// Comps-ensemble token launch radar (token-radar-01 v2).
//
// Model, fitted at runtime from the sealed snapshot, never hardcoded:
//  (a) global size curve: OLS log(mcap) = a + b*log(TVL) on CLEANNV live tokens.
//  (b) per-ticker comps curve: OLS on same-category comparables inside a 3x TVL
//      band (widened x3 up to 4 steps until >= 8 comps), slope shrunk toward the
//      global slope with w = n/(n+10), intercept anchored at the comparables'
//      median mcap and median TVL.
//  (c) ensemble: implied = geometric mean of the two curves.
//  (d) small tilts: +10% weight on 7-day TVL change (clamped -50..150) and on
//      age (0..4y, centred). Blind tests (leave-one-out, walk-forward, split-half)
//      are computed at runtime and shown in the dashboard, never asserted.
//  (e) rank ranges: 100 seeded bootstrap refits of the live-token pool; each
//      board protocol records its 5th-95th percentile rank across refits.
//
// Run: MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>
// Node 22, standard library only, deterministic, no network.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const TEXT_MAX_BYTES = 65_536;
const BOOTSTRAP_SEED = 20261117;
const BOOTSTRAP_ROUNDS = 100;

// ---------------------------------------------------------------- types

export interface Proto {
  slug: string; name: string; category: string | null; chains: string[];
  tvl_usd: number; change_7d: number | null; mcap_usd: number | null;
  listed_at: string | null; gecko_id: string | null; symbol: string | null;
}
export interface Snapshot { as_of: string; source: string; floor_usd: number; protocols: Proto[]; watchlist: string[]; }

export function parseSnapshot(text: string): Snapshot {
  const s = JSON.parse(text) as Snapshot;
  if (!Array.isArray(s.protocols) || !Array.isArray(s.watchlist) || typeof s.as_of !== 'string') throw new Error('snapshot: bad shape');
  return s;
}

// ---------------------------------------------------------------- helpers

const log = Math.log;
const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
const median = (xs: number[]): number => {
  const a = [...xs].sort((p, q) => p - q);
  const n = a.length;
  return n === 0 ? NaN : n % 2 ? a[(n - 1) / 2]! : (a[n / 2 - 1]! + a[n / 2]!) / 2;
};
const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
/** Deterministic PRNG (mulberry32) so bootstrap refits are byte-identical every run. */
function rng(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let z = t;
    z = Math.imul(z ^ (z >>> 15), z | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
  };
}
const daysBetween = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);

/** OLS log(mcap) = a + b*log(TVL). Returns null when the fit is degenerate. */
export function ols(rows: Proto[]): { a: number; b: number; n: number } | null {
  const pts = rows.filter((p) => p.tvl_usd > 0 && (p.mcap_usd ?? 0) > 0);
  if (pts.length < 3) return null;
  const xs = pts.map((p) => log(p.tvl_usd));
  const ys = pts.map((p) => log(p.mcap_usd!));
  const mx = mean(xs); const my = mean(ys);
  let sxx = 0; let sxy = 0;
  for (let i = 0; i < xs.length; i++) { sxx += (xs[i]! - mx) ** 2; sxy += (xs[i]! - mx) * (ys[i]! - my); }
  if (sxx === 0) return null;
  const b = sxy / sxx;
  return { a: my - b * mx, b, n: pts.length };
}

// ---------------------------------------------------------------- populations

const EXCLUDED_CATS = new Set(['CEX', 'Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'Cross Chain Bridge']);
const VERSION_TAIL = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_WORD = /\bwrapped\b|\bstaked\b|\bstaking\b/i;

export function liveOf(s: Snapshot): Proto[] { return s.protocols.filter((p) => (p.mcap_usd ?? 0) > 0); }
export function cleanOf(live: Proto[]): Proto[] { return live.filter((p) => !EXCLUDED_CATS.has(p.category ?? '')); }
export function cleanNvOf(clean: Proto[]): Proto[] {
  return clean.filter((p) => !VERSION_TAIL.test(p.name) && !WRAPPED_WORD.test(p.name));
}
export function preTokenOf(s: Snapshot): Proto[] {
  return s.protocols.filter((p) => p.gecko_id === null && p.symbol === null);
}

// ---------------------------------------------------------------- comps curve

export interface Comps { rows: Proto[]; a: number; b: number; n: number; band: number; }

/** Comparables for target t from pool: same category first, TVL band widened x3. */
export function compsFor(t: Proto, pool: Proto[], globalB: number): Comps {
  const same = pool.filter((p) => p.slug !== t.slug && (p.category ?? '') === (t.category ?? '') && p.category !== null);
  const all = pool.filter((p) => p.slug !== t.slug);
  let band = 3;
  for (let step = 0; step < 4; step++) {
    const lo = t.tvl_usd / band; const hi = t.tvl_usd * band;
    const rows = same.filter((p) => p.tvl_usd >= lo && p.tvl_usd <= hi);
    if (rows.length >= 8) return anchorComps(rows, globalB, band);
    band *= 3;
  }
  const lo = t.tvl_usd / band; const hi = t.tvl_usd * band;
  const wide = all.filter((p) => p.tvl_usd >= lo && p.tvl_usd <= hi);
  if (wide.length >= 8) return anchorComps(wide, globalB, band);
  const nearest = [...all].sort((p, q) => Math.abs(log(p.tvl_usd) - log(t.tvl_usd)) - Math.abs(log(q.tvl_usd) - log(t.tvl_usd))).slice(0, 8);
  return anchorComps(nearest, globalB, band);
}

function anchorComps(rows: Proto[], globalB: number, band: number): Comps {
  const fit = ols(rows);
  const n = rows.length;
  const w = n / (n + 10);
  const b = fit === null ? globalB : w * fit.b + (1 - w) * globalB;
  const a = log(median(rows.map((p) => p.mcap_usd!))) - b * log(median(rows.map((p) => p.tvl_usd)));
  return { rows, a, b, n, band };
}

// ---------------------------------------------------------------- ensemble + tilts

export interface ValueBreakdown {
  globalValue: number; compsValue: number; implied: number;
  tiltGrowth: number; tiltAge: number; comps: Comps;
}

/** Age in days from listed_at to the snapshot date; null when unlisted. */
export function ageDays(p: Proto, asOf: string): number | null {
  return p.listed_at === null ? null : Math.max(0, daysBetween(p.listed_at, asOf));
}

export function tiltFactors(p: Proto, asOf: string): { growth: number; age: number } {
  const growth = p.change_7d === null ? 1 : 1 + 0.10 * (clamp(p.change_7d, -50, 150) / 100);
  const age = ageDays(p, asOf);
  const ageF = age === null ? 1 : 1 + 0.10 * (Math.min(age, 1460) / 1460 - 0.5);
  return { growth, age: ageF };
}

/** Ensemble implied value for a pre-token protocol, from a fitted global curve + live pool. */
export function impliedValue(t: Proto, global: { a: number; b: number }, pool: Proto[], asOf: string): ValueBreakdown {
  const comps = compsFor(t, pool, global.b);
  const gv = Math.exp(global.a + global.b * log(t.tvl_usd));
  const cv = Math.exp(comps.a + comps.b * log(t.tvl_usd));
  const { growth, age } = tiltFactors(t, asOf);
  const implied = Math.exp((log(gv) + log(cv)) / 2) * growth * age;
  return { globalValue: gv, compsValue: cv, implied, tiltGrowth: growth, tiltAge: age, comps };
}

// ---------------------------------------------------------------- blind tests

export interface BlindTest { name: string; ensemble: number; flat: number; n: number; note: string; }
const flatValue = (p: Proto): number => 0.30 * p.tvl_usd;
const logErr = (actual: number, pred: number): number => Math.abs(log(actual) - log(Math.max(1, pred)));

/** Leave-one-out on CLEAN: refit the ensemble without the held-out token each time. */
export function looTest(clean: Proto[], global: { a: number; b: number }, asOf: string): BlindTest {
  const eErr: number[] = []; const fErr: number[] = [];
  for (const held of clean) {
    const pool = clean.filter((p) => p.slug !== held.slug);
    const g = ols(pool) ?? global;
    const v = impliedValue(held, g, pool, asOf);
    eErr.push(logErr(held.mcap_usd!, v.implied));
    fErr.push(logErr(held.mcap_usd!, flatValue(held)));
  }
  return { name: 'Leave-one-out', ensemble: median(eErr), flat: median(fErr), n: clean.length, note: 'each live token held out once, model refit without it' };
}

/** Walk-forward: fit on listed before 2024-01-01, test on listed on/after it. */
export function walkForwardTest(clean: Proto[], asOf: string): BlindTest {
  const fitSet = clean.filter((p) => p.listed_at !== null && p.listed_at < '2024-01-01');
  const testSet = clean.filter((p) => p.listed_at !== null && p.listed_at >= '2024-01-01');
  const g = ols(fitSet);
  const eErr: number[] = []; const fErr: number[] = [];
  for (const p of testSet) {
    const v = g === null ? flatValue(p) : impliedValue(p, g, fitSet, asOf).implied;
    eErr.push(logErr(p.mcap_usd!, v));
    fErr.push(logErr(p.mcap_usd!, flatValue(p)));
  }
  return { name: 'Walk-forward', ensemble: median(eErr), flat: median(fErr), n: testSet.length, note: 'fit on tokens listed before 2024-01-01, tested on tokens listed on/after it' };
}

/** Split-half: fit on even slugs, test odd, and vice versa; pool the held-out errors. */
export function splitHalfTest(clean: Proto[], asOf: string): BlindTest {
  const sorted = [...clean].sort((a, b) => (a.slug < b.slug ? -1 : 1));
  const even = sorted.filter((_, i) => i % 2 === 0);
  const odd = sorted.filter((_, i) => i % 2 === 1);
  const eErr: number[] = []; const fErr: number[] = [];
  for (const [fitSet, testSet] of [[even, odd], [odd, even]] as const) {
    const g = ols(fitSet);
    for (const p of testSet) {
      const v = g === null ? flatValue(p) : impliedValue(p, g, fitSet, asOf).implied;
      eErr.push(logErr(p.mcap_usd!, v));
      fErr.push(logErr(p.mcap_usd!, flatValue(p)));
    }
  }
  return { name: 'Split-half', ensemble: median(eErr), flat: median(fErr), n: sorted.length, note: 'slugs sorted, even/odd halves fit and test each other' };
}

// ---------------------------------------------------------------- farm plans

/** Estimated gas per on-chain interaction, USD. Estimates only, labelled so in code and UI. */
export const GAS_USD: Record<string, number> = {
  Ethereum: 25, Base: 1, Arbitrum: 1.5, Optimism: 1.5, Solana: 0.25,
  Binance: 0.75, Polygon: 0.5, Avalanche: 1,
};
export const GAS_DEFAULT = 2;
export const FARM_INTERACTIONS = 4; // fund + two protocol actions + one repeat/claim
export function gasPerTx(chain: string): number { return GAS_USD[chain] ?? GAS_DEFAULT; }
export function primaryChain(p: Proto): string { return p.chains[0] ?? 'Ethereum'; }
export function depositUsd(p: Proto): number { return p.tvl_usd >= 1e9 ? 2000 : p.tvl_usd >= 1e8 ? 1000 : 500; }

/** Per-category action templates; {D} is the suggested deposit, {C} the chain. */
function categoryActions(category: string | null): [string, string] {
  switch (category) {
    case 'Lending': return [
      'Supply ${D} of a major asset (ETH or a stablecoin) as collateral on {C}, then borrow up to 40% against it; keep the health factor above 2.',
      'Repay part of the loan and re-supply after a week so the position shows repeated, organic use rather than a single deposit.',
    ];
    case 'Dexs': return [
      'Provide ${D} of liquidity to the most active pool on {C} (a stable pair first), in a narrow range if the pool is concentrated.',
      'Swap a small amount through the pool once a week and rebalance the position when it drifts out of range.',
    ];
    case 'Yield': case 'Yield Aggregator': return [
      'Deposit ${D} into the highest-TVL vault on {C} and leave it earning for at least 4 weeks without withdrawing.',
      'Harvest or compound the yield weekly, and add a second smaller deposit in week 3 to show continued use.',
    ];
    case 'Derivatives': case 'Perpetuals': return [
      'Open a small hedged position (about ${D} notional, low leverage) on {C} and hold it for several days.',
      'Close and reopen a fresh position the following week, keeping total trading volume steady rather than one burst.',
    ];
    case 'CDP': return [
      'Lock ${D} of collateral on {C} and mint stablecoins against it at under 50% of the maximum ratio.',
      'Repay a slice of the minted amount in week 2, then mint again, so the vault shows two full borrow cycles.',
    ];
    case 'RWA': return [
      'Buy ${D} of the protocol\u2019s tokenised real-world asset on {C} and hold it through at least one yield distribution.',
      'Reinvest the first distribution back into the same product and keep the holding for 4 weeks or more.',
    ];
    case 'Bridge': case 'Canonical Bridge': return [
      'Bridge ${D} across {C} using the protocol\u2019s own route, in two transfers a week apart rather than one large move.',
      'Bridge a smaller amount back the other way in week 3 so the activity reads as real usage, not a one-off.',
    ];
    case 'Restaking': case 'Liquid Restaking': case 'Liquid Staking': return [
      'Stake ${D} through the protocol on {C} and keep the position staked for at least 4 weeks.',
      'Restake or compound the staking rewards weekly instead of withdrawing them.',
    ];
    default: return [
      'Use the protocol\u2019s main product on {C} with ${D}, following its own onboarding flow end to end.',
      'Repeat the core action once a week for 4 weeks, varying the amount slightly each time so the history looks organic.',
    ];
  }
}

export interface FarmPlan { steps: string[]; totalCost: number; verdict: 'FARM' | 'THIN' | 'SKIP'; deposit: number; gasPerTx: number; chain: string; }

/** Verdict rule (documented): FARM if implied > 100x cost and cost <= $500; THIN if implied > 20x cost and cost <= $1000; else SKIP. */
export function verdictFor(implied: number, totalCost: number): 'FARM' | 'THIN' | 'SKIP' {
  if (implied > 100 * totalCost && totalCost <= 500) return 'FARM';
  if (implied > 20 * totalCost && totalCost <= 1000) return 'THIN';
  return 'SKIP';
}

export function farmPlan(p: Proto, implied: number): FarmPlan {
  const chain = primaryChain(p);
  const gas = gasPerTx(chain);
  const totalCost = Math.round(FARM_INTERACTIONS * gas * 100) / 100;
  const deposit = depositUsd(p);
  const verdict = verdictFor(implied, totalCost);
  const [a1, a2] = categoryActions(p.category).map((s) => s.replaceAll('${D}', `$${deposit}`).replaceAll('{C}', chain));
  const money = (n: number): string => `$${n.toLocaleString('en-US')}`;
  const steps = [
    `Set up on ${chain}: fund a fresh wallet with ${money(deposit)} plus about ${money(Math.ceil(totalCost))} for gas (about ${money(gas)} per on-chain interaction, estimate), and confirm the protocol's app loads on ${chain}. Takes about 15 minutes.`,
    `${a1} Takes about 20 minutes for the first position; confirm the transaction succeeds before moving on.`,
    `${a2} Takes about 15 minutes per repeat action; spread the repeats across weeks, not hours.`,
    `Maintain the position for 4 to 6 weeks: check it weekly (about 10 minutes each time), top up or rebalance only when the position drifts, and keep a note of every transaction hash.`,
    `Track the launch: watch the protocol's own announcements weekly (about 5 minutes) for any token or points update, and only claim through its official app when one is announced.`,
    `Total estimated cost: ${money(totalCost)} across ${FARM_INTERACTIONS} on-chain interactions on ${chain} at about ${money(gas)} gas each (estimates, gas varies with congestion). Verdict: ${verdict} — implied value ${money(Math.round(implied))} is ${Math.round(implied / Math.max(totalCost, 0.01)).toLocaleString('en-US')}x the farming cost.`,
  ];
  return { steps, totalCost, verdict, deposit, gasPerTx: gas, chain };
}

// ---------------------------------------------------------------- board build

export interface BoardRow {
  slug: string; name: string; rank: number; implied_value_usd: number; farm_steps: string[];
}
export interface RadarData {
  meta: {
    as_of: string; floor_usd: number; protocols: number; live: number; clean: number; cleanNv: number;
    watchlist: number; boardRows: number; globalA: number; globalB: number; globalN: number;
    blind: BlindTest[]; seed: number; bootstrapRounds: number;
  };
  rows: Array<{
    slug: string; name: string; category: string | null; chains: string[]; tvl_usd: number;
    change_7d: number | null; age_days: number | null; rank: number; implied_value_usd: number;
    rank_lo: number; rank_hi: number; watchlist: boolean;
    global_value: number; comps_value: number; tilt_growth: number; tilt_age: number;
    comps: Array<{ slug: string; name: string; category: string | null; tvl_usd: number; mcap_usd: number; ratio: number }>;
    farm: FarmPlan;
  }>;
  live: Array<{ slug: string; name: string; category: string | null; tvl_usd: number; mcap_usd: number; ratio: number }>;
}

export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const live = liveOf(snapshot);
  const clean = cleanOf(live);
  const cleanNv = cleanNvOf(clean);
  const global = ols(cleanNv);
  if (global === null) throw new Error('model: global fit failed');
  const asOf = snapshot.as_of;
  const pre = preTokenOf(snapshot);
  const watch = new Set(snapshot.watchlist);
  const watchRows = pre.filter((p) => watch.has(p.slug));
  const below = pre.filter((p) => !watch.has(p.slug) && p.tvl_usd < snapshot.floor_usd)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : 1)).slice(0, 160);
  const picked = [...watchRows, ...below];

  // Score every picked protocol once with the fitted ensemble.
  const scored = picked.map((p) => ({ p, v: impliedValue(p, global, cleanNv, asOf) }));
  scored.sort((a, b) => b.v.implied - a.v.implied || (a.p.slug < b.p.slug ? -1 : 1));

  // (e) Bootstrap rank ranges: 100 seeded refits of the live-token pool.
  const rankSamples = new Map<string, number[]>();
  for (const { p } of scored) rankSamples.set(p.slug, []);
  const draw = rng(BOOTSTRAP_SEED);
  for (let r = 0; r < BOOTSTRAP_ROUNDS; r++) {
    const boot: Proto[] = [];
    for (let i = 0; i < cleanNv.length; i++) boot.push(cleanNv[Math.floor(draw() * cleanNv.length)]!);
    const g = ols(boot) ?? global;
    const vals = scored.map(({ p }) => ({ slug: p.slug, v: impliedValue(p, g, boot, asOf).implied }));
    vals.sort((a, b) => b.v - a.v || (a.slug < b.slug ? -1 : 1));
    vals.forEach((x, i) => rankSamples.get(x.slug)!.push(i + 1));
  }
  const pct = (xs: number[], q: number): number => {
    const a = [...xs].sort((p, q2) => p - q2);
    return a[Math.floor(q * (a.length - 1))]!;
  };

  const rows = scored.map(({ p, v }, i) => {
    const plan = farmPlan(p, v.implied);
    const samples = rankSamples.get(p.slug)!;
    return {
      slug: p.slug, name: p.name, category: p.category, chains: p.chains, tvl_usd: p.tvl_usd,
      change_7d: p.change_7d, age_days: ageDays(p, asOf), rank: i + 1,
      implied_value_usd: Math.max(1, Math.round(v.implied)),
      rank_lo: pct(samples, 0.05), rank_hi: pct(samples, 0.95), watchlist: watch.has(p.slug),
      global_value: Math.round(v.globalValue), comps_value: Math.round(v.compsValue),
      tilt_growth: v.tiltGrowth, tilt_age: v.tiltAge,
      comps: v.comps.rows.slice(0, 12).map((c) => ({
        slug: c.slug, name: c.name, category: c.category, tvl_usd: c.tvl_usd, mcap_usd: c.mcap_usd!,
        ratio: Math.round((c.mcap_usd! / c.tvl_usd) * 1000) / 1000,
      })),
      farm: plan,
    };
  });
  const board: BoardRow[] = rows.map((r) => ({
    slug: r.slug, name: r.name, rank: r.rank, implied_value_usd: r.implied_value_usd, farm_steps: r.farm.steps,
  }));
  const blind = [looTest(clean, global, asOf), walkForwardTest(clean, asOf), splitHalfTest(clean, asOf)];
  const radar: RadarData = {
    meta: {
      as_of: asOf, floor_usd: snapshot.floor_usd, protocols: snapshot.protocols.length,
      live: live.length, clean: clean.length, cleanNv: cleanNv.length,
      watchlist: snapshot.watchlist.length, boardRows: board.length,
      globalA: global.a, globalB: global.b, globalN: global.n, blind,
      seed: BOOTSTRAP_SEED, bootstrapRounds: BOOTSTRAP_ROUNDS,
    },
    rows,
    live: [...live].sort((a, b) => b.mcap_usd! - a.mcap_usd!).map((p) => ({
      slug: p.slug, name: p.name, category: p.category, tvl_usd: p.tvl_usd, mcap_usd: p.mcap_usd!,
      ratio: Math.round((p.mcap_usd! / p.tvl_usd) * 1000) / 1000,
    })),
  };
  return { board, radar };
}

/** The dashboard's data as a script: window.RADAR = {...}; (data.js, written beside the page). */
export function dataScript(radar: RadarData): string {
  return `window.RADAR = ${JSON.stringify(radar)};\n`;
}

/** First gate problem with the board, or null when it is valid. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100) return `board holds ${board.length} rows, under 100`;
  const slugs = new Set(snapshot.protocols.map((p) => p.slug));
  const seen = new Set<string>();
  for (const r of board) {
    if (!slugs.has(r.slug)) return `board row ${r.slug} is not a snapshot protocol`;
    if (seen.has(r.slug)) return `board repeats ${r.slug}`;
    seen.add(r.slug);
    if (!Number.isInteger(r.rank) || r.rank < 1) return `board row ${r.slug} has a bad rank`;
    if (!Number.isInteger(r.implied_value_usd) || r.implied_value_usd < 1) return `board row ${r.slug} has a bad implied value`;
    if (!Array.isArray(r.farm_steps) || r.farm_steps.length < 3 || r.farm_steps.length > 12) return `board row ${r.slug} has bad farm_steps`;
    for (const s of r.farm_steps) if (typeof s !== 'string' || s.trim().length < 20 || s.trim().length > 600) return `board row ${r.slug} has a farm step of bad length`;
  }
  const ranks = [...board].map((r) => r.rank).sort((a, b) => a - b);
  if (ranks.some((r, i) => r !== i + 1)) return 'board ranks are not exactly 1..N';
  const byRank = [...board].sort((a, b) => a.rank - b.rank);
  for (let i = 1; i < byRank.length; i++) if (byRank[i]!.implied_value_usd > byRank[i - 1]!.implied_value_usd) return 'board implied values rise with rank';
  for (const w of snapshot.watchlist) if (!seen.has(w)) return `board misses watchlist ${w}`;
  return null;
}

// ---------------------------------------------------------------- CLI

function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  return eq === undefined ? fallback : eq.slice(name.length + 3);
}

const inputArg = arg('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) {
  process.stderr.write(`token radar: no snapshot at ${inputFile}: pass --input <snapshot.json|directory> or mount the sealed /input\n`);
  process.exit(2);
}
const out = arg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));
const { board, radar } = buildRadar(snapshot);
const issue = boardIssue(board, snapshot);
if (issue !== null) {
  process.stderr.write(`token radar: the model wrote a board the gate refuses: ${issue}\n`);
  process.exit(1);
}

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
writeFileSync(join(out, 'data.js'), dataScript(radar));

function copyFiles(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    copied.push(name);
  }
  return copied;
}

copyFiles(join(here, 'dashboard'), join(out, 'dashboard'));
const shots = copyFiles(join(here, 'screenshots'), join(out, 'screenshots'));
if (shots.length < 3) {
  process.stderr.write(`token radar: screenshots/ holds ${shots.length}: hand in 3, the board, a detail view and a filtered view\n`);
  process.exit(1);
}
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
for (const name of shots) {
  if (!IMAGE_NAME.test(name)) { process.stderr.write(`token radar: screenshots/${name}: bad name\n`); process.exit(1); }
}

writeFileSync(join(out, 'dossier.json'), buildDossier(out, { text_max_bytes: TEXT_MAX_BYTES, screenshots: { max: 4, max_bytes: 524_288 }, dashboard: { max_files: 400, max_bytes: 4_194_304 } }));

const m = radar.meta;
process.stdout.write(
  `token radar: ${m.protocols} protocols, ${m.watchlist} on the watchlist, ${board.length} rows scored\n` +
  `token radar: global log(mcap) = ${m.globalA.toFixed(4)} + ${m.globalB.toFixed(4)}*log(TVL) on CLEANNV n=${m.globalN}\n` +
  m.blind.map((b) => `token radar: blind ${b.name}: ensemble median |log err| ${b.ensemble.toFixed(3)} vs flat 0.30xTVL ${b.flat.toFixed(3)} (n=${b.n})\n`).join('') +
  `token radar: wrote ${join(out, 'board.json')}, ${join(out, 'data.js')}, dashboard, ${shots.length} screenshots and dossier.json\n`,
);

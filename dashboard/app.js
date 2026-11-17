// Token Radar dashboard: renders window.RADAR (written by main.ts) with no network.
const D = window.RADAR;
const $ = (id) => document.getElementById(id);
const money = (n) => n == null ? '—' : '$' + Math.round(n).toLocaleString('en-US');
const moneyShort = (n) => n >= 1e9 ? '$' + (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? '$' + (n / 1e6).toFixed(1) + 'M' : money(n);
const pct = (n) => n == null ? '—' : (n > 0 ? '+' : '') + n.toFixed(1) + '%';
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const params = new URLSearchParams(location.search);

function fillSelects() {
  const cats = [...new Set(D.rows.map((r) => r.category).filter(Boolean))].sort();
  const chains = [...new Set(D.rows.flatMap((r) => r.chains))].sort();
  for (const c of cats) $('cat').append(new Option(c, c));
  for (const c of chains) $('chain').append(new Option(c, c));
  if (params.get('cat')) $('cat').value = params.get('cat');
  if (params.get('chain')) $('chain').value = params.get('chain');
  if (params.get('verdict')) $('verdict').value = params.get('verdict');
  if (params.get('watch') === '1') $('watch').checked = true;
  if (params.get('q')) $('q').value = params.get('q');
  if (params.get('sort')) $('sort').value = params.get('sort');
}

function filtered() {
  const q = $('q').value.trim().toLowerCase();
  const cat = $('cat').value, chain = $('chain').value, ver = $('verdict').value, wl = $('watch').checked;
  let rows = D.rows.filter((r) =>
    (!q || r.name.toLowerCase().includes(q) || r.slug.includes(q)) &&
    (!cat || r.category === cat) && (!chain || r.chains.includes(chain)) &&
    (!ver || r.farm.verdict === ver) && (!wl || r.watchlist));
  const s = $('sort').value;
  if (s === 'tvl') rows = [...rows].sort((a, b) => b.tvl_usd - a.tvl_usd);
  else if (s === 'growth') rows = [...rows].sort((a, b) => (b.change_7d ?? -1e9) - (a.change_7d ?? -1e9));
  else if (s === 'name') rows = [...rows].sort((a, b) => a.name.localeCompare(b.name));
  else rows = [...rows].sort((a, b) => a.rank - b.rank);
  return rows;
}

function renderBoard() {
  const rows = filtered();
  $('shown').textContent = rows.length + ' of ' + D.rows.length + ' shown';
  $('board').querySelector('tbody').innerHTML = rows.map((r) => `<tr data-slug="${esc(r.slug)}">
    <td class="rank">${r.rank}</td>
    <td><b>${esc(r.name)}</b>${r.watchlist ? '<span class="wl">WATCHLIST</span>' : ''}<br><span class="muted">${esc(r.slug)}</span></td>
    <td>${esc(r.category ?? '—')}</td><td>${esc(r.chains.slice(0, 2).join(', '))}${r.chains.length > 2 ? ' +' + (r.chains.length - 2) : ''}</td>
    <td class="num">${moneyShort(r.tvl_usd)}</td><td class="num">${pct(r.change_7d)}</td>
    <td class="num"><b>${moneyShort(r.implied_value_usd)}</b></td>
    <td class="num">${r.rank_lo}–${r.rank_hi}</td>
    <td class="v${r.farm.verdict}">${r.farm.verdict} · ${money(r.farm.totalCost)}</td></tr>`).join('');
  $('board').querySelectorAll('tbody tr').forEach((tr) => tr.addEventListener('click', () => showDetail(tr.dataset.slug)));
}

function renderChart() {
  const top = [...D.rows].sort((a, b) => a.rank - b.rank).slice(0, 10);
  const max = top[0].implied_value_usd;
  $('chart').innerHTML = top.map((r) => `<div class="bar-row"><span>${r.rank}. ${esc(r.name)}</span>
    <span class="bar"><i style="width:${(100 * r.implied_value_usd / max).toFixed(1)}%"></i></span>
    <span class="num"><b>${moneyShort(r.implied_value_usd)}</b></span></div>`).join('');
}

function showDetail(slug) {
  const r = D.rows.find((x) => x.slug === slug) || D.rows[0];
  const comps = r.comps.map((c) => `<tr><td>${esc(c.name)}</td><td>${esc(c.category ?? '—')}</td>
    <td class="num">${moneyShort(c.tvl_usd)}</td><td class="num">${moneyShort(c.mcap_usd)}</td>
    <td class="num">${c.ratio.toFixed(2)}x</td></tr>`).join('');
  $('detail').innerHTML = `<h2>Detail: ${esc(r.name)} <span class="muted">#${r.rank} · ${esc(r.slug)}</span>
    ${r.watchlist ? '<span class="wl">WATCHLIST</span>' : ''}</h2>
  <div class="detail-grid"><div>
    <div class="big">${moneyShort(r.implied_value_usd)}</div>
    <p class="muted">Implied value &middot; TVL ${moneyShort(r.tvl_usd)} &middot; 7d ${pct(r.change_7d)} &middot; age ${r.age_days == null ? 'unknown' : r.age_days + ' days'} &middot; bootstrap rank range ${r.rank_lo}–${r.rank_hi} (5th–95th pct, ${D.meta.bootstrapRounds} refits)</p>
    <dl class="kv">
      <dt>Global curve value</dt><dd>${money(r.global_value)}</dd>
      <dt>Per-ticker comps value</dt><dd>${money(r.comps_value)}</dd>
      <dt>Growth tilt</dt><dd>&times;${r.tilt_growth.toFixed(3)}</dd>
      <dt>Age tilt</dt><dd>&times;${r.tilt_age.toFixed(3)}</dd>
      <dt>Comparables used</dt><dd>${r.comps.length} comparables</dd>
      <dt>Chains</dt><dd>${esc(r.chains.join(', '))}</dd>
    </dl>
    <h3>Comparables (same category first, TVL within a 3x band, widened until 8+)</h3>
    <div class="scroll"><table><thead><tr><th>Comparable</th><th>Category</th><th>TVL</th><th>Mcap</th><th>Mcap/TVL</th></tr></thead><tbody>${comps}</tbody></table></div>
  </div><div>
    <h3>Costed farm plan &mdash; verdict <span class="v${r.farm.verdict}">${r.farm.verdict}</span></h3>
    <p>Primary chain <b>${esc(r.farm.chain)}</b> &middot; gas about ${money(r.farm.gasPerTx)} per interaction (estimate) &middot; suggested deposit ${money(r.farm.deposit)} &middot; total estimated cost <b>${money(r.farm.totalCost)}</b>. Rule: FARM if implied &gt; 100x cost and cost &le; $500; THIN if &gt; 20x and &le; $1000; else SKIP.</p>
    <ol class="steps">${r.farm.steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>
    <p><button onclick="document.getElementById('boardpanel').scrollIntoView()">Back to board</button></p>
  </div></div>`;
  $('detail').scrollIntoView({ block: 'start' });
}

function renderModel() {
  const m = D.meta;
  const blind = m.blind.map((b) => `<tr><td>${esc(b.name)}</td><td class="num">${b.ensemble.toFixed(3)}</td>
    <td class="num">${b.flat.toFixed(3)}</td><td class="num">${b.n}</td><td>${esc(b.note)}</td></tr>`).join('');
  $('model').innerHTML = `<h2>Model &amp; methodology &mdash; fitted at runtime, nothing hardcoded</h2>
  <div class="formula">implied = sqrt(global x comps) x growth-tilt x age-tilt
global: log(mcap) = ${m.globalA.toFixed(3)} + ${m.globalB.toFixed(3)} x log(TVL)   [OLS on CLEANNV, n=${m.globalN}]
comps:  OLS on same-category tokens in a 3x TVL band (widened x3 to 8+ comps),
        slope shrunk toward global with w = n/(n+10), intercept anchored at
        median mcap / median TVL of the comparables.
tilts:  x(1 + 0.10 x clamp(change_7d,-50,150)/100)  and  x(1 + 0.10 x (min(age,1460)/1460 - 0.5))</div>
  <p>Populations from the snapshot: ${m.protocols} protocols, ${m.live} with a market cap, ${m.clean} after excluding CEX / bridge / liquid-staking categories, ${m.cleanNv} after also dropping versioned and wrapped/staked names (CLEANNV, the fit set). Board: ${m.boardRows} rows = all ${m.watchlist} watchlist protocols + the 160 pre-token protocols below the $${(m.floor_usd / 1e6).toFixed(0)}M floor with the most TVL. Protocols that already trade are listed separately below, never ranked.</p>
  <h3>Blind tests (computed at runtime from the snapshot; median |log error| vs actual market cap)</h3>
  <div class="scroll"><table><thead><tr><th>Test</th><th>Ensemble</th><th>Flat 0.30 x TVL</th><th>n</th><th>Method</th></tr></thead><tbody>${blind}</tbody></table></div>
  <p class="note"><b>Honest limitations.</b> The model is a cross-sectional size curve: it says what a token would be worth if the protocol&rsquo;s record stayed as it is, not whether or when a token launches. Log errors near 1 mean typical misses of ~2.7x; small categories have few comparables, so their comps curve leans on the global slope. TVL can be gamed, mercenary, or double-counted across chains. Farm verdicts use gas estimates, not live quotes, and a FARM verdict is not a promise of an airdrop.</p>`;
}

function renderLive() {
  $('live').querySelector('tbody').innerHTML = D.live.slice(0, 20).map((p) => `<tr>
    <td><b>${esc(p.name)}</b><br><span class="muted">${esc(p.slug)}</span></td>
    <td>${esc(p.category ?? '—')}</td><td class="num">${moneyShort(p.tvl_usd)}</td>
    <td class="num">${moneyShort(p.mcap_usd)}</td><td class="num">${p.ratio.toFixed(2)}x</td></tr>`).join('');
}

$('asof').textContent = D.meta.as_of;
$('counts').textContent = D.meta.protocols + ' protocols · ' + D.meta.watchlist + ' watchlist · ' + D.meta.boardRows + ' ranked';
$('boardnote').textContent = '· ' + D.meta.boardRows + ' pre-token protocols · already-trading tokens listed separately below';
fillSelects(); renderChart(); renderBoard(); renderModel(); renderLive();
for (const id of ['q', 'cat', 'chain', 'verdict', 'sort']) $(id).addEventListener('input', renderBoard);
$('watch').addEventListener('change', renderBoard);
showDetail(params.get('detail') || D.rows[0].slug);
if (!params.get('detail')) document.getElementById('boardpanel').scrollIntoView();

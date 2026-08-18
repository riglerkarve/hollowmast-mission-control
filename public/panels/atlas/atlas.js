// Atlas — where you have been. Reads only /api/atlas.
//
// A GRID, LABELLED AS A GRID. A geographic projection needs real country path data, and
// drawing outlines from memory would be fabricating geography that looks authoritative.
// A cell per country, grouped by region, is honest about being a schematic.

let root = null;

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const TEMPLATE = `
  <div class="panel panel-wide">
    <div class="panel-header">
      <h1>Atlas</h1>
      <div class="badge"><span class="badge-icon">◫</span><span id="atBadge">—</span></div>
    </div>
    <section class="card" id="atSummary"></section>
    <section class="card" id="atGrid"></section>
  </div>
`;

async function api(path, opts) {
  const r = await fetch(`/api/atlas${path}`, opts);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
  return body;
}

async function load() {
  if (!root) return;   // may be CALLED after teardown, not only resumed after it
  let d;
  try {
    d = await api('/');
    if (!root) return;   // the panel was torn down mid-await; root is null now
  } catch (err) {
    if (!root) return;   // the panel was torn down mid-await; root is null now
    root.querySelector('#atSummary').innerHTML = `<p class="empty-hint">Could not read the atlas: ${esc(err.message)}</p>`;
    return;
  }

  root.querySelector('#atBadge').textContent = `${d.visited}/${d.total}`;

  root.querySelector('#atSummary').innerHTML = `
    <div class="at-figure">
      <span class="at-pct">${d.percent}%</span>
      <span class="at-pct-label">of the world, by country count</span>
    </div>
    <div class="at-regions">
      ${Object.entries(d.byRegion).map(([r, v]) => `
        <span class="at-region"><b>${esc(r)}</b> ${v.visited}/${v.total}</span>`).join('')}
    </div>
    <p class="at-note">${esc(d.basis)}</p>`;

  const byRegion = {};
  for (const c of d.countries) {
    if (!byRegion[c.region]) byRegion[c.region] = [];
    byRegion[c.region].push(c);
  }

  root.querySelector('#atGrid').innerHTML = `
    <p class="at-note at-dim">Click a country to mark it. This is a grid, not a projection —
      it does not pretend to know where anywhere is.</p>
    ${Object.entries(byRegion).map(([region, list]) => `
      <h3 class="at-h3">${esc(region)}</h3>
      <div class="at-cells">
        ${list.map((c) => `
          <button class="at-cell${c.visited ? ' is-visited' : ''}" data-country="${esc(c.name)}"
                  title="${esc(c.name)}${c.visitedAt ? ` — marked ${esc(c.visitedAt)}` : ''}">${esc(c.name)}</button>`).join('')}
      </div>`).join('')}`;

  root.querySelectorAll('.at-cell').forEach((b) => b.addEventListener('click', async () => {
    // Optimistic on the button only; the figures come back from the route, which owns them.
    b.classList.toggle('is-visited');
    try {
      await api('/visit', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-mc-by': 'you' },
        body: JSON.stringify({ name: b.dataset.country }),
      });
      load();
    } catch (err) {
      if (!root) return;   // the panel was torn down mid-await; root is null now
      b.classList.toggle('is-visited');
      root.querySelector('#atSummary').insertAdjacentHTML('afterbegin',
        `<p class="empty-hint">Could not save: ${esc(err.message)}</p>`);
    }
  }));
}

export default {
  mount(el) { root = el; el.innerHTML = TEMPLATE; load(); },
  unmount() { root = null; },
};

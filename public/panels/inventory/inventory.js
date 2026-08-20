// inventory — equipment, consumables, possessions.
//
// Owner chose all three scopes. Each tab leads with the QUESTION its category can answer,
// not with the list, because the list is the part you have to feed and the answer is the
// part that pays for it:
//   Equipment    -> capital spend per UK tax year
//   Consumables  -> what is at or below its own reorder threshold
//   Possessions  -> total value, and how many are uninsured vs unknown
//
// NO NEW CSS CLASSES — Codex owns the stylesheets (owner decision #18). Only classes
// already in public/shared.css are used.

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const gbp = (pence) => '£' + (Number(pence || 0) / 100).toLocaleString('en-GB', {
  minimumFractionDigits: 2, maximumFractionDigits: 2,
});

let root = null;
let tab = 'equipment';
let loadToken = 0;

const TEMPLATE = `
  <div class="panel">
    <div class="panel-header"><h1>Inventory</h1></div>
    <div class="mode-tabs" id="invTabs">
      <button class="mode-tab" data-tab="equipment">Equipment</button>
      <button class="mode-tab" data-tab="consumable">Stock</button>
      <button class="mode-tab" data-tab="possession">Possessions</button>
    </div>
    <div id="invBody"></div>
  </div>`;

async function get(url) {
  const r = await fetch(url, { headers: { 'x-mc-by': 'you' } });
  const body = await r.json().catch(() => null);
  if (!r.ok) throw new Error((body && (body.why || body.error)) || ('HTTP ' + r.status));
  return body;
}

const failure = (m) => `<div class="card"><p class="failure-hint">Could not load: ${esc(m)}</p></div>`;
const empty = (m) => `<div class="card"><p class="empty-hint">${esc(m)}</p></div>`;

function itemCard(it, extra) {
  return `
    <div class="card">
      <strong>${esc(it.name)}</strong>
      ${it.disposed_on ? '<span class="badge">disposed ' + esc(it.disposed_on) + '</span>' : ''}
      ${extra || ''}
      ${it.note ? `<p>${esc(it.note)}</p>` : ''}
    </div>`;
}

async function renderEquipment(body) {
  const [cap, list] = await Promise.all([
    get('/api/inventory/capital'),
    get('/api/inventory/items?category=equipment'),
  ]);
  const years = cap.years || [];
  const head = years.length
    ? `<div class="stats-summary">${years.slice(0, 4).map((y) => `
        <div class="stat-block"><div class="stat-label">${esc(y.tax_year)}</div>
        <div class="stat-value">${gbp(y.total_pence)}</div></div>`).join('')}</div>
       <p class="empty-hint">${esc(cap.caveat)}</p>`
    : empty('No equipment with both a cost and an acquisition date, so no tax year can be totalled.');

  const residue = cap.residue && cap.residue.no_cost_or_date
    ? `<p class="empty-hint">${cap.residue.no_cost_or_date} item(s) excluded: ${esc(cap.residue.why)}</p>` : '';

  body.innerHTML = head + residue
    + (list.count ? list.items.map((it) => itemCard(it, `
        <div class="stats-summary">
          <div class="stat-block"><div class="stat-label">Cost</div><div class="stat-value">${it.cost_pence == null ? '—' : gbp(it.cost_pence)}</div></div>
          <div class="stat-block"><div class="stat-label">Acquired</div><div class="stat-value">${esc(it.acquired_on || '—')}</div></div>
        </div>`)).join('')
      : empty(list.state || 'No equipment recorded.'));
}

async function renderConsumables(body) {
  const [re, list] = await Promise.all([
    get('/api/inventory/reorder'),
    get('/api/inventory/items?category=consumable'),
  ]);
  const head = re.count
    ? `<div class="card"><strong>${re.count} item(s) at or below threshold</strong>
        ${re.reorder.map((r) => `<p>${esc(r.name)} — ${r.quantity}${esc(r.unit || '')} left, short by ${r.short_by}</p>`).join('')}
       </div>`
    : empty(re.state || 'Nothing needs reordering.');

  // Items that cannot be judged are named rather than counted as fine.
  const residue = re.residue && re.residue.no_threshold_or_quantity
    ? `<p class="empty-hint">${re.residue.no_threshold_or_quantity} item(s) cannot be judged: ${esc(re.residue.why)}</p>` : '';

  body.innerHTML = head + residue
    + (list.count ? list.items.map((it) => itemCard(it, `
        <div class="stats-summary">
          <div class="stat-block"><div class="stat-label">In stock</div><div class="stat-value">${it.quantity == null ? '—' : it.quantity + ' ' + esc(it.unit || '')}</div></div>
          <div class="stat-block"><div class="stat-label">Reorder at</div><div class="stat-value">${it.reorder_at == null ? '—' : it.reorder_at}</div></div>
        </div>
        <button class="btn" data-use="${it.id}">Use 1</button>
        <button class="btn" data-restock="${it.id}">Restock 1</button>`)).join('')
      : empty(list.state || 'No consumables recorded.'));

  const move = (sel, path) => body.querySelectorAll(sel).forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    await fetch('/api/inventory/items/' + b.dataset[path === 'use' ? 'use' : 'restock'] + '/' + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-mc-by': 'you' },
      body: JSON.stringify({ quantity: 1 }),
    });
    await switchTab('consumable');
  }));
  move('[data-use]', 'use');
  move('[data-restock]', 'restock');
}

async function renderPossessions(body) {
  const [val, list] = await Promise.all([
    get('/api/inventory/value'),
    get('/api/inventory/items?category=possession'),
  ]);
  body.innerHTML = `
    <div class="stats-summary">
      <div class="stat-block"><div class="stat-label">Total</div><div class="stat-value">${gbp(val.total_pence)}</div></div>
      <div class="stat-block"><div class="stat-label">Counted</div><div class="stat-value">${val.counted}</div></div>
      <div class="stat-block"><div class="stat-label">Uninsured</div><div class="stat-value">${val.uninsured}</div></div>
      <div class="stat-block"><div class="stat-label">Insurance unknown</div><div class="stat-value">${val.insurance_unknown}</div></div>
    </div>
    <p class="empty-hint">"Unknown" is not "uninsured" — nobody has said, which is a different
       state from a settled no, and ${val.unpriced} item(s) have no value recorded.</p>
    ${list.count ? list.items.map((it) => itemCard(it, `
      <div class="stats-summary">
        <div class="stat-block"><div class="stat-label">Value</div><div class="stat-value">${it.cost_pence == null ? '—' : gbp(it.cost_pence)}</div></div>
        <div class="stat-block"><div class="stat-label">Where</div><div class="stat-value">${esc(it.location || '—')}</div></div>
      </div>`)).join('') : empty(list.state || 'No possessions recorded.')}`;
}

async function switchTab(name) {
  if (!root) return;
  tab = name;
  const token = ++loadToken;
  root.querySelectorAll('.mode-tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  const body = root.querySelector('#invBody');
  body.innerHTML = '<p class="empty-hint">Loading…</p>';
  try {
    if (name === 'equipment') await renderEquipment(body);
    else if (name === 'consumable') await renderConsumables(body);
    else await renderPossessions(body);
  } catch (e) {
    if (token !== loadToken || !root) return;
    body.innerHTML = failure(e.message);
  }
}

export default {
  mount(el) {
    root = el;
    el.innerHTML = TEMPLATE;
    el.querySelectorAll('.mode-tab').forEach((t) => {
      t.addEventListener('click', () => switchTab(t.dataset.tab));
    });
    switchTab(tab);
  },
  unmount() {
    loadToken++;
    root = null;
  },
};

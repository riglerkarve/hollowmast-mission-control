// inventory — equipment, consumables, possessions, and the way things get INTO them.
//
// Owner, 20 Aug 2026: "add a data entry section - task i've recieved my huel order - add
// items ordered to inventory so that when I look at meal planning it can see what i have
// available."
//
// Each tab leads with the QUESTION its category answers, then the entry form, then the
// list. The question first is deliberate: the list is the part you feed and the answer is
// the part that pays for it.
//
// THE FOOD PATH IS THE ONE THAT MATTERS. Typing "Huel" searches Open Food Facts through
// lifestyle's own lookup, saves the chosen product as a lifestyle food definition, and
// creates the stock row linked to it by food_id. Nutrition is NEVER copied onto the stock
// row -- lifestyle owns what a food is, inventory owns how much is in the house, and meal
// planning reads both through /api/inventory/food.
//
// NO NEW CSS CLASSES. Codex owns every stylesheet (owner decision #18); this uses only what
// public/shared.css already defines.

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const gbp = (pence) => '£' + (Number(pence || 0) / 100).toLocaleString('en-GB', {
  minimumFractionDigits: 2, maximumFractionDigits: 2,
});

let root = null;
let tab = 'consumable';
let loadToken = 0;

const TEMPLATE = `
  <div class="panel">
    <div class="panel-header"><h1>Inventory</h1></div>
    <div class="mode-tabs" id="invTabs">
      <button class="mode-tab" data-tab="consumable">Stock &amp; food</button>
      <button class="mode-tab" data-tab="equipment">Equipment</button>
      <button class="mode-tab" data-tab="possession">Possessions</button>
    </div>
    <div id="invBody"></div>
  </div>`;

async function api(url, opts) {
  const r = await fetch(url, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'x-mc-by': 'you', ...((opts && opts.headers) || {}) },
  });
  const body = await r.json().catch(() => null);
  if (!r.ok) throw new Error((body && (body.why || body.error)) || ('HTTP ' + r.status));
  return body;
}

const failure = (m) => `<div class="card"><p class="failure-hint">${esc(m)}</p></div>`;
const empty = (m) => `<div class="card"><p class="empty-hint">${esc(m)}</p></div>`;

// --- the data entry section ------------------------------------------------
// One form per category, showing only the fields that mean something for it. A single
// generic form would ask for a reorder threshold on a printer.
const FORMS = {
  consumable: `
    <div class="card">
      <strong>Add stock</strong>
      <p class="empty-hint">Search for a food to link it to meal planning, or add a
        non-food consumable below.</p>
      <input id="invFoodQ" type="search" placeholder="Search a food — e.g. Huel">
      <button class="btn" id="invFoodGo">Search</button>
      <div id="invFoodResults"></div>
      <hr>
      <input id="invName" placeholder="Name">
      <input id="invQty" type="number" step="any" placeholder="Quantity">
      <input id="invUnit" placeholder="Unit — bag, spool, kg">
      <input id="invReorder" type="number" step="any" placeholder="Reorder at">
      <button class="btn" id="invAdd">Add</button>
      <p class="empty-hint">A reorder threshold is required: without one it can never appear
        in the reorder list, so it would be storage that tells you nothing.</p>
    </div>`,
  equipment: `
    <div class="card">
      <strong>Add equipment</strong>
      <input id="invName" placeholder="Name">
      <input id="invCost" type="number" step="0.01" placeholder="Cost £">
      <input id="invAcquired" type="date">
      <input id="invSupplier" placeholder="Supplier">
      <button class="btn" id="invAdd">Add</button>
    </div>`,
  possession: `
    <div class="card">
      <strong>Add possession</strong>
      <input id="invName" placeholder="Name">
      <input id="invCost" type="number" step="0.01" placeholder="Value £">
      <input id="invLocation" placeholder="Where it is">
      <select id="invInsured">
        <option value="">Insured? not said</option>
        <option value="1">Insured</option>
        <option value="0">Not insured</option>
      </select>
      <button class="btn" id="invAdd">Add</button>
    </div>`,
};

const val = (id) => {
  const el = root && root.querySelector('#' + id);
  return el ? el.value.trim() : '';
};

// £ in the box, pence in the database. The unit is in the column name for exactly this
// reason -- a float pound value stored as-is is how a total drifts.
const pence = (id) => {
  const v = val(id);
  return v === '' ? null : Math.round(Number(v) * 100);
};

function wireForm(body) {
  const add = body.querySelector('#invAdd');
  if (add) add.addEventListener('click', async () => {
    const name = val('invName');
    if (!name) return;
    add.disabled = true;
    const payload = { category: tab, name };
    if (tab === 'consumable') {
      payload.quantity = val('invQty') === '' ? null : Number(val('invQty'));
      payload.unit = val('invUnit') || null;
      payload.reorder_at = val('invReorder') === '' ? null : Number(val('invReorder'));
    } else if (tab === 'equipment') {
      payload.cost_pence = pence('invCost');
      payload.acquired_on = val('invAcquired') || null;
      payload.supplier = val('invSupplier') || null;
    } else {
      payload.cost_pence = pence('invCost');
      payload.location = val('invLocation') || null;
      const ins = val('invInsured');
      payload.insured = ins === '' ? null : Number(ins);
    }
    try {
      await api('/api/inventory/items', { method: 'POST', body: JSON.stringify(payload) });
      await switchTab(tab);
    } catch (e) {
      add.disabled = false;
      // The route's refusal text explains WHY, so show it rather than a generic failure.
      add.insertAdjacentHTML('afterend', `<p class="failure-hint">${esc(e.message)}</p>`);
    }
  });

  const go = body.querySelector('#invFoodGo');
  if (go) go.addEventListener('click', async () => {
    const q = val('invFoodQ');
    const out = body.querySelector('#invFoodResults');
    if (!q) return;
    out.innerHTML = '<p class="empty-hint">Searching…</p>';
    let d;
    try {
      d = await api('/api/lifestyle/foods/lookup?q=' + encodeURIComponent(q));
    } catch (e) { out.innerHTML = `<p class="failure-hint">${esc(e.message)}</p>`; return; }

    // THREE STATES, not two. Open Food Facts 503s regularly, and "could not look" must
    // never render as "this food does not exist" -- one is a fact about the network.
    if (d.state === 'error') { out.innerHTML = `<p class="failure-hint">${esc(d.why || 'lookup failed')} — ${esc(d.note || '')}</p>`; return; }
    const hits = d.matches || d.results || [];
    if (!hits.length) { out.innerHTML = `<p class="empty-hint">${esc(d.note || 'Nothing found. You can add it by hand below.')}</p>`; return; }

    out.innerHTML = hits.slice(0, 6).map((m, i) => `
      <div class="card">
        <strong>${esc(m.brand ? m.brand + ' — ' : '')}${esc(m.name)}</strong>
        <p class="empty-hint">${m.kcal != null ? m.kcal + ' kcal' : 'no kcal recorded'}${m.protein_g != null ? ', ' + m.protein_g + 'g protein' : ''}${m.serving ? ' per ' + esc(m.serving) : ''}</p>
        <input type="number" step="any" placeholder="How many?" data-qty="${i}">
        <input placeholder="Unit — bag, pouch" data-unit="${i}">
        <input type="number" step="any" placeholder="Reorder at" data-re="${i}">
        <button class="btn" data-pick="${i}">Add to stock</button>
      </div>`).join('');

    out.querySelectorAll('[data-pick]').forEach((b) => b.addEventListener('click', async () => {
      const i = Number(b.dataset.pick);
      const m = hits[i];
      const q2 = out.querySelector(`[data-qty="${i}"]`).value.trim();
      const u = out.querySelector(`[data-unit="${i}"]`).value.trim();
      const re = out.querySelector(`[data-re="${i}"]`).value.trim();
      b.disabled = true;
      try {
        // Two writes, in order, and the food FIRST: the stock row is meaningless without
        // something to link to, and a stock row with a dangling food_id is worse than none.
        const food = await api('/api/lifestyle/foods', {
          method: 'POST',
          body: JSON.stringify({
            name: m.name, brand: m.brand || null, barcode: m.barcode || null, serving: m.serving || null,
            kcal: m.kcal, protein_g: m.protein_g, carbs_g: m.carbs_g, fat_g: m.fat_g, fibre_g: m.fibre_g,
            source: 'openfoodfacts', source_ref: m.barcode || m.source_ref || null,
          }),
        });
        await api('/api/inventory/items', {
          method: 'POST',
          body: JSON.stringify({
            category: 'consumable',
            name: (m.brand ? m.brand + ' ' : '') + m.name,
            quantity: q2 === '' ? null : Number(q2),
            unit: u || null,
            reorder_at: re === '' ? 1 : Number(re),
            food_id: food.id,
          }),
        });
        await switchTab('consumable');
      } catch (e) {
        b.disabled = false;
        b.insertAdjacentHTML('afterend', `<p class="failure-hint">${esc(e.message)}</p>`);
      }
    }));
  });
}

function itemCard(it, extra) {
  return `
    <div class="card">
      <strong>${esc(it.name)}</strong>
      ${it.food_id ? '<span class="badge">meal planning</span>' : ''}
      ${it.disposed_on ? '<span class="badge">disposed ' + esc(it.disposed_on) + '</span>' : ''}
      ${extra || ''}
      ${it.note ? `<p>${esc(it.note)}</p>` : ''}
    </div>`;
}

async function renderConsumables(body) {
  const [re, list, food] = await Promise.all([
    api('/api/inventory/reorder'),
    api('/api/inventory/items?category=consumable'),
    api('/api/inventory/food'),
  ]);

  const head = re.count
    ? `<div class="card"><strong>${re.count} item(s) at or below threshold</strong>
        ${re.reorder.map((r) => `<p>${esc(r.name)} — ${r.quantity}${esc(r.unit || '')} left, short by ${r.short_by}</p>`).join('')}</div>`
    : empty(re.state || 'Nothing needs reordering.');

  const residue = re.residue && re.residue.no_threshold_or_quantity
    ? `<p class="empty-hint">${re.residue.no_threshold_or_quantity} item(s) cannot be judged: ${esc(re.residue.why)}</p>` : '';

  const mealLine = `<p class="empty-hint">Meal planning can see <strong>${food.count}</strong>
      food item(s) in stock${food.residue && food.residue.out_of_stock ? ', ' + food.residue.out_of_stock + ' more recorded but at zero' : ''}.
      ${food.definitions_state ? esc(food.definitions_state) : ''}</p>`;

  body.innerHTML = head + residue + mealLine + FORMS.consumable
    + (list.count ? list.items.map((it) => itemCard(it, `
        <div class="stats-summary">
          <div class="stat-block"><div class="stat-label">In stock</div><div class="stat-value">${it.quantity == null ? '—' : it.quantity + ' ' + esc(it.unit || '')}</div></div>
          <div class="stat-block"><div class="stat-label">Reorder at</div><div class="stat-value">${it.reorder_at == null ? '—' : it.reorder_at}</div></div>
        </div>
        <button class="btn" data-use="${it.id}">Use 1</button>
        <button class="btn" data-restock="${it.id}">Restock 1</button>`)).join('')
      : empty(list.state || 'No consumables recorded.'));

  wireForm(body);
  body.querySelectorAll('[data-use],[data-restock]').forEach((b) => b.addEventListener('click', async () => {
    const id = b.dataset.use || b.dataset.restock;
    const path = b.dataset.use ? 'use' : 'restock';
    b.disabled = true;
    await api('/api/inventory/items/' + id + '/' + path, { method: 'POST', body: JSON.stringify({ quantity: 1 }) });
    await switchTab('consumable');
  }));
}

async function renderEquipment(body) {
  const [cap, list] = await Promise.all([
    api('/api/inventory/capital'),
    api('/api/inventory/items?category=equipment'),
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

  body.innerHTML = head + residue + FORMS.equipment
    + (list.count ? list.items.map((it) => itemCard(it, `
        <div class="stats-summary">
          <div class="stat-block"><div class="stat-label">Cost</div><div class="stat-value">${it.cost_pence == null ? '—' : gbp(it.cost_pence)}</div></div>
          <div class="stat-block"><div class="stat-label">Acquired</div><div class="stat-value">${esc(it.acquired_on || '—')}</div></div>
        </div>`)).join('')
      : empty(list.state || 'No equipment recorded.'));
  wireForm(body);
}

async function renderPossessions(body) {
  const [v, list] = await Promise.all([
    api('/api/inventory/value'),
    api('/api/inventory/items?category=possession'),
  ]);
  body.innerHTML = `
    <div class="stats-summary">
      <div class="stat-block"><div class="stat-label">Total</div><div class="stat-value">${gbp(v.total_pence)}</div></div>
      <div class="stat-block"><div class="stat-label">Counted</div><div class="stat-value">${v.counted}</div></div>
      <div class="stat-block"><div class="stat-label">Uninsured</div><div class="stat-value">${v.uninsured}</div></div>
      <div class="stat-block"><div class="stat-label">Not said</div><div class="stat-value">${v.insurance_unknown}</div></div>
    </div>
    <p class="empty-hint">"Not said" is not "uninsured" — nobody has answered, which is a
       different state from a settled no. ${v.unpriced} item(s) have no value recorded.</p>
    ${FORMS.possession}
    ${list.count ? list.items.map((it) => itemCard(it, `
      <div class="stats-summary">
        <div class="stat-block"><div class="stat-label">Value</div><div class="stat-value">${it.cost_pence == null ? '—' : gbp(it.cost_pence)}</div></div>
        <div class="stat-block"><div class="stat-label">Where</div><div class="stat-value">${esc(it.location || '—')}</div></div>
      </div>`)).join('') : empty(list.state || 'No possessions recorded.')}`;
  wireForm(body);
}

async function switchTab(name) {
  if (!root) return;
  tab = name;
  const token = ++loadToken;
  root.querySelectorAll('.mode-tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  const body = root.querySelector('#invBody');
  body.innerHTML = '<p class="empty-hint">Loading…</p>';
  try {
    if (name === 'consumable') await renderConsumables(body);
    else if (name === 'equipment') await renderEquipment(body);
    else await renderPossessions(body);
  } catch (e) {
    if (token !== loadToken || !root) return;
    body.innerHTML = failure('Could not load: ' + e.message);
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

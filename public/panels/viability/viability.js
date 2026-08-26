// Viability. Reads only /api/viability.
//
// M128: one calculator — unit price, unit cost, fixed costs — reused across every new
// business idea instead of a bespoke spreadsheet per venture. The three numbers you type
// are the only things stored; margin, break-even volume and the sentence describing them
// are recomputed on every read, same discipline as the goals panel.
//
// A negative or zero margin is never printed as a bigger break-even number. It is said in
// words: no volume fixes a unit that loses money. A number you have not typed reads
// "not set" — never blank, never zero, because both of those read as free.
import { renderLede } from '/panels/lede/lede.js';

const TEMPLATE = `
  <div class="panel panel-wide vb-panel">
    <div class="panel-header">
      <h1>Viability</h1>
    </div>

    <section class="card">
      <div id="vbErr"></div>
      <div id="vbTop"></div>
    </section>

    <div id="vbList"></div>

    <section class="card">
      <h2 class="vb-h2">Add a scenario</h2>
      <form class="vb-add" id="vbAddForm">
        <input id="vbVenture" class="vb-in" placeholder="Venture — e.g. Dropshipping" required>
        <input id="vbTitle" class="vb-in" placeholder="Scenario — e.g. Launch price" required>
        <input id="vbPrice" class="vb-in money" type="number" step="0.01" min="0" placeholder="price £">
        <input id="vbCost" class="vb-in money" type="number" step="0.01" min="0" placeholder="unit cost £">
        <input id="vbFixed" class="vb-in money" type="number" step="0.01" min="0" placeholder="fixed costs £">
        <select id="vbPeriod" class="vb-select">
          <option value="">fixed costs are —</option>
          <option value="one-off">one-off</option>
          <option value="monthly">monthly</option>
        </select>
        <button class="btn primary" type="submit">Add</button>
      </form>
      <p class="vb-note">Every field but venture and scenario name can be left blank. A blank
      price or cost reads "not set" here, not zero — nothing is invented to fill the gap.</p>
    </section>
  </div>
`;

let root = null;
let onClick = null;
let onSubmit = null;
let token = 0;
const opened = new Set();

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const gbp = (p) => `£${(p / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// Same four-way failure split as goals.js: "could not look" must never render like
// "looked, and there is nothing".
async function api(path, opts) {
  let res;
  try {
    res = await fetch(`/api/viability${path}`, opts);
  } catch (e) {
    const err = new Error(`could not reach the server — ${e.message}`);
    err.kind = 'unreachable';
    throw err;
  }
  let body = null;
  try { body = await res.json(); } catch { body = null; }

  if (!res.ok) {
    const err = new Error((body && body.error) || `HTTP ${res.status}`);
    err.kind = body && body.failed ? 'query-failed' : 'rejected';
    throw err;
  }
  if (body === null) {
    const err = new Error('the server answered with something that was not JSON');
    err.kind = 'unreadable';
    throw err;
  }
  return body;
}

function errorBox(err, headline, offerRetry) {
  const what = {
    unreachable: 'The dashboard server did not answer.',
    'query-failed': 'The server reached the database and the query failed.',
    rejected: 'The server refused that.',
    unreadable: 'The server answered, but not with data this panel can read.',
  }[err.kind] || 'Something failed and it is not clear what.';
  return `<p class="vb-error"><b>${esc(headline)}</b> ${esc(what)}
    <br>${esc(err.message)}
    ${offerRetry ? `<br>This is a failure, not an empty list — nothing was read, so the absence
    of scenarios below does not mean there are none.
    <span class="vb-next-do"><button class="btn vb-mini" type="button" data-act="retry">Try again</button></span>` : ''}</p>`;
}

// ---------------------------------------------------------------------------- rendering
function scenarioRow(s) {
  const cls = s.unitMarginPence === null ? 'is-empty' : s.losesPerUnit ? 'is-loss' : s.breakEvenUnits !== null ? 'is-priced' : 'is-partial';
  const priceValue = s.unitPricePence === null ? '' : (s.unitPricePence / 100).toFixed(2);
  const costValue = s.unitCostPence === null ? '' : (s.unitCostPence / 100).toFixed(2);
  const fixedValue = s.fixedCostsPence === null ? '' : (s.fixedCostsPence / 100).toFixed(2);
  const open = opened.has(s.id) ? ' open' : '';

  return `
    <li class="vb-scenario ${cls}" data-scenario="${s.id}">
      <div class="vb-top">
        <h3 class="vb-title">${esc(s.title)}</h3>
        ${s.breakEvenUnits !== null ? `<span class="vb-chip on-target">${plural(s.breakEvenUnits, 'unit')} to break even</span>` : ''}
        ${s.losesPerUnit ? `<span class="vb-chip loss">loses money per unit</span>` : ''}
      </div>
      <p class="vb-sentence${s.breakEvenUnits !== null ? '' : ' none'}">${esc(s.sentence)}</p>
      <div class="vb-facts">
        <span>price <b>${s.unitPricePence === null ? 'not set' : gbp(s.unitPricePence)}</b></span>
        <span>unit cost <b>${s.unitCostPence === null ? 'not set' : gbp(s.unitCostPence)}</b></span>
        <span>fixed costs <b>${s.fixedCostsPence === null ? 'not set' : gbp(s.fixedCostsPence)}</b>${s.fixedPeriod ? ` (${s.fixedPeriod})` : ''}</span>
        ${s.marginPct !== null ? `<span>margin <b>${s.marginPct}%</b></span>` : ''}
      </div>
      ${s.note ? `<p class="vb-scenario-note">${esc(s.note)}</p>` : ''}

      <details class="vb-edit" data-details="${s.id}"${open}>
        <summary>Edit</summary>
        <form class="vb-row" data-save="${s.id}">
          <input class="vb-in" name="venture" placeholder="venture" value="${esc(s.venture)}" required>
          <input class="vb-in" name="title" placeholder="scenario" value="${esc(s.title)}" required>
          <input class="vb-in money" name="unitPrice" type="number" step="0.01" min="0" placeholder="price £" value="${priceValue}">
          <input class="vb-in money" name="unitCost" type="number" step="0.01" min="0" placeholder="unit cost £" value="${costValue}">
          <input class="vb-in money" name="fixedCosts" type="number" step="0.01" min="0" placeholder="fixed costs £" value="${fixedValue}">
          <select class="vb-select" name="fixedPeriod">
            <option value=""${!s.fixedPeriod ? ' selected' : ''}>fixed costs are —</option>
            <option value="one-off"${s.fixedPeriod === 'one-off' ? ' selected' : ''}>one-off</option>
            <option value="monthly"${s.fixedPeriod === 'monthly' ? ' selected' : ''}>monthly</option>
          </select>
          <input class="vb-in wide" name="note" placeholder="note" value="${esc(s.note || '')}">
          <button class="btn vb-mini" type="submit">Save</button>
          <button class="vb-x" type="button" data-act="delete" data-scenario="${s.id}" title="Remove this scenario">×</button>
        </form>
      </details>
    </li>`;
}

function ventureGroup(v) {
  return `
    <section class="card vb-venture">
      <div class="vb-venture-head">
        <h2 class="vb-venture-title">${esc(v.venture)}</h2>
        <span class="vb-tally">${plural(v.count, 'scenario')}</span>
      </div>
      <ul class="vb-scenarios">${v.scenarios.map(scenarioRow).join('')}</ul>
    </section>`;
}

function render(d) {
  const top = root.querySelector('#vbTop');
  const list = root.querySelector('#vbList');

  if (d.state === 'empty') {
    top.innerHTML = `<p class="empty-hint">${esc(d.message)}</p>
      <p class="vb-note">This is an empty list, and the server said so explicitly — it is
      not a failed read. A failure would be in an orange box saying which part failed.</p>`;
    list.innerHTML = '';
    return;
  }

  const c = d.counts;
  top.innerHTML = `
    <div class="vb-counts">
      <span class="vb-count"><span class="vb-count-v">${c.distinctVentures}</span><span class="vb-count-l">${plural(c.distinctVentures, 'venture')}</span></span>
      <span class="vb-count"><span class="vb-count-v">${c.withBreakEven}</span><span class="vb-count-l">with a break-even volume</span></span>
      <span class="vb-count"><span class="vb-count-v">${c.losingMoney}</span><span class="vb-count-l">losing money per unit</span></span>
      <span class="vb-count"><span class="vb-count-v">${c.missingInputs}</span><span class="vb-count-l">missing price or cost</span></span>
    </div>
    <p class="vb-note">Nothing here ranks one venture against another — no score, no
    weighting. Each scenario is arithmetic you typed, and you can check it.</p>`;

  list.innerHTML = d.ventures.map(ventureGroup).join('');
}

async function load() {
  if (!root) return;
  const mine = token;
  let d;
  try {
    d = await api('/');
  } catch (err) {
    if (mine !== token || !root) return;
    root.querySelector('#vbErr').innerHTML = errorBox(err, 'Could not load your scenarios.', true);
    root.querySelector('#vbTop').innerHTML = '';
    root.querySelector('#vbList').innerHTML = '';
    return;
  }
  if (mine !== token || !root) return;
  root.querySelector('#vbErr').innerHTML = '';
  render(d);
}

async function act(fn) {
  if (!root) return;
  const mine = token;
  try {
    await fn();
  } catch (err) {
    if (mine !== token || !root) return;
    root.querySelector('#vbErr').innerHTML = errorBox(err, 'That change was not saved.', false);
    return;
  }
  if (mine !== token) return;
  await load();
}

// ---------------------------------------------------------------------------- wiring
export default {
  mount(el) {
    root = el;
    token += 1;
    el.innerHTML = TEMPLATE;
    renderLede('viability', el);

    // M141: creative.js sends business-shaped ideas here with the venture
    // name already picked (so it agrees with what /api/creative checks
    // against) -- read once and clear, so a later manual visit to this panel
    // does not keep refilling a stale value.
    try {
      const prefill = sessionStorage.getItem('mc_viability_prefill_venture');
      if (prefill) {
        sessionStorage.removeItem('mc_viability_prefill_venture');
        const ventureInput = el.querySelector('#vbVenture');
        if (ventureInput) ventureInput.value = prefill;
      }
    } catch {}

    onClick = (ev) => {
      const summary = ev.target.closest('.vb-edit > summary');
      if (summary) {
        const id = Number(summary.parentElement.dataset.details);
        if (summary.parentElement.open) opened.delete(id); else opened.add(id);
        return undefined;
      }

      const btn = ev.target.closest('[data-act]');
      if (!btn || !root.contains(btn)) return undefined;
      const { act: what, scenario } = btn.dataset;

      if (what === 'retry') { load(); return undefined; }
      if (what === 'delete') {
        if (!window.confirm('Remove this scenario? It cannot be undone.')) return undefined;
        return act(() => api(`/${scenario}`, { method: 'DELETE' }));
      }
      return undefined;
    };

    onSubmit = (ev) => {
      const form = ev.target;
      ev.preventDefault();
      const value = (name) => {
        const f = form.elements[name];
        return f ? f.value.trim() : '';
      };

      if (form.id === 'vbAddForm') {
        const venture = root.querySelector('#vbVenture').value.trim();
        const title = root.querySelector('#vbTitle').value.trim();
        if (!venture || !title) return undefined;
        return act(async () => {
          await api('/', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-mc-by': 'you' },
            body: JSON.stringify({
              venture, title,
              unitPrice: root.querySelector('#vbPrice').value,
              unitCost: root.querySelector('#vbCost').value,
              fixedCosts: root.querySelector('#vbFixed').value,
              fixedPeriod: root.querySelector('#vbPeriod').value || null,
            }),
          });
          form.reset();
        });
      }

      if (form.dataset.save) {
        opened.add(Number(form.dataset.save));
        return act(() => api(`/${form.dataset.save}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json', 'x-mc-by': 'you' },
          body: JSON.stringify({
            venture: value('venture'),
            title: value('title'),
            unitPrice: value('unitPrice'),
            unitCost: value('unitCost'),
            fixedCosts: value('fixedCosts'),
            fixedPeriod: value('fixedPeriod') || null,
            note: value('note') || null,
          }),
        }));
      }
      return undefined;
    };

    el.addEventListener('click', onClick);
    el.addEventListener('submit', onSubmit);
    load();
  },

  unmount() {
    if (root) {
      root.removeEventListener('click', onClick);
      root.removeEventListener('submit', onSubmit);
      root.innerHTML = '';
    }
    token += 1;
    onClick = null;
    onSubmit = null;
    opened.clear();
    root = null;
  },
};

//
// safety-retro — a spending retrospective over the safety_decisions table.
//
// FOUR SECTIONS, ONE FETCH.
//   'Quietest vs busiest' — the months with the fewest and most spending
//   decisions, side by side, so a lull or a surge is not buried in a list.
//   'Top payees' — who has accumulated the most authorised spend, ranked by
//   total amount. A payee that dominates the total is worth noticing even when
//   no single transaction was large.
//   'Active limits' — the per-transaction and per-month ceilings currently in
//   force, with who set them and when. A limit that was never configured is
//   shown as zero, not hidden.
//   'Recent decisions' — every recorded decision, newest first, with outcome,
//   amount, payee, and the reasons the guard gave. The raw log, not a summary.
//
// NOTHING HERE DERIVES ANYTHING. The monthly comparison and payee ranking come
// from the route, which reads the same tables the safety guard writes. A panel
// that recomputed totals would agree with the route until one was edited, and
// then disagree without either erroring — the exact failure this project keeps
// meeting.
import { renderLede } from '/panels/lede/lede.js';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const day = (s) => String(s || '').slice(0, 10);
const time = (s) => String(s || '').slice(11, 16);

// Format a pounds value from the route (already converted from pence).
const money = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return '£0.00';
  return '£' + n.toFixed(2);
};

// Format a month key (YYYY-MM) into a readable label.
const monthLabel = (m) => {
  if (!m) return '—';
  const [y, mo] = m.split('-');
  const names = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const idx = Number(mo) - 1;
  if (idx >= 0 && idx < 12) return `${names[idx]} ${y}`;
  return m;
};

let root = null;
let state = null;

// ---- Section 1: Quietest vs busiest month -----------------------------------

function monthCardHTML(label, info) {
  if (!info) {
    return `<div class="sr-month sr-month-none">
      <h3>${esc(label)}</h3>
      <p class="sr-month-empty">No data.</p>
    </div>`;
  }
  return `<div class="sr-month">
    <h3>${esc(label)}</h3>
    <p class="sr-month-label">${esc(monthLabel(info.month))}</p>
    <p class="sr-month-stat"><span class="sr-stat-n">${info.count}</span> decision${info.count === 1 ? '' : 's'}</p>
    <p class="sr-month-stat">${money(info.total)}</p>
  </div>`;
}

function quietestBusiestHTML(data) {
  const { quietestMonth, busiestMonth } = data;
  if (!quietestMonth && !busiestMonth) {
    return '<p class="sr-empty">Not enough data to compare months yet. A single month has no quiet or busy — that takes two.</p>';
  }
  return `<div class="sr-month-pair">
    ${monthCardHTML('Quietest month', quietestMonth)}
    ${monthCardHTML('Busiest month', busiestMonth)}
  </div>`;
}

// ---- Section 2: Top payees --------------------------------------------------

function payeesHTML(payees) {
  if (!payees.length) {
    return '<p class="sr-empty">No payees recorded. A decision without a payee is not a spend, and the guard says so.</p>';
  }
  const rows = payees.map((p) => `<tr class="sr-payee-row">
    <td class="sr-payee-name">${esc(p.payee)}</td>
    <td class="sr-payee-total">${money(p.total)}</td>
    <td class="sr-payee-count">${p.count}</td>
  </tr>`).join('');
  return `<table class="sr-table">
    <thead><tr><th>Payee</th><th>Total</th><th>Decisions</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

// ---- Section 3: Active limits -----------------------------------------------

function limitRowHTML(l) {
  const label = l.key === 'per_transaction_pence' ? 'Per transaction'
    : l.key === 'per_month_pence' ? 'Per month'
    : esc(l.key);
  const who = l.setBy ? `set by ${esc(l.setBy)}` : '';
  const when = l.setAt ? `${esc(day(l.setAt))} ${esc(time(l.setAt))}` : '';
  return `<tr class="sr-limit-row">
    <td class="sr-limit-key">${esc(label)}</td>
    <td class="sr-limit-value">${money(l.value)}</td>
    <td class="sr-limit-meta">${who}${when ? ` · ${when}` : ''}</td>
  </tr>`;
}

function limitsHTML(limits) {
  if (!limits.length) {
    return '<p class="sr-empty">No spending limits in the database. The guard fails closed — zero is the absence of permission, not a budget.</p>';
  }
  const rows = limits.map(limitRowHTML).join('');
  return `<table class="sr-table">
    <thead><tr><th>Limit</th><th>Value</th><th>Set</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

// ---- Section 4: Recent decisions --------------------------------------------

function reasonsHTML(reasons) {
  if (!reasons || !reasons.length) return '';
  return `<span class="sr-reasons">${reasons.map((r) => `<span class="sr-reason">${esc(r)}</span>`).join('')}</span>`;
}

function decisionRowHTML(d) {
  const outcomeClass = d.outcome === 'allowed' ? 'sr-outcome-allowed' : 'sr-outcome-refused';
  const payee = d.payee ? esc(d.payee) : '<span class="sr-null">no payee</span>';
  const amount = d.amountPence != null ? money(d.amount) : '<span class="sr-null">—</span>';
  const when = d.decidedAt ? `${esc(day(d.decidedAt))} ${esc(time(d.decidedAt))}` : '—';
  const who = d.askedBy ? esc(d.askedBy) : '<span class="sr-null">unknown</span>';
  return `<article class="sr-card ${outcomeClass}">
    <div class="sr-card-head">
      <span class="sr-outcome ${outcomeClass}">${esc(d.outcome)}</span>
      <span class="sr-amount">${amount}</span>
    </div>
    <p class="sr-payee-line">${payee}</p>
    ${d.action ? `<p class="sr-action">${esc(d.action)}</p>` : ''}
    <p class="sr-meta"><span class="sr-who">${who}</span> <span class="sr-when">${when}</span></p>
    ${reasonsHTML(d.reasons)}
  </article>`;
}

function decisionsHTML(decisions) {
  if (!decisions.length) {
    return '<p class="sr-empty">No decisions recorded yet. A guard that has never been asked is not the same as a guard that never refused.</p>';
  }
  return decisions.map(decisionRowHTML).join('');
}

// ---- Main render ------------------------------------------------------------

function render() {
  if (!root || !state) return;

  if (state.error) {
    root.innerHTML = `<section class="panel sr-panel">
      <h1>Safety retrospective</h1>
      <p class="sr-alarm">Could not read the spending log — ${esc(state.error)}.
      That is a failure to look, not an empty log.</p>
    </section>`;
    return;
  }

  if (!state.data) {
    root.innerHTML = `<section class="panel sr-panel"><h1>Safety retrospective</h1>
      <p class="sr-loading">Reading the log…</p></section>`;
    return;
  }

  const data = state.data;
  const { decisions, limits, payees, quietestMonth, busiestMonth, totalDecisions, totalAmount } = data;

  root.innerHTML = `<section class="panel sr-panel">
    <h1>Safety retrospective</h1>
    <p class="sr-lede">A retrospective over spending decisions — which months were quiet or busy,
      which payees dominate, what limits are in force, and the raw log of every call the guard has
      made. The guard itself lives in the Safety panel; this is what happened after the answer.</p>

    <p class="sr-summary">
      <span class="sr-summary-n">${totalDecisions}</span> decision${totalDecisions === 1 ? '' : 's'} recorded ·
      <span class="sr-summary-n">${money(totalAmount)}</span> total
    </p>

    <h2 class="sr-h2">Quietest vs busiest month</h2>
    ${quietestBusiestHTML({ quietestMonth, busiestMonth })}

    <h2 class="sr-h2">Top payees <span class="sr-n">${payees.length}</span></h2>
    ${payeesHTML(payees)}

    <h2 class="sr-h2">Active spending limits <span class="sr-n">${limits.length}</span></h2>
    ${limitsHTML(limits)}

    <h2 class="sr-h2">Recent decisions <span class="sr-n">${decisions.length}</span></h2>
    ${decisionsHTML(decisions)}
  </section>`;
}

async function load() {
  try {
    state.data = await (await fetch('/api/safety-retro')).json();
    state.error = null;
  } catch (e) {
    state.error = e.message;
  }
  render();
}

export default {
  mount(el, opts) {
    root = el;
    state = { data: null, error: null };
    render();
    load();
    renderLede('safety-retro', el);
  },
  unmount() { root = null; state = null; },
};
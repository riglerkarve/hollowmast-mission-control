//
// recurring-costs — shows recurring/subscription costs grouped by description,
// with total paid, count, last paid date, and average monthly cost.
//
// The total monthly cost is shown prominently at the top. Items are sorted by
// average monthly cost descending, so the most expensive recurring charge is
// the first thing seen — the one most worth questioning.
//
// NOTHING HERE DERIVES ANYTHING. The grouping and averaging come from the
// route. A panel that recomputed them would agree with the route until one was
// edited, and then disagree without either erroring — the exact failure this
// project keeps meeting.
import { renderLede } from '/panels/lede/lede.js';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const day = (s) => String(s || '').slice(0, 10);

const money = (n) => {
  if (n == null) return '—';
  const v = Number(n);
  if (Number.isNaN(v)) return '—';
  return '£' + v.toFixed(2);
};

let root = null;
let state = null;

function rowHTML(item) {
  return `<tr class="rc-row">
    <td class="rc-desc">${esc(item.description)}</td>
    <td class="rc-num">${money(item.totalPaid)}</td>
    <td class="rc-num">${esc(item.count)}</td>
    <td class="rc-date">${esc(day(item.lastDate))}</td>
    <td class="rc-num rc-avg">${money(item.avgMonthly)}</td>
  </tr>`;
}

function render() {
  if (!root || !state) return;

  if (state.error) {
    root.innerHTML = `<section class="panel rc-panel">
      <h1>Recurring costs</h1>
      <p class="rc-alarm">Could not read recurring costs — ${esc(state.error)}.
      That is a failure to look, not an empty result.</p>
    </section>`;
    return;
  }

  if (!state.data) {
    root.innerHTML = `<section class="panel rc-panel"><h1>Recurring costs</h1>
      <p class="rc-loading">Reading recurring costs…</p></section>`;
    return;
  }

  const { items, totalMonthly, count, state: emptyState } = state.data;

  if (!items || !items.length) {
    root.innerHTML = `<section class="panel rc-panel">
      <h1>Recurring costs</h1>
      <p class="rc-empty">${esc(emptyState || 'No recurring costs found.')}</p>
    </section>`;
    return;
  }

  const rowsHTML = items.map(rowHTML).join('');

  root.innerHTML = `<section class="panel rc-panel">
    <h1>Recurring costs</h1>
    <p class="rc-lede">Every transaction whose description mentions a subscription, monthly
      payment, or recurring charge, grouped and averaged. The total monthly figure is the
      sum of each group's average — what you pay per month if every recurrence continues.</p>

    <div class="rc-total">
      <span class="rc-total-label">Total monthly</span>
      <span class="rc-total-value">${money(totalMonthly)}</span>
      <span class="rc-total-count">${count} recurring charge${count === 1 ? '' : 's'}</span>
    </div>

    <table class="rc-table">
      <thead>
        <tr>
          <th>Description</th>
          <th class="rc-num">Total paid</th>
          <th class="rc-num">Count</th>
          <th>Last paid</th>
          <th class="rc-num">Avg / month</th>
        </tr>
      </thead>
      <tbody>
        ${rowsHTML}
      </tbody>
    </table>
  </section>`;
}

async function load() {
  try {
    state.data = await (await fetch('/api/recurring-costs')).json();
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
    renderLede('recurring-costs', el);
  },
  unmount() { root = null; state = null; },
};

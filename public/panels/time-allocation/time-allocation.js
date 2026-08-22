//
// time-allocation — where time has been spent across agents and projects over
// the last N days. Two breakdowns (by agent, by project), one fetch, and a days
// selector (7/14/30) that re-fetches.
//
// NOTHING HERE DERIVES ANYTHING. The breakdowns come from the route, which
// aggregates session records. A panel that recomputed "by agent" would agree
// with the route until one was edited, and then disagree without either
// erroring — the exact failure this project keeps meeting.
import { renderLede } from '/panels/lede/lede.js';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Format minutes as hours+minutes: 1252 → '20h 52m', 65 → '1h 5m', 5 → '5m'.
// The route sends whole minutes; rounding guards a fractional surprise.
function fmtMins(m) {
  m = Math.max(0, Math.round(Number(m) || 0));
  const h = Math.floor(m / 60);
  const mm = m % 60;
  if (h === 0) return `${mm}m`;
  return `${h}h ${mm}m`;
}

const DAYS = [7, 14, 30];

let root = null;
let state = null;

function daysBar() {
  return DAYS.map((n) => {
    const on = n === state.days ? ' on' : '';
    return `<button class="ta-day${on}" data-days="${n}">${n}d</button>`;
  }).join('');
}

function rowHTML(item, labelKey) {
  const label = esc(item[labelKey] || 'unknown');
  const time = esc(fmtMins(item.minutes));
  const sessions = Number(item.sessions) || 0;
  const pct = Number(item.percent) || 0;
  const sessNoun = sessions === 1 ? 'session' : 'sessions';
  return `<div class="ta-row">
    <div class="ta-row-top">
      <span class="ta-label">${label}</span>
      <span class="ta-time">${time}</span>
      <span class="ta-sessions">${sessions} ${sessNoun}</span>
      <span class="ta-pct">${pct.toFixed(1)}%</span>
    </div>
    <div class="ta-bar"><div class="ta-bar-fill" style="width:${Math.min(100, pct)}%"></div></div>
  </div>`;
}

// Sort by minutes descending — the biggest time sink is the first thing scanned.
function sectionHTML(items, labelKey) {
  if (!items || !items.length) return '';
  const sorted = [...items].sort((a, b) =>
    (Number(b.minutes) || 0) - (Number(a.minutes) || 0));
  return sorted.map((item) => rowHTML(item, labelKey)).join('');
}

function wireDays() {
  if (!root) return;
  root.querySelectorAll('.ta-day').forEach((b) => {
    b.addEventListener('click', () => {
      const n = Number(b.dataset.days) || 30;
      if (n === state.days) return;
      state.days = n;
      state.data = null;
      render();
      load();
    });
  });
}

function render() {
  if (!root || !state) return;

  if (state.error) {
    root.innerHTML = `<section class="panel ta-panel">
      <h1>Time allocation</h1>
      <p class="ta-alarm">Could not read time allocation — ${esc(state.error)}.
      That is a failure to look, not an empty ledger.</p>
    </section>`;
    return;
  }

  if (!state.data) {
    root.innerHTML = `<section class="panel ta-panel"><h1>Time allocation</h1>
      <p class="ta-loading">Reading the ledger…</p></section>`;
    return;
  }

  const d = state.data;
  const days = state.days;
  const total = Number(d.total) || 0;
  const hasData = total > 0
    || ((d.byAgent && d.byAgent.length) || (d.byProject && d.byProject.length));

  if (!hasData) {
    root.innerHTML = `<section class="panel ta-panel">
      <h1>Time allocation</h1>
      <p class="ta-lede">Where time has been spent across agents and projects over the last
        ${esc(days)} days.</p>
      <div class="ta-days">${daysBar()}</div>
      <p class="ta-empty">No time tracked in the last ${esc(days)} days.
        That is a real count, not a failed read.</p>
    </section>`;
    wireDays();
    return;
  }

  const agentN = (d.byAgent || []).length;
  const projN = (d.byProject || []).length;
  root.innerHTML = `<section class="panel ta-panel">
    <h1>Time allocation</h1>
    <p class="ta-lede">Where time has been spent across agents and projects over the last
      ${esc(days)} days.</p>
    <div class="ta-days">${daysBar()}</div>
    <div class="ta-total">
      <span class="ta-total-num">${esc(fmtMins(total))}</span>
      <span class="ta-total-label">total tracked</span>
    </div>

    <h2 class="ta-h2">By agent <span class="ta-n">${agentN}</span></h2>
    <div class="ta-rows">${sectionHTML(d.byAgent, 'agent')}</div>

    <h2 class="ta-h2">By project <span class="ta-n">${projN}</span></h2>
    <div class="ta-rows">${sectionHTML(d.byProject, 'project')}</div>
  </section>`;
  wireDays();
}

async function load() {
  try {
    const r = await fetch(`/api/time-allocation?days=${state.days}`);
    if (!r.ok) throw new Error(`/api/time-allocation answered ${r.status}`);
    state.data = await r.json();
    state.error = null;
  } catch (e) {
    state.error = e.message;
  }
  render();
}

export default {
  mount(el, opts) {
    root = el;
    state = { data: null, error: null, days: 30 };
    render();
    load();
    renderLede('time-allocation', el);
  },
  unmount() { root = null; state = null; },
};
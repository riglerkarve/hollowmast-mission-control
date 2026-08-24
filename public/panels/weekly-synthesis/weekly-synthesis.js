//
// weekly-synthesis — the one weekly view: what deserves attention, not four
// signals to check separately (M136).
//
// NOTHING HERE DERIVES ANYTHING. The headline is briefing.js's own stuck-longest
// fact, the momentum list is ventures.js's own momentum classification, and the
// time split is time-allocation.js's own aggregate. This panel only lays out what
// /api/weekly-synthesis already selected from them.
import { renderLede } from '/panels/lede/lede.js';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

let root = null;
let state = null;

function fmtMinutes(total) {
  const m = Number(total) || 0;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (h > 0) return `${h}h ${rem}m`;
  return `${rem}m`;
}

function headlineHTML(headline) {
  if (!headline) {
    return `<section class="ws-headline ws-headline-quiet">
      <h2 class="ws-h2">This week</h2>
      <p class="ws-quiet">Nothing has been waiting long enough to lead with. That is a
        real quiet week, not a failed read.</p>
    </section>`;
  }
  return `<section class="ws-headline">
    <h2 class="ws-h2">This week</h2>
    <p class="ws-headline-text">${esc(headline.text)}</p>
  </section>`;
}

function momentumHTML(momentum) {
  if (!momentum) return '';
  if (!momentum.total) {
    return `<section class="ws-section">
      <h3 class="ws-h3">Ventures</h3>
      <p class="ws-empty">No ventures registered.</p>
    </section>`;
  }
  const stats = `<div class="ws-mom-stats">
    <span class="ws-mom-stat"><b>${esc(momentum.active)}</b> active</span>
    <span class="ws-mom-stat"><b>${esc(momentum.slowing)}</b> slowing</span>
    <span class="ws-mom-stat ws-mom-bad"><b>${esc(momentum.stalledCount)}</b> stalled</span>
  </div>`;
  const rows = momentum.stalled.length
    ? momentum.stalled.map((v) => `<div class="ws-vn-row">
        <span class="ws-vn-name">${esc(v.name)}</span>
        <span class="ws-vn-days">${esc(v.daysSinceActivity)}d</span>
        <span class="ws-vn-open">${esc(v.openItems)} open${v.staleItems ? `, ${esc(v.staleItems)} stale` : ''}</span>
      </div>`).join('')
    : '<p class="ws-empty">Nothing stalled — every venture has moved in the last week.</p>';
  return `<section class="ws-section">
    <h3 class="ws-h3">Ventures <span class="ws-n">${esc(momentum.total)}</span></h3>
    ${stats}
    ${rows}
  </section>`;
}

function timeHTML(time) {
  if (!time) return '';
  if (!time.total) {
    return `<section class="ws-section">
      <h3 class="ws-h3">Time, last ${esc((time && time.days) || 7)}d</h3>
      <p class="ws-empty">No time tracked this week.</p>
    </section>`;
  }
  const parts = [];
  if (time.topProject) {
    parts.push(`<div class="ws-time-row">
      <span class="ws-time-label">${esc(time.topProject.project)}</span>
      <span class="ws-time-val">${esc(fmtMinutes(time.topProject.minutes))} (${esc(time.topProject.percent)}%)</span>
    </div>`);
  }
  if (time.topAgent) {
    parts.push(`<div class="ws-time-row">
      <span class="ws-time-label">${esc(time.topAgent.agent)}</span>
      <span class="ws-time-val">${esc(fmtMinutes(time.topAgent.minutes))} (${esc(time.topAgent.percent)}%)</span>
    </div>`);
  }
  return `<section class="ws-section">
    <h3 class="ws-h3">Time, last ${esc(time.days)}d <span class="ws-n">${esc(fmtMinutes(time.total))}</span></h3>
    ${parts.join('')}
  </section>`;
}

function failedHTML(failed) {
  if (!failed || !failed.length) return '';
  const rows = failed.map((f) => `<li>${esc(f.source)}: ${esc(f.reason)}</li>`).join('');
  return `<section class="ws-failed">
    <p class="ws-failed-lede">Could not read everything — this is a failure to look,
      not a clean report:</p>
    <ul class="ws-failed-list">${rows}</ul>
  </section>`;
}

function render() {
  if (!root || !state) return;

  if (state.error) {
    root.innerHTML = `<section class="panel ws-panel">
      <h1>Weekly synthesis</h1>
      <p class="ws-alarm">Could not read the weekly synthesis — ${esc(state.error)}.
      That is a failure to look, not a quiet week.</p>
    </section>`;
    return;
  }

  if (!state.data) {
    root.innerHTML = `<section class="panel ws-panel"><h1>Weekly synthesis</h1>
      <p class="ws-loading">Reading the week…</p></section>`;
    return;
  }

  const { headline, momentum, time, failed } = state.data;

  root.innerHTML = `<section class="panel ws-panel">
    <h1>Weekly synthesis</h1>
    <p class="ws-lede">One view of what deserves attention this week, not four separate
      signals to check.</p>
    ${headlineHTML(headline)}
    ${momentumHTML(momentum)}
    ${timeHTML(time)}
    ${failedHTML(failed)}
  </section>`;
}

async function load() {
  try {
    const r = await fetch('/api/weekly-synthesis');
    if (!r.ok) throw new Error(`/api/weekly-synthesis answered ${r.status}`);
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
    state = { data: null, error: null };
    render();
    load();
    renderLede('weekly-synthesis', el);
  },
  unmount() { root = null; state = null; },
};

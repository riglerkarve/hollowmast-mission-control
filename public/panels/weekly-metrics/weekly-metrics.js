//
// weekly-metrics — a one-screen digest of the week: board activity, sessions,
// dashboard health, and traffic. Derived from data that already exists in the
// other panels and routes, not typed in.
//
// FOUR SECTIONS, FOUR FETCHES.
//   'Board activity'   — /api/board counts: open bugs, open requests, backlog, total open.
//   'Sessions'         — /api/sessions/ledger?days=7: total minutes, session count, active agents.
//   'Dashboard health' — /api/health-check: healthy, broken, total panels.
//   'Traffic'          — /api/analytics: top sites by visits.
//
// NOTHING HERE IS TYPED IN. Every number comes from a route that already exists.
// Absence (no data) and failure (could not read) must look different — the same
// principle as every other panel.
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

function statHTML(value, label, cls) {
  return `<div class="wm-stat${cls ? ' ' + cls : ''}">
    <span class="wm-stat-num">${esc(value)}</span>
    <span class="wm-stat-label">${esc(label)}</span>
  </div>`;
}

function statRowHTML(stats) {
  return `<div class="wm-stat-row">${stats.map(s => statHTML(s.value, s.label, s.cls)).join('')}</div>`;
}

function sectionHTML(heading, n, inner) {
  return `<h2 class="wm-h2">${esc(heading)}${n != null ? ` <span class="wm-n">${esc(n)}</span>` : ''}</h2>${inner}`;
}

function boardHTML(board) {
  if (!board || !board.counts) return '';
  const c = board.counts;
  const stats = [
    { value: c.externalOpen ?? 0, label: 'open bugs' },
    { value: c.backlogOpen ?? 0, label: 'open requests' },
    { value: (board.backlog || []).length, label: 'total backlog' },
    { value: (c.externalOpen ?? 0) + (c.backlogOpen ?? 0), label: 'total open items' },
  ];
  return sectionHTML('Board activity', null, statRowHTML(stats));
}

function sessionsHTML(ledger) {
  if (!ledger || !ledger.actorDays) return '';
  let totalMinutes = 0;
  let sessionCount = 0;
  const actors = new Set();
  for (const ad of ledger.actorDays) {
    if (ad.minutes) totalMinutes += Number(ad.minutes) || 0;
    if (ad.sessions) sessionCount += Number(ad.sessions) || 0;
    if (ad.actor) actors.add(ad.actor);
  }
  const stats = [
    { value: fmtMinutes(totalMinutes), label: 'total minutes' },
    { value: sessionCount, label: 'sessions' },
    { value: actors.size, label: 'active agents (7d)' },
  ];
  return sectionHTML('Sessions', null, statRowHTML(stats));
}

function healthHTML(health) {
  if (!health || !health.panels) return '';
  const panels = health.panels;
  let healthy = 0, broken = 0;
  for (const p of panels) {
    if (p.status === 'ok' || p.status === 'healthy' || p.status === 'pass') healthy++;
    else broken++;
  }
  const stats = [
    { value: healthy, label: 'healthy panels', cls: 'wm-ok' },
    { value: broken, label: 'broken panels', cls: broken > 0 ? 'wm-bad' : '' },
    { value: panels.length, label: 'total panels' },
  ];
  return sectionHTML('Dashboard health', null, statRowHTML(stats));
}

function trafficHTML(analytics) {
  if (!analytics || !analytics.traffic) return '';
  const traffic = analytics.traffic || [];
  if (!traffic.length) {
    return sectionHTML('Traffic', null, '<p class="wm-empty">No traffic data this period.</p>');
  }
  const top = traffic.slice(0, 8);
  const rows = top.map(t => {
    const label = t.path ? `${esc(t.site)}${esc(t.path)}` : esc(t.site || '');
    return `<div class="wm-trf-row">
      <span class="wm-trf-site">${esc(t.site || '')}${t.path ? `<span class="wm-trf-path">${esc(t.path)}</span>` : ''}</span>
      <span class="wm-trf-visits">${esc(t.visits ?? 0)}</span>
    </div>`;
  }).join('');
  return sectionHTML('Traffic', top.length, `<div class="wm-trf">${rows}</div>`);
}

function render() {
  if (!root || !state) return;

  if (state.error) {
    root.innerHTML = `<section class="panel wm-panel">
      <h1>Weekly metrics</h1>
      <p class="wm-alarm">Could not read metrics — ${esc(state.error)}.
      That is a failure to look, not an empty report.</p>
    </section>`;
    return;
  }

  if (!state.data) {
    root.innerHTML = `<section class="panel wm-panel"><h1>Weekly metrics</h1>
      <p class="wm-loading">Reading the week…</p></section>`;
    return;
  }

  const { board, ledger, health, analytics } = state.data;

  // Empty state: all four sources came back but none had meaningful data.
  const hasBoard = board && board.counts;
  const hasLedger = ledger && ledger.actorDays && ledger.actorDays.length > 0;
  const hasHealth = health && health.panels && health.panels.length > 0;
  const hasTraffic = analytics && analytics.traffic && analytics.traffic.length > 0;

  if (!hasBoard && !hasLedger && !hasHealth && !hasTraffic) {
    root.innerHTML = `<section class="panel wm-panel">
      <h1>Weekly metrics</h1>
      <p class="wm-empty">No metrics data available. These are derived from existing data, not typed in.</p>
    </section>`;
    return;
  }

  const sections = [
    hasBoard ? boardHTML(board) : '',
    hasLedger ? sessionsHTML(ledger) : '',
    hasHealth ? healthHTML(health) : '',
    hasTraffic ? trafficHTML(analytics) : '',
  ].filter(Boolean).join('');

  root.innerHTML = `<section class="panel wm-panel">
    <h1>Weekly metrics</h1>
    ${sections}
  </section>`;
}

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

async function load() {
  try {
    const [board, ledger, health, analytics] = await Promise.all([
      fetchJSON('/api/board').catch(e => null),
      fetchJSON('/api/sessions/ledger?days=7').catch(e => null),
      fetchJSON('/api/health-check').catch(e => null),
      fetchJSON('/api/analytics').catch(e => null),
    ]);
    state.data = { board, ledger, health, analytics };
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
    renderLede('weekly-metrics', el);
  },
  unmount() { root = null; state = null; },
};
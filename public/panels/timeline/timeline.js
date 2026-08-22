//
// timeline — when agents were active over the last 30 days, built from the session
// ledger (/api/sessions/ledger) and the live heartbeat (/api/sessions/active).
//
// THREE SECTIONS, TWO FETCHES.
//   'Active now' — sessions with a heartbeat in the last 90 seconds. If nothing is
//   running, the empty state says so plainly — absence and failure look different.
//   'Activity by day' — a horizontal bar chart, one row per day for 30 days. The bar
//   width is proportional to that day's minutes against the busiest day. Each bar is
//   stacked by actor in opacity tiers of --accent, so a day with two contributors reads
//   as two tones of the same colour, not two colours.
//   'By agent' — each actor's total minutes, sessions, and models, sorted by minutes
//   descending. Minutes are formatted as hours + minutes.
//
// NOTHING HERE DERIVES ANYTHING the route does not already compute. The day totals come
// from actorDays in the ledger; the per-agent rollup sums the actors array the route
// already grouped. A panel that recomputed "how many minutes" would agree with the route
// until one was edited, and then disagree without either erroring.
import { renderLede } from '/panels/lede/lede.js';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

let root = null;
let state = null;

// Actor opacity tiers: the busiest actor is near-full accent, the next dimmer, and so on.
// Re-mapped by index after sorting by total minutes, so the names do not matter — only
// the count. Four tiers cover any realistic number of concurrent agents.
const OPACITY_TIERS = [0.92, 0.62, 0.42, 0.30];

// Format minutes as "3h 12m", "47m", or "2h".
function fmtMin(m) {
  m = Math.round(m || 0);
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h === 0) return r + 'm';
  if (r === 0) return h + 'h';
  return h + 'h ' + r + 'm';
}

// Format a YYYY-MM-DD day as "Aug 1" without timezone shifting.
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function fmtDay(s) {
  const parts = String(s || '').split('-');
  if (parts.length < 3) return s || '';
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  return MONTHS[(m - 1) || 0] + ' ' + d;
}

// Build the last N calendar days as YYYY-MM-DD strings in local time.
function lastNDays(n) {
  const days = [];
  const today = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    days.push(y + '-' + m + '-' + dd);
  }
  return days;
}

// Map each actor to an opacity-tier index, sorted by total minutes descending.
function actorIndexMap(actors) {
  const totals = {};
  for (const a of actors || []) {
    totals[a.actor] = (totals[a.actor] || 0) + (a.minutes || 0);
  }
  return Object.fromEntries(
    Object.entries(totals)
      .sort((a, b) => b[1] - a[1])
      .map(([actor], i) => [actor, i])
  );
}

// ---- Section 1: Active now ------------------------------------------------------

function activeHTML(active) {
  if (!active || !active.length) {
    return '<p class="tl-empty">No active sessions right now.</p>';
  }
  return active.map(function (s) {
    const parts = [];
    parts.push('<span class="tl-act-who">' + esc(s.actor || 'unknown') + '</span>');
    if (s.model) parts.push('<span class="tl-act-model">' + esc(s.model) + '</span>');
    if (s.minutes != null) parts.push('<span class="tl-act-min">' + esc(fmtMin(s.minutes)) + '</span>');
    return '<div class="tl-act-card"><p class="tl-attr">' + parts.join('') + '</p></div>';
  }).join('');
}

// ---- Section 2: Activity by day -------------------------------------------------

function dayChartHTML(actorDays, actorIndex) {
  // Flatten actorDays into { day: { actor: minutes } }
  const byDay = {};
  for (const ad of actorDays || []) {
    if (!byDay[ad.day]) byDay[ad.day] = {};
    byDay[ad.day][ad.actor] = (byDay[ad.day][ad.actor] || 0) + (ad.minutes || 0);
  }

  const days = lastNDays(30);
  const dayTotals = {};
  let maxMin = 0;
  for (const d of days) {
    const ad = byDay[d] || {};
    const total = Object.values(ad).reduce(function (a, b) { return a + b; }, 0);
    dayTotals[d] = total;
    if (total > maxMin) maxMin = total;
  }

  return days.map(function (d) {
    const total = dayTotals[d];
    const ad = byDay[d] || {};
    // A sliver for non-zero days so a single-minute day is still visible.
    const widthPct = maxMin > 0 ? Math.max((total / maxMin) * 100, total > 0 ? 1.5 : 0) : 0;

    const segs = Object.entries(ad)
      .sort(function (a, b) { return b[1] - a[1]; })
      .map(function (entry) {
        const actor = entry[0];
        const min = entry[1];
        const idx = actorIndex[actor] != null ? actorIndex[actor] : 0;
        const opacity = OPACITY_TIERS[idx] != null ? OPACITY_TIERS[idx] : OPACITY_TIERS[OPACITY_TIERS.length - 1];
        const segWidth = total > 0 ? (min / total) * 100 : 0;
        return '<div class="tl-bar-seg" style="width:' + segWidth.toFixed(1) + '%;opacity:' + opacity +
          '" title="' + esc(actor) + ': ' + esc(fmtMin(min)) + '"></div>';
      }).join('');

    return '<div class="tl-day-row">' +
      '<span class="tl-day-label">' + esc(fmtDay(d)) + '</span>' +
      '<div class="tl-day-bar-wrap">' +
        '<div class="tl-day-bar" style="width:' + widthPct.toFixed(1) + '%">' + segs + '</div>' +
      '</div>' +
      '<span class="tl-day-min">' + (total > 0 ? esc(fmtMin(total)) : '') + '</span>' +
    '</div>';
  }).join('');
}

// ---- Section 3: By agent --------------------------------------------------------

function agentsHTML(actors, models) {
  // Aggregate actors: sum minutes and sessions across all model rows (including null).
  const byActor = {};
  for (const a of actors || []) {
    if (!byActor[a.actor]) {
      byActor[a.actor] = { actor: a.actor, minutes: 0, sessions: 0, models: [] };
    }
    byActor[a.actor].minutes += a.minutes || 0;
    byActor[a.actor].sessions += a.sessions || 0;
  }
  // Attach model breakdown from the models array (linked sessions only).
  for (const m of models || []) {
    if (byActor[m.actor] && m.model) {
      byActor[m.actor].models.push({ model: m.model, sessions: m.sessions, minutes: m.minutes });
    }
  }

  const sorted = Object.values(byActor).sort(function (a, b) { return b.minutes - a.minutes; });
  if (!sorted.length) {
    return '<p class="tl-empty">No agents recorded.</p>';
  }

  return sorted.map(function (a) {
    const modelHTML = a.models.length
      ? a.models.map(function (m) {
          return '<span class="tl-agent-model">' + esc(m.model) + '</span>' +
            '<span class="tl-agent-model-n">' + esc(m.sessions) + ' session' + (m.sessions === 1 ? '' : 's') +
            ', ' + esc(fmtMin(m.minutes)) + '</span>';
        }).join('')
      : '<span class="tl-agent-model-none">model not recorded</span>';

    return '<article class="tl-agent-card">' +
      '<div class="tl-agent-head">' +
        '<span class="tl-agent-name">' + esc(a.actor) + '</span>' +
        '<span class="tl-agent-total">' + esc(fmtMin(a.minutes)) + '</span>' +
      '</div>' +
      '<p class="tl-agent-sessions">' + esc(a.sessions) + ' session' + (a.sessions === 1 ? '' : 's') + '</p>' +
      '<div class="tl-agent-models">' + modelHTML + '</div>' +
    '</article>';
  }).join('');
}

// ---- Render ---------------------------------------------------------------------

function render() {
  if (!root || !state) return;

  // Panel-level error: the ledger fetch failed.
  if (state.error) {
    root.innerHTML = '<section class="panel tl-panel">' +
      '<h1>Session timeline</h1>' +
      '<p class="tl-alarm">Could not read session data — ' + esc(state.error) + '. ' +
      'That is a failure to look, not an empty ledger.</p>' +
    '</section>';
    return;
  }

  // Loading: the ledger has not arrived yet.
  if (!state.ledger) {
    root.innerHTML = '<section class="panel tl-panel"><h1>Session timeline</h1>' +
      '<p class="tl-loading">Reading the ledger\u2026</p></section>';
    return;
  }

  const ledger = state.ledger;
  const hasData = (ledger.actorDays && ledger.actorDays.length) ||
                   (ledger.actors && ledger.actors.length);

  // Panel-level empty: the ledger loaded but holds nothing.
  if (!hasData) {
    root.innerHTML = '<section class="panel tl-panel">' +
      '<h1>Session timeline</h1>' +
      '<p class="tl-empty">No sessions recorded in the last 30 days. ' +
      'That is a real count, not a failed read.</p>' +
    '</section>';
    return;
  }

  // Full render.
  const actorIndex = actorIndexMap(ledger.actors);
  const active = (state.active && state.active.active) || [];
  const chartHTML = dayChartHTML(ledger.actorDays, actorIndex);
  const agents = agentsHTML(ledger.actors, ledger.models);

  // Active section: its own error if the active endpoint failed, otherwise render.
  let activeSection;
  if (state.activeError) {
    activeSection = '<p class="tl-empty">Could not read active sessions — ' + esc(state.activeError) + '.</p>';
  } else {
    activeSection = activeHTML(active);
  }

  root.innerHTML = '<section class="panel tl-panel">' +
    '<h1>Session timeline</h1>' +
    '<p class="tl-lede">When agents were active over the last 30 days \u2014 minutes per day, ' +
      'who was running, and which models they used.</p>' +

    '<h2 class="tl-h2">Active now <span class="tl-n">' + active.length + '</span></h2>' +
    activeSection +

    '<h2 class="tl-h2">Activity by day <span class="tl-n">30 days</span></h2>' +
    '<div class="tl-chart">' + chartHTML + '</div>' +

    '<h2 class="tl-h2">By agent <span class="tl-n">' + Object.keys(actorIndex).length + '</span></h2>' +
    agents +
  '</section>';
}

// ---- Load -----------------------------------------------------------------------

async function load() {
  // The ledger is the primary fetch — its failure is a panel-level error.
  try {
    const res = await fetch('/api/sessions/ledger?days=30');
    if (!res.ok) throw new Error('ledger ' + res.status);
    state.ledger = await res.json();
    state.error = null;
  } catch (e) {
    state.error = e.message;
    render();
    return;
  }

  // The active endpoint is secondary — its failure does not break the panel.
  try {
    const res = await fetch('/api/sessions/active');
    if (!res.ok) throw new Error('active ' + res.status);
    state.active = await res.json();
  } catch (e) {
    state.activeError = e.message;
  }

  render();
}

// ---- Export ---------------------------------------------------------------------

export default {
  mount(el, opts) {
    root = el;
    state = { ledger: null, active: null, error: null, activeError: null };
    render();
    load();
    renderLede('timeline', el);
  },
  unmount() { root = null; state = null; },
};
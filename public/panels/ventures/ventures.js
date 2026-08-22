//
// ventures — cross-venture view: momentum and staleness, not just a list.
//
// GET /api/ventures returns { ventures: [{ name, track, status, momentum,
//   daysSinceActivity, openItems, staleItems, note, lastActivity }] }.
//
// Each venture renders as a row with:
//   - name
//   - status badge (the project's state: active / dormant / parked — whatever the
//     route sends, shown verbatim so a value the panel does not know about still
//     appears rather than being silently dropped)
//   - days since activity
//   - open items count
//   - momentum indicator (active / slowing / stalled / parked / unknown)
//
// NOTHING HERE DERIVES ANYTHING. Momentum and daysSinceActivity come from the
// route, which uses git log + handovers + sessions. A panel that recomputed
// "is this stalled" would agree with the route until one was edited, and then
// disagree without either erroring — the exact failure this project keeps meeting.
import { renderLede } from '/panels/lede/lede.js';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

let root = null;
let state = null;

// The status badge: shown verbatim from the route's `status` field. The milestone
// brief names active / dormant / parked, but the route sends the project's actual
// state; whatever it is, it appears, so an unknown value is visible rather than
// silently swallowed.
function statusBadgeHTML(v) {
  const s = v.status || 'unknown';
  return `<span class="vn-status" data-status="${esc(s)}">${esc(s)}</span>`;
}

// The momentum indicator: a dot + label, coloured by momentum class so the eye
// reads the health of the portfolio at a glance without parsing text.
function momentumHTML(v) {
  const m = v.momentum || 'unknown';
  return `<span class="vn-mom" data-momentum="${esc(m)}"><span class="vn-mom-dot"></span>${esc(m)}</span>`;
}

// Days since activity: null means no recorded activity — shown as "—" rather than
// a misleading "0 days", because 0 days is a number and no-activity is not.
function daysHTML(v) {
  if (v.daysSinceActivity == null) return '<span class="vn-days vn-days-na">—</span>';
  const d = v.daysSinceActivity;
  const cls = d <= 3 ? 'vn-days-fresh' : d <= 7 ? 'vn-days-fade' : 'vn-days-stale';
  return `<span class="vn-days ${cls}">${d}d</span>`;
}

// Open items count: the number of board items still open for this venture, with
// stale items called out separately so a count that looks healthy but is rotting
// does not read as healthy.
function openItemsHTML(v) {
  const open = v.openItems || 0;
  const stale = v.staleItems || 0;
  if (!open) return '<span class="vn-open vn-open-zero">0</span>';
  const staleTag = stale ? `<span class="vn-open-stale">${stale} stale</span>` : '';
  return `<span class="vn-open">${open}</span>${staleTag}`;
}

function rowHTML(v) {
  const note = v.note ? `<p class="vn-note">${esc(v.note)}</p>` : '';
  return `<article class="vn-row">
    <div class="vn-main">
      <h3 class="vn-name">${esc(v.name)}</h3>
      <span class="vn-track">${esc(v.track)}</span>
    </div>
    <div class="vn-stats">
      ${statusBadgeHTML(v)}
      ${momentumHTML(v)}
      ${daysHTML(v)}
      ${openItemsHTML(v)}
    </div>
    ${note}
  </article>`;
}

function render() {
  if (!root || !state) return;

  if (state.error) {
    root.innerHTML = `<section class="panel vn-panel">
      <h1>Ventures</h1>
      <p class="vn-alarm">Could not read the ventures list — ${esc(state.error)}.
      That is a failure to look, not an empty portfolio.</p>
    </section>`;
    return;
  }

  if (!state.data) {
    root.innerHTML = `<section class="panel vn-panel"><h1>Ventures</h1>
      <p class="vn-loading">Reading the portfolio…</p></section>`;
    return;
  }

  const { ventures } = state.data;
  const listHTML = ventures.length
    ? ventures.map(rowHTML).join('')
    : '<p class="vn-empty">No ventures registered. A venture that is not on the board is a wish, not a bet.</p>';

  root.innerHTML = `<section class="panel vn-panel">
    <h1>Ventures</h1>
    <p class="vn-lede">Every venture, sorted by momentum — active first, stalled and parked last.
      Days since activity, open items, and whether any of them are going stale.</p>

    <h2 class="vn-h2">Portfolio <span class="vn-n">${ventures.length}</span></h2>
    <div class="vn-list">${listHTML}</div>
  </section>`;
}

async function load() {
  try {
    state.data = await (await fetch('/api/ventures')).json();
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
    renderLede('ventures', el);
  },
  unmount() { root = null; state = null; },
};
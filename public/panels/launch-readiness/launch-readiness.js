//
// launch-readiness — HOLLOWMAST Phase 5 launch-readiness view.
//
// ONE CHECKLIST, ONE FETCH.
//   A big status indicator at top — READY (accent) or NOT READY (muted) —
//   followed by every launch readiness check with pass / fail / pending
//   status, a name, an icon, and a detail line. Checks are sorted failed
//   first, then pending, then passed, so what blocks launch is on top.
//
// NOTHING HERE DERIVES ANYTHING. The checks come from the route, which reads
// disk, git, the network, and the board at request time. A panel that
// recomputed a check would agree with the route until one was edited, and
// then disagree without either erroring — the exact failure this project
// keeps meeting.
import { renderLede } from '/panels/lede/lede.js';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

let root = null;
let state = null;

// Status icon — green check for pass, red x for fail, gray dash for pending.
// Each is a text glyph in a span so it carries the status colour, not an image.
function iconFor(status) {
  if (status === 'pass') return '<span class="lr-icon lr-pass" aria-label="pass">&#x2713;</span>';
  if (status === 'fail') return '<span class="lr-icon lr-fail" aria-label="fail">&#x2717;</span>';
  return '<span class="lr-icon lr-pending" aria-label="pending">&mdash;</span>';
}

// Sort order: failed first, then pending, then passed. Within the same status
// the original order is preserved (stable sort).
const ORDER = { fail: 0, pending: 1, pass: 2 };
function sortChecks(checks) {
  return checks.slice().sort((a, b) => (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9));
}

function checkRow(c) {
  return `<div class="lr-row lr-${esc(c.status)}">
    ${iconFor(c.status)}
    <div class="lr-body">
      <h3 class="lr-name">${esc(c.name)}</h3>
      <p class="lr-detail">${esc(c.detail)}</p>
    </div>
  </div>`;
}

function render() {
  if (!root || !state) return;

  if (state.error) {
    root.innerHTML = `<section class="panel lr-panel">
      <h1>Launch readiness</h1>
      <p class="lr-alarm">Could not read launch readiness — ${esc(state.error)}.
      That is a failure to look, not an empty checklist.</p>
    </section>`;
    return;
  }

  if (!state.data) {
    root.innerHTML = `<section class="panel lr-panel"><h1>Launch readiness</h1>
      <p class="lr-loading">Reading launch readiness…</p></section>`;
    return;
  }

  const d = state.data;
  const checks = sortChecks(d.checks || []);
  const ready = !!d.ready;

  // Big status indicator at top.
  const statusLabel = ready ? 'READY' : 'NOT READY';
  const statusClass = ready ? 'lr-status-ready' : 'lr-status-notready';
  const statusNote = ready
    ? 'Every check passed — HOLLOWMAST is clear for launch.'
    : (d.passedChecks || 0) + ' of ' + (d.totalChecks || 0) + ' checks passed. What blocks launch is on top.';

  const listHTML = checks.length
    ? checks.map(checkRow).join('')
    : '<p class="lr-empty">No checks returned. An empty checklist is not a green one — it means the route did not look.</p>';

  root.innerHTML = `<section class="panel lr-panel">
    <h1>Launch readiness</h1>
    <p class="lr-lede">HOLLOWMAST Phase 5 — a single checklist that says go or no-go, with the
      reason beside each item. The big indicator is the answer; the list is the evidence.</p>

    <div class="lr-banner ${statusClass}">
      <span class="lr-banner-label">${statusLabel}</span>
      <span class="lr-banner-note">${esc(statusNote)}</span>
    </div>

    <h2 class="lr-h2">Checklist <span class="lr-n">${checks.length}</span></h2>
    ${listHTML}
  </section>`;
}

async function load() {
  try {
    state.data = await (await fetch('/api/launch-readiness')).json();
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
    renderLede('launch-readiness', el);
  },
  unmount() { root = null; state = null; },
};
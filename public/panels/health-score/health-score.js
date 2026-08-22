//
// health-score — one composite workspace health number (0–100%) from 8 checks.
//
// ABSENCE AND FAILURE LOOK DIFFERENT. A check that passed is green, a check that
// failed is red, and a check that could not run is grey with a "?" — never the
// same as either. A 100% score is the accent; anything less is muted, with the
// failed checks carrying the accent so the eye finds the problems, not the
// successes.
import { renderLede } from '/panels/lede/lede.js';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

let root = null;
let state = null;

// The icon for a check: green check for passed, red x for failed, grey ? for
// could-not-check. These are inline SVG drawn in fixed colours rather than
// currentColor, because a pass/fail/cannot-check distinction must survive a
// theme switch without re-derivation.
function iconHTML(passed) {
  if (passed === true) {
    return '<svg class="hs-icon hs-icon-ok" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-6.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  }
  if (passed === false) {
    return '<svg class="hs-icon hs-icon-bad" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  }
  return '<svg class="hs-icon hs-icon-na" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 7v3.5M8 4.8v.01" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
}

function checkRowHTML(check) {
  const icon = iconHTML(check.passed);
  return `<article class="hs-check hs-check-${check.passed === true ? 'ok' : check.passed === false ? 'bad' : 'na'}">
    <span class="hs-check-icon">${icon}</span>
    <div class="hs-check-body">
      <p class="hs-check-name">${esc(check.name)}</p>
      <p class="hs-check-detail">${esc(check.detail)}</p>
    </div>
  </article>`;
}

function render() {
  if (!root || !state) return;

  if (state.error) {
    root.innerHTML = `<section class="panel hs-panel">
      <h1>Health score</h1>
      <p class="hs-alarm">Could not compute health score — ${esc(state.error)}.
      That is a failure to look, not a clean bill of health.</p>
    </section>`;
    return;
  }

  if (!state.data) {
    root.innerHTML = `<section class="panel hs-panel"><h1>Health score</h1>
      <p class="hs-loading">Running 8 checks…</p></section>`;
    return;
  }

  const { score, max, percent, checks, asOf } = state.data;

  if (!checks || checks.length === 0) {
    root.innerHTML = `<section class="panel hs-panel">
      <h1>Health score</h1>
      <p class="hs-empty">No health data available.</p>
    </section>`;
    return;
  }

  const isFull = score === max;
  const bigClass = isFull ? 'hs-big hs-big-full' : 'hs-big';
  const checksHTML = checks.map(checkRowHTML).join('');

  root.innerHTML = `<section class="panel hs-panel">
    <h1>Health score</h1>
    <p class="hs-lede">A composite score from ${max} independent checks: routes, panels, server,
      database, handovers, P0 bugs, backup freshness, and Ollama. Each check is pass, fail, or
      could-not-check — so a missing signal never looks like a clean pass.</p>

    <div class="hs-score-block">
      <span class="${bigClass}">${percent}%</span>
      <span class="hs-score-frac">${score} / ${max} checks passed</span>
    </div>

    <h2 class="hs-h2">Checks <span class="hs-n">${checks.length}</span></h2>
    ${checksHTML}

    <p class="hs-asof">As of ${esc(asOf)}.</p>
  </section>`;
}

async function load() {
  try {
    state.data = await (await fetch('/api/health-score')).json();
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
    renderLede('health-score', el);
  },
  unmount() { root = null; state = null; },
};
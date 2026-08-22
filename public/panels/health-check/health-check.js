//
// health-check — verifies every panel's JS, CSS, and API endpoint are present
// and wired. The dashboard's own self-diagnostic: if a panel's files are
// missing or its API is down, this is where it surfaces — not as a silent
// 404 in the console.
//
// TWO SECTIONS, ONE FETCH.
//   'Healthy' — panels where every component is ok or n/a. Compact: names
//   only, because a healthy panel needs no explanation.
//   'Broken' — panels with at least one missing or down component. Full
//   detail: which component failed and the reported status, so the owner
//   knows what to fix without opening the devtools.
//
// ABSENCE AND FAILURE LOOK DIFFERENT. An empty panels list means nothing is
// registered yet; a fetch error means the check itself could not run. The
// latter is a failure to look, not a clean bill of health.
import { renderLede } from '/panels/lede/lede.js';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

let root = null;
let state = null;

// A component is 'failed' if it is neither ok nor n/a. n/a is a legitimate
// "this panel has no API endpoint" state, not a failure.
function isFailed(v) { return v !== 'ok' && v !== 'n/a'; }

function componentLabel(k) {
  if (k === 'js') return 'JS';
  if (k === 'css') return 'CSS';
  if (k === 'api') return 'API';
  return k;
}

function failedComponents(p) {
  const parts = [];
  if (isFailed(p.js)) parts.push({ label: 'JS', value: p.js });
  if (isFailed(p.css)) parts.push({ label: 'CSS', value: p.css });
  if (isFailed(p.api)) parts.push({ label: 'API', value: p.api });
  return parts;
}

function brokenCardHTML(p) {
  const comps = failedComponents(p);
  const compHTML = comps.map(c =>
    `<div class="hc-comp"><span class="hc-comp-label">${c.label}</span><span class="hc-comp-val hc-comp-fail">${esc(c.value)}</span></div>`
  ).join('');
  return `<article class="hc-card hc-card-broken">
    <h3 class="hc-name">${esc(p.name)}</h3>
    <div class="hc-comps">${compHTML}</div>
  </article>`;
}

function render() {
  if (!root || !state) return;

  if (state.error) {
    root.innerHTML = `<section class="panel hc-panel">
      <h1>Health check</h1>
      <p class="hc-alarm">Could not run health check — ${esc(state.error)}.
      That is a failure to look, not a clean bill of health.</p>
    </section>`;
    return;
  }

  if (!state.data) {
    root.innerHTML = `<section class="panel hc-panel"><h1>Health check</h1>
      <p class="hc-loading">Running health check…</p></section>`;
    return;
  }

  const panels = state.data.panels || [];
  const healthy = panels.filter(p => p.status === 'healthy');
  const broken = panels.filter(p => p.status === 'broken');

  if (panels.length === 0) {
    root.innerHTML = `<section class="panel hc-panel">
      <h1>Health check</h1>
      <p class="hc-lede">This panel checks every registered panel's JavaScript, stylesheet,
        and API endpoint — if a panel's files are missing or its API is down, that shows
        up here, not as a silent 404.</p>
      <p class="hc-empty">No panels registered yet.</p>
    </section>`;
    return;
  }

  const healthyHTML = healthy.length
    ? `<p class="hc-healthy-list">${healthy.map(p => `<span class="hc-healthy-name">${esc(p.name)}</span>`).join('')}</p>`
    : '<p class="hc-empty">None healthy.</p>';

  const brokenHTML = broken.length
    ? broken.map(brokenCardHTML).join('')
    : '<p class="hc-empty">No broken panels.</p>';

  root.innerHTML = `<section class="panel hc-panel">
    <h1>Health check</h1>
    <p class="hc-lede">This panel checks every registered panel's JavaScript, stylesheet,
      and API endpoint — if a panel's files are missing or its API is down, that shows
      up here, not as a silent 404.</p>

    <p class="hc-summary"><span class="hc-summary-ok">${healthy.length} of ${panels.length}</span>
      panels healthy, <span class="hc-summary-bad">${broken.length} broken</span>.</p>

    <h2 class="hc-h2">Healthy <span class="hc-n hc-n-ok">${healthy.length}</span></h2>
    ${healthyHTML}

    <h2 class="hc-h2">Broken <span class="hc-n hc-n-bad">${broken.length}</span></h2>
    ${brokenHTML}
  </section>`;
}

async function load() {
  try {
    state.data = await (await fetch('/api/health-check')).json();
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
    renderLede('health-check', el);
  },
  unmount() { root = null; state = null; },
};
//
// browsing-recall — where you spent time this week, in case the tab is still
// open. Reads the browsing_domain_days table (via the route) for the last 7
// days and shows the top 20 domains by visit count.
//
// NOTHING HERE DERIVES ANYTHING. The domain list, totals, and window come from
// the route. A panel that recomputed "how many visits" would agree with the
// route until one was edited, and then disagree without either erroring.
import { renderLede } from '/panels/lede/lede.js';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const day = (s) => String(s || '').slice(0, 10);

let root = null;
let state = null;

function cardHTML(d) {
  return `<article class="br-card">
    <div class="br-card-head">
      <h3 class="br-domain">${esc(d.domain)}</h3>
      <span class="br-visits">${esc(d.visits)}</span>
    </div>
    <p class="br-last">Last visited ${esc(day(d.lastVisit))}</p>
  </article>`;
}

function render() {
  if (!root || !state) return;

  if (state.error) {
    root.innerHTML = `<section class="panel br-panel">
      <h1>Browsing recall</h1>
      <p class="br-alarm">Could not read browsing data — ${esc(state.error)}.
      That is a failure to look, not an empty week.</p>
    </section>`;
    return;
  }

  if (!state.data) {
    root.innerHTML = `<section class="panel br-panel"><h1>Browsing recall</h1>
      <p class="br-loading">Reading the log…</p></section>`;
    return;
  }

  const d = state.data;

  if (d.state && (!d.domains || !d.domains.length)) {
    root.innerHTML = `<section class="panel br-panel">
      <h1>Browsing recall</h1>
      <p class="br-lede">Where you spent time this week, in case the tab is still open.</p>
      <p class="br-empty">${esc(d.state)}</p>
    </section>`;
    return;
  }

  const domains = d.domains || [];
  const listHTML = domains.length
    ? domains.map(cardHTML).join('')
    : '<p class="br-empty">No browsing data in the last 7 days. This is a real count, not a failed read.</p>';

  root.innerHTML = `<section class="panel br-panel">
    <h1>Browsing recall</h1>
    <p class="br-lede">Where you spent time this week, in case the tab is still open.</p>

    <div class="br-summary">
      <span class="br-stat"><span class="br-stat-n">${esc(d.totalVisits)}</span> visits</span>
      <span class="br-stat"><span class="br-stat-n">${esc(d.totalDomains)}</span> domains</span>
      <span class="br-stat"><span class="br-stat-n">${esc(d.days)}</span> days</span>
    </div>

    <div class="br-list">
      ${listHTML}
    </div>
  </section>`;
}

async function load() {
  try {
    state.data = await (await fetch('/api/browsing-recall')).json();
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
    renderLede('browsing-recall', el);
  },
  unmount() { root = null; state = null; },
};
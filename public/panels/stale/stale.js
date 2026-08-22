//
// stale — items that have not been touched in N days.
//
// ONE FETCH, ONE THRESHOLD. The route returns whatever has been sitting still past the
// given threshold. This panel does not compute "is this stale" itself — a panel that
// recomputed staleness from a checkedAt date would agree with the route until one was
// edited, and then disagree without either erroring. The count is the route's count.
//
// The days selector (7/14/30) re-fetches from the route with a different threshold. It
// does not filter the list client-side, because filtering a list you already have hides
// the fact that the threshold changed what the route considered worth returning.
import { renderLede } from '/panels/lede/lede.js';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const DAYS_OPTIONS = [7, 14, 30];

let root = null;
let state = null;

function kindLabel(k) {
  const map = { bug: 'bug', feature: 'feature', backlog: 'backlog' };
  return map[k] || (k ? String(k) : 'item');
}

function itemHTML(item) {
  const ref = item.ref ? `<span class="st-ref">${esc(item.ref)}</span>` : '';
  const kind = item.kind ? `<span class="st-kind st-kind-${esc(item.kind)}">${esc(kindLabel(item.kind))}</span>` : '';
  const days = `<span class="st-days">${esc(item.daysStale)}d stale</span>`;
  const title = item.title ? `<p class="st-title">${esc(item.title)}</p>` : '<p class="st-title st-title-empty">—</p>';
  return `<article class="st-card">
    <p class="st-head">${ref}${kind}${days}</p>
    ${title}
  </article>`;
}

function projectHTML(project, items) {
  const sorted = items.slice().sort((a, b) => b.daysStale - a.daysStale);
  return `<section class="st-group">
    <h2 class="st-h2">${esc(project)} <span class="st-n">${items.length}</span></h2>
    ${sorted.map(itemHTML).join('')}
  </section>`;
}

function render() {
  if (!root || !state) return;

  if (state.error) {
    root.innerHTML = `<section class="panel st-panel">
      <h1>Stale items</h1>
      <p class="st-alarm">Could not read stale items — ${esc(state.error)}.
      That is a failure to look, not an empty list.</p>
    </section>`;
    return;
  }

  if (!state.data) {
    root.innerHTML = `<section class="panel st-panel"><h1>Stale items</h1>
      <p class="st-loading">Checking what has been sitting still…</p></section>`;
    return;
  }

  const { items, checkedAt } = state.data;
  const days = state.days;

  const buttons = DAYS_OPTIONS.map((d) => {
    const active = d === days ? ' st-days-btn-active' : '';
    return `<button class="st-days-btn${active}" data-days="${d}">${d} days</button>`;
  }).join('');

  if (!items || items.length === 0) {
    root.innerHTML = `<section class="panel st-panel">
      <h1>Stale items</h1>
      <p class="st-lede">Items that have not been touched in ${days} days or more.</p>
      <div class="st-days-bar">${buttons}</div>
      <p class="st-empty">Nothing has been sitting still. That is a real count, not a failed read.</p>
      <p class="st-asof">As of ${esc(checkedAt || '')}.</p>
    </section>`;
    return;
  }

  // Group by project
  const groups = {};
  for (const item of items) {
    const key = item.project || '—';
    if (!groups[key]) groups[key] = [];
    groups[key].push(item);
  }

  // Sort projects by total stale count descending, then name
  const projectNames = Object.keys(groups).sort((a, b) => {
    if (groups[b].length !== groups[a].length) return groups[b].length - groups[a].length;
    return a < b ? -1 : 1;
  });

  const groupHTML = projectNames.map((p) => projectHTML(p, groups[p])).join('');

  root.innerHTML = `<section class="panel st-panel">
    <h1>Stale items</h1>
    <p class="st-lede">Items that have not been touched in ${days} days or more. The ones at the
      top of each group have been still the longest.</p>
    <div class="st-days-bar">${buttons}</div>
    <h2 class="st-h2 st-h2-total">Total <span class="st-n">${items.length}</span></h2>
    ${groupHTML}
    <p class="st-asof">As of ${esc(checkedAt || '')}.</p>
  </section>`;

  // Wire up the days buttons
  const btns = root.querySelectorAll('.st-days-btn');
  for (const btn of btns) {
    btn.addEventListener('click', onDaysClick);
  }
}

function onDaysClick(e) {
  const d = parseInt(e.currentTarget.dataset.days, 10);
  if (!d || d === state.days) return;
  state.days = d;
  state.data = null;
  state.error = null;
  render();
  load();
}

async function load() {
  try {
    state.data = await (await fetch(`/api/stale?days=${state.days}`)).json();
    state.error = null;
  } catch (e) {
    state.error = e.message;
  }
  render();
}

export default {
  mount(el, opts) {
    root = el;
    state = { data: null, error: null, days: (opts && opts.days) || 7 };
    render();
    load();
    renderLede('stale', el);
  },
  unmount() { root = null; state = null; },
};
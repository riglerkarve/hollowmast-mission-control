//
// goal-staleness — flags goals whose steps have not moved in 30+ days.
//
// Every multi-step goal is the same shape: a thing you genuinely want, five or
// six steps of paperwork between you and it, and no obvious place to start.
// The reason they sit in the backlog for months is not that they are hard. It
// is that "renew passport" is not an action — it is a name for four actions,
// and you have to reconstruct which one is next every single time you look at
// it.
//
// This panel answers one question: WHICH OF YOUR GOALS HAVE STALLED? It does
// not derive anything the route does not already send. The staleness flag comes
// from the route, which computes days-since-update from the most recent step
// movement. A panel that recomputed "is this stale" would agree with the route
// until one was edited, and then disagree without either erroring — the exact
// failure this project keeps meeting.
import { renderLede } from '/panels/lede/lede.js';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

let root = null;
let state = null;

// The staleness badge. Three kinds of fact, read at different weights:
//   stale  — 30+ days since any step moved. Accent highlight, because this is
//            the section the owner must not miss.
//   slowing — 7+ days. Muted, because it is a warning, not an alarm.
//   active  — < 7 days. Green-ish, because movement is the good state.
function badgeHTML(g) {
  if (g.status === 'stale') {
    return '<span class="gs-badge gs-badge-stale">stale</span>';
  }
  if (g.status === 'slowing') {
    return '<span class="gs-badge gs-badge-slowing">slowing</span>';
  }
  return '<span class="gs-badge gs-badge-active">active</span>';
}

// The days-since-update figure, shown as a number with a label. A goal that
// has never moved reads "never moved" rather than a day count, because
// daysSinceUpdate is computed from created_at in that case and the number
// would be misleading without the context.
function daysLabel(g) {
  if (g.daysSinceUpdate == null) return '<span class="gs-days gs-days-null">—</span>';
  const d = g.daysSinceUpdate;
  const word = d === 1 ? 'day' : 'days';
  return `<span class="gs-days">${d} ${word}</span>`;
}

// Step progress as "done / total", with a slim bar. The bar is decorative —
// the numbers are the fact, because a bar without numbers is a feeling.
function progressHTML(g) {
  const pct = g.totalSteps > 0 ? Math.round((g.doneSteps / g.totalSteps) * 100) : 0;
  return `<div class="gs-progress">
    <span class="gs-count">${g.doneSteps}/${g.totalSteps}</span>
    <span class="gs-bar"><span class="gs-bar-fill" style="width:${pct}%"></span></span>
  </div>`;
}

// One goal card. The status class on the article drives the left-rule colour,
// the same way decisions.js uses dc-due for its accent highlight.
function cardHTML(g) {
  const cls = g.status === 'stale' ? ' gs-stale'
    : g.status === 'slowing' ? ' gs-slowing'
    : ' gs-active';
  return `<article class="gs-card${cls}">
    ${badgeHTML(g)}
    <h3 class="gs-title">${esc(g.title)}</h3>
    ${progressHTML(g)}
    <p class="gs-meta">${daysLabel(g)} since last movement</p>
  </article>`;
}

function render() {
  if (!root || !state) return;

  if (state.error) {
    root.innerHTML = `<section class="panel gs-panel">
      <h1>Goal staleness</h1>
      <p class="gs-alarm">Could not read the goals — ${esc(state.error)}.
      That is a failure to look, not an empty goal list.</p>
    </section>`;
    return;
  }

  if (!state.data) {
    root.innerHTML = `<section class="panel gs-panel"><h1>Goal staleness</h1>
      <p class="gs-loading">Reading the goals…</p></section>`;
    return;
  }

  const { goals, staleCount, slowingCount, activeCount, asOf, state: ds } = state.data;

  if (ds === 'empty' || !goals.length) {
    root.innerHTML = `<section class="panel gs-panel">
      <h1>Goal staleness</h1>
      <p class="gs-lede">Every multi-step goal, with the days since any step last moved.
        Stale (30+ days) is highlighted; slowing (7+) is muted; active is green.</p>
      <p class="gs-empty">No goals recorded yet. A goal without steps is a wish — add one
        and give it steps, and this panel will watch it for stalls.</p>
    </section>`;
    return;
  }

  const cards = goals.map(cardHTML).join('');

  root.innerHTML = `<section class="panel gs-panel">
    <h1>Goal staleness</h1>
    <p class="gs-lede">Every multi-step goal, with the days since any step last moved.
      Stale (30+ days) is highlighted; slowing (7+) is muted; active is green.
      Sorted most stale first, so the goals that have stalled longest are at the top.</p>

    <p class="gs-summary">
      <span class="gs-sum gs-sum-stale">${staleCount} stale</span>
      <span class="gs-sum gs-sum-slowing">${slowingCount} slowing</span>
      <span class="gs-sum gs-sum-active">${activeCount} active</span>
    </p>
    <p class="gs-asof">As of ${esc(asOf)}.</p>

    <div class="gs-list">
      ${cards}
    </div>
  </section>`;
}

async function load() {
  try {
    state.data = await (await fetch('/api/goal-staleness')).json();
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
    renderLede('goal-staleness', el);
  },
  unmount() { root = null; state = null; },
};

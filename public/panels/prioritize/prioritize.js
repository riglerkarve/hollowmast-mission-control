//
// prioritize — "what should I do today?" (M254)
//
// GET /api/prioritize returns { items: [{ ref, title, project, priority, kind,
//   owner, score, reason, daysStale }], totalOpen, generatedAt } — a ranked
// list of every open board item, scored by a named, fixed heuristic so the
// ordering is arithmetic the owner can re-derive by hand. This panel does not
// re-score, re-sort, or second-guess the route: it shows what the route sent,
// in the order the route sent it, and lets the score and reason explain themselves.
//
// The top three items are highlighted so the first thing the eye lands on is
// the work that most needs doing right now. Everything below is still ranked —
// the owner can read down the list when the top three are done or wrong.
import { renderLede } from '/panels/lede/lede.js';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Reason prose is escaped, not parsed. The route joins reasons with ' · '; we
// keep that separator verbatim rather than re-splitting, because the route is
// the authority on how the score was built.
const prose = (s) => esc(s).replace(/\n{2,}/g, '</p><p>').replace(/\n/g, '<br>');

let root = null;
let state = null;

// Priority badge. The route normalises priority to P1/P2/P3 before sending, so
// any other value falls through to a neutral badge rather than being silently
// dropped — an unknown priority is still a priority the owner should see.
function priBadgeHTML(pri) {
  const p = String(pri || '').toUpperCase();
  // A raw "P1"/"P2"/"P3" is a label the owner has to decode every time. The class name
  // keeps the raw code for styling; the text the owner reads is the plain word.
  if (p === 'P1') return '<span class="pz-badge pz-p1">Urgent</span>';
  if (p === 'P2') return '<span class="pz-badge pz-p2">Normal</span>';
  if (p === 'P3') return '<span class="pz-badge pz-p3">Minor</span>';
  return p ? `<span class="pz-badge pz-pother">${esc(p)}</span>` : '';
}

// Kind tag — bug, question, etc. Optional, only shown when the route sent one.
function kindHTML(kind) {
  const k = String(kind || '');
  if (!k) return '';
  return `<span class="pz-kind">${esc(k)}</span>`;
}

function attrHTML(item) {
  const ref = item.ref ? `<span class="pz-ref">${esc(item.ref)}</span>` : '';
  const proj = item.project ? `<span class="pz-proj">${esc(item.project)}</span>` : '';
  const owner = item.owner ? `<span class="pz-owner">${esc(item.owner)}</span>` : '';
  const stale = item.daysStale > 0
    ? `<span class="pz-stale">${esc(item.daysStale)}d stale</span>` : '';
  return `<p class="pz-attr">${ref}${proj}${owner}${stale}</p>`;
}

function rowHTML(item, index) {
  // Top three items carry the accent left rule and a soft tint, the same
  // emphasis decisions.css gives a due-for-revisit call: the work that most
  // needs doing is the work that must not be scrolled past.
  const top = index < 3 ? ' pz-top' : '';
  const score = String(item.score == null ? '—' : item.score);
  return `<article class="pz-row${top}">
    <div class="pz-score"><span class="pz-score-n">${esc(score)}</span></div>
    <div class="pz-body">
      <div class="pz-head">
        ${priBadgeHTML(item.priority)}
        ${kindHTML(item.kind)}
        <h3 class="pz-title">${prose(item.title)}</h3>
      </div>
      ${attrHTML(item)}
      ${item.reason ? `<p class="pz-reason">${prose(item.reason)}</p>` : ''}
    </div>
  </article>`;
}

function render() {
  if (!root || !state) return;

  if (state.error) {
    root.innerHTML = `<section class="panel pz-panel">
      <h1>Prioritize</h1>
      <p class="pz-alarm">Could not read the priority list — ${esc(state.error)}.
      That is a failure to look, not an empty list.</p>
    </section>`;
    return;
  }

  if (!state.data) {
    root.innerHTML = `<section class="panel pz-panel"><h1>Prioritize</h1>
      <p class="pz-loading">Ranking open work…</p></section>`;
    return;
  }

  const { items, totalOpen, generatedAt } = state.data;
  const list = items || [];

  const listHTML = list.length
    ? list.map(rowHTML).join('')
    : '<p class="pz-empty">Nothing open to rank. Either everything is done, or the board could not be read — check which.</p>';

  const shown = list.length;
  const more = totalOpen > shown
    ? `<p class="pz-more">Showing the top ${esc(shown)} of ${esc(totalOpen)} open items. The rest are ranked below in the board.</p>`
    : '';

  root.innerHTML = `<section class="panel pz-panel">
    <h1>Prioritize</h1>
    <p class="pz-lede">What to do today, ranked by a scored heuristic — priority, whether only you
      can do it, how long it has been waiting, and whether it is a bug or a deferred decision.
      The score is named and fixed, not a measurement; disagree with an ordering and the fix is
      to change a weight in the route, in the open.</p>
    <p class="pz-asof">Generated ${esc(generatedAt || '')}.</p>
    ${listHTML}
    ${more}
  </section>`;
}

async function load() {
  try {
    state.data = await (await fetch('/api/prioritize')).json();
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
    renderLede('prioritize', el);
  },
  unmount() { root = null; state = null; },
};
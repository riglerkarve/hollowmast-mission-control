//
// unsigned — a log of changes shipped without explicit owner sign-off.
//
// ONE FETCH, ONE LIST. The route returns only the changes whose signedOff
// flag is false — commits and handovers that arrived without a decision
// behind them. This panel sorts them newest-first and renders one card per
// change. It does not derive sign-off, infer it, or second-guess the route:
// a panel that recomputed "was this signed off" would agree with the route
// until one was edited, and then disagree without erroring — the exact
// failure this project keeps meeting.
//
// EACH CARD SHOWS what changed (title), when (when), and who made the change
// (who). The kind (commit vs handover) is marked so a reader can tell a code
// change from a session record at a glance. The ref is the revert handle —
// a commit short-hash or a handover filename — shown in the mono face so it
// can be copied.
import { renderLede } from '/panels/lede/lede.js';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Commit subjects and handover titles are escaped, not parsed. A half-implemented
// markdown renderer that swallows a `**` is worse than plain text, because it
// silently changes what was recorded.
const prose = (s) => esc(s).replace(/\n{2,}/g, '</p><p>').replace(/\n/g, '<br>');

let root = null;
let state = null;

// Sort by date descending — newest first, so the most recent unreviewed change
// is the first thing the eye lands on. The route already sorts this way, but
// a panel that relied on the route's sort order would break the day the route
// changed it, so we sort again here.
function sortByDateDesc(items) {
  return items.slice().sort((a, b) => {
    const ta = new Date(a.when).getTime();
    const tb = new Date(b.when).getTime();
    return (Number.isFinite(tb) ? tb : 0) - (Number.isFinite(ta) ? ta : 0);
  });
}

function cardHTML(item) {
  const kindLabel = item.kind === 'handover' ? 'handover' : 'commit';
  const kindClass = item.kind === 'handover' ? 'un-kind-handover' : 'un-kind-commit';
  const ref = item.ref ? `<span class="un-ref">${esc(item.ref)}</span>` : '';
  const who = esc(item.who || 'unknown');
  const whenDate = esc(String(item.when || '').slice(0, 10));
  const project = item.project ? `<span class="un-project">${esc(item.project)}</span>` : '';

  return `<article class="un-card">
    <div class="un-meta">
      <span class="un-kind ${kindClass}">${kindLabel}</span>
      ${ref}
      ${project}
      <span class="un-who">${who}</span>
      <span class="un-when">${whenDate}</span>
    </div>
    <p class="un-text">${prose(item.title || '(no description)')}</p>
  </article>`;
}

function render() {
  if (!root || !state) return;

  if (state.error) {
    root.innerHTML = `<section class="panel un-panel">
      <h1>Unsigned changes</h1>
      <p class="un-alarm">Could not read the unsigned-changes log — ${esc(state.error)}.
      That is a failure to look, not an empty log.</p>
    </section>`;
    return;
  }

  if (!state.data) {
    root.innerHTML = `<section class="panel un-panel"><h1>Unsigned changes</h1>
      <p class="un-loading">Reading the log…</p></section>`;
    return;
  }

  const items = sortByDateDesc(state.data.items || []);

  const listHTML = items.length
    ? items.map(cardHTML).join('')
    : '<p class="un-empty">No unsigned changes. Everything shipped has been signed off.</p>';

  root.innerHTML = `<section class="panel un-panel">
    <h1>Unsigned changes</h1>
    <p class="un-lede">Changes shipped without explicit owner sign-off — commits and
      handovers that arrived without a decision behind them. Newest first, so the
      most recent unreviewed change is on top. Each entry shows what changed, when,
      and who made it. The ref is the revert handle.</p>
    <h2 class="un-h2">Unsigned <span class="un-n">${items.length}</span></h2>
    ${listHTML}
  </section>`;
}

async function load() {
  try {
    state.data = await (await fetch('/api/changes/unsigned')).json();
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
    renderLede('unsigned', el);
  },
  unmount() { root = null; state = null; },
};
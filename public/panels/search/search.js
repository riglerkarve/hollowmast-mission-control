//
// search — cross-project search across the backlog, board items, handovers, and files.
//
// ONE INPUT, ONE FETCH, FOUR GROUPS. A debounced search input fires GET /api/search?q=…,
// and the results are grouped by source: Backlog (id, title, project, kind, priority, and
// where the match landed), Board items (ref, title, project badge, kind), Handovers (title,
// shift, date), and Files (path only). Each result is clickable-looking but static — no
// actions are wired, because a search that navigates before the owner has read the matches
// is a guess, not a tool.
//
// BACKLOG IS FIRST because it is the store the owner authored. Board items are the read-only
// import of project trackers; the backlog is where a filed finding actually lives, so it is
// the answer to "did I write this down?" and belongs above the copies.
//
// A CAP THAT BIT IS SAID OUT LOUD. The route returns `truncated` per source; every group
// whose count was capped prints how many it dropped. A list that quietly stops at 50 reads
// as a complete answer, and the owner has no way to tell it was not.
//
// ABSENCE AND FAILURE MUST LOOK DIFFERENT. Three states, three messages:
//   Empty (no query yet): "Type to search across the backlog, board items, handovers, and workspace files."
//   No results (query returned zero): "No matches found. That is a real count, not a failed search."
//   Error (fetch failed): "Could not search — <error>. That is a failure to look, not no results."
// Conflating any two is the failure mode this workspace was built to prevent.
import { renderLede } from '/panels/lede/lede.js';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const day = (s) => String(s || '').slice(0, 10);

let root = null;
let state = null;
let debounceTimer = null;
let lastQuery = '';

// A board item row: ref, title, project, kind, status. The project is a badge because it
// is the cross-project axis — the thing that tells the owner which workspace this belongs
// to. The kind is a tag because bug/request/note/question are different things read at the
// same weight. Status is shown only when it is not the default, so a clean board does not
// fill with noise.
function boardCardHTML(item) {
  const status = item.status && item.status !== 'open'
    ? `<span class="sr-tag sr-tag-${esc(item.status)}">${esc(item.status)}</span>`
    : '';
  return `<article class="sr-card sr-card-board">
    <div class="sr-card-head">
      <span class="sr-ref">${esc(item.ref)}</span>
      <span class="sr-badge">${esc(item.project)}</span>
      <span class="sr-tag sr-tag-kind">${esc(item.kind)}</span>
      ${status}
    </div>
    <p class="sr-title">${esc(item.title)}</p>
  </article>`;
}

// A backlog row: id, title, project, kind, priority, status, and where the query matched.
//
// `matchedIn` is rendered, not hidden. A hit on the title and a hit buried in a 900-word
// rationale are different results, and showing which one it was is the difference between
// "here is your item" and "something in here contains that word". The project badge falls
// back to "unassigned" rather than being omitted, because a blank where a badge belongs
// reads as a rendering bug rather than as an item nobody filed against a project.
function backlogCardHTML(item) {
  const priority = item.priority
    ? `<span class="sr-tag sr-tag-priority">${esc(item.priority)}</span>` : '';
  const kind = item.kind
    ? `<span class="sr-tag sr-tag-kind">${esc(item.kind)}</span>` : '';
  const status = item.status && item.status !== 'open'
    ? `<span class="sr-tag sr-tag-${esc(item.status)}">${esc(item.status)}</span>` : '';
  const where = (item.matchedIn && item.matchedIn.length)
    ? `<p class="sr-matched">matched in ${esc(item.matchedIn.join(', '))}</p>` : '';
  return `<article class="sr-card sr-card-backlog">
    <div class="sr-card-head">
      <span class="sr-ref">${esc(item.id)}</span>
      <span class="sr-badge">${esc(item.project || 'unassigned')}</span>
      ${kind}
      ${priority}
      ${status}
    </div>
    <p class="sr-title">${esc(item.title)}</p>
    ${where}
  </article>`;
}

// A handover row: title, shift, date. The done/blocked/next prose is escaped, not parsed —
// a half-implemented markdown renderer that swallows a `**` is worse than plain text,
// because it silently changes what was recorded.
function handoverCardHTML(h) {
  const done = h.done ? `<div class="sr-h-field"><h5>Done</h5><p>${esc(h.done).replace(/\n/g, '<br>')}</p></div>` : '';
  const blocked = h.blocked ? `<div class="sr-h-field"><h5>Blocked</h5><p>${esc(h.blocked).replace(/\n/g, '<br>')}</p></div>` : '';
  const next = h.next ? `<div class="sr-h-field"><h5>Next</h5><p>${esc(h.next).replace(/\n/g, '<br>')}</p></div>` : '';
  return `<article class="sr-card sr-card-handover">
    <div class="sr-card-head">
      <span class="sr-shift">${esc(h.shift)}</span>
      <span class="sr-when">${esc(day(h.at))}</span>
    </div>
    <p class="sr-title">${esc(h.title)}</p>
    ${done}${blocked}${next}
  </article>`;
}

// A file row: path only. No line numbers, no context — the path is the result. The owner
// opens the file himself; a search that navigates before he has read the matches is a guess.
function fileRowHTML(f) {
  return `<div class="sr-file">${esc(f)}</div>`;
}

// A group heading, its count, its rows — and, when the cap bit, what it dropped. The
// dropped line is part of the result, not a footnote: a list that silently stops reads as
// the whole answer.
// A group heading, its count, its rows — and, when the cap bit or the source could not look
// everywhere, what it did not cover. Both lines are part of the result, not a footnote: a
// list that silently stops reads as the whole answer.
function groupHTML(label, count, inner, dropped, note) {
  const more = dropped > 0
    ? `<p class="sr-matched">Showing ${count}; ${dropped} further match${dropped === 1 ? '' : 'es'} not listed. Narrow the search to see them.</p>`
    : '';
  const caveat = note ? `<p class="sr-matched">${esc(note)}</p>` : '';
  return `<h2 class="sr-h2">${esc(label)} <span class="sr-n">${count}</span></h2>${more}${caveat}${inner}`;
}

function render() {
  if (!root || !state) return;

  // Error state: the fetch failed. This is a failure to look, not no results — the two must
  // never look the same.
  if (state.error) {
    root.innerHTML = `<section class="panel sr-panel">
      <h1>Search</h1>
      <div class="sr-search-box">
        <input type="text" class="sr-input" placeholder="Search the backlog, board, handovers, files…"
          value="${esc(lastQuery)}" />
      </div>
      <p class="sr-alarm">Could not search — ${esc(state.error)}.
      That is a failure to look, not no results.</p>
    </section>`;
    bindInput();
    return;
  }

  // Empty state: no query has been typed yet. The placeholder is the call to action.
  if (!state.data && !state.searching) {
    root.innerHTML = `<section class="panel sr-panel">
      <h1>Search</h1>
      <div class="sr-search-box">
        <input type="text" class="sr-input" placeholder="Search the backlog, board, handovers, files…" />
      </div>
      <p class="sr-empty">Type to search across the backlog, board items, handovers, and workspace files.</p>
    </section>`;
    bindInput();
    return;
  }

  // Loading state: a query is in flight. Show the input with its value and a loading note.
  if (state.searching) {
    root.innerHTML = `<section class="panel sr-panel">
      <h1>Search</h1>
      <div class="sr-search-box">
        <input type="text" class="sr-input" placeholder="Search the backlog, board, handovers, files…"
          value="${esc(lastQuery)}" />
      </div>
      <p class="sr-loading">Searching…</p>
    </section>`;
    bindInput();
    return;
  }

  // Results state: data is in. Group by source, show counts, and if the total is zero show
  // the no-results message — which is a real count, not a failed search.
  const d = state.data;
  const total = d.total;

  // Zero results is only "a real count" if every source actually looked. If any source
  // reported a caveat, the honest statement is that nothing was found in what WAS searched —
  // so that case falls through to the grouped render, where the caveat is visible.
  const anyCaveat = Object.keys(d.notes || {}).length > 0;

  if (total === 0 && !anyCaveat) {
    root.innerHTML = `<section class="panel sr-panel">
      <h1>Search</h1>
      <div class="sr-search-box">
        <input type="text" class="sr-input" placeholder="Search the backlog, board, handovers, files…"
          value="${esc(lastQuery)}" />
      </div>
      <p class="sr-empty">No matches found. That is a real count, not a failed search.</p>
    </section>`;
    bindInput();
    return;
  }

  // The route may predate this panel (or a source may have thrown), so every array and the
  // truncated bundle are read defensively. A missing key must render as "this group has
  // nothing", never as a thrown TypeError that blanks the whole result set.
  const t = d.truncated || {};
  const n = d.notes || {};
  const backlog = d.backlog || [];

  // A group renders when it has rows OR when it has a caveat. A source that found nothing
  // and a source that could not look everywhere must not both render as silence — dropping
  // an empty-but-caveated group is how "could not look" gets read as "looked and it was
  // fine", which is the one confusion this panel exists to prevent.
  const backlogHTML = (backlog.length || n.backlog)
    ? groupHTML('Backlog', backlog.length, backlog.map(backlogCardHTML).join(''), t.backlog || 0, n.backlog)
    : '';
  const boardHTML = (d.board.length || n.board)
    ? groupHTML('Board items', d.board.length, d.board.map(boardCardHTML).join(''), t.board || 0, n.board)
    : '';
  const handoverHTML = (d.handovers.length || n.handovers)
    ? groupHTML('Handovers', d.handovers.length, d.handovers.map(handoverCardHTML).join(''), t.handovers || 0, n.handovers)
    : '';
  const fileHTML = (d.files.length || n.files)
    ? groupHTML('Files', d.files.length, d.files.map(fileRowHTML).join(''), t.files || 0, n.files)
    : '';

  root.innerHTML = `<section class="panel sr-panel">
    <h1>Search</h1>
    <div class="sr-search-box">
      <input type="text" class="sr-input" placeholder="Search the backlog, board, handovers, files…"
        value="${esc(lastQuery)}" />
    </div>
    <p class="sr-summary">${total} match${total === 1 ? '' : 'es'} for "${esc(d.query)}"</p>
    ${backlogHTML}
    ${boardHTML}
    ${handoverHTML}
    ${fileHTML}
  </section>`;
  bindInput();
}

// Re-bind the input listener after every render, because innerHTML replaces the element.
// The debounce is 300ms — short enough to feel instant, long enough to not fire per keystroke.
function bindInput() {
  const input = root && root.querySelector('.sr-input');
  if (!input) return;
  input.addEventListener('input', onInput);
  // Focus the input so the owner can start typing immediately.
  input.focus();
  // Place the cursor at the end of any existing text.
  if (input.value) {
    input.setSelectionRange(input.value.length, input.value.length);
  }
}

function onInput(e) {
  const q = e.target.value;
  lastQuery = q;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => doSearch(q), 300);
}

async function doSearch(q) {
  q = q.trim();
  if (!q) {
    state.data = null;
    state.searching = false;
    state.error = null;
    render();
    return;
  }

  state.searching = true;
  state.data = null;
  state.error = null;
  render();

  try {
    const r = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
    if (!r.ok) throw new Error(`${r.status}`);
    const data = await r.json();
    state.data = data;
    state.error = data.error || null;
  } catch (e) {
    state.error = e.message;
  } finally {
    state.searching = false;
    render();
  }
}

export default {
  mount(el, opts) {
    root = el;
    state = { data: null, searching: false, error: null };
    lastQuery = '';
    render();
    renderLede('search', el);
  },
  unmount() {
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
    root = null;
    state = null;
    lastQuery = '';
  },
};
// The second brain. Renders the ~106 memory files Claude writes across sessions, and
// lets you flag one as wrong, stale or important — which Claude reads back at session
// start via the generated _flags.md.
//
// Reads ONLY /api/brain. It never touches another module's route or tables.

import { renderLede } from '/panels/lede/lede.js';
const TEMPLATE = `
  <div class="panel panel-wide">
    <div class="panel-header">
      <h1>Second brain</h1>
      <div class="badge"><span class="badge-icon">🧠</span><span id="brainCount">—</span></div>
    </div>

    <section class="card">
      <div class="brain-toolbar">
        <input id="brainSearch" class="brain-search" type="search"
               placeholder="Search names and descriptions…" autocomplete="off">
        <select id="brainSort" class="brain-sort" aria-label="Order memories by">
          <option value="name">A–Z</option>
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
          <option value="longest">Longest</option>
          <option value="linked">Most linked</option>
          <option value="flagged">Flagged first</option>
        </select>
        <div class="mode-tabs" id="brainTypes"></div>
      </div>
      <div id="brainStats" class="brain-stats"></div>
    </section>

    <div class="brain-split">
      <section class="card brain-list" id="brainList"></section>
      <section class="card brain-detail" id="brainDetail">
        <p class="empty-hint">Select a memory to read it.</p>
      </section>
    </div>

    <section class="card">
      <h2 class="brain-h2">Your own entries</h2>
      <p class="brain-note-intro">Everything above was written by Claude — lessons from
        getting something wrong. This is the half you write. Entries here are not memories
        and are not guesses about you: they are read back at the start of every session as
        <em>fact and instruction</em>. Use <code>[[name]]</code> to point at any memory, and
        it will show up on that memory as a link back.</p>
      <form class="brain-note-form" id="brainNoteForm">
        <div class="brain-note-row">
          <input id="brainNoteTitle" class="brain-in" placeholder="Title" required maxlength="120">
          <select id="brainNoteKind" class="brain-sort" aria-label="Kind of entry">
            <option value="note">note</option>
            <option value="reference">reference</option>
            <option value="decision">decision</option>
          </select>
        </div>
        <textarea id="brainNoteBody" class="brain-in brain-ta" rows="4" required
                  placeholder="What is worth keeping? Link with [[a-memory-name]]."></textarea>
        <button class="btn primary" type="submit">Save entry</button>
      </form>
      <div id="brainNoteResult" class="brain-result"></div>
      <div id="brainNotes"></div>
    </section>

    <section class="card">
      <h2 class="brain-h2">Owner decisions</h2>
      <p class="brain-note-intro">Cross-venture calls — which niche, which spend ceiling, why
        HOLLOWMAST stays private — kept in the same shape as the AI team's own decision log, so
        a business or personal call can be found and explained later. This register is not
        edited or deleted: a change of mind supersedes the old row rather than rewriting it.</p>
      <form class="brain-note-form" id="brainDecisionForm">
        <div class="brain-note-row">
          <input id="brainDecisionVenture" class="brain-in" list="brainVentureList"
                 placeholder="Venture (e.g. HOLLOWMAST)" required maxlength="60">
          <input id="brainDecisionTitle" class="brain-in" placeholder="Decision" required maxlength="160">
        </div>
        <datalist id="brainVentureList"></datalist>
        <textarea id="brainDecisionBecause" class="brain-in brain-ta" rows="3" required
                  placeholder="Because — the reasoning behind it"></textarea>
        <div class="brain-note-row">
          <input id="brainDecisionCost" class="brain-in" placeholder="Cost if wrong (optional)" maxlength="200">
          <input id="brainDecisionRevisit" class="brain-in" placeholder="Revisit when… (optional)" maxlength="200">
        </div>
        <div class="brain-note-row">
          <input id="brainDecisionRecheck" class="brain-in" type="date" aria-label="Recheck date (optional)">
          <input id="brainDecisionEvidence" class="brain-in" placeholder="Evidence (optional)" maxlength="200">
        </div>
        <select id="brainDecisionSupersedes" class="brain-sort" aria-label="Supersedes an earlier decision">
          <option value="">— does not supersede an earlier decision —</option>
        </select>
        <button class="btn primary" type="submit">Save decision</button>
      </form>
      <div id="brainDecisionResult" class="brain-result"></div>
      <div id="brainDecisions"></div>
    </section>
  </div>
`;

const STATUSES = [
  ['important', '★ important'],
  ['stale', '◷ stale'],
  ['wrong', '✕ wrong'],
];

let root = null;
let all = [];
let typeFilter = null;
let selected = null;
let decisions = [];
// Ordering is the ROUTE's job, not the panel's: it holds the frontmatter-vs-mtime rule
// and the caveat that goes with it. The panel only remembers which order was asked for.
let sortBy = 'name';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function api(path, opts) {
  const res = await fetch(`/api/brain${path}`, opts);
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error((body && body.error) || `HTTP ${res.status}`);
  return body;
}

function renderList() {
  const list = root.querySelector('#brainList');
  const shown = typeFilter ? all.filter((m) => m.type === typeFilter) : all;

  if (!shown.length) {
    // An empty result and a failed load must not look the same.
    list.innerHTML = '<p class="empty-hint">No memory matches this search.</p>';
    return;
  }

  list.innerHTML = shown.map((m) => `
    <button class="brain-item${selected === m.name ? ' selected' : ''}" data-name="${esc(m.name)}">
      <span class="brain-item-top">
        <span class="brain-name">${esc(m.name)}</span>
        ${m.flag ? `<span class="brain-flag brain-flag-${esc(m.flag.status)}">${esc(m.flag.status)}</span>` : ''}
      </span>
      <span class="brain-desc">${esc(m.description)}</span>
      <span class="brain-meta">${esc(m.type)} · ${m.words} words · ${m.links.length} link${m.links.length === 1 ? '' : 's'} · ${esc(m.modified)}</span>
    </button>
  `).join('');

  list.querySelectorAll('.brain-item').forEach((b) => {
    b.addEventListener('click', () => selectMemory(b.dataset.name));
  });
}

async function selectMemory(name) {
  if (!root) return;   // may be CALLED after teardown, not only resumed after it
  selected = name;
  renderList();
  const detail = root.querySelector('#brainDetail');
  detail.innerHTML = '<p class="empty-hint">Loading…</p>';

  let m;
  try { m = await api(`/${encodeURIComponent(name)}`); } catch (err) {
    if (!root) return;   // the panel was torn down mid-await; root is null now
    detail.innerHTML = `<p class="brain-error">Could not load this memory: ${esc(err.message)}</p>`;
    return;
  }

  const body = m.markdown.replace(/^---[\s\S]*?---\r?\n/, '').trim();
  detail.innerHTML = `
    <div class="brain-detail-head">
      <h2>${esc(m.name)}</h2>
      <span class="brain-meta">${esc(m.type)} · ${esc(m.file)} · modified ${esc(m.modified)}</span>
    </div>
    <div class="brain-flags">
      ${STATUSES.map(([s, label]) => `
        <button class="btn brain-set${m.flag && m.flag.status === s ? ' primary' : ''}" data-status="${s}">${label}</button>
      `).join('')}
      <button class="btn brain-set" data-status="">clear</button>
      <input id="brainNote" class="brain-note" placeholder="why? (optional)"
             value="${esc(m.flag ? m.flag.note || '' : '')}">
    </div>
    <div id="brainFlagResult" class="brain-result"></div>
    <pre class="brain-body">${esc(body)}</pre>
    ${m.links.length ? `<p class="brain-meta">Links to: ${m.links.map((l) => `<a href="#" data-goto="${esc(l)}">${esc(l)}</a>`).join(', ')}</p>` : ''}
    ${(m.backlinks && m.backlinks.length)
    // The direction you cannot get by reading the file in front of you. Outbound links
    // were always shown; nothing computed the reverse until #M2.
    ? `<p class="brain-meta">Linked from: ${m.backlinks.map((b) => `<a href="#" data-goto="${esc(b.from)}">${esc(b.from)}</a>${b.kind === 'note' ? ' <b>(your note)</b>' : ''}`).join(', ')}</p>`
    : '<p class="brain-meta brain-dim">Nothing links here yet.</p>'}
  `;

  detail.querySelectorAll('.brain-set').forEach((b) => {
    b.addEventListener('click', () => setFlag(name, b.dataset.status || null));
  });
  detail.querySelectorAll('[data-goto]').forEach((a) => {
    a.addEventListener('click', (e) => { e.preventDefault(); selectMemory(a.dataset.goto); });
  });
}

// Backlog #M2. The owner's own entries. This is the only place in the whole panel that
// WRITES something that is not a flag.
async function renderNotes() {
  if (!root) return;   // may be CALLED after teardown, not only resumed after it
  const box = root.querySelector('#brainNotes');
  let d;
  try {
    d = await api('/notes');
    if (!root) return;   // the panel was torn down mid-await; root is null now
  } catch (err) {
    if (!root) return;   // the panel was torn down mid-await; root is null now
    box.innerHTML = `<p class="brain-error">Could not read your entries: ${esc(err.message)}
      — that is a failure to look, not a report that you have written none.</p>`;
    return;
  }

  const reach = d.reachesClaude === null
    ? `<span class="brain-warn">${esc(d.reachesNote)}</span>`
    : `<span class="brain-dim">${esc(d.reachesNote)}</span>`;

  box.innerHTML = !d.notes.length
    ? `<p class="empty-hint">You have not written anything yet. ${reach}</p>`
    : `<p class="brain-meta">${d.notes.length}
         entr${d.notes.length === 1 ? 'y' : 'ies'} ·
         ${Object.entries(d.byKind).filter(([, n]) => n).map(([k, n]) => `${n} ${esc(k)}`).join(' · ')}
         · ${reach}</p>
       <ul class="brain-note-list">${d.notes.map((n) => `
         <li>
           <div class="brain-note-head">
             <span class="brain-note-title">${esc(n.title)}</span>
             <span class="brain-note-kind">${esc(n.kind)}</span>
             <button class="btn brain-note-del" data-id="${n.id}">Delete</button>
           </div>
           <pre class="brain-note-body">${esc(n.body)}</pre>
           <span class="brain-meta brain-dim">[[${esc(n.slug)}]] · updated ${esc(n.updated_at)}</span>
         </li>`).join('')}</ul>`;

  box.querySelectorAll('.brain-note-del').forEach((b) => {
    b.addEventListener('click', async () => {
      b.disabled = true;
      try {
        await api(`/notes/${b.dataset.id}`, { method: 'DELETE', headers: { 'x-mc-by': 'you' } });
        if (!root) return;   // the panel was torn down mid-await; root is null now
        renderNotes();
      } catch (err) {
        if (!root) return;   // the panel was torn down mid-await; root is null now
        b.disabled = false;
        root.querySelector('#brainNoteResult').innerHTML = `<p class="brain-error">${esc(err.message)}</p>`;
      }
    });
  });
}

// M149. Same shape as team_decisions (public/panels/team/team.js), for the owner's own
// cross-venture calls rather than the AI team's operational ones. There is no PATCH or
// DELETE here — the route deliberately offers none: a decision is superseded, not rewritten,
// so the register stays a record of what was actually decided at the time.
async function renderDecisions() {
  if (!root) return;   // may be CALLED after teardown, not only resumed after it
  const box = root.querySelector('#brainDecisions');
  let d;
  try {
    d = await api('/decisions');
    if (!root) return;   // the panel was torn down mid-await; root is null now
  } catch (err) {
    if (!root) return;   // the panel was torn down mid-await; root is null now
    box.innerHTML = `<p class="brain-error">Could not read the decision register: ${esc(err.message)}
      — that is a failure to look, not a report that none exist.</p>`;
    return;
  }

  decisions = d.decisions;
  const supersededBy = new Map();
  for (const row of decisions) {
    if (row.supersedes != null) supersededBy.set(row.supersedes, row.id);
  }

  const ventureList = root.querySelector('#brainVentureList');
  if (ventureList) ventureList.innerHTML = d.ventures.map((v) => `<option value="${esc(v)}">`).join('');

  // Only offer to supersede the head of a chain — superseding an already-superseded row
  // would bury the real current answer one link deeper instead of correcting it.
  const supersedesSel = root.querySelector('#brainDecisionSupersedes');
  if (supersedesSel) {
    const current = supersedesSel.value;
    supersedesSel.innerHTML = '<option value="">— does not supersede an earlier decision —</option>'
      + decisions.filter((r) => !supersededBy.has(r.id)).map((r) =>
        `<option value="${r.id}">#${r.id} ${esc(r.venture)} — ${esc(r.decision)}</option>`).join('');
    supersedesSel.value = current;
  }

  const today = new Date().toISOString().slice(0, 10);

  // Same honesty check as the notes list above: whether this reaches Claude is a fact
  // about the generated file, not an assumption from "the save request returned 201".
  const reach = d.reachesClaude === null
    ? `<span class="brain-warn">${esc(d.reachesNote)}</span>`
    : `<span class="brain-dim">${esc(d.reachesNote)}</span>`;

  box.innerHTML = !decisions.length
    ? `<p class="empty-hint">No owner decisions logged yet. ${reach}</p>`
    : `<p class="brain-meta">${decisions.length} decision${decisions.length === 1 ? '' : 's'} across
         ${d.ventures.length} venture${d.ventures.length === 1 ? '' : 's'} · ${reach}</p>
       <ul class="brain-note-list">${decisions.map((row) => {
    const superseded = supersededBy.has(row.id);
    const due = !superseded && row.recheck_at && row.recheck_at <= today;
    return `
         <li class="${superseded ? 'brain-decision-superseded' : ''}">
           <div class="brain-note-head">
             <span class="brain-note-kind">${esc(row.venture)}</span>
             <span class="brain-note-title">${esc(row.decision)}</span>
             ${superseded ? `<span class="brain-flag brain-flag-stale">superseded by #${supersededBy.get(row.id)}</span>` : ''}
             ${due ? '<span class="brain-flag brain-flag-wrong">recheck due</span>' : ''}
           </div>
           <p class="brain-note-body">${esc(row.because)}</p>
           ${row.cost_if_wrong ? `<p class="brain-meta"><b>If wrong:</b> ${esc(row.cost_if_wrong)}</p>` : ''}
           ${row.revisit_when ? `<p class="brain-meta"><b>Revisit when:</b> ${esc(row.revisit_when)}${row.recheck_at ? ` (by ${esc(row.recheck_at)})` : ''}</p>` : ''}
           ${row.evidence ? `<p class="brain-meta"><b>Evidence:</b> ${esc(row.evidence)}</p>` : ''}
           ${row.supersedes != null ? `<p class="brain-meta brain-dim">Supersedes decision #${row.supersedes}</p>` : ''}
           <span class="brain-meta brain-dim">#${row.id} · ${esc(row.at)}</span>
         </li>`;
  }).join('')}</ul>`;
}

async function setFlag(name, status) {
  if (!root) return;   // may be CALLED after teardown, not only resumed after it
  const note = root.querySelector('#brainNote')?.value || '';
  const out = root.querySelector('#brainFlagResult');
  out.textContent = 'saving…';
  out.className = 'brain-result';

  try {
    const r = await api(`/${encodeURIComponent(name)}/flag`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-mc-by': 'you' },
      body: JSON.stringify({ status, note }),
    });
    // Redraw FIRST, then write the message. Doing it the other way round set the text and
    // then immediately destroyed it in the re-render — the confirmation was written, and
    // unreadable, which is indistinguishable from the flag not being saved at all.
    await load(root.querySelector('#brainSearch').value);
    if (!root) return;   // the panel was torn down mid-await; root is null now
    await selectMemory(name);
    if (!root) return;   // the panel was torn down mid-await; root is null now

    // Report what actually reached Claude, not merely that the click was received.
    const after = root.querySelector('#brainFlagResult');
    if (after) {
      after.textContent = status
        ? `Flagged "${status}". ${r.flagsFile} — Claude reads this at session start.`
        : `Flag cleared. ${r.flagsFile}`;
      after.className = 'brain-result ok';
    }
  } catch (err) {
    if (!root) return;   // the panel was torn down mid-await; root is null now
    out.textContent = `Not saved: ${err.message}`;
    out.className = 'brain-result bad';
  }
}

async function load(q) {
  if (!root) return;   // may be CALLED after teardown, not only resumed after it
  const stats = root.querySelector('#brainStats');
  let data;
  try {
    // The route has supported six orders and a sortCaveat since it was written; nothing
    // in the panel ever asked for one, so the store could only be read A-Z. Backlog #2.
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (sortBy && sortBy !== 'name') params.set('sort', sortBy);
    const qs = params.toString();
    data = await api(`/${qs ? `?${qs}` : ''}`);
    if (!root) return;   // the panel was torn down mid-await; root is null now
  } catch (err) {
    if (!root) return;   // the panel was torn down mid-await; root is null now
    // 503 means the directory could not be read. That is a different fact from "there
    // are no memories", and the panel says which.
    root.querySelector('#brainList').innerHTML =
      `<p class="brain-error">Could not read the memory store: ${esc(err.message)}</p>`;
    stats.textContent = '';
    return;
  }

  all = data.memories;
  root.querySelector('#brainCount').textContent = `${data.shown} of ${data.total}`;

  stats.innerHTML = `
    <span>${data.total} memories</span>
    <span>${Object.entries(data.byType).map(([t, n]) => `${n} ${esc(t)}`).join(' · ')}</span>
    <span>${data.flagged} flagged</span>
    ${data.sortCaveat ? `<span class="brain-warn">${esc(data.sortCaveat)}</span>` : ''}
    <span class="${data.dangling.length ? 'brain-warn' : ''}">${
      data.dangling.length
        ? `${data.dangling.length} broken link${data.dangling.length === 1 ? '' : 's'}: ${data.dangling.map(esc).join(', ')}`
        : 'every [[link]] resolves'}</span>
  `;

  const tabs = root.querySelector('#brainTypes');
  const types = Object.keys(data.byType).sort();
  tabs.innerHTML = [['', 'all'], ...types.map((t) => [t, t])]
    .map(([v, label]) => `<button class="mode-tab${typeFilter === (v || null) ? ' active' : ''}" data-type="${esc(v)}">${esc(label)}</button>`)
    .join('');
  tabs.querySelectorAll('.mode-tab').forEach((b) => {
    b.addEventListener('click', () => {
      typeFilter = b.dataset.type || null;
      tabs.querySelectorAll('.mode-tab').forEach((x) => x.classList.toggle('active', x === b));
      renderList();
    });
  });

  renderList();
}

let searchTimer = null;

export default {
  mount(el) {
    root = el;
    el.innerHTML = TEMPLATE;
    renderLede('brain', el);
    const search = el.querySelector('#brainSearch');
    search.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => load(search.value), 200);
    });

    const sortSel = el.querySelector('#brainSort');
    sortSel.value = sortBy;
    sortSel.addEventListener('change', () => {
      sortBy = sortSel.value;
      // The current search is kept, so changing order does not silently widen the set.
      load(search.value);
    });

    el.querySelector('#brainNoteForm').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const out = el.querySelector('#brainNoteResult');
      const title = el.querySelector('#brainNoteTitle').value.trim();
      const body = el.querySelector('#brainNoteBody').value.trim();
      const kind = el.querySelector('#brainNoteKind').value;
      if (!title || !body) return;

      out.innerHTML = '';
      try {
        const r = await api('/notes', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-mc-by': 'you' },
          body: JSON.stringify({ title, body, kind }),
        });
        el.querySelector('#brainNoteTitle').value = '';
        el.querySelector('#brainNoteBody').value = '';
        // Says what actually happened, including the part that matters: it reached the
        // file Claude reads. "Saved" alone would not distinguish stored from surfaced.
        out.innerHTML = `<p class="brain-ok">Saved as <code>[[${esc(r.slug)}]]</code> and
          written to the memory directory — Claude reads it at the start of the next session.</p>`;
        renderNotes();
        // A new note can add a backlink to whatever is open, so refresh the detail too.
        if (selected) selectMemory(selected);
      } catch (err) {
        out.innerHTML = `<p class="brain-error">${esc(err.message)}</p>`;
      }
    });

    el.querySelector('#brainDecisionForm').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const out = el.querySelector('#brainDecisionResult');
      const venture = el.querySelector('#brainDecisionVenture').value.trim();
      const decision = el.querySelector('#brainDecisionTitle').value.trim();
      const because = el.querySelector('#brainDecisionBecause').value.trim();
      const costIfWrong = el.querySelector('#brainDecisionCost').value.trim();
      const revisitWhen = el.querySelector('#brainDecisionRevisit').value.trim();
      const recheckAt = el.querySelector('#brainDecisionRecheck').value;
      const evidence = el.querySelector('#brainDecisionEvidence').value.trim();
      const supersedes = el.querySelector('#brainDecisionSupersedes').value;
      if (!venture || !decision || !because) return;

      out.innerHTML = '';
      try {
        const r = await api('/decisions', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-mc-by': 'you' },
          body: JSON.stringify({
            venture, decision, because,
            cost_if_wrong: costIfWrong || undefined,
            revisit_when: revisitWhen || undefined,
            recheck_at: recheckAt || undefined,
            evidence: evidence || undefined,
            supersedes: supersedes ? Number(supersedes) : undefined,
          }),
        });
        el.querySelector('#brainDecisionForm').reset();
        // Says what actually happened, including the part that matters: it reached the
        // file Claude reads, same convention as the note-save confirmation above.
        out.innerHTML = `<p class="brain-ok">Saved as decision #${r.id} — written to the memory
          directory (${r.written} decision${r.written === 1 ? '' : 's'} total). Claude reads it
          at the start of the next session.</p>`;
        renderDecisions();
      } catch (err) {
        out.innerHTML = `<p class="brain-error">${esc(err.message)}</p>`;
      }
    });

    load('');
    // Called separately from load(): the notes list and the decision register each come
    // from a different route and must not disappear because the memory store failed to read.
    renderNotes();
    renderDecisions();
  },

  // Not optional: the debounce timer would otherwise keep firing against a detached DOM
  // after you switch panels.
  unmount() {
    clearTimeout(searchTimer);
    searchTimer = null;
    root = null;
    all = [];
    selected = null;
    typeFilter = null;
    decisions = [];
    // sortBy is deliberately NOT reset, and the difference is not an oversight: a type
    // filter HIDES memories, so carrying one back into a fresh mount would make the store
    // look smaller than it is. An order hides nothing, so remembering it is safe.
  },
};

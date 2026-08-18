// Backlog — two views over one store. Reads only /api/todo.
//
// The list is the least interesting part of this panel. 93 rows in a spreadsheet were
// already a list; what was missing was the answer to "what now", and how much of the
// plan is not mine to move. Both come from the route, computed once, so the panel and
// the summary can never disagree about them.
//
// Priorities are your editorial judgement, not a score — so every item carries the
// reasoning that produced it, one click away, and nothing here ranks anything by a
// weighting of its own.

const VIEWS = {
  mine: {
    tab: 'Yours — decisions',
    heading: 'Only you can do these',
    blurb: 'Decisions, approvals, accounts, signatures, purchases. Nothing in the build queue clears any of them.',
  },
  build: {
    tab: 'The build queue',
    heading: 'Work to be done',
    blurb: 'Everything that does not need you personally — deterministic, local model, or frontier.',
  },
};

const STATUS_LABEL = { open: 'open', in_progress: 'in progress', done: 'done', declined: 'declined' };
const CLUSTERS_FALLBACK = [];

const TEMPLATE = `
  <div class="panel panel-wide td-panel">
    <div class="panel-header">
      <h1>Backlog</h1>
      <div class="td-head-right">
        <div class="badge"><span class="badge-icon">◷</span><span id="tdBadge">—</span></div>
        <a class="td-export" href="/api/todo/export.csv" download
           title="All items, both views, as CSV — regenerate the spreadsheet from here rather than editing it alongside">Export CSV</a>
      </div>
    </div>

    <section class="card" id="tdConstraintCard">
      <div id="tdConstraint"></div>
    </section>

    <section class="card" id="tdClusters"></section>

    <div class="mode-tabs" id="tdTabs">
      <button class="mode-tab active" type="button" data-view="mine">${VIEWS.mine.tab}</button>
      <button class="mode-tab" type="button" data-view="build">${VIEWS.build.tab}</button>
    </div>

    <section class="card">
      <h2 class="td-h2">What is actionable now</h2>
      <div id="tdNext"></div>
    </section>

    <div class="td-split">
      <section class="card">
        <h2 class="td-h2" id="tdListHead">Everything in this view</h2>
        <div class="td-filters" id="tdFilters"></div>
        <div id="tdList"></div>
        <details class="td-add">
          <summary>Add an item</summary>
          <form id="tdAdd" class="td-add-form">
            <input id="tdTitle" class="td-in" placeholder="What is it?" required>
            <textarea id="tdRationale" class="td-in td-area" rows="2" placeholder="Why — the reasoning, so the call can be argued with later"></textarea>
            <div class="td-add-row">
              <input id="tdCluster" class="td-in td-sm" placeholder="Cluster" list="tdClusterList">
              <datalist id="tdClusterList"></datalist>
              <select id="tdPriority" class="td-in td-sm">
                <option value="P0">P0</option><option value="P1">P1</option>
                <option value="P2" selected>P2</option><option value="P3">P3</option>
              </select>
              <select id="tdOwner" class="td-in td-sm">
                <option value="DET">DET</option><option value="LOC">LOC</option>
                <option value="DET+LOC">DET+LOC</option><option value="FRO">FRO</option>
                <option value="YOU">YOU</option>
              </select>
              <input id="tdEffort" class="td-in td-sm" placeholder="Effort e.g. 3h">
              <button class="btn primary" type="submit">Add</button>
            </div>
          </form>
        </details>
      </section>

      <section class="card">
        <h2 class="td-h2">The shape of what is left</h2>
        <div id="tdShape"></div>
      </section>
    </div>
  </div>
`;

let root = null;
let view = 'mine';
let embedded = false;
let filters = { status: '', cluster: '', priority: '' };
let clusters = CLUSTERS_FALLBACK;
let ac = null;                 // aborts in-flight fetches so a tab switch never writes into a dead DOM
let onClick = null;
let onChange = null;
let onSubmit = null;

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

async function api(path, opts = {}) {
  const res = await fetch(`/api/todo${path}`, { ...opts, signal: ac ? ac.signal : undefined });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error((body && body.error) || `HTTP ${res.status}`);
  return body;
}

// A failed fetch and an empty result must never look alike. Empty states are written by
// the route and say which kind of nothing they are; this only handles the other case,
// and always shows the message rather than an empty box.
function fail(el, what, err) {
  if (err && err.name === 'AbortError') return;       // panel unmounted mid-flight, not a failure
  if (!el) return;
  el.innerHTML = `<p class="td-error"><b>Could not load ${esc(what)}.</b> ${esc(err.message)}
    <br><span class="td-dim">This is a failure, not an empty list — nothing has been read, so do not take the counts above as current.</span></p>`;
}

const ageText = (d) => (d == null ? '' : d === 0 ? 'today' : plural(d, 'day') + ' old');

function ownerChip(owner) {
  const you = owner === 'YOU';
  return `<span class="td-chip ${you ? 'you' : 'bot'}" title="${you ? 'Only you can do this' : 'Where the work runs'}">${esc(owner)}</span>`;
}

const priClass = (p) => `pri-${String(p || '').toLowerCase()}`;

// --------------------------------------------------------------------------- summary
async function loadSummary() {
  if (!root) return;   // may be CALLED after teardown, not only resumed after it
  const el = root.querySelector('#tdConstraint');
  const shape = root.querySelector('#tdShape');
  let d;
  try { d = await api('/'); } catch (err) { fail(el, 'the backlog summary', err); fail(shape, 'the cluster shape', err); return; }
    if (!root) return;   // the panel was torn down mid-await; root is null now

  if (d.state === 'empty') {
    root.querySelector('#tdBadge').textContent = '0 items';
    el.innerHTML = `<p class="empty-hint">${esc(d.message)}</p>`;
    shape.innerHTML = '<p class="empty-hint">Nothing to shape — the store is empty.</p>';
    return;
  }

  const b = d.blockedOnYou;
  const e = d.buildEffort;
  clusters = d.byCluster.map((c) => c.cluster).filter(Boolean);
  const dl = root.querySelector('#tdClusterList');
  if (dl) dl.innerHTML = clusters.map((c) => `<option value="${esc(c)}">`).join('');

  root.querySelector('#tdBadge').textContent = `${b.openTotal} open of ${d.total}`;

  el.innerHTML = `
    <div class="stats-summary td-stats">
      <div class="stat-block"><span class="stat-value">${b.openTotal}</span><span class="stat-label">open</span></div>
      <div class="stat-block"><span class="stat-value td-you">${b.open}</span><span class="stat-label">only you can do</span></div>
      <div class="stat-block"><span class="stat-value">${b.openTotal - b.open}</span><span class="stat-label">buildable</span></div>
      <div class="stat-block"><span class="stat-value">${e.hours}h</span><span class="stat-label">build queue, estimated part</span></div>
    </div>

    <p class="td-banner"><b>${b.open} of ${b.openTotal} open items are waiting on you</b> — ${b.shareOfOpen}% of what is left.
    Nothing in the build queue can clear any of them, so this is the number that actually bounds the plan.</p>

    <div class="td-blocked">
      ${b.byPriority.map((p) => `<span class="td-count ${priClass(p.priority)}">${esc(p.priority)} <b>${p.count}</b></span>`).join('')}
    </div>
    ${b.oldest.length ? `<p class="td-note">Longest sitting with you:
      ${b.oldest.slice(0, 3).map((o) => `<b>${esc(o.id)}</b> ${esc(o.title)}`).join(' · ')}</p>` : ''}

    <p class="td-note td-dim">${esc(e.note)}
      ${e.partial.length ? `Two items are part-built and counted as what remains (${e.partial.map((p) => `${esc(p.id)}: ${esc(p.effort)}`).join(', ')}).` : ''}</p>
    <p class="td-note td-dim">${esc(d.noPercentComplete)} ${esc(d.notScored)} ${esc(d.ageBasis)}</p>
  `;

  // The shape, as a composition rather than a total. Each bar splits into the part that
  // needs you and the part that does not — a cluster that looks busy but is entirely
  // yours is a different problem from one that is entirely buildable.
  const maxOpen = Math.max(...d.byCluster.map((c) => c.open), 1);
  shape.innerHTML = `
    <p class="td-note">Open items only. Counting finished work here would make a cleared cluster
    look like the busiest thing on the page.</p>
    <ul class="td-shape">
      ${d.byCluster.filter((c) => c.total).map((c) => `
        <li>
          <button class="td-shape-name" type="button" data-cluster="${esc(c.cluster)}"
                  title="Filter the list to ${esc(c.cluster)}">${esc(c.cluster || 'unfiled')}</button>
          <span class="td-shape-track">
            <span class="td-shape-you" style="width:${(c.blocked_on_you / maxOpen) * 100}%"></span>
            <span class="td-shape-build" style="width:${(c.build / maxOpen) * 100}%"></span>
          </span>
          <span class="td-shape-val">${c.open}<span class="td-dim"> of ${c.total}</span></span>
        </li>`).join('')}
    </ul>
    <p class="td-legend"><span class="td-key you"></span>waiting on you
      <span class="td-key build"></span>buildable <span class="td-dim">· click a cluster to filter</span></p>

    <h3 class="td-h3">Sitting longest, untouched</h3>
    <ul class="td-stale">
      ${d.stale.map((s) => `<li><b>${esc(s.id)}</b> <span class="td-chip ${priClass(s.priority)}">${esc(s.priority)}</span>
        ${esc(s.title)} <span class="td-dim">${ageText(s.age_days)}</span></li>`).join('')}
    </ul>
    <p class="td-note td-dim">${esc(d.ageBasis)}</p>
  `;
}

// ----------------------------------------------------------------------------- items
function itemHtml(i) {
  const why = String(i.rationale || '');
  const teaser = why.length > 96 ? `${why.slice(0, 96).trimEnd()}…` : why;
  return `
    <li class="td-item ${i.status}${i.isNext ? ' is-next' : ''}${i.isStarted ? ' is-started' : ''}" data-id="${esc(i.id)}">
      <div class="td-row">
        <span class="td-chip ${priClass(i.priority)}">${esc(i.priority)}</span>
        <span class="td-title">${esc(i.title)}</span>
        <span class="td-id">${esc(i.id)}</span>
      </div>
      <div class="td-meta">
        ${ownerChip(i.owner)}
        ${i.cluster ? `<span class="td-chip">${esc(i.cluster)}</span>` : ''}
        ${i.effort && i.effort !== '-' ? `<span class="td-dim">${esc(i.effort)}</span>` : '<span class="td-dim">no estimate</span>'}
        <span class="td-dim">${ageText(i.age_days)}</span>
        ${i.status !== 'open' ? `<span class="td-state ${i.status}">${STATUS_LABEL[i.status]}</span>` : ''}
        ${i.isStarted ? '<span class="td-state in_progress">started</span>' : ''}
        ${i.isNext && i.status === 'open' ? '<span class="td-state next">next up</span>' : ''}
      </div>
      ${why ? `
        <details class="td-why" data-detail="${esc(String(i.id))}">
          <summary><span class="td-teaser">${esc(teaser)}</span></summary>
          <div class="td-why-body"><p class="td-dim">reading…</p></div>
        </details>` : '<p class="td-why-none td-dim">No reasoning recorded for this one.</p>'}
      ${i.noteCount ? `<p class="td-note-count td-dim">${i.noteCount} note${i.noteCount === 1 ? '' : 's'}${i.lastNoteAt ? `, latest ${esc(String(i.lastNoteAt).slice(0, 10))}` : ''} — open the reasoning above to read them</p>` : ''}
      <div class="td-acts">
        ${i.status !== 'in_progress' && i.status !== 'done' ? `<button class="btn td-act" type="button" data-act="status" data-to="in_progress">Start</button>` : ''}
        ${i.status !== 'done' ? `<button class="btn td-act" type="button" data-act="status" data-to="done">Done</button>` : ''}
        ${i.status === 'open' || i.status === 'in_progress' ? `<button class="btn td-act" type="button" data-act="status" data-to="declined">Decline</button>` : ''}
        ${i.status === 'done' || i.status === 'declined' ? `<button class="btn td-act" type="button" data-act="status" data-to="open">Reopen</button>` : ''}
        <select class="td-in td-pri" data-act="priority" title="Re-prioritise">
          ${['P0', 'P1', 'P2', 'P3', 'DECLINE', 'DONE'].map((p) => `<option value="${p}"${p === i.priority ? ' selected' : ''}>${p}</option>`).join('')}
        </select>
        <button class="btn td-act td-focus-btn" type="button" data-act="focus" title="Work on this — the timer records against it">Focus</button>
        <button class="td-note-btn" type="button" data-act="note" title="Add a note">+ note</button>
        <button class="td-del" type="button" data-act="delete" title="Delete — the seed only runs once, so it will not come back">×</button>
      </div>
    </li>`;
}

async function loadItems() {
  if (!root) return;   // may be CALLED after teardown, not only resumed after it
  const el = root.querySelector('#tdList');
  const next = root.querySelector('#tdNext');
  const q = new URLSearchParams({ view });
  for (const k of ['status', 'cluster', 'priority']) if (filters[k]) q.set(k, filters[k]);

  let d;
  try { d = await api(`/items?${q}`); } catch (err) { fail(el, 'the item list', err); fail(next, 'what is actionable now', err); return; }
    if (!root) return;   // the panel was torn down mid-await; root is null now

  root.querySelector('#tdListHead').textContent = VIEWS[view].heading;

  // What is actionable now, straight from the route. Recomputing it here would be a
  // second owner for the same figure, and the two would drift.
  const a = d.actionable;
  next.innerHTML = a && a.state === 'ok'
    ? `<p class="td-note">${esc(VIEWS[view].blurb)}</p>
       ${a.started.length ? `
         <h3 class="td-h3">Already started — finish before starting anything else</h3>
         <ul class="td-next">${a.started.map((i) => `<li><span class="td-chip ${priClass(i.priority)}">${esc(i.priority)}</span>
           <b>${esc(i.id)}</b> ${esc(i.title)}</li>`).join('')}</ul>` : ''}
       <h3 class="td-h3">Top open band: ${esc(a.priority)}</h3>
       <ul class="td-next">${a.items.map((i) => `<li><span class="td-chip ${priClass(i.priority)}">${esc(i.priority)}</span>
         <b>${esc(i.id)}</b> ${esc(i.title)} ${ownerChip(i.owner)}</li>`).join('')}</ul>
       <p class="td-note td-dim">${esc(a.note)}</p>`
    : `<p class="empty-hint">${esc((a && a.note) || 'Nothing open in this view.')}</p>`;

  if (d.state === 'no-match') {
    el.innerHTML = `<p class="empty-hint">${esc(d.message)}</p>`;
    return;
  }

  el.innerHTML = `
    <p class="td-note td-dim">${plural(d.count, 'item')} shown${d.count === d.totalInStore ? '' : ` of ${d.totalInStore} in the store`}.</p>
    <ul class="td-items">${d.items.map(itemHtml).join('')}</ul>`;
}

function renderFilters() {
  if (!root) return;   // called from an async path; the panel may already be torn down
  const el = root.querySelector('#tdFilters');
  const opts = (name, list, cur) => `<select class="td-in td-filter" data-filter="${name}">
      <option value="">all ${esc(name)}</option>
      ${list.map((v) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(v)}</option>`).join('')}
    </select>`;
  el.innerHTML =
    opts('status', ['open', 'in_progress', 'done', 'declined'], filters.status)
    + opts('priority', ['P0', 'P1', 'P2', 'P3', 'DECLINE', 'DONE'], filters.priority)
    + opts('cluster', clusters, filters.cluster)
    + (filters.status || filters.priority || filters.cluster
      ? '<button class="btn td-act" type="button" data-act="clear">Clear filters</button>' : '');
}

// #24, the honest half: where the work actually goes. Counts over the cluster vocabulary
// already written on each item — nothing weighted, nothing scored, no level.
//
// The history line is not decoration. Closures land on two days, so a distribution shown
// alone would invite a trend reading the data cannot support; saying how thin it is beside
// the bars is what stops the chart claiming more than it knows.
async function loadClusters() {
  if (!root) return;
  const host = root.querySelector('#tdClusters');
  if (!host) return;
  let d;
  try {
    const r = await fetch('/api/todo/clusters', { headers: { 'X-MC-By': 'todo-panel' } });
    d = await r.json();
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
  } catch (err) {
    if (!root) return;
    host.innerHTML = `<p class="empty-hint">Could not read the cluster counts: ${esc(err.message)}<br>`
      + '<small>That is a failure to look, not a report that you have done nothing.</small></p>';
    return;
  }
  if (!root) return;

  const max = Math.max(...d.clusters.map((c) => c.done), 1);
  host.innerHTML = `
    <h2 class="td-h2">Where the work goes</h2>
    <p class="td-note">${esc(d.note)}</p>
    <ul class="td-clusters">${d.clusters.filter((c) => c.done || c.open).map((c) => `
      <li class="td-cl">
        <span class="td-cl-name">${esc(c.cluster)}</span>
        <span class="td-cl-bar"><span class="td-cl-fill" style="width:${Math.round(100 * c.done / max)}%"></span></span>
        <span class="td-cl-n">${c.done} done</span>
        <span class="td-cl-open">${c.open ? `${c.open} open` : ''}</span>
      </li>`).join('')}</ul>
    ${d.historyNote ? `<p class="td-caveat">${esc(d.historyNote)}</p>` : ''}`;
}

async function load() {
  await loadSummary();     // first — it supplies the cluster list the filters need
  renderFilters();
  await loadItems();
  loadClusters();
}

async function reloadAll() {
  await load();
  // A host may be holding one of these ids. Closing an item elsewhere in this panel must
  // not leave the timer pointed at something that is done.
  if (root) root.dispatchEvent(new CustomEvent('td:changed', { bubbles: true }));
}

// ---------------------------------------------------------------------------- events
// Delegated, so there is exactly one listener per event type to remove on unmount and
// nothing to rebind after a render.
async function handleClick(ev) {
  if (!root) return;   // may be CALLED after teardown, not only resumed after it
  const shapeBtn = ev.target.closest('.td-shape-name');
  if (shapeBtn) {
    filters.cluster = filters.cluster === shapeBtn.dataset.cluster ? '' : shapeBtn.dataset.cluster;
    renderFilters();
    await loadItems();
    if (!root) return;   // the panel was torn down mid-await; root is null now
    return;
  }

  const tab = ev.target.closest('.mode-tab');
  if (tab) {
    view = tab.dataset.view;
    root.querySelectorAll('.mode-tab').forEach((t) => t.classList.toggle('active', t === tab));
    await loadItems();
    if (!root) return;   // the panel was torn down mid-await; root is null now
    return;
  }

  const act = ev.target.closest('[data-act]');
  if (!act || act.tagName === 'SELECT') return;
  const li = act.closest('.td-item');

  // 'focus' is the one action that writes nothing. It tells the host — Focus, when this
  // panel is embedded there — which item the timer should record against. Announced as a
  // bubbling event rather than called directly, so this panel keeps knowing nothing about
  // the timer and still works standalone, where nothing is listening.
  if (act.dataset.act === 'focus') {
    root.dispatchEvent(new CustomEvent('td:focus', {
      bubbles: true,
      detail: { id: li.dataset.id, title: li.querySelector('.td-title')?.textContent || '' },
    }));
    return;
  }

  try {
    if (act.dataset.act === 'clear') {
      filters = { status: '', cluster: '', priority: '' };
      renderFilters();
      await loadItems();
      if (!root) return;   // the panel was torn down mid-await; root is null now
      return;
    }
    if (!li) return;
    const id = li.dataset.id;

    if (act.dataset.act === 'status') {
      await api(`/items/${encodeURIComponent(id)}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json', 'x-mc-by': 'you' },
        body: JSON.stringify({ status: act.dataset.to }),
      });
      await reloadAll();
      if (!root) return;   // the panel was torn down mid-await; root is null now
    } else if (act.dataset.act === 'note') {
      // eslint-disable-next-line no-alert
      const note = window.prompt(`Note on ${id}:`);
      if (!note || !note.trim()) return;
      await api(`/items/${encodeURIComponent(id)}/notes`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-mc-by': 'you' },
        body: JSON.stringify({ note }),
      });
      await loadItems();
      if (!root) return;   // the panel was torn down mid-await; root is null now
    } else if (act.dataset.act === 'delete') {
      // eslint-disable-next-line no-alert
      if (!window.confirm(`Delete ${id}? The seed runs once, so it will not come back — declining keeps the row and its reasoning.`)) return;
      await api(`/items/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!root) return;   // the panel was torn down mid-await; root is null now
      await reloadAll();
      if (!root) return;   // the panel was torn down mid-await; root is null now
    }
  } catch (err) {
    if (!root) return;   // the panel was torn down mid-await; root is null now
    fail(root.querySelector('#tdList'), 'the change you just made', err);
  }
}

async function handleChange(ev) {
  if (!root) return;   // may be CALLED after teardown, not only resumed after it
  const f = ev.target.closest('.td-filter');
  if (f) {
    filters[f.dataset.filter] = f.value;
    // Re-rendered rather than left alone, so the "Clear filters" button appears the
    // moment a filter is set. Without it you can filter yourself into an empty list
    // through the selects and have no way back that looks like one.
    renderFilters();
    await loadItems();
    if (!root) return;   // the panel was torn down mid-await; root is null now
    return;
  }
  const p = ev.target.closest('.td-pri');
  if (!p) return;
  const li = p.closest('.td-item');
  try {
    await api(`/items/${encodeURIComponent(li.dataset.id)}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json', 'x-mc-by': 'you' },
      body: JSON.stringify({ priority: p.value }),
    });
    await reloadAll();
    if (!root) return;   // the panel was torn down mid-await; root is null now
  } catch (err) {
    if (!root) return;   // the panel was torn down mid-await; root is null now
    fail(root.querySelector('#tdList'), 'the priority change', err);
  }
}

async function handleSubmit(ev) {
  if (!root) return;   // may be CALLED after teardown, not only resumed after it
  if (!ev.target.closest('#tdAdd')) return;
  ev.preventDefault();
  const val = (sel) => root.querySelector(sel).value.trim();
  const title = val('#tdTitle');
  if (!title) return;
  try {
    await api('/items', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-mc-by': 'you' },
      body: JSON.stringify({
        title,
        rationale: val('#tdRationale') || null,
        cluster: val('#tdCluster') || null,
        priority: root.querySelector('#tdPriority').value,
        owner: root.querySelector('#tdOwner').value,
        effort: val('#tdEffort') || null,
      }),
    });
    ['#tdTitle', '#tdRationale', '#tdCluster', '#tdEffort'].forEach((s) => { root.querySelector(s).value = ''; });
    await reloadAll();
    if (!root) return;   // the panel was torn down mid-await; root is null now
  } catch (err) {
    if (!root) return;   // the panel was torn down mid-await; root is null now
    fail(root.querySelector('#tdList'), 'the new item', err);
  }
}

// The full rationale and the notes are fetched WHEN THE READER OPENS ONE, not with the
// list. Measured 18 Aug: sending them with every item made this endpoint 335 KB for 148
// items, 84% of it text that is collapsed or below the fold. It is now 76 KB.
//
// Bound on the toggle event, which fires for <details> and does not bubble — hence
// capture. Once filled, an item is not re-fetched: `filled` is checked before asking.
const filled = new Set();
async function openDetail(ev) {
  const d = ev.target;
  if (!d || d.tagName !== 'DETAILS' || !d.open || !d.dataset.detail) return;
  const id = d.dataset.detail;
  const body = d.querySelector('.td-why-body');
  if (!body || filled.has(id)) return;
  filled.add(id);
  try {
    const full = await api(`/items/${encodeURIComponent(id)}/detail`);
    if (!body.isConnected) return;   // closed and re-rendered while the fetch was in flight
    const notes = (full.notes || []).map((n) => `<li${n.superseded_by ? ' class="td-note-old"' : ''}>`
      + `${n.superseded_by ? '<span class="td-note-flag">superseded by the later note</span> ' : ''}`
      + `${esc(n.note)} <span class="td-dim">${esc(n.created_at)}</span></li>`).join('');
    body.innerHTML = `<p class="td-why-text">${esc(full.rationaleFull || '')}</p>`
      + '<p class="td-why-label">Editorial judgement, written when the item was triaged — not a score.</p>'
      + (notes ? `<ul class="td-notes">${notes}</ul>` : '');
  } catch (err) {
    filled.delete(id);   // a failed read must be retryable, not permanent
    if (body.isConnected) {
      body.innerHTML = '<p class="td-why-none td-dim">Could not read the full reasoning. '
        + 'That is a failure to look, not an item without reasoning.</p>';
    }
  }
}


export default {
  // opts.embedded: rendered inside another panel (Focus), so drop the outer page chrome.
  // The shell calls mount(root) with one argument, so standalone stays the default and
  // this panel still works on its own if it is ever put back in the nav.
  mount(el, opts) {
    root = el;
    embedded = !!(opts && opts.embedded);
    view = 'mine';
    filters = { status: '', cluster: '', priority: '' };
    ac = new AbortController();
    el.innerHTML = TEMPLATE;

    if (embedded) {
      const p = el.querySelector('.td-panel');
      p.classList.remove('panel', 'panel-wide');
      const h1 = p.querySelector('.panel-header h1');
      if (h1) {
        const h2 = document.createElement('h2');
        h2.textContent = h1.textContent;
        h1.replaceWith(h2);
      }
    }

    onClick = handleClick;
    onChange = handleChange;
    onSubmit = handleSubmit;
    el.addEventListener('click', onClick);
    el.addEventListener('change', onChange);
    el.addEventListener('submit', onSubmit);
    // CAPTURE: the toggle event fires on <details> and does NOT bubble, so a listener on
    // the panel root never sees it without this.
    el.addEventListener('toggle', openDetail, true);

    load();
  },

  // No polling here — a backlog does not change unless you change it, and a timer would
  // be a surface to feed. What does need cleaning up is any fetch still in flight: it
  // would resolve after the tab switched and write into a DOM that no longer exists.
  unmount() {
    if (ac) ac.abort();
    ac = null;
    if (root) {
      if (onClick) root.removeEventListener('click', onClick);
      if (onChange) root.removeEventListener('change', onChange);
      if (onSubmit) root.removeEventListener('submit', onSubmit);
      root.removeEventListener('toggle', openDetail, true);
    }
    onClick = onChange = onSubmit = null;
    root = null;
  },
};

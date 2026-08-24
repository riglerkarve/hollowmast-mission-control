// focus-tasks — the owner's real actionable tasks, always in front of him.
//
// Owner's direct quote, 24 Aug: tasks must show clearly on the dashboard "in front of
// him" so he can't forget them, and be clickable -- clicking one opens a detail view
// with title, elapsed time, priority, and the full body text formatted so a copy-
// pasteable prompt inside it is easy to select as one block.
//
// This is a NEW panel (t_3ab3bfae), not a redesign of the naming/rebrand decision
// pending in t_9ccb2bb5 -- plain functional panel, relabel later at zero cost.
//
// NOTHING HERE COMPUTES ELAPSED TIME OR ORDERING OF ITS OWN. /api/open-tasks does
// that (reusing M131's stuck-longest, oldest-first rule) and this panel renders what
// it returns, the same shape as digest.js/team-digest.js already follow for exactly
// this reason: a panel that recomputed the ordering would agree with the route until
// one of them was edited, then disagree without either erroring.
let root = null;
let loadToken = 0;
let tasksById = new Map();

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

function priorityLabel(p) {
  if (p == null) return null;
  const n = Number(p);
  if (Number.isFinite(n)) return n === 0 ? null : `priority ${n}`;
  return String(p);
}

function taskRow(t) {
  const elapsed = t.elapsedLabel || 'unknown';
  const pri = priorityLabel(t.priority);
  return `<li class="ft-row" data-id="${esc(t.id)}" tabindex="0" role="button" aria-haspopup="dialog">
    <div class="ft-row-main">
      <span class="ft-status ft-status-${esc(t.status)}">${esc(t.status)}</span>
      <span class="ft-title">${esc(t.title)}</span>
    </div>
    <div class="ft-row-meta">
      <span class="ft-assignee">${esc(t.assignee)}</span>
      <span class="ft-elapsed">open ${esc(elapsed)}</span>
      ${pri ? `<span class="ft-priority">${esc(pri)}</span>` : ''}
    </div>
  </li>`;
}

function render(data) {
  if (!root) return;
  const tasks = data.tasks || [];
  tasksById = new Map(tasks.map((t) => [String(t.id), t]));

  const body = tasks.length
    ? `<ul class="ft-list">${tasks.map(taskRow).join('')}</ul>`
    : `<p class="ft-empty">Nothing running or ready right now. This is a quiet board, not a failure to look.</p>`;

  root.innerHTML = `
    <div class="panel panel-wide focus-tasks-panel">
      <div class="panel-header">
        <h1>Focus tasks</h1>
      </div>
      <p class="ft-lede">Ready and running work, oldest-waiting first. Click a task for the full brief.</p>
      <section class="card">
        ${body}
      </section>
    </div>

    <div class="ft-modal-overlay" id="ftModalOverlay">
      <div class="ft-modal" role="dialog" aria-modal="true" aria-labelledby="ftModalTitle">
        <button class="ft-modal-close" id="ftModalClose" aria-label="Close">&times;</button>
        <h2 id="ftModalTitle"></h2>
        <div class="ft-modal-meta" id="ftModalMeta"></div>
        <div class="ft-modal-body-wrap">
          <div class="ft-modal-body-head">
            <span>Full task body</span>
            <button class="btn ft-copy-btn" id="ftCopyBtn">Copy</button>
          </div>
          <pre class="ft-modal-body" id="ftModalBody"></pre>
        </div>
      </div>
    </div>`;

  const list = root.querySelector('.ft-list');
  if (list) {
    list.addEventListener('click', onRowActivate);
    list.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        onRowActivate(ev);
      }
    });
  }

  const overlay = root.querySelector('#ftModalOverlay');
  const closeBtn = root.querySelector('#ftModalClose');
  if (closeBtn) closeBtn.addEventListener('click', closeModal);
  if (overlay) overlay.addEventListener('click', (ev) => { if (ev.target === overlay) closeModal(); });
  document.addEventListener('keydown', onEscKey);

  const copyBtn = root.querySelector('#ftCopyBtn');
  if (copyBtn) copyBtn.addEventListener('click', onCopyClick);
}

function onRowActivate(ev) {
  const row = ev.target.closest && ev.target.closest('.ft-row');
  if (!row) return;
  openModal(row.dataset.id);
}

function onEscKey(ev) {
  if (ev.key === 'Escape') closeModal();
}

function openModal(id) {
  const t = tasksById.get(String(id));
  if (!t || !root) return;
  const overlay = root.querySelector('#ftModalOverlay');
  const titleEl = root.querySelector('#ftModalTitle');
  const metaEl = root.querySelector('#ftModalMeta');
  const bodyEl = root.querySelector('#ftModalBody');
  if (!overlay || !titleEl || !metaEl || !bodyEl) return;

  titleEl.textContent = t.title;
  const pri = priorityLabel(t.priority);
  const metaParts = [
    `Assignee: ${t.assignee}`,
    `Status: ${t.status}`,
    `Open: ${t.elapsedLabel || 'unknown'}`,
  ];
  if (pri) metaParts.push(pri.charAt(0).toUpperCase() + pri.slice(1));
  metaEl.innerHTML = metaParts.map((p) => `<span class="ft-modal-meta-item">${esc(p)}</span>`).join('');
  // Verbatim, not re-formatted -- a Suno prompt or checklist inside the body must stay
  // selectable as one exact block, so this is textContent into a <pre>, never innerHTML.
  bodyEl.textContent = t.body || '(no body text)';

  overlay.classList.add('show');
}

function closeModal() {
  if (!root) return;
  const overlay = root.querySelector('#ftModalOverlay');
  if (overlay) overlay.classList.remove('show');
}

async function onCopyClick() {
  if (!root) return;
  const bodyEl = root.querySelector('#ftModalBody');
  const btn = root.querySelector('#ftCopyBtn');
  if (!bodyEl) return;
  try {
    await navigator.clipboard.writeText(bodyEl.textContent || '');
    if (btn) { btn.textContent = 'Copied'; setTimeout(() => { if (btn) btn.textContent = 'Copy'; }, 1500); }
  } catch {
    if (btn) { btn.textContent = 'Select the text above'; setTimeout(() => { if (btn) btn.textContent = 'Copy'; }, 2000); }
  }
}

async function load() {
  if (!root) return;
  const token = loadToken;
  try {
    const r = await fetch('/api/open-tasks');
    if (!root || token !== loadToken) return;
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      root.innerHTML = `<div class="panel"><div class="panel-header"><h1>Focus tasks</h1></div>
        <p class="failure-hint">Could not load tasks (HTTP ${r.status}${err.reason ? `, ${esc(err.reason)}` : ''}). This is a failure to look, not an empty board.</p></div>`;
      return;
    }
    const data = await r.json();
    if (!root || token !== loadToken) return;
    render(data);
  } catch (e) {
    if (!root || token !== loadToken) return;
    root.innerHTML = `<div class="panel"><div class="panel-header"><h1>Focus tasks</h1></div>
      <p class="failure-hint">Could not reach the server: ${esc(e.message)}.</p></div>`;
  }
}

export default {
  mount(el, opts) {
    root = el;
    loadToken++;
    load();
  },
  unmount() {
    loadToken++;
    document.removeEventListener('keydown', onEscKey);
    root = null;
    tasksById = new Map();
  },
};

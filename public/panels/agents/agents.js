//
// agents — the Hermes profile roster: who is registered, whether they are running/ready/
// blocked on a task right now, and what it is. Click a row for the full task body.
//
// ONE FETCH, ONE LIST. The route returns every profile with a status field derived straight
// from the kanban board (`hermes kanban list --status <x>`). This panel sorts them (running
// first, then blocked, then ready, then idle) and renders one card per profile. It does not
// derive status, infer it from a session heartbeat, or second-guess the route — a panel
// that recomputed "is this profile running" would agree with the route until one was
// edited, and then disagree without either erroring, the exact failure this project keeps
// meeting.
//
// INTERACTIVE LIVE VIEW (24 Aug 2026, t_137df3fc), owner's explicit ask: "make this panel
// show an interactive view of the agents and what they're working on." Clicking an agent
// card with a current task opens a detail modal with the full task body — same modal
// pattern as t_3ab3bfae's Focus panel (focus-tasks.js: overlay + dialog + copy button),
// reused rather than reinvented per that task's own instruction. The list also now
// auto-refreshes on an interval so it stays a live view without a page reload; a manual
// refresh button covers the moment right after you expect a status to have changed.
//
// REBUILT 23 Aug 2026 (t_e0d4f4cb) alongside server/routes/agents.js. The old shape was
// {name, role, engine, model, owns, status: active|available|idle, lastSeen}. The shape
// since is {name, model, status: running|ready|blocked|idle, currentTask, lastHeartbeat,
// lastSeen, doneCount} — there is no `role`/`owns`/`engine` any more because the Hermes
// profile roster does not carry that TEAM.md-role concept; see agents.js (server route)
// header comment for why the two rosters are not merged here.
import { renderLede } from '/panels/lede/lede.js';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

let root = null;
let state = null;
let refreshTimer = null;
let loadToken = 0;
let agentsByName = new Map();

const REFRESH_MS = 20000; // live view, not a page-load snapshot

const STATUS_ORDER = { running: 0, blocked: 1, ready: 2, idle: 3 };

function sortAgents(agents) {
  return agents.slice().sort((a, b) => {
    const sa = STATUS_ORDER[a.status] ?? 4;
    const sb = STATUS_ORDER[b.status] ?? 4;
    if (sa !== sb) return sa - sb;
    return String(a.name || '').localeCompare(String(b.name || ''));
  });
}

function relTime(iso) {
  if (!iso) return 'never';
  const then = new Date(iso);
  if (isNaN(then.getTime())) return 'unknown';
  const now = Date.now();
  const diff = now - then.getTime();
  if (diff < 0) return 'just now';
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return then.toISOString().slice(0, 10);
}

// Existing CSS only — the stylesheet is Codex's (AGENTS.md §4b). `running` maps onto the
// accent rule that used to mean `active`. `blocked`/`ready` are new statuses this rebuild
// adds classes for; ag-st-blocked and ag-st-ready are new rules alongside the existing
// ag-st-active/ag-st-idle in agents.css, not a replacement of them.
function statusClass(s) {
  if (s === 'running') return 'ag-st-active';
  if (s === 'blocked') return 'ag-st-blocked';
  if (s === 'ready') return 'ag-st-ready';
  return 'ag-st-idle';
}

function priorityLabel(p) {
  if (p == null) return null;
  const n = Number(p);
  if (Number.isFinite(n)) return n === 0 ? null : `priority ${n}`;
  return String(p);
}

function cardHTML(a) {
  const stCls = statusClass(a.status);
  const stLabel = esc(a.status || 'idle');
  const model = a.model ? `<span class="ag-model">${esc(a.model)}</span>` : '';
  const doneCount = `<span class="ag-model">done: ${esc(a.doneCount ?? 0)}</span>`;
  const lastSeen = a.lastSeen
    ? `<span class="ag-seen">${esc(relTime(a.lastSeen))}</span>`
    : '<span class="ag-seen ag-seen-none">never seen</span>';

  const t = a.currentTask;
  const clickable = !!t;
  const task = t
    ? `<p class="ag-owns"><span class="ag-field-label">${esc(t.status === 'ready' ? 'Waiting' : t.status === 'blocked' ? 'Blocked on' : 'Task')}</span> ${esc(t.title)}
        <span class="ag-role">${esc(t.id)}</span></p>
      <p class="ag-owns ag-owns-elapsed"><span class="ag-field-label">${esc(t.status === 'ready' ? 'Waiting' : 'On it')}</span> ${esc(t.elapsedLabel || 'unknown')}</p>`
    : '';
  const heartbeat = a.status === 'running'
    ? `<p class="ag-owns"><span class="ag-field-label">Last heartbeat</span> ${esc(relTime(a.lastHeartbeat))}</p>`
    : '';
  const hint = clickable ? '<p class="ag-click-hint">Click for full task detail</p>' : '';

  return `<article class="ag-card ${stCls}${clickable ? ' ag-clickable' : ''}"
      ${clickable ? `data-task-id="${esc(t.id)}" tabindex="0" role="button" aria-haspopup="dialog"` : ''}>
    <div class="ag-head">
      <h3 class="ag-name">${esc(a.name || 'unnamed')}</h3>
      <span class="ag-status">${stLabel}</span>
    </div>
    <div class="ag-meta">
      ${model}
      ${doneCount}
      ${lastSeen}
    </div>
    ${task}
    ${heartbeat}
    ${hint}
  </article>`;
}

function residueNote(residue) {
  if (!residue) return '';
  const failed = [];
  if (residue.running_list_ok === false) failed.push('the running-task list');
  if (residue.ready_list_ok === false) failed.push('the ready-task list');
  if (residue.blocked_list_ok === false) failed.push('the blocked-task list');
  if (residue.done_list_ok === false) failed.push('the done-task list');
  if (residue.heartbeats_ok === false) failed.push('one or more task heartbeats');
  if (!failed.length) return '';
  if (failed.length === 1) {
    return `<p class="ag-alarm">Could not read ${esc(failed[0])} from the kanban board —
      status below may be incomplete, not wrong.</p>`;
  }
  return `<div class="ag-alarm"><b>Could not read from the kanban board</b>
    <ul class="ag-alarm-list">${failed.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>
    <span>Status below may be incomplete, not wrong.</span></div>`;
}

function render() {
  if (!root || !state) return;

  if (state.error) {
    root.innerHTML = `<section class="panel ag-panel">
      <h1>Agents</h1>
      <p class="ag-alarm">Could not read agents — ${esc(state.error)}.
      That is a failure to look, not an empty roster.</p>
    </section>`;
    return;
  }

  if (!state.data) {
    root.innerHTML = `<section class="panel ag-panel"><h1>Agents</h1>
      <p class="ag-loading">Reading the roster…</p></section>`;
    return;
  }

  const agents = sortAgents(state.data.agents || []);
  agentsByName = new Map(agents.map((a) => [a.name, a]));

  const listHTML = agents.length
    ? agents.map(cardHTML).join('')
    : '<p class="ag-empty">No agents registered.</p>';

  root.innerHTML = `<section class="panel ag-panel">
    <div class="ag-header-row">
      <h1>Agents</h1>
      <button type="button" class="btn ag-refresh-btn" id="agRefreshBtn">Refresh</button>
    </div>
    <p class="ag-lede">The Hermes profile roster — every profile, and whether it is running,
      blocked, or waiting on a kanban task right now. Working profiles are surfaced first so
      you can see who is actually doing something at a glance. Click a card for the full
      task. Source: the kanban board, not a session heartbeat. Refreshes automatically.</p>
    ${residueNote(state.data.residue)}
    <h2 class="ag-h2">Roster <span class="ag-n">${agents.length}</span></h2>
    ${listHTML}
  </section>

  <div class="ft-modal-overlay" id="agModalOverlay">
    <div class="ft-modal" role="dialog" aria-modal="true" aria-labelledby="agModalTitle">
      <button class="ft-modal-close" id="agModalClose" aria-label="Close">&times;</button>
      <h2 id="agModalTitle"></h2>
      <div class="ft-modal-meta" id="agModalMeta"></div>
      <div class="ft-modal-body-wrap">
        <div class="ft-modal-body-head">
          <span>Full task body</span>
          <button class="btn ft-copy-btn" id="agCopyBtn">Copy</button>
        </div>
        <pre class="ft-modal-body" id="agModalBody"></pre>
      </div>
    </div>
  </div>`;

  const cards = root.querySelectorAll('.ag-card.ag-clickable');
  cards.forEach((card) => {
    card.addEventListener('click', onCardActivate);
    card.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); onCardActivate(ev); }
    });
  });

  const refreshBtn = root.querySelector('#agRefreshBtn');
  if (refreshBtn) refreshBtn.addEventListener('click', () => load());

  const overlay = root.querySelector('#agModalOverlay');
  const closeBtn = root.querySelector('#agModalClose');
  if (closeBtn) closeBtn.addEventListener('click', closeModal);
  if (overlay) overlay.addEventListener('click', (ev) => { if (ev.target === overlay) closeModal(); });
  document.addEventListener('keydown', onEscKey);

  const copyBtn = root.querySelector('#agCopyBtn');
  if (copyBtn) copyBtn.addEventListener('click', onCopyClick);
}

function onCardActivate(ev) {
  const card = ev.currentTarget;
  if (!card) return;
  openModal(card.dataset.taskId);
}

function onEscKey(ev) {
  if (ev.key === 'Escape') closeModal();
}

function findTaskById(id) {
  for (const a of agentsByName.values()) {
    if (a.currentTask && String(a.currentTask.id) === String(id)) return { agent: a, task: a.currentTask };
  }
  return null;
}

function openModal(id) {
  const found = findTaskById(id);
  if (!found || !root) return;
  const { agent, task } = found;
  const overlay = root.querySelector('#agModalOverlay');
  const titleEl = root.querySelector('#agModalTitle');
  const metaEl = root.querySelector('#agModalMeta');
  const bodyEl = root.querySelector('#agModalBody');
  if (!overlay || !titleEl || !metaEl || !bodyEl) return;

  titleEl.textContent = task.title;
  const pri = priorityLabel(task.priority);
  const metaParts = [
    `Agent: ${agent.name}`,
    `Status: ${task.status}`,
    task.status === 'ready' ? `Waiting: ${task.elapsedLabel || 'unknown'}` : `On it: ${task.elapsedLabel || 'unknown'}`,
  ];
  if (pri) metaParts.push(pri.charAt(0).toUpperCase() + pri.slice(1));
  metaEl.innerHTML = metaParts.map((p) => `<span class="ft-modal-meta-item">${esc(p)}</span>`).join('');
  // Verbatim, not re-formatted — a prompt or checklist inside the body must stay
  // selectable as one exact block, so this is textContent into a <pre>, never innerHTML.
  bodyEl.textContent = task.body || '(no body text)';

  overlay.classList.add('show');
}

function closeModal() {
  if (!root) return;
  const overlay = root.querySelector('#agModalOverlay');
  if (overlay) overlay.classList.remove('show');
}

async function onCopyClick() {
  if (!root) return;
  const bodyEl = root.querySelector('#agModalBody');
  const btn = root.querySelector('#agCopyBtn');
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
    const r = await fetch('/api/agents');
    if (!root || token !== loadToken) return;
    const body = await r.json();
    if (!r.ok) {
      state.data = null;
      state.error = body.error || `HTTP ${r.status}`;
    } else {
      state.data = body;
      state.error = null;
    }
  } catch (e) {
    if (!root || token !== loadToken) return;
    state.data = null;
    state.error = e.message;
  }
  render();
}

export default {
  mount(el, opts) {
    root = el;
    loadToken++;
    state = { data: null, error: null };
    render();
    load();
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(load, REFRESH_MS);
    renderLede('agents', el);
  },
  unmount() {
    loadToken++;
    if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
    document.removeEventListener('keydown', onEscKey);
    root = null;
    state = null;
    agentsByName = new Map();
  },
};

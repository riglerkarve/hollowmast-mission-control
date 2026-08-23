//
// agents — the Hermes profile roster: who is registered, whether they are running a task
// right now, and what it is.
//
// ONE FETCH, ONE LIST. The route returns every profile with a status field derived straight
// from the kanban board (`hermes kanban list --status running`). This panel sorts them
// (running first) and renders one card per profile. It does not derive status, infer it
// from a session heartbeat, or second-guess the route — a panel that recomputed "is this
// profile running" would agree with the route until one was edited, and then disagree
// without either erroring, the exact failure this project keeps meeting.
//
// REBUILT 23 Aug 2026 (t_e0d4f4cb) alongside server/routes/agents.js. The old shape was
// {name, role, engine, model, owns, status: active|available|idle, lastSeen}. The new shape
// is {name, model, status: running|idle, currentTask, lastHeartbeat, lastSeen, doneCount} —
// there is no `role`/`owns`/`engine` any more because the Hermes profile roster does not
// carry that TEAM.md-role concept; see agents.js's header comment for why the two rosters
// are not merged here.
import { renderLede } from '/panels/lede/lede.js';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

let root = null;
let state = null;

const STATUS_ORDER = { running: 0, idle: 1 };

function sortAgents(agents) {
  return agents.slice().sort((a, b) => {
    const sa = STATUS_ORDER[a.status] ?? 2;
    const sb = STATUS_ORDER[b.status] ?? 2;
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

// Existing CSS only — the stylesheet is Codex's (AGENTS.md §4b) and this rebuild does not
// touch it. `running` maps onto the accent rule that used to mean `active`; there is no
// styled `available` state left to reuse, so the previous green rule is simply unused now.
// Filed as a hotspot below for Codex to pick up rather than editing agents.css here.
function statusClass(s) {
  return s === 'running' ? 'ag-st-active' : 'ag-st-idle';
}

function cardHTML(a) {
  const stCls = statusClass(a.status);
  const stLabel = esc(a.status || 'idle');
  const model = a.model ? `<span class="ag-model">${esc(a.model)}</span>` : '';
  const doneCount = `<span class="ag-model">done: ${esc(a.doneCount ?? 0)}</span>`;
  const lastSeen = a.lastSeen
    ? `<span class="ag-seen">${esc(relTime(a.lastSeen))}</span>`
    : '<span class="ag-seen ag-seen-none">never seen</span>';

  const task = a.currentTask
    ? `<p class="ag-owns"><span class="ag-field-label">Task</span> ${esc(a.currentTask.title)}
        <span class="ag-role">${esc(a.currentTask.id)}</span></p>`
    : '';
  const heartbeat = a.status === 'running'
    ? `<p class="ag-owns"><span class="ag-field-label">Last heartbeat</span> ${esc(relTime(a.lastHeartbeat))}</p>`
    : '';

  return `<article class="ag-card ${stCls}">
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
  </article>`;
}

function residueNote(residue) {
  if (!residue) return '';
  const failed = [];
  if (residue.running_list_ok === false) failed.push('the running-task list');
  if (residue.done_list_ok === false) failed.push('the done-task list');
  if (residue.heartbeats_ok === false) failed.push('one or more task heartbeats');
  if (!failed.length) return '';
  return `<p class="ag-alarm">Could not read ${esc(failed.join(', '))} from the kanban board —
    status below may be incomplete, not wrong.</p>`;
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

  const listHTML = agents.length
    ? agents.map(cardHTML).join('')
    : '<p class="ag-empty">No agents registered.</p>';

  root.innerHTML = `<section class="panel ag-panel">
    <h1>Agents</h1>
    <p class="ag-lede">The Hermes profile roster — every profile, and whether it is running a
      kanban task right now. Running profiles are surfaced first so you can see who is
      actually working at a glance. Source: the kanban board, not a session heartbeat.</p>
    ${residueNote(state.data.residue)}
    <h2 class="ag-h2">Roster <span class="ag-n">${agents.length}</span></h2>
    ${listHTML}
  </section>`;
}

async function load() {
  try {
    const r = await fetch('/api/agents');
    const body = await r.json();
    if (!r.ok) {
      state.data = null;
      state.error = body.error || `HTTP ${r.status}`;
    } else {
      state.data = body;
      state.error = null;
    }
  } catch (e) {
    state.data = null;
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
    renderLede('agents', el);
  },
  unmount() { root = null; state = null; },
};

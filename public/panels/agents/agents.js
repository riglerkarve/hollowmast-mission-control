//
// agents — the team roster: who is registered, what they own, and whether they
// are active, idle, or available right now.
//
// ONE FETCH, ONE LIST. The route returns every agent with a status field. This
// panel sorts them (active first, then available, then idle) and renders one
// card per agent. It does not derive status, infer it from lastSeen, or
// second-guess the route — a panel that recomputed "is this agent active"
// would agree with the route until one was edited, and then disagree without
// either erroring, the exact failure this project keeps meeting.
import { renderLede } from '/panels/lede/lede.js';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Agent names and roles are escaped, not parsed. A half-implemented markdown
// renderer that swallows a `**` is worse than plain text, because it silently
// changes what was recorded.
const prose = (s) => esc(s).replace(/\n{2,}/g, '</p><p>').replace(/\n/g, '<br>');

let root = null;
let state = null;

const STATUS_ORDER = { active: 0, available: 1, idle: 2 };

function sortAgents(agents) {
  return agents.slice().sort((a, b) => {
    const sa = STATUS_ORDER[a.status] ?? 3;
    const sb = STATUS_ORDER[b.status] ?? 3;
    if (sa !== sb) return sa - sb;
    // Within the same status, sort by name so the list is stable.
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

function statusClass(s) {
  if (s === 'active') return 'ag-st-active';
  if (s === 'available') return 'ag-st-available';
  return 'ag-st-idle';
}

function cardHTML(a) {
  const stCls = statusClass(a.status);
  const stLabel = esc(a.status || 'idle');
  const role = a.role ? `<span class="ag-role">${esc(a.role)}</span>` : '';
  const engine = a.engine ? `<span class="ag-engine">${esc(a.engine)}</span>` : '';
  const model = a.model ? `<span class="ag-model">${esc(a.model)}</span>` : '';
  const owns = a.owns ? `<p class="ag-owns"><span class="ag-field-label">Owns</span> ${prose(a.owns)}</p>` : '';
  const lastSeen = a.lastSeen
    ? `<span class="ag-seen">${esc(relTime(a.lastSeen))}</span>`
    : '<span class="ag-seen ag-seen-none">never seen</span>';

  return `<article class="ag-card ${stCls}">
    <div class="ag-head">
      <h3 class="ag-name">${esc(a.name || 'unnamed')}</h3>
      ${role}
      <span class="ag-status">${stLabel}</span>
    </div>
    <div class="ag-meta">
      ${engine}
      ${model}
      ${lastSeen}
    </div>
    ${owns}
  </article>`;
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
    <p class="ag-lede">The team roster — every registered agent, what they own, and
      whether they are active, available, or idle right now. Active agents are
      surfaced first so you can see who is working at a glance.</p>
    <h2 class="ag-h2">Roster <span class="ag-n">${agents.length}</span></h2>
    ${listHTML}
  </section>`;
}

async function load() {
  try {
    state.data = await (await fetch('/api/agents')).json();
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
    renderLede('agents', el);
  },
  unmount() { root = null; state = null; },
};
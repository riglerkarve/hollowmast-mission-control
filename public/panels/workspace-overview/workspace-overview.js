//
// workspace-overview — all projects at a glance, dashboard health, and venture momentum.
//
// THREE SECTIONS, TWO FETCHES.
//   'Projects' — one card per project from the board data, showing open bugs (accent if >0),
//   open requests, backlog count, and status from ventures data if available. Sorted by
//   open items descending so the loudest project is first.
//   'Dashboard health' — compact summary from /api/health-check: X of Y panels healthy, Z
//   broken, with the broken panel names listed. A panel that is down is not the same as a
//   panel that is empty; this section says which is which.
//   'Ventures momentum' — compact list from /api/ventures with momentum indicator and days
//   since activity, so the owner can see at a glance what is moving and what is parked.
//
// NOTHING HERE DERIVES ANYTHING. Project counts come from /api/board, venture status from
// /api/ventures, and panel health from /api/health-check. The panel joins them by name; it
// does not recompute any of them.
import { renderLede } from '/panels/lede/lede.js';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

let root = null;
let state = null;

// ---- data shaping -----------------------------------------------------------

// Join board projects to ventures by name (case-insensitive) so each card can show
// momentum/status if the venture data has it. Returns a map from lowercased name → venture.
function ventureMap(ventures) {
  const m = {};
  for (const v of (ventures || [])) m[String(v.name).toLowerCase()] = v;
  return m;
}

// Open items = bugs + requests. This is the sort key: the project with the most open work
// is the first card. If two tie, backlog breaks the tie so the project with the larger
// backlog (more known unknowns) sorts first.
function openItems(p) {
  return (p.bugs || 0) + (p.requests || 0);
}

function sortProjects(projects) {
  return (projects || []).slice().sort((a, b) => {
    const oa = openItems(a), ob = openItems(b);
    if (ob !== oa) return ob - oa;
    return (b.backlog || 0) - (a.backlog || 0);
  });
}

// ---- section 1: projects ---------------------------------------------------

function projectCardHTML(p, vmap) {
  const v = vmap[String(p.project).toLowerCase()];
  const bugs = p.bugs || 0;
  const requests = p.requests || 0;
  const backlog = p.backlog || 0;
  const total = bugs + requests;

  const bugsClass = bugs > 0 ? ' wo-num wo-num-accent' : ' wo-num';
  const reqClass = ' wo-num';
  const backClass = ' wo-num wo-num-muted';

  const momentum = v && v.momentum
    ? `<span class="wo-momentum wo-momentum-${esc(v.momentum)}">${esc(v.momentum)}</span>`
    : '';
  const status = v && v.status ? `<span class="wo-status">${esc(v.status)}</span>` : '';

  return `<article class="wo-card${bugs > 0 ? ' wo-card-accent' : ''}">
    <h3 class="wo-project">${esc(p.project)}</h3>
    ${status}${momentum}
    <div class="wo-nums">
      <span class="${bugsClass}"><b>${bugs}</b> bugs</span>
      <span class="${reqClass}"><b>${requests}</b> requests</span>
      <span class="${backClass}"><b>${backlog}</b> backlog</span>
    </div>
  </article>`;
}

function projectsHTML(data) {
  const projects = sortProjects(data.projects);
  if (!projects.length) return '<p class="wo-empty">No projects found.</p>';
  const vmap = ventureMap(data.ventures);
  return projects.map((p) => projectCardHTML(p, vmap)).join('');
}

// ---- section 2: dashboard health -------------------------------------------

function healthHTML(health) {
  if (!health || !health.panels) return '';
  const panels = health.panels;
  const total = panels.length;
  const healthy = panels.filter((p) => p.status === 'healthy').length;
  const broken = panels.filter((p) => p.status !== 'healthy');

  const brokenHTML = broken.length
    ? `<ul class="wo-broken">${broken.map((p) =>
      `<li><span class="wo-broken-name">${esc(p.name)}</span>` +
      `<span class="wo-broken-detail">${esc(p.status)}${p.api && p.api !== 'n/a' ? ' · api ' + esc(p.api) : ''}</span></li>`
    ).join('')}</ul>`
    : '';

  return `<p class="wo-health-line"><b>${healthy}</b> of <b>${total}</b> panels healthy` +
    (broken.length ? `, <b>${broken.length}</b> broken` : '') + '.</p>' + brokenHTML;
}

// ---- section 3: ventures momentum ------------------------------------------

function momentumDot(m) {
  if (m === 'active') return 'wo-dot wo-dot-active';
  if (m === 'parked') return 'wo-dot wo-dot-parked';
  return 'wo-dot wo-dot-unknown';
}

function venturesHTML(ventures) {
  const vs = ventures || [];
  if (!vs.length) return '<p class="wo-empty">No ventures found.</p>';
  return '<ul class="wo-ventures">' + vs.map((v) => {
    const days = v.daysSinceActivity == null ? '—' : String(v.daysSinceActivity) + 'd';
    return `<li class="wo-venture">
      <span class="${momentumDot(v.momentum)}"></span>
      <span class="wo-venture-name">${esc(v.name)}</span>
      <span class="wo-venture-track">${esc(v.track || '')}</span>
      <span class="wo-venture-days">${esc(days)}</span>
      <span class="wo-venture-items">${esc(v.openItems || 0)} open</span>
    </li>`;
  }).join('') + '</ul>';
}

// ---- render -----------------------------------------------------------------

function render() {
  if (!root || !state) return;

  if (state.error) {
    root.innerHTML = `<section class="panel wo-panel">
      <h1>Workspace overview</h1>
      <p class="wo-alarm">Could not read workspace data — ${esc(state.error)}.
      That is a failure to look, not an empty workspace.</p>
    </section>`;
    return;
  }

  if (!state.board) {
    root.innerHTML = `<section class="panel wo-panel"><h1>Workspace overview</h1>
      <p class="wo-loading">Reading the workspace…</p></section>`;
    return;
  }

  const projHTML = projectsHTML(state.board);
  const health = state.health;
  const ventures = state.ventures ? state.ventures.ventures : [];
  const ventHTML = venturesHTML(ventures);

  root.innerHTML = `<section class="panel wo-panel">
    <h1>Workspace overview</h1>
    <p class="wo-lede">Every project at a glance — open bugs, requests, and backlog from the
      board, alongside venture momentum and dashboard panel health. The project with the most
      open work is first.</p>

    <h2 class="wo-h2">Projects <span class="wo-n">${(state.board.projects || []).length}</span></h2>
    ${projHTML}

    <h2 class="wo-h2">Dashboard health</h2>
    ${healthHTML(health)}

    <h2 class="wo-h2">Ventures momentum <span class="wo-n">${ventures.length}</span></h2>
    ${ventHTML}
  </section>`;
}

// ---- fetch ------------------------------------------------------------------

async function fetchJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} returned ${r.status}`);
  return r.json();
}

async function load() {
  try {
    const [board, ventures, health] = await Promise.all([
      fetchJSON('/api/board'),
      fetchJSON('/api/ventures').catch(() => null),
      fetchJSON('/api/health-check').catch(() => null),
    ]);
    state.board = board;
    state.ventures = ventures;
    state.health = health;
    state.error = null;
  } catch (e) {
    state.error = e.message;
  }
  render();
}

export default {
  mount(el, opts) {
    root = el;
    state = { board: null, ventures: null, health: null, error: null };
    render();
    load();
    renderLede('workspace-overview', el);
  },
  unmount() { root = null; state = null; },
};
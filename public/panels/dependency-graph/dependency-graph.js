//
// dependency-graph — which routes are mounted, which panels import what, and
// which projects share npm dependencies.
//
// THREE SECTIONS, ONE FETCH.
//   'Routes' — every route file require()'d by server/index.js, with a badge
//   showing whether the file actually exists on disk.
//   'Panels' — every panel directory, with indented children showing which
//   other panels it imports.
//   'Projects' — every top-level directory with a package.json, and the
//   shared npm dependencies (used by 2+ projects) listed underneath each.
//
// ABSENCE AND FAILURE LOOK DIFFERENT. An empty nodes list means the scanner
// found nothing — that is a real count, not a failed scan. A fetch error means
// the route itself could not run. The latter is a failure to look, not an
// empty graph.
import { renderLede } from '/panels/lede/lede.js';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

let root = null;
let state = null;

function typeBadge(type) {
  const cls = {
    'route': 'dg-badge-route',
    'panel': 'dg-badge-panel',
    'project': 'dg-badge-project',
    'shared-dep': 'dg-badge-dep',
  }[type] || 'dg-badge-route';
  return `<span class="dg-badge ${cls}">${esc(type)}</span>`;
}

function routeSection(nodes) {
  const routes = nodes.filter((n) => n.type === 'route');
  if (!routes.length) return '<p class="dg-empty">No routes found.</p>';
  return routes.map((n) => {
    const missing = n.exists === false ? ' <span class="dg-missing">missing</span>' : '';
    return `<div class="dg-node dg-node-route">${typeBadge(n.type)}<span class="dg-id">${esc(n.id)}</span><span class="dg-path">${esc(n.path)}</span>${missing}</div>`;
  }).join('');
}

function panelSection(nodes, edges) {
  const panels = nodes.filter((n) => n.type === 'panel');
  if (!panels.length) return '<p class="dg-empty">No panels found.</p>';
  // Build a map: panel name -> [imported panel names]
  const importsMap = {};
  for (const p of panels) importsMap[p.id] = [];
  for (const e of edges) {
    if (e.type === 'imports' && importsMap[e.from]) {
      importsMap[e.from].push(e.to);
    }
  }
  return panels.map((n) => {
    const imports = (importsMap[n.id] || []).sort();
    const missing = n.exists === false ? ' <span class="dg-missing">missing</span>' : '';
    const childHTML = imports.length
      ? `<ul class="dg-children">${imports.map((t) => `<li class="dg-child">${typeBadge('panel')}<span class="dg-id">${esc(t)}</span></li>`).join('')}</ul>`
      : '';
    return `<div class="dg-node dg-node-panel">${typeBadge(n.type)}<span class="dg-id">${esc(n.id)}</span><span class="dg-path">${esc(n.path)}</span>${missing}${childHTML}</div>`;
  }).join('');
}

function projectSection(nodes, edges) {
  const projects = nodes.filter((n) => n.type === 'project');
  const sharedDeps = nodes.filter((n) => n.type === 'shared-dep');
  if (!projects.length && !sharedDeps.length) return '<p class="dg-empty">No projects with package.json found.</p>';

  // Build a map: project name -> [shared dep names]
  const depMap = {};
  for (const p of projects) depMap[p.id] = [];
  for (const e of edges) {
    if (e.type === 'uses-dep' && depMap[e.from]) {
      depMap[e.from].push(e.to);
    }
  }

  const projectHTML = projects.map((n) => {
    const deps = (depMap[n.id] || []).sort();
    const depCount = n.depCount != null ? ` <span class="dg-count">${n.depCount} deps</span>` : '';
    const childHTML = deps.length
      ? `<ul class="dg-children">${deps.map((d) => `<li class="dg-child">${typeBadge('shared-dep')}<span class="dg-id">${esc(d)}</span><span class="dg-shared-by">${esc(nodes.find((nn) => nn.id === d && nn.type === 'shared-dep')?.sharedBy || '?')} projects</span></li>`).join('')}</ul>`
      : '';
    return `<div class="dg-node dg-node-project">${typeBadge(n.type)}<span class="dg-id">${esc(n.id)}</span>${depCount}${childHTML}</div>`;
  }).join('');

  return projectHTML;
}

function render() {
  if (!root || !state) return;

  if (state.error) {
    root.innerHTML = `<section class="panel dg-panel">
      <h1>Dependency graph</h1>
      <p class="dg-alarm">Could not read dependency graph — ${esc(state.error)}.
      That is a failure to look, not an empty graph.</p>
    </section>`;
    return;
  }

  if (!state.data) {
    root.innerHTML = `<section class="panel dg-panel"><h1>Dependency graph</h1>
      <p class="dg-loading">Scanning dependencies…</p></section>`;
    return;
  }

  const { nodes, edges, errors } = state.data;

  if (!nodes || nodes.length === 0) {
    root.innerHTML = `<section class="panel dg-panel">
      <h1>Dependency graph</h1>
      <p class="dg-lede">Which routes are mounted, which panels import what, and which projects share
        npm dependencies. The source IS the manifest — a new route is visible the moment its
        require() appears in index.js.</p>
      <p class="dg-empty">No dependencies found. That is a real count, not a failed scan.</p>
    </section>`;
    return;
  }

  const routeCount = nodes.filter((n) => n.type === 'route').length;
  const panelCount = nodes.filter((n) => n.type === 'panel').length;
  const projectCount = nodes.filter((n) => n.type === 'project').length;
  const depCount = nodes.filter((n) => n.type === 'shared-dep').length;
  const edgeCount = edges ? edges.length : 0;

  const errorsHTML = errors && errors.length
    ? `<div class="dg-errors">${errors.map((e) => `<div class="dg-error">${esc(e)}</div>`).join('')}</div>`
    : '';

  root.innerHTML = `<section class="panel dg-panel">
    <h1>Dependency graph</h1>
    <p class="dg-lede">Which routes are mounted, which panels import what, and which projects share
      npm dependencies. The source IS the manifest — a new route is visible the moment its
      require() appears in index.js.</p>

    <p class="dg-summary"><span class="dg-summary-n">${nodes.length}</span> nodes,
      <span class="dg-summary-n">${edgeCount}</span> edges —
      ${routeCount} routes, ${panelCount} panels, ${projectCount} projects, ${depCount} shared deps.</p>

    ${errorsHTML}

    <h2 class="dg-h2">Routes <span class="dg-n">${routeCount}</span></h2>
    ${routeSection(nodes)}

    <h2 class="dg-h2">Panels <span class="dg-n">${panelCount}</span></h2>
    ${panelSection(nodes, edges)}

    <h2 class="dg-h2">Projects <span class="dg-n">${projectCount}</span></h2>
    ${projectSection(nodes, edges)}
  </section>`;
}

async function load() {
  try {
    state.data = await (await fetch('/api/dependency-graph')).json();
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
    renderLede('dependency-graph', el);
  },
  unmount() { root = null; state = null; },
};
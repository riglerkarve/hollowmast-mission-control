'use strict';
//
// dependency-graph.js — cross-project dependency graph for the workspace.
//
// GET /api/dependency-graph — returns { nodes, edges } where nodes are
// { id, type, path } (type = 'route' | 'panel' | 'project' | 'shared-dep')
// and edges are { from, to, type } (type = 'mounts' | 'imports' | 'uses-dep').
//
// The graph is built by scanning source files at request time — no manifest
// is maintained, the source IS the manifest. A new route is visible the
// moment its require() appears in index.js; a panel that stops importing
// another drops its edge the moment the import is removed.
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');

const router = express.Router();

const WORKSPACE = 'C:/Users/jcwhi/Claude Outputs';
const SERVER_DIR = path.join(WORKSPACE, 'mission-control', 'server');
const PANELS_DIR = path.join(WORKSPACE, 'mission-control', 'public', 'panels');
const ROUTES_DIR = path.join(SERVER_DIR, 'routes');

// Scan index.js for require('./routes/...') statements to find mounted routes.
function scanRoutes() {
  const nodes = [];
  const edges = [];
  const indexPath = path.join(SERVER_DIR, 'index.js');
  let src = '';
  try { src = fs.readFileSync(indexPath, 'utf8'); } catch (e) { return { nodes, edges, error: e.message }; }

  // Match: const fooRouter = require('./routes/foo');
  const re = /require\s*\(\s*['"]\.\/routes\/([^'"]+)['"]\s*\)/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const name = m[1].replace(/\.js$/, '');
    const filePath = path.join(ROUTES_DIR, `${name}.js`);
    let exists = false;
    try { fs.statSync(filePath); exists = true; } catch {}
    nodes.push({ id: name, type: 'route', path: `server/routes/${name}.js`, exists });
    edges.push({ from: 'server/index.js', to: name, type: 'mounts' });
  }
  return { nodes, edges, error: null };
}

// Scan panel JS files for import ... from '/panels/...' to find panel-to-panel deps.
function scanPanels() {
  const nodes = [];
  const edges = [];

  let panelDirs = [];
  try {
    panelDirs = fs.readdirSync(PANELS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch (e) { return { nodes, edges, error: e.message }; }

  for (const name of panelDirs) {
    const jsPath = path.join(PANELS_DIR, name, `${name}.js`);
    let src = '';
    let exists = false;
    try { src = fs.readFileSync(jsPath, 'utf8'); exists = true; } catch {}
    nodes.push({ id: name, type: 'panel', path: `public/panels/${name}/${name}.js`, exists });

    if (!exists) continue;

    // Match: import { ... } from '/panels/lede/lede.js';
    const re = /import\s+[^;]+?\s+from\s+['"]\/panels\/([^'"/]+)\/[^'"]+['"]/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      const target = m[1];
      if (target !== name) {
        edges.push({ from: name, to: target, type: 'imports' });
      }
    }
  }
  return { nodes, edges, error: null };
}

// Scan top-level project directories for package.json shared dependencies.
function scanProjects() {
  const nodes = [];
  const edges = [];

  let dirs = [];
  try {
    dirs = fs.readdirSync(WORKSPACE, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name)
      .sort();
  } catch (e) { return { nodes, edges, error: e.message }; }

  // Collect all shared deps across projects to find overlaps.
  const depMap = {}; // dep -> [project names]

  for (const dir of dirs) {
    const pkgPath = path.join(WORKSPACE, dir, 'package.json');
    let pkg = null;
    try {
      pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    } catch { continue; }

    const deps = Object.keys(pkg.dependencies || {});
    const devDeps = Object.keys(pkg.devDependencies || {});
    const allDeps = [...deps, ...devDeps];

    nodes.push({ id: dir, type: 'project', path: dir, depCount: allDeps.length });

    for (const dep of allDeps) {
      if (!depMap[dep]) depMap[dep] = [];
      depMap[dep].push(dir);
    }
  }

  // Shared deps are deps used by 2+ projects.
  for (const [dep, projects] of Object.entries(depMap)) {
    if (projects.length < 2) continue;
    nodes.push({ id: dep, type: 'shared-dep', path: dep, sharedBy: projects.length });
    for (const project of projects) {
      edges.push({ from: project, to: dep, type: 'uses-dep' });
    }
  }

  return { nodes, edges, error: null };
}

router.get('/', (req, res) => {
  const nodes = [];
  const edges = [];
  const errors = [];

  // Routes
  const r = scanRoutes();
  if (r.error) errors.push(`routes: ${r.error}`);
  nodes.push(...r.nodes);
  edges.push(...r.edges);

  // Panels
  const p = scanPanels();
  if (p.error) errors.push(`panels: ${p.error}`);
  nodes.push(...p.nodes);
  edges.push(...p.edges);

  // Projects
  const pr = scanProjects();
  if (pr.error) errors.push(`projects: ${pr.error}`);
  nodes.push(...pr.nodes);
  edges.push(...pr.edges);

  res.json({ nodes, edges, errors: errors.length ? errors : undefined });
});

module.exports = router;
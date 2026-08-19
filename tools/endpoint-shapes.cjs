#!/usr/bin/env node
'use strict';

// Contract guard for Mission Control GET endpoints.
//
//   node tools/endpoint-shapes.cjs          compare the live shapes with the committed baseline
//   node tools/endpoint-shapes.cjs --write  deliberately replace that baseline
//
// Only field names and JSON types are written. Response values, identifiers, prose and
// financial/health data stay in process and are never printed or committed.
require('./_run-log.cjs').record();

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { inventory } = require('./route-inventory.cjs');

const ROOT = path.join(__dirname, '..');
const BASELINE = path.join(ROOT, 'baselines', 'endpoint-shapes.json');
const BASE = process.env.MC_BASE || 'http://127.0.0.1:3000';
const WRITE = process.argv.includes('--write');
const SAMPLE_LIMIT = 25;

function shapeOf(value, depth = 0) {
  if (value === null) return { type: 'null' };
  if (Array.isArray(value)) {
    const samples = value.slice(0, SAMPLE_LIMIT).map((item) => shapeOf(item, depth + 1));
    const unique = [...new Map(samples.map((shape) => [JSON.stringify(shape), shape])).values()];
    return { type: 'array', items: unique };
  }
  if (typeof value === 'object') {
    // A response cannot make this snapshot unbounded through an accidentally deep object.
    if (depth > 12) return { type: 'object', truncated: true };
    return {
      type: 'object',
      keys: Object.fromEntries(Object.keys(value).sort().map((key) => [key, shapeOf(value[key], depth + 1)])),
    };
  }
  return { type: typeof value };
}

function firstArray(json, keys) {
  for (const key of keys) if (Array.isArray(json && json[key]) && json[key].length) return json[key];
  return [];
}

async function fetchJson(relative) {
  const response = await fetch(BASE + relative, {
    headers: { 'X-MC-By': 'codex' }, signal: AbortSignal.timeout(15000),
  });
  const type = response.headers.get('content-type') || '';
  const body = type.includes('application/json') ? await response.json() : null;
  return { response, body, type };
}

async function dynamicPaths() {
  // Values selected here are used only to make a request. They never enter the report or
  // baseline. An empty source list leaves the route unresolved instead of inventing a URL.
  const out = new Map([['/garage/*', '/garage/index.html']]);
  const brain = await fetchJson('/api/brain');
  const memory = firstArray(brain.body, ['memories', 'items', 'notes']).find((item) => item && item.name);
  if (memory) out.set('/api/brain/:name', `/api/brain/${encodeURIComponent(memory.name)}`);

  const briefing = await fetchJson('/api/briefing');
  const latestBriefing = Array.isArray(briefing.body) && briefing.body.find((item) => item && item.date);
  if (latestBriefing) out.set('/api/briefing/:date', `/api/briefing/${encodeURIComponent(latestBriefing.date)}`);

  const wishlist = await fetchJson('/api/budget/wishlist');
  const wish = firstArray(wishlist.body, ['items']).find((item) => item && item.id !== undefined);
  if (wish) out.set('/api/budget/wishlist/:id/proposition', `/api/budget/wishlist/${encodeURIComponent(wish.id)}/proposition`);

  const goals = await fetchJson('/api/goals');
  const goal = firstArray(goals.body, ['goals']).find((item) => item && item.id !== undefined);
  if (goal) out.set('/api/goals/goals/:id', `/api/goals/goals/${encodeURIComponent(goal.id)}`);

  const todo = await fetchJson('/api/todo/items');
  const item = firstArray(todo.body, ['items']).find((row) => row && row.id !== undefined);
  if (item) out.set('/api/todo/items/:id/detail', `/api/todo/items/${encodeURIComponent(item.id)}/detail`);

  const projects = await fetchJson('/api/projects');
  const project = firstArray(projects.body, ['projects']).find((row) => row && row.href && /^\/api\/projects\//.test(row.href));
  if (project) out.set('/api/projects/:id/dash/*', new URL(project.href, BASE).pathname);
  return out;
}

async function probe(endpoint, resolved) {
  const response = await fetch(BASE + resolved, {
    headers: { 'X-MC-By': 'codex' }, signal: AbortSignal.timeout(15000),
  });
  const type = response.headers.get('content-type') || '';
  let body;
  if (type.includes('application/json')) body = await response.json();
  else { await response.arrayBuffer(); body = undefined; }
  return body === undefined ? { type: 'non-json' } : shapeOf(body);
}

function diff(before, after) {
  const lines = [];
  const keys = new Set([...Object.keys(before.endpoints || {}), ...Object.keys(after.endpoints || {})]);
  for (const key of [...keys].sort()) {
    if (!(key in (before.endpoints || {}))) lines.push(`ADDED ${key}`);
    else if (!(key in (after.endpoints || {}))) lines.push(`MISSING ${key}`);
    else if (JSON.stringify(before.endpoints[key]) !== JSON.stringify(after.endpoints[key])) lines.push(`CHANGED ${key}`);
  }
  return lines;
}

(async () => {
  const { endpoints } = inventory();
  const lookup = await dynamicPaths();
  const report = { version: 1, generatedBy: 'tools/endpoint-shapes.cjs', endpoints: {} };
  const unresolved = [];

  for (const endpoint of endpoints) {
    const resolved = lookup.get(endpoint.path) || endpoint.path;
    if (resolved.includes(':') || resolved.includes('*')) { unresolved.push(endpoint.path); continue; }
    try { report.endpoints[endpoint.path] = await probe(endpoint, resolved); }
    catch (error) { report.endpoints[endpoint.path] = { error: error.name }; }
  }

  console.log(`Probed ${Object.keys(report.endpoints).length} registered GET endpoint(s); values were not recorded.`);
  if (unresolved.length) {
    console.error(`UNRESOLVED dynamic endpoint(s): ${unresolved.join(', ')}`);
    process.exitCode = 1;
    return;
  }
  if (Object.values(report.endpoints).some((entry) => entry.error)) {
    console.error('REQUEST ERROR: one or more endpoints did not answer. No baseline was written.');
    process.exitCode = 1;
    return;
  }

  if (WRITE) {
    fs.mkdirSync(path.dirname(BASELINE), { recursive: true });
    fs.writeFileSync(BASELINE, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`WROTE deliberate baseline: ${path.relative(ROOT, BASELINE)}`);
    return;
  }
  if (!fs.existsSync(BASELINE)) {
    console.error('NO BASELINE: run node tools/endpoint-shapes.cjs --write after reviewing the live contract.');
    process.exitCode = 1;
    return;
  }
  const changes = diff(JSON.parse(fs.readFileSync(BASELINE, 'utf8')), report);
  if (changes.length) {
    console.error(`CONTRACT DRIFT (${changes.length}):\n  ${changes.join('\n  ')}`);
    process.exitCode = 1;
  } else console.log('PASS endpoint shapes match the committed baseline.');
})().catch((error) => { console.error(`${error.name}: ${error.message}`); process.exitCode = 1; });

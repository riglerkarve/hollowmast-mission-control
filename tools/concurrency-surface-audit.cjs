#!/usr/bin/env node
//
// concurrency-surface-audit.cjs — Batch G M104: identify shared outputs that
// can be reached by independent Mission Control processes.
//
//   node tools/concurrency-surface-audit.cjs
//
// This is deliberately source-only. It does not start a second server, invoke
// the scheduler, open SQLite, or write any output. A fixed temporary filename
// plus rename keeps readers from seeing a partial file; it does not establish
// ownership between two writers. The report therefore distinguishes a source
// guard observed here from a candidate that needs a contained reproduction.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function source(file) {
  const full = path.join(ROOT, file);
  try {
    return fs.readFileSync(full, 'utf8');
  } catch (error) {
    throw new Error(`could not read ${file}: ${error.message}`);
  }
}

function lineOf(text, needle) {
  const index = text.indexOf(needle);
  return index < 0 ? null : text.slice(0, index).split(/\r?\n/).length;
}

function evidence(text, needles) {
  return needles.map((needle) => {
    const line = lineOf(text, needle);
    return line == null ? null : `line ${line}: ${needle}`;
  }).filter(Boolean);
}

// Each entry names a shared resource that is intentionally known to this
// audit. It is not a claim that every unlisted write is safe: discovery is
// bounded to the high-value process boundaries below, and residue is printed.
const surfaces = [
  {
    id: 'restart-lock',
    file: 'scripts/restart-lock.cjs',
    resource: 'data/restart.lock',
    state: 'GUARDED',
    claim: 'restart ownership is published with an atomic hard link and stale locks are reclaimed by rename.',
    required: ['fs.linkSync(claim, file)', 'fs.renameSync(file, stale)'],
  },
  {
    id: 'heartbeat',
    file: 'server/heartbeat.js',
    resource: 'data/heartbeat.json via data/heartbeat.json.tmp',
    state: 'CANDIDATE',
    claim: 'a fixed temp path is atomically renamed for readers, but this file has no writer-ownership guard.',
    required: ['const TMP = `${FILE}.tmp`', 'fs.renameSync(TMP, FILE)'],
  },
  {
    id: 'watchdog-state',
    file: 'scripts/watchdog.cjs',
    resource: 'data/watchdog-state.json via data/watchdog-state.json.tmp',
    state: 'CANDIDATE',
    claim: 'restart attempts are locked, while the independently written watchdog state uses one fixed temp path.',
    required: ['const tmp = `${STATE_FILE}.tmp`', 'fs.renameSync(tmp, STATE_FILE)', 'const lock = acquireRestartLock()'],
  },
  {
    id: 'handover-spool',
    file: 'tools/handover.cjs',
    resource: 'data/handover-spool.jsonl',
    state: 'CANDIDATE',
    claim: 'the down-server fallback appends to a shared JSONL spool with no process lock visible in this tool.',
    required: ["'handover-spool.jsonl'", 'fs.appendFileSync(spool,'],
  },
  {
    id: 'daily-briefing',
    file: 'scripts/briefing.cjs',
    resource: 'reports/<date>.md and the briefings row for that date',
    state: 'CANDIDATE',
    claim: 'a date-keyed report is rewritten and then upserted without a single-flight guard in this script.',
    required: ['fs.writeFileSync(path.join(dir, `${facts.date}.md`), md)', 'ON CONFLICT(date) DO UPDATE'],
  },
  {
    id: 'brain-generated-files',
    file: 'server/routes/brain.js',
    resource: 'MEMORY_DIR/_flags.md and MEMORY_DIR/_notes.md',
    state: 'CANDIDATE',
    claim: 'generated files are rewritten in full after database changes, without a temp-rename or inter-process writer guard.',
    required: ["path.join(MEMORY_DIR, '_flags.md')", "path.join(MEMORY_DIR, '_notes.md')", 'fs.writeFileSync(file, L.join'],
  },
  {
    id: 'endpoint-baseline',
    file: 'tools/endpoint-shapes.cjs',
    resource: 'baselines/endpoint-shapes.json',
    state: 'CANDIDATE',
    claim: 'the deliberate --write operation replaces one committed baseline with no source-level exclusivity guard.',
    required: ['if (WRITE)', 'fs.writeFileSync(BASELINE,'],
  },
  {
    id: 'archive-manifest',
    file: 'tools/archive.cjs',
    resource: 'archive/archive-manifest.jsonl',
    state: 'CANDIDATE',
    claim: 'staging rewrites the manifest from an in-memory snapshot with no source-level process guard.',
    required: ['const staged = readManifest()', 'fs.writeFileSync(MANIFEST,'],
  },
];

const rows = [];
for (const surface of surfaces) {
  const text = source(surface.file);
  const found = evidence(text, surface.required);
  const missing = surface.required.filter((needle) => !text.includes(needle));
  rows.push({ ...surface, found, missing });
}

console.log('Concurrency Surface Audit — Batch G M104');
console.log('STATIC ONLY: no process was started, no database was opened, and no path was written.');
console.log('CANDIDATE means source inspection found a shared output without an ownership guard in that file; it is not a reproduced race.');
for (const row of rows) {
  const status = row.missing.length ? 'COULD NOT VERIFY' : row.state;
  console.log(`\n${status}  ${row.id}`);
  console.log(`  resource: ${row.resource}`);
  console.log(`  source: ${row.file}`);
  console.log(`  observed: ${row.claim}`);
  if (row.found.length) console.log(`  evidence: ${row.found.join('; ')}`);
  if (row.missing.length) console.log(`  missing expected source markers: ${row.missing.join('; ')}`);
}

const guarded = rows.filter((row) => !row.missing.length && row.state === 'GUARDED').length;
const candidates = rows.filter((row) => !row.missing.length && row.state === 'CANDIDATE').length;
const uncertain = rows.filter((row) => row.missing.length).length;
console.log(`\nSUMMARY: ${guarded} guarded surface(s); ${candidates} candidate surface(s); ${uncertain} could not verify.`);
console.log('RESIDUE: this bounded audit does not prove filesystem semantics, scheduler overlap, or SQLite multi-process behaviour. Reproduce a candidate only with isolated temporary paths and explicit approval.');

if (uncertain) process.exitCode = 1;

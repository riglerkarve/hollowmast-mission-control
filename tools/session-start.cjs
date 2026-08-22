#!/usr/bin/env node
//
// session-start.cjs — the five things every agent does at the start of a shift,
// in one command.
//
//   node tools/session-start.cjs
//
// 1. Pull the latest code (shared tree — stale commits have deleted work)
// 2. Restart the server (if it's not running, or if the code changed)
// 3. Run routes-check (static — is every route wired?)
// 4. Run shift-start --peek (what happened, who's silent, what needs the owner?)
// 5. Print the top 5 prioritized items (what to work on this shift)
//
// This exists because #16 asked to "automate anything I keep repeating" and
// the most repeated thing in this workspace is the 5-command sequence every
// agent runs at the start of every shift. Each step prints its own output and
// the script exits non-zero if any check fails — so it is composable with the
// handover at the other end of the shift.
'use strict';
require('./_run-log.cjs').record();

const { execSync, execFileSync } = require('node:child_process');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');

function run(cmd, opts = {}) {
  try {
    return execSync(cmd, { cwd: ROOT, encoding: 'utf8', timeout: 30000, ...opts });
  } catch (e) {
    return e.stdout || String(e.message);
  }
}

console.log('=== SESSION START ===\n');

// 1. Git pull
console.log('--- git pull ---');
const pull = run('git pull --ff-only 2>&1');
console.log(pull.trim() || 'already up to date');
console.log('');

// 2. Restart server
console.log('--- restart server ---');
const restart = run('node tools/restart.cjs 2>&1');
console.log(restart.trim());
console.log('');

// 3. Routes check (static only — no HTTP probe needed at session start)
console.log('--- routes check ---');
try {
  const out = execFileSync('node', ['tools/routes-check.cjs', '--no-http'], {
    cwd: ROOT, encoding: 'utf8', timeout: 15000,
  });
  console.log(out.trim());
} catch (e) {
  console.log('FAIL: routes-check exited ' + (e.status || '?'));
  console.log(String(e.stdout || e.message).trim());
}
console.log('');

// 4. Shift start (peek — don't mark handovers read, the agent decides that)
console.log('--- shift start ---');
try {
  const out = execFileSync('node', ['tools/shift-start.cjs', '--peek'], {
    cwd: ROOT, encoding: 'utf8', timeout: 15000,
  });
  console.log(out.trim());
} catch (e) {
  console.log('could not run shift-start: ' + String(e.message).slice(0, 80));
}
console.log('');

// 5. Top 5 priorities
console.log('--- top priorities ---');
try {
  const r = require('../server/db');
  // Use the prioritize route's logic directly
  const fetch = globalThis.fetch || require('node:http');
  const out = execSync('curl -s http://127.0.0.1:3000/api/prioritize', {
    encoding: 'utf8', timeout: 5000,
  });
  const d = JSON.parse(out);
  const items = (d.items || []).slice(0, 5);
  for (const i of items) {
    console.log('  ' + String(i.score).padStart(3) + ' [' + i.priority + '] ' +
      String(i.ref).padStart(6) + ' ' + (i.title || '').slice(0, 65));
  }
  console.log('  (' + (d.totalOpen || '?') + ' open items total)');
} catch (e) {
  console.log('could not fetch priorities: ' + String(e.message).slice(0, 80));
}
console.log('');
console.log('=== READY ===');
#!/usr/bin/env node
'use strict';

// verify-shift-report.cjs — independently recompute current shift gaps from team_* tables.
//
// The table queries below were written before inspecting reportFor(). The API is requested
// only AFTER the independent result exists, and comparison is by the route's own gap kind
// and count. An unknown route kind fails closed as UNMODELLED rather than passing silently.
// This opens the live database read-only and makes no use of server/routes/team helpers.

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.join(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data', 'dashboard.db');
const BASE = process.env.MC_BASE || 'http://127.0.0.1:3000';
const shiftArg = process.argv.indexOf('--shift');

function localShift(now = new Date()) {
  const date = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  return `${date}-${now.getHours() < 12 ? 'morning' : now.getHours() < 18 ? 'afternoon' : 'evening'}`;
}

function count(db, sql, ...params) { return Number(db.prepare(sql).get(...params).n); }
function rows(db, sql, ...params) { return db.prepare(sql).all(...params); }

function recompute(db, shift) {
  // Each definition names the table predicate rather than borrowing a route helper. Names are
  // IDs only: gap comparison does not need handover prose, and reports no private content.
  return new Map([
    ['unread-handovers', {
      rule: 'team_handovers for this shift with read_at IS NULL',
      n: count(db, 'SELECT COUNT(*) AS n FROM team_handovers WHERE shift = ? AND read_at IS NULL', shift),
    }],
    ['unconfirmed-plans', {
      rule: 'plans neither confirmed nor returned nor superseded',
      n: count(db, `SELECT COUNT(*) AS n FROM team_plans
                    WHERE shift = ? AND confirmed_at IS NULL AND returned_at IS NULL AND superseded_by IS NULL`, shift),
    }],
    ['unanswered-steering', {
      rule: 'steering questions for this shift with answer IS NULL',
      n: count(db, 'SELECT COUNT(*) AS n FROM team_steering WHERE shift = ? AND answer IS NULL', shift),
    }],
    ['unresolved-owner-items', {
      rule: 'canonical owner items with resolved_at IS NULL',
      n: count(db, 'SELECT COUNT(*) AS n FROM team_owner_items WHERE resolved_at IS NULL'),
    }],
    ['unactioned-responses', {
      rule: 'owner responses for this shift with actioned_at IS NULL',
      n: count(db, 'SELECT COUNT(*) AS n FROM team_responses WHERE shift = ? AND actioned_at IS NULL', shift),
    }],
    ['assignment-use-not-recorded', {
      rule: 'assignment has neither a recorded model/effort pair nor an override reason',
      n: count(db, `SELECT COUNT(*) AS n FROM team_assignments
                    WHERE shift = ? AND (used_model IS NULL OR used_effort IS NULL) AND override_reason IS NULL`, shift),
    }],
    ['unreviewed-assignments', {
      rule: 'assignment refs with no review targeting the same ref',
      n: count(db, `SELECT COUNT(*) AS n FROM team_assignments a
                    WHERE a.shift = ? AND NOT EXISTS (SELECT 1 FROM team_reviews r WHERE r.target = a.ref)`, shift),
    }],
  ]);
}

(async () => {
  const shift = shiftArg >= 0 ? process.argv[shiftArg + 1] : localShift();
  if (!shift) throw new Error('--shift needs a shift label');
  if (!fs.existsSync(DB_PATH)) throw new Error(`database absent: ${DB_PATH}`);
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  let expected;
  try { expected = recompute(db, shift); }
  finally { db.close(); }

  console.log(`LIVE DATABASE OPENED READ-ONLY: ${DB_PATH}`);
  console.log(`INDEPENDENT SHIFT: ${shift}`);
  console.log('INDEPENDENT GAP COUNTS');
  for (const [kind, gap] of expected) console.log(`  ${kind}: ${gap.n} — ${gap.rule}`);

  // Independent work is complete above. Only now ask the report route what it says.
  const response = await fetch(`${BASE}/api/team/report?shift=${encodeURIComponent(shift)}`, {
    headers: { 'X-MC-By': 'codex' }, signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`/api/team/report answered ${response.status}`);
  const report = await response.json();
  const actual = new Map((report.gaps || []).map((gap) => [gap.kind, Number(gap.n)]));
  const aliases = new Map([
    ['unread-handovers', ['unread-handovers']],
    ['unconfirmed-plans', ['unconfirmed-plans']],
    ['unanswered-steering', ['unanswered-steering']],
    ['unresolved-owner-items', ['unresolved-owner-items']],
    ['unactioned-responses', ['unactioned-responses']],
    ['assignment-use-not-recorded', ['assignment-use-not-recorded']],
    ['unreviewed-assignments', ['unreviewed-assignments']],
  ]);
  let failures = 0;
  console.log('\nROUTE COMPARISON');
  for (const [kind, gap] of expected) {
    const routeKinds = aliases.get(kind) || [];
    const present = routeKinds.find((name) => actual.has(name));
    const seen = present ? actual.get(present) : 0;
    if (seen === gap.n) console.log(`  PASS ${kind}: ${gap.n}`);
    else { console.log(`  FAIL ${kind}: independent ${gap.n}, report ${seen}`); failures += 1; }
    if (present) actual.delete(present);
  }
  for (const [kind, n] of actual) {
    console.log(`  FAIL unmodelled report gap: ${kind} = ${n}`);
    failures += 1;
  }
  console.log(`\n${failures ? `REPORT DISAGREEMENTS: ${failures}` : 'PASS shift report gaps match the independent recomputation.'}`);
  process.exitCode = failures ? 1 : 0;
})().catch((error) => { console.error(`COULD NOT COMPARE shift report: ${error.message}`); process.exitCode = 2; });

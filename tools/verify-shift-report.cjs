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

function rows(db, sql, ...params) { return db.prepare(sql).all(...params); }

function recompute(db, shift) {
  // Every predicate is expressed here against base tables. No route helpers are imported.
  const handovers = rows(db, 'SELECT id, title, read_at FROM team_handovers WHERE shift = ? ORDER BY at', shift);
  const plans = rows(db, 'SELECT id, confirmed_at, returned_at, superseded_by FROM team_plans WHERE shift = ? ORDER BY id', shift);
  const assignments = rows(db, 'SELECT plan_id FROM team_assignments WHERE shift = ? ORDER BY id', shift);
  const steering = rows(db, 'SELECT answer, by_whom FROM team_steering WHERE shift = ? ORDER BY id', shift);
  const roster = rows(db, 'SELECT title FROM team_sessions WHERE retired_at IS NULL');
  const ownerItems = rows(db, `SELECT DISTINCT o.id, o.title, o.resolved_at
                               FROM team_owner_items o
                               JOIN team_owner_item_filings f ON f.item_id = o.id
                               JOIN team_handovers h ON h.id = f.handover_id
                               WHERE h.shift = ? ORDER BY o.id`, shift);
  const responses = rows(db, 'SELECT kind, ref FROM team_responses WHERE actioned_at IS NULL ORDER BY id');
  const reported = new Set(handovers.map((row) => row.title));
  const drafts = plans.filter((row) => !row.confirmed_at && !row.returned_at && !row.superseded_by);
  const later = (plan) => plans.some((other) => other.id > plan.id);
  const untriaged = ownerItems.filter((row) => !row.resolved_at);

  const make = (rule, names, n = names.length) => ({ rule, n, names });
  return new Map([
    ['unread', make('handover has no read_at', handovers.filter((row) => !row.read_at).map((row) => row.title))],
    ['hanging', make('draft plan has no later plan in shift', drafts.filter((row) => !later(row)).map((row) => `#${row.id}`))],
    ['unresolved', make('draft plan has a later plan but no superseded_by', drafts.filter(later).map((row) => `#${row.id}`))],
    ['undelegated', make('confirmed plan has no assignment referencing it', plans.filter((row) => row.confirmed_at && !assignments.some((a) => a.plan_id === row.id)).map((row) => `#${row.id}`))],
    ['untriaged', make('distinct unresolved canonical owner items filed in this shift', untriaged.map((row) => `${row.title} #${row.id}`))],
    ['unanswered', make('steering question has no answer', steering.filter((row) => !row.answer).map(() => ''))],
    ['silent', make('active roster member did not file, only after this shift has a handover', handovers.length ? roster.filter((row) => !reported.has(row.title)).map((row) => row.title) : [])],
    ['unattributed', make('answered steering question has no known by_whom', steering.filter((row) => row.answer && (!row.by_whom || row.by_whom === 'unknown')).map(() => ''))],
    ['unactioned', make('owner response remains unactioned across all shifts', responses.slice(0, 8).map((row) => `${row.kind} ${row.ref}`), responses.length)],
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
  const actual = new Map((report.gaps || []).map((gap) => [gap.kind, {
    n: Number(gap.n), names: Array.isArray(gap.names) ? gap.names : [],
  }]));
  let failures = 0;
  console.log('\nROUTE COMPARISON');
  for (const [kind, gap] of expected) {
    const seen = actual.get(kind) || { n: 0, names: [] };
    const sameCount = seen.n === gap.n;
    const sameNames = [...seen.names].sort().join('\n') === [...gap.names].sort().join('\n');
    if (sameCount && sameNames) console.log(`  PASS ${kind}: ${gap.n}`);
    else {
      console.log(`  FAIL ${kind}: independent ${gap.n}, report ${seen.n}${sameNames ? '' : '; identities differ'}`);
      failures += 1;
    }
    actual.delete(kind);
  }
  for (const [kind, gap] of actual) {
    console.log(`  FAIL unmodelled report gap: ${kind} = ${gap.n}`);
    failures += 1;
  }
  console.log(`\n${failures ? `REPORT DISAGREEMENTS: ${failures}` : 'PASS shift report gaps match the independent recomputation.'}`);
  process.exitCode = failures ? 1 : 0;
})().catch((error) => { console.error(`COULD NOT COMPARE shift report: ${error.message}`); process.exitCode = 2; });

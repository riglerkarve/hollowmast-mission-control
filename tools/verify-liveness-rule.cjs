#!/usr/bin/env node
//
// verify-liveness-rule.cjs — re-derives every figure in VERIFICATION-2026-08-23-liveness-rule.md
//
//   node tools/verify-liveness-rule.cjs
//   node tools/verify-liveness-rule.cjs --all         (also print the checks that held)
//   node tools/verify-liveness-rule.cjs --self-test   (prove it fails when it should)
//
// WHY THIS EXISTS. The report it checks was a prose snapshot taken at 2026-08-23T12:14Z, and
// it started rotting immediately: team_decisions took nine owner rows the same day, one of
// them fifteen minutes before the snapshot. A reader three days later has no way to tell a
// figure that is still true from one that has moved, so the honest thing the report could say
// was "assume drift before assuming error" -- which is an apology, not a check.
//
// THE DISTINCTION THIS TOOL IS BUILT ON, and it is the whole design: some of those figures are
// SUPPOSED to move and some are not.
//
//   gmail_messages growing is the finding working. Flagging it would be noise, and an alarm
//   that fires every day is one you learn to dismiss.
//
//   browsing_domains having more than ONE distinct imported_at would mean a re-import happened
//   and the claim "frozen single import" is dead. That must be impossible to miss.
//
// So every check carries `volatile`. Volatile checks report their new value and never alarm.
// Stable checks are load-bearing: if one moves, a sentence in the report is now false and the
// tool says which one. That is the difference between a stale document and a wrong one.
//
// WHAT IT DOES NOT DO. It does not re-argue the debate, and it does not judge the rule. It
// re-derives numbers and says whether the report's numbers still match. The conclusions are
// the reader's, exactly as check-claim.cjs leaves them to the Manager.
//
// THREE THINGS IT HAS TO GET RIGHT, each learned the hard way on this workspace:
//
//   1. WAL. A plain file copy of dashboard.db reads stale -- measured at 983 against 993 for
//      tool_runs on the day the report was written. This takes its own VACUUM INTO snapshot,
//      and CHECK 0 re-runs that control every time rather than trusting the number, because
//      a control you stop running is decoration.
//   2. ABSENCE MUST NOT LOOK LIKE HEALTH. A missing table, a locked database or a renamed
//      column reports COULD NOT LOOK and exits non-zero. It never reports zero findings
//      because it failed to look for any.
//   3. THE OBSERVER EFFECT IS DECLARED, NOT HIDDEN. This file calls _run-log.cjs like every
//      other tool here, which writes a row to tool_runs -- a table the report cites. So
//      running this checker increments one of the figures it checks. tool_runs is marked
//      volatile and CHECK 0 measures the WAL gap rather than pinning a count, so the effect
//      changes nothing; but a tool that quietly moved its own evidence would be the exact
//      defect the report was commissioned to find.
//
'use strict';
require('./_run-log.cjs').record();

const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const LIVE = path.join(ROOT, 'data', 'dashboard.db');
const REPORT = 'VERIFICATION-2026-08-23-liveness-rule.md';
const TAKEN = '2026-08-23T12:14Z';

const showAll = process.argv.includes('--all');
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log('\n  usage: node tools/verify-liveness-rule.cjs [--all] [--self-test]');
  console.log(`  Re-derives every figure in ${REPORT}.`);
  console.log('  Reports facts and whether they moved. It does not judge the debate.\n');
  process.exit(2);
}

// ---------------------------------------------------------------------------------------
// Snapshot. VACUUM INTO, never a file copy.
// ---------------------------------------------------------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-verify-'));
const SNAP = path.join(tmp, 'snap.db');
const PLAIN = path.join(tmp, 'plain.db');
let db, plainDb;

function cleanup() {
  try { if (db) db.close(); } catch (e) { /* closing a closed handle is not an error worth raising */ }
  try { if (plainDb) plainDb.close(); } catch (e) { /* same */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* a temp dir that outlives us is harmless */ }
}
process.on('exit', cleanup);

try {
  const src = new DatabaseSync(LIVE, { readOnly: true });
  src.exec(`VACUUM INTO '${SNAP.replace(/'/g, "''")}'`);
  src.close();
  db = new DatabaseSync(SNAP, { readOnly: true });
} catch (e) {
  console.error(`\n  COULD NOT LOOK: no snapshot. ${e.message}`);
  console.error('  Nothing below was checked. This is not a clean run.\n');
  process.exit(3);
}

// ---------------------------------------------------------------------------------------
// Checks. `expected` is the value recorded in the report at TAKEN.
// `volatile: true`  -> movement is the system working; report it, never alarm.
// `volatile: false` -> movement means a sentence in the report is now false.
//
// A check function returns EITHER a bare value, compared directly against `expected`, OR
// `{ v, detail }` where only `v` is compared and `detail` is printed beside it.
//
// THAT SPLIT IS NOT COSMETIC -- the first draft of this file lacked it and raised FOUR FALSE
// ALARMS on its first run. Checks like 5f returned "yes, by 5.6 h" and were compared against
// the recorded "yes", so a stable finding reported itself as CHANGED because the detail
// string moved. Six alarms, four of them noise, is the cry-wolf failure check-claim.cjs
// documents at the top of its own file. The verdict and the evidence for it have to be
// separate values, or every richer message becomes a spurious finding.
// ---------------------------------------------------------------------------------------
const one = (sql, ...args) => db.prepare(sql).get(...args);
const n = (sql, ...args) => Object.values(one(sql, ...args))[0];
const sha = (s) => (s === null || s === undefined ? '(null)'
  : crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 10));

const CHECKS = [];
const add = (id, claim, expected, fn, volatile, note) =>
  CHECKS.push({ id, claim, expected, fn, volatile, note });

// --- CHECK 0: the control. Re-run, never trusted from the page. -------------------------
add('CTRL', 'plain file copy is not ahead of the snapshot', 'sound', () => {
  fs.copyFileSync(LIVE, PLAIN);
  plainDb = new DatabaseSync(PLAIN, { readOnly: true });
  const v = n('SELECT count(*) c FROM tool_runs');
  const p = Object.values(plainDb.prepare('SELECT count(*) c FROM tool_runs').get())[0];
  plainDb.close(); plainDb = null;
  return { v: p <= v ? 'sound' : 'INVERTED', detail: `plain ${p} vs vacuum ${v}` };
}, false, 'if this ever inverts, the snapshot method is wrong and nothing below is safe');

// --- Claim 1: the DEAD set --------------------------------------------------------------
add('1a', 'journal_entries', 1, () => n('SELECT count(*) c FROM journal_entries'), true);
add('1b', 'wellbeing_entries', 1, () => n('SELECT count(*) c FROM wellbeing_entries'), true);
add('1c', 'lifestyle_intake', 0, () => n('SELECT count(*) c FROM lifestyle_intake'), true);
add('1d', 'cash_counts', 0, () => n('SELECT count(*) c FROM cash_counts'), true);
add('1e', 'exercise_sessions', 1, () => n('SELECT count(*) c FROM exercise_sessions'), true);
add('1f', 'crm_clients', 1, () => n('SELECT count(*) c FROM crm_clients'), true);
add('1g', 'focus_sessions rows', 13, () => n('SELECT count(*) c FROM focus_sessions'), true);
add('1h', 'focus_sessions written by owner', 0,
  () => n("SELECT count(*) c FROM focus_sessions WHERE by_whom NOT IN ('claude','unknown')"),
  false, 'report says 12 claude / 1 unknown / ZERO owner -- the misfiling finding');
add('1i', 'alert_events total', 31, () => n('SELECT count(*) c FROM alert_events'), true);
add('1j', 'alert_events with a verdict', 0,
  () => n('SELECT count(*) c FROM alert_events WHERE verdict IS NOT NULL'),
  false, 'a non-zero here means the adjudication loop restarted and the DEAD label is wrong');

// --- Claim 2: the ALIVE set -------------------------------------------------------------
add('2a', 'gmail_messages', 69237, () => n('SELECT count(*) c FROM gmail_messages'), true);
add('2b', 'gmail_sync held == row count', 'equal', () => {
  const held = n('SELECT sum(messages_held) c FROM gmail_sync');
  const rows = n('SELECT count(*) c FROM gmail_messages');
  return held === rows ? 'equal' : `MISMATCH held=${held} rows=${rows}`;
}, false, 'the internal cross-check that made claim 2 trustworthy');
add('2c', 'finance_transactions', 6839, () => n('SELECT count(*) c FROM finance_transactions'), true);
add('2d', 'browsing_domains rows', 811, () => n('SELECT count(*) c FROM browsing_domains'), true);
add('2e', 'browsing_domains distinct import instants', 1,
  () => n('SELECT count(DISTINCT imported_at) c FROM browsing_domains'),
  false, 'report calls this a FROZEN single import; >1 kills that finding');
add('2f', 'drive_files rows', 43, () => n('SELECT count(*) c FROM drive_files'), true);
add('2g', 'health_metrics distinct record instants', 1,
  () => n('SELECT count(DISTINCT recorded_at) c FROM health_metrics'),
  false, 'same finding as 2e, on the table neither side cited');

// --- Claim 3: the adjudication set ------------------------------------------------------
add('3a', 'team_decisions total', 46, () => n('SELECT count(*) c FROM team_decisions'), true);
add('3b', "decided_by = 'owner' (exact)", 33,
  () => n("SELECT count(*) c FROM team_decisions WHERE decided_by='owner'"), true);
add('3c', "decided_by = 'owner' (case-insensitive)", 34,
  () => n("SELECT count(*) c FROM team_decisions WHERE lower(decided_by)='owner'"), true);
add('3d', 'rows whose case breaks exact-match', 1,
  () => n("SELECT count(*) c FROM team_decisions WHERE lower(decided_by)='owner' AND decided_by<>'owner'"),
  false, 'the off-by-one bug. 0 means it was fixed; >1 means it spread');
add('3e', 'the three owner columns still disagree', 'disagree', () => {
  const a = n("SELECT count(*) c FROM team_decisions WHERE decided_by='owner'");
  const b = n("SELECT count(*) c FROM team_decisions WHERE role='owner'");
  const c = n("SELECT count(*) c FROM team_decisions WHERE by_whom='you'");
  return { v: (a === b && b === c) ? 'RESOLVED' : 'disagree',
    detail: `decided_by=${a} role=${b} by_whom=${c}` };
}, false, 'the open question: which column is authoritative. Resolution changes clause 3');
add('3f', 'todo_items total', 427, () => n('SELECT count(*) c FROM todo_items'), true);
add('3g', 'todo_items declined', 21,
  () => n("SELECT count(*) c FROM todo_items WHERE status='declined'"), true);
add('3h', 'todo_items adjudicated without a decided_at', 16,
  () => n("SELECT count(*) c FROM todo_items WHERE status IN ('done','declined') AND decided_at IS NULL"),
  true, 'report: 7 of 21 declined and 9 of 234 done lack one');

// --- Claim 4: the gate ------------------------------------------------------------------
add('4a', 'gate_devices', 0, () => n('SELECT count(*) c FROM gate_devices'), true);
add('4b', 'gate_attempts', 0, () => n('SELECT count(*) c FROM gate_attempts'), true);
add('4c', 'gate.js still exempts loopback', 'yes', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server', 'gate.js'), 'utf8');
  return /loopback/i.test(src) ? 'yes' : 'NO -- finding 4 is void';
}, false, 'the whole reason gate_devices=0 is not a counterexample');

// --- Claim 5: steering ------------------------------------------------------------------
add('5a', 'team_steering rows', 5, () => n('SELECT count(*) c FROM team_steering'), true);
add('5b', 'rows from briefing-auto', 4,
  () => n("SELECT count(*) c FROM team_steering WHERE asked_by='briefing-auto'"), true);
add('5c', 'distinct question texts among them', 2, () => {
  const r = db.prepare("SELECT question FROM team_steering WHERE asked_by='briefing-auto'").all();
  return new Set(r.map((x) => sha(x.question))).size;
}, false, 'report corrects "4 byte-identical" to 3+1. Two distinct hashes is that claim');
add('5d', 'distinct OPTIONS blobs among them', 1, () => {
  const r = db.prepare("SELECT options FROM team_steering WHERE asked_by='briefing-auto'").all();
  return new Set(r.map((x) => sha(x.options))).size;
}, false, 'ONE blob across questions saying 27 and 32 -- the question contradicts its options');
add('5e', 'ensureSteering still dedupes on date only', 'open', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server', 'routes', 'team.js'), 'utf8');
  const hit = /substr\(asked_at,1,10\)\s*=/.test(src);
  return { v: hit ? 'open' : 'FIXED', detail: hit ? 'date-only dedupe present' : 'predicate gone' };
}, false, 'REAL, but downstream of 5h. Not the cause -- see the correction under claim 5');

// 5g-5i ADDED 23 Aug, after survive-1e caught what the first pass missed. The report originally
// named the date-only dedupe as the defect; it is downstream of these. The owner ANSWERED, and
// answering resolves nothing -- so the question is recomposed from unchanged data every morning.
// A content-aware dedupe would suppress the symptom and leave him answering into a table that
// forgets him, which is why these are checked apart from 5e.
add('5g', 'steering rows the owner answered himself', 2,
  () => n("SELECT count(*) c FROM team_steering WHERE by_whom='you'"),
  false, '"he will not answer" is contradicted by these. #2 in 21 min, #7 the same day');
add('5h', 'the item steering #7 selected is still unresolved', 'unresolved', () => {
  const r = one('SELECT resolved_at, filing_count FROM team_owner_items WHERE id=2');
  if (!r) return null;
  return { v: r.resolved_at === null ? 'unresolved' : 'RESOLVED',
    detail: `filed ${r.filing_count}x · resolved_at ${r.resolved_at || 'NULL'}` };
}, false, 'root cause: answering writes team_steering.answer and nothing else. RESOLVED = wired');
add('5j', 'the owner is locked out of the resolve endpoint (M336)', 'locked', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server', 'routes', 'team.js'), 'utf8');
  const gate = /resolver is not on the roster/.test(src);
  const endpoint = /UPDATE team_owner_items SET resolved_at=\?, resolved_by=\?, resolved_note=\? WHERE id=\?/.test(src);
  return { v: gate ? 'locked' : 'OPEN',
    detail: `roster gate ${gate ? 'present' : 'gone'} · per-item endpoint ${endpoint ? 'present' : 'gone'}` };
}, false, 'stacks with 5h. engineOf(owner) is falsy so the human fails a same-engine review rule');
add('5i', 'owner items ever resolved by the owner', 0, () => {
  const by = n("SELECT count(*) c FROM team_owner_items WHERE resolved_by IN ('you','owner','Owner')");
  const open = n('SELECT count(*) c FROM team_owner_items WHERE resolved_at IS NULL');
  return { v: by, detail: `${by} by owner · ${open} of 48 still open` };
}, false, 'the six resolved rows were sessions clearing parser false positives, not him acting');

add('5f', 'briefing precedes the answers (the timing that voids the paradox)', 'briefing-first', () => {
  const b = one('SELECT date, created_at FROM briefings ORDER BY date DESC LIMIT 1');
  const a = n("SELECT max(answered_at) c FROM team_steering WHERE asked_by='briefing-auto'");
  if (!b || !a) return null;
  // briefings.created_at is LOCALTIME, answered_at is ISO-Z. See check 8d: in BST that is one
  // hour. Compared as instants, not as strings, or the offset silently decides the answer.
  const local = new Date(b.created_at.replace(' ', 'T') + 'Z').getTime() - 3600000;
  const ans = new Date(a).getTime();
  const hrs = ((ans - local) / 3600000).toFixed(1);
  return { v: ans > local ? 'briefing-first' : 'ANSWERS-FIRST',
    detail: `gap ${hrs} h · briefing ${b.date}` };
}, false, 'if this ever flips, the report is wrong and the debate was right');

// --- Claim 6: panels --------------------------------------------------------------------
function panelStats() {
  const dir = path.join(ROOT, 'public', 'panels');
  const dirs = fs.readdirSync(dir).filter((d) => fs.statSync(path.join(dir, d)).isDirectory());
  const strip = (s) => s.replace(/[/][*][^]*?[*][/]/g, ' ')
    .split(/\r?\n/).map((l) => l.replace(/(^|[^:])[/][/].*$/, '$1')).join('\n');
  const WRITE = /method\s*:\s*['"`](POST|PATCH|PUT|DELETE)['"`]/i;
  let writes = 0, noJs = 0;
  for (const d of dirs) {
    const files = fs.readdirSync(path.join(dir, d)).filter((f) => f.endsWith('.js'));
    if (!files.length) { noJs += 1; continue; }
    const src = strip(files.map((f) => fs.readFileSync(path.join(dir, d, f), 'utf8')).join('\n'));
    if (WRITE.test(src)) writes += 1;
  }
  const shell = fs.readFileSync(path.join(ROOT, 'public', 'shell.js'), 'utf8');
  const reg = [...shell.matchAll(/(?:'([a-z0-9-]+)'|([a-zA-Z0-9_-]+))\s*:\s*\(\)\s*=>\s*import\(/g)]
    .map((m) => m[1] || m[2]);
  return { dirs: dirs.length, writes, noJs, registered: reg.length,
    orphans: dirs.filter((d) => !reg.includes(d)) };
}
add('6a', 'panel directories', 69, () => panelStats().dirs, true);
add('6b', 'panels carrying a write method', 31, () => panelStats().writes, true);
add('6c', 'panel dirs with no .js at all (filter residue)', 0, () => panelStats().noJs,
  false, 'residue. A non-zero means 6b silently skipped a panel');
add('6d', 'panels registered in shell.js', 68, () => panelStats().registered, true);
add('6e', 'unregistered panel dirs', 'lede', () => panelStats().orphans.join(',') || '(none)', true);

// --- Claim 7: income --------------------------------------------------------------------
add('7a', 'income lifetime total', 224.93,
  () => n('SELECT sum(amount_pence)/100.0 c FROM income_entries'), true);
add('7b', 'currencies present', 'USD',
  () => db.prepare('SELECT DISTINCT currency c FROM income_entries ORDER BY 1').all().map((r) => r.c).join(','), false,
  'all rows are USD while the column DEFAULTS to GBP. A second currency here means they mixed');
add('7c', 'streams with zero entries', 3,
  () => n('SELECT count(*) c FROM income_streams s WHERE NOT EXISTS (SELECT 1 FROM income_entries e WHERE e.stream_id=s.id)'), true);
add('7d', 'honeygain newest income_ENTRY', '2024-12-24',
  () => n("SELECT max(period) c FROM income_entries WHERE stream_id='honeygain'"), true);
add('7e', 'honeygain newest income_BALANCE', '2026-08-23',
  () => String(n("SELECT max(day) c FROM income_balances WHERE stream_id='honeygain'")), true,
  'the correction: the stream is alive, only the manual entry died');

// --- The structural findings behind attack (a) ------------------------------------------
add('8a', 'empty tables', 19, () => {
  const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
  return t.filter((x) => n(`SELECT count(*) c FROM "${x.name}"`) === 0).length;
}, true);
// 8b AND 8d ARE RATIOS, NOT COUNTS, and that is the point. Both moved by one on the first run
// -- because a session created finance_purposes mid-audit, not because either finding changed.
// The report's claim is "who acted is unrecorded for roughly three quarters of the schema"
// and "two clocks coexist". Pinning the raw count would alarm on every migration; pinning the
// band alarms only when the claim itself stops being true.
add('8b', 'provenance coverage stays under a third', 'under-a-third', () => {
  const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
  const withProv = t.filter((x) => db.prepare(`PRAGMA table_info("${x.name}")`).all()
    .some((c) => /^(by_whom|tracked_by|logged_by|author)$/.test(c.name))).length;
  const pct = (withProv / t.length) * 100;
  return { v: pct < 33 ? 'under-a-third' : 'IMPROVED',
    detail: `${withProv} of ${t.length} (${pct.toFixed(0)}%)` };
}, false, 'the ceiling on the whole debate: who acted is unrecorded for the rest');
add('8c', 'non-internal tables', 85, () =>
  n("SELECT count(*) c FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"), true);
add('8d', 'two clocks still coexist', 'two-clocks', () => {
  const local = n("SELECT count(*) c FROM sqlite_master WHERE type='table' AND sql LIKE '%localtime%'");
  const total = n("SELECT count(*) c FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
  return { v: (local > 0 && local < total) ? 'two-clocks' : 'UNIFIED',
    detail: `${local} localtime of ${total}` };
}, false, 'the two-clock hazard. Any cross-boundary comparison under an hour can invert');
// 8e WAS "team_arbitrations, the only true orphan -- safe to delete", expecting 0
// rows forever. That check is now WRONG in two ways and table-census.cjs is what
// caught it: it flagged this line as an ASSERTION READER and warned that the
// first row ever written would fail it.
//
// M340 built the write path (POST /api/team/arbitration), so the table is no
// longer an orphan, and a checker still recommending its deletion would be
// arguing against work that shipped. The row count is now VOLATILE -- the first
// real arbitration is expected and must not read as a regression. What stays
// stable is the thing the report actually claimed: that it had no writer. It has
// one now, so the check asserts the writer exists rather than that the table is
// empty.
add('8e', 'team_arbitrations has a write path (was the only orphan)', 'has-writer', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server', 'routes', 'team.js'), 'utf8');
  const wired = /INSERT INTO team_arbitrations/.test(src);
  const rows = n('SELECT count(*) c FROM team_arbitrations');
  return { v: wired ? 'has-writer' : 'ORPHAN-AGAIN', detail: `${rows} row(s) recorded` };
}, false, 'M340. If this reverts to ORPHAN-AGAIN the route was removed, not the table filled');

// ---------------------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------------------
function run(checks) {
  const held = [], moved = [], changed = [], blind = [];
  for (const c of checks) {
    let raw;
    try {
      raw = c.fn();
    } catch (e) {
      blind.push({ ...c, why: e.message });
      continue;
    }
    if (raw === undefined || raw === null) {
      blind.push({ ...c, why: 'query returned nothing' });
      continue;
    }
    // A bare return is the value; an object splits the verdict from the evidence for it.
    const isPair = typeof raw === 'object' && raw !== null && 'v' in raw;
    const actual = isPair ? raw.v : raw;
    const detail = isPair ? raw.detail : null;
    if (actual === undefined || actual === null) {
      blind.push({ ...c, why: 'check produced no verdict' });
      continue;
    }
    const row = { ...c, actual, detail };
    if (String(actual) === String(c.expected)) held.push(row);
    else if (c.volatile) moved.push(row);
    else changed.push(row);
  }
  return { held, moved, changed, blind };
}

// --- SELF-TEST ---------------------------------------------------------------------------
// A clean sweep from this tool is not believable until the tool has been shown to fail. Both
// outcomes print reassuringly otherwise: "0 CHANGED" is what a working checker says and also
// what one with a broken predicate says. Three mutations, each asserting the classifier
// responds the way the report claims it does.
if (process.argv.includes('--self-test')) {
  const pick = (id) => CHECKS.find((c) => c.id === id);
  const mutate = (id, over) => CHECKS.map((c) => (c.id === id ? { ...c, ...over } : c));
  const cases = [
    ['a broken STABLE check is caught',
      mutate('5e', { expected: '__wrong__' }),
      (r) => r.changed.some((c) => c.id === '5e')],
    ['a moved VOLATILE check does not alarm',
      mutate('3a', { expected: -1 }),
      (r) => r.moved.some((c) => c.id === '3a') && !r.changed.length],
    ['an unreadable check reports COULD NOT LOOK, not success',
      mutate('8e', { fn: () => { throw new Error('simulated unreadable table'); } }),
      (r) => r.blind.some((c) => c.id === '8e')],
  ];
  let bad = 0;
  console.log('\n  self-test — the checker must fail when it should\n');
  for (const [name, checks, assert] of cases) {
    const ok = assert(run(checks));
    if (!ok) bad += 1;
    console.log(`    ${ok ? 'pass' : 'FAIL'}  ${name}`);
  }
  console.log(bad ? `\n  ${bad} self-test failure(s). Do not trust this tool's verdicts.\n`
    : '\n  All three pass. A clean run from this tool means something.\n');
  process.exit(bad ? 4 : 0);
}

const { held, moved, changed, blind } = run(CHECKS);

const w = (s, k) => String(s).padEnd(k);
console.log(`\n  ${REPORT}`);
console.log(`  recorded ${TAKEN} · re-derived ${new Date().toISOString().slice(0, 16)}Z\n`);

if (blind.length) {
  console.log('  COULD NOT LOOK — these were not checked. This is not a clean run.');
  for (const c of blind) console.log(`    ${w(c.id, 6)} ${w(c.claim, 46)} ${c.why}`);
  console.log('');
}

if (changed.length) {
  console.log('  CHANGED — a load-bearing figure moved. A sentence in the report is now false.');
  for (const c of changed) {
    console.log(`    ${w(c.id, 6)} ${w(c.claim, 48)} was ${w(c.expected, 14)} now ${c.actual}`);
    if (c.detail) console.log(`    ${' '.repeat(6)}   ${c.detail}`);
    if (c.note) console.log(`    ${' '.repeat(6)} ^ ${c.note}`);
  }
  console.log('');
}

if (moved.length) {
  console.log('  MOVED — expected. These track live data; the finding still stands.');
  for (const c of moved) {
    const d = (typeof c.actual === 'number' && typeof c.expected === 'number')
      ? `  (${c.actual > c.expected ? '+' : ''}${(c.actual - c.expected).toFixed(2).replace(/\.00$/, '')})` : '';
    console.log(`    ${w(c.id, 6)} ${w(c.claim, 48)} was ${w(c.expected, 14)} now ${c.actual}${d}`);
  }
  console.log('');
}

if (showAll && held.length) {
  console.log('  HELD');
  for (const c of held) {
    console.log(`    ${w(c.id, 6)} ${w(c.claim, 48)} ${c.actual}${c.detail ? '   ' + c.detail : ''}`);
  }
  console.log('');
}

console.log(`  ${held.length} held · ${moved.length} moved (expected) · `
  + `${changed.length} CHANGED · ${blind.length} could not look`);
if (!changed.length && !blind.length) {
  console.log('  Every load-bearing finding in the report still holds.\n');
} else {
  console.log('  Re-read the report against the lines above before citing it.\n');
}

process.exit(blind.length ? 3 : (changed.length ? 1 : 0));

#!/usr/bin/env node
//
// plan-outcome.cjs — what did the last plan actually deliver?
//
//   node tools/plan-outcome.cjs            the most recent plan
//   node tools/plan-outcome.cjs --all      every plan
//   node tools/plan-outcome.cjs --id 3
//
// Expansion 1 of 5. The chain the owner specified runs handover -> plan -> confirm ->
// delegate, and it had no fifth step: nothing ever asked whether the delegated work happened.
// A plan that is drafted, scrutinised and confirmed still reads as a success even if not one
// item on it moved.
//
// IT ADDS NO INPUT. An assignment names (source, ref); the board already mirrors that ref's
// live status out of the project's own tracker, and the backlog owns its own. So the outcome
// is a join, not a report anybody writes — which matters, because a status somebody has to
// remember to update is a status that is wrong by the second week.
//
// THE FIRST THING IT REPORTS IS THE STATE THIS PROJECT IS ACTUALLY IN. Measured on the day it
// was written: one plan, drafted and confirmed with a substantial verdict, and ZERO
// assignments against it. The chain reached "confirmed" and stopped. Reporting completion
// percentages over an empty set would have rendered that as nothing at all, so a confirmed
// plan with no assignments is called out ahead of any arithmetic.
'use strict';
require('./_run-log.cjs').record();

const db = require('../server/db');
db.setProcessActor('claude');

require('../server/routes/board');
const todo = require('../server/routes/todo');

const argv = process.argv.slice(2);
const idFlag = (() => { const i = argv.indexOf('--id'); return i >= 0 ? argv[i + 1] : null; })();

const plans = idFlag
  ? db.prepare('SELECT * FROM team_plans WHERE id = ?').all(idFlag)
  : argv.includes('--all')
    ? db.prepare('SELECT * FROM team_plans ORDER BY id DESC').all()
    : db.prepare('SELECT * FROM team_plans ORDER BY id DESC LIMIT 1').all();

if (!plans.length) {
  console.log('\n  No plans recorded. That is not "the team delivered nothing" — it means no');
  console.log('  supervisor has drafted one yet, which is a different fact and an earlier one.\n');
  process.exit(0);
}

// The two stores work items live in. Neither is read directly: the board owns imported tracker
// rows and todo owns the backlog, and a second query here would be a second owner for "is this
// done" that disagrees with the panel without either erroring.
const boardStatus = new Map(
  db.prepare('SELECT source, ref, status, title FROM board_items').all()
    .map((r) => [`${r.source}|${r.ref}`, r]));
const backlog = new Map(todo.openForBoard().map((r) => [String(r.id), r]));
const backlogAll = new Map(
  db.prepare('SELECT id, title, status FROM todo_items').all().map((r) => [String(r.id), r]));

const DONE = new Set(['fixed', 'wontfix', 'notabug', 'done', 'declined']);

for (const p of plans) {
  console.log(`\n  PLAN #${p.id} — shift ${p.shift}`);
  console.log(`    drafted   ${String(p.drafted_at).slice(0, 16).replace('T', ' ')} by ${p.drafted_by}`);
  if (p.confirmed_at) console.log(`    confirmed ${String(p.confirmed_at).slice(0, 16).replace('T', ' ')} by ${p.confirmed_by}`);
  else if (p.returned_at) console.log(`    RETURNED  ${String(p.returned_at).slice(0, 16).replace('T', ' ')} — never confirmed`);
  else console.log('    still a draft — never put to the manager');

  const rows = db.prepare('SELECT * FROM team_assignments WHERE plan_id = ? ORDER BY id').all(p.id);

  if (!rows.length) {
    if (p.confirmed_at) {
      console.log('');
      console.log('    CONFIRMED, AND NOTHING WAS DELEGATED AGAINST IT.');
      console.log('    The chain ran handover -> plan -> confirm and stopped. That is not a plan');
      console.log('    that failed; it is a plan that was never turned into work, which looks');
      console.log('    identical to success from every other view in this system.');
    } else {
      console.log('    No assignments, and the plan was never confirmed — consistent, not a gap.');
    }
    continue;
  }

  let done = 0; let open = 0; let unknown = 0;
  const lines = [];
  for (const a of rows) {
    let state; let title;
    if (a.source === 'todo') {
      const row = backlogAll.get(String(a.ref));
      if (!row) { state = 'NOT FOUND'; title = '(no such backlog item)'; }
      else { state = row.status; title = row.title; }
    } else {
      const row = boardStatus.get(`${a.source}|${a.ref}`);
      if (!row) { state = 'NOT FOUND'; title = '(not in the mirrored tracker)'; }
      else { state = row.status; title = row.title; }
    }
    // NOT FOUND is counted apart from both. An item the mirror cannot see is not evidence of
    // completion and not evidence of neglect — it is evidence that this join has a hole, and
    // folding it into either column would quietly flatter or damn the shift.
    if (state === 'NOT FOUND') unknown += 1;
    else if (DONE.has(state)) done += 1;
    else open += 1;
    lines.push(`      ${String(a.ref).padEnd(10)} ${String(state).padEnd(10)} ${String(title).slice(0, 56)}`
      + `  -> ${a.session_id}`);
  }

  console.log(`\n    ${rows.length} assigned · ${done} closed since · ${open} still open`
    + (unknown ? ` · ${unknown} NOT FOUND in either store` : ''));
  for (const l of lines) console.log(l);

  if (unknown) {
    console.log('\n    NOT FOUND means the assignment names something neither the backlog nor the');
    console.log('    mirrored trackers hold. Re-run tools/import-trackers.cjs before reading it as');
    console.log('    a bad reference — a tracker that has not been re-imported looks the same.');
  }
}

console.log('\n  Status is read from whichever module owns the item, never recomputed here.');
console.log('  Nothing above required anyone to mark a task complete.\n');

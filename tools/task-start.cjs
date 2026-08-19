#!/usr/bin/env node
//
// task-start.cjs — read the model and effort a task is meant to get, and check yourself.
//
//   node tools/task-start.cjs <assignment-id>
//   node tools/task-start.cjs --item M75           look up an item with no assignment yet
//   node tools/task-start.cjs <id> --used opus --effort high --why "the repro did not reproduce"
//
// Owner instruction, 19 Aug 2026: "Enforce model and effort use in sessions."
//
// ENFORCEMENT HERE HAS THREE STRENGTHS AND THIS FILE IS HONEST ABOUT WHICH IT IS.
//
//   ENFORCED   anything spawned: Codex takes -m <model> and model_reasoning_effort per
//              invocation, a Claude subagent takes model and effort as parameters. The caller
//              sets them, so there is nothing for the worker to comply with. Not this file.
//   CHECKED    a Claude session already running. It CAN read its own effort -- CLAUDE_EFFORT is
//              in the environment -- so this compares and refuses. It CANNOT read its own
//              model: nothing in the environment names it, only the harness. So the model is
//              DECLARED, and a declaration is a claim rather than a measurement. This file says
//              so on every run rather than presenting both with the same confidence.
//   RECORDED   the rest. What was recommended and what was used both sit on the assignment, and
//              a mismatch with no reason is a gap in the shift report.
//
// It exits NON-ZERO on a mismatch so a script cannot sail past it, and prints what to do. It
// does not and cannot stop a human from ignoring it — no schema reaches a chat window — but an
// ignored refusal leaves a row, and that is the same bargain every other guard here makes.
'use strict';
require('./_run-log.cjs').record();

const db = require('../server/db');
db.setProcessActor('claude');
const { dispatch, AGENTS } = require('../server/dispatch');

const argv = process.argv.slice(2);
const arg = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : null; };

const itemId = arg('item');
const usedModel = arg('used');
const usedEffort = arg('effort');
const why = arg('why');
const id = argv.find((a) => /^\d+$/.test(a));

if (!id && !itemId) {
  console.log('\n  usage: node tools/task-start.cjs <assignment-id>');
  console.log('         node tools/task-start.cjs --item <backlog-id>');
  console.log('         node tools/task-start.cjs <id> --used <model> --effort <level> --why "..."\n');
  process.exit(2);
}

// ------------------------------------------------------------------- what is recommended
let rec = null;
let row = null;
let label = '';

if (id) {
  row = db.prepare('SELECT * FROM team_assignments WHERE id = ?').get(id);
  if (!row) { console.log(`\n  no assignment ${id}\n`); process.exit(2); }
  label = `${row.source}:${row.ref}`;
  if (row.rec_model) rec = { model: row.rec_model, effort: row.rec_effort, rule: '(recorded at assignment)' };
}

if (!rec) {
  const ref = itemId || (row && row.ref);
  const item = db.prepare('SELECT id, title, rationale, kind, priority, cluster, owner, project FROM todo_items WHERE id = ?').get(String(ref))
    || db.prepare('SELECT ref, title, kind, severity AS priority, project FROM board_items WHERE ref = ?').get(String(ref));
  if (!item) {
    // COULD NOT LOOK. Not "no recommendation" -- an item that cannot be found gives no basis
    // for one, and defaulting to a middle tier here would manufacture a recommendation nobody
    // derived and nobody could audit.
    console.log(`\n  COULD NOT LOOK: no item matching "${ref}". That is not "no recommendation";`);
    console.log('  it is no basis for one. Nothing is assumed.\n');
    process.exit(2);
  }
  label = item.id || item.ref;
  rec = dispatch(item);
}

// ------------------------------------------------------------------- recording what was used
if (usedModel || usedEffort) {
  const mismatch = (usedModel && usedModel !== rec.model) || (usedEffort && usedEffort !== rec.effort);
  if (mismatch && !why) {
    console.log(`\n  REFUSED: ${usedModel || rec.model}/${usedEffort || rec.effort} differs from the`);
    console.log(`  recommendation ${rec.model}/${rec.effort}, and no reason was given.`);
    console.log('');
    console.log('  Overriding is fine. Overriding SILENTLY is not: afterwards, a considered');
    console.log('  exception and a session ignoring the recommendation look identical.');
    console.log('  Add --why "<what the recommendation missed>".\n');
    process.exit(1);
  }
  if (row) {
    db.prepare('UPDATE team_assignments SET used_model = ?, used_effort = ?, override_reason = ? WHERE id = ?')
      .run(usedModel || null, usedEffort || null, why || null, row.id);
    console.log(`\n  recorded on assignment ${row.id}: ${usedModel || '-'}/${usedEffort || '-'}${mismatch ? '  (override, reason recorded)' : ''}\n`);
  } else {
    console.log('\n  No assignment to record against — this was an item lookup only.\n');
  }
  process.exit(0);
}

// ------------------------------------------------------------------- the check
const a = AGENTS[rec.model] || {};
console.log('');
console.log(`  ${label}`);
console.log(`  recommended:  ${rec.model} / ${rec.effort}   ${a.what ? `(${a.what})` : ''}`);
if (rec.rule) console.log(`  rule:         ${rec.rule}`);
if (rec.why) console.log(`  why:          ${rec.why}`);
if (rec.escalateIf) console.log(`  escalate if:  ${rec.escalateIf}`);

// EFFORT IS MEASURED. The session's own environment carries it.
const mine = process.env.CLAUDE_EFFORT || null;
console.log('');
if (!mine) {
  console.log('  YOUR EFFORT: not readable from this environment. That is "could not look", not');
  console.log('  a match — do not treat it as one.');
} else if (mine === rec.effort) {
  console.log(`  YOUR EFFORT: ${mine} — matches.`);
} else {
  console.log(`  YOUR EFFORT: ${mine}, and this task wants ${rec.effort}.`);
  console.log('');
  const order = ['low', 'medium', 'high', 'xhigh', 'max'];
  const over = order.indexOf(mine) > order.indexOf(rec.effort);
  if (over) {
    console.log('  You are set HIGHER than the task needs. That is not wrong, it is just more');
    console.log('  expensive than the work requires — which is the thing this exists to reduce.');
    console.log('  Consider handing it to a cheaper session rather than doing it here.');
  } else {
    console.log('  You are set LOWER than the task needs. This is the direction that costs more,');
    console.log('  not less: an under-powered pass on an ambiguous task explores the wrong');
    console.log('  branch and is repeated. Hand it to a session set to ' + rec.effort + '.');
  }
}

// THE MODEL CANNOT BE MEASURED FROM HERE, and saying so every time is the point. Nothing in a
// Claude session's environment names its model — only the harness (`claude-code_..._agent`).
console.log('');
console.log('  YOUR MODEL: not detectable. Nothing in a Claude session\'s environment names the');
console.log('  model, so this cannot be checked, only declared. Record it when you finish:');
console.log(`    node tools/task-start.cjs ${row ? row.id : '<assignment-id>'} --used <model> --effort <level>`);
console.log('');

process.exitCode = (mine && mine !== rec.effort) ? 1 : 0;

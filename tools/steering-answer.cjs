#!/usr/bin/env node
//
// steering-answer.cjs — the owner answers one of the manager's steering questions.
//
//   node tools/steering-answer.cjs                    list what is waiting
//   node tools/steering-answer.cjs <id> "<answer>"    answer one
//
// The briefing names this command, so it has to exist and it has to be the whole route: a
// briefing that sends you to a screen nobody built costs you the time spent looking for it
// before you start doubting the sentence.
'use strict';
require('./_run-log.cjs').record();

const db = require('../server/db');
// The OWNER is answering. This is one of the few places where 'you' is the honest actor —
// recording it as 'claude' would attribute his decision to the session that typed it.
db.setProcessActor('you');

require('../server/routes/team');

const [id, ...rest] = process.argv.slice(2);
const answer = rest.join(' ').trim();

if (!id) {
  const open = db.prepare('SELECT * FROM team_steering WHERE answer IS NULL ORDER BY asked_at').all();
  if (!open.length) {
    console.log('\n  Nothing waiting on you. That is "no questions asked", not "no questions needed" —');
    console.log('  the manager decides what is worth asking, and today it asked nothing.\n');
    process.exit(0);
  }
  console.log('');
  for (const q of open) {
    console.log(`  #${q.id}  asked ${String(q.asked_at).slice(0, 16).replace('T', ' ')}`);
    console.log(`     ${q.question}`);
    if (q.options) {
      for (const o of JSON.parse(q.options)) {
        const label = typeof o === 'string' ? o : o.label;
        const cost = typeof o === 'string' ? null : o.cost;
        console.log(`       - ${label}${cost ? `   (if wrong: ${cost})` : ''}`);
      }
    }
    console.log(`     recommended: ${q.recommend}\n`);
  }
  console.log('  Answer with:  node tools/steering-answer.cjs <id> "<your answer>"\n');
  process.exit(0);
}

if (!answer) {
  console.log('\n  An answer is required. Nothing was recorded.\n');
  process.exit(2);
}

const row = db.prepare('SELECT * FROM team_steering WHERE id = ?').get(id);
if (!row) { console.log(`\n  No steering question #${id}.\n`); process.exit(1); }

// ANSWERING TWICE IS REFUSED RATHER THAN OVERWRITTEN. The first answer is the decision that
// was acted on; silently replacing it would leave the record disagreeing with what happened.
if (row.answer) {
  console.log(`\n  #${id} was already answered ${String(row.answered_at).slice(0, 16).replace('T', ' ')}:`);
  console.log(`    ${row.answer}`);
  console.log('\n  Not overwritten. If the decision has changed, that is a NEW question — the old');
  console.log('  answer is what the team acted on and the record has to keep saying so.\n');
  process.exit(1);
}

db.prepare('UPDATE team_steering SET answer = ?, answered_at = ?, by_whom = ? WHERE id = ?')
  .run(answer, new Date().toISOString(), 'you', id);

const back = db.prepare('SELECT * FROM team_steering WHERE id = ?').get(id);
console.log(`\n  Recorded against #${id}: ${back.answer}`);
console.log(`  ${db.prepare('SELECT COUNT(*) n FROM team_steering WHERE answer IS NULL').get().n} question(s) still waiting on you.\n`);

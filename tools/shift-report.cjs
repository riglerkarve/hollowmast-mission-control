#!/usr/bin/env node
//
// shift-report.cjs — the shift, written up for review.
//
//   node tools/shift-report.cjs                     the current shift
//   node tools/shift-report.cjs --shift 2026-08-19-afternoon
//   node tools/shift-report.cjs --out reports/team/  write the markdown as well as printing
//
// Owner instruction, 19 Aug 2026: "ensure every plan and decision is being recorded and
// reports made for review... This is to ensure a smooth learning curve and production output
// as you will be learning from feedback."
//
// SO THE REPORT'S JOB IS TO BE REVIEWABLE, WHICH IS NOT THE SAME AS BEING COMPLETE. A dump of
// everything that happened is unreadable and gets skimmed; what makes feedback possible is
// that each claim is attributed and each gap is named. Two halves:
//
//   WHAT WAS DECIDED — every decision in the shift, joined from the four places they live,
//                      each with who decided it and why. Never re-recorded here: a verdict
//                      lives on team_plans, an answer on team_steering, and this reads them.
//   WHAT THE PROCESS MISSED — derived, and the half that earns the report. A list of what
//                      happened cannot tell you the chain stalled; a list of what did NOT
//                      happen can, and it needs no one to remember to file it.
'use strict';
require('./_run-log.cjs').record();

const fs = require('node:fs');
const path = require('node:path');
const db = require('../server/db');
db.setProcessActor('claude');

const team = require('../server/routes/team');
require('../server/routes/board');
const todo = require('../server/routes/todo');

const argv = process.argv.slice(2);
const arg = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : null; };
const SHIFT = arg('shift') || team.shiftLabel();
const OUT = arg('out');

const all = (s, ...a) => db.prepare(s).all(...a);
const L = [];
const p = (s = '') => L.push(s);

const handovers = all('SELECT * FROM team_handovers WHERE shift = ? ORDER BY at', SHIFT);
const plans = all('SELECT * FROM team_plans WHERE shift = ? ORDER BY id', SHIFT);
const steering = all('SELECT * FROM team_steering WHERE shift = ? ORDER BY id', SHIFT);
const decisions = all('SELECT * FROM team_decisions WHERE shift = ? ORDER BY id', SHIFT);
const assignments = all('SELECT * FROM team_assignments WHERE shift = ? ORDER BY id', SHIFT);
const roster = all('SELECT * FROM team_sessions WHERE retired_at IS NULL');

p(`# Shift report — ${SHIFT}`);
p();
p(`_Generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} by \`tools/shift-report.cjs\`._`);
p(`_Nothing here is typed. Every line is read from the module that owns it._`);
p();

// ---------------------------------------------------------------- what the shift produced
p('## What the shift produced');
p();
p('| | |');
p('|---|---|');
p(`| Handovers filed | ${handovers.length} of ${roster.length} on the roster |`);
p(`| Plans drafted | ${plans.length} |`);
p(`| Plans confirmed | ${plans.filter((x) => x.confirmed_at).length} |`);
p(`| Work delegated | ${assignments.length} |`);
p(`| Decisions recorded | ${decisions.length + steering.filter((s) => s.answer).length + plans.filter((x) => x.verdict).length} |`);
p(`| Questions put to the owner | ${steering.length} |`);
p();

// ------------------------------------------------------------------------ what was decided
p('## What was decided, and by whom');
p();
const anyDecision = decisions.length || steering.length || plans.filter((x) => x.verdict).length;
if (!anyDecision) {
  p('**Nothing was decided this shift.** That is a real finding rather than a formatting');
  p('artefact — work happened, and no call was recorded about any of it.');
  p();
}

for (const d of decisions) {
  p(`### ${d.decision}`);
  p(`**${d.decided_by}**${d.role ? ` · ${d.role}` : ''} · ${String(d.at).slice(11, 16)}`);
  p();
  p(`**Because:** ${d.because}`);
  if (d.cost_if_wrong) p(`\n**If this is wrong:** ${d.cost_if_wrong}`);
  if (d.revisit_when) p(`\n**Revisit when:** ${d.revisit_when}${d.recheck_at ? ` (by ${d.recheck_at})` : ''}`);
  if (d.evidence) p(`\n**Evidence:** ${d.evidence}`);
  p();
}

for (const s of steering.filter((x) => x.answer)) {
  p(`### ${s.question.length > 90 ? `${s.question.slice(0, 90)}…` : s.question}`);
  p(`**The owner** · answered ${String(s.answered_at).slice(11, 16)}`);
  p();
  p(`**Decided:** ${s.answer}`);
  p(`\n**The manager had recommended:** ${s.recommend}`);
  // Attribution is printed even when it is missing, because `unknown` on the one table that
  // holds the owner's own judgement is exactly the gap worth seeing.
  if (s.by_whom && s.by_whom !== 'you') p(`\n> Recorded as \`${s.by_whom}\` rather than \`you\`. Attribution on this row is not certain.`);
  p();
}

for (const pl of plans.filter((x) => x.verdict)) {
  p(`### Plan #${pl.id} — ${pl.confirmed_at ? 'confirmed' : 'returned'}`);
  p(`**${pl.confirmed_by || 'the manager'}** · ${String(pl.confirmed_at || pl.returned_at).slice(11, 16)}`);
  p();
  p(`**Verdict:** ${pl.verdict}`);
  p();
}

// --------------------------------------------------------------- what the process missed
// THE DERIVED HALF. Everything above is a record of what happened; a record cannot tell you
// the chain stalled, because a stall leaves no row. These are absences, and each one is a
// question somebody should answer next shift.
p('## What the process missed');
p();
const gaps = [];

const unread = handovers.filter((h) => !h.read_at);
if (unread.length) {
  gaps.push(`**${unread.length} of ${handovers.length} handovers were never read** — ${unread.map((h) => h.title).join(', ')}. `
    + 'A handover nobody reads is a shift that reported into nothing, and the session that wrote it has no way to know.');
}

const drafts = plans.filter((x) => !x.confirmed_at && !x.returned_at);
if (drafts.length) {
  gaps.push(`**${drafts.length} plan(s) were drafted and never put to the manager** (#${drafts.map((d) => d.id).join(', #')}). `
    + 'Neither confirmed nor returned, so nothing can be delegated against them and nothing marks them as abandoned.');
}

const confirmedNoWork = plans.filter((x) => x.confirmed_at && !assignments.some((a) => a.plan_id === x.id));
if (confirmedNoWork.length) {
  gaps.push(`**${confirmedNoWork.length} confirmed plan(s) had no work delegated against them** (#${confirmedNoWork.map((d) => d.id).join(', #')}). `
    + 'The chain ran handover → plan → confirm and stopped. From every other view this looks identical to success.');
}

const untriaged = handovers.filter((h) => h.needs_owner && !h.owner_resolved_at);
if (untriaged.length) {
  gaps.push(`**${untriaged.length} owner-facing item(s) are sitting untriaged** — from ${untriaged.map((h) => h.title).join(', ')}. `
    + 'These are the only route a worker has to the owner. Until the manager triages them they reach nobody.');
}

const openQ = steering.filter((s) => !s.answer);
if (openQ.length) gaps.push(`**${openQ.length} steering question(s) are still waiting on the owner.**`);

const reported = new Set(handovers.map((h) => h.title));
const silent = roster.filter((r) => !reported.has(r.title));
if (silent.length) {
  gaps.push(`**${silent.length} session(s) on the roster filed nothing** — ${silent.map((s) => s.title).join(', ')}. `
    + 'Silence and having nothing to say look identical from here, and the second is rare.');
}

const badAttrib = steering.filter((s) => s.answer && (!s.by_whom || s.by_whom === 'unknown'));
if (badAttrib.length) {
  gaps.push(`**${badAttrib.length} answered steering question(s) are attributed to \`unknown\`.** `
    + 'This is the one table holding the owner\'s own judgement; an unattributed row there cannot be told from a session answering for him.');
}

if (!gaps.length) p('Nothing. Every handover was read, every plan resolved, every owner-facing item triaged.');
else for (const g of gaps) p(`- ${g}\n`);
p();

// ------------------------------------------------------------------------- for the owner
p('## For your review');
p();
p('The two questions worth answering, because they are what the next shift changes on:');
p();
p('1. **Are the decisions above the right ones?** Each carries its reasoning, so a "no" here');
p('   is actionable — it tells the team which reasoning to stop using, not just which call to reverse.');
p('2. **Which of the gaps matters?** They are listed because they are absences, not because');
p('   they are all worth fixing. A gap you do not care about should be removed from this report');
p('   rather than tolerated in it, or it becomes a line everyone learns to skip.');
p();
p('Feedback goes to the Team Manager, which is the only role that may reach you and the only');
p('one that can put it into the next plan.');

const text = `${L.join('\n')}\n`;
console.log(`\n${text}`);

if (OUT) {
  const dir = path.isAbsolute(OUT) ? OUT : path.join(__dirname, '..', OUT);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `shift-${SHIFT}.md`);
  fs.writeFileSync(file, text);
  // Read back rather than trusting the write: a report nobody can open is the same as none.
  const back = fs.readFileSync(file, 'utf8');
  console.log(`  written ${file} (${back.length} bytes, ${back.split('\n').length} lines)`);
}

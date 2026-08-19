#!/usr/bin/env node
//
// shift-start.cjs — what the supervisor reads at the beginning of a shift.
//
//   node tools/shift-start.cjs              the current shift, marking handovers read
//   node tools/shift-start.cjs --peek       the same, without marking anything read
//   node tools/shift-start.cjs --shift 2026-08-19-morning
//
// This is the first step of the chain the owner specified: every session hands over, the
// supervisor reads them all here, drafts a plan, the manager scrutinises and confirms it, and
// only then is anything delegated.
//
// IT REPORTS SILENCE AS LOUDLY AS IT REPORTS WORK. A session that handed nothing over and a
// session that had nothing to say produce the same empty space in an inbox, and the second is
// rare. Naming who did not report is the difference between a shift start and a mailbox.
'use strict';
require('./_run-log.cjs').record();

const db = require('../server/db');
db.setProcessActor('claude');

const team = require('../server/routes/team');
const board = require('../server/routes/board');

const PEEK = process.argv.includes('--peek');
const shiftArg = (() => {
  const i = process.argv.indexOf('--shift');
  return i >= 0 ? process.argv[i + 1] : null;
})();

const view = team.shiftView(shiftArg);
const rule = (s) => `\n${s}\n${'-'.repeat(s.length)}`;

console.log(`\n  SHIFT ${view.shift}`);

// ---- 1. the roster, and whether it can actually function
const roster = db.prepare('SELECT role, COUNT(*) n FROM team_sessions WHERE retired_at IS NULL GROUP BY role').all();
const have = Object.fromEntries(roster.map((r) => [r.role, r.n]));
if (!have.manager) {
  console.log('\n  NO MANAGER ON THE ROSTER. Nothing below can be confirmed, so nothing can be');
  console.log('  delegated, and no steering question can reach the owner. Read on, but the chain');
  console.log('  stops at "plan drafted" until that seat is filled.');
}

// ---- 2. handovers
console.log(rule(`HANDOVERS — ${view.handovers.length}`));
if (!view.handovers.length) {
  console.log('  None for this shift. That is NOT "a quiet shift" — it is no report at all, and');
  console.log('  the two look identical from here. Check whether the sessions ran.');
} else {
  for (const h of view.handovers) {
    console.log(`\n  ${h.title}  (${h.role}${h.project ? `, ${h.project}` : ''})  ${String(h.at).slice(11, 16)}`);
    const stated = ['done', 'blocked', 'next'].filter((k) => h[k]);
    const silentOn = ['done', 'blocked', 'next'].filter((k) => !h[k]);
    for (const k of stated) {
      const first = String(h[k]).split('\n').filter((l) => l.trim())[0];
      console.log(`    ${k.padEnd(10)} ${first.slice(0, 96)}`);
    }
    // NOT STATED is printed, because an absent field and a field saying "nothing" are
    // different reports and only one of them is reassuring.
    if (silentOn.length) console.log(`    not stated: ${silentOn.join(', ')}`);
  }
}

// ---- 3. silence
console.log(rule(`SILENT — ${view.silent.length} of ${(have.worker || 0) + (have.supervisor || 0) + (have.manager || 0)} on the roster`));
if (!view.silent.length) console.log('  Everyone on the roster reported.');
for (const s of view.silent) {
  console.log(`  ${s.title.padEnd(34)} ${s.role.padEnd(11)} last seen ${String(s.lastSeen).slice(0, 16).replace('T', ' ')}`);
}

// ---- 4. what must go to the owner, via the manager and nobody else
console.log(rule(`FOR THE OWNER — ${view.needsOwner.length}`));
if (!view.needsOwner.length) console.log('  Nothing this shift.');
for (const n of view.needsOwner) {
  console.log(`\n  item #${n.id} from ${n.from}${n.state === 'unsplit' ? ' (whole block; not safely split)' : ''}:`);
  for (const l of String(n.text).split('\n').filter((x) => x.trim()).slice(0, 4)) console.log(`    ${l.trim().slice(0, 96)}`);
}
if (view.needsOwner.length) {
  console.log('\n  These do NOT go to the owner from here. They go to the manager, who decides');
  console.log('  which of them is worth one of the day\'s steering questions.');
}

// Resolved items are SHOWN, not hidden. A question that got answered and one that was never
// raised must not look the same — and the manager needs to see that it does not have to ask.
if (view.needsOwnerResolved && view.needsOwnerResolved.length) {
  console.log(rule(`ALREADY RESOLVED — DO NOT ASK — ${view.needsOwnerResolved.length}`));
  for (const n of view.needsOwnerResolved) {
    console.log(`  item #${n.id} from ${n.from}: ${String(n.text).split('\n')[0].slice(0, 76)}`);
    console.log(`    resolved by ${n.by}: ${n.note}`);
  }
}

// ---- 5. what is blocked
console.log(rule(`BLOCKED — ${view.blocked.length}`));
if (!view.blocked.length) console.log('  Nothing reported blocked.');
for (const b of view.blocked) console.log(`  ${b.from}: ${String(b.text).split('\n')[0].slice(0, 92)}`);

// ---- 6. the work itself, from the one board
const b = board.summary();
console.log(rule(`OPEN WORK — ${b.counts.externalOpen + b.counts.backlogOpen}`));
for (const p of b.projects) {
  console.log(`  ${p.project.padEnd(18)} ${String(p.bugs).padStart(3)} bug  ${String(p.requests).padStart(3)} req  ${String(p.backlog).padStart(3)} backlog`);
}
const bad = b.sources.filter((s) => !s.exists || !s.lastRun || !s.lastRun.ok);
if (bad.length) {
  console.log(`\n  ${bad.length} tracker(s) could not be read — the figures above are missing them`);
  console.log('  entirely, and that is not the same as those projects being clear:');
  for (const s of bad) console.log(`    ${s.id}: ${s.lastRun ? s.lastRun.note : 'never imported'}`);
}
if (b.backlogError) console.log(`\n  THE BACKLOG COULD NOT BE READ: ${b.backlogError}`);

// ---- 7. steering still open
const steer = team.openSteering();
if (steer.length) {
  console.log(rule(`STEERING AWAITING THE OWNER — ${steer.length}`));
  for (const s of steer) console.log(`  asked ${String(s.asked_at).slice(0, 16).replace('T', ' ')}: ${s.question.slice(0, 88)}`);
}

// ---- 8. mark read, so an unread handover is a real finding rather than a guess
if (!PEEK && view.handovers.length) {
  const now = new Date().toISOString();
  const upd = db.prepare('UPDATE team_handovers SET read_at = ? WHERE id = ? AND read_at IS NULL');
  let n = 0;
  db.withTransaction(() => { for (const h of view.handovers) n += upd.run(now, h.id).changes; });
  console.log(`\n  ${n} handover(s) marked read. Run with --peek to look without marking.`);
}

console.log('\n  NEXT: draft a plan against the above, then have the manager confirm it.');
console.log('  Nothing can be delegated until it is — the API refuses an assignment whose plan');
console.log('  is unconfirmed, which is the one step of the chain a schema can actually enforce.\n');

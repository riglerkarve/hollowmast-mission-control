#!/usr/bin/env node
//
// team-roster.cjs — who is on the team, and in which role.
//
//   node tools/team-roster.cjs                 show the roster and what it is missing
//   node tools/team-roster.cjs --seed          write the sessions observed on 19 Aug 2026
//   node tools/team-roster.cjs --set "<title>" <role>
//
// ROLES ARE DEFINED BY WHAT THEY MAY INTERRUPT. See server/routes/team.js — worker and
// supervisor never interrupt the owner; the manager is the only role that may, and does it
// once a day as a steering quiz. So the roster is not decoration: it is the list of who is
// allowed to spend the owner's attention.
'use strict';
require('./_run-log.cjs').record();

const db = require('../server/db');
db.setProcessActor('claude');

const team = require('../server/routes/team');

// THIS IS A SNAPSHOT, taken from the session list on 19 Aug 2026 at 15:03 UTC, and it starts
// going out of date immediately. The first version was taken at 14:38 and was already wrong
// twenty minutes later: the session then called "User interface cleanup and flow" had been
// renamed "Team Manager", which filled the one seat whose absence I had just written up as
// the blocking question for the owner. Accurate is not current. Re-read the live list before
// trusting this, and treat --seed as a starting point rather than the roster.
//
// EVERY ROLE HERE IS `worker` EXCEPT THE ONE THAT SAYS OTHERWISE ON ITS OWN FACE. Deciding
// that "Admin Agent" is really a supervisor, or that "Opus 5 Ultra" outranks "Coding Agent",
// would be inventing a hierarchy and then presenting it as observed.
const OBSERVED = [
  ['local_7723327d-6070-4942-8898-8ff5f1d4488f', 'Team Supervisor', 'supervisor', 'HOLLOWMAST'],
  ['local_d09195ff-12fc-4c33-8c4a-eec2dc52a935', 'Team Manager', 'manager', 'HOLLOWMAST'],
  ['local_462a30cf-f135-4ab6-b8e5-9e2e849e5b17', 'Website Agent', 'worker', 'HOLLOWMAST'],
  ['local_e6147002-b16d-418d-b7c5-e4cbab587ed8', 'Coding Agent', 'worker', 'HOLLOWMAST'],
  ['local_b5f1fa28-7b83-4aa5-9053-9f2f7a55d2b4', 'Auto Play Agent', 'worker', 'HOLLOWMAST'],
  ['local_171e0ab1-14c5-4e8e-9f8f-8801c9f338b4', 'Admin Agent', 'worker', 'HOLLOWMAST'],
  ['local_4fda3b61-5a2c-491f-a0bb-712434ec38e1', 'use chr', 'worker', 'PrintProfit'],
  ['local_f5821e3b-6685-4be8-af3f-b2a579b1c02a', 'Opus 5 Ultra', 'worker', 'HOLLOWMAST'],
  ['local_8c1a5cb9-c59c-4b98-93b6-883cd3ad216a', 'Fable Ultra', 'worker', 'Mini Games'],
];

const args = process.argv.slice(2);

if (args[0] === '--seed') {
  const now = new Date().toISOString();
  const ins = db.prepare(`INSERT INTO team_sessions (id, title, role, project, first_seen, last_seen)
    VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title, role=excluded.role,
    project=excluded.project, last_seen=excluded.last_seen`);
  db.withTransaction(() => { for (const [id, title, role, project] of OBSERVED) ins.run(id, title, role, project, now, now); });
  console.log(`  seeded ${OBSERVED.length} sessions`);
} else if (args[0] === '--set') {
  const [, title, role] = args;
  if (!title || !team.ROLES.includes(role)) {
    console.log(`  usage: --set "<title>" <${team.ROLES.join('|')}>`);
    process.exit(2);
  }
  const info = db.prepare('UPDATE team_sessions SET role = ? WHERE title = ?').run(role, title);
  if (!info.changes) { console.log(`  no session titled "${title}"`); process.exit(1); }
  console.log(`  ${title} is now ${role}`);
}

const rows = db.prepare('SELECT * FROM team_sessions WHERE retired_at IS NULL ORDER BY role, title').all();
console.log('');
if (!rows.length) {
  console.log('  THE ROSTER IS EMPTY. That is not "no team" — it means nobody has been recorded.');
  console.log('  Run with --seed.');
  process.exit(1);
}

for (const r of rows) {
  console.log(`  ${r.role.padEnd(11)} ${r.title.padEnd(34)} ${r.project || ''}`);
}

// THE MISSING ROLE IS THE INTERESTING OUTPUT. A team with no manager is not a smaller team —
// it is a team in which nothing can be confirmed and nobody may reach the owner, so the whole
// chain stops at "plan drafted". Reporting the count would hide that; the role is named.
console.log('');
for (const role of team.CHAIN_ROLES) {
  const n = rows.filter((r) => r.role === role).length;
  if (n) { console.log(`  ${role}: ${n}`); continue; }
  console.log(`  ${role}: NONE — and that blocks the chain:`);
  if (role === 'manager') {
    console.log('    no plan can be confirmed, so nothing can be delegated, and no steering');
    console.log('    question can reach the owner. The manager is the only role permitted to');
    console.log('    interrupt him; with the seat empty, that channel is closed rather than open.');
  } else if (role === 'supervisor') {
    console.log('    nobody reads the handovers or drafts a plan, so the shift never starts.');
  } else {
    console.log('    nobody is doing the work.');
  }
}

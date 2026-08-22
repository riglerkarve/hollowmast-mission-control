#!/usr/bin/env node
//
// normalise-projects.cjs — make every project label in the database one of the names
// `server/routes/projects.js` declares.
//
//   node tools/normalise-projects.cjs           report only, writes nothing
//   node tools/normalise-projects.cjs --apply   write the changes
//
// WHY THIS EXISTS. On 23 Aug 2026 the owner asked for every session to work the whole
// workspace rather than only HOLLOWMAST. The blocker was not permission, it was vocabulary:
// `todo_items` held 27 rows under `mission-control` and 103 under `Mission Control`, 4 under
// `income-portfolio` and 7 under `PrintProfit`. To any query those are different projects, so
// "show me the open work on Mission Control" answered with three quarters of it and looked
// complete. A cross-project queue cannot be built on a vocabulary that has two words for one
// project — [[a-vocabulary-has-one-owner-too]], and the same one-owner rule the workspace
// applies to figures.
//
// THE MAPPING IS DERIVED, NEVER DECLARED. Every non-canonical label seen so far is a
// DIRECTORY name, and `PROJECTS` already carries `dir` beside `name`. So the fix is a join on
// data that already exists, not a hand-written table of aliases — a hand-written table would
// be a second place the truth lives, which is the defect this is repairing rather than a fix
// for it. Anything that does not match a declared `dir` (case-insensitively) is REPORTED AND
// LEFT ALONE. A normaliser that guesses is worse than one that skips: a wrong attribution is
// invisible afterwards, and the row still counts, just under someone else's name.
//
// NULL IS NOT A DEFECT AND IS NOT TOUCHED. 133 rows carry no project at all. That is missing
// data, and inventing an owner for it would turn "we do not know" into a confident wrong
// answer on 133 items at once. It is counted and reported so the gap stays visible.
'use strict';
require('./_run-log.cjs').record();

const db = require('../server/db');
db.setProcessActor('claude');

const { PROJECTS } = require('../server/routes/projects');

const APPLY = process.argv.includes('--apply');

// name -> itself, and dir -> name. Lower-cased keys, because the observed drift is
// `mission-control` against `Mission Control`, which differs in case as well as in the
// separator. The canonical NAME always wins a collision with a dir.
const byDir = new Map();
const canonical = new Set();
for (const p of PROJECTS) {
  canonical.add(p.name);
  if (p.dir) byDir.set(String(p.dir).toLowerCase(), p.name);
}
for (const p of PROJECTS) byDir.set(String(p.name).toLowerCase(), p.name);

// Every table that carries a project label. Add to this list rather than writing a second
// script; the point of the file is that one pass covers the vocabulary.
const TABLES = [
  ['todo_items', 'project'],
  ['team_sessions', 'project'],
  ['team_handovers', 'project'],
  ['board_items', 'project'],
  // `work_items` is deliberately NOT here. Checked 23 Aug 2026: its schema carries no project
  // column at all — it is the Scribe's tier queue, keyed on prompt and tier, and a job in it
  // is not attributed to a project. Listing it produced a COULD NOT LOOK line on every single
  // run, which is the alert you learn to dismiss: a permanent warning about a condition that
  // is correct trains the reader to skip the one that is not. If it ever gains a project
  // column, add it back and the line starts meaning something again.
];

let totalChanged = 0;
let totalSkipped = 0;
let totalNull = 0;

for (const [table, col] of TABLES) {
  // A table named here may not exist in every database this runs against — a migration that
  // has not been applied yet, or a table renamed. That is "could not look", and it must not
  // read the same as "nothing to change". See the fourth law.
  let rows;
  try {
    rows = db.prepare(`SELECT ${col} AS v, COUNT(*) AS n FROM ${table} GROUP BY ${col}`).all();
  } catch (e) {
    console.log(`\n${table}.${col}: COULD NOT LOOK — ${e.message}`);
    continue;
  }

  const changes = [];
  const skipped = [];
  let nulls = 0;

  for (const r of rows) {
    if (r.v === null || r.v === '') { nulls += r.n; continue; }
    if (canonical.has(r.v)) continue;                    // already right
    const to = byDir.get(String(r.v).toLowerCase());
    if (to && to !== r.v) changes.push([r.v, to, r.n]);
    else if (!to) skipped.push([r.v, r.n]);
  }

  console.log(`\n${table}.${col}: ${rows.length} distinct value(s)`);
  if (nulls) console.log(`  ${String(nulls).padStart(4)} row(s) carry no project — left as NULL, not guessed`);
  for (const [from, to, n] of changes) console.log(`  ${String(n).padStart(4)} ${from}  ->  ${to}`);
  // The residue. A filter that drops candidates has to say what it dropped and why, or the
  // surviving evidence looks cleaner than it is.
  for (const [v, n] of skipped) {
    console.log(`  ${String(n).padStart(4)} ${v}  ->  SKIPPED, matches no declared name or dir in projects.js`);
  }
  if (!changes.length && !skipped.length && !nulls) console.log('  all canonical');

  if (APPLY && changes.length) {
    const upd = db.prepare(`UPDATE ${table} SET ${col} = ? WHERE ${col} = ?`);
    db.withTransaction(() => { for (const [from, to] of changes) upd.run(to, from); });
  }

  totalChanged += changes.reduce((s, c) => s + c[2], 0);
  totalSkipped += skipped.reduce((s, c) => s + c[1], 0);
  totalNull += nulls;
}

console.log(`\n${APPLY ? 'APPLIED' : 'DRY RUN'}: ${totalChanged} row(s) ${APPLY ? 'renamed' : 'would be renamed'}`
  + `, ${totalSkipped} unmatched and left alone, ${totalNull} with no project at all.`);
if (!APPLY && totalChanged) console.log('Re-run with --apply to write.');

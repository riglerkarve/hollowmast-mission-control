#!/usr/bin/env node
//
// cross-review.cjs — have the OTHER engine review a commit.
//
//   node tools/cross-review.cjs <sha> [--repo Survive] [--author "Coding Agent"]
//   node tools/cross-review.cjs --uncommitted --repo Survive
//   node tools/cross-review.cjs <sha> --dry        decide and report, run nothing
//
// Owner's rules, 19 Aug 2026:
//   - a review by the SAME engine that wrote the code is REFUSED and recorded as not reviewed
//   - when the two engines disagree about a finding, the Team Manager arbitrates
//
// WHY REFUSING BEATS DEGRADING, since it is the non-obvious half: a same-engine review that
// finds nothing is indistinguishable from a clean bill of health, and it fails in the
// flattering direction -- the one nobody investigates. An explicit "not reviewed, no
// independent engine available" is an absence you can see and count. This tool therefore has
// THREE outcomes and never collapses them:
//
//   reviewed              it ran, and `findings` is a real number including zero
//   refused_same_engine   it deliberately did not run. NOT a pass.
//   could_not_run         it tried and failed. NOT a pass either, and not the same as above.
//
// It also proved its own worth before this file existed: the first Codex review of a Claude
// commit found a P1 where a saved response was reported to the owner as "Nothing was
// recorded", which would have made him send it again.
'use strict';
require('./_run-log.cjs').record();

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const db = require('../server/db');
db.setProcessActor('claude');

const team = require('../server/routes/team');

const WS = path.join(__dirname, '..', '..');
const argv = process.argv.slice(2);
const arg = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : null; };
const has = (n) => argv.includes(`--${n}`);

const REPO = arg('repo') || 'mission-control';
const DRY = has('dry');
const UNCOMMITTED = has('uncommitted');
const TARGET = UNCOMMITTED ? 'uncommitted' : argv.find((a) => /^[0-9a-f]{7,40}$/.test(a));
const AUTHOR = arg('author');

if (!TARGET) {
  console.log('\n  usage: node tools/cross-review.cjs <sha> [--repo NAME] [--author TITLE]');
  console.log('         node tools/cross-review.cjs --uncommitted --repo NAME\n');
  process.exit(2);
}

// THE BINARY IS NOT THE ONE ON PATH, and running the wrong one is not a harmless mistake.
// `~/.codex/.sandbox-bin/codex.exe` exists and runs, but is missing
// codex-windows-sandbox-setup.exe, so every command it tries fails -- and the model still
// writes a review. A review with no access to the diff produces confident prose about
// nothing, which is worse than no review. So the path is pinned and verified before use.
function codexBinary() {
  const local = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Local');
  const base = path.join(local, 'OpenAI', 'Codex', 'bin');
  if (!fs.existsSync(base)) return null;
  for (const d of fs.readdirSync(base)) {
    const exe = path.join(base, d, 'codex.exe');
    const helper = path.join(base, d, 'codex-windows-sandbox-setup.exe');
    // BOTH must be present. The helper's absence is what made the other copy useless.
    if (fs.existsSync(exe) && fs.existsSync(helper)) return exe;
  }
  return null;
}

// Who wrote it, and on what engine. Read from the roster where the author is known; the git
// author is only a name, and a name is not an engine.
function engineOf(title) {
  if (!title) return 'unknown';
  const row = db.prepare('SELECT engine FROM team_sessions WHERE title = ?').get(title);
  return (row && row.engine) || 'unknown';
}

const repoDir = path.join(WS, REPO);
if (!fs.existsSync(path.join(repoDir, '.git'))) {
  console.log(`\n  COULD NOT LOOK: ${REPO} is not a git repository at ${repoDir}\n`);
  process.exit(2);
}

const authorEngine = engineOf(AUTHOR);
const reviewerEngine = 'codex';
const shift = team.shiftLabel();

console.log('');
console.log(`  target   ${TARGET}  in ${REPO}`);
console.log(`  author   ${AUTHOR || '(not stated)'} -- engine ${authorEngine}`);
console.log(`  reviewer codex`);

const record = (outcome, findings, body, note) => {
  db.prepare(`INSERT INTO team_reviews
    (at, shift, target, repo, author, author_engine, reviewer, reviewer_engine, outcome, findings, body, note)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(new Date().toISOString(), shift, TARGET, REPO, AUTHOR || null, authorEngine,
      'codex', reviewerEngine, outcome, findings, body || null, note || null);
};

// ---------------------------------------------------------------- the independence check
// UNKNOWN IS NOT TREATED AS INDEPENDENT. An author whose engine nobody recorded must not be
// assumed to be Claude, because that assumption is precisely what would let a Codex-reviews-
// Codex pass through. Unknown blocks, and says how to fix itself.
if (authorEngine === reviewerEngine) {
  console.log('\n  REFUSED: the author and the reviewer are the same engine.');
  console.log('  This is NOT a pass. A same-engine review that finds nothing is');
  console.log('  indistinguishable from a clean bill of health, and it fails in the direction');
  console.log('  nobody investigates. Recorded as not reviewed.\n');
  if (!DRY) record('refused_same_engine', null, null, `author and reviewer both ${authorEngine}`);
  process.exit(1);
}
if (authorEngine === 'unknown') {
  console.log('\n  REFUSED: the author\'s engine is not recorded, so independence cannot be');
  console.log('  established. Unknown is not treated as independent -- assuming it would be');
  console.log('  exactly how a same-engine review slips through.');
  console.log(`  Fix: POST /api/team/roster with the author's title and engine.\n`);
  if (!DRY) record('refused_same_engine', null, null, 'author engine unknown; independence unprovable');
  process.exit(1);
}

const exe = codexBinary();
if (!exe) {
  console.log('\n  COULD NOT RUN: no Codex install found with its sandbox helper alongside it.');
  console.log('  Checked %LOCALAPPDATA%\\OpenAI\\Codex\\bin\\*\\codex.exe. This is a failure to');
  console.log('  look, not a clean review, and it is recorded as such.\n');
  if (!DRY) record('could_not_run', null, null, 'codex binary with helper not found');
  process.exit(2);
}
console.log(`  binary   ${exe}`);

if (DRY) {
  console.log('\n  DRY RUN: independence holds and the binary is present. Nothing was run.\n');
  process.exit(0);
}

// ------------------------------------------------------------------------------- run it
const args = ['review'];
if (UNCOMMITTED) args.push('--uncommitted');
else args.push('--commit', TARGET);

console.log('\n  running codex review... (this takes a few minutes)\n');
let out = '';
let ok = true;
try {
  out = execFileSync(exe, args, { cwd: repoDir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 15 * 60 * 1000 });
} catch (e) {
  // A non-zero exit still often carries the review on stdout, so keep it rather than
  // discarding the whole run -- but mark it, because a truncated review is not a clean one.
  out = String((e && e.stdout) || '') + String((e && e.stderr) || '');
  ok = false;
}

// Count findings the way Codex prints them: "- [P1] title -- file:line".
const findings = (out.match(/^\s*-\s*\[P[0-9]\]/gm) || []).length;
const bySeverity = {};
for (const m of out.matchAll(/^\s*-\s*\[(P[0-9])\]/gm)) bySeverity[m[1]] = (bySeverity[m[1]] || 0) + 1;

// A run whose output carries no review shape at all is NOT "no findings" -- it is a run that
// did not produce a review, and calling it clean is the failure this whole tool exists to
// avoid making.
const looksLikeAReview = /\[P[0-9]\]/.test(out) || /review/i.test(out.slice(-2000));
if (!looksLikeAReview) {
  console.log('  COULD NOT RUN: the output carries no review in it. Not recording this as');
  console.log('  "no findings" -- an empty result and a failed run must not look the same.\n');
  record('could_not_run', null, out.slice(0, 20000), 'output contained no review');
  process.exit(2);
}

record('reviewed', findings, out.slice(0, 200000), ok ? null : 'codex exited non-zero; output kept');

console.log(`  ${findings} finding(s)` + (Object.keys(bySeverity).length ? `  (${Object.entries(bySeverity).map(([k, v]) => `${k}:${v}`).join(', ')})` : ''));
for (const m of out.matchAll(/^\s*-\s*\[(P[0-9])\]\s*(.+)$/gm)) console.log(`    [${m[1]}] ${m[2].trim().slice(0, 100)}`);
console.log('');
console.log('  Recorded. EVERY FINDING IS A CANDIDATE until reproduced -- that is the house');
console.log('  rule and it does not change because a different model raised it. Where the two');
console.log('  engines disagree, the Team Manager arbitrates, and the arbitration records the');
console.log('  arbiter\'s engine so a lean toward its own side stays countable.');
console.log('');

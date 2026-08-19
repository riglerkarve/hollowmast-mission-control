#!/usr/bin/env node
//
// vanished.cjs — refuse a commit that silently deletes something HEAD has.
//
//   node tools/vanished.cjs --repo Survive          check what is staged right now
//   node tools/vanished.cjs --repo Survive --replay <sha>   test against a real past commit
//   node tools/vanished.cjs --repo Survive --allow  proceed anyway, having read the list
//
// THE FAILURE THIS EXISTS FOR IS MEASURED, NOT HYPOTHETICAL. Nine sessions share one working
// tree. A session reads a file, another session commits a change to it, and the first session
// then commits ITS whole-file copy — which silently reverts the second. Git raises nothing:
// the content is clean and there is no conflict to resolve.
//
// Counting `loadCareer` in src/65_save.js across HOLLOWMAST's own history on 19 Aug:
//
//   3185c3c 14:55  x1        8d12407 14:56  x0   <- gone
//   3691ebe 15:17  x1        5b951e9 15:18  x0   <- gone
//   40b508d 15:19  x1        d52f4a2 15:23  x0   <- gone
//   c731eb6 15:25  x1
//
// Three disappearances inside half an hour, each followed by a manual restore. One of the
// restoring commits is titled "the fifth restore of the same three files". Every one of those
// deletions passed review, because a commit that quietly drops a function looks exactly like
// a commit that does not.
//
// WHAT IT CHECKS: definitions present in HEAD and absent from what you are committing. No
// threshold, no heuristic about size — a name is either still there or it is not.
//
// IT BLOCKS, AND IT IS EASY TO PASS. Deliberate deletions are normal; I removed a function
// from this very workspace today on purpose. So it names exactly what is vanishing and takes
// --allow. A guard that cannot be waved through gets deleted, and takes its protection with
// it. A guard that reports nothing gets ignored, which is the same outcome more slowly.
'use strict';
require('./_run-log.cjs').record();

const path = require('node:path');
const { execFileSync } = require('node:child_process');

const WS = path.join(__dirname, '..', '..');
const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null; };
const has = (n) => argv.includes(`--${n}`);

const repo = flag('repo') || '.';
const replay = flag('replay');
const cwd = path.resolve(WS, repo);

const git = (...a) => execFileSync('git', a, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
const gitSafe = (...a) => { try { return git(...a); } catch { return null; } };

// Definitions, not every identifier. Matching every `name(` would flag ordinary call sites
// moving around and drown the real finding — the cry-wolf failure this repo keeps meeting.
const DEF_PATTERNS = [
  /\bfunction\s+([A-Za-z_$][\w$]*)/g,          // function foo
  /\bclass\s+([A-Za-z_$][\w$]*)/g,             // class Foo
  /^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/gm, // const foo =
  /^\s{2,}([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/gm,     // object/class method:  foo(a) {
  /^\s{2,}([A-Za-z_$][\w$]*)\s*:\s*(?:function|\()/gm, // foo: function / foo: (
];

// Names so common that their absence says nothing about intent.
const NOISE = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'class',
  'constructor', 'get', 'set', 'then', 'map', 'filter', 'forEach', 'push', 'test', 'i', 'j', 'n', 'x', 'y', 'e', 'r', 's', 'p']);

function defs(text) {
  const out = new Map();
  if (!text) return out;
  for (const re of DEF_PATTERNS) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const name = m[1];
      if (NOISE.has(name) || name.length < 3) continue;
      out.set(name, (out.get(name) || 0) + 1);
    }
  }
  return out;
}

// Which files, and what is the "before" and "after" for each.
let files = [];
let label;
if (replay) {
  // Replay a historical commit as if it were being made now. This is how the guard was proved
  // before it was inflicted on nine sessions: run it over the commits that actually did the
  // damage and confirm it fires, then over ordinary commits and confirm it does not.
  label = `replaying ${replay}`;
  const names = (gitSafe('diff-tree', '--no-commit-id', '--name-only', '-r', replay) || '').trim();
  files = names ? names.split(/\r?\n/) : [];
  files = files.map((f) => ({
    file: f,
    before: gitSafe('show', `${replay}^:${f}`),
    after: gitSafe('show', `${replay}:${f}`),
  }));
} else {
  label = 'staged changes';
  const names = (gitSafe('diff', '--cached', '--name-only') || '').trim();
  files = names ? names.split(/\r?\n/) : [];
  files = files.map((f) => ({
    file: f,
    before: gitSafe('show', `HEAD:${f}`),
    after: gitSafe('show', `:${f}`),          // the staged blob
  }));
}

console.log(`\n  ${repo}: ${label}, ${files.length} file(s)`);

if (!files.length) {
  // ABSENCE AND FAILURE MUST DIFFER. Nothing staged is a legitimate state; a git command that
  // failed is not, and both produce an empty list.
  const ok = gitSafe('rev-parse', '--git-dir');
  if (!ok) {
    console.log('  COULD NOT LOOK — this is not a git repository, or git failed. Nothing checked.\n');
    process.exit(2);
  }
  console.log('  Nothing staged. Looked, and there was nothing to check.\n');
  process.exit(0);
}

let lost = 0;
const report = [];
for (const f of files) {
  if (!/\.(js|cjs|mjs|ts)$/.test(f.file)) continue;      // definition patterns are JS-shaped
  if (f.before == null) continue;                         // new file: nothing can have vanished
  if (f.after == null) {
    report.push({ file: f.file, deletedFile: true, names: [] });
    continue;
  }
  const a = defs(f.before);
  const b = defs(f.after);
  const gone = [...a.keys()].filter((k) => !b.has(k));
  if (gone.length) { lost += gone.length; report.push({ file: f.file, names: gone }); }
}

if (!report.length) {
  console.log('  Nothing defined in HEAD has disappeared. Checked, and clean.\n');
  process.exit(0);
}

console.log(`\n  ${lost} definition(s) present in HEAD are ABSENT from this commit:\n`);
for (const r of report) {
  if (r.deletedFile) { console.log(`    ${r.file}  — the whole file is being deleted`); continue; }
  console.log(`    ${r.file}`);
  for (const n of r.names) console.log(`      ${n}`);
}

console.log('\n  If you meant to remove these, say so in the commit message and re-run with');
console.log('  --allow. If you did NOT, you are almost certainly committing a whole-file copy');
console.log('  that predates someone else\'s push: `git pull` (or re-read the file) and redo');
console.log('  your edit on top. That is how the same three files were reverted five times in');
console.log('  one afternoon, with nothing conflicting and nothing warning.\n');

if (has('allow')) {
  console.log('  --allow given: proceeding, and the list above is the record of what you chose.\n');
  process.exit(0);
}
process.exit(1);

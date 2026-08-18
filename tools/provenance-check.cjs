#!/usr/bin/env node
//
// provenance-check.cjs — every in-process database user must say who it is.
//
//   node tools/provenance-check.cjs      exits 1 if any caller is unattributed
//
// Backlog M58. On 18 Aug 60% of logged data accesses (1,431 of 2,402) read as 'unknown'.
// The cause was not the panels — all 16 already send X-MC-By — it was that no script
// calling require('../server/db') ever called setProcessActor, so every read a tool or the
// nightly briefing made was recorded against nobody.
//
// This exists because that gap is INVISIBLE. Adding a new tool that forgets the call does
// not error, does not warn, and produces a log that looks complete. The only symptom is a
// number quietly growing in a panel nobody reads twice.
//
// MY FIRST SWEEP FOR THIS MISSED FIVE FILES, including the Starling bank importer, because
// I grepped a narrower pattern than the one I reported. A filter that reports a clean result
// is the most dangerous kind, so this one prints its residue and its blind spots every run.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SKIP = new Set(['node_modules', '.git', 'server', 'public', 'data']);
const VALID = require('../server/provenance').VALID;

const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(cjs|js)$/.test(e.name)) files.push(p);
  }
})(ROOT);

const users = [];
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  // Anchored to a real binding, not a mention. The first version matched any occurrence of
  // the text and so flagged THIS FILE, whose header comment quotes the require it looks for.
  // A checker that cries wolf gets switched off, so the question is narrowed rather than the
  // result filtered: a comment line cannot match, because // precedes the keyword.
  if (!/^[ \t]*(?:const|let|var)\s+\w+\s*=\s*require\(['"][^'"]*server\/db['"]\)/m.test(src)) continue;
  const m = src.match(/setProcessActor\(\s*['"]([^'"]*)['"]\s*\)/);
  users.push({ file: path.relative(ROOT, f).split(path.sep).join('/'), actor: m ? m[1] : null });
}

const bad = users.filter((u) => !u.actor);
const invalid = users.filter((u) => u.actor && !VALID.includes(u.actor));

for (const u of users.sort((a, b) => a.file.localeCompare(b.file))) {
  const state = !u.actor ? 'UNATTRIBUTED' : VALID.includes(u.actor) ? u.actor : `NOT IN VOCABULARY: ${u.actor}`;
  console.log(`  ${String(state).padEnd(22)} ${u.file}`);
}

console.log(`\n  ${users.length} in-process database users, vocabulary: ${VALID.join(', ')}`);

// ABSENCE AND FAILURE MUST NOT LOOK THE SAME. Zero callers is not a clean bill of health
// here — this repo has always had importers and a briefing — it means the walk or the
// require pattern stopped matching, and a broken check that prints nothing reads as a pass.
if (users.length === 0) {
  console.log('  FOUND NOTHING TO CHECK. That is a broken check, not a clean result: the walk');
  console.log('  or the require pattern matched no files. Investigate before trusting this.');
  process.exitCode = 1;
} else if (bad.length || invalid.length) {
  console.log(`  ${bad.length} unattributed, ${invalid.length} outside the vocabulary.`);
  console.log('  Add db.setProcessActor(...) after the require. See server/provenance.js.');
  process.exitCode = 1;
} else {
  console.log('  All attributed, all inside the vocabulary.');
}

// WHAT THIS DOES NOT KEY ON, stated because a filter that hides its scope fails flatteringly:
console.log('\n  Blind to: a dynamic or computed require; a file that opens data/dashboard.db');
console.log('  directly with new DatabaseSync, bypassing server/db.js entirely; anything under');
console.log('  server/ or public/; and any caller outside this repository. It checks that the');
console.log('  call EXISTS, not that the actor chosen is the honest one for that script.');

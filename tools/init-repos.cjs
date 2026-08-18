#!/usr/bin/env node
//
// init-repos.cjs — give the unversioned projects version control, safely.
//
//   node tools/init-repos.cjs            report what it would do, change nothing
//   node tools/init-repos.cjs --apply    write .gitignore, init, and make the first commit
//
// Owner instruction, 18 Aug 2026: "add version control to other projects without".
//
// SIX PROJECTS HERE HAVE NO REPOSITORY, and the cost is not hypothetical: Mission Control's
// briefing reports project progress from git, so work in those directories is invisible rather
// than absent. Every count that mentions them has to caveat itself.
//
// THE IGNORE FILE IS WRITTEN BEFORE `git init`, IN THAT ORDER, and it is the whole safety
// property. thin-air and emberfall are ~100 MB each, almost entirely node_modules; initialising
// first and ignoring afterwards means the first `git add` either takes minutes and bloats the
// repository permanently, or it catches a credential that then lives in history forever. A
// secret committed once is committed for good.
//
// IT REFUSES RATHER THAN GUESSING when it finds something credential-shaped that is not covered
// by the ignore rules it is about to write. Better to stop and ask than to publish.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const WORKSPACE = path.join(__dirname, '..', '..');
const APPLY = process.argv.includes('--apply');

const TARGETS = ['.garage', 'thin-air', 'Fallow', 'emberfall', 'high-society-420-tycoon', 'SecondBrain', 'dropshipping'];

// Ignore rules by what the project actually is, detected rather than assumed.
const BASE = [
  '# Written by mission-control/tools/init-repos.cjs before `git init`, deliberately in that',
  '# order: ignoring after initialising risks the first commit capturing something permanent.',
  '',
  'node_modules/',
  'dist/',
  'build/',
  '.cache/',
  '',
  '# Credentials. Ignored before any could exist.',
  '.env',
  '.env.*',
  '*.key',
  '*.pem',
  '*-token.txt',
  '*-api-key.txt',
  '*secret*',
  '',
  '# OS and editor noise',
  'Thumbs.db',
  'Desktop.ini',
  '.DS_Store',
  '*.log',
  'logs/',
];

const UNREAL = ['', '# Unreal Engine — derived data, never committed', 'Binaries/', 'DerivedDataCache/',
  'Intermediate/', 'Saved/', '.vs/', '*.sln', '*.suo'];
const OBSIDIAN = ['', '# Obsidian workspace state, which is per-machine', '.obsidian/workspace*',
  '.obsidian/cache', '.trash/'];

// A file whose NAME suggests a secret and which the rules above would not catch.
const SUSPICIOUS = /(^|[._-])(secret|password|credential|token|apikey|api_key)([._-]|$)/i;

function run(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
}

const results = [];

for (const name of TARGETS) {
  const dir = path.join(WORKSPACE, name);
  if (!fs.existsSync(dir)) { results.push({ name, state: 'MISSING', detail: 'no such directory' }); continue; }

  const hasGit = fs.existsSync(path.join(dir, '.git'));
  const isUnreal = fs.existsSync(path.join(dir, 'Content')) || fs.readdirSync(dir).some((f) => f.endsWith('.uproject'));
  const isVault = fs.existsSync(path.join(dir, '.obsidian'));

  // Walk the tree, skipping the directories we are about to ignore, so this stays fast on
  // a 100 MB node_modules tree.
  const files = [];
  const skip = new Set(['node_modules', '.git', 'DerivedDataCache', 'Intermediate', 'Binaries', 'Saved', 'dist', 'build']);
  (function walk(d, depth) {
    if (depth > 6) return;
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (skip.has(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else files.push(path.relative(dir, p));
    }
  }(dir, 0));

  const risky = files.filter((f) => SUSPICIOUS.test(path.basename(f)));
  const bytes = files.reduce((a, f) => { try { return a + fs.statSync(path.join(dir, f)).size; } catch { return a; } }, 0);

  if (hasGit) { results.push({ name, state: 'SKIP', detail: 'already a repository' }); continue; }

  if (risky.length) {
    results.push({
      name,
      state: 'REFUSED',
      detail: `${risky.length} credential-shaped file(s): ${risky.slice(0, 3).join(', ')}`,
      note: 'Check these, add them to .gitignore, then re-run. Not initialising blind.',
    });
    continue;
  }

  const rules = BASE.concat(isUnreal ? UNREAL : [], isVault ? OBSIDIAN : []);

  if (!APPLY) {
    results.push({
      name,
      state: 'WOULD INIT',
      detail: `${files.length} file(s), ${(bytes / 1048576).toFixed(1)} MB`
        + (isUnreal ? ' [unreal rules]' : '') + (isVault ? ' [vault rules]' : ''),
    });
    continue;
  }

  try {
    const gi = path.join(dir, '.gitignore');
    const existing = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
    if (!existing.includes('init-repos.cjs')) {
      fs.writeFileSync(gi, (existing ? `${existing}\n\n` : '') + rules.join('\n') + '\n');
    }
    run(dir, ['init', '-q']);
    run(dir, ['add', '-A']);
    const staged = run(dir, ['diff', '--cached', '--name-only']).split('\n').filter(Boolean);
    // A first commit that swept in node_modules would be permanent. Check before committing.
    const leaked = staged.filter((f) => f.includes('node_modules/') || f.includes('DerivedDataCache/'));
    if (leaked.length) {
      results.push({ name, state: 'REFUSED', detail: `${leaked.length} ignored-path file(s) still staged`, note: 'The ignore did not take. Nothing committed.' });
      continue;
    }
    run(dir, ['-c', 'user.name=Claude', '-c', 'user.email=noreply@anthropic.com', 'commit', '-q', '-m',
      'Version control, so work here stops being invisible\n\n'
      + 'Mission Control reports project progress from git, so a directory with no\n'
      + 'repository shows as unmeasurable rather than quiet. .gitignore was written\n'
      + 'BEFORE git init, deliberately: ignoring afterwards risks the first commit\n'
      + 'capturing node_modules or a credential permanently.\n\n'
      + 'Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>']);
    const n = run(dir, ['ls-files']).split('\n').filter(Boolean).length;
    results.push({ name, state: 'DONE', detail: `${n} file(s) committed` });
  } catch (e) {
    results.push({ name, state: 'FAILED', detail: String(e.message).split('\n')[0].slice(0, 90) });
  }
}

console.log('');
for (const r of results) {
  console.log(`  ${r.state.padEnd(11)} ${r.name.padEnd(26)} ${r.detail}`);
  if (r.note) console.log(`              ${r.note}`);
}
const done = results.filter((r) => r.state === 'DONE').length;
const refused = results.filter((r) => r.state === 'REFUSED').length;
console.log('');
if (!APPLY) console.log('  Report only. Re-run with --apply to write .gitignore, init and commit.');
else console.log(`  ${done} initialised, ${refused} refused, ${results.filter((r) => r.state === 'SKIP').length} already had git.`);
if (refused) console.log('  REFUSED is not FAILED: something needs a human look before it is committed.');

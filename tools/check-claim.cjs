#!/usr/bin/env node
//
// check-claim.cjs — the facts behind a handover claim, in ten seconds instead of ten minutes.
//
//   node tools/check-claim.cjs 65_save.js loadCareer recordRun markDeath
//   node tools/check-claim.cjs site/support.html HM.support.kofi
//   node tools/check-claim.cjs src/70_game.js --project HOLLOWMAST
//
// WHAT THIS IS NOT, and the distinction is the whole design: it is NOT a claim checker. It
// never reads a handover, never decides whether a sentence is true, and never says a session
// was wrong. It reports what git and the file say, and the Manager draws the conclusion.
//
// THE VERSION I ORIGINALLY PROPOSED WAS MEASURED AND ABANDONED. The plan was to extract
// backticked paths out of each handover and flag the ones that do not resolve. Measured
// against the three real handovers: 37 path-shaped tokens, 20 "not found" — and all 20 were
// FALSE, because people write basenames (`65_save.js`) and the file is `src/65_save.js`.
// Resolving by basename instead: 36 of 36 resolve, ZERO findings. A checker producing twenty
// wrong answers, or none at all, is the cry-wolf failure this workspace keeps meeting.
//
// Worse, the example I used to justify it would not have been caught. The Manager killed a
// claim that Ko-fi could not take money by finding `HM.support.kofi` is NULL — a VALUE, not a
// missing file. No existence check can see that. So the tool follows what the Manager
// actually did: git tracking, HEAD-versus-worktree, symbol counts in BOTH, and the matching
// lines printed so a value can be read.
//
// HEAD AND THE WORKING TREE ARE REPORTED SEPARATELY, ALWAYS. Nine sessions share one checkout;
// "it is in the file" and "it is in the commit" are different facts, and the gap between them
// is exactly how work has been silently reverted here.
'use strict';
require('./_run-log.cjs').record();

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const WS = path.join(__dirname, '..', '..');
const PROJECTS = {
  HOLLOWMAST: 'Survive',
  'Mission Control': 'mission-control',
  PrintProfit: 'income-portfolio',
};
const SKIP = new Set(['node_modules', '.git', 'DerivedDataCache', 'Intermediate', 'Saved', 'backups', '_archive']);

const argv = process.argv.slice(2);
const projIdx = argv.indexOf('--project');
const wantProject = projIdx >= 0 ? argv[projIdx + 1] : null;
// GUARD THE ABSENT CASE. Written as `i !== projIdx + 1`, this dropped argv[0] whenever
// --project was absent, because indexOf returned -1 and -1 + 1 is 0 — a filter that is
// correct with the flag and silently eats the filename without it.
const drop = projIdx >= 0 ? new Set([projIdx, projIdx + 1]) : new Set();
const args = argv.filter((a, i) => !drop.has(i));
const target = args[0];
const symbols = args.slice(1);

if (!target) {
  console.log('\n  usage: node tools/check-claim.cjs <file> [symbol ...] [--project NAME]');
  console.log('  Reports git tracking, HEAD vs the working tree, and where each symbol appears.');
  console.log('  It reports facts. It does not judge a claim.\n');
  process.exit(2);
}

// Resolve the way people write: a basename is enough, a suffix is enough, a full path works.
function findFile(tok) {
  const roots = wantProject && PROJECTS[wantProject]
    ? [PROJECTS[wantProject]]
    : Object.values(PROJECTS);
  const hits = [];
  const base = tok.split('/').pop();
  for (const r of roots) {
    (function walk(dir, rel, depth) {
      if (depth > 7) return;
      let ents;
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        if (SKIP.has(e.name)) continue;
        const p = path.join(dir, e.name);
        const relp = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(p, relp, depth + 1);
        else if (e.name === base && (relp.endsWith(`/${tok}`) || relp === tok || base === tok)) {
          hits.push({ abs: p, rel: relp, repo: r, inRepo: relp.slice(r.length + 1) });
        }
      }
    }(path.join(WS, r), r, 0));
  }
  return hits;
}

const hits = findFile(target);

if (!hits.length) {
  console.log(`\n  COULD NOT FIND a file matching "${target}".`);
  console.log('  That is not "the claim is false" — it may be a path this tool does not search');
  console.log(`  (it looks under ${Object.values(PROJECTS).join(', ')}, skipping node_modules and build output),`);
  console.log('  or a file that has since been renamed. Check the spelling before concluding.\n');
  process.exit(1);
}
if (hits.length > 1) {
  console.log(`\n  ${hits.length} files match "${target}" — reporting all of them, because picking`);
  console.log('  one would be a guess about which the claim meant:');
  for (const h of hits) console.log(`    ${h.rel}`);
}

const git = (repo, ...a) => {
  try {
    return { ok: true, out: execFileSync('git', a, { cwd: path.join(WS, repo), encoding: 'utf8' }) };
  } catch (e) {
    return { ok: false, out: String((e && e.stderr) || (e && e.message) || e).slice(0, 200) };
  }
};

const countIn = (text, sym) => {
  if (!text) return 0;
  // Plain substring count. Deliberately not a word-boundary regex: symbols here are often
  // dotted (`HM.support.kofi`) or partial, and a cleverer matcher would silently disagree
  // with the grep the Manager would have run by hand.
  let n = 0; let i = 0;
  for (;;) { const j = text.indexOf(sym, i); if (j < 0) break; n += 1; i = j + sym.length; }
  return n;
};

for (const h of hits) {
  console.log(`\n  ${h.rel}`);

  const tracked = git(h.repo, 'ls-files', '--error-unmatch', h.inRepo);
  console.log(`    tracked in git : ${tracked.ok ? 'yes' : 'NO — this file is not in the repository'}`);

  const headBlob = git(h.repo, 'show', `HEAD:${h.inRepo}`);
  const work = fs.readFileSync(h.abs, 'utf8');

  if (!headBlob.ok) {
    console.log('    in HEAD        : NO — the file exists on disk but not in the last commit');
  } else {
    const same = headBlob.out === work;
    console.log(`    HEAD vs disk   : ${same ? 'identical' : 'DIFFERENT — the working tree has uncommitted changes'}`);
    if (!same) {
      const d = git(h.repo, 'diff', '--numstat', '--', h.inRepo);
      if (d.ok && d.out.trim()) console.log(`    diff (+/-)     : ${d.out.trim().split('\t').slice(0, 2).join(' added, ')} removed`);
    }
  }

  const last = git(h.repo, 'log', '-1', '--format=%h %ad %s', '--date=short', '--', h.inRepo);
  if (last.ok && last.out.trim()) console.log(`    last commit    : ${last.out.trim().slice(0, 96)}`);

  if (!symbols.length) continue;
  console.log('    symbol                          HEAD  disk');
  for (const s of symbols) {
    const inHead = headBlob.ok ? countIn(headBlob.out, s) : null;
    const inWork = countIn(work, s);
    const flag = inHead !== null && inHead !== inWork ? '   <- DIFFERS' : '';
    console.log(`      ${s.padEnd(30)} ${String(inHead === null ? '-' : inHead).padStart(4)}  ${String(inWork).padStart(4)}${flag}`);
  }

  // THE LINES THEMSELVES, because a count answers "is it there" and the Manager's job is
  // usually "what does it SAY". The Ko-fi claim turned on a value being null, and a count of
  // 1 would have looked like confirmation.
  for (const s of symbols) {
    const lines = work.split(/\r?\n/).map((l, i) => [i + 1, l]).filter(([, l]) => l.includes(s));
    if (!lines.length) continue;
    console.log(`    ${s} — on disk:`);
    for (const [n, l] of lines.slice(0, 5)) console.log(`      ${String(n).padStart(5)}: ${l.trim().slice(0, 92)}`);
    if (lines.length > 5) console.log(`      …and ${lines.length - 5} more`);
  }
}

console.log('\n  These are facts about git and the file. Whether they support the claim is a');
console.log('  judgement, and it stays with you.\n');

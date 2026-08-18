#!/usr/bin/env node
//
// memory-index-check.cjs — verify the second brain's index against the files on disk.
//
//   node tools/memory-index-check.cjs
//
// WHY THIS EXISTS. MEMORY.md is what loads at the start of every session, so a memory with
// no line in it is invisible — and invisibly so. Nothing errors, nothing looks wrong, and
// the lesson simply stops being known. That failure has no symptom, which is exactly the
// class this workspace keeps getting caught by, so it gets a check rather than care.
//
// Written after compacting the index (#M6), where a full rewrite of 132 lines could have
// dropped one silently. It is cheap; run it after ANY bulk edit of MEMORY.md.
'use strict';
require('./_run-log.cjs').record();

const fs = require('node:fs');
const path = require('node:path');

const DIR = process.env.MEMORY_DIR
  || 'C:/Users/jcwhi/.claude/projects/C--Users-jcwhi-Claude-Outputs/memory';

// The read limit the memory system enforces, and the level it starts warning at.
const HARD_KB = 24.4;
const WARN_KB = 17.1;

function main() {
  if (!fs.existsSync(DIR)) {
    console.error(`Memory directory not found:\n  ${DIR}`);
    console.error('Set MEMORY_DIR if it has moved. Refusing to report "all clear" on a');
    console.error('directory that could not be read — could-not-look is not looked-and-fine.');
    process.exit(2);
  }

  const indexPath = path.join(DIR, 'MEMORY.md');
  if (!fs.existsSync(indexPath)) {
    console.error(`No MEMORY.md in ${DIR} — every memory is currently unindexed.`);
    process.exit(1);
  }

  const raw = fs.readFileSync(indexPath, 'utf8');
  const bytes = Buffer.byteLength(raw);
  const kb = bytes / 1024;

  // Generated files (_notes.md, _flags.md) are excluded BY PREFIX. Naming them individually
  // is how _notes.md briefly became a 133rd "memory" when it was added.
  const onDisk = fs.readdirSync(DIR)
    .filter((f) => f.endsWith('.md') && f !== 'MEMORY.md' && !f.startsWith('_'));

  const lines = raw.split('\n').filter((l) => /^- \[/.test(l));
  const linked = lines.map((l) => (l.match(/\]\(([^)]+)\)/) || [])[1]).filter(Boolean);
  const linkedSet = new Set(linked);

  const unindexed = onDisk.filter((f) => !linkedSet.has(f));
  const dangling = [...linkedSet].filter((f) => !onDisk.includes(f));
  const dupes = linked.length - linkedSet.size;

  console.log(`  index   ${kb.toFixed(1)}KB of a ${HARD_KB}KB read limit`
    + `  (${(HARD_KB - kb).toFixed(1)}KB spare, ~${Math.floor((HARD_KB * 1024 - bytes) / 140)} more entries)`);
  console.log(`  entries ${lines.length} indexed · ${onDisk.length} files on disk`);

  // Capped, and the cap REPORTS ITSELF. An unbounded dump buried the one useful line under
  // 131 others the first time this ran; silently truncating instead would have been worse.
  const show = (list, max = 8) => {
    const head = list.slice(0, max).map((f) => `    ${f}`).join('\n');
    return list.length > max
      ? `${head}\n    …and ${list.length - max} more (${list.length} total)`
      : head;
  };

  const problems = [];
  if (unindexed.length) problems.push(`${unindexed.length} memory file(s) MISSING from the index — invisible at session start:\n${show(unindexed)}`);
  if (dangling.length) problems.push(`${dangling.length} index line(s) pointing at a file that does not exist:\n${show(dangling)}`);
  if (dupes) problems.push(`${dupes} duplicate index line(s)`);

  if (problems.length) {
    console.log('');
    problems.forEach((p) => console.log(`  FAIL  ${p}`));
    process.exitCode = 1;
    return;
  }

  // Distinguishes "looked and it was fine" from "found nothing", which is the whole point.
  console.log('  checked every file against every line: no gaps, no dangling, no duplicates');

  if (kb > WARN_KB) {
    console.log('');
    console.log(`  NOTE  above ${WARN_KB}KB. Not broken — the limit is ${HARD_KB}KB — but the`);
    console.log('        index grows ~140 bytes per memory, so this is a slope problem rather');
    console.log('        than a level one. Shortening hooks buys ~10%; only fewer entries or a');
    console.log('        shorter line format changes the trend.');
  }
}

main();

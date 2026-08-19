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

// THERE ARE TWO LIMITS AND THIS TOOL ONLY KNEW ABOUT ONE. Measured 19 Aug 2026: the index
// stood at 22.5KB and this printed "1.9KB spare, ~14 more entries" -- while the session that
// loaded it reported "MEMORY.md is 217 lines (limit: 200). Only part of it was loaded."
//
// The byte figure was correct. It was a correct answer to the narrower question, offered for
// the claim "the index fits", and the file was ALREADY being truncated on the other axis.
// Worse than useless: it read as headroom.
//
// So both are measured, and the report is driven by whichever BINDS FIRST. Spare capacity is
// never printed on one axis while the other is over -- that is the shape that hid this.
const HARD_LINES = 200;

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

  // Both index shapes: the markdown-link form, and the bare-filename form adopted 19 Aug.
  // Filtering on /^- \[/ alone reported 0 indexed and 200 files missing the moment the format
  // changed -- loud and correct, but it was the filter that was out of date, not the index.
  const lines = raw.split('\n').filter((l) => /^- \[/.test(l) || /^-\s+[A-Za-z0-9._-]+\.md\b/.test(l));
  // Three accepted shapes, in the order they were used:
  //   `- [Title](file.md) — hook`                  the original; wrote the title twice
  //   `- file.md — hook`                           19 Aug, to get under the SIZE limit
  //   `- file.md — hook  ·  file.md — hook`        19 Aug, to get under the LINE limit
  //
  // ONE ENTRY PER LINE IS NO LONGER THE UNIT, and this parser assumed it was: it took the
  // first filename on each line and reported the other 101 as missing from an index they
  // were sitting in. Loud and wrong, which is the right direction to be wrong in -- but the
  // count of INDEX LINES is now a different number from the count of ENTRIES, and conflating
  // them is what produced the false alarm.
  // BOTH FORMS ARE COLLECTED FROM EVERY LINE, never one form or the other. This used to read
  // `if (links.length) return links;` — an early return, so a line carrying a markdown link
  // was never searched for bare entries. The index is now MIXED: other sessions still append
  // in the link form while the packed lines use the bare form, and a freshly written memory
  // appended onto a link-form line was invisible to this check while sitting in the file in
  // plain sight. Whichever form is tested first silently decides what the other one gets.
  const linked = lines.flatMap((l) => [
    ...[...l.matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1]),
    ...[...l.matchAll(/([A-Za-z0-9._-]+\.md)\s+—/g)].map((m) => m[1]),
  ]).filter(Boolean);
  const linkedSet = new Set(linked);

  const unindexed = onDisk.filter((f) => !linkedSet.has(f));
  const dangling = [...linkedSet].filter((f) => !onDisk.includes(f));
  const dupes = linked.length - linkedSet.size;

  // Whole lines, counted the way the loader counts them: a trailing newline does not add one.
  const lineCount = raw.replace(/\n$/, '').split('\n').length;
  const overKb = kb > HARD_KB;
  const overLines = lineCount > HARD_LINES;

  console.log(`  index   ${kb.toFixed(1)}KB of ${HARD_KB}KB  ·  ${lineCount} lines of ${HARD_LINES}`);
  if (overKb || overLines) {
    // No "spare" figure here, deliberately. Once either axis is over, remaining room on the
    // other is not headroom -- it is the number that made this invisible for a day.
    console.log(`          OVER on ${[overKb && 'size', overLines && 'lines'].filter(Boolean).join(' and ')}.`);
  } else {
    const byKb = Math.floor((HARD_KB * 1024 - bytes) / 140);
    const byLines = HARD_LINES - lineCount;
    console.log(`          room for ~${Math.min(byKb, byLines)} more entries`
      + `  (${byKb} by size, ${byLines} by lines -- the smaller one is the real answer)`);
  }
  console.log(`  entries ${linked.length} indexed on ${lines.length} line(s) · ${onDisk.length} files on disk`);

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
    // NO EARLY RETURN. It used to return here, so a missing index line SUPPRESSED the
    // over-limit report entirely -- and the two failures arrive together, because adding
    // the entry that fixes the first is what tips the second. Whichever is tested first
    // silently decided what you were told about the other.
  } else {
    // Distinguishes "looked and it was fine" from "found nothing", which is the whole point.
    console.log('  checked every file against every line: no gaps, no dangling, no duplicates');
  }

  // OVER THE LIMIT IS NOT A NOTE. Above HARD_KB the index is being TRUNCATED when a session
  // loads it: entries past the cut are silently absent, which is the one failure a memory
  // index must never have. This branch has to come first, because the warning branch below
  // fires for this case too and describes it as a slope problem.
  if (overKb || overLines) {
    if (overKb) console.log(`  OVER    ${(kb - HARD_KB).toFixed(1)}KB past the ${HARD_KB}KB read limit.`);
    if (overLines) console.log(`  OVER    ${lineCount - HARD_LINES} lines past the ${HARD_LINES}-line limit.`);
    console.log('  MEMORY.md is being truncated at session start. Entries past the cut are');
    console.log('  invisible to a new session -- present on disk, absent from the index it reads.');
    console.log('');
    if (overLines && !overKb) {
      // The two overflows have DIFFERENT fixes, and prescribing the wrong one wastes a day.
      console.log('  Shortening hooks cannot fix a LINE overflow -- a shorter line is still a');
      console.log('  line. Only two things move this number: fewer entries (consolidate related');
      console.log('  memories into one file), or fewer non-entry lines. Count the prose in the');
      console.log('  header first: it is the cheapest thing to move out into its own memory.');
    } else {
      console.log('  Trimming hooks will not fix it. Each line carries the title TWICE, once as');
      console.log('  text and once as the filename, which is about 45 bytes an entry of pure');
      console.log('  duplication; even zero-length hooks leave roughly 21KB. It needs fewer');
      console.log('  entries -- consolidation -- or a line format that does not repeat the title.');
    }
    process.exitCode = 1;
  } else
  if (kb > WARN_KB) {
    console.log('');
    console.log(`  NOTE  above ${WARN_KB}KB. Not broken — the limit is ${HARD_KB}KB — but the`);
    console.log('        index grows ~140 bytes per memory, so this is a slope problem rather');
    console.log('        than a level one. Shortening hooks buys ~10%; only fewer entries or a');
    console.log('        shorter line format changes the trend.');
  }
}

main();

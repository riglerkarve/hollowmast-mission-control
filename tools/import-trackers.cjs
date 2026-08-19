#!/usr/bin/env node
//
// import-trackers.cjs — mirror each project's own bug/request tracker into the board.
//
//   node tools/import-trackers.cjs           read the trackers, report, write
//   node tools/import-trackers.cjs --dry     parse and report, write nothing
//
// The trackers are never modified. This reads them.
'use strict';
require('./_run-log.cjs').record();

const db = require('../server/db');
// Bulk rows read out of files this repo does not own. Same category as the statement importers.
db.setProcessActor('import');

require('../server/routes/board');          // creates the tables via its migration
const { SOURCES, importAll } = require('../server/trackers');
const fs = require('node:fs');

const DRY = process.argv.includes('--dry');

if (DRY) {
  console.log('\n  DRY RUN — parsing only, nothing written\n');
  for (const s of SOURCES) {
    if (!s.exists()) {
      console.log(`  COULD NOT LOOK  ${s.id}: no file at ${s.file}`);
      console.log('                  That is not "no bugs". Nothing was changed.\n');
      continue;
    }
    const r = s.parse(fs.readFileSync(s.file, 'utf8'));
    const open = r.items.filter((i) => i.status === 'open').length;
    const unknown = r.items.filter((i) => i.status === 'unknown').length;
    console.log(`  ${s.id}  (${s.project})`);
    console.log(`    ${r.items.length} entries · ${open} open · ${unknown} unknown · ${r.conflicts} section/meta conflicts`);
    console.log(`    ${r.note}`);
    if (r.skipped.length) {
      console.log(`    RESIDUE — ${r.skipped.length} entr(ies) the parser could not settle:`);
      for (const s2 of r.skipped.slice(0, 6)) console.log(`      ${s2}`);
      if (r.skipped.length > 6) console.log(`      …and ${r.skipped.length - 6} more`);
    }
    console.log('');
  }
  process.exit(0);
}

const res = importAll(db);
console.log('');
let failed = 0;
for (const s of res.sources) {
  if (!s.ok) {
    failed += 1;
    console.log(`  COULD NOT LOOK  ${s.source}: ${s.note}`);
    console.log('                  Existing rows for this source were LEFT ALONE — an unreadable');
    console.log('                  tracker must never render as "no open bugs".');
    continue;
  }
  console.log(`  ${s.source}: ${s.parsed} parsed, ${s.skipped} unsettled, ${s.conflicts} conflicts`);
  console.log(`    ${s.note}`);
  for (const r of s.residue) console.log(`      · ${r}`);
}

// Read back out of the database rather than trusting the return value of the write.
const back = db.prepare(`SELECT project, status, COUNT(*) n FROM board_items
                         GROUP BY project, status ORDER BY project, n DESC`).all();
console.log('\n  held on the board:');
for (const r of back) console.log(`    ${String(r.n).padStart(3)}  ${r.project}  ${r.status}`);

console.log('\n  The trackers were not modified. This is a mirror; they remain the place to write.');
process.exitCode = failed ? 1 : 0;

#!/usr/bin/env node
//
// read-ods.cjs — dump an OpenDocument spreadsheet as text, with no dependencies.
//
//   node tools/read-ods.cjs <file.ods> [sheet-name] [max-cell-chars]
//
// Written 17 Aug 2026 to read the backlog out of "claude todo - MERGED 2026-08-17.ods"
// on the Desktop. Kept because the user works in .ods and this machine has no Python,
// and because the two obvious alternatives are both wrong here:
//
//   - LibreOffice --convert-to csv exports only the FIRST sheet. That workbook has
//     seven, and the one you want is rarely first. It fails by giving you a real CSV
//     of the wrong data, which is the failure mode nobody investigates.
//   - A regex over content.xml that splits on <table:table-cell> loses column
//     alignment, because ODS does not emit repeated cells: it writes one cell with
//     table:number-columns-repeated="8". Ignore that and every row after the first
//     empty run is shifted left, silently.
//
// So this expands both repeat attributes, which is the whole reason it exists.
//
// Node has no zip reader built in, so content.xml comes out via unzip(1), which is
// present in Git Bash. If that ever stops being true this needs a real zip reader.

const { execFileSync } = require('node:child_process');

const file = process.argv[2];
const wanted = process.argv[3] || null;
const maxCell = Number(process.argv[4] || 400);

if (!file) {
  console.error('usage: node tools/read-ods.cjs <file.ods> [sheet-name] [max-cell-chars]');
  process.exit(2);
}

let xml;
try {
  xml = execFileSync('unzip', ['-p', file, 'content.xml'], {
    maxBuffer: 128 * 1024 * 1024, encoding: 'utf8',
  });
} catch (err) {
  // Absence and failure must look different: a missing file, a file that is not a zip,
  // and a sheet with no rows are three different answers and must not all print nothing.
  console.error(`could not read content.xml from ${file}: ${err.message}`);
  process.exit(1);
}

const unesc = (s) => s.replace(/<[^>]+>/g, '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
  .replace(/&amp;/g, '&');   // last, or an &amp;lt; decodes twice

function cellText(inner) {
  const ps = [...inner.matchAll(/<text:p[^>]*>([\s\S]*?)<\/text:p>/g)].map((m) => unesc(m[1]));
  return ps.length ? ps.join(' | ').trim() : '';
}

const tables = [...xml.matchAll(/<table:table [^>]*table:name="([^"]*)"[^>]*>([\s\S]*?)<\/table:table>/g)];
if (!tables.length) {
  console.error('no sheets found — is this an .ods file?');
  process.exit(1);
}

const names = tables.map((t) => t[1]);
if (wanted && !names.includes(wanted)) {
  console.error(`no sheet named "${wanted}". Sheets present: ${names.join(', ')}`);
  process.exit(1);
}

for (const [, name, body] of tables) {
  if (wanted && name !== wanted) continue;

  const rows = [];
  const rowRe = /<table:table-row([^>]*)(?:\/>|>([\s\S]*?)<\/table:table-row>)/g;
  let rm;
  while ((rm = rowRe.exec(body))) {
    const rRep = Math.min(Number((/table:number-rows-repeated="(\d+)"/.exec(rm[1] || '') || [, 1])[1]), 2000);
    const cells = [];
    const cellRe = /<table:(?:covered-)?table-cell([^>]*)(?:\/>|>([\s\S]*?)<\/table:(?:covered-)?table-cell>)/g;
    let cm;
    while ((cm = cellRe.exec(rm[2] || ''))) {
      const attrs = cm[1] || '';
      const cRep = Math.min(Number((/table:number-columns-repeated="(\d+)"/.exec(attrs) || [, 1])[1]), 1000);
      let txt = cm[2] ? cellText(cm[2]) : '';
      if (!txt) {
        const v = /office:value="([^"]*)"/.exec(attrs);
        if (v) txt = v[1];
      }
      if (txt.length > maxCell) txt = `${txt.slice(0, maxCell)}…[+${txt.length - maxCell}]`;
      for (let i = 0; i < cRep; i++) cells.push(txt);
    }
    // Trailing empties are padding to the sheet's used width, not data.
    while (cells.length && cells[cells.length - 1] === '') cells.pop();
    for (let i = 0; i < rRep; i++) rows.push(cells.slice());
  }
  while (rows.length && rows[rows.length - 1].length === 0) rows.pop();

  console.log(`\n########## SHEET: ${name}  (${rows.length} rows) ##########`);
  rows.forEach((r, i) => console.log(r.length ? `[${i}] ${r.map((c) => c.replace(/\s+/g, ' ')).join(' ¦ ')}` : `[${i}] --`));
}

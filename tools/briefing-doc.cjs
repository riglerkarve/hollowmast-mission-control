#!/usr/bin/env node
//
// briefing-doc.cjs — turn the day's briefing into a document you can open, print or file.
//
//   node tools/briefing-doc.cjs              today
//   node tools/briefing-doc.cjs 2026-08-17   a specific day
//
// The briefing has always written markdown, which is right for a machine and for a terminal
// and is not a thing anyone reads on paper or keeps in a folder. This renders it to PDF via
// LibreOffice, which is already on this machine — there is no Python here and adding a
// markdown library for one file would be a dependency for a formatting job.
//
// IT REPORTS EVERY LINE IT DID NOT UNDERSTAND, and that is the reason this file is longer than
// a regex chain. A renderer that silently drops a construct produces a document that looks
// complete and is missing a section, which is exactly the failure mode this project keeps
// finding: the output is plausible, nothing errors, and nobody checks. Unrecognised lines are
// passed through as plain text AND counted, so a briefing that grows a new construct shows up
// as a number rather than as a gap.
'use strict';
require('./_run-log.cjs').record();

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const day = (process.argv[2] || new Date().toISOString().slice(0, 10));
const SRC = path.join(ROOT, 'reports', `${day}.md`);
const OUT_DIR = path.join(ROOT, 'reports');

if (!fs.existsSync(SRC)) {
  console.log(`\n  COULD NOT LOOK: no briefing at reports/${day}.md`);
  console.log('  Run: node scripts/briefing.cjs');
  console.log('  That is a missing input, not an empty briefing.');
  process.exit(2);
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Inline: bold, italic, code. Applied after escaping so the markers cannot inject markup.
function inline(s) {
  return esc(s)
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/`([^`]+)`/g, '<span class="code">$1</span>')
    .replace(/(^|\s)_([^_]+)_(\s|$)/g, '$1<i>$2</i>$3');
}

const lines = fs.readFileSync(SRC, 'utf8').split(/\r?\n/);
const out = [];
const unknown = [];
let inList = false;
let table = null;

function closeList() { if (inList) { out.push('</ul>'); inList = false; } }
function closeTable() {
  if (!table) return;
  const [head, ...body] = table;
  out.push('<table>');
  out.push('<tr>' + head.map((c) => `<th>${inline(c)}</th>`).join('') + '</tr>');
  for (const r of body) out.push('<tr>' + r.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>');
  out.push('</table>');
  table = null;
}

for (let i = 0; i < lines.length; i += 1) {
  const raw = lines[i];
  const l = raw.trim();

  if (!l) { closeList(); closeTable(); continue; }

  // Table rows. The separator row (|---|---|) is structure, not content.
  if (/^\|/.test(l)) {
    closeList();
    const cells = l.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
    if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue;
    if (!table) table = [];
    table.push(cells);
    continue;
  }
  closeTable();

  if (/^#{1,4} /.test(l)) {
    closeList();
    const level = l.match(/^#+/)[0].length;
    out.push(`<h${level}>${inline(l.replace(/^#+\s*/, ''))}</h${level}>`);
    continue;
  }
  if (/^[-*] /.test(l)) {
    if (!inList) { out.push('<ul>'); inList = true; }
    out.push(`<li>${inline(l.replace(/^[-*]\s*/, ''))}</li>`);
    continue;
  }
  if (/^> /.test(l)) { closeList(); out.push(`<blockquote>${inline(l.slice(2))}</blockquote>`); continue; }
  if (/^(---|___|\*\*\*)$/.test(l)) { closeList(); out.push('<hr>'); continue; }

  // Anything else is prose. Recognised as prose ON PURPOSE, but a line that starts with a
  // character we have no rule for is worth counting rather than assuming.
  if (/^[^A-Za-z0-9_£$"'(]/.test(l)) unknown.push({ n: i + 1, text: l.slice(0, 70) });
  out.push(`<p>${inline(l)}</p>`);
}
closeList();
closeTable();

const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>Briefing ${day}</title>
<style>
  @page { size: A4; margin: 18mm 16mm; }
  body { font-family: "Georgia", serif; font-size: 10.5pt; line-height: 1.45; color: #1a1a1a; }
  h1 { font-size: 20pt; margin: 0 0 2mm 0; border-bottom: 2px solid #333; padding-bottom: 2mm; }
  h2 { font-size: 13pt; margin: 7mm 0 2mm 0; color: #000; }
  h3 { font-size: 11pt; margin: 5mm 0 1mm 0; }
  ul { margin: 1mm 0 2mm 5mm; padding: 0; }
  li { margin: 0.6mm 0; }
  p  { margin: 1.5mm 0; }
  table { border-collapse: collapse; margin: 2mm 0 3mm 0; width: 100%; font-size: 9.5pt; }
  th, td { border: 1px solid #bbb; padding: 1.2mm 2mm; text-align: left; vertical-align: top; }
  th { background: #eee; }
  blockquote { margin: 2mm 0 2mm 4mm; padding-left: 3mm; border-left: 2px solid #999; color: #444; }
  hr { border: none; border-top: 1px solid #ccc; margin: 4mm 0; }
  .code { font-family: "Consolas", monospace; font-size: 9pt; background: #f2f2f2; padding: 0 1mm; }
  .foot { margin-top: 8mm; padding-top: 2mm; border-top: 1px solid #ccc; font-size: 8pt; color: #666; }
</style></head><body>
${out.join('\n')}
<p class="foot">Generated from reports/${day}.md by tools/briefing-doc.cjs.
Every figure in it is computed from the Mission Control database; nothing here is typed.</p>
</body></html>`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'briefdoc-'));
const htmlPath = path.join(tmp, `briefing-${day}.html`);
fs.writeFileSync(htmlPath, html, 'utf8');

const soffice = ['C:/Program Files/LibreOffice/program/soffice.exe',
  'C:/Program Files (x86)/LibreOffice/program/soffice.exe'].find((p) => fs.existsSync(p));

if (!soffice) {
  console.log('\n  COULD NOT CONVERT: LibreOffice was not found at either usual path.');
  console.log(`  The HTML is still readable at ${htmlPath}`);
  process.exit(2);
}

try {
  execFileSync(soffice, ['--headless', '--convert-to', 'pdf', '--outdir', OUT_DIR, htmlPath],
    { stdio: 'pipe', timeout: 120000 });
} catch (e) {
  console.log(`\n  COULD NOT CONVERT: ${String(e.message).split('\n')[0]}`);
  process.exit(2);
}

const pdf = path.join(OUT_DIR, `briefing-${day}.pdf`);
if (!fs.existsSync(pdf)) {
  console.log('\n  LibreOffice reported success but wrote no PDF.');
  console.log('  Reporting that rather than treating a missing file as a clean run.');
  process.exit(2);
}

const kb = Math.round(fs.statSync(pdf).size / 1024);
console.log(`\n  ${path.relative(ROOT, pdf)}  ${kb} KB`);
console.log(`  from ${lines.length} lines of markdown: ${out.filter((l) => /^<h/.test(l)).length} headings, `
  + `${out.filter((l) => l === '<table>').length} tables, ${out.filter((l) => /^<li>/.test(l)).length} bullets`);

if (unknown.length) {
  console.log(`\n  ${unknown.length} line(s) had no matching rule and were rendered as plain prose:`);
  for (const u of unknown.slice(0, 6)) console.log(`    line ${u.n}: ${u.text}`);
  console.log('  Nothing was dropped. Listed so a new construct is noticed rather than lost.');
}

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ }

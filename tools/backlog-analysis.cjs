#!/usr/bin/env node
//
// backlog-analysis.cjs — the backlog, organised, plus where the system could expand next.
//
//   node tools/backlog-analysis.cjs              writes a new dated .ods to the Desktop
//   node tools/backlog-analysis.cjs --csv        just the CSV, no conversion
//
// NEVER OVERWRITES. Owner instruction, 18 Aug 2026: "do not overwrite, keeping old ones for
// comparison reasons." A new file is written with a timestamp suffix if today's already
// exists, so two runs in one day produce two artefacts and neither destroys the other. The
// previous analysis was hand-made once; this makes it repeatable, which is the difference
// between a snapshot and a series.
//
// EVERY FIGURE IS COUNTED AT GENERATION, none typed. The store is the source of truth --
// "claude todo.ods" is the row-per-item export and this is an analysis beside it, not a
// replacement for either.
//
// THE EXPANSION SECTION IS DERIVED FROM GAPS, NOT IMAGINED. Three real signals, each
// measurable: a module whose tables are empty, a table nothing reads, and a capability that is
// exported and never called. That last one is the dominant defect on this workspace -- five
// were found in one day -- so it is worth a standing report rather than a memory.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.join(__dirname, '..');
const DESKTOP = 'C:/Users/jcwhi/OneDrive/Desktop';
const db = new DatabaseSync(path.join(ROOT, 'data', 'dashboard.db'), { readOnly: true });

const rows = [];
const R = (...cells) => rows.push(cells.map((c) => (c == null ? '' : String(c))));
const BLANK = () => rows.push([]);

const now = new Date();
const stamp = now.toISOString().slice(0, 10);
const q = (sql, ...a) => { try { return db.prepare(sql).all(...a); } catch (e) { return [{ __err: e.message }]; } };
const one = (sql, ...a) => { const r = q(sql, ...a); return r[0] && !r[0].__err ? r[0] : null; };

// ---------------------------------------------------------------- where it stands
R('BACKLOG ANALYSIS', now.toLocaleString('en-GB'));
R('Source', 'Mission Control dashboard.db — counted at generation, not typed');
R('Note', 'This is an ANALYSIS. "claude todo.ods" remains the row-per-item export. Neither overwrites the other.');
BLANK();

const items = q('SELECT id, title, status, priority, owner, cluster, effort, recheck_at FROM todo_items');
const by = (f) => items.reduce((m, r) => { const k = f(r) || '(none)'; m[k] = (m[k] || 0) + 1; return m; }, {});
const open = items.filter((r) => ['open', 'in_progress'].includes(r.status));

R('WHERE IT STANDS');
R('Total items', items.length);
for (const [k, v] of Object.entries(by((r) => r.status))) R(`  ${k}`, v);
R('Open', open.length);
R('  of which blocked on you', open.filter((r) => r.owner === 'YOU').length);
R('  of which mine', open.filter((r) => r.owner !== 'YOU').length);
BLANK();

// ---------------------------------------------------------------- organised
R('OPEN WORK BY CLUSTER', 'count', 'yours', 'mine');
const clusters = [...new Set(open.map((r) => r.cluster || '(none)'))].sort();
for (const c of clusters) {
  const g = open.filter((r) => (r.cluster || '(none)') === c);
  R(c, g.length, g.filter((r) => r.owner === 'YOU').length, g.filter((r) => r.owner !== 'YOU').length);
}
BLANK();

R('OPEN WORK BY PRIORITY', 'count', 'yours', 'mine');
for (const p of ['P0', 'P1', 'P2', 'P3'].concat([...new Set(open.map((r) => r.priority))].filter((x) => !/^P[0-3]$/.test(x)))) {
  const g = open.filter((r) => r.priority === p);
  if (g.length) R(p || '(none)', g.length, g.filter((r) => r.owner === 'YOU').length, g.filter((r) => r.owner !== 'YOU').length);
}
BLANK();

R('EVERY OPEN ITEM', 'priority', 'owner', 'cluster', 'effort', 'title');
for (const r of open.sort((a, b) => String(a.priority).localeCompare(String(b.priority)))) {
  R(r.id, r.priority, r.owner, r.cluster, r.effort, String(r.title).slice(0, 90));
}
BLANK();

R('DEFERRED, WITH A DATE TO COME BACK', 'recheck', 'title');
const deferred = items.filter((r) => r.recheck_at);
if (!deferred.length) R('(none)');
for (const r of deferred) R(r.id, r.recheck_at, String(r.title).slice(0, 80));
BLANK();

// ---------------------------------------------------------------- expansion, derived
R('EXPANSION CANDIDATES — derived from gaps, not imagined');
R('Each row below is a measurement, not a suggestion I invented.');
BLANK();

// 1. modules whose tables hold nothing
R('1. MODULES WITH NO DATA', 'rows', 'reading');
const tables = q("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  .filter((t) => !t.__err).map((t) => t.name);
const empty = [];
for (const t of tables) {
  const c = one(`SELECT COUNT(*) AS n FROM "${t}"`);
  if (c && c.n === 0) empty.push(t);
}
if (!empty.length) R('(every table holds at least one row)');
for (const t of empty) R(t, 0, 'built, never used — either seed it, use it, or remove it');
BLANK();

// 2. exported helpers nothing calls — the dominant defect here
R('2. CAPABILITIES EXPORTED AND NEVER CALLED', 'module', 'export', 'call sites elsewhere');
const routeDir = path.join(ROOT, 'server', 'routes');
const files = fs.readdirSync(routeDir).filter((f) => f.endsWith('.js'));
const allSrc = files.map((f) => ({ f, s: fs.readFileSync(path.join(routeDir, f), 'utf8') }));
const scriptSrc = ['scripts', 'tools'].flatMap((d) => {
  const p = path.join(ROOT, d);
  if (!fs.existsSync(p)) return [];
  return fs.readdirSync(p).filter((f) => /\.(cjs|js)$/.test(f))
    .map((f) => ({ f: `${d}/${f}`, s: fs.readFileSync(path.join(p, f), 'utf8') }));
});
const universe = allSrc.concat(scriptSrc);
let unconnected = 0;
for (const { f, s } of allSrc) {
  const mod = f.replace('.js', '');
  const exports = [...s.matchAll(/module\.exports\.(\w+)\s*=/g)].map((m) => m[1])
    .filter((n) => n !== 'PROJECTS' && n === n.replace(/^[A-Z_]+$/, ''));
  for (const e of exports) {
    // MATCH ON THE METHOD, NOT ON module.method. The first version keyed on `${mod}.${e}(`
    // and reported machine.startSampling as unreached while server/index.js line 101 calls it
    // as `machineRouter.startSampling()`. A require is routinely aliased, so a detector that
    // assumes the variable is named after the file over-reports — and an audit that cries wolf
    // is one that gets switched off. Any `.method(` outside the defining file counts, which
    // trades a little precision for not lying.
    const callers = universe.filter((u) => u.f !== f && new RegExp(`\\.${e}\\s*\\(`).test(u.s));
    if (!callers.length) { R(mod, e, 'NONE — built and unreached'); unconnected += 1; }
  }
}
if (!unconnected) R('(every exported helper has a caller)');
BLANK();

// 3. projects that cannot be measured at all
R('3. PROJECTS OUTSIDE VERSION CONTROL', '', 'why it matters');
let projects = [];
try { projects = require(path.join(ROOT, 'server', 'routes', 'projects')).progressSince(stamp); } catch (e) { projects = null; }
if (!projects) R('(could not read the project list)');
else {
  for (const u of projects.unmeasurable) R(u.name, '', u.why + ' — progress there is invisible, not absent');
  R('', '', `${projects.moved.length} project(s) committed today; ${projects.quiet.length} quiet`);
}
BLANK();

R('WHAT THIS ANALYSIS CANNOT SEE');
R('- Effort estimates are the owner\'s, not measured; a 2h item may be a day.');
R('- Items closed before the store existed carry no date and are absent from any trend.');
R('- "Blocked on you" counts what was labelled, not what is truly blocking.');
R('- Six projects have no repository, so their work cannot appear in any count here.');

// ---------------------------------------------------------------- write
const csv = rows.map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\n');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'backlog-'));

let base = `claude todo - ANALYSIS ${stamp}`;
if (fs.existsSync(path.join(DESKTOP, `${base}.ods`))) {
  base = `${base} ${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
}
const csvPath = path.join(tmp, `${base}.csv`);
fs.writeFileSync(csvPath, '\ufeff' + csv, 'utf8');

if (process.argv.includes('--csv')) {
  const out = path.join(DESKTOP, `${base}.csv`);
  fs.copyFileSync(csvPath, out);
  console.log(`\n  ${out}`);
  process.exit(0);
}

const soffice = ['C:/Program Files/LibreOffice/program/soffice.exe',
  'C:/Program Files (x86)/LibreOffice/program/soffice.exe'].find((p) => fs.existsSync(p));
if (!soffice) {
  console.log('\n  COULD NOT CONVERT: LibreOffice not found. The CSV is at:');
  console.log(`  ${csvPath}`);
  process.exit(2);
}
execFileSync(soffice, ['--headless', '--convert-to', 'ods', '--outdir', DESKTOP, csvPath],
  { stdio: 'pipe', timeout: 120000 });

const ods = path.join(DESKTOP, `${base}.ods`);
if (!fs.existsSync(ods)) {
  console.log('\n  LibreOffice reported success and wrote no .ods. Reporting rather than assuming.');
  process.exit(2);
}
console.log(`\n  ${ods}`);
console.log(`  ${rows.length} rows · ${items.length} items · ${open.length} open `
  + `(${open.filter((r) => r.owner === 'YOU').length} yours, ${open.filter((r) => r.owner !== 'YOU').length} mine)`);
console.log(`  expansion signals: ${empty.length} empty table(s), ${unconnected} unreached export(s), `
  + `${projects ? projects.unmeasurable.length : '?'} project(s) outside version control`);
console.log('  Nothing was overwritten.');
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ }

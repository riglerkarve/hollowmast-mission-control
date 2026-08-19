#!/usr/bin/env node
'use strict';

// tool-audit.cjs — cross every tools/*.cjs file against tool_runs without rewriting history.
//
//   node tools/tool-audit.cjs             recent means the last 14 days
//   node tools/tool-audit.cjs --days 30   choose the recency window explicitly
//
// “Never run” is reserved for a tool that visibly calls _run-log and has no row. A tool
// without that call is UNINSTRUMENTED: its absent row is evidence we could not look, not
// evidence it never ran. This reader uses a direct read-only SQLite connection, so the audit
// does not add its own run or write data/dashboard.db.

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.join(__dirname, '..');
const TOOLS = path.join(ROOT, 'tools');
const DB_PATH = path.join(ROOT, 'data', 'dashboard.db');
const daysArg = process.argv.indexOf('--days');
const days = daysArg >= 0 ? Number(process.argv[daysArg + 1]) : 14;
if (!Number.isFinite(days) || days <= 0) throw new Error('--days must be a positive number');
const recentSince = Date.now() - days * 86400000;

// Whitespace is intentional: a logger call may be split across lines. A one-line-only regex
// was one of the prior audit’s documented false-positive shapes.
const LOGGER = /require\(\s*['"]\.\/_run-log\.cjs['"]\s*\)\.record\(\s*\)/s;

function toolRows() {
  return fs.readdirSync(TOOLS, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.cjs'))
    .map((entry) => {
      const source = fs.readFileSync(path.join(TOOLS, entry.name), 'utf8');
      return {
        tool: entry.name,
        instrumented: LOGGER.test(source),
        executable: source.startsWith('#!'),
        noLogReason: (source.match(/(?:deliberately |does not )(?:use |invoke )?`?_run-log\.cjs`?([^\n.]*)/i) || [])[1] || null,
      };
    })
    .sort((a, b) => a.tool.localeCompare(b.tool));
}

function runHistory(db) {
  const result = new Map();
  const rows = db.prepare(`
    SELECT tool, at, exit_ok,
           ROW_NUMBER() OVER (PARTITION BY tool ORDER BY at DESC, id DESC) AS newest,
           COUNT(*) OVER (PARTITION BY tool) AS runs,
           SUM(CASE WHEN exit_ok = 0 THEN 1 ELSE 0 END) OVER (PARTITION BY tool) AS failures
    FROM tool_runs
  `).all();
  for (const row of rows) {
    if (row.newest === 1) result.set(row.tool, row);
  }
  return result;
}

let db;
try {
  if (!fs.existsSync(DB_PATH)) throw new Error(`database absent: ${DB_PATH}`);
  db = new DatabaseSync(DB_PATH, { readOnly: true });
  const history = runHistory(db);
  const rows = toolRows();
  const totals = new Map();

  console.log(`TOOL AUDIT — ${rows.length} tools; recent means last ${days} day(s).`);
  console.log(`DATABASE OPENED READ-ONLY: ${DB_PATH}`);
  console.log('STATUS                    TOOL                              LAST RUN / EVIDENCE');

  for (const row of rows) {
    let status;
    let evidence;
    if (row.tool === '_run-log.cjs') {
      status = 'DEFINING MODULE';
      evidence = 'creates tool_runs; does not represent a standalone tool run';
    } else if (!row.instrumented) {
      status = row.executable ? 'UNINSTRUMENTED' : 'SUPPORT MODULE';
      evidence = row.noLogReason || 'no _run-log call — could not tell whether it has run';
    } else {
      const run = history.get(row.tool);
      if (!run) {
        status = 'NEVER-RUN';
        evidence = 'instrumented but no tool_runs row';
      } else if (!run.exit_ok) {
        status = 'RUN-AND-FAILING';
        evidence = `${run.at}; latest exit failed; ${run.runs} run(s), ${run.failures} failure(s)`;
      } else if (Date.parse(run.at) >= recentSince) {
        status = 'RUN-RECENTLY';
        evidence = `${run.at}; ${run.runs} run(s), ${run.failures} earlier failure(s)`;
      } else {
        status = 'STALE-SUCCESS';
        evidence = `${run.at}; last succeeded but is older than ${days} days; ${run.runs} run(s)`;
      }
    }
    totals.set(status, (totals.get(status) || 0) + 1);
    console.log(`${status.padEnd(25)} ${row.tool.padEnd(33)} ${evidence}`);
  }

  console.log('\nSUMMARY');
  for (const [status, count] of [...totals].sort((a, b) => a[0].localeCompare(b[0]))) console.log(`  ${status}: ${count}`);
  console.log('  “Never run” excludes uninstrumented and support files; those are reported separately as could-not-tell.');
  console.log('  This audit intentionally covers tools/ only. server/ is application code, not a tool, and is not silently treated as absent.');
} catch (error) {
  console.error(`COULD NOT AUDIT tool runs: ${error.message}`);
  process.exitCode = 2;
} finally {
  try { if (db) db.close(); } catch { /* read-only handle cleanup */ }
}

#!/usr/bin/env node
//
// weekly-metrics-digest.cjs — a weekly roll-up: commits, handovers, items opened/closed.
//
// Owner request, 23 Aug 2026 (migrated from backlog M264): "queue remaining planned
// features... commits, handovers, items closed/opened -- sent as a cron job summary."
//
//   node tools/weekly-metrics-digest.cjs                    last 7 days, printed
//   node tools/weekly-metrics-digest.cjs --days 14
//   node tools/weekly-metrics-digest.cjs --out reports/metrics/   write the markdown too
//
// THIS IS THE REPORT GENERATOR ONLY. No cron job is wired to it — the task that created
// this file is explicit that a schedule and a delivery target need the owner's sign-off
// first, the same convention followed for the MindVirus deck job. Run it by hand, or ask
// the owner which cron schedule/channel to use before scheduling it.
//
// FOUR SOURCES, EACH READ, NONE OWNED:
//   commits   — `git log` over the workspace root. Same execFile pattern as changes.js:
//               never `exec`, so a subject line cannot inject a shell command.
//   handovers — files under mission-control/handover/, same directory changes.js reads,
//               counted by filing (not content), because that mirrors what a session did.
//   opened    — board_items.first_seen and todo_items.created_at falling inside the window.
//               A row's CURRENT project tracker or todo backlog is the only place "when was
//               this filed" is recorded, so first-seen-in-window is the fact available, not
//               a stored history of every add.
//   closed    — board_items rows whose status is no longer 'open'/'unknown' AND whose
//               last_seen falls inside the window (the last time the tracker import saw a
//               state change), plus todo_items moved to 'done'/'declined' with decided_at in
//               the window. THIS IS A PROXY, NOT A CLOSE-EVENT LOG: neither table records a
//               closed_at column, so "last time the row was seen with a closed status" is
//               what's true rather than what would be ideal. Said outright in the output
//               rather than presented as exact, per the workspace rule that absence and
//               failure must look different from success.
//
// A SOURCE THAT FAILS IS SKIPPED, NOT FATAL, and the skip is named in the output — the same
// rule changes.js and board.js already follow.
'use strict';
require('./_run-log.cjs').record();

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const db = require('../server/db');
db.setProcessActor('claude');

const WORKSPACE_ROOT = path.resolve(__dirname, '..', '..');
const HANDOVER_DIR = path.join(WORKSPACE_ROOT, 'mission-control', 'handover');

const argv = process.argv.slice(2);
const arg = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : null; };
const DAYS = Math.min(90, Math.max(1, Number(arg('days')) || 7));
const OUT = arg('out');

const notes = [];

// --------------------------------------------------------------------------------- commits
function gitLog(days) {
  return new Promise((resolve) => {
    const since = `${days} days ago`;
    execFile('git', ['log', `--since=${since}`, '--format=%H|%an|%ai|%s'],
      { cwd: WORKSPACE_ROOT, maxBuffer: 1024 * 1024 * 4 },
      (err, stdout) => {
        if (err) {
          notes.push(`commits: could not look — ${String((err && err.message) || err).slice(0, 160)}`);
          resolve([]);
          return;
        }
        const items = [];
        for (const line of stdout.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          const parts = trimmed.split('|');
          if (parts.length < 4) continue;
          const [hash, author, date, ...subjectParts] = parts;
          const subject = subjectParts.join('|');
          const projMatch = subject.match(/^(\w[\w-]*)\s*[:!]/);
          items.push({ ref: hash.slice(0, 8), subject, author, date, project: projMatch ? projMatch[1] : 'workspace root' });
        }
        resolve(items);
      });
  });
}

// ------------------------------------------------------------------------------ handovers
function handoversInWindow(days) {
  const cutoff = Date.now() - days * 86400 * 1000;
  const items = [];
  let entries;
  try {
    entries = fs.readdirSync(HANDOVER_DIR);
  } catch (e) {
    if (e && e.code !== 'ENOENT') notes.push(`handovers: could not look — ${String((e && e.message) || e).slice(0, 160)}`);
    return items;
  }
  for (const name of entries) {
    if (!name.endsWith('.md')) continue;
    const full = path.join(HANDOVER_DIR, name);
    let stat;
    try { stat = fs.statSync(full); } catch { continue; }
    if (stat.mtimeMs < cutoff) continue;
    const base = name.replace(/\.md$/, '');
    const agentMatch = base.match(/^\d{4}-\d{2}-\d{2}-(.+)$/);
    items.push({ file: name, who: agentMatch ? agentMatch[1] : base, at: stat.mtime.toISOString() });
  }
  return items;
}

// ------------------------------------------------------------------------- board_items (opened/closed)
const CLOSED_STATUSES = new Set(['fixed', 'wontfix', 'notabug', 'done', 'declined']);

function boardOpenedClosed(days) {
  const since = new Date(Date.now() - days * 86400 * 1000).toISOString();
  let opened = [];
  let closed = [];
  try {
    opened = db.prepare(
      `SELECT source, project, ref, kind, title, status, first_seen
         FROM board_items WHERE datetime(first_seen) >= datetime(?)
        ORDER BY project, first_seen`
    ).all(since);
  } catch (e) {
    notes.push(`board items opened: could not look — ${String((e && e.message) || e).slice(0, 160)}`);
  }
  try {
    closed = db.prepare(
      `SELECT source, project, ref, kind, title, status, last_seen
         FROM board_items WHERE status IN ('fixed','wontfix','notabug')
           AND datetime(last_seen) >= datetime(?)
        ORDER BY project, last_seen`
    ).all(since);
  } catch (e) {
    notes.push(`board items closed: could not look — ${String((e && e.message) || e).slice(0, 160)}`);
  }
  return { opened, closed };
}

// --------------------------------------------------------------------------- todo_items
function todoOpenedClosed(days) {
  const since = new Date(Date.now() - days * 86400 * 1000).toISOString();
  let opened = [];
  let closed = [];
  try {
    opened = db.prepare(
      `SELECT id, title, cluster, owner, status, created_at
         FROM todo_items WHERE datetime(created_at) >= datetime(?)
        ORDER BY created_at`
    ).all(since);
  } catch (e) {
    notes.push(`todo items opened: could not look — ${String((e && e.message) || e).slice(0, 160)}`);
  }
  try {
    closed = db.prepare(
      `SELECT id, title, cluster, owner, status, decided_at
         FROM todo_items WHERE status IN ('done','declined')
           AND decided_at IS NOT NULL AND datetime(decided_at) >= datetime(?)
        ORDER BY decided_at`
    ).all(since);
  } catch (e) {
    notes.push(`todo items closed: could not look — ${String((e && e.message) || e).slice(0, 160)}`);
  }
  return { opened, closed };
}

// -------------------------------------------------------------------------------- render
function countBy(rows, key) {
  const m = {};
  for (const r of rows) { const k = r[key] || '(unassigned)'; m[k] = (m[k] || 0) + 1; }
  return Object.entries(m).sort((a, b) => b[1] - a[1]);
}

(async () => {
  const commits = await gitLog(DAYS);
  const handovers = handoversInWindow(DAYS);
  const board = boardOpenedClosed(DAYS);
  const todo = todoOpenedClosed(DAYS);

  const itemsOpened = board.opened.length + todo.opened.length;
  const itemsClosed = board.closed.length + todo.closed.length;

  const L = [];
  const p = (s = '') => L.push(s);
  const rangeLabel = `${DAYS} day${DAYS === 1 ? '' : 's'}`;
  const now = new Date().toISOString().slice(0, 16).replace('T', ' ');

  p(`# Weekly metrics digest — last ${rangeLabel}`);
  p();
  p(`_Generated ${now} by \`tools/weekly-metrics-digest.cjs --days ${DAYS}\`._`);
  p('_No cron job runs this yet — this file is the report generator, printed/saved by hand._');
  p();
  p('| | |');
  p('|---|---|');
  p(`| Commits | ${commits.length} |`);
  p(`| Handovers filed | ${handovers.length} |`);
  p(`| Items opened | ${itemsOpened} (${board.opened.length} tracker, ${todo.opened.length} backlog) |`);
  p(`| Items closed | ${itemsClosed} (${board.closed.length} tracker, ${todo.closed.length} backlog) |`);
  p();

  p('## Commits');
  p();
  if (!commits.length) {
    p(`No commits in the last ${rangeLabel}.`);
  } else {
    p('By project:');
    p();
    for (const [proj, n] of countBy(commits, 'project')) p(`- ${proj}: ${n}`);
    p();
    p('| ref | project | who | when | subject |');
    p('|---|---|---|---|---|');
    for (const c of commits.slice(0, 40)) {
      p(`| ${c.ref} | ${c.project} | ${c.author} | ${c.date.slice(0, 16)} | ${c.subject.replace(/\|/g, '\\|')} |`);
    }
    if (commits.length > 40) p(`\n_...and ${commits.length - 40} more._`);
  }
  p();

  p('## Handovers filed');
  p();
  if (!handovers.length) {
    p(`No handover files under \`mission-control/handover/\` in the last ${rangeLabel}.`);
  } else {
    for (const h of handovers) p(`- ${h.who} — ${h.at.slice(0, 16)} (\`${h.file}\`)`);
  }
  p();

  p('## Items opened');
  p();
  p(`_Board trackers use \`first_seen\`: when the import first read the row, not necessarily`);
  p(`the moment it was filed in the source file._`);
  p();
  if (board.opened.length) {
    p('Tracker items (bugs/requests/notes):');
    p();
    for (const [proj, n] of countBy(board.opened, 'project')) p(`- ${proj}: ${n}`);
    p();
  }
  if (todo.opened.length) {
    p('Backlog items (Mission Control):');
    p();
    for (const [cluster, n] of countBy(todo.opened, 'cluster')) p(`- ${cluster}: ${n}`);
    p();
  }
  if (!board.opened.length && !todo.opened.length) p(`Nothing opened in the last ${rangeLabel}.`);
  p();

  p('## Items closed');
  p();
  p('_This is a proxy, not a close-event log: neither table stores a `closed_at` column, so');
  p('this counts rows whose status is now closed AND whose tracker last saw them inside the');
  p('window — the last known state change, not a guaranteed close date._');
  p();
  if (board.closed.length) {
    p('Tracker items:');
    p();
    for (const [proj, n] of countBy(board.closed, 'project')) p(`- ${proj}: ${n}`);
    p();
  }
  if (todo.closed.length) {
    p('Backlog items (Mission Control):');
    p();
    for (const [cluster, n] of countBy(todo.closed, 'cluster')) p(`- ${cluster}: ${n}`);
    p();
  }
  if (!board.closed.length && !todo.closed.length) p(`Nothing closed in the last ${rangeLabel}.`);
  p();

  if (notes.length) {
    p('## Sources that could not be read');
    p();
    for (const n of notes) p(`- ${n}`);
    p();
  }

  const text = `${L.join('\n')}\n`;
  console.log(`\n${text}`);

  if (OUT) {
    const dir = path.isAbsolute(OUT) ? OUT : path.join(__dirname, '..', OUT);
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 10);
    const file = path.join(dir, `weekly-metrics-${stamp}.md`);
    fs.writeFileSync(file, text);
    const back = fs.readFileSync(file, 'utf8');
    console.log(`  written ${file} (${back.length} bytes, ${back.split('\n').length} lines)`);
  }
})();

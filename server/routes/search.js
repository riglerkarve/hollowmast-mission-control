'use strict';
//
// search.js — cross-project search across the backlog, board items, handovers, and files.
//
// GET /api/search?q=QUERY — searches four sources in parallel and returns one bundle:
//   { backlog: [...], board: [...], handovers: [...], files: [...], query, total, truncated }
//
// THE BACKLOG IS A SOURCE, NOT A DERIVED VIEW (M275). This route shipped reading board_items
// and team_handovers only. board_items is the READ-ONLY IMPORT of each project's tracker;
// todo_items is the backlog inside Focus, which CLAUDE.md names as the place cross-project
// work actually lives. So the searchable store was the copy and the authored one was
// invisible: an item filed with its evidence could not be found by searching for it, which
// defeats the reason for filing it. Searching notes as well as title and rationale is
// deliberate — an item's current state lives in its notes, not in the title it was filed
// under, so a title-only search finds items whose answer it cannot show.
//
// NOTHING HERE IS DERIVED TWICE. Every source is read from the table its own module owns
// (todo.js, board.js, team.js); the file search shells out to grep. A panel that recomputed
// any of this would agree with the route until one was edited, and then disagree without
// either erroring — the exact failure this project keeps meeting.
//
// ABSENCE AND FAILURE LOOK DIFFERENT. An empty query returns empty arrays with 200; a
// search that errors returns the same shape with empty arrays AND an `error` field, so the
// panel can tell "nothing matched" from "could not look". Conflating the two is the failure
// mode this workspace was built to prevent.
//
// EVERY CAP REPORTS ITS RESIDUE. Each source is capped so one broad query cannot flood the
// panel, and a cap is a biased sample — it keeps the head of whatever the ORDER BY chose.
// `truncated` carries the number of matches each source dropped, so a partial answer is
// never read as a complete one. All zeroes means nothing was dropped, which is a different
// statement from not having looked.
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const db = require('../db');

const router = express.Router();

// The workspace root — THREE levels up (server/routes/ -> server/ -> mission-control/ ->
// workspace). It was two, which resolves to mission-control itself, so "cross-project file
// search" only ever searched this one project. Nothing errored: the walk found real files
// and returned real hits, just from a twelfth of the tree it claimed to cover.
//
// Asserted rather than assumed, because an off-by-one in a path is invisible in its
// results — a wrong directory that exists returns a confident, wrong answer. If the parent
// does not look like the workspace, we fall back to this project and say so in `note`
// rather than silently searching the wrong tree.
const PROJECT_DIR = path.join(__dirname, '..', '..');
const WORKSPACE = path.join(PROJECT_DIR, '..');

// board_items is owned by the board module; team_handovers by the team module. If either
// table is absent (module not yet migrated on a fresh database), we return empty rather
// than throw, so a panel that mounts before either module is set up reports nothing rather
// than erroring.
function tableExists(name) {
  const row = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
  ).get(name);
  return !!row;
}

// How many rows each database source may return. Anything beyond this is counted and
// reported in `truncated` rather than silently dropped — see the header.
const CAP = 50;

// Search board items by title. Returns ref, title, project, kind, status — the fields the
// panel renders, not the table's full row, so the panel never reaches into column names the
// board module might rename.
//
// Each of these returns { rows, matched }: `matched` is how many the WHERE clause found,
// `rows` is what survived the cap. They differ exactly when the cap bit.
function searchBoard(q) {
  if (!tableExists('board_items')) return { rows: [], matched: 0 };
  const like = `%${q}%`;
  const rows = db.prepare(
    'SELECT ref, title, project, kind, status FROM board_items WHERE title LIKE ? ORDER BY project, ref LIMIT ?'
  ).all(like, CAP);
  const matched = db.prepare(
    'SELECT COUNT(*) AS n FROM board_items WHERE title LIKE ?'
  ).get(like).n;
  return { rows, matched };
}

// Search the backlog — todo_items, the store the Focus panel writes. Matches on title,
// rationale AND notes, because those are three different questions: the title is what it was
// filed as, the rationale is why, and the notes are what has happened to it since. An item
// deferred in a note is found by searching for the reason it was deferred.
//
// `matchedIn` says WHICH of the three matched. Without it a hit on a 900-word rationale looks
// identical to a hit on the title, and the owner cannot tell why a result is in the list —
// which is the same "correct answer to a narrower question" failure the laws warn about.
function searchBacklog(q) {
  if (!tableExists('todo_items')) return { rows: [], matched: 0 };
  const like = `%${q}%`;
  const hasNotes = tableExists('todo_notes');

  // When todo_notes is absent the note predicate is a literal 0 rather than a subquery, so
  // this degrades to a title+rationale search instead of throwing on a fresh database.
  const noteMatch = hasNotes
    ? 'EXISTS (SELECT 1 FROM todo_notes n WHERE n.item_id = i.id AND n.note LIKE ?)'
    : '0';
  const noteArgs = hasNotes ? [like] : [];

  const where = `i.title LIKE ? OR COALESCE(i.rationale, '') LIKE ? OR ${noteMatch}`;

  // in_progress before open before everything settled, then P0..P3, then anything whose
  // priority is not a P-code (the DECLINE / DONE seed markers) last.
  const order = `ORDER BY
      CASE i.status WHEN 'in_progress' THEN 0 WHEN 'open' THEN 1 ELSE 2 END,
      CASE WHEN i.priority LIKE 'P%' THEN i.priority ELSE 'ZZ' END,
      i.id`;

  const rows = db.prepare(
    `SELECT i.id, i.title, i.project, i.kind, i.status, i.priority, i.cluster,
            (i.title LIKE ?) AS m_title,
            (COALESCE(i.rationale, '') LIKE ?) AS m_rationale,
            ${noteMatch} AS m_notes
       FROM todo_items i
      WHERE ${where}
      ${order}
      LIMIT ?`
  ).all(like, like, ...noteArgs, like, like, ...noteArgs, CAP);

  const matched = db.prepare(
    `SELECT COUNT(*) AS n FROM todo_items i WHERE ${where}`
  ).get(like, like, ...noteArgs).n;

  // Collapse the three 0/1 columns into the list the panel renders, and drop them from the
  // row so the panel is never tempted to read a raw SQL boolean.
  return {
    rows: rows.map((r) => {
      const matchedIn = [];
      if (r.m_title) matchedIn.push('title');
      if (r.m_rationale) matchedIn.push('rationale');
      if (r.m_notes) matchedIn.push('notes');
      const { m_title, m_rationale, m_notes, ...rest } = r;
      return { ...rest, matchedIn };
    }),
    matched,
  };
}

// Search handovers across title, done, and next — the three free-text fields a handover
// carries. Returns id, title, done, blocked, next, shift, at so the panel can show what the
// shift produced without a second lookup.
function searchHandovers(q) {
  if (!tableExists('team_handovers')) return { rows: [], matched: 0 };
  const like = `%${q}%`;
  const where = 'title LIKE ? OR done LIKE ? OR next LIKE ?';
  const rows = db.prepare(
    `SELECT id, title, done, blocked, next, shift, at FROM team_handovers WHERE ${where} ORDER BY at DESC LIMIT ?`
  ).all(like, like, like, CAP);
  const matched = db.prepare(
    `SELECT COUNT(*) AS n FROM team_handovers WHERE ${where}`
  ).get(like, like, like).n;
  return { rows, matched };
}

// Search workspace files by content. Returns paths only (no line numbers or context), capped
// so a broad query does not flood the panel.
//
// THIS WALKS THE TREE IN NODE INSTEAD OF SHELLING OUT TO grep, and the reason is a measured
// failure rather than a preference. The previous version ran `grep -rl` through execSync,
// which on Windows goes via cmd.exe — and cmd.exe exits **1** for a command it cannot find,
// the exact code this function treated as "no matches". grep is on PATH in a developer shell
// and is NOT on PATH for the MissionControl-Server scheduled task, so on the running service
// every file search returned zero and the panel printed "That is a real count, not a failed
// search." Measured 23 Aug 2026: same query, same code, 54 files from a shell and 0 from the
// task, distinguished by nothing but PATH. That is absence and failure rendering identically
// inside the file whose own header forbids it.
//
// A Node walk has no PATH, no shell quoting and no platform branch, so the dev shell and the
// service cannot disagree again. It is also why the extension list can include .cjs: the
// house convention is that every Node script here is .cjs, and the old `--include="*.js"`
// silently excluded the entire tools/ directory from every search.
const FILE_CAP = 20;

// Extensions worth searching. Anything not listed is skipped unread — a binary or an asset
// is not a search result, and reading it to find out costs the whole walk.
const FILE_EXTS = new Set(['.js', '.cjs', '.mjs', '.md', '.css', '.html', '.json', '.ps1', '.sh']);

// Directories never descended into. The first four are bulk (Oxford AutoWorks alone is 4.7 GB
// of Unreal cache); `data` and `backups` are excluded because they hold the ledger, and a
// path list is a weaker leak than a body but still not something a search box should emit.
const SKIP_DIRS = new Set([
  'node_modules', '.git', '_archive', 'dist', 'build', '.next', '.cache', '.venv',
  '__pycache__', 'DerivedDataCache', 'Intermediate', 'Saved', 'Binaries', 'Build',
  'data', 'backups', 'logs',
]);

// Files larger than this are skipped. A 5 MB single-file game or a minified bundle matches
// almost any query and tells the owner nothing.
const MAX_FILE_BYTES = 2 * 1024 * 1024;

// A wall-clock budget. The walk is fast on this tree, but the workspace is not fixed in size
// and a search box that hangs is worse than one that answers partially — provided it SAYS it
// answered partially, which is what `note` is for.
const WALK_BUDGET_MS = 8000;

function searchFiles(q) {
  // Confirm the parent really is the workspace before searching it. `mission-control` is
  // this project; if it is not there, the layout is not what this code assumes and searching
  // the parent anyway would walk an unknown tree.
  let root = WORKSPACE;
  let note = null;
  if (!fs.existsSync(path.join(WORKSPACE, 'mission-control'))) {
    root = PROJECT_DIR;
    note = 'Workspace root not found — searched this project only.';
  }

  const needle = q.toLowerCase();
  const hits = [];
  let scanned = 0;
  let unreadable = 0;
  const startedAt = Date.now();
  let ranOut = false;

  const walk = (dir) => {
    if (ranOut) return;
    if (Date.now() - startedAt > WALK_BUDGET_MS) { ranOut = true; return; }

    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      // A directory we cannot list is counted, not swallowed — see `note` below.
      unreadable += 1;
      return;
    }

    for (const entry of entries) {
      if (ranOut) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!FILE_EXTS.has(path.extname(entry.name).toLowerCase())) continue;

      try {
        if (fs.statSync(full).size > MAX_FILE_BYTES) continue;
        scanned += 1;
        // Case-insensitive, to match the three database sources — SQLite's LIKE is
        // case-insensitive for ASCII, and a search box where one of four sources quietly
        // disagrees about case is a worse answer than either rule applied consistently.
        if (fs.readFileSync(full, 'utf8').toLowerCase().includes(needle)) {
          hits.push(path.relative(root, full).split(path.sep).join('/'));
        }
      } catch {
        unreadable += 1;
      }
    }
  };

  walk(root);

  // Everything the walk could not do is said out loud. A file search that stopped early or
  // skipped a locked directory has NOT looked everywhere, and reporting its hits without
  // that is the flattering-filter failure: the surviving evidence looks cleaner than it is.
  const caveats = [];
  if (note) caveats.push(note);
  if (ranOut) caveats.push(`Stopped after ${WALK_BUDGET_MS / 1000}s — this is a partial sweep, not a complete one.`);
  if (unreadable) caveats.push(`${unreadable} path(s) could not be read and were not searched.`);

  return {
    rows: hits.slice(0, FILE_CAP),
    matched: hits.length,
    note: caveats.length ? caveats.join(' ') : null,
    scanned,
  };
}

// GET /api/search?q=QUERY
router.get('/', (req, res) => {
  const query = String(req.query.q || '').trim();

  // Empty query: return the empty shape immediately. A search with no term is not an error
  // and not a loading state — it is nothing, and nothing is what we return.
  if (!query) {
    return res.json({
      backlog: [], board: [], handovers: [], files: [],
      query: '', total: 0, truncated: { backlog: 0, board: 0, handovers: 0, files: 0 }, notes: {},
    });
  }

  const result = {
    backlog: [], board: [], handovers: [], files: [],
    query, total: 0, truncated: { backlog: 0, board: 0, handovers: 0, files: 0 }, notes: {},
  };
  const errors = [];

  // Each source is searched independently so one failing does not blank the others. A
  // broken board table does not prevent handovers from showing; a grep timeout does not
  // prevent the database results. The panel gets what survived plus an error if any
  // source failed, so a partial result is never mistaken for a complete one.
  //
  // A source that THREW is left at [] with its name in `errors`, and its truncated count
  // stays 0 — the panel must read the error field to tell "this source found nothing" from
  // "this source could not be asked". That is the same distinction the header states, applied
  // per source rather than to the bundle.
  const sources = [
    ['backlog', searchBacklog],
    ['board', searchBoard],
    ['handovers', searchHandovers],
    ['files', searchFiles],
  ];

  for (const [key, fn] of sources) {
    try {
      const { rows, matched, note } = fn(query);
      result[key] = rows;
      result.truncated[key] = Math.max(0, matched - rows.length);
      // A source may have looked successfully and still not looked everywhere. That is
      // neither an error nor a clean result, so it gets its own channel rather than being
      // folded into either.
      if (note) result.notes[key] = note;
    } catch (e) {
      errors.push(`${key}: ${e.message}`);
    }
  }

  result.total = result.backlog.length + result.board.length
    + result.handovers.length + result.files.length;
  if (errors.length) result.error = errors.join('; ');

  res.json(result);
});

module.exports = router;
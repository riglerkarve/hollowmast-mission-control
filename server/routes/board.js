//
// board.js — one place to see open bugs and requests across every project.
//
// Owner instruction, 19 Aug 2026: "I need a central place to view open bugs, requests for all
// projects." Work was scattered across SIX stores when this was written:
//
//   todo_items (Mission Control)      163 rows, 151 open   the workspace backlog
//   Survive/BUGS.md                   3,690 lines, 76      HOLLOWMAST's bug tracker
//   Survive/dash/requests.jsonl       92 records           HOLLOWMAST's request inbox
//   mission-control/handover/*.md     2 files              ad hoc
//   Survive/HANDOVER-*.md             2 files              ad hoc
//   Oxford AutoWorks/docs/HANDOVER-*  2 files              ad hoc
//
// THIS MODULE IMPORTS AND DISPLAYS. It does not own the external trackers and never writes to
// them. That was the owner's call on 19 Aug and it is the right one: BUGS.md is where a game
// session already works — one keystroke, no server, no network — and 3,690 lines of
// reproduction notes would not survive a migration intact. Writing back would create two
// writers with no merge, which is the failure the backlog module was built to end and which
// recurred inside thirty minutes the last time it was allowed.
//
// So the external files are the WRITE surface and this is the READ surface, exactly as the
// ledger and the browsing history already work.
'use strict';

const express = require('express');
const path = require('node:path');
const db = require('../db');
const provenance = require('../provenance');
const todo = require('./todo');
const { SOURCES, importAll } = require('../trackers');

const router = express.Router();

db.migrate('board', [
  (d) => {
    // One row per item in an external tracker. `ref` is the tracker's own id (B054, req 91) —
    // kept rather than renumbered, because the whole value of this table is that you can read
    // a row here and then find it in the file it came from.
    d.exec(`
      CREATE TABLE board_items (
        source        TEXT NOT NULL,     -- 'hollowmast-bugs' | 'hollowmast-requests'
        project       TEXT NOT NULL,
        ref           TEXT NOT NULL,     -- the tracker's own identifier
        kind          TEXT NOT NULL,     -- bug | request | note | question
        title         TEXT NOT NULL,
        severity      TEXT,              -- P1..P4, or null where the tracker did not say
        status        TEXT NOT NULL,     -- open | fixed | wontfix | notabug | unknown
        status_basis  TEXT NOT NULL,     -- meta | section | record | none  <- HOW status was decided
        section       TEXT,              -- where in the file it was filed
        raw_meta      TEXT,
        first_seen    TEXT NOT NULL,
        last_seen     TEXT NOT NULL,
        PRIMARY KEY (source, ref)
      )`);

    // One row per import RUN, so "nothing imported" and "the import failed" are different
    // facts on disk rather than the same empty table. Every field here exists because a
    // silently-empty importer is the failure this workspace keeps meeting.
    d.exec(`
      CREATE TABLE board_imports (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        source     TEXT NOT NULL,
        at         TEXT NOT NULL,
        ok         INTEGER NOT NULL,     -- 0 = could not look. NOT the same as 0 items.
        parsed     INTEGER NOT NULL,
        skipped    INTEGER NOT NULL,     -- the residue: entries the parser could not read
        conflicts  INTEGER NOT NULL,     -- entries whose section and meta line disagree
        note       TEXT
      )`);
    provenance.addColumn(d, 'board_items');
  },
]);

// ---------------------------------------------------------------------------- reading

// STATUS IS DECIDED BY THE META LINE, AND THE SECTION IS ONLY A FALLBACK — measured, not
// assumed. BUGS.md files entries under `## Open`, `## Fixed`, `## Won't fix` and so on, and
// each entry also carries a `**P2 · FIXED 2026-08-18 · area**` line. Those two disagree
// wholesale: of the 34 entries sitting under `## Open`, 29 say FIXED, 4 say NOTABUG, and
// exactly ONE is genuinely open. Entries get fixed and their meta line updated without being
// moved, so the section heading is the stale copy.
//
// Reading the section would have reported 34 open bugs on HOLLOWMAST. Reading the meta line
// reports 1. That is a 34x error in the headline figure of the board the owner asked for, and
// neither number errors — which is why the disagreement is COUNTED and shown rather than
// quietly resolved.
function summary() {
  const items = db.prepare(`
    SELECT source, project, ref, kind, title, severity, status, status_basis, section
      FROM board_items
     ORDER BY project, CASE severity WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 WHEN 'P3' THEN 3 ELSE 9 END, ref`).all();

  // The most recent run per source, so the panel can say when each tracker was last read and
  // whether that read succeeded.
  const runs = db.prepare(`
    SELECT b.* FROM board_imports b
      JOIN (SELECT source, MAX(id) id FROM board_imports GROUP BY source) m ON m.id = b.id`).all();

  let backlog = [];
  let backlogError = null;
  try {
    backlog = todo.openForBoard();
  } catch (e) {
    // COULD NOT LOOK is not the same as nothing open. An empty backlog on a broken accessor
    // would render as "all clear" on the one screen that exists to prevent that.
    backlogError = String((e && e.message) || e).slice(0, 200);
  }

  const openItems = items.filter((i) => i.status === 'open' || i.status === 'unknown');

  // Every project that appears anywhere, so a project with zero open items is still listed —
  // "nothing open on thin-air" and "thin-air is not being read" must look different.
  const projects = {};
  const bump = (p, key) => {
    const k = p || '(unassigned)';
    projects[k] = projects[k] || { project: k, bugs: 0, requests: 0, backlog: 0, unknown: 0 };
    projects[k][key] += 1;
  };
  for (const i of openItems) {
    bump(i.project, i.status === 'unknown' ? 'unknown' : (i.kind === 'request' ? 'requests' : 'bugs'));
  }
  for (const b of backlog) bump(b.project, 'backlog');

  return {
    sources: SOURCES.map((s) => {
      const run = runs.find((r) => r.source === s.id) || null;
      return {
        id: s.id,
        project: s.project,
        file: s.file,
        exists: s.exists(),
        lastRun: run && { at: run.at, ok: !!run.ok, parsed: run.parsed, skipped: run.skipped, conflicts: run.conflicts, note: run.note },
      };
    }),
    projects: Object.values(projects).sort((a, b) => a.project.localeCompare(b.project)),
    items: openItems,
    backlog,
    backlogError,
    counts: {
      externalOpen: openItems.length,
      externalTotal: items.length,
      backlogOpen: backlog.length,
    },
  };
}

router.get('/', (req, res) => res.json(summary()));

// Everything held, not just what is open — so a closed bug can still be found by ref.
router.get('/items', (req, res) => {
  const { project, kind, status } = req.query;
  const where = [];
  const args = [];
  if (project) { where.push('project = ?'); args.push(project); }
  if (kind) { where.push('kind = ?'); args.push(kind); }
  if (status) { where.push('status = ?'); args.push(status); }
  const sql = `SELECT * FROM board_items ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
               ORDER BY project, ref`;
  res.json({ items: db.prepare(sql).all(...args) });
});

// Re-read the trackers now. Safe to call repeatedly: it is a full reconcile against the files.
router.post('/refresh', express.json(), (req, res) => {
  try {
    res.json(importAll(db));
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e).slice(0, 300) });
  }
});

module.exports = router;
module.exports.summary = summary;

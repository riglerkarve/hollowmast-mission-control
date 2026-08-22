'use strict';
//
// search.js — cross-project search across board items, handovers, and workspace files.
//
// GET /api/search?q=QUERY — searches three sources in parallel and returns one bundle:
//   { board: [...], handovers: [...], files: [...], query, total }
//
// NOTHING HERE IS DERIVED TWICE. Board items and handovers are read from the tables their
// own modules own (board.js, team.js); the file search shells out to grep. A panel that
// recomputed any of this would agree with the route until one was edited, and then disagree
// without either erroring — the exact failure this project keeps meeting.
//
// ABSENCE AND FAILURE LOOK DIFFERENT. An empty query returns empty arrays with 200; a
// search that errors returns the same shape with empty arrays AND an `error` field, so the
// panel can tell "nothing matched" from "could not look". Conflating the two is the failure
// mode this workspace was built to prevent.
const express = require('express');
const { execSync } = require('node:child_process');
const path = require('node:path');
const db = require('../db');

const router = express.Router();

// The workspace root — two levels up from this file (server/routes/ -> server/ -> root).
// Same convention as workspace.js, so the file search covers the same set of projects.
const ROOT = path.join(__dirname, '..', '..');

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

// Search board items by title. Returns ref, title, project, kind, status — the fields the
// panel renders, not the table's full row, so the panel never reaches into column names the
// board module might rename.
function searchBoard(q) {
  if (!tableExists('board_items')) return [];
  const like = `%${q}%`;
  return db.prepare(
    'SELECT ref, title, project, kind, status FROM board_items WHERE title LIKE ? ORDER BY project, ref LIMIT 50'
  ).all(like);
}

// Search handovers across title, done, and next — the three free-text fields a handover
// carries. Returns id, title, done, blocked, next, shift, at so the panel can show what the
// shift produced without a second lookup.
function searchHandovers(q) {
  if (!tableExists('team_handovers')) return [];
  const like = `%${q}%`;
  return db.prepare(
    'SELECT id, title, done, blocked, next, shift, at FROM team_handovers WHERE title LIKE ? OR done LIKE ? OR next LIKE ? ORDER BY at DESC LIMIT 50'
  ).all(like, like, like);
}

// Search workspace files by content using grep. Returns file paths only (no line numbers or
// context), limited to 20 so a broad query does not flood the panel. grep -r walks the tree;
// --include restricts to source files the owner would actually search.
//
// ERRORS HERE ARE NOT FATAL. grep returns exit code 1 when nothing matches, which execSync
// throws on — that is a real zero, not a failure, and is caught and returned as []. A
// genuine error (grep not found, permission denied) is caught separately and surfaced in the
// error field so the panel can distinguish it.
function searchFiles(q) {
  try {
    const cmd = `grep -rl ${JSON.stringify(q)} --include="*.js" --include="*.css" --include="*.md" .`;
    const out = execSync(cmd, { cwd: ROOT, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 }).trim();
    if (!out) return [];
    return out.split('\n').slice(0, 20);
  } catch (e) {
    // grep exits 1 when no matches — that is absence, not failure.
    if (e.status === 1) return [];
    // Any other error (timeout, grep missing) is a real failure — re-throw so the caller
    // can put it in the error field.
    throw e;
  }
}

// GET /api/search?q=QUERY
router.get('/', (req, res) => {
  const query = String(req.query.q || '').trim();

  // Empty query: return the empty shape immediately. A search with no term is not an error
  // and not a loading state — it is nothing, and nothing is what we return.
  if (!query) {
    return res.json({ board: [], handovers: [], files: [], query: '', total: 0 });
  }

  const result = { board: [], handovers: [], files: [], query, total: 0 };
  const errors = [];

  // Each source is searched independently so one failing does not blank the others. A
  // broken board table does not prevent handovers from showing; a grep timeout does not
  // prevent the database results. The panel gets what survived plus an error if any
  // source failed, so a partial result is never mistaken for a complete one.
  try {
    result.board = searchBoard(query);
  } catch (e) {
    errors.push(`board: ${e.message}`);
  }

  try {
    result.handovers = searchHandovers(query);
  } catch (e) {
    errors.push(`handovers: ${e.message}`);
  }

  try {
    result.files = searchFiles(query);
  } catch (e) {
    errors.push(`files: ${e.message}`);
  }

  result.total = result.board.length + result.handovers.length + result.files.length;
  if (errors.length) result.error = errors.join('; ');

  res.json(result);
});

module.exports = router;
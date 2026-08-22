'use strict';
//
// bulk-import.js — bulk import items into the board from JSON or CSV.
//
// POST /api/bulk-import — accepts { items: [{ ref, title, project, kind }] }
// GET /api/bulk-import/template — returns a JSON template for the import
//
// This writes to board_items with source = 'bulk-import'. It never touches the external
// trackers — those are the WRITE surface for their own projects, and this is a
// convenience for the owner to seed the board from a list. The board panel reads
// board_items and this panel writes to it; the external trackers stay untouched.
//
// ABSENCE AND FAILURE MUST NOT LOOK THE SAME. An item with no title is a validation
// failure, not an empty import. A duplicate is a skip, not an error. Both are counted
// and reported so "imported 0" is never mistaken for "nothing was sent".
const express = require('express');
const db = require('../db');

const router = express.Router();

// POST / — bulk import items into board_items.
//
// Each item needs at least a title. kind defaults to 'backlog'. ref defaults to a
// synthesised value so every row has a primary key. project defaults to '(unassigned)'.
//
// An item with the same source + ref + title as one already on the board is SKIPPED,
// not duplicated — and not silently: it is counted in `failed` (which is really
// "skipped or failed") and the caller can see how many.
router.post('/', express.json(), (req, res) => {
  const { items } = req.body || {};
  if (!Array.isArray(items)) {
    return res.status(400).json({
      ok: false, imported: 0, failed: 0,
      errors: ['Body must have an "items" array'],
    });
  }

  const at = new Date().toISOString();
  const by = req.by || 'unknown';

  // Check for an exact duplicate: same source, ref, and title. A different title on
  // the same ref is an update, not a skip — the ref is the key, and the new title is
  // presumably the latest.
  const checkDup = db.prepare(
    'SELECT 1 FROM board_items WHERE source = ? AND ref = ? AND title = ?'
  );

  // INSERT with all NOT NULL columns. status is 'open', status_basis is 'meta'
  // because this import asserts the status explicitly — it is not inferred.
  // ON CONFLICT(source, ref) updates the row if the ref exists with a different title.
  const ins = db.prepare(`
    INSERT INTO board_items (source, project, ref, kind, title, severity, status, status_basis,
                             section, raw_meta, first_seen, last_seen, by_whom)
         VALUES (?, ?, ?, ?, ?, NULL, 'open', 'meta', NULL, NULL, ?, ?, ?)
    ON CONFLICT(source, ref) DO UPDATE SET
      title = excluded.title, kind = excluded.kind, project = excluded.project,
      status = excluded.status, status_basis = excluded.status_basis,
      last_seen = excluded.last_seen`);

  let imported = 0;
  let failed = 0;
  const errors = [];

  db.withTransaction(() => {
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      if (!item || typeof item !== 'object') {
        errors.push(`Item ${i + 1}: not an object`);
        failed += 1;
        continue;
      }

      const title = String(item.title || '').trim();
      if (!title) {
        errors.push(`Item ${i + 1}: missing title (required)`);
        failed += 1;
        continue;
      }

      const ref = String(item.ref || '').trim() || `auto-${at}-${i + 1}`;
      const project = String(item.project || '').trim() || '(unassigned)';
      const kind = String(item.kind || 'backlog').trim() || 'backlog';

      // Skip exact duplicates: same source + ref + title. Not an error — the caller
      // may have pasted the same list twice, and re-importing should be a no-op, not
      // a failure. It is counted so "imported 0" can be distinguished from "sent 0".
      const existing = checkDup.get('bulk-import', ref, title);
      if (existing) {
        failed += 1;
        continue;
      }

      try {
        ins.run('bulk-import', project, ref, kind, title, at, at, by);
        imported += 1;
      } catch (e) {
        errors.push(`Item ${i + 1} (${ref}): ${String((e && e.message) || e).slice(0, 150)}`);
        failed += 1;
      }
    }
  });

  res.json({ ok: true, imported, failed, errors });
});

// GET /template — returns a JSON template for the import format.
router.get('/template', (req, res) => {
  res.json({
    items: [
      { ref: 'M001', title: 'Example item', project: 'Mission Control', kind: 'backlog' },
    ],
  });
});

module.exports = router;

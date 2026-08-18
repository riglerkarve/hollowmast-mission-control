// Exercise — counts, and only counts.
//
// Owner's decision, 18 Aug: a SEPARATE module rather than numeric fields on wellbeing. The
// reasoning is worth keeping, because it is the whole reason this file exists: wellbeing is
// journal-only by design — free text, no interval, no due date, no overdue state, nothing
// that can report you as behind — and the moment a number lives there, something will chart
// it, and a chart invites a judgement. Twenty squats is a fact. "Three of seven days" is a
// verdict wearing a number.
//
// So numbers live here, where they can be counted honestly, and wellbeing stays untouched.
//
// WHAT THIS MODULE STILL REFUSES, inherited deliberately from the wellbeing rules:
//   * no target, and no field to put one in. Nothing here can compute "behind".
//   * no streak. A streak turns one missed day into a loss, which is the mechanic that makes
//     people quit rather than the one that makes them continue.
//   * no score, no rating, no colour meaning bad.
//   * the vocabulary of kinds is YOURS. Nothing is seeded, because a seeded list is a list
//     you can fail to fill in — the same call already made for the atlas and the wishlist.
//
// What it DERIVES, so it is not merely a box that stores what you typed: totals and a best
// per kind, and where each kind sits against its own history. Arithmetic over your own rows,
// never a comparison against a figure anyone invented.
'use strict';

const express = require('express');
const db = require('../db');

db.migrate('exercise', [
  (d) => {
    d.exec(`
      CREATE TABLE exercise_sessions (
        id         INTEGER PRIMARY KEY,
        day        TEXT NOT NULL,
        kind       TEXT NOT NULL,
        -- Both optional and both nullable: some things are counted (squats), some are timed
        -- (a walk), and some are neither and are just recorded as done. A row with neither
        -- is valid and deliberate.
        reps       INTEGER,
        minutes    INTEGER,
        note       TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
      );
      CREATE INDEX exercise_day  ON exercise_sessions (day);
      CREATE INDEX exercise_kind ON exercise_sessions (kind, day);
    `);
  },
]);

const router = express.Router();

router.post('/sessions', express.json(), (req, res) => {
  const b = req.body || {};
  const kind = String(b.kind || '').trim().toLowerCase();
  if (!kind) return res.status(400).json({ error: 'a kind is required' });

  // Empty string and zero are different from absent, and only absent is stored as NULL.
  // A recorded zero is a real fact ("I did none") and must not read as "not recorded".
  const num = (v) => (v === '' || v == null ? null : (Number.isFinite(Number(v)) ? Math.round(Number(v)) : null));
  const day = String(b.day || '').trim() || new Date().toLocaleDateString('en-CA');

  const info = db.prepare(
    'INSERT INTO exercise_sessions (day, kind, reps, minutes, note) VALUES (?, ?, ?, ?, ?)'
  ).run(day, kind, num(b.reps), num(b.minutes), String(b.note || '').trim() || null);

  res.status(201).json({ id: info.lastInsertRowid, kind, day });
});

router.delete('/sessions/:id', (req, res) => {
  const r = db.prepare('DELETE FROM exercise_sessions WHERE id = ?').run(req.params.id);
  if (!r.changes) return res.status(404).json({ error: 'no such session' });
  res.json({ deleted: Number(req.params.id) });
});

router.get('/', (req, res) => {
  const total = db.prepare('SELECT COUNT(*) AS n FROM exercise_sessions').get().n;
  if (!total) {
    return res.json({
      state: 'empty',
      message: 'Nothing recorded yet.',
      // An empty module and a broken one must not read the same, and an empty one should say
      // what it is FOR rather than sitting blank.
      note: 'Record anything you did. The kinds are whatever you type — nothing is seeded, '
        + 'because a list you did not write is a list you can fail to fill in.',
    });
  }

  // Per kind: how many sessions, the totals, the best single session, and when it last
  // happened. "Best" is the largest number you have actually recorded — it is not a target,
  // and nothing compares you against it.
  const kinds = db.prepare(
    `SELECT kind,
            COUNT(*)                    AS sessions,
            SUM(COALESCE(reps, 0))      AS reps,
            SUM(COALESCE(minutes, 0))   AS minutes,
            MAX(reps)                   AS bestReps,
            MAX(minutes)                AS bestMinutes,
            MAX(day)                    AS lastDay,
            MIN(day)                    AS firstDay
     FROM exercise_sessions GROUP BY kind ORDER BY sessions DESC, kind`
  ).all();

  const recent = db.prepare(
    `SELECT id, day, kind, reps, minutes, note FROM exercise_sessions
     ORDER BY day DESC, id DESC LIMIT 30`
  ).all();

  // Days with any activity, over the last 12 weeks, as a plain count per week. NOT a streak
  // and not a percentage: a bare count cannot say you fell short of anything.
  const weeks = db.prepare(
    `SELECT strftime('%Y-W%W', day) AS week, COUNT(DISTINCT day) AS days, COUNT(*) AS sessions
     FROM exercise_sessions WHERE day >= date('now','localtime','-84 days')
     GROUP BY week ORDER BY week`
  ).all();

  res.json({
    state: 'ok',
    total,
    kinds,
    recent,
    weeks,
    daysRecorded: db.prepare('SELECT COUNT(DISTINCT day) AS n FROM exercise_sessions').get().n,
    note: 'Counts only. There is no target here, no streak and no score — nothing in this '
      + 'module can tell you that you are behind, because nothing in it knows what you '
      + 'intended.',
  });
});

module.exports = router;

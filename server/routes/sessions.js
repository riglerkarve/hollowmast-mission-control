const express = require('express');
const db = require('../db');
const provenance = require('../provenance');

// FOCUS SESSIONS, and who did them.
//
// `focus_sessions` predates the provenance work: it was created in db.js as one of the two
// original tables and carried no attribution at all. That was harmless while the only
// writer was the timer in the browser. It stopped being harmless the moment Claude's own
// work started being recorded here (18 Aug 2026, at the owner's request), because
// server/routes/stats.js reads this table in EIGHT places to compute streaks, totals and
// "days with a focus session" — every one of which would silently have become a claim
// about the owner's habits built from my hours.
//
// That is precisely the failure server/provenance.js exists to prevent, and it says so in
// its own header. So the column comes first and the recording second.
db.migrate('sessions', [
  (d) => provenance.addColumn(d, 'focus_sessions'),

  // v2 — a key for rows DERIVED from something else, so an importer can re-run without
  // double-counting. Claude's sessions are imported from the telemetry parse of its own
  // transcripts rather than logged by hand: a record that depends on the agent remembering
  // to log is a record that is wrong the first time it forgets.
  //
  // UNIQUE so re-import is an upsert rather than a duplicate. NULL for anything typed by a
  // person, and SQLite treats NULLs as distinct in a unique index, so hand-entered rows are
  // unaffected by it.
  (d) => {
    d.exec(`
      ALTER TABLE focus_sessions ADD COLUMN source_key TEXT;
      CREATE UNIQUE INDEX idx_focus_source_key ON focus_sessions(source_key);
    `);
  },
]);

// THE ONE PLACE THE FILTER IS WRITTEN. Exported and reused by stats.js rather than retyped
// per query: eight call sites means eight chances to forget one, and a forgotten filter
// does not error — it just quietly folds my hours into your streak. A shared fragment also
// means grep can PROVE every site is converted, which retyping never can.
//
// It excludes Claude rather than selecting 'you', and the difference is deliberate. The one
// pre-existing row is 'unknown': it was recorded on 2026-08-01, before any of this, and is
// almost certainly the owner's — but "almost certainly" is a guess, and the standing rule
// is never to guess 'you'. Excluding what is known to be mine keeps that row visible and
// makes the honest claim: these are the sessions Claude did not do.
const NOT_CLAUDE = "(by_whom IS NULL OR by_whom <> 'claude')";
const IS_CLAUDE = "by_whom = 'claude'";

const router = express.Router();

const VALID_KINDS = new Set(['work', 'short', 'long']);

router.post('/', (req, res) => {
  const { kind, durationMinutes, taskId, label } = req.body;

  if (!VALID_KINDS.has(kind)) {
    res.status(400).json({ error: `kind must be one of ${[...VALID_KINDS].join(', ')}` });
    return;
  }
  const minutes = Number(durationMinutes);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    res.status(400).json({ error: 'durationMinutes must be a positive number' });
    return;
  }

  let resolvedTaskId = null;
  if (taskId != null) {
    const task = db.prepare('SELECT id FROM tasks WHERE id = ?').get(Number(taskId));
    resolvedTaskId = task ? task.id : null;
  }

  // req.by, never a guess. A request that does not say who it is is recorded 'unknown'.
  const info = db
    .prepare('INSERT INTO focus_sessions (task_id, kind, duration_minutes, by_whom) VALUES (?, ?, ?, ?)')
    .run(resolvedTaskId, kind, Math.round(minutes), req.by);

  const row = db.prepare('SELECT * FROM focus_sessions WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({
    id: row.id,
    taskId: row.task_id,
    kind: row.kind,
    durationMinutes: row.duration_minutes,
    completedAt: row.completed_at,
    byWhom: row.by_whom,
    label: label || undefined,
  });
});

// What Claude has actually worked on. Kept as a SEPARATE reading rather than a filter on
// the main stats, because the two answer different questions and blending them is the whole
// thing this is designed against: "how much did you focus" and "how much did the agent
// grind" are not the same number and must never share one.
router.get('/claude', (req, res) => {
  const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));

  const totals = db.prepare(
    `SELECT COUNT(*) AS sessions, COALESCE(SUM(duration_minutes), 0) AS minutes,
            MIN(date(completed_at)) AS since
       FROM focus_sessions
      WHERE ${IS_CLAUDE} AND date(completed_at) >= date('now','localtime',?)`
  ).get(`-${days - 1} days`);

  const byDay = db.prepare(
    `SELECT date(completed_at) AS day, COUNT(*) AS sessions,
            COALESCE(SUM(duration_minutes), 0) AS minutes
       FROM focus_sessions
      WHERE ${IS_CLAUDE} AND date(completed_at) >= date('now','localtime',?)
      GROUP BY day ORDER BY day DESC`
  ).all(`-${days - 1} days`);

  const yours = db.prepare(
    `SELECT COUNT(*) AS sessions FROM focus_sessions WHERE ${NOT_CLAUDE}`
  ).get();

  res.json({
    days,
    ...totals,
    byDay,
    // Stated beside it so the comparison is never implied to be like-for-like: one is an
    // agent recording its own runs, the other is a person choosing to start a timer.
    yourSessionsAllTime: yours.sessions,
    note: 'Claude sessions are recorded separately and are EXCLUDED from your streaks, '
      + 'totals and "days with a focus session". They are not a measure of your work, and '
      + 'the two are never summed.',
    recordedNothing: totals.sessions === 0
      ? 'No Claude sessions in this window. That is a statement about the record, not about '
        + 'whether work happened — sessions are recorded only when something calls this route.'
      : undefined,
  });
});

module.exports = router;
module.exports.NOT_CLAUDE = NOT_CLAUDE;
module.exports.IS_CLAUDE = IS_CLAUDE;

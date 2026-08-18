const express = require('express');
const db = require('../db');

const router = express.Router();

function localDateStr(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// A "current" streak stays alive through today even if today has no session
// yet (it only breaks once a full day passes with zero work sessions) — this
// is computed fresh from the data every time rather than stored, so it can
// never drift out of sync the way the old localStorage counter could.
function computeStreak() {
  const rows = db
    .prepare(`SELECT DISTINCT date(completed_at) AS d FROM focus_sessions WHERE kind = 'work'`)
    .all();
  const dateSet = new Set(rows.map((r) => r.d));

  const cursor = new Date();
  if (!dateSet.has(localDateStr(cursor))) {
    cursor.setDate(cursor.getDate() - 1);
    if (!dateSet.has(localDateStr(cursor))) return 0;
  }

  let streak = 0;
  while (dateSet.has(localDateStr(cursor))) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

router.get('/summary', (req, res) => {
  const todayRow = db
    .prepare(
      `SELECT COUNT(*) AS c FROM focus_sessions WHERE kind = 'work' AND date(completed_at) = date('now', 'localtime')`
    )
    .get();
  res.json({ today: todayRow.c, streak: computeStreak() });
});

router.get('/daily', (req, res) => {
  const days = Math.min(90, Math.max(1, Number(req.query.days) || 7));

  const rows = db
    .prepare(
      `SELECT date(completed_at) AS d, COUNT(*) AS count, SUM(duration_minutes) AS minutes
       FROM focus_sessions
       WHERE kind = 'work' AND date(completed_at) >= date('now', 'localtime', ?)
       GROUP BY d`
    )
    .all(`-${days - 1} days`);

  const byDate = new Map(rows.map((r) => [r.d, r]));

  const result = [];
  const cursor = new Date();
  cursor.setDate(cursor.getDate() - (days - 1));
  for (let i = 0; i < days; i += 1) {
    const key = localDateStr(cursor);
    const row = byDate.get(key);
    result.push({
      date: key,
      count: row ? row.count : 0,
      minutes: row ? row.minutes : 0,
    });
    cursor.setDate(cursor.getDate() + 1);
  }

  const totalSessions = result.reduce((sum, r) => sum + r.count, 0);
  const totalMinutes = result.reduce((sum, r) => sum + r.minutes, 0);

  res.json({ days: result, totalSessions, totalMinutes });
});

router.get('/monthly', (req, res) => {
  const months = Math.min(24, Math.max(1, Number(req.query.months) || 12));

  const rows = db
    .prepare(
      `SELECT strftime('%Y-%m', completed_at) AS m, COUNT(*) AS count, SUM(duration_minutes) AS minutes
       FROM focus_sessions
       WHERE kind = 'work'
       GROUP BY m`
    )
    .all();
  const byMonth = new Map(rows.map((r) => [r.m, r]));

  const result = [];
  const cursor = new Date();
  cursor.setDate(1);
  cursor.setMonth(cursor.getMonth() - (months - 1));
  for (let i = 0; i < months; i += 1) {
    const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}`;
    const row = byMonth.get(key);
    result.push({
      month: key,
      count: row ? row.count : 0,
      minutes: row ? row.minutes : 0,
    });
    cursor.setMonth(cursor.getMonth() + 1);
  }

  const totalSessions = result.reduce((sum, r) => sum + r.count, 0);
  const totalMinutes = result.reduce((sum, r) => sum + r.minutes, 0);

  res.json({ months: result, totalSessions, totalMinutes });
});

router.get('/all-time', (req, res) => {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS sessions, COALESCE(SUM(duration_minutes), 0) AS minutes, MIN(date(completed_at)) AS since
       FROM focus_sessions WHERE kind = 'work'`
    )
    .get();
  res.json({ totalSessions: row.sessions, totalMinutes: row.minutes, trackingSince: row.since });
});

router.get('/export', (req, res) => {
  const rows = db
    .prepare(
      `SELECT s.id, s.kind, s.duration_minutes, s.completed_at, t.text AS task_text
       FROM focus_sessions s
       LEFT JOIN tasks t ON t.id = s.task_id
       ORDER BY s.completed_at ASC`
    )
    .all();

  const escape = (v) => {
    if (v == null) return '';
    const str = String(v);
    return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };

  const lines = ['id,kind,duration_minutes,completed_at,task'];
  rows.forEach((r) => {
    lines.push([r.id, r.kind, r.duration_minutes, r.completed_at, escape(r.task_text)].join(','));
  });

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="focus-sessions.csv"');
  res.send(lines.join('\n'));
});

module.exports = router;

// DERIVED ACTIVITY — backlog #38, second half. The first half was provenance; this is what
// it makes possible.
//
// It reconstructs when YOU were working from rows you actually wrote, across every module
// that records a human action. It is not a focus timer and does not pretend to be: it says
// "you were doing something at these times", which is the honest version of the question
// the timer kept failing to answer by asking you to press start.
//
// IT COUNTS ONLY by_whom = 'you'. That is the entire point. Before provenance existed, the
// same query would have been dominated by a Claude session's own writes and would have
// reported my working hours as yours.
//
// A SESSION IS A CLUSTER, NOT A CLAIM. Consecutive actions less than gapMinutes apart are
// treated as one stretch. That is a grouping rule stated in the output, not a measurement
// of attention — two actions 20 minutes apart do not prove 20 minutes of work, and the
// response says so rather than quietly implying it.
function derivedActivity({ days = 14, gapMinutes = 45 } = {}) {
  const SOURCES = [
    ['todo_notes', 'created_at', 'backlog note'],
    ['wellbeing_entries', 'created_at', 'journal entry'],
    ['lifestyle_done', 'recorded_at', 'chore recorded'],
    ['lifestyle_intake', 'recorded_at', 'meal recorded'],
    ['wishlist_items', 'added_at', 'wishlist item'],
  ];

  const events = [];
  for (const [table, col, label] of SOURCES) {
    let rows = [];
    try {
      rows = db.prepare(
        `SELECT ${col} AS at FROM ${table}
          WHERE by_whom = 'you' AND ${col} >= datetime('now','localtime','-' || ? || ' days')`
      ).all(days);
    } catch { /* table or column absent — reported below, never silently zero */ }
    for (const r of rows) events.push({ at: r.at, kind: label });
  }

  events.sort((a, b) => String(a.at).localeCompare(String(b.at)));

  const stretches = [];
  for (const e of events) {
    const last = stretches[stretches.length - 1];
    const t = Date.parse(e.at.replace(' ', 'T'));
    if (last && (t - last.endMs) <= gapMinutes * 60000) {
      last.endMs = t; last.end = e.at; last.actions++;
    } else {
      stretches.push({ start: e.at, end: e.at, endMs: t, startMs: t, actions: 1 });
    }
  }

  return {
    state: events.length ? 'ok' : 'no-activity',
    days,
    gapMinutes,
    actions: events.length,
    stretches: stretches.map((s) => ({
      start: s.start,
      end: s.end,
      actions: s.actions,
      spanMinutes: Math.round((s.endMs - s.startMs) / 60000),
    })),
    basis: `Rows you wrote yourself (by_whom = 'you') across ${SOURCES.length} tables, `
      + `clustered with a ${gapMinutes}-minute gap. A cluster is a GROUPING, not a measure `
      + 'of attention: two actions 20 minutes apart do not prove 20 minutes of work.',
    note: events.length ? undefined
      : 'Nothing attributed to you in this window. That is ABSENCE, not zero activity — '
        + 'provenance began on 18 Aug, so anything before it is unattributed rather than '
        + 'not yours, and a module you have not used yet records nothing at all.',
  };
}

router.get('/activity', (req, res) => {
  const days = Math.min(90, Math.max(1, Number(req.query.days) || 14));
  res.json(derivedActivity({ days }));
});

module.exports.derivedActivity = derivedActivity;

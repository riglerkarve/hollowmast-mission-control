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

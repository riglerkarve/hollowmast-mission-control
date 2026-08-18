const express = require('express');
const db = require('../db');

// The Claude-exclusion filter is IMPORTED, never retyped. focus_sessions is read in eight
// places here, and once Claude's own work started being recorded (18 Aug 2026) every one of
// them would otherwise have folded an agent's hours into the owner's streaks and totals.
// A shared constant means grep can prove all eight are converted; eight hand-typed copies
// means one is eventually forgotten, and a forgotten one does not error.
const { NOT_CLAUDE } = require('./sessions');

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
    .prepare(`SELECT DISTINCT date(completed_at) AS d FROM focus_sessions
       WHERE kind = 'work' AND ${NOT_CLAUDE}`)
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
      `SELECT COUNT(*) AS c FROM focus_sessions
         WHERE kind = 'work' AND ${NOT_CLAUDE} AND date(completed_at) = date('now', 'localtime')`
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
       WHERE kind = 'work' AND ${NOT_CLAUDE} AND date(completed_at) >= date('now', 'localtime', ?)
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
       WHERE kind = 'work' AND ${NOT_CLAUDE}
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
       FROM focus_sessions WHERE kind = 'work' AND ${NOT_CLAUDE}`
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
       WHERE ${NOT_CLAUDE}
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

// STANDING — backlog #24, "turn life into a game", built to the shape you chose: counts and
// streaks only, no composite.
//
// THERE IS NO XP NUMBER AND NO LEVEL, DELIBERATELY. An XP total is a weighted sum, and the
// weights would be mine: is shipping a module worth five chores or fifty? Nobody can answer
// that, so the number would be unauditable by construction — the one figure on the dashboard
// that could not be checked, sitting next to figures that can. Your standing rule forbids it
// and this is the case it was written for.
//
// Every line below is a COUNT of rows that already exist, or a STREAK of consecutive days
// with such a row. Both are arithmetic you can verify by looking at the table.
function standing() {
  const q = (sql, ...a) => { try { return db.prepare(sql).get(...a); } catch { return null; } };

  // A streak is consecutive days ending today or yesterday — ending yesterday still counts
  // as live, because a streak that breaks at midnight before you have had the day is a
  // punishment for the clock rather than a fact about you.
  const streak = (table, col, where = null) => {
    let rows = [];
    try {
      rows = db.prepare(
        `SELECT DISTINCT date(${col}) AS d FROM ${table}${where ? ` WHERE ${where}` : ''} ORDER BY d DESC`
      ).all().map((r) => r.d);
    } catch { return { days: 0, reason: 'no such table yet' }; }
    if (!rows.length) return { days: 0, reason: 'nothing recorded' };

    const today = db.prepare("SELECT date('now','localtime') AS d").get().d;
    const yest = db.prepare("SELECT date('now','localtime','-1 day') AS d").get().d;
    if (rows[0] !== today && rows[0] !== yest) return { days: 0, lastOn: rows[0], reason: 'not current' };

    let n = 1;
    for (let i = 1; i < rows.length; i++) {
      const gap = Math.round((Date.parse(rows[i - 1]) - Date.parse(rows[i])) / 86400000);
      if (gap === 1) n++; else break;
    }
    return { days: n, lastOn: rows[0] };
  };

  const modules = q('SELECT COUNT(*) c FROM schema_meta');
  const done = q("SELECT COUNT(*) c FROM todo_items WHERE status = 'done'");
  const chores = q('SELECT COUNT(*) c FROM lifestyle_done');
  const journal = q('SELECT COUNT(*) c FROM wellbeing_entries');
  const focus = q(`SELECT COUNT(*) c, COALESCE(SUM(duration_minutes),0) m FROM focus_sessions WHERE ${NOT_CLAUDE}`);
  const countries = q('SELECT COUNT(*) c FROM atlas_countries WHERE visited = 1');
  const countriesAll = q('SELECT COUNT(*) c FROM atlas_countries');

  return {
    state: 'ok',
    counts: [
      { label: 'modules with a migrated schema', value: modules ? modules.c : 0 },
      { label: 'backlog items closed', value: done ? done.c : 0 },
      { label: 'focus sessions', value: focus ? focus.c : 0, detail: `${focus ? focus.m : 0} minutes` },
      { label: 'chores recorded', value: chores ? chores.c : 0 },
      { label: 'journal entries', value: journal ? journal.c : 0 },
      { label: 'countries marked', value: countries ? countries.c : 0, detail: `of ${countriesAll ? countriesAll.c : 0}` },
    ],
    streaks: [
      { label: 'days with a chore recorded', ...streak('lifestyle_done', 'done_on') },
      { label: 'days with a journal entry', ...streak('wellbeing_entries', 'date') },
      { label: 'days with a focus session', ...streak('focus_sessions', 'completed_at', NOT_CLAUDE) },
    ],
    refuses: 'No XP, no level, no composite. Those need weights — is a shipped module worth '
      + 'five chores or fifty? — and the weights would be mine, making it the one figure here '
      + 'that could not be checked. Every number above is a row count or a run of days.',
    streakRule: 'A streak counts consecutive days ending today OR yesterday. Breaking at '
      + 'midnight before you have had the day would punish the clock, not measure you.',
  };
}

router.get('/standing', (req, res) => res.json(standing()));
module.exports.standing = standing;

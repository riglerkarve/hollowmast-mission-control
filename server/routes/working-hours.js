'use strict';
//
// working-hours.js — the owner's weekly working-hours pattern, and the one queryable
// question it exists to answer: is a given moment inside it?
//
// Owner requirement, 25 Aug: a place to set which days/times he is actually working, so
// "appropriate time" scheduling — flagged skill-grant requests, non-urgent decisions — can
// later be surfaced during his real hours instead of whenever they arrive. THIS TASK ONLY
// builds the schedule itself and its query; nothing reads it yet. See CLAUDE.md/backlog for
// the follow-up that wires a consumer to isWithinWorkingHours().
//
// WHY NOT schedule.js: that module states its own scope in its header comment — "NO
// RECURRENCE, and no recurrence table. Anything that repeats on a fixed interval is a
// chore [or in this case a pattern], and a second recurrence engine here would be a second
// owner of the same figure, which is the one thing the module contract forbids outright."
// A weekly Mon-Fri 9-6 pattern is exactly the recurring shape that module refuses to hold.
// This is a different kind of fact — a standing PATTERN, not a dated event — so it gets its
// own table rather than bending schedule_events to hold something it was designed to reject.
//
// ONE ROW PER WEEKDAY, KEYED 0 (Sunday) TO 6 (Saturday) — the same convention JS
// Date.getDay() and SQLite's strftime('%w', ...) both use, so nothing here needs its own
// day-numbering translation layer.
//
// THE TABLE STARTS EMPTY. No row is seeded for any day, and no default (e.g. "Mon-Fri
// 9-6") is invented — the schedule.js module's own rule applies here word for word: an
// invented working-hours value in a settings table is indistinguishable from one the owner
// actually chose, and every automation that later reads it needs to trust that a set day
// really was set. A day with no row is simply "not set" and is treated as NOT within
// working hours, so nothing is ever surfaced during a day nobody said was a work day.
//
// ONE CLOCK, LOCAL WALL TIME — same discipline as schedule.js. Times are stored as
// 'HH:MM' with no offset. "Now", for the /check endpoint's default, comes from SQLite's
// localtime, exactly as schedule.js's localNow()/localToday() do, so the two modules can
// never disagree about what day or time it currently is.

const express = require('express');
const db = require('../db');

db.migrate('working_hours', [
  (d) => {
    d.exec(`
      CREATE TABLE working_hours (
        day_of_week INTEGER PRIMARY KEY,   -- 0=Sunday .. 6=Saturday
        enabled     INTEGER NOT NULL DEFAULT 0,
        start_time  TEXT,                  -- 'HH:MM', local wall clock
        end_time    TEXT,                  -- 'HH:MM', local wall clock
        updated_at  TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
      );
    `);
  },
]);

const router = express.Router();

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const isTime = (s) => /^\d{2}:\d{2}$/.test(String(s || ''));
function isRealTime(s) {
  if (!isTime(s)) return false;
  const [h, m] = s.split(':').map(Number);
  return h >= 0 && h <= 23 && m >= 0 && m <= 59;
}

// ONE CLOCK. Both come from SQLite's localtime — see the header note on why this must
// never be asked of the JS Date object instead.
const localNowParts = () => db.prepare(
  "SELECT CAST(strftime('%w','now','localtime') AS INTEGER) AS dow, strftime('%H:%M','now','localtime') AS hm, date('now','localtime') AS today"
).get();

function readAll() {
  const rows = db.prepare('SELECT * FROM working_hours ORDER BY day_of_week').all();
  const byDay = new Map(rows.map((r) => [r.day_of_week, r]));
  const days = [];
  for (let dow = 0; dow < 7; dow += 1) {
    const r = byDay.get(dow);
    days.push({
      dayOfWeek: dow,
      day: DAY_NAMES[dow],
      shortDay: DAY_SHORT[dow],
      // NOT SET is a real, distinct state from "set but off" — a day with no row at all
      // has never been given a value, and the panel needs to be able to say so rather
      // than rendering it identically to a day the owner deliberately turned off.
      set: !!r,
      enabled: !!(r && r.enabled),
      startTime: r ? r.start_time : null,
      endTime: r ? r.end_time : null,
      updatedAt: r ? r.updated_at : null,
    });
  }
  return days;
}

// ---------------------------------------------------------------------------- GET /
router.get('/', (req, res) => {
  let days;
  try {
    days = readAll();
  } catch (err) {
    return res.status(500).json({
      state: 'error',
      error: `could not read working hours: ${err.message}`,
      note: 'This is a failed read, not an empty schedule. Nothing below was computed.',
    });
  }

  const anySet = days.some((d) => d.set);
  res.json({
    state: anySet ? 'ok' : 'empty',
    message: anySet ? undefined
      : 'No working hours set yet. Nothing is treated as "in hours" until at least one day is set.',
    days,
    note: 'A day with no value is "not set", not "off" — the two are shown separately. '
      + 'Nothing here is invented: every start/end time on this list is one the owner entered.',
  });
});

// ---------------------------------------------------------------------------- PUT /
// Bulk set: { days: [{ dayOfWeek, enabled, startTime, endTime }, ...] }. One call rather
// than seven, because a week is what the owner actually thinks in when he sets this — a
// per-day endpoint would make "turn the whole week off" seven requests for one intention.
router.put('/', (req, res) => {
  const body = req.body || {};
  const input = Array.isArray(body.days) ? body.days : null;
  if (!input) return res.status(400).json({ error: 'body must be { days: [...] }' });

  const errors = [];
  const clean = [];
  for (const raw of input) {
    const dow = Number(raw.dayOfWeek);
    if (!Number.isInteger(dow) || dow < 0 || dow > 6) {
      errors.push(`dayOfWeek must be 0-6 (0=Sunday): got ${JSON.stringify(raw.dayOfWeek)}`);
      continue;
    }
    const enabled = !!raw.enabled;
    let startTime = null;
    let endTime = null;
    if (enabled) {
      startTime = String(raw.startTime || '').trim();
      endTime = String(raw.endTime || '').trim();
      if (!isRealTime(startTime)) {
        errors.push(`${DAY_NAMES[dow]}: startTime must be HH:MM, got ${JSON.stringify(raw.startTime)}`);
        continue;
      }
      if (!isRealTime(endTime)) {
        errors.push(`${DAY_NAMES[dow]}: endTime must be HH:MM, got ${JSON.stringify(raw.endTime)}`);
        continue;
      }
      if (endTime <= startTime) {
        errors.push(`${DAY_NAMES[dow]}: endTime (${endTime}) must be after startTime (${startTime})`);
        continue;
      }
    }
    clean.push({ dow, enabled, startTime, endTime });
  }

  if (errors.length) return res.status(400).json({ error: 'invalid input', details: errors });
  if (!clean.length) return res.status(400).json({ error: 'no valid days in body.days' });

  const upsert = db.prepare(`
    INSERT INTO working_hours (day_of_week, enabled, start_time, end_time, updated_at)
    VALUES (?, ?, ?, ?, datetime('now', 'localtime'))
    ON CONFLICT(day_of_week) DO UPDATE SET
      enabled = excluded.enabled, start_time = excluded.start_time,
      end_time = excluded.end_time, updated_at = excluded.updated_at
  `);
  for (const c of clean) upsert.run(c.dow, c.enabled ? 1 : 0, c.startTime, c.endTime);

  res.json({ state: 'ok', updated: clean.map((c) => c.dow), days: readAll() });
});

// ---------------------------------------------------------------------------- GET /check
// The payoff the whole module exists for: is a given moment inside working hours? Answers
// with a boolean AND the reasoning, because a bare true/false a future consumer disagrees
// with is unauditable — this shows exactly which day's row (or absence of one) decided it.
//
// ?at=YYYY-MM-DDTHH:MM to check a specific local moment; omitted means right now, taken
// from SQLite's localtime so it can never disagree with schedule.js about what day it is.
router.get('/check', (req, res) => {
  const at = req.query.at;
  let dow;
  let hm;
  let today;
  if (at !== undefined) {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(at));
    if (!m) return res.status(400).json({ error: `"${at}" is not YYYY-MM-DDTHH:MM local wall-clock time` });
    // getUTCDay on a UTC-midnight parse, same technique as schedule.js's weekdayOf — the
    // local getter would misname the weekday for a date string with no time zone attached.
    const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    dow = d.getUTCDay();
    hm = `${m[4]}:${m[5]}`;
    today = `${m[1]}-${m[2]}-${m[3]}`;
  } else {
    ({ dow, hm, today } = localNowParts());
  }

  let row;
  try {
    row = db.prepare('SELECT * FROM working_hours WHERE day_of_week = ?').get(dow);
  } catch (err) {
    return res.status(500).json({ error: `could not read working hours: ${err.message}` });
  }

  let inHours = false;
  let reason;
  if (!row) {
    reason = `${DAY_NAMES[dow]} has no working-hours value set.`;
  } else if (!row.enabled) {
    reason = `${DAY_NAMES[dow]} is set but marked off.`;
  } else if (hm >= row.start_time && hm < row.end_time) {
    inHours = true;
    reason = `${DAY_NAMES[dow]} ${row.start_time}\u2013${row.end_time} covers ${hm}.`;
  } else {
    reason = `${DAY_NAMES[dow]} is ${row.start_time}\u2013${row.end_time}; ${hm} is outside that.`;
  }

  res.json({
    at: at || `${today}T${hm}`,
    dayOfWeek: dow,
    day: DAY_NAMES[dow],
    time: hm,
    inHours,
    reason,
  });
});

router.all('*', (req, res) => {
  const attempted = req.params[0] ? `/${String(req.params[0]).replace(/^\/+/, '')}` : req.path;
  res.status(404).json({
    error: `no such working-hours endpoint: ${req.method} ${attempted}`,
    endpoints: [
      'GET  /              the week, one entry per day (set/enabled/start/end)',
      'PUT  / { days }     bulk-set some or all days: [{ dayOfWeek, enabled, startTime, endTime }]',
      'GET  /check?at=     is a local YYYY-MM-DDTHH:MM (or now, if omitted) within working hours?',
    ],
  });
});

module.exports = router;

// Attached AFTER the router export — see social.js's own comment on this pattern. Exported
// so another module can ask "is now within working hours?" as a direct function call
// rather than an HTTP round trip to itself; the route above and this function share the
// exact same logic path (readAll + strftime), never two.
module.exports.isWithinWorkingHours = function isWithinWorkingHours(atLocalIso) {
  let dow;
  let hm;
  if (atLocalIso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(atLocalIso));
    if (!m) throw new Error(`"${atLocalIso}" is not YYYY-MM-DDTHH:MM local wall-clock time`);
    const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    dow = d.getUTCDay();
    hm = `${m[4]}:${m[5]}`;
  } else {
    ({ dow, hm } = localNowParts());
  }
  const row = db.prepare('SELECT * FROM working_hours WHERE day_of_week = ?').get(dow);
  return !!(row && row.enabled && hm >= row.start_time && hm < row.end_time);
};

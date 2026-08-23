//
// WHO OWNS A DATED COMMITMENT — decided by the owner, 18 Aug 2026 (backlog M65).
//
//   The SCHEDULE owns a date somebody else set   — a GP appointment, a course, a hearing.
//   The BACKLOG owns intent                      — renewing a passport, replacing a licence.
//
// The split is on WHO CHOSE THE DATE, which is answerable without thinking; that is what makes
// it survive a busy week. Before this, the same commitment lived in both — a provisional
// licence replacement was a diary entry AND backlog #48 — so clearing it in one place left the
// other saying it had never been done, and neither list could be trusted alone.
//
// `tools/duplicate-commitments.cjs` finds overlaps. It only reports: which side set the date is
// a fact about the owner's life, not about the data, and a script that guessed would delete
// diary entries on a hunch.

const express = require('express');
const db = require('../db');

// ------------------------------------------------------------------------------------
// SCHEDULE. The things with a date attached that currently live nowhere — passport
// renewal, the provisional licence replacement, CBT, the GP. Backlog 64 ("appointment
// tracker") and 44 ("viewable, interactable schedule") are one table seen twice, so they
// are one module rather than two panels you would have to keep in step.
//
// WHAT IT STORES: a title, when it is, and what you decided about it afterwards. Nothing
// else. Every state, count and grouping below is arithmetic done at request time — none
// of it is written to the database, because a stored "overdue" flag is wrong by morning
// and nothing would ever tell you.
//
// WHAT IT DERIVES — the reason it clears the gate rather than being a form with a nice font:
//   - daysUntil and a state for every event, from the stored date and today.
//   - OVERDUE: an appointment whose day has passed while it is still 'scheduled'. This is
//     the single most useful thing here. A slot you did not attend leaves no trace anywhere
//     — it just recedes — so this module puts it at the top and asks you to say which it
//     was. It is also the only figure here that changes on its own overnight.
//   - lead time on 'deadline' rows: how many days are left.
//   - the free/busy SHAPE of the next 14 days: which days have nothing written on them.
//
// WHAT IT DELIBERATELY WILL NOT DO:
//   - NO RECURRENCE, and no recurrence table. Anything that repeats on a fixed interval is
//     a chore, and the lifestyle module already derives that from last-done + interval. A
//     second recurrence engine here would be a second owner of the same figure, which is
//     the one thing the module contract forbids outright.
//   - NO PRIORITY SCORE and no urgency weighting. `daysUntil` is a fact you can check
//     against a calendar; a number I invented and labelled "urgency" is the one figure
//     nobody could ever audit. Ordering here is by date, which is arithmetic, not judgement.
//   - NO FORECAST. "Free" below means "nothing is written down in this module on that day".
//     It never means you are free, and the response says so in its own words.
//   - NO SEEDED EVENTS. The lifestyle module seeds chore NAMES, which costs nothing. Seeding
//     an appointment would mean inventing a date, and an invented date in a schedule is
//     indistinguishable from one you set. The table starts empty and says so.
//
// ONE CLOCK, AND IT IS LOCAL WALL TIME.
//   `starts_at` is stored as local wall-clock ISO — '2026-09-03' for an all-day row,
//   '2026-09-03T09:15' for a timed one — with NO 'Z' and NO offset. A GP appointment at
//   09:15 means 09:15 on the clock in the room; it is not an instant that needs converting.
//   Anything carrying a Z or an offset is REFUSED rather than silently converted, because
//   this machine is UK/BST and `new Date().toISOString()` names the previous day for the
//   first hour after local midnight — which would put a late-evening event on the wrong day
//   and quietly mark it overdue a day early. "today" comes from SQLite's localtime, once,
//   in localToday(), exactly as the lifestyle module does it.
// ------------------------------------------------------------------------------------

db.migrate('schedule', [
  (d) => {
    d.exec(`
      CREATE TABLE schedule_events (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        title      TEXT NOT NULL,
        -- Local wall-clock ISO. 'YYYY-MM-DD' when all_day, 'YYYY-MM-DDTHH:MM' otherwise.
        -- Both sort lexicographically in the same order they occur, which is what lets the
        -- range queries below use the index instead of a substr() per row.
        starts_at  TEXT NOT NULL,
        ends_at    TEXT,
        all_day    INTEGER NOT NULL DEFAULT 0,
        location   TEXT,
        kind       TEXT NOT NULL DEFAULT 'appointment',   -- appointment|deadline|reminder|other
        note       TEXT,
        -- 'scheduled' is the only status that can be overdue. done/missed/cancelled are all
        -- decisions you made, and the point of the module is the gap between the two.
        status     TEXT NOT NULL DEFAULT 'scheduled',     -- scheduled|done|missed|cancelled
        created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
      );

      CREATE INDEX idx_sched_starts ON schedule_events(starts_at);
      CREATE INDEX idx_sched_status ON schedule_events(status, starts_at);
    `);
  },
]);

const router = express.Router();

const KINDS = ['appointment', 'deadline', 'reminder', 'other'];
const STATUSES = ['scheduled', 'done', 'missed', 'cancelled'];

// How far ahead GET / looks. Disclosed in the response as `window`, and everything the
// window drops is counted and reported — a horizon that silently hides two events in
// October makes the schedule look emptier than it is.
const HORIZON_DAYS = 30;

// The free/busy strip length. Also disclosed.
const FREE_BUSY_DAYS = 14;

// The boundary between 'this week' and 'later'. It is a GROUPING for the panel, not a
// weight and not a score: `daysUntil` is returned raw on every event and this number comes
// back as `thisWeekWithinDays`, so any grouping decision can be checked by hand.
const THIS_WEEK_DAYS = 7;

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// ONE CLOCK. Both of these come from SQLite's localtime and nothing else in this file asks
// the JS Date object what day it is.
const localToday = () => db.prepare("SELECT date('now','localtime') AS d").get().d;
// datetime('now','localtime') is 'YYYY-MM-DD HH:MM:SS'; normalised to the same shape the
// stored values use so the two can be string-compared directly.
const localNow = () => db.prepare("SELECT datetime('now','localtime') AS d").get().d.replace(' ', 'T').slice(0, 16);

const isISODate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

// Both operands are 'YYYY-MM-DD', which Date.parse reads as UTC midnight, so the difference
// is an exact whole number of days with no DST term in it.
const dayDiff = (later, earlier) => Math.round((Date.parse(later) - Date.parse(earlier)) / 86400000);
const addDays = (date, n) => new Date(Date.parse(date) + n * 86400000).toISOString().slice(0, 10);
// getUTCDay, not getDay: the string parsed to UTC midnight, so the local getter would name
// the wrong weekday for anywhere west of Greenwich and, on a BST evening, occasionally here.
const weekdayOf = (date) => WEEKDAYS[new Date(Date.parse(date)).getUTCDay()];

// A regex match is not a date. '2026-02-30' and '2026-13-01' both pass the pattern and then
// silently become March and January, which would land an appointment on a day you never
// chose. Rebuild it and check it survived.
function isRealDate(d) {
  const [y, m, dd] = d.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, dd));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === dd;
}

// ---------------------------------------------------------------------------- when
// Normalises one user-supplied moment into the stored form, or explains why it cannot.
// Returns { value, allDay } or { error }.
function normaliseWhen(raw, wantAllDay) {
  let s = String(raw == null ? '' : raw).trim();
  if (!s) return { error: 'a date is required' };

  // Refused, not converted. See the header: an offset or a Z makes this an instant rather
  // than a wall-clock time, and converting it here is how a 23:30 appointment ends up filed
  // on the following day with nothing to show for it.
  if (/(Z|[+-]\d{2}:?\d{2})$/i.test(s.slice(10))) {
    return { error: `"${s}" carries a timezone. This module stores local wall-clock time only `
      + '(YYYY-MM-DD or YYYY-MM-DDTHH:MM) — 09:15 means 09:15 on the clock, not an instant to convert.' };
  }

  s = s.replace(' ', 'T');                       // SQLite-style 'YYYY-MM-DD HH:MM' is accepted
  const m = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}):(\d{2})(?::\d{2})?)?$/.exec(s);
  if (!m) return { error: `"${raw}" is not a date. Use YYYY-MM-DD, or YYYY-MM-DDTHH:MM for a time.` };

  const date = m[1];
  if (!isRealDate(date)) return { error: `"${date}" is not a real calendar date` };

  const hasTime = m[2] !== undefined;
  if (hasTime && (Number(m[2]) > 23 || Number(m[3]) > 59)) {
    return { error: `"${raw}" has an impossible time` };
  }

  // Seconds are dropped: minutes are the unit anything here is ever scheduled in, and a
  // mix of 'T09:00' and 'T09:00:00' in one column sorts the two apart for no reason.
  //
  // allDay is INFERRED when it was not stated. A date with no time IS an all-day row —
  // asking the caller to say so twice is a second thing to get wrong.
  const allDay = wantAllDay === undefined || wantAllDay === null ? !hasTime : !!wantAllDay;
  if (allDay) return { value: date, allDay: true };
  if (!hasTime) return { error: `"${raw}" has no time, but the event was marked as not all-day` };
  return { value: `${date}T${m[2]}:${m[3]}`, allDay: false };
}

// ---------------------------------------------------------------------------- derive
// Everything the module knows that you did not type is computed HERE, once, from the two
// stored columns plus today. No panel recomputes any of it — a second copy of `daysUntil`
// would drift from this one without either erroring.
function decorate(r, today, now) {
  const day = r.starts_at.slice(0, 10);
  const daysUntil = dayDiff(day, today);
  const resolved = r.status !== 'scheduled';
  const endDay = r.ends_at ? r.ends_at.slice(0, 10) : null;

  // FIVE states, not four. The brief asked for overdue | today | this week | later, but a
  // past event you already marked 'done' is none of those: calling it overdue would be a
  // false alarm, and 'later' would be a lie. 'past' is that fifth case and it is the reason
  // 'overdue' can stay meaningful — overdue here means "the day went by and you never said
  // what happened", which is the only state that needs anything from you.
  let state;
  if (daysUntil < 0) state = resolved ? 'past' : 'overdue';
  else if (daysUntil === 0) state = 'today';
  else if (daysUntil <= THIS_WEEK_DAYS) state = 'this week';
  else state = 'later';

  return {
    id: r.id,
    title: r.title,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    allDay: !!r.all_day,
    location: r.location,
    kind: r.kind,
    note: r.note,
    status: r.status,
    createdAt: r.created_at,

    day,
    weekday: weekdayOf(day),
    time: r.all_day ? null : r.starts_at.slice(11, 16),
    endTime: r.all_day || !r.ends_at || r.ends_at.length < 16 ? null : r.ends_at.slice(11, 16),

    daysUntil,                                   // negative = in the past
    state,
    overdueByDays: state === 'overdue' ? -daysUntil : 0,
    resolved,

    // A fact, not a state change. An appointment at 09:00 is not "missed" at 09:01 — you
    // are probably sitting in the waiting room. Reported so the panel can grey out a slot
    // that has already started, and never used to decide anything.
    startTimePassed: r.all_day || day !== today ? null : r.starts_at <= now,

    // LEAD TIME. The same arithmetic as daysUntil, named for the kind that asks the
    // question in those words — not a second measurement, and it says so rather than
    // appearing beside daysUntil as though it were independently derived.
    leadTimeDays: r.kind === 'deadline' ? daysUntil : null,
    leadTimeNote: r.kind === 'deadline'
      ? (daysUntil < 0 ? `The deadline was ${-daysUntil} day${daysUntil === -1 ? '' : 's'} ago.`
        : `${daysUntil} day${daysUntil === 1 ? '' : 's'} left. This is daysUntil under the name a deadline asks for; it is one number, not two.`)
      : null,

    // An event is listed on the day it STARTS. ends_at is stored and shown, and it never
    // spreads a row across the days between — stated because a multi-day row silently
    // absent from the days it covers is exactly the kind of gap a free/busy view hides.
    multiDay: !!(endDay && endDay !== day),
    endsOnDay: endDay,
  };
}

// Date order, ascending. Not a ranking: it is the order the days arrive in.
const byWhen = (a, b) => (a.startsAt < b.startsAt ? -1 : a.startsAt > b.startsAt ? 1 : a.id - b.id);

function readAll() {
  const today = localToday();
  const now = localNow();
  const rows = db.prepare('SELECT * FROM schedule_events ORDER BY starts_at, id').all();
  return { today, now, events: rows.map((r) => decorate(r, today, now)) };
}

// ---------------------------------------------------------------------------- free/busy
// The SHAPE of the next fortnight: which days have nothing written on them. This is a
// statement about the contents of one table, never a claim about your availability, and the
// note says so in the response rather than leaving the panel to remember.
function freeBusy(events, today, days) {
  const from = today;
  const to = addDays(today, days - 1);

  // Cancelled rows are excluded — a cancelled appointment does not occupy the day. That is
  // a filter, so it reports its residue: how many rows it dropped, and from which dates.
  const inWindow = events.filter((e) => e.day >= from && e.day <= to);
  const cancelled = inWindow.filter((e) => e.status === 'cancelled');
  const counted = inWindow.filter((e) => e.status !== 'cancelled');

  const byDay = new Map();
  for (const e of counted) byDay.set(e.day, (byDay.get(e.day) || 0) + 1);

  const series = [];
  for (let i = 0; i < days; i += 1) {
    const date = addDays(today, i);
    const n = byDay.get(date) || 0;
    series.push({ date, weekday: weekdayOf(date), isToday: i === 0, eventCount: n, free: n === 0 });
  }

  return {
    days,
    from,
    to,
    series,
    freeDays: series.filter((s) => s.free).length,
    freeDates: series.filter((s) => s.free).map((s) => s.date),
    busyDays: series.filter((s) => !s.free).length,
    excluded: {
      cancelled: cancelled.length,
      dates: cancelled.map((e) => e.day),
      why: 'Cancelled rows do not occupy a day, so they are not counted as busy. They are still listed in the agenda.',
    },
    // The one sentence that stops this being a lie.
    note: `"Free" means nothing is written down in this module on that day. It is not a claim `
      + `that you are available, and it does not know about anything you never entered. `
      + `Multi-day events are counted only on the day they start.`,
  };
}

// ---------------------------------------------------------------------------- GET /
// async only so the social module can be ASKED for its outstanding posts. Nothing about
// the schedule's own reads changed; see the `suggested` key at the bottom of the response.
router.get('/', async (req, res) => {
  let today; let now; let events;
  try {
    ({ today, now, events } = readAll());
  } catch (err) {
    // "Could not read the schedule" and "there is nothing in the schedule" are different
    // sentences and must never render the same. This one is a 500 with the reason in it;
    // the empty case below is a 200 that says so.
    return res.status(500).json({
      state: 'error',
      error: `could not read the schedule: ${err.message}`,
      note: 'This is a failed read, not an empty schedule. Nothing below was computed.',
    });
  }

  // Outstanding social posts, from the module that owns them. A failure here must never
  // take the schedule down with it: the schedule is the load-bearing thing on this page and
  // the posts are an addition to it, so anything that goes wrong degrades to an empty list
  // with a stated reason.
  let suggested = { source: 'social', items: [], note: null };
  try {
    const { pendingQueue } = require('./social');
    const q = await pendingQueue();
    suggested = {
      source: 'social',
      items: q.available
        ? q.pending.filter((p) => p.suggestedFor).map((p) => ({
            n: p.n, suggestedFor: p.suggestedFor, text: p.text,
            hasImage: Boolean(p.image), composeUrl: p.composeUrl,
          }))
        : [],
      note: 'Bluesky posts written but not yet out. THESE ARE NOT DIARY ENTRIES. The day is '
        + 'arithmetic from the cadence written in SOCIAL-POSTS.md and the date of the last actual '
        + 'post, so it moves when you post. Nothing here is stored in schedule_events, and nothing '
        + 'here counts as overdue.',
    };
    if (q.available && q.feedState !== 'ok') {
      suggested.note += ' WARNING: the account feed could not be read, so posts already out may still be listed.';
    }
  } catch (err) {
    suggested.note = `Could not read the social queue: ${err.message}. This is a failed read, not an empty queue.`;
  }

  if (!events.length) {
    return res.json({
      state: 'empty',
      suggested,
      today,
      now,
      message: 'Nothing in the schedule yet. Add the first thing with a date on it — a passport '
        + 'renewal, a licence replacement, a CBT booking, a GP appointment — and this starts working.',
      note: 'The table is empty. That is different from a read that failed, which answers 500 with a reason.',
      window: { from: today, to: addDays(today, HORIZON_DAYS - 1), days: HORIZON_DAYS },
      overdue: { count: 0, events: [] },
      days: [],
      deadlines: [],
      freeBusy: freeBusy([], today, FREE_BUSY_DAYS),
      counts: { total: 0, inWindow: 0, overdue: 0, today: 0, thisWeek: 0, later: 0, beyondWindowScheduled: 0, pastResolved: 0 },
    });
  }

  const winFrom = today;
  const winTo = addDays(today, HORIZON_DAYS - 1);
  const inWindow = events.filter((e) => e.day >= winFrom && e.day <= winTo).sort(byWhen);

  // THE POINT OF THE MODULE. Most overdue first — that is arithmetic on the stored dates,
  // not a weighting.
  const overdue = events.filter((e) => e.state === 'overdue')
    .sort((a, b) => b.overdueByDays - a.overdueByDays || byWhen(a, b));

  // Grouped by day, and only days that HAVE something. A 30-row list of mostly-empty days
  // is noise; emptiness is answered properly by freeBusy below, over a stated window.
  const dayMap = new Map();
  for (const e of inWindow) {
    if (!dayMap.has(e.day)) {
      dayMap.set(e.day, {
        date: e.day,
        weekday: e.weekday,
        daysUntil: e.daysUntil,
        isToday: e.daysUntil === 0,
        events: [],
      });
    }
    dayMap.get(e.day).events.push(e);
  }
  const days = [...dayMap.values()];

  const deadlines = events.filter((e) => e.kind === 'deadline' && e.status === 'scheduled').sort(byWhen);
  const nextUp = inWindow.find((e) => e.status === 'scheduled' && e.daysUntil >= 0) || null;

  // The horizon is a filter, so it reports what it dropped. Two events in October are not
  // "nothing coming up", and without this count the panel could not tell the difference.
  const beyond = events.filter((e) => e.day > winTo && e.status === 'scheduled');

  res.json({
    state: 'ok',
    today,
    now,
    thisWeekWithinDays: THIS_WEEK_DAYS,
    window: { from: winFrom, to: winTo, days: HORIZON_DAYS },

    overdue: {
      count: overdue.length,
      events: overdue,
      note: overdue.length
        ? 'The day passed and these were never marked done, missed or cancelled. Nothing else '
          + 'will tell you this — a slot you did not attend simply recedes.'
        : 'Nothing has gone past without you saying what happened to it.',
    },

    nextUp,
    days,
    deadlines,
    freeBusy: freeBusy(events, today, FREE_BUSY_DAYS),

    counts: {
      total: events.length,
      inWindow: inWindow.length,
      overdue: overdue.length,
      today: events.filter((e) => e.state === 'today').length,
      thisWeek: events.filter((e) => e.state === 'this week').length,
      later: events.filter((e) => e.state === 'later').length,
      // Residue of the 30-day horizon, named so it cannot be mistaken for part of it.
      beyondWindowScheduled: beyond.length,
      nextBeyondWindow: beyond.length ? beyond.sort(byWhen)[0].day : null,
      pastResolved: events.filter((e) => e.state === 'past').length,
      cancelledInWindow: inWindow.filter((e) => e.status === 'cancelled').length,
    },

    suggested,

    derived: 'daysUntil, state, overdueByDays, lead time and the free/busy shape are computed '
      + 'from starts_at and today on every request. None of it is stored, so none of it can go stale. '
      + 'Ordering is by date only — there is no priority score here and there will not be one.',
  });
});

// ---------------------------------------------------------------------------- GET /events
router.get('/events', (req, res) => {
  const { from, to, status } = req.query;

  if (from && !isISODate(from)) return res.status(400).json({ error: 'from must be YYYY-MM-DD' });
  if (to && !isISODate(to)) return res.status(400).json({ error: 'to must be YYYY-MM-DD' });
  if (status && !STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of ${STATUSES.join(', ')}` });
  }

  let today; let now; let all;
  try {
    ({ today, now, events: all } = readAll());
  } catch (err) {
    return res.status(500).json({ state: 'error', error: `could not read the schedule: ${err.message}` });
  }

  // Filtering happens here rather than in SQL so the residue can be counted against the
  // same list it was removed from. A filter that reports "12 results" without saying what
  // it dropped makes the surviving evidence look cleaner than it is.
  let kept = all;
  const dropped = { beforeFrom: 0, afterTo: 0, otherStatus: 0 };
  if (from) { const n = kept.length; kept = kept.filter((e) => e.day >= from); dropped.beforeFrom = n - kept.length; }
  if (to) { const n = kept.length; kept = kept.filter((e) => e.day <= to); dropped.afterTo = n - kept.length; }
  if (status) { const n = kept.length; kept = kept.filter((e) => e.status === status); dropped.otherStatus = n - kept.length; }

  const anyFilter = !!(from || to || status);
  res.json({
    // Three answers, never two: nothing stored at all, nothing matching these filters, and
    // some matches. A caller that cannot tell the first two apart will read an over-tight
    // filter as an empty schedule.
    state: all.length === 0 ? 'empty' : (kept.length === 0 ? 'no-match' : 'ok'),
    message: all.length === 0
      ? 'Nothing in the schedule yet.'
      : (kept.length === 0 ? `Nothing matches. ${all.length} event${all.length === 1 ? '' : 's'} stored, all excluded by the filters.` : undefined),
    today,
    now,
    filters: { from: from || null, to: to || null, status: status || null, applied: anyFilter },
    excludedByFilter: anyFilter ? { ...dropped, total: all.length - kept.length } : { total: 0 },
    // What the filters do NOT key on, said out loud: `kind` is not filterable here, and a
    // date range is matched against the START day only, so a multi-day event beginning
    // before `from` will not appear even though it covers days inside the range.
    filterScope: 'from/to match the day an event STARTS on, not the days it covers. kind is not filtered here.',
    count: kept.length,
    totalStored: all.length,
    events: kept.sort(byWhen),
  });
});

// ---------------------------------------------------------------------------- POST /events
router.post('/events', (req, res) => {
  const b = req.body || {};
  const title = String(b.title || '').trim();
  if (!title) return res.status(400).json({ error: 'title is required' });

  const kind = b.kind === undefined || b.kind === null || b.kind === '' ? 'appointment' : String(b.kind);
  if (!KINDS.includes(kind)) return res.status(400).json({ error: `kind must be one of ${KINDS.join(', ')}` });

  const status = b.status === undefined || b.status === null || b.status === '' ? 'scheduled' : String(b.status);
  if (!STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of ${STATUSES.join(', ')}` });

  const start = normaliseWhen(b.startsAt !== undefined ? b.startsAt : b.starts_at, b.allDay);
  if (start.error) return res.status(400).json({ error: `startsAt: ${start.error}` });

  let endsAt = null;
  const rawEnd = b.endsAt !== undefined ? b.endsAt : b.ends_at;
  if (rawEnd !== undefined && rawEnd !== null && String(rawEnd).trim() !== '') {
    // The end inherits the start's all-day-ness. A timed start with an all-day end (or the
    // reverse) makes every duration and every ordering below meaningless.
    const end = normaliseWhen(rawEnd, start.allDay);
    if (end.error) return res.status(400).json({ error: `endsAt: ${end.error}` });
    if (end.value < start.value) {
      return res.status(400).json({ error: `endsAt ${end.value} is before startsAt ${start.value}` });
    }
    endsAt = end.value;
  }

  const info = db.prepare(
    `INSERT INTO schedule_events (title, starts_at, ends_at, all_day, location, kind, note, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    title, start.value, endsAt, start.allDay ? 1 : 0,
    String(b.location || '').trim() || null, kind,
    String(b.note || '').trim() || null, status
  );

  const today = localToday();
  const row = db.prepare('SELECT * FROM schedule_events WHERE id = ?').get(Number(info.lastInsertRowid));
  const out = decorate(row, today, localNow());

  // The capture returns the derived value immediately, as the gate requires: you find out
  // how far away it is at the moment you write it down.
  res.status(201).json({
    ...out,
    // A past date is allowed — backfilling an appointment you already had is legitimate —
    // but it lands as overdue the instant it is saved, so that is stated rather than
    // discovered later on the panel.
    warning: out.state === 'overdue'
      ? `Saved with a date ${out.overdueByDays} day${out.overdueByDays === 1 ? '' : 's'} in the past and status 'scheduled', so it is already overdue. Mark it done or missed if it has been dealt with.`
      : undefined,
  });
});

// ---------------------------------------------------------------------------- PATCH /events/:id
// One endpoint for both editing and deciding, because "mark it done" is just a status edit
// and a second endpoint for it would be a second place the same column is written.
router.patch('/events/:id', (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM schedule_events WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'no such event' });

  const b = req.body || {};
  const has = (k) => Object.prototype.hasOwnProperty.call(b, k);

  const title = has('title') ? String(b.title || '').trim() : row.title;
  if (!title) return res.status(400).json({ error: 'title cannot be empty' });

  const kind = has('kind') ? String(b.kind) : row.kind;
  if (!KINDS.includes(kind)) return res.status(400).json({ error: `kind must be one of ${KINDS.join(', ')}` });

  const status = has('status') ? String(b.status) : row.status;
  if (!STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of ${STATUSES.join(', ')}` });

  // Start and end are re-normalised TOGETHER whenever either of them or the all-day flag
  // moves. Editing just the time on an all-day row, or just the flag, otherwise leaves the
  // two columns in shapes that cannot be compared with each other.
  const wantAllDay = has('allDay') ? !!b.allDay : (has('startsAt') ? undefined : !!row.all_day);
  const start = normaliseWhen(has('startsAt') ? b.startsAt : row.starts_at, wantAllDay);
  if (start.error) return res.status(400).json({ error: `startsAt: ${start.error}` });

  let endsAt = null;
  const rawEnd = has('endsAt') ? b.endsAt : row.ends_at;
  if (rawEnd !== undefined && rawEnd !== null && String(rawEnd).trim() !== '') {
    const end = normaliseWhen(rawEnd, start.allDay);
    if (end.error) return res.status(400).json({ error: `endsAt: ${end.error}` });
    if (end.value < start.value) {
      return res.status(400).json({ error: `endsAt ${end.value} is before startsAt ${start.value}` });
    }
    endsAt = end.value;
  }

  db.prepare(
    `UPDATE schedule_events SET title = ?, starts_at = ?, ends_at = ?, all_day = ?,
       location = ?, kind = ?, note = ?, status = ? WHERE id = ?`
  ).run(
    title, start.value, endsAt, start.allDay ? 1 : 0,
    has('location') ? (String(b.location || '').trim() || null) : row.location,
    kind,
    has('note') ? (String(b.note || '').trim() || null) : row.note,
    status, id
  );

  const fresh = decorate(db.prepare('SELECT * FROM schedule_events WHERE id = ?').get(id), localToday(), localNow());
  res.json({
    ...fresh,
    // Says what changed rather than only what the row now is — otherwise a PATCH that
    // silently ignored an unknown field looks identical to one that applied it.
    changed: ['title', 'startsAt', 'endsAt', 'allDay', 'location', 'kind', 'note', 'status'].filter(has),
    ignored: Object.keys(b).filter((k) => !['title', 'startsAt', 'endsAt', 'allDay', 'location', 'kind', 'note', 'status'].includes(k)),
    statusNote: has('status') && status !== 'scheduled'
      ? `Marked "${status}". It will no longer appear as overdue.`
      : undefined,
  });
});

// ---------------------------------------------------------------------------- DELETE
router.delete('/events/:id', (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM schedule_events WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'no such event' });

  db.prepare('DELETE FROM schedule_events WHERE id = ?').run(id);
  res.json({
    deleted: id,
    title: row.title,
    startsAt: row.starts_at,
    // Deleting and marking cancelled are different acts and the response says so, because
    // one of them keeps the record that it was ever in the diary and the other does not.
    note: 'Gone. If you wanted to keep the record that it existed, PATCH status to "cancelled" instead.',
  });
});

// Express 4 wildcard — a bare '*' with the matched remainder in req.params[0]. (Express 5's
// '/*splat' form matches nothing here and returns no error, which reads as a routing bug.)
// It exists so a mistyped endpoint answers with a named failure in JSON rather than falling
// through to the static handler and returning HTML the panel would read as a parse error.
router.all('*', (req, res) => {
  const attempted = req.params[0] ? `/${String(req.params[0]).replace(/^\/+/, '')}` : req.path;
  res.status(404).json({
    error: `no such schedule endpoint: ${req.method} ${attempted}`,
    endpoints: [
      'GET    /                       next 30 days by day, what is overdue, and the 14-day shape',
      'GET    /events?from=&to=&status=',
      'POST   /events                 { title, startsAt, endsAt?, allDay?, location?, kind?, note?, status? }',
      'PATCH  /events/:id             any subset of the same fields',
      'DELETE /events/:id',
    ],
    kinds: KINDS,
    statuses: STATUSES,
  });
});

// For the briefing to ASK rather than join. The moment anything else reads
// schedule_events directly, the two cannot be changed independently — so the accessor
// exists before the temptation does. Returns the same derived shape as the API.
function upcoming(days) {
  const n = Number.isInteger(days) && days > 0 ? days : 7;
  const { today, now, events } = readAll();
  const to = addDays(today, n);
  return {
    today,
    overdue: events.filter((e) => e.state === 'overdue'),
    upcoming: events.filter((e) => e.status === 'scheduled' && e.day >= today && e.day <= to).sort(byWhen),
    windowDays: n,
    now,
  };
}

module.exports = router;
module.exports.upcoming = upcoming;

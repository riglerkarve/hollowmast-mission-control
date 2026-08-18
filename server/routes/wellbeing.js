const express = require('express');
const db = require('../db');
const provenance = require('../provenance');

// ------------------------------------------------------------------------------------
// WELLBEING. Read the constraints before changing anything here.
//
// From the workspace CLAUDE.md, and they are not style preferences:
//
//   "Never build anything in the wellbeing module that reads as diagnosis, clinical
//    advice, or a risk score. Journal, patterns, signposting. The signposting panel is
//    fixed and always present, regardless of what the data says."
//
//   "Never offload ... anything in the wellbeing module" to the local model.
//
// So: every figure below is a COUNT or a RECALL of something already recorded. Nothing
// is weighted, scored, ranked by severity, trended into a prediction, or interpreted.
// "You have logged 9 of the last 14 days" is a fact. "Your mood is declining" is a
// clinical claim this module is not allowed to make and could not stand behind.
//
// The signposting is served unconditionally by /api/wellbeing/support — it does not
// depend on a query, a threshold, or what the entries say. Nothing can suppress it.
// ------------------------------------------------------------------------------------

db.migrate('wellbeing', [
  (d) => {
    d.exec(`
      CREATE TABLE wellbeing_entries (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        date       TEXT NOT NULL,          -- ISO date the entry is FOR
        mood       INTEGER,                -- 1..5, or NULL: a note without a number is valid
        note       TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
      );

      CREATE INDEX idx_wb_date ON wellbeing_entries(date);
    `);
  },

  // 2 — self-care, moved here from the chore module deliberately.
  //
  // The original todo read "chores, laundry, bins, shower". Shower is the one item on
  // that list that is not housework, and putting it beside the bins would have given it
  // an interval, a due date, an "overdue by 3 days" and a phone notification — a machine
  // telling you to wash. That is the line this module exists to stay behind.
  //
  // So it is a FREE TEXT field on the journal entry, and every property is a decision:
  //
  //   - free text, not a checklist. A preset list of self-care items is a list you can
  //     fail, and on a bad day it reads as an accusation.
  //   - NO interval, NO due date, NO overdue state. Nothing schedules it, so nothing can
  //     ever report it as late.
  //   - excluded from triggers and from the briefing. It is never pushed at you.
  //   - in patterns it is RECALLED by date only — never "3 of 7 days", never a gap or a
  //     streak. A ratio here is a judgement wearing a number.
  (d) => {
    d.exec(`ALTER TABLE wellbeing_entries ADD COLUMN self_care TEXT;`);
  },

  // 3 — quiet hours. Backlog #29, "enforce time away", and the item's own rationale is the
  // specification: "I will build a limit you set in advance and can always override. I will
  // NOT build a lock you cannot open: a wellbeing feature that traps you is the failure
  // mode, not the feature."
  //
  // So every property here is a refusal as much as a feature:
  //
  //   - It gates the UI ONLY. /api/* is never blocked, because the watchdog, the briefing
  //     and the backup run through it and a wellbeing setting must not be able to take the
  //     ops chain down at 23:00.
  //   - The override is one click, always visible, never delayed and never counted. A
  //     dismissal that costs three seconds is a dark pattern; a dismissal that gets tallied
  //     is a compliance score, and this module does not score.
  //   - NOTHING IS RECORDED about it — not overrides, not adherence, not streaks. The
  //     moment a "you ignored quiet hours 4 times this week" figure exists, the feature has
  //     become a judgement about the user, which is the line this whole module sits behind.
  //   - Off by default. A boundary nobody asked for is an imposition.
  (d) => {
    d.exec(`
      CREATE TABLE wellbeing_quiet (
        id       INTEGER PRIMARY KEY CHECK (id = 1),   -- single row, deliberately
        enabled  INTEGER NOT NULL DEFAULT 0,
        from_hm  TEXT NOT NULL DEFAULT '23:00',
        to_hm    TEXT NOT NULL DEFAULT '07:00',
        message  TEXT,
        set_at   TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
      );
      INSERT INTO wellbeing_quiet (id, enabled) VALUES (1, 0);
    `);
  },

  // Provenance. Default 'unknown' rather than 'you' — see server/provenance.js.
  (d) => {
    provenance.addColumn(d, 'wellbeing_entries');
  },
]);

const router = express.Router();

// Deliberately plain words, not clinical ones, and not a scale that implies a threshold
// anyone should act on. They are labels for the user's own recall, nothing more.
const MOOD_LABELS = { 1: 'rough', 2: 'low', 3: 'ok', 4: 'good', 5: 'great' };

const today = () => new Date().toISOString().slice(0, 10);

// ---------------------------------------------------------------------------- support
// Fixed. Always present. Never conditional on the data, never dismissible, never
// reordered by anything this module infers. Verified 17 Aug 2026 against nhs.uk and
// samaritans.org — the source and date are returned with it so it can be re-checked
// rather than trusted indefinitely.
const SUPPORT = {
  checkedOn: '2026-08-17',
  sources: [
    'https://www.nhs.uk/mental-health/feelings-symptoms-behaviours/behaviours/help-for-suicidal-thoughts/',
    'https://www.samaritans.org/how-we-can-help/contact-samaritan/',
  ],
  emergency: 'If life is in danger, call 999 or go to A&E.',
  contacts: [
    { name: 'Samaritans', how: 'Call 116 123', when: '24 hours, every day', cost: 'Free from landlines and mobiles' },
    { name: 'Shout', how: 'Text SHOUT to 85258', when: '24 hours, every day', cost: 'Free' },
    { name: 'NHS 111', how: 'Call 111', when: '24 hours, every day', cost: 'Free' },
    { name: 'CALM', how: 'Call 0800 58 58 58', when: '5pm to midnight, every day', cost: 'Free' },
    { name: 'Papyrus (under 35s)', how: 'Call 0800 068 41 41, or text 07860 039967', when: 'See papyrus-uk.org for hours', cost: 'Free' },
  ],
};

router.get('/support', (req, res) => res.json(SUPPORT));

// ---------------------------------------------------------------------------- capture
// ------------------------------------------------------------------------------ quiet
const HM = /^([01]\d|2[0-3]):[0-5]\d$/;

// Inside the window, handling the overnight case where 'from' is later than 'to'.
function withinQuiet(row, now = new Date()) {
  if (!row || !row.enabled) return false;
  const hm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  // 23:00 -> 07:00 crosses midnight, so the test is an OR rather than an AND. Getting this
  // backwards would make the quiet window the only time the dashboard was available.
  return row.from_hm <= row.to_hm
    ? hm >= row.from_hm && hm < row.to_hm
    : hm >= row.from_hm || hm < row.to_hm;
}

router.get('/quiet', (req, res) => {
  const row = db.prepare('SELECT * FROM wellbeing_quiet WHERE id = 1').get();
  res.json({
    enabled: !!row.enabled,
    from: row.from_hm,
    to: row.to_hm,
    message: row.message,
    active: withinQuiet(row),
    contract: 'A limit you set and can always override in one click. It gates this page only '
      + '— never /api, because the watchdog and the briefing run through there. Nothing about '
      + 'whether you observe it is recorded, now or ever.',
  });
});

router.put('/quiet', (req, res) => {
  const { enabled, from, to, message } = req.body || {};
  if (from !== undefined && !HM.test(String(from))) return res.status(400).json({ error: 'from must be HH:MM' });
  if (to !== undefined && !HM.test(String(to))) return res.status(400).json({ error: 'to must be HH:MM' });

  const cur = db.prepare('SELECT * FROM wellbeing_quiet WHERE id = 1').get();
  db.prepare(
    `UPDATE wellbeing_quiet SET enabled = ?, from_hm = ?, to_hm = ?, message = ?,
            set_at = datetime('now','localtime') WHERE id = 1`
  ).run(
    enabled === undefined ? cur.enabled : (enabled ? 1 : 0),
    from === undefined ? cur.from_hm : String(from),
    to === undefined ? cur.to_hm : String(to),
    // `message === undefined ? ... : String(message)` turned an explicit JSON null into the
    // STRING "null", which is truthy, so the curtain would have rendered the word "null" as
    // its message. Clearing a value and omitting it are different requests and must stay so.
    message === undefined ? cur.message : (message === null ? null : (String(message).trim() || null))
  );
  const row = db.prepare('SELECT * FROM wellbeing_quiet WHERE id = 1').get();
  res.json({ enabled: !!row.enabled, from: row.from_hm, to: row.to_hm, message: row.message, active: withinQuiet(row) });
});

router.post('/entries', (req, res) => {
  const { mood, note, date, selfCare } = req.body || {};
  const d = /^\d{4}-\d{2}-\d{2}$/.test(date || '') ? date : today();

  const m = mood === null || mood === undefined || mood === '' ? null : Number(mood);
  if (m !== null && (!Number.isInteger(m) || m < 1 || m > 5)) {
    return res.status(400).json({ error: 'mood must be an integer 1-5, or omitted' });
  }
  const sc = String(selfCare || '').trim() || null;
  // self_care counts as content: an entry that is only "washed, ate properly" is a valid
  // thing to have recorded, and refusing it would make the field feel like an afterthought.
  if (m === null && !String(note || '').trim() && !sc) {
    return res.status(400).json({ error: 'an entry needs a mood, a note, some self-care, or any combination' });
  }

  const info = db.prepare('INSERT INTO wellbeing_entries (date, mood, note, self_care, by_whom) VALUES (?, ?, ?, ?, ?)')
    .run(d, m, String(note || '').trim() || null, sc, req.by);

  // The capture must return something immediately, or it is a surface you feed. What
  // comes back is RECALL, not assessment: how often you have logged lately, and when you
  // last recorded this same value. Both are facts already in the table.
  const logged14 = db.prepare(
    `SELECT COUNT(DISTINCT date) c FROM wellbeing_entries WHERE date > date('now', 'localtime', '-14 days')`
  ).get().c;

  let lastSame = null;
  if (m !== null) {
    const row = db.prepare(
      `SELECT date FROM wellbeing_entries WHERE mood = ? AND id <> ? ORDER BY date DESC LIMIT 1`
    ).get(m, info.lastInsertRowid);
    if (row) {
      const days = Math.round((new Date(d) - new Date(row.date)) / 86400000);
      lastSame = { date: row.date, daysAgo: days };
    }
  }

  res.status(201).json({
    id: Number(info.lastInsertRowid),
    date: d,
    mood: m,
    moodLabel: m ? MOOD_LABELS[m] : null,
    recall: {
      daysLoggedInLast14: logged14,
      lastTimeYouLoggedThis: lastSame,   // null = first time, or no mood given
    },
  });
});

router.get('/entries', (req, res) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 60));
  const rows = db.prepare(
    'SELECT * FROM wellbeing_entries ORDER BY date DESC, id DESC LIMIT ?'
  ).all(limit);
  res.json({
    total: db.prepare('SELECT COUNT(*) c FROM wellbeing_entries').get().c,
    entries: rows.map((r) => ({ ...r, moodLabel: r.mood ? MOOD_LABELS[r.mood] : null })),
  });
});

router.delete('/entries/:id', (req, res) => {
  const r = db.prepare('DELETE FROM wellbeing_entries WHERE id = ?').run(Number(req.params.id));
  if (!r.changes) return res.status(404).json({ error: 'no such entry' });
  res.json({ deleted: Number(req.params.id) });
});

// ---------------------------------------------------------------------------- patterns
// Counts and recall only. Read the guard rails at the top of this file before adding to
// this endpoint: if a figure here cannot be checked by counting rows by hand, it does not
// belong in this module.
router.get('/patterns', (req, res) => {
  const total = db.prepare('SELECT COUNT(*) c FROM wellbeing_entries').get().c;

  if (!total) {
    // Empty and broken must not read the same. This says WHICH, and still returns the
    // support block so the panel can render it with nothing else on the page.
    return res.json({ state: 'empty', message: 'No entries yet. Nothing here is derived from anything else.', support: SUPPORT });
  }

  const span = db.prepare('SELECT MIN(date) a, MAX(date) b FROM wellbeing_entries').get();

  const byMood = db.prepare(
    'SELECT mood, COUNT(*) c FROM wellbeing_entries WHERE mood IS NOT NULL GROUP BY mood ORDER BY mood'
  ).all().map((r) => ({ mood: r.mood, label: MOOD_LABELS[r.mood], count: r.c }));

  // Day of week, from SQLite's strftime. Descriptive: which days you tend to write on.
  const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const byWeekday = db.prepare(
    `SELECT CAST(strftime('%w', date) AS INTEGER) w, COUNT(DISTINCT date) c
       FROM wellbeing_entries GROUP BY w ORDER BY w`
  ).all().map((r) => ({ day: DOW[r.w], daysLogged: r.c }));

  const logged14 = db.prepare(
    `SELECT COUNT(DISTINCT date) c FROM wellbeing_entries WHERE date > date('now', 'localtime', '-14 days')`
  ).get().c;
  const logged7 = db.prepare(
    `SELECT COUNT(DISTINCT date) c FROM wellbeing_entries WHERE date > date('now', 'localtime', '-7 days')`
  ).get().c;

  const lastEntry = db.prepare('SELECT date FROM wellbeing_entries ORDER BY date DESC LIMIT 1').get();
  const gapDays = Math.round((new Date(today()) - new Date(lastEntry.date)) / 86400000);

  const withNotes = db.prepare("SELECT COUNT(*) c FROM wellbeing_entries WHERE note IS NOT NULL AND note <> ''").get().c;

  res.json({
    state: 'ok',
    total,
    firstEntry: span.a,
    lastEntry: span.b,
    daysSinceLastEntry: gapDays,
    daysLoggedInLast7: logged7,
    daysLoggedInLast14: logged14,
    entriesWithNotes: withNotes,
    byMood,
    byWeekday,
    // Said plainly so the panel never has to imply more than it knows.
    note: 'Counts only. Nothing here is scored, weighted, predicted or interpreted.',
    support: SUPPORT,
  });
});

// Asked for by the briefing. A COUNT of days written, and nothing else — no mood value,
// no average, no direction. Whether you wrote is a fact about the week; what you wrote
// is not the briefing's business and this module will not hand it over.
function daysWrittenSince(sinceDate) {
  return db.prepare('SELECT COUNT(DISTINCT date) c FROM wellbeing_entries WHERE date >= ?').get(sinceDate).c;
}

module.exports = router;
module.exports.SUPPORT = SUPPORT;
module.exports.daysWrittenSince = daysWrittenSince;

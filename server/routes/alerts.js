const express = require('express');
const db = require('../db');

// ------------------------------------------------------------------------------------
// ALERTS. The workspace rule reads:
//
//   "Notifications have a high bar. An alert you learn to dismiss is worse than no alert,
//    because it teaches you to ignore the channel. Anything dismissed twice gets deleted,
//    not tuned."
//
// That rule was unenforceable, because nothing recorded what had been sent. Two notifiers
// existed — the watchdog and the briefing — and neither left a trace, so "dismissed twice"
// could never be counted and the rule was a good intention.
//
// This module is the ledger that makes it real. Every alert is recorded before it is sent.
// You mark a KIND as useful or ignored. Two ignores and the kind is muted automatically,
// by the rule, without anyone having to remember it.
//
// Muting is reversible and never silent: a muted kind still records that it WOULD have
// fired, so "nothing happened" and "something happened and you had chosen not to hear it"
// stay different facts.
// ------------------------------------------------------------------------------------

db.migrate('alerts', [
  (d) => {
    d.exec(`
      CREATE TABLE alert_kinds (
        kind        TEXT PRIMARY KEY,     -- 'uptime' | 'briefing' | ...
        label       TEXT NOT NULL,
        muted       INTEGER NOT NULL DEFAULT 0,
        muted_at    TEXT,
        muted_reason TEXT
      );

      CREATE TABLE alert_events (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        kind       TEXT NOT NULL,
        title      TEXT NOT NULL,
        body       TEXT,
        sent       INTEGER NOT NULL,      -- 0 = suppressed because the kind is muted
        sent_at    TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        -- NULL = you have not said. 'useful' or 'ignored' once you have.
        verdict    TEXT,
        verdict_at TEXT
      );

      CREATE INDEX idx_alert_kind ON alert_events(kind, sent_at);

      INSERT INTO alert_kinds (kind, label) VALUES
        ('uptime',   'Mission Control went down'),
        ('briefing', 'The morning briefing is ready');
    `);
  },
]);

const IGNORES_TO_MUTE = 2;   // the rule, in one place

const router = express.Router();

// Called by notify.cjs BEFORE the toast fires. Returns whether it should be sent.
function record(kind, title, body) {
  const k = db.prepare('SELECT * FROM alert_kinds WHERE kind = ?').get(kind);
  if (!k) {
    db.prepare('INSERT INTO alert_kinds (kind, label) VALUES (?, ?)').run(kind, kind);
  }
  const muted = k ? !!k.muted : false;

  // Recorded whether or not it is sent. A muted alert that is never written down turns
  // "nothing was wrong" and "something was wrong and you had muted it" into one silence.
  const info = db.prepare(
    'INSERT INTO alert_events (kind, title, body, sent) VALUES (?, ?, ?, ?)'
  ).run(kind, title, body || null, muted ? 0 : 1);

  return { send: !muted, id: Number(info.lastInsertRowid), muted };
}

router.get('/', (req, res) => {
  const kinds = db.prepare('SELECT * FROM alert_kinds ORDER BY kind').all();
  const total = db.prepare('SELECT COUNT(*) c FROM alert_events').get().c;

  if (!total) {
    return res.json({
      state: 'none-sent',
      message: 'No alert has been sent yet. That is an empty ledger, not a broken one.',
      kinds: kinds.map((k) => ({ ...k, sent: 0, ignored: 0, useful: 0, unjudged: 0 })),
      rule: `A kind marked ignored ${IGNORES_TO_MUTE} times mutes itself.`,
    });
  }

  const stats = db.prepare(
    `SELECT kind,
            COUNT(*) total,
            SUM(sent) sent,
            SUM(CASE WHEN sent = 0 THEN 1 ELSE 0 END) suppressed,
            SUM(CASE WHEN verdict = 'ignored' THEN 1 ELSE 0 END) ignored,
            SUM(CASE WHEN verdict = 'useful' THEN 1 ELSE 0 END) useful,
            SUM(CASE WHEN verdict IS NULL THEN 1 ELSE 0 END) unjudged,
            MAX(sent_at) last
       FROM alert_events GROUP BY kind`
  ).all();
  const byKind = new Map(stats.map((s) => [s.kind, s]));

  res.json({
    state: 'ok',
    total,
    rule: `A kind marked ignored ${IGNORES_TO_MUTE} times mutes itself. Muting is reversible and a muted alert is still recorded.`,
    kinds: kinds.map((k) => {
      const s = byKind.get(k.kind) || { total: 0, sent: 0, suppressed: 0, ignored: 0, useful: 0, unjudged: 0, last: null };
      return {
        kind: k.kind,
        label: k.label,
        muted: !!k.muted,
        mutedAt: k.muted_at,
        mutedReason: k.muted_reason,
        ...s,
        // The derived judgement, stated as a count rather than a score.
        standing: k.muted ? 'muted'
          : s.ignored >= IGNORES_TO_MUTE ? 'should be muted'
          : s.useful > 0 ? 'earning its place'
          : s.unjudged === s.total && s.total > 0 ? 'never judged'
          : 'on probation',
        ignoresToMute: Math.max(0, IGNORES_TO_MUTE - s.ignored),
      };
    }),
  });
});

router.get('/events', (req, res) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  const rows = db.prepare(
    'SELECT * FROM alert_events ORDER BY sent_at DESC, id DESC LIMIT ?'
  ).all(limit);
  res.json({ total: db.prepare('SELECT COUNT(*) c FROM alert_events').get().c, events: rows });
});

// Judging an alert is the whole point. It is also what enforces the rule.
router.post('/events/:id/verdict', (req, res) => {
  const { verdict } = req.body || {};
  if (!['useful', 'ignored', null].includes(verdict)) {
    return res.status(400).json({ error: "verdict must be 'useful', 'ignored' or null" });
  }

  const ev = db.prepare('SELECT * FROM alert_events WHERE id = ?').get(Number(req.params.id));
  if (!ev) return res.status(404).json({ error: 'no such alert' });

  db.prepare(
    `UPDATE alert_events SET verdict = ?, verdict_at = CASE WHEN ? IS NULL THEN NULL ELSE datetime('now','localtime') END WHERE id = ?`
  ).run(verdict, verdict, ev.id);

  // Apply the rule immediately rather than at some later sweep, so the count on screen
  // and the behaviour of the notifier can never disagree.
  const ignored = db.prepare(
    "SELECT COUNT(*) c FROM alert_events WHERE kind = ? AND verdict = 'ignored'"
  ).get(ev.kind).c;

  let muted = false;
  if (ignored >= IGNORES_TO_MUTE) {
    db.prepare(
      `UPDATE alert_kinds SET muted = 1, muted_at = datetime('now','localtime'),
        muted_reason = ? WHERE kind = ? AND muted = 0`
    ).run(`marked ignored ${ignored} times`, ev.kind);
    muted = true;
  }

  res.json({
    id: ev.id,
    kind: ev.kind,
    verdict,
    ignoredCount: ignored,
    kindNowMuted: muted,
    note: muted
      ? `"${ev.kind}" is muted — you ignored it ${ignored} times, which is the rule, not a suggestion. It will still be recorded so you can see what you are not being told.`
      : undefined,
  });
});

// Unmuting is deliberate and clears the count, because otherwise a kind you chose to keep
// would re-mute itself on the next ignore and feel broken.
router.post('/kinds/:kind/unmute', (req, res) => {
  const k = db.prepare('SELECT * FROM alert_kinds WHERE kind = ?').get(req.params.kind);
  if (!k) return res.status(404).json({ error: 'no such alert kind' });

  try {
    db.withTransaction(() => {
      db.prepare('UPDATE alert_kinds SET muted = 0, muted_at = NULL, muted_reason = NULL WHERE kind = ?').run(k.kind);
      db.prepare("UPDATE alert_events SET verdict = NULL, verdict_at = NULL WHERE kind = ? AND verdict = 'ignored'").run(k.kind);
    });
  } catch (err) { return res.status(500).json({ error: err.message }); }

  res.json({ kind: k.kind, muted: false, note: 'Unmuted, and previous ignores cleared so it starts fresh.' });
});

// Alerts raised in the window, for the briefing.
//
// It reports what was RAISED, not what is "active", because this module has no concept of an
// alert being resolved — it has a ledger of sends and a judgement on each kind. Inventing an
// open/closed state here would be a second, disagreeing definition of the same thing.
//
// `unjudged` matters more than the count: the module's own rule is that a kind ignored enough
// times mutes itself, so an alert nobody has judged is one still costing attention without yet
// earning its place.
function raisedSince(sinceISO) {
  const since = String(sinceISO || '').slice(0, 10);
  if (!since) return { state: 'no-window' };

  const total = db.prepare('SELECT COUNT(*) c FROM alert_events').get().c;
  if (!total) return { state: 'none-sent', why: 'no alert has ever been sent — an empty ledger, not a broken one' };

  const rows = db.prepare(
    `SELECT kind, COUNT(*) AS n, SUM(CASE WHEN verdict IS NULL OR verdict = '' THEN 1 ELSE 0 END) AS unjudged
     FROM alert_events WHERE sent_at >= ? GROUP BY kind ORDER BY n DESC`
  ).all(since);

  return {
    state: 'ok',
    since,
    kinds: rows,
    raised: rows.reduce((a, r) => a + r.n, 0),
    unjudged: rows.reduce((a, r) => a + Number(r.unjudged || 0), 0),
  };
}

module.exports = router;
module.exports.raisedSince = raisedSince;
module.exports.record = record;
module.exports.IGNORES_TO_MUTE = IGNORES_TO_MUTE;

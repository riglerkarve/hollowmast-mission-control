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

  // M337 / owner decision #47 — A PROPOSED VERDICT IS NOT A VERDICT, AND LIVES IN ITS OWN
  // COLUMNS FOR A REASON THAT IS NOT TIDINESS.
  //
  // The mute rule counts `verdict = 'ignored'`. If a proposal were written into that same
  // column, this module could silence one of its own kinds on its own guess, without the
  // owner ever seeing the alert that did it — an alerts ledger muting itself is the exact
  // failure the workspace rule about notifications exists to prevent, one level up. Separate
  // columns make that structurally impossible rather than merely unintended.
  //
  // WHY THIS EXISTS AT ALL: 31 events, 31 unjudged, zero verdicts ever recorded. The owner
  // first decided to cut the module (#44) and then reversed it (#47) on new evidence: the
  // debate established that every instrument requiring a RECURRING act from him is dead
  // here — journal 1 row, cash_counts 0, lifestyle_intake 0, steering asked and re-asked —
  // while every instrument a session operates and he merely ADJUDICATES is alive. 31/0 was
  // predictable from the shape, not a verdict on the module. So the shape changes: a session
  // proposes from observable state, he accepts or rejects.
  (d) => {
    const cols = d.prepare("SELECT name FROM pragma_table_info('alert_events')").all().map(r => r.name);
    if (!cols.includes('proposed_verdict')) d.exec('ALTER TABLE alert_events ADD COLUMN proposed_verdict TEXT');
    if (!cols.includes('proposed_because')) d.exec('ALTER TABLE alert_events ADD COLUMN proposed_because TEXT');
    if (!cols.includes('proposed_at')) d.exec('ALTER TABLE alert_events ADD COLUMN proposed_at TEXT');
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
// ------------------------------------------------------------------------------------
// THE PROPOSER. M337 / decision #47.
//
// A session derives a verdict from OBSERVABLE STATE and offers it; the owner accepts or
// rejects. Nothing here writes `verdict`, and nothing here can mute a kind — see the
// migration note. A proposal is an argument, and it always ships with the evidence that
// produced it, because a verdict he cannot check is one he has to take on trust and the
// whole point is that he is the one who knows.
//
// THREE OF FIVE KINDS ARE NOT DERIVABLE, AND SAY SO RATHER THAN GUESSING. That is not a
// gap in the implementation, it is the honest answer, and it is worth him seeing:
//
//   unregistered-session  DERIVABLE. The alert names a session and asks for it to be added
//                         to the roster. Either it is on the roster now or it is not.
//   chores_due            DERIVABLE. A chore completed after the alert was sent is the
//                         action the alert was asking for.
//   briefing              NOT DERIVABLE. "The briefing is ready" — nothing records whether
//                         he read it. team_handovers.read_at exists and is 'unknown' on 99
//                         of 99 rows, so it cannot tell his hand from a session's.
//   uptime                NOT DERIVABLE. The watchdog restores the service, not him. The
//                         alert may be useful and his behaviour cannot show it either way.
//   schedule_overdue      NOT DERIVABLE YET. schedule_events has a `status`, but nothing
//                         links an alert to the event that triggered it, so which row to
//                         look at is a guess. Filed rather than approximated.
const PROPOSERS = {
  'unregistered-session': (ev) => {
    const m = String(ev.title || '').match(/"([^"]+)"/);
    if (!m) return { verdict: null, because: 'could not read a session name out of the title' };
    const name = m[1];
    const row = db.prepare('SELECT retired_at FROM team_sessions WHERE title = ?').get(name);
    if (row) {
      return { verdict: 'useful', because: `"${name}" is on the roster now`
        + (row.retired_at ? ' (retired, but registered)' : '') + ' — the alert asked for that and it happened.' };
    }
    return { verdict: 'ignored', because: `"${name}" is still not on the roster. The alert asked for `
      + 'an action that was never taken, which is what ignored means here — not that it was wrong.' };
  },
  chores_due: (ev) => {
    const after = db.prepare('SELECT COUNT(*) c FROM lifestyle_done WHERE recorded_at > ?')
      .get(ev.sent_at || '').c;
    if (after > 0) return { verdict: 'useful', because: `${after} chore(s) were recorded done after this fired.` };
    return { verdict: 'ignored', because: 'no chore was recorded done at any point after this fired.' };
  },
};

// Kinds with no proposer, and WHY — carried to the panel so "nothing proposed" and
// "nothing could be proposed" never look the same.
const NOT_DERIVABLE = {
  briefing: 'nothing records whether he read it; handover read_at is "unknown" on 99 of 99 rows',
  uptime: 'the watchdog restores the service, not him — his behaviour cannot show usefulness either way',
  schedule_overdue: 'no link from an alert to the schedule row that triggered it, so which row to check is a guess',
};

// EXPORTED so the daily briefing pass can run it. A proposer nothing triggers is the
// dormant-mechanism shape this project rules worse than an absent one -- and it would have
// shipped that way: an endpoint exists, nothing calls it, proposals only ever appear if
// somebody remembers to POST. That is the same "no scheduled writer" cause M341's census
// was built to make visible, and it would have been invisible here for the same reason.
function proposeAll() {
  // Only unjudged events, and only ones without a proposal already. Re-running must not
  // overwrite a proposal he has already seen and is about to act on.
  const rows = db.prepare(
    'SELECT * FROM alert_events WHERE verdict IS NULL AND proposed_verdict IS NULL'
  ).all();

  const now = new Date().toISOString();
  const upd = db.prepare('UPDATE alert_events SET proposed_verdict=?, proposed_because=?, proposed_at=? WHERE id=?');
  const made = [], skipped = [];

  db.withTransaction(() => {
    for (const ev of rows) {
      const fn = PROPOSERS[ev.kind];
      if (!fn) { skipped.push({ id: ev.id, kind: ev.kind, why: NOT_DERIVABLE[ev.kind] || 'no proposer for this kind' }); continue; }
      let p;
      try { p = fn(ev); } catch (e) { skipped.push({ id: ev.id, kind: ev.kind, why: 'proposer threw: ' + e.message }); continue; }
      if (!p || !p.verdict) { skipped.push({ id: ev.id, kind: ev.kind, why: (p && p.because) || 'proposer declined' }); continue; }
      upd.run(p.verdict, p.because, now, ev.id);
      made.push({ id: ev.id, kind: ev.kind, verdict: p.verdict, because: p.because });
    }
  });

  return {
    considered: rows.length, proposed: made.length, made, skipped,
    note: 'A proposal is not a verdict. Nothing here writes alert_events.verdict and nothing '
        + 'here can mute a kind — the mute rule counts his verdicts only.',
  };
}

router.post('/propose', express.json(), (_req, res) => res.json(proposeAll()));

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
module.exports.proposeAll = proposeAll;

// Mail — Gmail METADATA only. Backlog #M37, split from #9. Owns gmail_messages.
//
// SUBJECTS ARE STORED. Owner decision, 18 Aug 2026, asked directly and answered against my
// recommendation: they are useful for search and for making mail reachable from the second
// brain. That is settled and is not re-litigated here.
//
// WHAT THAT COSTS, recorded once because it changes what this file must do rather than to
// argue it again: dashboard.db binds 0.0.0.0 behind one shared secret over plain HTTP and
// already holds ten account-years of bank transactions. Subject lines routinely carry what
// bodies would — order totals, appointment types, account references, names. So:
//
//   * SUBJECT TEXT IS LOOPBACK-ONLY. /messages returns subjects to 127.0.0.1 and NEVER over
//     the network, the same distinction finance already draws about what may cross the LAN.
//     A phone on the LAN gets senders, dates, labels and counts. Search runs on this machine.
//   * gmail_ is added to SENSITIVE_PREFIXES so the access log watches these tables the way it
//     watches finance_ — from the moment they exist, not later.
//
// The scope is gmail.metadata: headers and labels, never bodies, never snippets. The API
// cannot return a body with this token even if this code asked for one.
'use strict';

const express = require('express');
const db = require('../db');
const ga = require('../../tools/google-auth.cjs');

db.migrate('mail', [
  (d) => {
    d.exec(`
      CREATE TABLE gmail_messages (
        account       TEXT NOT NULL,          -- WHICH mailbox. There are two, and a row
                                              -- without this is unattributable.
        id            TEXT NOT NULL,          -- Gmail message id, unique per account
        thread_id     TEXT,
        internal_date INTEGER NOT NULL,       -- epoch ms, Gmail's own clock
        day           TEXT NOT NULL,          -- YYYY-MM-DD, derived once so SQL can group
        from_addr     TEXT,
        from_name     TEXT,
        to_addr       TEXT,
        subject       TEXT,                   -- loopback-only on the way out; see header
        labels        TEXT,                   -- comma-separated label ids
        size_estimate INTEGER,
        imported_at   TEXT NOT NULL DEFAULT (datetime('now','localtime')),
        PRIMARY KEY (account, id)
      );
      CREATE INDEX idx_gmail_day     ON gmail_messages(day);
      CREATE INDEX idx_gmail_from    ON gmail_messages(from_addr);
      CREATE INDEX idx_gmail_account ON gmail_messages(account);

      -- One row per account: how far the importer has got. Without this every run re-reads
      -- 65,000 messages, and the second run costs the same as the first.
      CREATE TABLE gmail_sync (
        account        TEXT PRIMARY KEY,
        newest_seen_ms INTEGER,               -- high-water mark; next run stops here
        oldest_seen_ms INTEGER,               -- how far back the backfill has reached
        total_estimate INTEGER,               -- Gmail's own estimate of the mailbox size
        messages_held  INTEGER NOT NULL DEFAULT 0,
        last_run_at    TEXT,
        last_error     TEXT
      );
    `);
  },

  // 2. Sender classification. Rules first, the local model only for what rules cannot reach,
  //    and NOTHING it says is treated as settled.
  //
  //    MEASURED BEFORE BUILDING (tools/llm-probe-mail.cjs, 48,021 messages / 1,132 senders):
  //    pattern rules classify 50.4% of senders and 73.1% of message VOLUME. qwen3.5:9b scored
  //    10/10 on unambiguous senders and 2/5 on judgement calls. So the model is good enough to
  //    SUGGEST and nowhere near good enough to decide — which is exactly what class_source
  //    encodes, the same way finance_transactions.category_source already does.
  (d) => {
    d.exec(`
      CREATE TABLE gmail_senders (
        addr         TEXT PRIMARY KEY,        -- the sender, not per-account: an address is
                                              -- the same kind of thing in either mailbox
        class        TEXT,                    -- NULL means not classified, never 'other'
        class_source TEXT,                    -- 'rule' | 'model' | 'manual'
        classified_at TEXT
      );
      CREATE INDEX idx_gmail_senders_class ON gmail_senders(class);

      -- Deterministic and auditable, the same shape as finance_rules. Merchant knowledge in a
      -- table beats merchant knowledge in a prompt: it is exact, inspectable, and it cannot
      -- destabilise the rows it does not match. That is the recorded finding from the
      -- transaction work, where naming the business in the prompt broke four correct answers.
      CREATE TABLE gmail_sender_rules (
        id      INTEGER PRIMARY KEY AUTOINCREMENT,
        pattern TEXT NOT NULL,                -- matched against the address, case-insensitive
        kind    TEXT NOT NULL DEFAULT 'regex',-- 'regex' | 'exact' | 'domain'
        class   TEXT NOT NULL,
        note    TEXT,
        UNIQUE (pattern, kind)
      );
    `);
  },
]);

const router = express.Router();

// Loopback covers IPv4, IPv6 and the mapped form. Anything else is "the network" and does
// not see subject text. Deliberately a whitelist: an unrecognised address is treated as
// remote, so a proxy or a new interface fails CLOSED.
function isLoopback(req) {
  const ip = (req.ip || req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  return ip === '127.0.0.1' || ip === '::1' || ip === 'localhost';
}

function counts() {
  const rows = db.prepare(
    `SELECT account, COUNT(*) AS n, MIN(day) AS first_day, MAX(day) AS last_day
       FROM gmail_messages GROUP BY account`
  ).all();
  const sync = db.prepare('SELECT * FROM gmail_sync').all();
  const byAccount = new Map(sync.map((s) => [s.account, s]));
  return rows.map((r) => {
    const s = byAccount.get(r.account) || {};
    return {
      account: r.account,
      held: r.n,
      firstDay: r.first_day,
      lastDay: r.last_day,
      mailboxEstimate: s.total_estimate || null,
      // A COVERAGE FIGURE, not a completeness claim. An importer that says "done" while
      // holding 3% of a mailbox is the flattering-filter failure this project keeps hitting.
      coverage: s.total_estimate ? +(100 * r.n / s.total_estimate).toFixed(1) : null,
      lastRunAt: s.last_run_at || null,
      lastError: s.last_error || null,
    };
  });
}

router.get('/', (req, res) => {
  const known = ga.accounts();
  const held = counts();
  const seen = new Set(held.map((h) => h.account));
  res.json({
    accounts: held,
    // Authorised but never imported is a THIRD state, distinct from "imported nothing".
    authorisedNotYetImported: known.filter((a) => !seen.has(a)),
    subjectsVisibleHere: isLoopback(req),
    note: isLoopback(req)
      ? 'On this machine, so subject text is available from /messages.'
      : 'Over the network, so subject text is withheld. Senders, dates, labels and counts only.',
  });
});

router.get('/messages', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 500);
  const account = req.query.account;
  const q = String(req.query.q || '').trim();

  if (q && !isLoopback(req)) {
    // Refused rather than silently searching senders only: a search that quietly stops
    // matching subjects returns fewer results and looks like an empty mailbox.
    return res.status(403).json({
      error: 'subject search is available on this machine only',
      why: 'Subjects are stored but never served over the network. This request came from '
        + `${(req.ip || '').replace(/^::ffff:/, '')}, which is not loopback.`,
    });
  }

  const where = [];
  const args = [];
  if (account) { where.push('account = ?'); args.push(account); }
  if (q) { where.push('(subject LIKE ? OR from_addr LIKE ? OR from_name LIKE ?)'); args.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  args.push(limit);

  const rows = db.prepare(
    `SELECT account, id, thread_id, day, from_addr, from_name, subject, labels
       FROM gmail_messages
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY internal_date DESC LIMIT ?`
  ).all(...args);

  const local = isLoopback(req);
  res.json({
    subjectsIncluded: local,
    messages: rows.map((r) => (local ? r : { ...r, subject: undefined })),
  });
});

// Sender classification, and WHERE EACH ANSWER CAME FROM. class_source is carried on every
// row rather than summarised away, because 'rule', 'model' and 'manual' are three different
// degrees of trust and collapsing them into a class name would hide which.
//
// Measured before any of this shipped: rules reach 81.2% of message volume; qwen3.5:9b scored
// 10/10 on unambiguous senders and 2/5 on judgement calls. So a 'model' row is a SUGGESTION.
// NULL means not classified and is never rendered as 'other' — a fabricated category is
// indistinguishable from a real one, which is the whole reason 'other' is a real class here
// and absence is not.
router.get('/senders/classes', (req, res) => {
  const rows = db.prepare(
    `SELECT s.class, s.class_source, COUNT(DISTINCT s.addr) AS senders,
            COALESCE(SUM(v.n), 0) AS messages
       FROM gmail_senders s
       LEFT JOIN (SELECT from_addr, COUNT(*) AS n FROM gmail_messages GROUP BY from_addr) v
              ON v.from_addr = s.addr
      GROUP BY s.class, s.class_source ORDER BY messages DESC`
  ).all();

  const unclassified = db.prepare(
    `SELECT COUNT(DISTINCT m.from_addr) AS senders, COUNT(*) AS messages
       FROM gmail_messages m
       LEFT JOIN gmail_senders s ON s.addr = m.from_addr
      WHERE m.from_addr IS NOT NULL AND (s.class IS NULL)`
  ).get();

  res.json({
    rows,
    // Reported as its own row, never folded into a class. "Nothing has looked at these" and
    // "these were looked at and are miscellaneous" are different facts.
    unclassified,
    trust: {
      rule: 'deterministic and auditable — the pattern is in gmail_sender_rules',
      model: 'SUGGESTED by qwen3.5:9b. 10/10 on unambiguous senders, 2/5 on judgement calls '
        + 'when measured. Review before relying on one.',
      manual: 'yours. Never overwritten by a rule or the model.',
    },
  });
});

// Correct one. A human answer outranks both a rule and the model, permanently.
router.post('/senders/:addr/class', express.json(), (req, res) => {
  const { class: cls } = req.body || {};
  const allowed = ['marketing', 'transactional', 'social', 'survey', 'adult', 'jobs', 'finance', 'personal', 'other'];
  if (!allowed.includes(cls)) return res.status(400).json({ error: `class must be one of ${allowed.join(', ')}` });
  if (!db.prepare('SELECT 1 FROM gmail_messages WHERE from_addr = ? LIMIT 1').get(req.params.addr)) {
    return res.status(404).json({ error: 'no mail from that sender' });
  }
  db.prepare(
    `INSERT INTO gmail_senders (addr, class, class_source, classified_at)
     VALUES (?,?, 'manual', datetime('now','localtime'))
     ON CONFLICT(addr) DO UPDATE SET class = excluded.class, class_source = 'manual',
       classified_at = excluded.classified_at`
  ).run(req.params.addr, cls);
  res.json({ addr: req.params.addr, class: cls, class_source: 'manual' });
});

// Who fills the inbox. Derived rather than stored, and it needs no subject text at all —
// which is why this one IS safe over the network.
router.get('/senders', (req, res) => {
  const months = Math.min(Number(req.query.months) || 12, 120);
  const since = new Date(Date.now() - months * 30 * 86400000).toISOString().slice(0, 10);
  res.json(db.prepare(
    `SELECT from_addr, from_name, account, COUNT(*) AS n,
            SUM(CASE WHEN labels LIKE '%UNREAD%' THEN 1 ELSE 0 END) AS unread,
            MIN(day) AS first_day, MAX(day) AS last_day
       FROM gmail_messages WHERE day >= ?
      GROUP BY from_addr, account ORDER BY n DESC LIMIT 40`
  ).all(since));
});


// M40: where the mail comes from, and how old the unread is. Two counts and nothing else.
//
// DELIBERATELY ABSENT: any score, streak, target, or colour that means bad. There is no
// inbox-zero figure and no suggestion to unsubscribe. This reports what is there; what to
// do about it is not the dashboard's opinion to have.
router.get('/attention', (req, res) => {
  const total = db.prepare('SELECT COUNT(*) AS n FROM gmail_messages').get().n;
  if (!total) return res.json({ state: 'empty', message: 'No mail imported yet.' });

  const senders = db.prepare(
    `SELECT from_addr AS addr, COUNT(*) AS n FROM gmail_messages
     GROUP BY from_addr ORDER BY n DESC LIMIT 12`
  ).all().map((r) => ({ ...r, pct: +(100 * r.n / total).toFixed(1) }));

  const distinct = db.prepare('SELECT COUNT(DISTINCT from_addr) AS n FROM gmail_messages').get().n;
  const top12 = senders.reduce((a, r) => a + r.n, 0);

  const unread = db.prepare('SELECT COUNT(*) AS n FROM gmail_messages WHERE labels LIKE ?').get('%UNREAD%').n;
  const bands = db.prepare(
    `SELECT CASE
       WHEN julianday('now') - julianday(day) <  7  THEN 'under a week'
       WHEN julianday('now') - julianday(day) <  30 THEN 'under a month'
       WHEN julianday('now') - julianday(day) < 365 THEN 'under a year'
       ELSE 'over a year' END AS band, COUNT(*) AS n
     FROM gmail_messages WHERE labels LIKE ? GROUP BY band`
  ).all('%UNREAD%');
  const order = ['under a week', 'under a month', 'under a year', 'over a year'];
  const ageing = order.map((b) => ({ band: b, n: (bands.find((x) => x.band === b) || {}).n || 0 }));

  const sync = db.prepare('SELECT account, messages_held, total_estimate FROM gmail_sync').all();
  const held = sync.reduce((a, r) => a + (r.messages_held || 0), 0);
  const est = sync.reduce((a, r) => a + (r.total_estimate || 0), 0);

  res.json({
    state: 'ok', total, distinctSenders: distinct, senders,
    top12Share: +(100 * top12 / total).toFixed(1),
    unread, unreadPct: +(100 * unread / total).toFixed(1), ageing,
    // Coverage travels WITH the figures. Sender concentration over a partial mailbox is a
    // claim about the last few days wearing the clothes of a claim about your mail.
    coverage: est ? +(100 * held / est).toFixed(1) : null,
    // The caveat is part of the payload, not the panel's decoration, so anything else that
    // reads this endpoint carries it too.
    unreadCaveat: `Unread is a LABEL, not a measure of attention -- ${(100 * unread / total).toFixed(0)}%`
      + ' of this mailbox is unread, which means the flag is not being used to track anything.'
      + ' Treat the bands as where mail accumulates, not as a backlog you owe.',
  });
});

module.exports = router;
module.exports.counts = counts;

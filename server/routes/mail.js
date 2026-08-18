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

module.exports = router;
module.exports.counts = counts;

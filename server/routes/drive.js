// Drive — file METADATA only. Backlog #9, the other half of the Google integration.
// Owns drive_files. Reads nothing else.
//
// SCOPE IS drive.metadata.readonly: names, types, sizes, dates, owners, sharing. NEVER file
// CONTENTS. The token cannot fetch a body even if this code asked for one.
//
// FILE NAMES GET THE SAME TREATMENT AS MAIL SUBJECTS, and for the same reason. "Divorce
// papers", "Statement Jan", "Tenancy agreement" — a filename is often the whole story, and
// dashboard.db binds 0.0.0.0 behind one shared secret over plain HTTP. So names are STORED
// (consistent with the owner's 18 Aug decision on subjects) and are LOOPBACK-ONLY on the way
// out. A phone on the LAN gets counts, types, sizes, dates and sharing — not names.
//
// UNLIKE GMAIL, THIS CAN ACTUALLY FINISH. 42 files and 1 file across the two accounts, so a
// run lists everything and coverage is genuinely complete rather than a bounded slice. That
// difference is stated in the data rather than assumed by a reader: `listedEverything` is a
// real field, because Drive's API offers no file-count total to compute a percentage from.
'use strict';

const express = require('express');
const db = require('../db');

db.migrate('drive', [
  (d) => {
    d.exec(`
      CREATE TABLE drive_files (
        account       TEXT NOT NULL,
        id            TEXT NOT NULL,
        name          TEXT,                  -- loopback-only on the way out; see header
        mime_type     TEXT,
        size_bytes    INTEGER,               -- absent for Google-native docs; NULL, not 0
        created_time  TEXT,
        modified_time TEXT,
        owner_email   TEXT,
        parents       TEXT,
        trashed       INTEGER NOT NULL DEFAULT 0,
        shared        INTEGER NOT NULL DEFAULT 0,
        web_link      TEXT,
        imported_at   TEXT NOT NULL DEFAULT (datetime('now','localtime')),
        PRIMARY KEY (account, id)
      );
      CREATE INDEX idx_drive_account  ON drive_files(account);
      CREATE INDEX idx_drive_modified ON drive_files(modified_time);
      CREATE INDEX idx_drive_mime     ON drive_files(mime_type);

      CREATE TABLE drive_sync (
        account          TEXT PRIMARY KEY,
        files_held       INTEGER NOT NULL DEFAULT 0,
        listed_everything INTEGER NOT NULL DEFAULT 0,
        quota_used_bytes INTEGER,
        last_run_at      TEXT,
        last_error       TEXT
      );
    `);
  },
]);

const router = express.Router();

function isLoopback(req) {
  const ip = (req.ip || req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  return ip === '127.0.0.1' || ip === '::1' || ip === 'localhost';
}

const FOLDER = 'application/vnd.google-apps.folder';

// What is actually in there — the derivation, not the storage. A module that only holds what
// it fetched fails the contract; these are the questions a file list cannot answer by being
// looked at.
function summary() {
  const rows = db.prepare('SELECT * FROM drive_sync').all();
  const byAccount = db.prepare(
    `SELECT account, COUNT(*) AS n,
            SUM(CASE WHEN trashed = 1 THEN 1 ELSE 0 END) AS trashed,
            SUM(CASE WHEN shared = 1 THEN 1 ELSE 0 END) AS shared,
            SUM(COALESCE(size_bytes,0)) AS bytes,
            MIN(modified_time) AS oldest, MAX(modified_time) AS newest
       FROM drive_files WHERE mime_type <> ? GROUP BY account`
  ).all(FOLDER);
  const sync = new Map(rows.map((r) => [r.account, r]));

  return byAccount.map((a) => {
    const s = sync.get(a.account) || {};
    return {
      account: a.account,
      files: a.n,
      folders: db.prepare('SELECT COUNT(*) AS n FROM drive_files WHERE account = ? AND mime_type = ?').get(a.account, FOLDER).n,
      trashed: a.trashed,
      // SHARED IS THE ONE WORTH LOOKING AT. A file shared years ago stays shared, and nothing
      // reminds you. It is reported as a plain count with no judgement attached.
      shared: a.shared,
      storedBytes: a.bytes,
      oldestModified: a.oldest,
      newestModified: a.newest,
      listedEverything: !!s.listed_everything,
      lastRunAt: s.last_run_at || null,
      lastError: s.last_error || null,
    };
  });
}

router.get('/', (req, res) => {
  const local = isLoopback(req);
  res.json({
    accounts: summary(),
    byType: db.prepare(
      `SELECT mime_type, COUNT(*) AS n, SUM(COALESCE(size_bytes,0)) AS bytes
         FROM drive_files GROUP BY mime_type ORDER BY n DESC`
    ).all(),
    namesVisibleHere: local,
    note: local
      ? 'On this machine, so file names are available from /files.'
      : 'Over the network, so file names are withheld. Counts, types, sizes, dates and sharing only.',
  });
});

router.get('/files', (req, res) => {
  const local = isLoopback(req);
  const q = String(req.query.q || '').trim();
  if (q && !local) {
    return res.status(403).json({
      error: 'searching file names is available on this machine only',
      why: 'Names are stored but never served over the network. A search that quietly matched '
        + 'nothing would look like an empty Drive rather than a refusal.',
    });
  }

  const where = ['mime_type <> ?'];
  const args = [FOLDER];
  if (req.query.account) { where.push('account = ?'); args.push(req.query.account); }
  if (q) { where.push('name LIKE ?'); args.push(`%${q}%`); }
  if (req.query.sharedOnly === 'true') where.push('shared = 1');
  args.push(Math.min(Number(req.query.limit) || 100, 500));

  const rows = db.prepare(
    `SELECT account, id, name, mime_type, size_bytes, modified_time, shared, trashed, web_link
       FROM drive_files WHERE ${where.join(' AND ')}
      ORDER BY modified_time DESC LIMIT ?`
  ).all(...args);

  res.json({
    namesIncluded: local,
    files: rows.map((r) => (local ? r : { ...r, name: undefined, web_link: undefined })),
  });
});

// Files shared with someone else, oldest first. Safe over the LAN because it carries no
// names — a count and a date is not a disclosure, and this is the one question here with a
// real consequence attached.
router.get('/shared', (req, res) => {
  const local = isLoopback(req);
  const rows = db.prepare(
    `SELECT account, id, name, mime_type, modified_time, web_link
       FROM drive_files WHERE shared = 1 AND mime_type <> ? ORDER BY modified_time ASC LIMIT 200`
  ).all(FOLDER);
  res.json({
    count: rows.length,
    namesIncluded: local,
    caveat: 'Drive reports THAT a file is shared, not with whom — that needs a per-file '
      + 'permissions call this does not make. Treat this as "worth reviewing", never as a list '
      + 'of who can see what.',
    files: rows.map((r) => (local ? r : { ...r, name: undefined, web_link: undefined })),
  });
});

module.exports = router;
module.exports.summary = summary;

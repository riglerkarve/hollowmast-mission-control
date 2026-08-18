#!/usr/bin/env node
//
// import-drive.cjs — pull Drive file METADATA into dashboard.db. Backlog #9.
//
//   node tools/import-drive.cjs            every account, full listing
//   node tools/import-drive.cjs --dry      list and count, write nothing
//
// Scope is drive.metadata.readonly: names, types, sizes, dates, owners, sharing. Never file
// contents. Names are loopback-only on the way OUT — enforced in server/routes/drive.js.
//
// THIS ONE CAN ACTUALLY FINISH, and says so. Gmail is bounded by a budget and reports a
// coverage percentage; Drive here is 42 files and 1 file, so a run lists everything and
// records listed_everything = 1. Drive's API offers NO total file count, so a percentage
// would have to be invented — "did the paging run out" is the honest completeness signal and
// it is the one recorded.
'use strict';
require('./_run-log.cjs').record();

const db = require('../server/db');
// Provenance: every read this process makes is logged against this actor. Without it the
// access log records 'unknown', which is honest but useless. See server/provenance.js.
db.setProcessActor('import');
require('../server/routes/drive');
const ga = require('./google-auth.cjs');

const args = process.argv.slice(2);
const DRY = args.includes('--dry');

const FIELDS = 'nextPageToken,files(id,name,mimeType,size,createdTime,modifiedTime,'
  + 'owners(emailAddress),parents,trashed,shared,webViewLink)';

async function importAccount(account) {
  const token = await ga.accessToken(account);
  if (!token) return { account, ok: false, why: 'no usable credential' };

  const files = [];
  let pageToken = null;
  let pages = 0;
  do {
    const u = new URL('https://www.googleapis.com/drive/v3/files');
    u.searchParams.set('pageSize', '1000');
    u.searchParams.set('fields', FIELDS);
    // NO q FILTER, deliberately. Drive v3 lists trashed files by default, and "deleted but
    // still there" is a real state worth seeing — filtering it out is how a trash stays full
    // unnoticed. (An earlier attempt passed q=true to mean "everything"; Drive's q takes a
    // query EXPRESSION, not a boolean, and returned 400 Invalid Value. Omitting it is both
    // correct and what was wanted.)
    if (pageToken) u.searchParams.set('pageToken', pageToken);
    const r = await fetch(u, { headers: { authorization: `Bearer ${token}` } });
    if (!r.ok) return { account, ok: false, why: `list ${r.status}: ${(await r.text()).slice(0, 160)}` };
    const b = await r.json();
    (b.files || []).forEach((f) => files.push(f));
    pageToken = b.nextPageToken;
    pages++;
  } while (pageToken && pages < 50);

  // Paging ran out on its own => everything was listed. Hitting the page guard means it did
  // not, and that must not be reported as a complete import.
  const listedEverything = !pageToken;

  let quota = null;
  const ab = await fetch('https://www.googleapis.com/drive/v3/about?fields=storageQuota', {
    headers: { authorization: `Bearer ${token}` },
  });
  if (ab.ok) quota = Number(((await ab.json()).storageQuota || {}).usageInDrive) || null;

  if (DRY) return { account, ok: true, dry: true, wouldWrite: files.length, listedEverything, quota };

  const ins = db.prepare(
    `INSERT OR REPLACE INTO drive_files
       (account, id, name, mime_type, size_bytes, created_time, modified_time, owner_email,
        parents, trashed, shared, web_link)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  );

  db.withTransaction(() => {
    for (const f of files) {
      ins.run(
        account, f.id, f.name || null, f.mimeType || null,
        // Google-native docs report NO size. NULL, never 0 — a zero would sum into totals and
        // make a spreadsheet look empty rather than unmeasured.
        f.size !== undefined ? Number(f.size) : null,
        f.createdTime || null, f.modifiedTime || null,
        (f.owners && f.owners[0] && f.owners[0].emailAddress) || null,
        (f.parents || []).join(','), f.trashed ? 1 : 0, f.shared ? 1 : 0,
        f.webViewLink || null,
      );
    }
    db.prepare(
      `INSERT INTO drive_sync (account, files_held, listed_everything, quota_used_bytes, last_run_at, last_error)
       VALUES (?,?,?,?,datetime('now','localtime'),NULL)
       ON CONFLICT(account) DO UPDATE SET
         files_held = excluded.files_held, listed_everything = excluded.listed_everything,
         quota_used_bytes = excluded.quota_used_bytes, last_run_at = excluded.last_run_at,
         last_error = excluded.last_error`
    ).run(account, files.length, listedEverything ? 1 : 0, quota);
  });

  return { account, ok: true, written: files.length, listedEverything, quota };
}

(async () => {
  const accounts = ga.accounts();
  if (!accounts.length) { console.error('  no accounts authorised'); process.exitCode = 1; return; }

  const out = [];
  for (const a of accounts) out.push(await importAccount(a));

  for (const r of out) {
    if (!r.ok) { console.log(`  ${r.account}: FAILED — ${r.why}`); continue; }
    const n = r.dry ? r.wouldWrite : r.written;
    console.log(`  ${r.account}: ${r.dry ? 'would write' : 'wrote'} ${n} file(s)`
      + `, Drive using ${r.quota ? (r.quota / 1048576).toFixed(1) + ' MB' : 'unknown'}`);
    console.log(`     ${r.listedEverything
      ? 'listed everything Drive offered — this is a COMPLETE import'
      : 'STOPPED EARLY at the page guard — this is NOT complete'}`);
  }
})();

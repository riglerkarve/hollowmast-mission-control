#!/usr/bin/env node
//
// import-claude-sessions.cjs — record Claude's own work as focus sessions.
//
//   node tools/import-claude-sessions.cjs          import
//   node tools/import-claude-sessions.cjs --dry    show what would change, write nothing
//
// ---------------------------------------------------------------------------------------
// ASKED FOR 18 Aug 2026: "wire the focus app to record claude workloads."
//
// DERIVED, NOT LOGGED. The obvious implementation is an endpoint the agent calls when it
// finishes something — and it is wrong, because a record that depends on the agent
// remembering to write it is wrong the first time it forgets, and nothing would ever show
// that it had. tools/telemetry.cjs already parses the real session transcripts, so the work
// is measured whether or not anyone thought to record it.
//
// activeMs, NOT wallMs. Wall clock counts the hours a session sat open while nobody was at
// the machine; active time is the part where work was actually happening. Both are in the
// telemetry and using the flattering one would overstate this by roughly 20%.
//
// THE SEPARATION IS THE POINT. Every row lands with by_whom='claude', and every read of
// focus_sessions in server/routes/stats.js excludes that — verified, all eight of them.
// The owner's streaks, totals and "days with a focus session" must never absorb an agent's
// hours; that is the exact fabrication server/provenance.js exists to prevent.
// ---------------------------------------------------------------------------------------
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const db = require('../server/db');

// REQUIRED FOR ITS MIGRATION, not for its router. Migrations in this project run when a
// route file is required, so a tool that only requires db.js sees whatever schema the last
// server start happened to leave behind. Without this line the first run failed with
// "no column named source_key" — the column exists in code and had never been applied in
// this process. Requiring the owner makes the tool responsible for the schema it uses.
require('../server/routes/sessions');

const DRY = process.argv.includes('--dry');
const SESSIONS = path.join(__dirname, '..', 'data', 'telemetry', 'sessions.json');

function main() {
  // Absence and failure must differ: no telemetry file is a different problem from a
  // telemetry file containing nothing.
  if (!fs.existsSync(SESSIONS)) {
    console.error(`No parsed telemetry at:\n  ${SESSIONS}`);
    console.error('Run `node tools/telemetry.cjs` first — this imports its output rather than');
    console.error('parsing transcripts itself, so there is one owner for what a session was.');
    process.exit(2);
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(SESSIONS, 'utf8'));
  } catch (err) {
    console.error(`Telemetry file is present but unreadable: ${err.message}`);
    console.error('Refusing to report "0 sessions" for a parse failure.');
    process.exit(2);
  }

  const list = Array.isArray(parsed) ? parsed : (parsed.sessions || []);
  if (!list.length) {
    console.log('  telemetry parsed 0 sessions — nothing to import, and nothing is wrong.');
    return;
  }

  const rows = list
    .filter((s) => s.sessionId && s.lastTs)
    .map((s) => {
      const minutes = Math.round((s.activeMs || 0) / 60000);
      return {
        key: `claude:${s.sessionId}`,
        minutes,
        // The session's END is when the work landed. Stored in local time to match every
        // other completed_at in this table, which SQLite writes with 'localtime'.
        at: new Date(s.lastTs).toLocaleString('sv-SE').replace('T', ' '),
        msgs: s.msgs || 0,
        tools: s.toolCalls || 0,
      };
    })
    // A session with no measurable active time is not work. Reported, not silently dropped.
    .filter((r) => {
      if (r.minutes > 0) return true;
      console.log(`  skipped ${r.key.slice(0, 20)}… — 0 active minutes`);
      return false;
    });

  const before = db.prepare("SELECT COUNT(*) n FROM focus_sessions WHERE by_whom = 'claude'").get().n;

  if (DRY) {
    console.log(`  ${rows.length} session(s) would be imported`);
    console.log(`  ${rows.reduce((a, r) => a + r.minutes, 0)} active minutes total`);
    console.log(`  ${before} Claude row(s) already present — re-running is an upsert, not a duplicate`);
    return;
  }

  // Upsert on source_key. Re-running after another session simply updates the rows that
  // changed and adds the new ones; it can never double-count, which matters because this is
  // the sort of thing that gets run from a scheduled task later.
  const up = db.prepare(`
    INSERT INTO focus_sessions (kind, duration_minutes, completed_at, by_whom, source_key)
    VALUES ('work', ?, ?, 'claude', ?)
    ON CONFLICT(source_key) DO UPDATE SET
      duration_minutes = excluded.duration_minutes,
      completed_at     = excluded.completed_at
  `);

  db.exec('BEGIN');
  try {
    for (const r of rows) up.run(r.minutes, r.at, r.key);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    console.error(`import failed, nothing written: ${err.message}`);
    process.exit(1);
  }

  const after = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(duration_minutes),0) m FROM focus_sessions WHERE by_whom = 'claude'").get();
  console.log(`  imported ${rows.length} session(s): ${before} -> ${after.n} Claude rows, ${after.m} active minutes`);

  // The check that matters, printed every run rather than assumed: the owner's own numbers
  // must be untouched by any of this.
  const yours = db.prepare("SELECT COUNT(*) n FROM focus_sessions WHERE by_whom IS NULL OR by_whom <> 'claude'").get().n;
  console.log(`  your sessions, unaffected: ${yours}`);
}

main();

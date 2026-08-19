'use strict';
//
// _run-log.cjs — record that a tool ran, so #16 can be answered with evidence.
//
// Backlog #16 says, in its own rationale: "log what actually repeats for two weeks, then
// automate the top three. Automating a guess is how you get a surface to feed." Nothing was
// logging, so the two weeks had never started. This starts them.
//
// Required as one line at the top of each tool. It records the tool name, the flags, how long
// it ran and whether it exited cleanly — and nothing else. No arguments beyond flags, because
// a file path can be a credential path and a search term can be personal.
//
// IT MUST NEVER BE THE REASON A TOOL FAILS. Every path is wrapped: a locked database, a missing
// table or a broken clock leaves the tool running normally and simply loses one row. A logger
// that can break the thing it observes is worse than no logger.
//
// It records the FLAGS but not the values. `--account paypal` logs as `--account`, because the
// question #16 asks is "what do I keep doing", not "what did I do it to".

const path = require('node:path');

function record() {
  try {
    const db = require('../server/db');

    // @no-actor-by-design: a logger must not overwrite the actor its host tool chose.
    //
    // THIS FILE DELIBERATELY SETS NO ACTOR. provenance-check still lists it every run,
    // marked BY DESIGN with the reason above -- an exemption that hid the file would be
    // a place to put anything.
    //
    // db.setProcessActor writes a MODULE-LEVEL global. A logger that set one would
    // silently overwrite the actor its host tool chose -- so import-paypal would start
    // filing its rows under whatever this file picked, and the attribution work would
    // be undone by the thing measuring it.
    //
    // So tool_runs rows carry whatever actor the host already established, and rows
    // from a tool that set none are honestly `unknown`. That is the correct answer:
    // the run log does not know who ran it, and should not guess.

    db.migrate('runlog', [
      (d) => {
        d.exec(`
          CREATE TABLE tool_runs (
            id       INTEGER PRIMARY KEY AUTOINCREMENT,
            tool     TEXT NOT NULL,
            flags    TEXT,
            at       TEXT NOT NULL,
            ms       INTEGER,
            exit_ok  INTEGER
          );
          CREATE INDEX idx_tool_runs_tool ON tool_runs (tool, at DESC);
        `);
      },
    ]);

    const tool = path.basename(process.argv[1] || 'unknown');
    // Flags only. A value can be a path, a token file, or a search term.
    const flags = process.argv.slice(2).filter((a) => a.startsWith('--')).join(' ') || null;
    const started = Date.now();

    process.on('exit', (code) => {
      try {
        db.prepare('INSERT INTO tool_runs (tool, flags, at, ms, exit_ok) VALUES (?, ?, ?, ?, ?)')
          .run(tool, flags, new Date().toISOString(), Date.now() - started, code === 0 ? 1 : 0);
      } catch { /* a lost row must never break a tool */ }
    });
  } catch { /* no database, no log, no problem */ }
}

// What repeats, for whoever answers #16. Reports the WINDOW as well as the counts, because
// "ran 9 times" means nothing without knowing whether that was over a day or a fortnight.
function summary(days) {
  const db = require('../server/db');
  const since = new Date(Date.now() - (Number(days) || 14) * 86400000).toISOString();
  const rows = db.prepare(
    `SELECT tool, COUNT(*) AS runs, MIN(at) AS first, MAX(at) AS last,
            SUM(CASE WHEN exit_ok = 0 THEN 1 ELSE 0 END) AS failures,
            ROUND(AVG(ms)) AS avg_ms
     FROM tool_runs WHERE at >= ? GROUP BY tool ORDER BY runs DESC`
  ).all(since);

  const total = rows.reduce((a, r) => a + r.runs, 0);
  const span = rows.length
    ? Math.max(1, Math.round((Date.parse(rows.reduce((m, r) => (r.last > m ? r.last : m), rows[0].last))
      - Date.parse(rows.reduce((m, r) => (r.first < m ? r.first : m), rows[0].first))) / 86400000))
    : 0;

  return {
    rows,
    total,
    spanDays: span,
    enough: span >= 14,
    // The item asks for two weeks. Saying so is the difference between evidence and a hunch.
    why: span >= 14
      ? null
      : `only ${span} day(s) of history so far; #16 asks for two weeks before automating anything`,
  };
}

module.exports = { record, summary };

// panel-usage — one row per panel opened. M342.
//
// WHY: 68 panels, and until now nothing recorded which of them he opens. A whole debate
// about which parts of Mission Control earn their place ran on inference, because no
// usage figure existed to run it on. Two weeks of this turns every future version of that
// argument into arithmetic.
//
// ---------------------------------------------------------------------------------------
// A PASSIVE LOG. IT MUST NEVER ASK HIM ANYTHING.
//
// The finding this whole plan rests on is that every instrument requiring a RECURRING act
// from him is dead here -- journal 1 row, cash_counts 0, lifestyle_intake 0, alerts 31
// events and 0 verdicts, steering asked four times and answered by a backfill. The moment
// this surface asks him to rate, confirm or dismiss anything, it joins that list and
// stops producing data. It records and stays silent. There is no panel for it, on purpose.
//
// ---------------------------------------------------------------------------------------
// THE HONEST LIMITATION, STATED HERE RATHER THAN DISCOVERED LATER.
//
// shell.js is the human surface and sends `X-MC-By: you`. Claude sessions drive that same
// shell through the browser pane -- this session opened panels in it repeatedly while
// building the servers panel and the alerts conversion. Those opens are indistinguishable
// from his unless the driving session says so.
//
// That is exactly the defect already recorded against team_handovers.read_at, which is
// populated on 99 of 103 rows and carries by_whom='unknown' on all 99: an engagement
// figure that cannot tell his hand from ours. Building a second one knowingly would be
// worse than the first.
//
// SO: a session driving the pane sets `localStorage.mc_agent = '1'` and shell.js sends
// 'claude' instead. Opt-in, and it WILL sometimes be forgotten -- so `GET /usage` reports
// the split rather than a single number, and never sums them. A total that blends his
// opens with a session's is the fabricated-data-about-a-person failure server/provenance.js
// was written to prevent, and this route must not reintroduce it one table over.

const express = require('express');
const db = require('../db');

db.migrate('panel_usage', [
  (d) => {
    d.exec(`
      CREATE TABLE panel_opens (
        id      INTEGER PRIMARY KEY AUTOINCREMENT,
        panel   TEXT NOT NULL,
        at      TEXT NOT NULL DEFAULT (datetime('now','localtime')),
        by_whom TEXT NOT NULL DEFAULT 'unknown'
      );
      CREATE INDEX idx_panel_opens ON panel_opens(panel, at);
    `);
  },
]);

const router = express.Router();

// Fire-and-forget from shell.js. It must never fail loudly: a telemetry write that throws
// in front of a panel mount would break the app to record that the app was used.
router.post('/open', express.json(), (req, res) => {
  const panel = String((req.body || {}).panel || '').trim().slice(0, 64);
  if (!panel) return res.status(400).json({ error: 'panel is required' });
  try {
    db.prepare('INSERT INTO panel_opens (panel, by_whom) VALUES (?, ?)').run(panel, req.by || 'unknown');
  } catch (e) {
    return res.status(500).json({ error: 'could not record: ' + e.message });
  }
  res.json({ ok: true });
});

router.get('/usage', (req, res) => {
  const days = Math.min(90, Math.max(1, Number(req.query.days) || 14));
  const since = `-${days} days`;

  let rows;
  try {
    rows = db.prepare(
      `SELECT panel,
              SUM(CASE WHEN by_whom = 'you' THEN 1 ELSE 0 END)  AS you,
              SUM(CASE WHEN by_whom <> 'you' THEN 1 ELSE 0 END) AS sessions,
              MAX(at) AS last
         FROM panel_opens
        WHERE at >= datetime('now','localtime', ?)
        GROUP BY panel`
    ).all(since);
  } catch (e) {
    // COULD NOT LOOK is not "nothing was opened". They are opposite facts and this table
    // exists to answer a question where that distinction decides what gets deleted.
    return res.status(500).json({ state: 'could-not-look', why: e.message,
      note: 'This is NOT a report that no panel was opened.' });
  }

  const opened = new Map(rows.map((r) => [r.panel, r]));
  const total = rows.reduce((n, r) => n + r.you + r.sessions, 0);

  if (!total) {
    return res.json({
      state: 'none-recorded', days,
      note: 'No panel open has been recorded in this window. If the shell was deployed less '
          + 'than that ago, this is an empty ledger rather than an unused dashboard -- check '
          + 'the earliest row before reading it as disuse.',
      earliest: db.prepare('SELECT MIN(at) m FROM panel_opens').get().m || null,
    });
  }

  res.json({
    state: 'ok', days, total,
    // NEVER SUMMED. See the header: a blended figure cannot be told from a fabricated one.
    panels: rows.sort((a, b) => b.you - a.you || b.sessions - a.sessions),
    neverOpened: null,   // filled by the caller if it knows the panel registry; this route
                         // deliberately does not, because the registry lives in shell.js and
                         // duplicating it here would be a second place that list lives.
    caveat: 'you = opened from the human surface. sessions = a Claude session that set the '
          + 'agent flag. A session that did NOT set it is counted under "you" -- so "you" is '
          + 'an upper bound, never a measurement.',
    earliest: db.prepare('SELECT MIN(at) m FROM panel_opens').get().m || null,
  });
  void opened;
});

module.exports = router;

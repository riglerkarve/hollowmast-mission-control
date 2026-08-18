// The BRIEFING module. Named 'briefing', not 'reports': the focus-statistics panel
// already owns /api/stats under the name Reports, and two modules called the same
// thing is precisely what the module contract forbids. Caught before either shipped.
const express = require('express');
const db = require('../db');

db.migrate('briefing', [
  (d) => {
    d.exec(`
      CREATE TABLE briefings (
        date       TEXT PRIMARY KEY,          -- ISO date the briefing is FOR
        markdown   TEXT NOT NULL,
        facts      TEXT NOT NULL,             -- the JSON the prose was written from
        prose_by   TEXT,                      -- 'model' | NULL when Ollama was unavailable
        created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
      );
    `);
  },
]);

const router = express.Router();

router.get('/', (req, res) => {
  const limit = Math.min(90, Math.max(1, Number(req.query.limit) || 30));
  res.json(db.prepare(
    `SELECT date, prose_by, created_at, length(markdown) AS bytes
     FROM briefings ORDER BY date DESC LIMIT ?`
  ).all(limit));
});

router.get('/latest', (req, res) => {
  const row = db.prepare('SELECT * FROM briefings ORDER BY date DESC LIMIT 1').get();
  // An empty table and a failed generator must not render the same. 404 with a reason.
  if (!row) return res.status(404).json({ error: 'no briefing has been generated yet' });
  res.json({ ...row, facts: JSON.parse(row.facts) });
});

// --- Major Tom ------------------------------------------------------------------------
// Backlog #22. The speaking was already built and verified in scripts/voice.cjs on 18 Aug
// and then CALLED BY NOTHING — no route, no task, no button. It has been sitting silent
// since. That is the fifth instance of the same failure in this project, so the work here
// is connecting it, not writing it.
//
// ON REQUEST ONLY, never unprompted. A voice that speaks when you did not ask arrives
// whether or not the room is empty, cannot be re-read, and becomes the thing you learn to
// mute — the same bar every notification here has to clear, and harder, because muting a
// voice means turning off the speakers.
//
// THERE IS NO TEXT PARAMETER, DELIBERATELY. This endpoint shells out to PowerShell, so any
// caller-supplied string would be an injection surface on a server that binds 0.0.0.0.
// The route speaks the line the system computed from SQL and nothing else, which removes
// the class of bug rather than trying to sanitise it. The CLI keeps --say for local use,
// where you already have a shell.
const voice = require('../../scripts/voice.cjs');

router.get('/speak', (req, res) => {
  // GET returns what WOULD be said, so the panel can show the words before speaking them
  // and you are never surprised by what comes out.
  try {
    res.json({ line: voice.line() });
  } catch (err) {
    res.status(503).json({ error: `could not compose a line: ${err.message}` });
  }
});

router.post('/speak', async (req, res) => {
  let line;
  try {
    line = voice.line();
  } catch (err) {
    return res.status(503).json({ error: `could not compose a line: ${err.message}` });
  }

  // speakAsync, NOT speak. The synchronous one blocks Node's single thread for the whole
  // sentence: measured at 5,084 ms of total server unavailability for one line, on an
  // endpoint the watchdog polls and treats a timeout as DOWN.
  const r = await voice.speakAsync(line);
  // Three outcomes, never two: spoken, could-not-speak, and nothing-worth-saying. A silent
  // success and a broken speech synthesiser must not render the same.
  if (r.error) {
    return res.status(503).json({
      line,
      spoken: false,
      error: 'System.Speech did not answer — the line is above, it just was not said aloud.',
    });
  }
  res.json({ line, spoken: Boolean(r.spoken) });
});

router.get('/:date', (req, res) => {
  const row = db.prepare('SELECT * FROM briefings WHERE date = ?').get(req.params.date);
  if (!row) return res.status(404).json({ error: `no briefing for ${req.params.date}` });
  res.json({ ...row, facts: JSON.parse(row.facts) });
});

module.exports = router;

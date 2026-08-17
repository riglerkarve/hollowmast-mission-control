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

router.get('/:date', (req, res) => {
  const row = db.prepare('SELECT * FROM briefings WHERE date = ?').get(req.params.date);
  if (!row) return res.status(404).json({ error: `no briefing for ${req.params.date}` });
  res.json({ ...row, facts: JSON.parse(row.facts) });
});

module.exports = router;

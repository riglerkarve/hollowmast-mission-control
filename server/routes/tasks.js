const express = require('express');
const db = require('../db');

// The tasks table predates the module system and was created in db.js with
// CREATE TABLE IF NOT EXISTS. It owns its own changes from here.
//
// v1 adds completed_at. Without it a finished task carries no date, so "what did I get
// done this week" — the question the reports item exists to answer — was unanswerable
// from the most obvious signal in the app. Backfill is deliberately NULL: the rows that
// are already done have no honest completion date and inventing one would make the
// first week's figures wrong in a way nothing could later detect.
db.migrate('tasks', [
  (d) => {
    d.exec('ALTER TABLE tasks ADD COLUMN completed_at TEXT');
  },
]);

const router = express.Router();

function serializeTask(row) {
  return {
    id: row.id,
    text: row.text,
    done: !!row.done,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    pomodoros: row.pomodoros,
  };
}

router.get('/', (req, res) => {
  const rows = db
    .prepare(
      `SELECT t.*, COUNT(CASE WHEN s.kind = 'work' THEN 1 END) AS pomodoros
       FROM tasks t
       LEFT JOIN focus_sessions s ON s.task_id = t.id
       GROUP BY t.id
       ORDER BY t.created_at ASC`
    )
    .all();
  res.json(rows.map(serializeTask));
});

router.post('/', (req, res) => {
  const text = typeof req.body.text === 'string' ? req.body.text.trim() : '';
  if (!text) {
    res.status(400).json({ error: 'text is required' });
    return;
  }
  const info = db.prepare('INSERT INTO tasks (text) VALUES (?)').run(text.slice(0, 200));
  const row = db.prepare('SELECT *, 0 AS pomodoros FROM tasks WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json(serializeTask(row));
});

router.patch('/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  if (!existing) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  const done = typeof req.body.done === 'boolean' ? (req.body.done ? 1 : 0) : existing.done;

  // Stamped when it becomes done and cleared when it is reopened, so the date always
  // means "finished on", never "was finished once".
  if (done && !existing.done) {
    db.prepare("UPDATE tasks SET done = 1, completed_at = datetime('now','localtime') WHERE id = ?").run(id);
  } else if (!done && existing.done) {
    db.prepare('UPDATE tasks SET done = 0, completed_at = NULL WHERE id = ?').run(id);
  } else {
    db.prepare('UPDATE tasks SET done = ? WHERE id = ?').run(done, id);
  }
  const row = db
    .prepare(
      `SELECT t.*, COUNT(CASE WHEN s.kind = 'work' THEN 1 END) AS pomodoros
       FROM tasks t LEFT JOIN focus_sessions s ON s.task_id = t.id
       WHERE t.id = ? GROUP BY t.id`
    )
    .get(id);
  res.json(serializeTask(row));
});

router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
  res.status(204).end();
});

// Asked for by the briefing rather than read from its tables — same rule as finance.
function completedSince(sinceIso) {
  return db.prepare(
    "SELECT COUNT(*) c FROM tasks WHERE done = 1 AND completed_at IS NOT NULL AND completed_at >= ?"
  ).get(sinceIso).c;
}

// How many finished tasks predate the column, and therefore cannot be counted in any
// period. A figure that silently excludes them would understate early weeks.
function undatedDone() {
  return db.prepare('SELECT COUNT(*) c FROM tasks WHERE done = 1 AND completed_at IS NULL').get().c;
}

module.exports = router;
module.exports.completedSince = completedSince;
module.exports.undatedDone = undatedDone;

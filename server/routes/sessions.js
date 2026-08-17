const express = require('express');
const db = require('../db');

const router = express.Router();

const VALID_KINDS = new Set(['work', 'short', 'long']);

router.post('/', (req, res) => {
  const { kind, durationMinutes, taskId } = req.body;

  if (!VALID_KINDS.has(kind)) {
    res.status(400).json({ error: `kind must be one of ${[...VALID_KINDS].join(', ')}` });
    return;
  }
  const minutes = Number(durationMinutes);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    res.status(400).json({ error: 'durationMinutes must be a positive number' });
    return;
  }

  let resolvedTaskId = null;
  if (taskId != null) {
    const task = db.prepare('SELECT id FROM tasks WHERE id = ?').get(Number(taskId));
    resolvedTaskId = task ? task.id : null;
  }

  const info = db
    .prepare('INSERT INTO focus_sessions (task_id, kind, duration_minutes) VALUES (?, ?, ?)')
    .run(resolvedTaskId, kind, Math.round(minutes));

  const row = db.prepare('SELECT * FROM focus_sessions WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({
    id: row.id,
    taskId: row.task_id,
    kind: row.kind,
    durationMinutes: row.duration_minutes,
    completedAt: row.completed_at,
  });
});

module.exports = router;

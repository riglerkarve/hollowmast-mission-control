const express = require('express');
const db = require('../db');

// LIVENESS — is the service alive, not is the USER well. Mounted at /api/status.
//
// This lived at /api/health in routes/health.js until 17 Aug, when the health module
// wanted that name and I overwrote this file building it. Renamed so the collision cannot
// happen again: one name, one owner, and "health" now unambiguously means steps and sleep.
// The watchdog's URL was updated in the same change.

const router = express.Router();
const STARTED_AT = new Date();

// Health must prove the SERVICE, not the process. A route that returns {ok:true} without
// touching storage stays green while SQLite is locked, the data directory has moved, or
// the disk is full — which are exactly the failures you need it for. So it runs a real
// query, and answers 503 when that query cannot run.
router.get('/', (req, res) => {
  let database = 'ok';
  let taskCount = null;

  try {
    taskCount = db.prepare('SELECT COUNT(*) AS c FROM tasks').get().c;
  } catch (err) {
    database = `error: ${err.message}`;
  }

  const ok = database === 'ok';
  res.status(ok ? 200 : 503).json({
    ok,
    database,
    taskCount,
    pid: process.pid,
    startedAt: STARTED_AT.toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
  });
});

module.exports = router;

// The single way anything in Mission Control raises a notification.
//
//   const notify = require('./notify.cjs');
//   notify('uptime', 'Mission Control is DOWN', 'restart failed');
//
// Every alert is RECORDED before it is sent, and a kind you have marked ignored twice is
// recorded but not shown. That is the workspace rule — "anything dismissed twice gets
// deleted, not tuned" — enforced here rather than left as an intention.
//
// Before this existed, the watchdog and the briefing each shelled out to notify.ps1
// directly and left no trace, so "dismissed twice" could never be counted.
'use strict';

const path = require('node:path');
const { execFileSync } = require('node:child_process');

const alerts = require('../server/routes/alerts');

const PS1 = path.join(__dirname, 'notify.ps1');

module.exports = function notify(kind, title, body) {
  let decision;
  try {
    decision = alerts.record(kind, title, body);
  } catch (err) {
    // The ledger failing must not swallow the alert — an outage notice matters more than
    // its own bookkeeping. Send it and say the record failed.
    console.error(`alert ledger failed (${err.message}); sending anyway, unrecorded`);
    decision = { send: true, id: null, muted: false };
  }

  if (!decision.send) {
    // Suppressed, not lost. It is in the ledger, and the panel shows what you are not
    // being told — otherwise a muted alert and a quiet day look identical.
    console.log(`suppressed (${kind} is muted): ${title}`);
    return { delivered: false, suppressed: true, id: decision.id };
  }

  try {
    execFileSync('powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS1, '-Title', title, '-Message', body || title],
      { stdio: 'pipe', timeout: 20000 });
    return { delivered: true, suppressed: false, id: decision.id };
  } catch (err) {
    // "We alerted you" and "we tried to alert you" are different facts.
    const why = String(err.stderr || err.message).trim().slice(0, 200);
    console.error(`ALERT DELIVERY FAILED: ${why}`);
    return { delivered: false, suppressed: false, id: decision.id, error: why };
  }
};

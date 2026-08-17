// Mission Control watchdog. Runs every 5 minutes from the "MissionControl-Watchdog"
// scheduled task — a SEPARATE process from the server, deliberately. A monitor started
// by the thing it monitors dies with it and reports nothing, which is the failure mode
// this exists to close.
//
//   node scripts/watchdog.cjs          check, restart if needed, alert on transition
//   node scripts/watchdog.cjs --dry    check and log only; never restarts, never alerts
//
// Written 17 Aug 2026 after the server was found dead for ~4 hours with a log whose
// last line still read "Dashboard running".
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const STATE_FILE = path.join(ROOT, 'data', 'watchdog-state.json');
const HEARTBEAT_FILE = path.join(ROOT, 'data', 'heartbeat.json');
const raise = require('./notify.cjs');   // records every alert, honours a muted kind

const URL = process.env.WATCHDOG_URL || 'http://127.0.0.1:3000/api/status';
const TASK = process.env.WATCHDOG_TASK || 'MissionControl-Server';
const PROBES = 3;                        // a single miss is a blip; three is a death
const PROBE_GAP_MS = 5000;
const PROBE_TIMEOUT_MS = 5000;
const RENOTIFY_AFTER_MS = 30 * 60000;    // still-down reminder, at most half-hourly
const HEARTBEAT_STALE_MS = 90000;        // 3x the server's 30s beat

const DRY = process.argv.includes('--dry');

function log(line) {
  const stamp = new Date().toISOString();
  const dir = path.join(ROOT, 'logs');
  const file = path.join(dir, `watchdog-${stamp.slice(0, 10)}.log`);
  const text = `[${stamp}]${DRY ? ' (dry)' : ''} ${line}\n`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(file, text);
  } catch {
    // Logging must never be the thing that fails.
  }
  process.stdout.write(text);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeState(state) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    const tmp = `${STATE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, STATE_FILE);
  } catch (err) {
    log(`WARN could not write state: ${err.message}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function probe() {
  try {
    const res = await fetch(URL, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    const body = await res.json().catch(() => null);
    // 200 alone is not enough. The endpoint answers 503 with ok:false when SQLite is
    // unreachable, and a dashboard that cannot read its own database is down.
    return { ok: res.status === 200 && body != null && body.ok === true, status: res.status, body };
  } catch (err) {
    return { ok: false, status: null, error: err.message };
  }
}

async function confirmDown() {
  let last = null;
  for (let i = 0; i < PROBES; i += 1) {
    last = await probe();
    if (last.ok) return { down: false, last };
    if (i < PROBES - 1) await sleep(PROBE_GAP_MS);
  }
  return { down: true, last };
}

function notify(title, message) {
  if (DRY) {
    log(`WOULD NOTIFY: ${title} — ${message}`);
    return true;
  }
  const r = raise('uptime', title, message);
  if (r.suppressed) { log(`SUPPRESSED (uptime muted): ${title} | ${message}`); return true; }
  if (r.delivered) { log(`ALERTED: ${title} | ${message}`); return true; }
  // "We alerted you" and "we tried to alert you" are different facts. Never conflate them.
  log(`ALERT DELIVERY FAILED: ${r.error || 'unknown'}`);
  return false;
}

// Reads the scheduler's own view of the task. Returns 'Running', 'Ready', or null.
function taskStatus() {
  try {
    const out = execFileSync('schtasks.exe', ['/query', '/tn', TASK, '/fo', 'csv', '/nh'],
      { stdio: 'pipe', timeout: 15000 }).toString();
    const cols = out.trim().split(/\r?\n/)[0].split('","');
    return cols.length >= 3 ? cols[2].replace(/"/g, '').trim() : null;
  } catch {
    return null;
  }
}

function restart() {
  if (DRY) {
    log('WOULD RESTART the server task');
    return false;
  }
  try {
    // /end first: the task can read as Running while the port is dead, and /run on an
    // already-running task is a no-op that looks exactly like success.
    try {
      execFileSync('schtasks.exe', ['/end', '/tn', TASK], { stdio: 'pipe', timeout: 15000 });
    } catch {
      // Not currently running is a normal case, not an error.
    }

    // WAIT for the scheduler to actually reach Ready. /end returns SUCCESS immediately
    // and the state lags it by a second or two; a /run issued inside that window is
    // silently dropped, the task keeps its old LastRunTime, and nothing anywhere reports
    // a failure. Cost 17 Aug 2026: two "restarts" that never happened.
    const deadline = Date.now() + 15000;
    let status = taskStatus();
    while (status === 'Running' && Date.now() < deadline) {
      execFileSync('powershell.exe', ['-NoProfile', '-Command', 'Start-Sleep -Milliseconds 500'], { stdio: 'pipe' });
      status = taskStatus();
    }
    if (status === 'Running') {
      log('RESTART ABORTED: task still Running 15s after /end; /run would be a silent no-op');
      return false;
    }

    execFileSync('schtasks.exe', ['/run', '/tn', TASK], { stdio: 'pipe', timeout: 15000 });
    return true;
  } catch (err) {
    log(`RESTART COMMAND FAILED: ${String(err.stderr || err.message).trim().slice(0, 200)}`);
    return false;
  }
}

// How long has it actually been dead, and how did it die? The health endpoint can only
// ever answer "now" — this is the part that survives the process being killed outright.
function deathReport() {
  const hb = readJson(HEARTBEAT_FILE);
  if (!hb) return 'no heartbeat file';

  const ageMs = Date.now() - new Date(hb.lastBeat).getTime();
  const mins = (ageMs / 60000).toFixed(1);

  if (hb.status === 'stopped') return `stopped cleanly (${hb.reason}) ${mins} min ago`;
  if (hb.status === 'crashed') return `crashed ${mins} min ago: ${hb.reason}`;

  // Heartbeat AGE alone cannot tell a kill from a hang. The beat is every 30s, so a
  // freshly killed server still has a heartbeat only seconds old and reads as "alive" —
  // measured, it misreported a real kill as a hang. Whether the PID still exists is the
  // definitive answer; the timestamp only says WHEN.
  //
  // signal 0 performs the permission and existence checks without delivering anything.
  let alive;
  try {
    process.kill(hb.pid, 0);
    alive = true;
  } catch (err) {
    alive = err.code === 'EPERM';   // exists but is not ours — still alive
  }

  if (!alive) return `pid ${hb.pid} is gone, last beat ${mins} min ago — killed or exited, no shutdown signal delivered`;
  if (ageMs < HEARTBEAT_STALE_MS) return `pid ${hb.pid} is alive and still beating (${mins} min) — running but NOT serving`;
  return `pid ${hb.pid} is alive but has not beaten for ${mins} min — wedged, not killed`;
}

async function main() {
  const prev = readJson(STATE_FILE) || { state: 'unknown', downSince: null, lastNotifyAt: null, restarts: 0 };
  const now = Date.now();

  const first = await probe();

  if (first.ok) {
    if (prev.state === 'down') {
      const downMs = prev.downSince ? now - new Date(prev.downSince).getTime() : null;
      const mins = downMs == null ? 'an unknown time' : `${(downMs / 60000).toFixed(1)} min`;
      log(`RECOVERED after ${mins} down (uptime now ${first.body.uptimeSeconds}s)`);
      notify('Mission Control recovered', `Back up after ${mins} down.`);
    } else {
      log(`ok — uptime ${first.body.uptimeSeconds}s, ${first.body.taskCount} tasks`);
    }
    writeState({ state: 'up', downSince: null, lastNotifyAt: null, restarts: 0, lastCheck: new Date().toISOString() });
    return;
  }

  const { down, last } = await confirmDown();
  if (!down) {
    log(`transient miss, answered within ${PROBES} probes — not treating as an outage`);
    writeState({ ...prev, state: 'up', lastCheck: new Date().toISOString() });
    return;
  }

  const why = last.status ? `HTTP ${last.status} ok=false` : last.error;
  log(`DOWN — ${why}. ${deathReport()}`);

  const downSince = prev.state === 'down' && prev.downSince ? prev.downSince : new Date().toISOString();
  const restarted = restart();

  let recovered = false;
  if (restarted) {
    for (let i = 0; i < 6 && !recovered; i += 1) {   // up to 30s for express to bind
      await sleep(5000);
      recovered = (await probe()).ok;
    }
    log(recovered ? 'restart succeeded' : 'restart did NOT bring it back');
  }

  // Alert on the transition, and at most half-hourly while it stays down. An alert you
  // learn to dismiss is worse than no alert, because it teaches you to ignore the channel.
  const sinceNotify = prev.lastNotifyAt ? now - new Date(prev.lastNotifyAt).getTime() : Infinity;
  const shouldNotify = prev.state !== 'down' || sinceNotify > RENOTIFY_AFTER_MS;
  let lastNotifyAt = prev.lastNotifyAt;

  if (shouldNotify) {
    const delivered = recovered
      ? notify('Mission Control restarted', `Was down (${why}). Restarted automatically.`)
      : notify('Mission Control is DOWN', `${why}. Automatic restart failed — needs you.`);
    if (delivered) lastNotifyAt = new Date().toISOString();
  } else {
    log('suppressed duplicate alert — already notified within 30 min');
  }

  writeState({
    state: recovered ? 'up' : 'down',
    downSince: recovered ? null : downSince,
    lastNotifyAt: recovered ? null : lastNotifyAt,
    restarts: (prev.restarts || 0) + (restarted ? 1 : 0),
    lastCheck: new Date().toISOString(),
  });

  if (!recovered) process.exitCode = 1;   // a failing task run is itself a signal
}

main().catch((err) => {
  log(`WATCHDOG ERROR: ${err.stack}`);
  process.exitCode = 2;
});

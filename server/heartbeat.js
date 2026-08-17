const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'heartbeat.json');
const TMP = `${FILE}.tmp`;
const INTERVAL_MS = 30_000;

const STARTED_AT = new Date().toISOString();

// Written temp-then-rename so a reader can never catch a half-written file.
function write(status, extra = {}) {
  const payload = {
    status,
    pid: process.pid,
    startedAt: STARTED_AT,
    lastBeat: new Date().toISOString(),
    ...extra,
  };
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(TMP, JSON.stringify(payload, null, 2));
    fs.renameSync(TMP, FILE);
  } catch {
    // A failed heartbeat write must never take the server down with it.
  }
}

// Why a heartbeat as well as /api/health:
//
// The health endpoint answers "is it up NOW". It cannot answer "when did it die",
// and on 17 Aug 2026 that was the whole problem — the log's last line was still
// "Dashboard running" four hours after the process had been killed, so up and
// long-dead looked identical.
//
// A shutdown handler alone does not fix that. On Windows a forced kill
// (Stop-Process -Force, TerminateProcess) delivers NO signal, so the graceful
// path below simply does not run. A timestamp that stops advancing is the only
// death signal that survives being killed abruptly, which is how it usually dies.
function start() {
  write('running');
  const timer = setInterval(() => write('running'), INTERVAL_MS);
  timer.unref(); // never hold the process open just to say it is alive

  const stop = (reason, code) => {
    write('stopped', { stoppedAt: new Date().toISOString(), reason });
    process.exit(code);
  };

  process.on('SIGINT', () => stop('SIGINT', 130));
  process.on('SIGTERM', () => stop('SIGTERM', 143));
}

// Called from the uncaughtException / unhandledRejection handlers. A crash and a
// kill must not leave the same trace: this records WHY, where a forced kill can
// only ever leave a stale timestamp.
function crashed(reason) {
  write('crashed', { stoppedAt: new Date().toISOString(), reason });
}

module.exports = { start, crashed, FILE, INTERVAL_MS };

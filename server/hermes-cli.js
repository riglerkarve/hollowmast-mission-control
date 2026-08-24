'use strict';
//
// hermes-cli.js — ONE OWNER for "where is the hermes binary, and did it actually run".
//
// Same shape as git.js and for the same reason: `hermes` is on PATH in a developer shell
// and is not guaranteed to be on PATH for the service running this server. Resolve an
// absolute path where one is knowable, probe it, and never let "could not run the tool"
// come back looking the same as "ran it and there was nothing to report".
//
// This module is generic — it does not know about kanban. server/routes/agents.js calls
// `run(['kanban', 'assignees', '--json'])` etc; this file only guarantees the binary runs.
//
// SELF-HEALING (24 Aug 2026, t_137df3fc): resolution used to run ONCE at module load and
// freeze `available` forever. The MissionControl-Server scheduled task starts at Windows
// logon — if hermes.exe was mid-write, being AV-scanned, or the very first `--version`
// spawn hiccuped for any transient reason at that moment, `available` latched to false
// and /api/agents + /api/open-tasks returned "hermes CLI not found" for the rest of the
// server's life, even though `hermes` worked fine in every interactive shell a human
// checked it from. Confirmed live: the absolute path resolved and the version probe
// succeeded the instant it was re-run — nothing was ever actually broken except the
// permanent cache of one bad moment. So resolution is now re-attempted lazily whenever
// the cached state says "not available", cheaply (existsSync, no subprocess) on every
// call, and the expensive --version probe every REPROBE_MS as a fuller health check.
//
// ASYNC (24 Aug 2026, same task, second root cause): `run()` used execFileSync, which
// blocks Node's single event loop thread for the entire subprocess lifetime — observed
// live at 1.7-8s per hermes invocation. agents.js makes 5+ of these sequentially per
// request, so one /api/agents hit froze the ENTIRE server (every other route, every
// other browser tab) for 10-20+ seconds. That is exactly the watchdog's "DOWN — fetch
// failed. pid alive and still beating — running but NOT serving" pattern logged
// throughout 24 Aug: the process was alive, just wedged inside a sync spawn. `runAsync`
// (execFile via util.promisify, non-blocking) is the fix; routes must use it, not `run`.
// `run` is kept only so nothing importing it at the top level breaks on load; it must
// not be called from a request handler.

const { execFileSync, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs');
const path = require('node:path');

const execFileAsync = promisify(execFile);

const REPROBE_MS = 60 * 1000; // re-run the full --version probe at most once a minute

function candidatePaths() {
  const candidates = [];
  if (process.env.HERMES_EXE) candidates.push(process.env.HERMES_EXE);
  if (process.env.LOCALAPPDATA) {
    candidates.push(path.join(process.env.LOCALAPPDATA, 'hermes', 'hermes-agent', 'venv', 'Scripts', 'hermes.exe'));
  }
  return candidates;
}

function findExisting() {
  for (const c of candidatePaths()) {
    try {
      if (fs.existsSync(c)) return { exe: c, how: 'absolute path' };
    } catch { /* an unreadable candidate is simply not the one */ }
  }
  return { exe: null, how: null };
}

function probeVersion(exe) {
  try {
    return execFileSync(exe, ['--version'], {
      encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
}

// Cached state. `exe`/`how`/`version` reflect the last successful resolution; `checkedAt`
// gates how often the expensive probe re-runs once resolution has succeeded at least once.
const state = { exe: null, how: null, version: null, checkedAt: 0 };

function ensureResolved() {
  const now = Date.now();
  if (state.exe) {
    // Already resolved once. Cheap re-check that the file is still where we found it —
    // this alone catches "was mid-write at boot, exists now" without a subprocess spawn.
    // Only re-run the full --version probe periodically, not on every single call.
    if (now - state.checkedAt < REPROBE_MS) return state;
    if (!fs.existsSync(state.exe)) {
      state.exe = null; state.how = null; state.version = null; // fall through to re-resolve
    } else {
      state.checkedAt = now;
      return state;
    }
  }

  // Not currently resolved (either never was, or the cached path vanished). Try again —
  // this is the self-healing path: a transient failure at server boot no longer sticks.
  const found = findExisting();
  let exe = found.exe;
  let how = found.how;

  if (!exe) {
    // Last resort: PATH, same as an interactive shell would find it.
    try {
      execFileSync('hermes', ['--version'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] });
      exe = 'hermes'; how = 'PATH';
    } catch { /* not on PATH either */ }
  }

  if (exe) {
    const version = probeVersion(exe);
    if (version !== null) {
      state.exe = exe; state.how = how; state.version = version; state.checkedAt = now;
      return state;
    }
    // Resolved a path but it would not actually run — do not claim available.
  }

  state.checkedAt = now;
  return state;
}

module.exports = {
  // `available` and `version` are live getters, not frozen booleans — every read
  // re-attempts resolution if the cache currently says "not available" (or the
  // cheap file-existence recheck failed), so a fix (install finishing, AV scan
  // clearing, PATH becoming valid) is picked up without restarting the server.
  get available() { return !!ensureResolved().exe; },
  get version() { return ensureResolved().version; },
  get how() { return ensureResolved().how; },
  get exe() { return ensureResolved().exe; },

  // Run a hermes subcommand. `args` is an ARRAY — execFile, not exec, so a space in
  // "Claude Outputs" or a task id never needs shell quoting.
  //
  // Returns { ok, out, error, reason }. Never throws.
  //   ok:true              hermes ran and exited 0; `out` is its stdout, possibly empty
  //   ok:false 'no-hermes'  hermes could not be found at all
  //   ok:false 'failed'    hermes ran and exited non-zero; `error` carries the first stderr line
  //
  // SYNCHRONOUS — blocks the Node event loop for the whole subprocess lifetime (measured
  // 1.7-8s per call live). Do not call this from a request handler; use `runAsync` below.
  // Kept only for any non-request-path caller that genuinely needs a blocking call.
  run(args, opts = {}) {
    const resolved = ensureResolved();
    if (!resolved.exe) {
      return { ok: false, out: '', reason: 'no-hermes', error: 'hermes executable not found' };
    }
    try {
      const out = execFileSync(resolved.exe, args, {
        cwd: opts.cwd,
        encoding: 'utf8',
        timeout: opts.timeout || 8000,
        maxBuffer: opts.maxBuffer || 2 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { ok: true, out: String(out), reason: null, error: null };
    } catch (e) {
      const stderr = String(e.stderr || e.message || '').split('\n')[0].slice(0, 200);
      return { ok: false, out: '', reason: 'failed', error: stderr };
    }
  },

  // Non-blocking twin of `run`, same args/return shape (as a resolved value, never a
  // rejection — callers already branch on `.ok`, this keeps that contract identical).
  // THIS is what request handlers must call: it frees the event loop while the hermes
  // subprocess runs, so one slow `hermes kanban show` cannot stall every other route and
  // every other browser tab on the server, which is what execFileSync was doing (see
  // the ASYNC header comment above).
  //
  // Default timeout is 25s, not 8s (t_137df3fc): measured live, this box runs many
  // concurrent Hermes profile agents and a single `hermes kanban list` call was seen
  // taking 50-59s under that load, well past 8s, on calls that were NOT stuck — they
  // finished and returned real data seconds later. Since runAsync no longer blocks the
  // event loop, a longer timeout costs nothing but wall-clock time on the one request
  // waiting on it; the old 8s value was tuned for a synchronous call that had to be kept
  // short to protect the whole server, a constraint that no longer applies. A genuinely
  // hung hermes process still gets killed at 25s rather than waiting forever.
  async runAsync(args, opts = {}) {
    const resolved = ensureResolved();
    if (!resolved.exe) {
      return { ok: false, out: '', reason: 'no-hermes', error: 'hermes executable not found' };
    }
    try {
      const { stdout } = await execFileAsync(resolved.exe, args, {
        cwd: opts.cwd,
        encoding: 'utf8',
        timeout: opts.timeout || 25000,
        maxBuffer: opts.maxBuffer || 2 * 1024 * 1024,
      });
      return { ok: true, out: String(stdout), reason: null, error: null };
    } catch (e) {
      const stderr = String(e.stderr || e.message || '').split('\n')[0].slice(0, 200);
      return { ok: false, out: '', reason: 'failed', error: stderr };
    }
  },
};

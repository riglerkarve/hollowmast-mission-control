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

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function resolveHermes() {
  const candidates = [];
  if (process.env.HERMES_EXE) candidates.push(process.env.HERMES_EXE);

  if (process.env.LOCALAPPDATA) {
    candidates.push(path.join(process.env.LOCALAPPDATA, 'hermes', 'hermes-agent', 'venv', 'Scripts', 'hermes.exe'));
  }

  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return { exe: c, how: 'absolute path' };
    } catch { /* an unreadable candidate is simply not the one */ }
  }

  try {
    execFileSync('hermes', ['--version'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] });
    return { exe: 'hermes', how: 'PATH' };
  } catch {
    return { exe: null, how: null };
  }
}

const resolved = resolveHermes();

let version = null;
if (resolved.exe) {
  try {
    version = execFileSync(resolved.exe, ['--version'], {
      encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (e) {
    resolved.exe = null;
    resolved.how = null;
  }
}

const available = !!resolved.exe;

// Run a hermes subcommand. `args` is an ARRAY — execFile, not exec, so a space in
// "Claude Outputs" or a task id never needs shell quoting.
//
// Returns { ok, out, error, reason }. Never throws.
//   ok:true              hermes ran and exited 0; `out` is its stdout, possibly empty
//   ok:false 'no-hermes'  hermes could not be found at all
//   ok:false 'failed'    hermes ran and exited non-zero; `error` carries the first stderr line
function run(args, opts = {}) {
  if (!available) {
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
}

module.exports = {
  available,
  version,
  how: resolved.how,
  exe: resolved.exe,
  run,
};

'use strict';
//
// git.js — ONE OWNER for "where is git, and did it actually run".
//
// WHY THIS EXISTS. Six route files shell out to `git log` (git-heatmap, hollowmast,
// launch-readiness, projects, ventures, workspace). Every one of them ran it as the bare
// word `git` through execSync, which on Windows goes via cmd.exe — and cmd.exe exits **1**
// for a command it cannot find. `git` is on PATH in a developer shell and is NOT on PATH for
// the MissionControl-Server scheduled task, so on the running service every one of those
// calls failed, and each caller's catch block turned that failure into "no commits" or a
// zero. Measured 23 Aug 2026 under the task's PATH:
//
//     'git' is not recognized as an internal or external command   ->   e.status === 1
//
// That is the same defect, from the same cause, as the `grep` shell-out in search.js: a
// tool that exists on the developer's PATH and not on the service's, failing with the exact
// status the code reads as "nothing found". The unrecorded variable is PATH, which is why
// it never reproduced for anyone testing locally.
//
// WHAT THIS MODULE GUARANTEES, and it is deliberately only two things:
//
//   1. `git` is invoked by ABSOLUTE PATH wherever one can be found, so the dev shell and the
//      service cannot disagree about whether git exists.
//   2. A caller can always tell "git ran and the answer was empty" from "git could not be
//      run at all". `run()` never throws and never returns a bare empty string for a
//      failure — absence and failure are different return shapes, not the same one.
//
// It does NOT interpret git output. Each caller still parses what it asked for; a shared
// parser would be a second owner for every figure derived from it.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// Candidate locations, in order. `GIT_EXE` first so the machine can override without a code
// change; then the standard Windows install paths; then the bare name, which works whenever
// PATH does happen to carry it (a developer shell, or a future fixed service environment).
function resolveGit() {
  const candidates = [];
  if (process.env.GIT_EXE) candidates.push(process.env.GIT_EXE);

  const programFiles = [
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs'),
  ].filter(Boolean);
  for (const base of programFiles) {
    candidates.push(path.join(base, 'Git', 'cmd', 'git.exe'));
    candidates.push(path.join(base, 'Git', 'bin', 'git.exe'));
  }

  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return { exe: c, how: 'absolute path' };
    } catch { /* an unreadable candidate is simply not the one */ }
  }

  // Last resort: the bare name. Probed rather than assumed — a name that cannot run is not
  // a resolution, and recording it as one is how this failed in the first place.
  try {
    execFileSync('git', ['--version'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] });
    return { exe: 'git', how: 'PATH' };
  } catch {
    return { exe: null, how: null };
  }
}

const resolved = resolveGit();

// Confirm the resolved binary actually answers. A path that exists is not the same as a
// working executable, and "found it" is a claim that should survive being tested.
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

// Run a git command. `args` is an ARRAY — execFile, not exec, so there is no shell and
// therefore no quoting to get wrong on a path containing a space. "Claude Outputs" contains
// one, and every cwd passed here sits under it.
//
// Returns { ok, out, error, reason }. It never throws.
//   ok:true            git ran and exited 0; `out` is its stdout, possibly empty
//   ok:false 'no-git'  git could not be found at all
//   ok:false 'failed'  git ran and exited non-zero; `error` carries the first stderr line
//
// An empty repository exits non-zero on `git log`, which is a real empty history rather than
// a fault. Callers that care are given `reason` and the stderr text to decide; this module
// does not guess on their behalf.
function run(args, opts = {}) {
  if (!available) {
    return { ok: false, out: '', reason: 'no-git', error: 'git executable not found' };
  }
  try {
    const out = execFileSync(resolved.exe, args, {
      cwd: opts.cwd,
      encoding: 'utf8',
      timeout: opts.timeout || 5000,
      maxBuffer: opts.maxBuffer || 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, out: String(out), reason: null, error: null };
  } catch (e) {
    const stderr = String(e.stderr || e.message || '').split('\n')[0].slice(0, 200);
    return { ok: false, out: '', reason: 'failed', error: stderr };
  }
}

// True when the directory is a working tree with at least one commit. Used by callers that
// want to distinguish "not a repo" from "empty repo" without parsing stderr themselves.
function hasCommits(cwd) {
  return run(['rev-parse', '--verify', 'HEAD'], { cwd }).ok;
}

module.exports = {
  available,
  version,
  how: resolved.how,
  exe: resolved.exe,
  run,
  hasCommits,
};

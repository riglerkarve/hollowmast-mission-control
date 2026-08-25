'use strict';
//
// account-usage.js — the model/usage percentage the owner asked to see on every page.
//
// ONE OWNER FOR THIS FIGURE: Hermes's own `agent/account_usage.py` (the same module the
// CLI's `/status` screen calls). This route does not compute a percentage of its own — it
// shells out to the venv Python and reads back what Hermes itself already knows about the
// Anthropic OAuth account (session + weekly utilisation). Inventing a second tracker here
// (counting tokens from kanban run rows, say) would violate the module contract's "one
// owner per figure" rule the moment it drifted from Hermes's own number by a single point.
//
// FAILS OPEN, and says which failure it hit. `state` is one of:
//   'ok'            — got real windows back, at least one has a usedPercent
//   'unavailable'   — venv/python resolved but Hermes reported no usable window (e.g. not
//                      an OAuth-backed account) — a known, named absence, not a crash
//   'could-not-look'— the subprocess itself failed (venv missing, timeout, bad JSON) — this
//                      must never be presented as "0% used", the two are opposite facts
//
// CACHED for a few minutes: this now polls on every panel load across the whole shell, and
// the fetch itself calls out to Anthropic's own usage API — an unthrottled version of this
// would turn "show it everywhere" into "hit the network everywhere". See t_38e3b61b's
// diagnosis: the infra scare tonight was NOT a reason to skip this, but it IS a reason to
// keep the polling interval real; a 3-minute cache does that without the client needing to
// know or agree on an interval — every tab shares one cache.
const express = require('express');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const execFileAsync = promisify(execFile);
const router = express.Router();

const CACHE_MS = 3 * 60 * 1000; // a plain number refreshed every few minutes, not real-time
const AGENT_ROOT = path.join(os.homedir(), 'AppData', 'Local', 'hermes', 'hermes-agent');

function pythonExe() {
  const venv = path.join(AGENT_ROOT, 'venv', 'Scripts', 'python.exe');
  if (fs.existsSync(venv)) return venv;
  return 'python';
}

// Printed by the child process as one JSON line — the module contract's own dataclasses,
// re-serialised rather than re-derived, so nothing here duplicates account_usage.py's logic.
const PROBE_SCRIPT = [
  'import json, sys',
  `sys.path.insert(0, ${JSON.stringify(AGENT_ROOT)})`,
  'try:',
  '    from agent.account_usage import fetch_account_usage',
  '    snap = fetch_account_usage("anthropic")',
  'except Exception as e:',
  '    print(json.dumps({"ok": False, "error": str(e)}))',
  '    sys.exit(0)',
  'if snap is None:',
  '    print(json.dumps({"ok": True, "windows": [], "unavailableReason": None}))',
  '    sys.exit(0)',
  'windows = [',
  '    {"label": w.label, "usedPercent": w.used_percent,',
  '     "resetAt": w.reset_at.isoformat() if w.reset_at else None}',
  '    for w in snap.windows',
  ']',
  'print(json.dumps({"ok": True, "windows": windows, "unavailableReason": snap.unavailable_reason}))',
].join('\n');

let cache = { at: 0, body: null };
// A probe in flight, so N concurrent requests during a cold start share ONE subprocess
// instead of each spawning their own -- this route is now hit from every open tab.
let inFlight = null;

function startProbe() {
  if (!inFlight) {
    inFlight = probe().finally(() => { inFlight = null; });
  }
  return inFlight;
}

async function probe() {
  const py = pythonExe();
  try {
    // Measured live: a cold venv Python interpreter importing Hermes's agent package plus
    // the network round-trip to Anthropic's usage API took ~90s once. 45s covers a normal
    // run with room; a genuinely stuck call still gets killed rather than hanging the
    // request forever. This only costs anything once per CACHE_MS window.
    const { stdout } = await execFileAsync(py, ['-c', PROBE_SCRIPT], {
      timeout: 45000, maxBuffer: 1024 * 1024,
    });
    const parsed = JSON.parse(String(stdout).trim().split('\n').pop());
    let body;
    if (!parsed.ok) {
      body = { state: 'could-not-look', why: parsed.error || 'unknown error', fetchedAt: new Date().toISOString() };
    } else if (parsed.unavailableReason) {
      body = { state: 'unavailable', why: parsed.unavailableReason, fetchedAt: new Date().toISOString() };
    } else {
      const windows = (parsed.windows || []).filter((w) => w.usedPercent != null);
      body = windows.length
        ? { state: 'ok', windows, fetchedAt: new Date().toISOString() }
        : { state: 'unavailable', why: 'Hermes reported no usage window for this account.', fetchedAt: new Date().toISOString() };
    }
    // Only cache a real answer or a named absence — never cache a could-not-look, so a
    // transient hiccup clears itself on the next poll rather than sitting stale for 3 minutes.
    if (body.state !== 'could-not-look') cache = { at: Date.now(), body };
    return body;
  } catch (e) {
    return { state: 'could-not-look', why: String(e.message || e).slice(0, 200), fetchedAt: new Date().toISOString() };
  }
}

router.get('/', async (req, res) => {
  const now = Date.now();
  if (cache.body && now - cache.at < CACHE_MS) {
    return res.json({ ...cache.body, cached: true });
  }
  // First hit (or a stale cache): if a probe is already running for another tab, ride it
  // rather than spawning a second Python process for the same answer. If none is running,
  // start one — either way the request waits for THIS probe's result, since the badge has
  // nothing better to show yet and 45s worst-case only happens once per cache window.
  const body = await startProbe();
  res.json({ ...body, cached: false });
});

module.exports = router;

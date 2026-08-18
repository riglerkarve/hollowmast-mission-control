#!/usr/bin/env node
//
// restart.cjs — restart Mission Control and PROVE it came back.
//
//   node tools/restart.cjs
//
// Backlog #16, "automate anything I keep repeating", whose own rationale says: log what
// actually repeats, then automate the top three — automating a guess is how you get a surface
// to feed. So this was measured rather than chosen. On 18 Aug 2026 alone,
// logs/server-2026-08-18.log recorded "Dashboard running" **53 times**. Every route change
// needs it, and the manual form is five steps in two different shells.
//
// THE FIVE STEPS IT REPLACES, and each is here because doing it by hand got it wrong:
//   1. read the PID currently holding :3000
//   2. stop that process — NOT `schtasks /end`, which reports SUCCESS, sets the task Ready,
//      and leaves node holding the port. Verified on this machine, twice.
//   3. start MissionControl-Server
//   4. wait — the task returns immediately and the server takes several seconds. A check run
//      too early reports failure on a service that is simply still booting, which happened
//      today and cost two extra round trips.
//   5. confirm by TWO independent facts: a DIFFERENT pid is listening, and /api/status
//      actually answers. Never by an exit code — see the whole of ARCHITECTURE.md on why.
//
// It exits non-zero if the server does not come back, so a caller cannot mistake a dead
// service for a restarted one.
'use strict';

const { execFileSync } = require('node:child_process');
const TASK = 'MissionControl-Server';
const PORT = 3000;
const URL = `http://127.0.0.1:${PORT}/api/status`;

const ps = (cmd) => {
  try {
    return execFileSync('powershell.exe', ['-NoProfile', '-Command', cmd], { encoding: 'utf8' }).trim();
  } catch { return ''; }
};

const pidOnPort = () => {
  const out = ps(`(Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction SilentlyContinue `
    + '| Select-Object -First 1).OwningProcess');
  return out ? Number(out) : null;
};

async function status() {
  try {
    const r = await fetch(URL, { signal: AbortSignal.timeout(4000) });
    return { code: r.status, body: await r.json().catch(() => null) };
  } catch (err) { return { code: null, err: String(err.name) }; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const before = pidOnPort();
  console.log(`  pid on :${PORT} before: ${before == null ? '(nothing listening)' : before}`);

  if (before) {
    ps(`Get-Process -Id ${before} -ErrorAction SilentlyContinue | Stop-Process -Force`);
    await sleep(800);
    const still = pidOnPort();
    if (still === before) {
      console.error(`  FAILED to stop pid ${before} — it is still holding the port. Nothing was restarted.`);
      process.exit(1);
    }
  }

  ps(`Start-ScheduledTask -TaskName "${TASK}"`);

  // Poll rather than sleeping a fixed amount: the boot time varies with what the migrations
  // have to do, and a fixed wait is either too short (false failure) or wasted.
  const deadline = Date.now() + 45000;
  let after = null, st = null;
  while (Date.now() < deadline) {
    await sleep(1200);
    after = pidOnPort();
    if (!after || after === before) continue;
    st = await status();
    if (st.code === 200) break;
  }

  if (!after || st == null || st.code !== 200) {
    console.error(`  DID NOT COME BACK within 45s. pid=${after || 'none'} status=${st ? st.code || st.err : 'never asked'}`);
    console.error('  Check logs/server-<date>.log — the last line will name the migration or port problem.');
    process.exit(1);
  }

  const up = st.body && st.body.startedAt ? ` startedAt ${st.body.startedAt}` : '';
  console.log(`  pid on :${PORT} after:  ${after}${before ? `  (was ${before})` : ''}`);
  console.log(`  ${URL} -> ${st.code}${up}`);
  console.log('  restarted, and both facts checked: the pid moved AND the service answered.');
})();

# BUILT

- Completed M77: added `scripts/restart-lock.cjs`, an inter-process restart lock shared by `tools/restart.cjs` and `scripts/watchdog.cjs`.
- Both restart paths now hold the lock from before any stop action through the replacement server's health check. A competing manual restart exits without stopping anything; the watchdog defers instead of overlapping it.
- Added `tools/verify-restart-lock.cjs`, a scheduler-free contention and stale-lock recovery test.

# VERIFIED

- `node tools/verify-restart-lock.cjs` passed: a second process was denied while held, the released lock could be acquired, and a dead holder was reclaimed.
- `node --check` passed for all four affected scripts and `git diff --check` passed.
- `node scripts/watchdog.cjs --dry` reached the live status endpoint and reported it healthy without scheduling a restart or alert.

# RISKS

- The dry watchdog run logged `WARN could not write state: EPERM` for `data/watchdog-state.json.tmp`; the status check itself passed. Investigate the current file lock/permissions if watchdog state persistence continues to fail.
- The lock implementation relies on an atomic NTFS hard-link in the same `data` directory; the test passed on this machine.

# NEXT

- Commit only M77 files once the Claude-provided Git wrapper/permission is available: `scripts/restart-lock.cjs`, `scripts/watchdog.cjs`, `tools/restart.cjs`, and `tools/verify-restart-lock.cjs`.
- Continue the panel API-state sweep with tier 1 finance, budget, safety, and income.

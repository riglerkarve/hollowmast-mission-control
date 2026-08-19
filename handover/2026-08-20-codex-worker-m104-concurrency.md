# Codex Worker — M104 concurrency surface audit

## Built

- Added `tools/concurrency-surface-audit.cjs`, a bounded, source-only audit of shared process outputs. It reports observed source evidence separately from unproven race candidates; it neither starts processes nor opens a database.
- Registered the new audit as a safe, no-database check in `tools/verify-suite.cjs` and updated `baselines/verification-suite.json`.

## Verified

- `node --check tools/concurrency-surface-audit.cjs` and `node --check tools/verify-suite.cjs` exited 0.
- `node tools/concurrency-surface-audit.cjs` exited 0: 1 guarded surface (`data/restart.lock`), 7 candidate surfaces, and 0 source markers missing. Candidates are `heartbeat.json`, `watchdog-state.json`, the handover spool, the daily briefing, generated Brain files, endpoint baseline writing, and the archive manifest.
- `node tools/verify-suite.cjs` exited 0: `10 safe pass; 0 safe fail; 14 manual; 0 unclassified; baseline matches.` The automatic database checks named and cleaned their own temporary paths, including `C:\Users\jcwhi\AppData\Local\Temp\mission-control-route-failure-NliA5A`; this M104 audit opened no database and never wrote `data/dashboard.db`.

## Blocked

- The audit intentionally does not reproduce concurrency against live paths. A candidate is not a defect until a contained reproduction uses isolated temporary paths. M106's database-concurrency exercise remains outside this block under the standing instruction not to run concurrent database writes.
- M105 remains blocked by the previously recorded absent pre-commit hook; this block did not alter that prerequisite.

## Candidates

- Temp-then-rename protects readers but does not provide writer ownership: `server/heartbeat.js` and `scripts/watchdog.cjs` each use a fixed `.tmp` output.
- `scripts/briefing.cjs`, `server/routes/brain.js`, `tools/handover.cjs`, `tools/endpoint-shapes.cjs`, and `tools/archive.cjs` each publish a shared output without a process-level ownership guard visible in their respective source.
- These are deliberately leads, not filed defects: source inspection cannot establish Task Scheduler overlap, filesystem append semantics, or multi-process SQLite behaviour.

## Blocked on you


## Next

- Do not reproduce the listed candidates on shared live resources. The remaining Batch G work is constrained by the existing M105 hook absence and the instruction to avoid concurrent database writes.

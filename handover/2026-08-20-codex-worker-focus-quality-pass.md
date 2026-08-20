# Codex Worker — Focus quality pass

## Built

- Added 25-, 50-, and 90-minute Focus intervals. The selected interval is locked while running and the completed record carries that actual configured interval.
- Changed Skip so it abandons the interval and changes mode without recording a completed work session. This removes the prior false-full-session path.
- Captured the selected backlog item when a timer starts; later clicks cannot redirect a running timer's final record.
- Made the historical-link repair list include every canonical backlog item, including done or declined work, because older time can honestly belong to completed work.
- Added a planning table for every canonical project, not only projects that already have linked Focus time. It shows weekly targets and selected-window actual/plan arithmetic.
- Fixed stale active-presence renewal: a heartbeat after the 90-second expiry gets a new `started_at`, rather than reviving an old session as though it never ended.

## Verified

- `node --check` passed for `server/routes/sessions.js`, `public/panels/focus/focus.js`, and `tools/verify-focus-ledger-features.cjs`; `node tools/verify-panel.cjs focus` passed (63 static classes, 11 defined tokens, no unstyled hooks).
- `git diff --check` passed for all changed files.
- `node tools/verify-focus-ledger-features.cjs` passed on the named temporary database `C:\Users\jcwhi\AppData\Local\Temp\mission-control-focus-ledger-24Xgjx\dashboard.db`. It exercised explicit and immutable links, project targets and known projects, stale/live presence, coverage, drill-down, and CSV. No test wrote `data/dashboard.db`.
- Guarded deployment moved the live server PID from 38896 to 41140 and `/api/status` returned 200.
- Read-only live API checks returned five canonical projects to both the ledger and target endpoint, 0/13 project-evidenced historical sessions, zero live heartbeats with an explicit absence message, and the CSV header for the 7-day allocation report.
- Committed exactly `server/routes/sessions.js`, `public/panels/focus/focus.js`, `public/panels/focus/focus.css`, and `tools/verify-focus-ledger-features.cjs` as `ee2c6c2` through `tools/codex-run.cjs`.

## Blocked

- The historical record still has no direct project links (0/13). The repair control is now capable of selecting every canonical item but cannot know which one is correct without evidence.

## Deviations

- No automatic linking, model-time split, or inferred duration was added. Those would make the module look more complete while lowering its evidential quality.

## Blocked on you

- None.

## Next

- As sessions acquire direct item links, set a weekly target for the relevant project and use its actual/plan row and CSV during the weekly review.

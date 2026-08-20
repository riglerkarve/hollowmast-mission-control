# Codex Worker — Focus time ledger

## Built

- Reframed Focus as a time ledger rather than only a Pomodoro timer.
- Added `GET /api/sessions/ledger?days=30`, which separates work time by contributor, exact telemetry model where unambiguous, and linked project.
- Added `focus_sessions.model`, populated only from a one-model telemetry session; mixed or missing model telemetry remains null rather than being allocated from tokens or cost.
- Added `codex` and `ollama` provenance values, and changed owner-facing Focus writes to send `X-MC-By: you` so future browser sessions no longer fall into `unknown`.
- Updated all owner focus statistics to exclude every known model actor (`claude`, `codex`, `ollama`, `scribe`), not only Claude.

## Verified

- `node tools/migrate-from-zero.cjs` passed, applying `sessions@v4` to the named temporary database `C:\Users\jcwhi\AppData\Local\Temp\mission-control-migrate-zero-6SoZCE\dashboard.db`. Its output states that the live `data/dashboard.db` was not opened.
- `node --check` passed for every changed JavaScript file and `node tools/verify-panel.cjs focus` passed (44 static classes, 11 defined tokens, no unstyled hooks).
- The guarded restart changed the live server PID from 21056 to 27932 and `/api/status` returned 200.
- The real telemetry import completed deterministically: 12 Claude rows remained 12, now totalling 4,684 active minutes; the owner-session count remained 1.
- The live ledger and browser rendering show: 8 mixed/unspecified Claude sessions (75h 16m), 2 `claude-sonnet-5` sessions (1h 39m), 2 `claude-opus-5` sessions (1h 9m), and one 25-minute unattributed row. The UI reported no console errors.

## Blocked

- There are currently no work sessions linked to a backlog item, so the ledger correctly reports no project allocation. It reports 78h 29m as unlinked rather than inventing a project split. Future Focus sessions selected from the backlog will create that evidence.

## Deviations

- No test wrote `data/dashboard.db`. The later telemetry importer was a requested production backfill, not a test; it updated existing Claude session rows from the parser's own telemetry.

## Blocked on you

- None.

## Next

- Add deterministic project evidence to model telemetry only if the source records a session-to-project link; do not infer it from token, cost, or file-touch proportions.

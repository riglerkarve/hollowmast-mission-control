# Codex Worker — Focus ledger views

## Built

- Added a 7-, 30-, and 90-day selector to the Focus time ledger.
- Added contributor timeline lanes, project trend lanes, a precise model-evidence table, and a queue of work sessions that have no direct project evidence.
- Extended `GET /api/sessions/ledger` with daily contributor/project totals, exact-model aggregates, and the unlinked-session records required for those views.
- Kept project allocation evidence-only: the queue identifies records needing a direct backlog or telemetry link and offers no inferred assignment.

## Verified

- `node --check server/routes/sessions.js` and `node --check public/panels/focus/focus.js` passed.
- `node tools/verify-panel.cjs focus` passed: 50 static classes, 11 defined tokens, and no unstyled selector hooks. Its API probe limitation remains: it does not recognise the shared `api()` helper.
- `git diff --check` passed for the three changed files.
- The guarded restart changed the live server PID from 27932 to 34892; `/api/status` returned 200.
- Read-only live ledger checks returned the new fields for every selector range: 7 days (2 actors, 3 contributor-day rows, 1 model, 7 unlinked records); 30 days (4 actors, 9 contributor-day rows, 2 models, 13 unlinked records); and 90 days (the same currently recorded set). No test wrote `data/dashboard.db`.
- Committed exactly `server/routes/sessions.js`, `public/panels/focus/focus.js`, and `public/panels/focus/focus.css` as `47ea6ff` through `tools/codex-run.cjs`.

## Blocked

- The current recorded model telemetry has no `todo_id` evidence, so live project and project-day totals are empty. The project-trend interface will populate only when a session is directly linked to a backlog item; it must not be backfilled by inference.

## Deviations

- No temporary database was needed in this view-only/API-read block. The earlier schema migration verification used the named temporary path documented in the preceding Focus time-ledger handover.

## Blocked on you

- None.

## Next

- When a source can record a direct session-to-project relationship, persist that link to `focus_sessions.todo_id` and re-run the ledger read checks. Do not derive it from model, token, cost, file, or time proportions.

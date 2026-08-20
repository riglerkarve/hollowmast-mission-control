# Codex Worker — Focus evidence and presence

## Built

- Added an explicit contributor selector to the Focus timer. A selected contributor is recorded on the completed session; exact model identity and USD cost remain telemetry-only facts.
- Preserved the item selected when a timer starts, so changing the backlog after start cannot redirect its final record.
- Added a visible manual-link inbox for unlinked historical sessions. A user must select a real backlog item; the route stores `manual`, who linked it, and when. It refuses to overwrite an existing direct link.
- Added weekly per-project Focus targets, evidence coverage (project, contributor, exact model, source cost), clickable contributor/project timeline bars, exact-session drill-down, and allocation CSV export.
- Added live Focus presence. Running timers send a 60-second heartbeat, presence expires after 90 seconds, and an unavailable read visibly differs from no active contributor.
- Added source-recorded micro-USD costs to derived Claude Focus rows and a repeatable temp-database verifier at `tools/verify-focus-ledger-features.cjs`.

## Verified

- `node --check` passed for the route, importer, Focus panel, and the new verifier; `node tools/verify-panel.cjs focus` passed with 61 static classes, 11 defined tokens, and no unstyled hooks.
- `git diff --check` passed for every changed source file.
- `node tools/migrate-from-zero.cjs` passed with `sessions@v6` on the named temporary database `C:\Users\jcwhi\AppData\Local\Temp\mission-control-migrate-zero-LVBII4\dashboard.db`; it stated that live `data/dashboard.db` was not opened. (The subsequent presence migration is exercised by the feature verifier.)
- `node tools/verify-focus-ledger-features.cjs` passed on the named temporary database `C:\Users\jcwhi\AppData\Local\Temp\mission-control-focus-ledger-wZJsBO\dashboard.db`: it proved session creation, manual evidence linking, refusal to overwrite a link, targets, live presence, coverage, drill-down, and CSV output. No test wrote `data/dashboard.db`.
- The final guarded restart moved the live server PID from 34908 to 38896 and `/api/status` returned 200.
- The requested production telemetry backfill updated 12 existing derived Claude rows with exact source-recorded costs; it remained 12 rows / 4,684 active minutes and left the owner-session count at 1.
- Live read-only checks now report 13 sessions in 30 days: 0/13 project evidence, 12/13 contributor evidence, 4/13 exact-model evidence, and 12/13 source-cost evidence. Live presence correctly returned zero active contributors with the explicit 90-second-heartbeat absence message. The 7-day allocation CSV returned its header plus two current data rows.
- Committed exactly the route, importer, verifier, and Focus JavaScript/CSS as `b687440` through `tools/codex-run.cjs`.

## Blocked

- There are still no historical sessions with direct project evidence. The new manual-link inbox exposes this gap but does not repair it automatically; assigning the current 13 sessions needs someone who knows their actual backlog relationship.

## Deviations

- The allocation report ships as CSV. A PDF was not added because this no-dependency dashboard has no report renderer, and inventing one would add a second report surface rather than improve the evidence record.

## Blocked on you

- None.

## Next

- Use the manual-link inbox only when the selected backlog item is known. Once linked sessions exist, set weekly project targets on their project rows and use the CSV for weekly review.

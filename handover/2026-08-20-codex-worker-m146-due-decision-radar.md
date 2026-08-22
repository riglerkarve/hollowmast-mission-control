# Codex Worker — M146 due-decision radar

## Built

- Added one canonical `dueDecisions()` derivation to the Team route. It returns an explicit
  `due` or `none-due` state, today's local date, due decision rows, and the residue that cannot
  be truthfully called due: undated, future, malformed, and superseded decisions.
- Added `GET /api/team/decisions?due=1` and included the same result in `team.reportFor()`.
  Existing `GET /api/team/decisions` remains compatible and now adds `state: "ok"`.
- Validated new `recheck_at` values as real `YYYY-MM-DD` calendar dates.
- Made `tools/shift-report.cjs` render a "Decisions due for recheck" section from that one
  derivation, including an explicit no-due result rather than a silent blank.
- Recorded the explicit date already stated in decision #27's condition: `recheck_at` is now
  `2026-08-23`. This was a product-data correction, not test data; the temporary Codex-manager
  decision will therefore be visible as a future recheck until Sunday and due on Sunday.

## Verified

- `node tools/verify-team-due-decisions.cjs` passed direct derivation, report-contract, HTTP
  endpoint, invalid-date rejection, and rendered shift-report assertions.
- The verifier used and removed:
  `C:\Users\jcwhi\AppData\Local\Temp\mc-team-due-decisions-KyVZ2N`.
  It never opened or wrote `data/dashboard.db`.
- `git diff --check -- server/routes/team.js tools/shift-report.cjs
  tools/verify-team-due-decisions.cjs` passed.

## Deliberate boundary

- Did not edit `server/routes/briefing.js` or `public/panels/team/team.js`: both were already
  dirty in another session. The shared report/API contract now gives those consumers a single,
  ready input once their active work is committed.

## Next

- Display `report.decisionsDue` in the briefing card and Team panel when their current changes
  are settled; do not reimplement date parsing in either consumer.

## Blocked on you

- None.

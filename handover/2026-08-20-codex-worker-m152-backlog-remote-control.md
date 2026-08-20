# Codex Worker — M152 Backlog Remote Control

## Built

Extended the existing Backlog panel; no second task store or dependency was added.

- Each existing task now has labeled **Priority** and **Assign to** controls.
- Assignment choices are the closed set `DET`, `LOC`, `FRO`, `DET+LOC`, `CODEX`, and `YOU`.
- `CODEX` is now accepted consistently by both task creation and reassignment; it was already present on 13 live rows but had not been part of the create vocabulary.
- Existing reassignment uses `PATCH /api/todo/items/:id`, so the route preserves the old owner as an append-only `todo_notes` entry, then the panel reloads its derived actionable queue.
- The route now rejects unknown owner values on PATCH rather than accepting a typo that no agent can ever see.

Changed paths:

- `server/routes/todo.js`
- `public/panels/todo/todo.js`
- `public/panels/todo/todo.css`
- `tools/verify-todo-remote-control.cjs`

## Verified

```powershell
node tools/verify-todo-remote-control.cjs
node --check server/routes/todo.js
node --check public/panels/todo/todo.js
git diff --check
```

The verifier passed:

```
REMOTE CONTROL: PASS
TEMP_DB=C:\Users\jcwhi\AppData\Local\Temp\mc-todo-remote-control-TTcGxD\dashboard.db
LIVE_DB=data/dashboard.db was never opened by this verifier.
Checked: CODEX assignment, LOC reassignment, unknown-owner refusal, append-only owner history.
```

The temporary directory reported above was removed by the verifier after it closed its isolated SQLite connection. An earlier verifier directory from a harness-only cleanup failure was also removed after its exact temporary path was checked.

The live server was restarted through `node tools/restart.cjs`; its PID changed and `/api/status` returned 200. Browser inspection of the running Focus-embedded Backlog showed the visible `Priority` and `Assign to` controls for live task rows.

M152 is marked done with board note `todo_notes` #213.

## Deviations

The first isolated verifier run failed only because its minimal Express app omitted the production `req.by` attribution middleware; Todo correctly refused the unattributed audit-note write with HTTP 500. The verifier now installs the same request attribution before mounting the route, then passes. No production source defect was found by that failure.

## Blocked

None.

## Blocked on you

None.

## Next

Use the Backlog's controls as the one place to reprioritise and move work between agents. The separate M147 per-venture safety-gap design remains deliberately unstarted after its verification finding; it requires a scoped architecture decision before implementation.

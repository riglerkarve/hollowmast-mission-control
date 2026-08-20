# Codex Worker — M116 kind provenance

## Built

- Added todo schema migration v6: append-only `todo_kind_log(todo_item_id, kind, source, model, at)` with valid kind/source constraints and an item/time index.
- `tools/ollama-shift.cjs` now writes one provenance row in the same transaction as every successful `todo_items.kind` update. Deterministic-rule rows record `source = rule` and `model = NULL`; model rows record `source = model` plus the configured model name.
- Added `node tools/ollama-shift.cjs --verify-kind-log`, which launches a child only with a unique temporary database and refuses the live database.

## Verified

- `node --check tools/ollama-shift.cjs`
- `node --check server/routes/todo.js`
- `node tools/ollama-shift.cjs --verify-kind-log` passed. It migrated the temporary database through todo v6, confirmed exactly one log row for each successful rule/model update, and confirmed a guarded no-op creates no row. Temporary path: `C:\Users\jcwhi\AppData\Local\Temp\mission-control-kind-log-abgrks\dashboard.db` (removed by the verifier after completion).
- `git diff --check -- server/routes/todo.js tools/ollama-shift.cjs`
- No test opened or wrote `data/dashboard.db`.

## Blocked

- Nothing for M116. Batch H's separately recorded M109 scope block remains unresolved.

## Deviations

- Historical `kind` rows were not backfilled: their source cannot be recovered honestly.

## Blocked on you


## Next

- M117 is the next independent, currently open verification task; Batch H remains stopped until M109's intended health target is specified.

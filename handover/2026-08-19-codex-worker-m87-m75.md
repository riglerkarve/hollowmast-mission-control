# Codex Worker — M87 and M75 follow-up

## Built

- Added `tools/verify-ollama-shift.cjs`, a read-only deterministic audit of stored kind labels. It states the missing `kind_source` provenance instead of pretending the asserted 21 model-written rows can be identified.
- Added `CLOUD_DEFAULT` to `server/ollama.js`; `tools/ollama-shift.cjs` now takes both defaults from the shared client and contains no named default model.

## Verified

- `node tools/verify-ollama-shift.cjs` reports `MODEL DEFAULT: shared client only` and two untouched rule disagreements: M84 (`chore`/`question`) and M88 (`question`/`bug`).
- `node tools/codex-run.cjs --prompt "wrapper readiness check" --dry-run` verified M75’s wrapper path: it skipped the absent upstream, named five pre-existing dirty paths, and did not run Codex or commit.

## Blocked

- #16 is explicitly deferred until 1 September to collect the required two weeks of run-log evidence. No build work should start before then.

## Deviations

- Exact model-row provenance is absent from the current schema. The audit checks the broadest defensible scope and performs no updates.

## Blocked on you

- Nothing.

## Next

- Wrapper/supervisor should commit only Codex paths. Re-run the model-label audit after changes and revisit #16 on its recorded date.

# Codex Worker — M117 local Scribe bakeoff

## Measured

- Ran `node tools/model-bakeoff.cjs qwen3.5:4b qwen3:8b --ctx 8192` against the prescribed
  four gates: GPU fit, JSON schema, 12-item classification oracle, and inverted-evidence
  discrimination. This used only the local Ollama service and local task labels.
- `qwen3.5:4b`: fit and schema passed; classification was 12/12 but the script correctly
  labels that oracle as an upper bound because up to 21 historic labels may be model-written;
  the evidence-supporting half of discrimination returned no verdict. Result: one gate could
  not be measured, therefore not proven.
- `qwen3:8b` at 8192 context: fit, schema, and discrimination passed; classification was
  8/12 (0.67), below the required 0.8. Result: not proven.
- No capability was added to `scribe_capabilities`. That table remains empty by design;
  an inconclusive or failed gate is not permission to run a Scribe job.
- Marked M117 `in_progress` through the audited backlog PATCH route. It needs a different
  candidate model or a better independent oracle before a capability can honestly be proven.

## Fixed

- `tools/model-bakeoff.cjs` now prints `----` for a gate whose result is unavailable, instead
  of incorrectly printing `FAIL` while its own explanatory text says "COULD NOT LOOK".
- Exposed the small pure display helper only for verification; running the tool normally is
  unchanged and still performs no automatic capability write.

## Verified

- `node tools/verify-model-bakeoff-output.cjs` passed all four display states.
- `node --check tools/model-bakeoff.cjs` and `node --check
  tools/verify-model-bakeoff-output.cjs` passed, as did `git diff --check`.
- No test database was used: the verifier is pure and does not open a database. The bakeoff
  read the live local task oracle as a real capability measurement but did not write the live
  dashboard database.

## Blocked on you

- None.

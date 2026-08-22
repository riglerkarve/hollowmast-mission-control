# Codex Worker — verification batches M79–M86

## Built

- M79: `tools/migrate-from-zero.cjs` creates an isolated temporary database, loads every route module in `server/index.js` order, and reports migrations/tables. `server/db.js` now accepts the explicit `MC_DB_PATH` temporary database override.
- M80: `tools/restore-backup.cjs` restores the newest backup to a temporary directory and compares schema/table row counts with the live database using only read-only handles.
- M81: `tools/route-inventory.cjs` is shared by `routes-check.cjs` and `tools/endpoint-shapes.cjs`. The latter probes all registered GET routes and compares a deliberately generated committed names-and-types-only baseline at `baselines/endpoint-shapes.json`.
- M82: `tools/verify-checkers.cjs` proves the six trust checkers each fail on a known reversible defect and return clean after verified restoration. It redirects tool logging to a temporary database. During this proof, it found and fixed `tools/secrets-scan.cjs`: `--all` had omitted ordinary untracked files.
- M83: `tools/figure-ownership.cjs` compares duplicate dashboard figures while stating every comparison window.
- M84: `tools/tool-audit.cjs` crosswalks `tools/*.cjs` against `tool_runs` through a read-only database handle; absent instrumentation is explicitly `could not tell`, never `never run`.
- M85: `tools/verify-access-log-floor.cjs` proves the finance access log remains a floor using a direct read-only database handle and reports direct database readers.
- M86: `tools/verify-shift-report.cjs` independently recomputes all nine shift-report gap categories from `team_*` tables, then compares route kinds, counts, and identities. It was written before reading `reportFor()`.

## Verified

- `node tools/migrate-from-zero.cjs` passed: 33 route/module imports, 29 migrations, and 65 tables on a unique temporary database; the live database was not opened.
- `node tools/restore-backup.cjs` passed: newest backup restored to a unique temporary path, integrity check `ok`, comparison handles read-only.
- `node tools/endpoint-shapes.cjs` passed after deliberate baseline creation: 99 registered GET endpoints probed, no values written to the baseline.
- `node tools/verify-checkers.cjs` passed: provenance, routes, panel, memory index, link, and secret checks each failed on a planted defect and passed after restoration. The temporary tool database path is printed by the run.
- `node tools/figure-ownership.cjs` passed: current duplicate headroom, todo/board/schedule/finance totals, cash counts, income totals, and per-account latest balances agree under their printed windows.
- `node tools/tool-audit.cjs` read-only classification: 30 run recently, 20 instrumented but never run, 4 latest-run failures, 7 uninstrumented, 1 support module, 1 defining module.
- `node tools/verify-access-log-floor.cjs` passed: direct read of 6,839 finance rows left the logged counter unchanged at 5,763. Confirmed direct readers include `scripts/backup.js` and the intentionally read-only `tools/restore-backup.cjs`.
- `node tools/verify-shift-report.cjs` passed: all nine categories match exactly; current nonzero gaps are 23 unread and 27 distinct untriaged owner asks.
- All new/changed scripts passed `node --check`; repeated `git diff --check` passed.

## Blocked

- No commit made. The shared worktree contains concurrent changes; Codex’s Git-write sandbox limitation remains tracked as M75. The wrapper/supervisor should commit only the files listed above.

## Deviations

- M82 exposed a real defect in the secret scanner before it was accepted: `git ls-files -coi` acted as an ignored-file filter rather than a union. The scanner now unions ordinary untracked paths with ignored paths for `--all`.
- M86’s first independent attempt deliberately failed closed on two route kinds rather than assuming their meaning. After the independent result existed, `reportFor()` was read solely to align terminology; the final checker compares all nine documented predicates from base tables.

## Blocked on you

- Nothing.

## Next

- Continue with M87, then repeat the verification tools after any future route, checker, or team-report changes.

---

# Codex Worker — M87 and M75 follow-up

## Built

- M87: `tools/verify-ollama-shift.cjs` re-scores stored kind labels that a deterministic rule can classify, without calling a model or changing any row. It explicitly reports that `todo_items` has no `kind_source`, so the claimed 21 model-written rows cannot be isolated honestly.
- M87: `server/ollama.js` now owns `CLOUD_DEFAULT`, and `tools/ollama-shift.cjs` names neither a local nor cloud model default.

## Verified

- `node tools/verify-ollama-shift.cjs` opened the live database read-only. It found two disagreements, deliberately left untouched: M84 is stored as `chore` but matches the deterministic `question` rule; M88 is stored as `question` but matches `bug`.
- The same verifier confirms `MODEL DEFAULT: shared client only`.
- `node tools/codex-run.cjs --prompt "wrapper readiness check" --dry-run` passed M75’s non-mutating path: absent upstream was safely skipped; five already-dirty paths were named and excluded; no Codex process or commit ran.

## Blocked

- The remaining build-owned automation item #16 is explicitly deferred until 1 September for two weeks of run-log evidence. No implementation should start before that evidence window.

## Deviations

- M87 cannot re-score exactly the asserted 21 model-written rows: schema provenance is absent. The auditor checks the broadest defensible set and names the limitation instead of inventing a subset.

## Blocked on you

- Nothing.

## Next

- Have the wrapper/supervisor commit only Codex’s changed paths. Re-run `verify-ollama-shift` after any kind-label change and revisit #16 on its recorded date.

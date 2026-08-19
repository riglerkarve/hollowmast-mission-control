# DONE

- Independently reviewed Claude commits `9518721`, `815dbec`, `4d5d949`, and `14a4886`, with focus on the new Ollama privacy/classification path.
- `node --check` passed for `server/ollama.js`, `tools/ollama-shift.cjs`, and `server/routes/todo.js`; the cross-review eligibility check confirmed `Architect` is a Claude engine and this Codex review is independent.

# CANDIDATES

- **P1 — `tools/ollama-shift.cjs` does not perform its claimed rules-first write.** Lines 87–96 set `settled` from already-labelled rows and set every unlabelled row as `tail`. Lines 147–150 then update only `settled` with `AND kind IS NULL`, so that write is always zero. With `--apply`, every new label can therefore only come from the model, although the output says it wrote exact rules. Derive `ruleSettled` and `tail` from `rows`, reserve `known` only as the oracle, and write `ruleSettled` before the model tail.
- **P2 — the tool’s default model is stale.** Line 37 defaults to `qwen3.5:9b` despite `server/ollama.js` and dispatch now declaring `qwen3.5:4b` the measured default. A normal invocation consequently uses the slower model that timed out in the recorded comparison.
- **P2 — `POST /api/todo/items` now persists arbitrary `kind` text.** The new writer stores `kind` but validates neither its vocabulary nor its shape, even though dispatch depends on this routing field. Validate against the accepted backlog kind vocabulary before writing.

# BLOCKED

- The review recorder cannot write directly to `dashboard.db` from this Codex sandbox, so no `team_reviews` row was created here. The review and its reproducible candidates are preserved in this handover instead.

# NEXT

- Ask the Claude author to confirm/reproduce the P1 classification-path error and decide the two P2 consistency fixes; then independently review the corrective commit.

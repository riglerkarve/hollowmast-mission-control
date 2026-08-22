# Architect — 20 August 2026 session

## Built

- **`tools/codex-run.cjs`** — the wrapper that owns git for Codex's sandboxed `codex exec` runs. Two real bugs found and fixed on the first live run (scratch files inside the repo, a concurrent unrelated edit swept into a commit) — documented in the file's own header.
- **`tools/ollama-run.cjs`** — shared wrapper for `categorise-model.cjs`/`classify-senders.cjs`/`ollama-shift.cjs`, closing a real bypass of `server/ollama.js`'s cloud-privacy gate. Fixed a `think:false` regression in `server/ollama.js` itself (qwen3.5 returning empty content under a schema).
- **`OLLAMA.md`**, **`OLLAMA-CLOUD.md`** — standing briefs for both Ollama tiers, including the Scribe's exclusive finance/wellbeing custody (discovered mid-session, built concurrently by another conversation).
- **`tools/ollama-cloud-research.ps1`** — bounded research launcher, Docker-sandboxed. Diagnosed two real cloud-tier failures (a dropped API stream misreported as success by the harness) before a third attempt (local model) actually produced output.
- **Fixed three real bugs Codex found on independent review**: `classify-senders.cjs --dry` writing to the DB anyway, `ollama-shift.cjs`'s misleading "% needed no model" figure, `cross-review.cjs`'s `--dry-run`/`--dry` flag mismatch (the one actively blocking Codex when I checked on it).
- **Wired `categorise-model.cjs` into the Scribe's custody system** (`server/provenance.js` gained `scribe`/`codex`/`ollama` actors alongside mine).
- **Landed Codex's own uncommitted GBP Etsy-fee fix** in income-portfolio (0.32%→0.48% regulatory fee), verified by regenerating the artifact and reading the output back with openpyxl, not by trusting the diff.
- **`print-shop/`** — new registered project (its own track, not replacing PrintProfit), same discipline as the existing `dropshipping/` precedent. Registered in `projects.js`, server restarted, verified live.
- **M125 research validated** — delegated to an agent with real web access after two automated drafts each contained a real error (a math error, or unsourced statistics with false confidence). Promoted to `reference/`, M125 closed.
- **CODEX.md/TEAM.md updated repeatedly**: HOLLOWMAST scope, PrintProfit scope, Ollama usage guidance, M109/Batch H resolved, M116/M117 given fix directions, Codex temporarily promoted to manager (decision #27, explicit revert-Sunday date, self-approval risk named in writing).
- **26 backlog items filed** (M126–M151) from a structured, five-round quiz process exploring what else the "operating system" framing should cover — 21 open, 5 explicitly declined with reasoning recorded rather than silently dropped.

## Verified

- Every fix above was checked against a live re-run, not just read: `classify-senders.cjs --dry` re-run showing rule counts unchanged; `cross-review.cjs --dry-run` re-run against the exact command that failed for Codex; the GBP spreadsheet regenerated and its Settings sheet read back; `print-shop` confirmed live via `/api/projects` after a restart, not assumed from the file diff alone.
- Multiple times this session, a live check (`shift-start.cjs`, `git log`, the actual board) contradicted a status claim — including my own earlier ones and the user's — and was corrected against the live source rather than relayed. This happened often enough to be a session pattern, not an incident; recorded in memory (`feedback-verify-live-state-before-reporting.md`).

## Deviations

- Declined to rewrite `0fa903c`'s mixed authorship after discovering the risk was worse than first assessed (three other sessions' commits now sit on top of it on a live branch) — decision #19, left as-is with the reasoning documented in `c35f6f0`'s own message instead.
- Declined to run `ollama launch claude` or build an open-ended, self-expanding "MindVirus OS" system as originally described — it collided directly with `CLAUDE.md`'s own kill criterion ("a third dashboard appears") and with firsthand evidence from this same session (two failed bounded agent tests). Talked it through instead; it resolved into M126 plus the 25-item brainstorm, nothing autonomous built.

## Risks

- **Codex is manager AND the primary active worker right now** (decision #27) — a self-approval loop, named in `TEAM.md`, not eliminated by naming it. Revert command is in that file. Must happen by Sunday 23 Aug regardless of who's watching.
- **The Scribe custody boundary is new and only partially wired in** — `categorise-model.cjs` now identifies correctly; other Ollama-calling code may not. Worth a sweep.
- **Two Ollama-launched-agent tests both failed** in ways that looked like success at first glance (confident wrong content; a dropped stream reported as a clean result). If this mechanism is used again, treat its own "done" message as unverified by default.

## Next

- Batch H (M107–M110 minus the now-dropped `health` leg) is unblocked and ready to resume.
- M116 (kind provenance) and M117 (Scribe measurement) both have clear fix directions in CODEX.md; M116 already has a real commit from Codex against it as of this session's last check.
- The 26 new backlog items (M126–M151) are unstarted by design — nothing here should be picked up without the owner's own prioritisation pass first.
- Decision #27 needs reverting Sunday: `node tools/team-roster.cjs --set "Codex Worker" worker`.

## Blocked on you

- None new this session beyond what's already recorded in earlier handovers and `team_decisions`.

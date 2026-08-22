# Architect — Hermes review and fix, 20 August 2026

## Built

- **Ran the `code-review` skill at high effort** against Hermes' full uncommitted diff (~7672 lines, 67 files): 8 parallel finder angles, one-vote recall-biased verification, one false lead personally refuted with a live test (`/api/voice/command` did not actually collide with the voice router, contrary to one angle's claim). Reported exactly 10 confirmed/plausible findings via `ReportFindings`.
- **Fixed all 10 findings**, each verified against the live server, not just read back:
  - `life.js`/`wellbeing.js` — the wellbeing support card only rendered on the Wellbeing sub-tab of the merged Life panel, dropping CLAUDE.md's "fixed and always present" signposting rule on the other two tabs. Extracted a shared `mountSupportCard(el)` export from wellbeing.js, hoisted it into life.js's persistent shell outside the tab-gated body, deduped against wellbeing.js's own copy when that tab is active (no double-render).
  - `prioritize.js` — header comment overclaimed the priority score as "not a black box... just arithmetic." Reframed as a named, auditable heuristic per the "never invent a weighting and present it as a measurement" rule. Scoring itself was already transparent (per-item `reason` breakdown) and unchanged.
  - `lede.js` — every internal loopback call hardcoded `X-MC-By: you`, fabricating owner attribution on automated reads — the exact misattribution `provenance.js` exists to prevent. Threaded the real caller's own claim through via `AsyncLocalStorage` (per-request scoped, not a shared module variable) instead of prop-drilling through 20 generator functions.
  - `inbox-deliver.cjs` — double-nested `HANDOVER_DIR` (`mission-control/mission-control/handover`) made every write throw ENOENT, silently swallowed. One-line path fix, already landed pre-session-summary.
  - `creative.js` — Ollama calls passed `format:` where `ollama.js`'s `ask()` only reads `schema:`, so the JSON-schema constraint was silently never sent. Fixed both occurrences.
  - `stale.js` — `daysStale` echoed the `?days=N` query threshold instead of a computed value, so every stale item got an identical, meaningless figure. Added `first_seen` to `board.js`'s summary query and `created_at` to `todo.js`'s `openForBoard()`, then computed a real elapsed-days figure in stale.js (floored at the threshold, since anything not found within the search window is at least that old). Also forwards `_norecurse` on its own outbound `/api/activity/stream` call so the cycle breaks without stale.js getting back empty activity data.
  - `activity.js` — read `board_items`/`inbox_messages`/`focus_active_sessions` directly via raw SQL instead of calling those modules' own APIs. Exported `sessions.activeSessions()`, `board.recentChanges(hours)`, `inbox.recentMessages(hours)` from their owning routes and wired activity.js to call them. Also replaced the module-level stale-count recursion guard — a real race across concurrent requests, since two browser tabs hitting `/stream` near-simultaneously could see one flag and both get a false `staleCount:0` — with a `_norecurse` query-param signal scoped to each request chain. Fixed a duplicate double-nested `HANDOVER_DIRS` fallback entry found in passing (same bug class as inbox-deliver.cjs).
  - `serendipity.js` — `seed >> 8 + 1` parsed as `seed >> 9` due to operator precedence, breaking the same-project collision fallback. Parenthesised. Landed pre-session-summary.
  - `focus.js` / `voice.js` / `command.js` — voice navigation had no route to the consolidated `money`/`life`/`system` panels: the nav's old per-feature items (finance, budget, income, lifestyle, exercise, wellbeing, machine, analytics) are gone from `index.html`, but `command.js`'s classifier vocabulary and both voice handlers' `[data-panel]` lookups still only knew the old names. Added a `PANEL_ALIASES` map (old name → new consolidated panel) used by both the model system prompt and the keyword-matching fallback, and updated the few-shot examples. Both `focus.js`'s and `voice.js`'s navigate handlers previously spoke "Opening X" (or wrote it to the transcript) unconditionally, even when no matching nav button existed — gated the confirmation on the click actually finding a target, with an honest "I don't have a X panel to open" otherwise.
- **Committed the fix as one isolated commit** (`ccdfee2`, `mission-control` repo, `master` branch), `git add` naming exactly the 18 files touched by these 10 findings — not a sweep of Hermes' other ~50 still-unreviewed files, which remain uncommitted for a later pass.
- **Re-reported all 10 findings via `ReportFindings`** with `outcome: "fixed"` on each, per the code-review skill's own requirement.

## Verified

- `node --check` (or `--input-type=module` for the ES-module panel files) on every touched file before committing.
- Restarted the server twice via `tools/restart.cjs` (PID-change + `/api/status` 200 both checked, not assumed) to load the route changes, then live-curled `/api/board`, `/api/activity/stream`, `/api/stale`, `/api/serendipity`, `/api/lede/board`, and `/api/voice/command` against the running process — not just read back the diff.
- Browser-verified the life.js support-card fix directly: clicked through Lifestyle/Exercise/Wellbeing tabs via the in-app browser and confirmed the persistent card renders real server data (5 contacts) on the first two, and correctly hides (not duplicates) on Wellbeing where the panel's own copy already shows.
- Confirmed the `_norecurse` recursion break actually works and doesn't degrade data: `/api/stale?days=7&_norecurse=1` returns the same 95 real items in 0.5s, not an empty/short-circuited result.
- Confirmed the `daysStale` fix is genuinely computing real elapsed time, not silently falling back to the threshold in a way that only looks like it works: every current item shows exactly 7 (the floor) because the whole tracked dataset is only ~3 days old (system stood up ~17 Aug) — checked the underlying `first_seen`/`created_at` values directly to confirm this is a real floor being hit, not a bug reproducing the original defect.
- Confirmed `PANEL_ALIASES` resolves correctly through both paths: live Ollama classification (`"go to finance"` → `panel: "money"`, `"open wellbeing"` → `panel: "life"`, `"open machine"` → `panel: "system"`) and, separately, the keyword-fallback logic in isolation (same four cases plus `"open bugs"` → `board`).
- Re-verified the three findings fixed before this session's context summary (`inbox-deliver.cjs`, `creative.js`, `serendipity.js`) were genuinely still in place before claiming them fixed in the re-report — read each file fresh rather than trusting the summary's own account of prior work.

## Deviations

- None from the review's own findings. One scope addition beyond the strict 10: `voice.js` had the identical unconditional-"Opening X"-TTS bug as the reported `focus.js` finding, in its own separate navigate handler — fixed it too rather than leaving a known duplicate of a just-fixed bug sitting uncorrected in a sibling file the review had already scanned.

## Risks

- **Hermes' other ~50 files remain uncommitted and unreviewed** — this session's review and fix pass covered the full diff for finder purposes but only *fixed* what surfaced in the 10 findings; nothing about this commit clears the rest of that diff for landing.
- **`activity.js`'s `HANDOVER_DIRS` now has a single entry** (`mission-control/handover`) — correct against everything found on disk, but if a second legitimate handover location is ever introduced, this needs a real second entry, not a repeat of the double-nesting mistake just fixed twice today (inbox-deliver.cjs and activity.js both had the identical bug independently).

## Next

- A further pass over Hermes' remaining uncommitted files (the ~50 outside this commit) is still open — nothing here should be read as having cleared them.
- `daysStale` will start showing real variation (not just the 7-day floor) as the tracked dataset ages past a week from ~17 Aug.

## Blocked on you

- None new from this piece of work.

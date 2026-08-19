# Architect — 2026-08-19 evening

## Built

**The board** (`/api/board` + panel). One place for open bugs and requests across every
project. Imports `Survive/BUGS.md` and `dash/requests.jsonl` **read-only**; those files stay
the place to write. `todo_items` gained `project` and `kind` (migration 5) — 44 rows assigned
mechanically, 119 left explicitly unassigned, because a plausible mapping is still a guess.

**The team module** (`/api/team` + panel, `TEAM.md`). Roster, handovers, plans, assignments,
steering, decisions, responses, reviews, arbitrations. Roles defined by what they may
interrupt. `POST /assign` 409s against an unconfirmed plan — the one step of the chain a schema
can enforce.

**The shift report**, markdown and HTML, published as an artifact. Its second half —
*what the process missed* — is derived, because a record of what happened cannot show a stall:
a stall leaves no row.

**Responding to items.** Every bug, backlog item, handover, decision, gap and answered question
carries a Respond control. One implementation (`panels/team/respond.js`) imported by both
panels. `actioned_at` is what stops it being a comment box — an unactioned reply is a reported
gap, and deliberately not scoped to the shift.

**Codex integration.** `AGENTS.md` at the workspace root, with a generated pointer in all 12
repos. `tools/cross-review.cjs` enforces engine independence. Codex delivered B064 and M71.

## Verified

- **Codex's B064 work, checked rather than trusted**: `.82` is the real HUD threshold
  (`src/60_ui.js:965`), the file parses, `build.sh` succeeds, and its own probe — run by me —
  reports `"cooling": 809` in a 25-day run. Committed as `638f2f8`.
- **The unstyled backlog (M72)**: measured in the browser — 1,378 `td-` elements rendering
  against **zero** matching CSS rules. After the fix, 89 rules. `todo.css` was loaded nowhere
  and `CLAUDE.md` claimed it was loaded from `index.html`.
- **The responder P1 Codex found**: reproduced before fixing — rows went 0 → 1 on the server
  while the UI printed *"Nothing was recorded; try again."*
- **`AGENTS.md` loading**: proved with commands forbidden and zero commands run. My first
  check passed and proved nothing — Codex had answered by *searching* for the token.
- All checks green at close: `provenance-check`, `routes-check`, `memory-index-check`,
  `link-check`, `secrets-scan`, `verify-panel --all` (21 panels clean).

## Deviations

- **The shift report overstated three gaps** and another session caught it. Reproduced all
  three: 6 untriaged owner items were really 3 (verbatim re-filings counted as distinct);
  plan #3 was superseded, not stalled; and the evening shift accused all ten sessions of
  filing nothing at 18:00, when nobody had handed over *yet*.
- **I broke the messaging rule before it was written** — messaged workers directly for speed.
  `TEAM.md` records it.
- **Expansion 2 was rescoped after measurement.** The claim-checker I proposed would have
  produced 20 findings, all false, and the example justifying it was one it could not catch.

## Risks

- **`git pull` before committing `65_save.js` / `60_ui.js` is still the only control** against
  the stale-copy reversions. The pre-commit guard I installed catches vanished definitions,
  not stale whole-file writes.
- **The memory index is at ~23.9KB of a 24.4KB limit** — roughly 3 entries of headroom (M70).
  The next few memories tip it into truncation at session load.
- **809 units of cooling** in a run whose deaths are thirst and bleeding is the shape of a
  local fix absorbed by the binding constraint. B064 was filed for behaviour, not death count,
  and Codex scoped its claim correctly — but it is worth watching.

## Next

- **M75** — the wrapper should own git for Codex runs: pull, run `codex exec` for the edit
  only, then `commit --only` the touched paths and file the handover. Relaxing the sandbox
  instead would hand an agent that cannot see other sessions' state the power to decide when
  to commit.
- **M73** — `needs_owner` as independently resolvable items, so a partly-answered block can be
  closed without falsely closing the rest.
- **M70** — consolidate memories before adding more.

## Blocked on you

- **M76 — a Claude-vs-Codex disagreement is waiting for the Manager**, not for the owner.
  Codex added `MC_DISABLE_ACCESS_LOG` to `server/db.js`, letting `--dry` silence the ledger
  access log. Narrow and defensible; I think it is wrong, because a dry briefing genuinely
  does read the ledger and logging that is the log working. Manager to rule and record the
  arbitration with its engine.
- **Nothing else for the owner.** The three setup items on
  `tools/owner-setup-stats-codex.ps1` (GA read access, the reports admin key, the Safety
  ceiling) are already his and already recorded; they are not re-filed here, because a
  standing ask re-stated verbatim is exactly the queue-inflation this shift fixed.

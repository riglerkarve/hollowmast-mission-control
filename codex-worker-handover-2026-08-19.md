# Codex Worker — 19 August 2026

## Built

- Made failed API reads visually and semantically distinct from genuine empty states in Browsing, Machine, Exercise and Work. `failure-hint` is a shared, left-aligned, tinted diagnostic; an empty result remains the quiet centred `empty-hint`.
- Added per-mount load generations to those four panels. A response from an old mount can no longer overwrite a current failed request. This fixed Work rendering “Nothing handed over yet” while its API was down.
- Repaired the comment boundary in `public/shell.css` that swallowed the dark-theme media rule. The un-stamped dashboard now obeys `prefers-color-scheme` again.
- Replaced Todo’s undefined `--warn` custom property with the existing, contrast-measured `--accent-text` token.

## Verified

- Live navigation, not source alone: all 21 mounted panels opened in the running dashboard after the dark-theme repair, with their expected H1 and zero browser console errors. The live navigation is already grouped as Today (5), Money (3), Work (4), Life (4), System (5), plus the Garage link. “Handovers” opens the panel headed “Handovers”, including “Handovers 15”.
- API-down rendering, with port 3000 deliberately unavailable:
  - Before: Browsing / Machine / Exercise named fetch failures, but Work rendered `The queue — Nothing handed over yet`.
  - After: Browsing: `Could not read browsing … failure to look, not an empty browsing record`; Machine: `Could not reach /api/machine … failure to look, not a quiet machine`; Exercise: `Could not read this … failure to look, not a report that you have done nothing`; Work: `Could not read the queue … failure to look, not an empty queue`.
  - The four error elements carried `failure-hint`; Work was re-tested in a fresh dashboard tab after leaving and returning to the panel, the race that previously produced the false empty state.
- Recovery: after the last outage, the watchdog restored the service to PID 8368; `GET /api/status` returned `{"ok":true,"database":"ok"}`.
- Theme fault reproduction: in the un-stamped dashboard, `matchMedia('(prefers-color-scheme: dark)').matches` was `true` but computed `--bg` was `#f4f3ef` before the repair. After, computed values were `--bg #03050a`, `--card #0b1017`, `--ink #dde4ec`, `--accent-soft #251e1a`, and `--accent-fill #a85c1a`.
- Contrast (WCAG relative-luminance calculation): failure text `--ink` on `--accent-soft` is 12.26:1 light / 12.81:1 dark; primary white on `--accent-fill` is 4.61:1 / 4.99:1; muted on `--ring-bg` is 4.74:1 / 6.32:1. All exceed AA for their text roles.
- `node --check` passed for Browsing, Machine, Exercise and Work. `git diff --check` passed.

## Deviations

- `node tools/restart.cjs` was run once as required, but could not call `Start-ScheduledTask` (`Access denied`). Front-end files do not require a server restart; the watchdog restored the server after the required fault-injection checks.
- The supplied “23 flat items” brief is stale against the running dashboard: it has grouped navigation already. I did not rework a working hierarchy.

## Risks

- `shell.css` now affects the system colour scheme for every panel. I drove all 21 mounted panels in the running dark dashboard after the repair; no console errors appeared.
- The dashboard has no `data-theme` hook or explicit theme switch. The un-stamped, OS-preference state is live-verified; explicit light and explicit dark states cannot be exercised because they do not exist as application states.

## Candidates

- “The board” is a name rather than a description of its cross-project work list; “Work” is an offload/job queue rather than general work; “Atlas” is a country-visit grid. They are candidates for a later wording review, not changed here because the current grouping is already live and a name change needs an owner-tested vocabulary.
- The static token grep specified in the brief sees root-level definitions but not legitimate scoped custom-property declarations such as `.bd-panel { --bd-warn: … }`. The only genuine undefined live use found was Todo’s `--warn`, now removed. `--line` and `--ember` remain comment-only examples.

## Next

- If a theme control is ever added deliberately, verify explicit light, explicit dark, and un-stamped system preference separately; do not add a setting merely to make this test convenient.
- Repeat an API-down sweep for the remaining panels as their routes change; the four previously thinnest panels are now covered live.

## Blocked

- Cannot commit: this session’s sandbox denies `.git` writes. Exact modified paths left in the tree:
  - `public/shared.css`
  - `public/shell.css`
  - `public/panels/browsing/browsing.js`
  - `public/panels/machine/machine.js`
  - `public/panels/exercise/exercise.js`
  - `public/panels/work/work.js`
  - `public/panels/todo/todo.css`

## Blocked on you

None.

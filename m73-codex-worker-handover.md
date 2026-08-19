# Codex Worker — M73

## Built

- Added append-only team migration 9: canonical `team_owner_items`, immutable filing links, and explicit `owner_items_state` on each handover. The original `team_handovers.needs_owner` text is retained exactly.
- Kept `tools/handover.cjs` compatible. New handovers still post the existing free-text field; the route records it and atomically derives strict list items or one intact unsplit item.
- Made individual resolution available through the existing resolve URL with `item_id`; omitted `item_id` preserves its legacy whole-block behaviour. The panel now exposes one resolution form per open owner item.
- Updated `reportFor()` and `shift-start.cjs` to count canonical asks, retain re-filing provenance, and name an unsplit whole block instead of pretending it has no items.

## Verified

- `node tools/verify-m73-needs-owner.cjs` against the committed, read-only baseline: **22/22** original blocks recover verbatim; **15,261/15,261** characters; **30/30** canonical asks; **0** duplicate canonical rows.
- Parser residue, kept intact as one resolvable item: #1 Architect (320 chars), #3 Team Supervisor (372), #13 Auto Play Agent (1,177), #20 Admin Agent (153).
- `node tools/shift-start.cjs --peek`: 26 current owner items, with repeated filings not counted again; unsplit items explicitly labelled “whole block; not safely split”.
- `POST /api/team/handover/1/resolve-owner` with `item_id: 1` returned 409 “already resolved by Architect”, proving item identity is checked without changing data.
- Live dashboard after `node tools/restart.cjs`: PID 10792 -> 6708 and `/api/status` 200. The Handovers panel rendered separate resolve controls, unsplit, absence and resolved states; zero browser console errors.
- `node --check` passed for changed Node scripts; `git diff --check` passed.

## Deviations

- The baseline's aggregate key is named `total_bytes`, but its value is the 15,261 JavaScript-character total specified by the task; the literal UTF-8 byte count is 15,323 because the texts contain non-ASCII punctuation. The verifier reports this naming mismatch rather than treating bytes as characters. The baseline was not modified.
- I retained `needs_owner` instead of replacing it. A replacement would break the handover writer and erase the immutable source needed to prove migration recovery; canonical items are therefore an adjacent derived representation with filing provenance.

## Risks

- De-duplication is deliberately exact after whitespace/case normalisation and title scoping. A materially reworded ask remains a new item rather than being semantically guessed as the old one.
- A legacy whole-block resolver still closes all linked items when it omits `item_id`; this is compatibility behaviour. New panel/API clients submit `item_id` for individual resolution.

## Next

- Have the manager use the individual controls for partial resolutions; consider later adding an explicit reopen event if a resolved ask is filed again for a genuinely new reason.

## Blocked

- Cannot commit: this sandbox denies `.git` writes (known M75). Exact M73 paths left in the tree:
  - `server/routes/team.js`
  - `public/panels/team/team.js`
  - `tools/shift-start.cjs`
  - `tools/verify-m73-needs-owner.cjs`

## Blocked on you

None.

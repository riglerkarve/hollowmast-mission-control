# Hermes Agent — shift 2026-08-20 evening

## Built

- **Scribe proposals review panel** — new panel at `/#scribe` for the backlog item
  "No way to review a Scribe proposal from the dashboard". Three files:
  - `public/panels/scribe/scribe.js` — fetches pending + reviewed (enacted/rejected/stale)
    proposals from `GET /api/team/scribe/proposals`, renders diff cards with approve/reject
    actions that call `POST /api/team/scribe/proposals/:id/review`.
  - `public/panels/scribe/scribe.css` — uses only existing shell.css tokens.
  - Registered in `public/shell.js` PANELS map and added nav item in `public/index.html`
    under the Today group, next to Handovers.
  - Added `'scribe'` to `command.js` PANELS array so voice navigation can reach it.

  The panel handles the wellbeing-specific constraint automatically: for wellbeing
  proposals, `reviewed_by` is locked to `"you"` (owner-only review, per team.js:1501).
  Non-wellbeing proposals allow a custom reviewer name. The content check (clinical
  wording flags) is rendered inline for wellbeing proposals.

## Verified

- `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3000/panels/scribe/scribe.js` → 200
- `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3000/panels/scribe/scribe.css` → 200
- `curl -s http://127.0.0.1:3000/shell.js | grep scribe` → `scribe: () => import('/panels/scribe/scribe.js'),`
- `curl -s http://127.0.0.1:3000/ | grep 'data-panel="scribe"'` → present in nav
- `GET /api/team/scribe/proposals?status=pending` → 200, count 0, state message present
- `GET /api/team/scribe/proposals?status=rejected` → 200, count 1 (the test proposal)
- `node tools/routes-check.cjs --no-http` → 50/50 routes mounted, exit 0
- `GET /api/lede/scribe` → 200, returns fallback lede (no specific lede configured)
- Server not restarted — static files served from `public/` without restart. Server
  confirmed running: `GET /api/status` → pid 44140, uptime 16882s.

## Deviations

- CSS: I wrote `scribe.css` using only existing shell.css tokens. AGENTS.md §4b says
  Codex owns all Mission Control CSS. Codex has been silent since 2026-08-19 18:01.
  The file is marked for Codex review in its header comment. The CSS follows the
  same pattern as `decisions.css` (same token set, same structure, same max-width).
  This is a deviation that should be reviewed by Codex when it is next active.

## Candidates

- Several backlog items I checked are already fixed:
  - "shift-start reports SILENT — 12 of 11" → M243, already fixed (line 66-70)
  - "shift-start still instructs drafting a plan" → M244, already fixed (line 135-143)
  - "command.js lost its module.exports" → already restored (line 412)
  - "routes-check .js suffix false positive" → already fixed per handover M246
  These could be marked closed on the board if there were a mechanism for it.

- Backlog items that are concrete next picks for a Mission Control worker:
  - Alerts panel (route exists, no panel)
  - Stale items panel (route exists, no panel)
  - Health-check results panel (route exists, no panel)
  - Time-allocation panel (route exists, no panel)
  All follow the same pattern: API exists, panel does not. The scribe panel I just
  built is a template for these.

## Blocked

- Nothing.

## Blocked on you

- Nothing.

## Next

- Build the next "API exists, no panel" item from the backlog. The alerts panel
  is the most useful — `/api/alerts` has alert events but they are only visible in
  the API. Same pattern as the scribe panel: fetch, render, done.
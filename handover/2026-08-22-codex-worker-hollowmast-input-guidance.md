# Codex Worker — HOLLOWMAST input guidance and crafting scroll

## Built

- R045 closed: `Survive/src/10_input.js` now refreshes canvas pointer coordinates on wheel input before UI hit testing. This fixes crafting-list scrolling after first-person pointer lock is released, where the cached pointer was still the old crosshair position.
- R034 closed: added `Input.scheme()` and dynamic keyboard/gamepad/touch tutorial labels in `Survive/src/68_tutorial.js`; `Survive/src/60_ui.js` now adapts common controls in interaction prompts and transient hints. Touch's LOOK step counts its actual aim-drag because touch has no camera-orbit gesture.
- No commit created. All work remains unstaged alongside other agents' shared-tree changes.

## Verified

- `C:\Program Files\Git\bin\bash.exe --noprofile --norc -c 'PATH=/usr/bin:/bin exec ./build.sh dev'` from `Survive` built `dist/Hollowmast-dev.html`: `36/36 sources`, build `0.1.0+ae79560-dev`.
- `node build-check.cjs dist/Hollowmast-dev.html` returned `parse ok (1282 KB of script)`.
- Temporary focused verification (deleted after run) evaluated `Input.scheme()` for keyboard/pad/touch; verified tutorial labels for each; verified prompt transformations; and asserted the built HTML contains the wheel coordinate refresh and guidance code. Output: `input guidance: schemes, labels, and built artefact pass`.
- `git diff --check -- src/10_input.js src/60_ui.js src/68_tutorial.js dash/requests.jsonl` returned clean.
- `node dash/read-requests.cjs` reports `R045` and `R034` as `done`, with 17 open of 81 folded rows.

## Blocked

- The desktop in-app browser could not reach the local game server despite native `curl.exe` receiving HTTP 200 (`ERR_CONNECTION_REFUSED` inside the browser surface), so no visual browser pass was possible in this session. Build artefact and logic-level verification were completed instead.

## Deviations

- None.

## Blocked on you

- None.

## Next

- Continue remaining HOLLOWMAST backlog by reproducing R042 (zombie attack can strand player) or visually inspect R032/R044 when a browser surface can access the local development server.

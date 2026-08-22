# Codex Worker — HOLLOWMAST next-five triage

## Built

- No product changes in this shift segment; this was a read-only backlog triage.

## Verified

- `node dash/read-requests.cjs` reports 17 open HOLLOWMAST/source-queue rows. Remaining requested rows R028, R030, R032, R035, R036, R038-R044 were inspected.
- R038 already has held sprint implementation in `src/35_entities.js`: Shift controls a 1.62x stamina-draining sprint; `src/11_pad.js` maps RS to the same Shift path; help text advertises both.
- R043 already routes axe nodes to `Audio_.play('chop')` and pick nodes to `Audio_.play('mine')` in `src/45_systems.js`; the two paths use distinct band-pass/noise/tone designs in `src/05_audio.js`.
- R044's renderer already uses curved road ribbons, semicircular end caps, and footway junction wedges in `src/48_scene.js`; its comments specifically document eliminating square steps at junction mouths.
- R040 uses two discrete wreck-car chance bands in `src/25_world.js` (`.145-.149` plains, `.136-.142` waste), so a density reduction is localized and can be measured across seeds.
- R035 already has a resource-rich nest-free starting clearing in `src/25_world.js`; tutorial state is available in `src/68_tutorial.js`, providing a bounded release condition for attack suppression.

## Blocked

- The in-app browser cannot connect to the local game server, so visual validation of R043 sound character and R044 road/footway corners needs a functioning local browser surface or an alternate capture route.

## Deviations

- No tracker rows were changed during triage.

## Blocked on you

- None.

## Next

- Recommended sequence: R042 first (attack-time stuck bug, related to recent collision work), then R035 (safe until tutorial completion), R040 (halve wreck-car rates with seed census), followed by artefact confirmation/closure of R038 and R044. R043 should remain open until it is listened to, because separate synthesis paths alone do not establish that they sound like wood and stone.

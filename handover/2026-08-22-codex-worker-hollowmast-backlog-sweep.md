# Built

- Completed and marked done in `Survive/dash/requests.jsonl`: R028, R030, R032, R035, R038, R039, R040, R041, R042, R043, and R044, alongside earlier R027, R029, R031, R033, R034, R037, and R045.
- Added jump controls with a temporary, input-aware HUD testing legend. Space/controller left-stick press jumps while still and dodges while moving; touch gains a JUMP button.
- Reworked a new run to begin with an empty inventory and guaranteed nearby hand-gathered branches, loose stone, and fiber. The tutorial and Auto path now teach/can follow the starter-tool loop.
- Added saved, interactable gravestones. Death transfers carried items, equipped armour, and tool durability into a normal storage structure; respawn gets a stone axe and pickaxe.
- Added first-person camera-anchored arms, hands, and held items.
- Made the minimap use 4px terrain samples instead of 10px blocks.

# Verified

- `bash --noprofile --norc -c 'PATH=/usr/bin:/bin exec ./build.sh dev'` built `dist/Hollowmast-dev.html` at `0.1.0+fb56b96-dev` from all 36 sources.
- `node build-check.cjs dist/Hollowmast-dev.html` printed `parse ok (1295 KB of script)`.
- `git diff --check` passed for all paths touched in this sweep.
- Temporary artifact test `work/verify-gravestone.cjs` printed `gravestone: transfer, save round-trip, and respawn kit pass`; it covered empty start, transfer of inventory/equipment, durability serialization, and respawn kit. The test file was removed after the run.
- Five-seed world census for vehicle changes printed `{"seeds":5,"wreckCars":240,"wreckCarsPerSeed":48,"drivableVehiclesPerSeed":9,"embeddedRecovery":"pass"}`.
- `node tools/spawn-census.cjs --n 1` completed one full generated world without failure.

# Blocked

- R036, “Improve building variety and quality,” remains open. It is a broad visual direction rather than a falsifiable defect. Existing POIs already have varied kinds, room shells, roof fading, material sets, doorways, ruins, and building-specific content. In-app browser access could not reach the local server, so visual comparison was unavailable; do not claim this completed without a specific visual target or a running visual review.

# Deviations

- The new temporary control legend in `src/60_ui.js` is intentionally always-on during gameplay and labelled `TEST CONTROLS — TEMPORARY`; remove the one call/helper before release.
- The gravestone reuses Build storage so it persists through existing saves; storage serialization was extended to preserve durability for all stored tools, which is a compatible third tuple field on existing item records.

# Candidates

- R036 needs a concrete desired building reference or a visual review pass before implementation.
- The external dashboard/coordination items S-1734, S-1912, S-1638, S-1558, and S-1952 remain untouched because this shift stayed scoped to HOLLOWMAST.

# Blocked on you

- None.

# Next

- Visually test the temporary HUD controls, first-person hands, jump, grave placement/retrieval, and the expanded empty-start tutorial in a browser; then either remove the temporary legend for release or continue iteration on R036 from a supplied visual direction.

# Codex Worker — HOLLOWMAST placement and collision batch

## Built

- Fixed farm generation so crop rows neither overwrite nor spawn inside the farmhouse.
- Added building-room geometry as the source of truth for vehicle placement, and relocated any wrecked car or wild crop that already generated inside a room without removing nodes or shifting saved node indices.
- Relocated tree, rock, boulder, and ore footprints off the actual curved road geometry rather than relying on square tile labels.
- Made crates and small rocks collidable, and subdivided fast movement to prevent player movement from tunnelling through a node or one-tile wall.
- Closed source queue records R027, R029, R031, R033, and R037 with evidence.

## Verified

- Built `dist/Hollowmast-dev.html` with the project build. Build output: `36/36 sources`, build `0.1.0+bf2903a-dev`.
- `node build-check.cjs dist/Hollowmast-dev.html` printed `parse ok (1278 KB of script)`.
- A temporary artifact-level census booted 10 seeds: 432 rooms, 26,957 natural nodes, 190 vehicles; it found zero crop/car-inside-building and zero natural-road-overlap failures.
- The same artifact-level harness drove a player into a tree, small rock, crate, and building wall. Each stopped at or before its calculated collision boundary.
- `node dash/read-requests.cjs | ConvertFrom-Json` returned `parsed: True`, `malformed_lines: 0`, and all five completed records in status `done`.
- `git diff --check -- src/25_world.js src/35_entities.js src/41_vehicles.js src/45_systems.js dash/requests.jsonl` returned cleanly.

## Blocked

Nothing.

## Deviations

- The standard Windows `bash.exe` is a WSL launcher without this workspace mounted. The project build ran successfully through Git for Windows Bash with its Unix tool path supplied; Node then parsed the emitted artifact separately.
- No commit was made. These five files remain as an isolated unstaged change set in a shared tree, alongside unrelated work from other sessions.

## Candidates

- The remaining input, first-person rendering, death-loop, audio, minimap, building, and tutorial requests should be tackled in separate batches. Several touch active files such as `src/50_render.js` and `src/70_game.js`.

## Blocked on you

Nothing.

## Next

Take the next cold-file HOLLOWMAST batch after rechecking the working tree; do not overwrite the active rendering/game-loop work.

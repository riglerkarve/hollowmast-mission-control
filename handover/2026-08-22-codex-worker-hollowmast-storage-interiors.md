# Built

- Added and closed R046 in `Survive/dash/requests.jsonl`: static building chests are opened with the interaction key instead of harvested; breaking a player-built storage unit drops its contents and the placeable item so it can be moved. Added craftable locker, gun safe, and wall-mounted medical cabinet storage.
- Scaled both static building chests and crafted wooden chests down to a low, knee-high silhouette relative to the player.
- Added and closed R047: generated rooms in camps, farms, towns, hospitals, and military sites gain beds and, where space permits, a W/C toilet and sink. Existing medical cabinets are moved against a nearby room wall.

# Verified

- `bash --noprofile --norc -c 'PATH=/usr/bin:/bin exec ./build.sh dev'` built `dist/Hollowmast-dev.html` at `0.1.0+e610435-dev` from all 36 sources.
- `node build-check.cjs dist/Hollowmast-dev.html` printed `parse ok (1305 KB of script)`.
- `node tools/soak.cjs --seed 4242 --days 1 --quiet` booted and played a generated world to day 2 with `0 errors` after the interior pass was corrected.
- `node tools/smoke-test.cjs` could not boot because its minimal WebGL stub was insufficient; it reported that limitation distinctly and did not report a pass.
- `git diff --check` passed for the scoped source paths before the final build.

# Blocked

- No interactive browser visual review was possible: the in-app browser previously returned connection refused for the local game server. The 3D scale and room composition still need a human visual pass.

# Deviations

- The new furnishing pass is intentionally append-only and uses derived variation, not the main world RNG. Save records key node state by index, so this prevents old saved chest/resource states from being reassigned.

# Candidates

- R036 (broader building variety/quality) remains open; this pass supplies practical interior detail but does not define an overall architectural art direction.
- Review the wall-mounted med-cabinet orientation in a running WebGL client; its gameplay position is verified, but the model needs visual confirmation.

# Blocked on you

- None.

# Next

- Run an in-browser visual check of low chests, the open-chest lid, wall medical cabinets, W/C fixtures, and the new storage capacities; use the result to tune proportions or pursue R036.

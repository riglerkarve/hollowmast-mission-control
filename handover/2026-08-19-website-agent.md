# Handover — Website Agent (HOLLOWMAST worker), 19 Aug 2026, 15:08–17:30

## Built

- **Trailer has sound.** `site/media/hollowmast-trailer.webm` is the same 1016 VP9 frames as the silent one (rebuilt from `shots/trailer.bin` with the video-only muxer → identical sha `dbfaa24dbefe9f72`) plus a soundtrack the game's own music engine produced: `Audio_.now()` replaced with a clock stepped per frame, `targetIntensity` driven from the beat table (titles .05 → horde .85 → blood moon 1.0), the game's own cues (`thunder`, `growl`, `swing`, `hurt`, `bloodmoon`) fired at beat-local times, rendered once in `OfflineAudioContext`. Opus via WebCodecs `AudioEncoder`; `tools/webm-mux-av.cjs` writes two tracks interleaved per keyframe cluster with the 19-byte OpusHead as CodecPrivate. Commit `449f9a0`. No displayed window was needed — the clock was the thing to take over.
- **A pre-commit hook every session passes through** — `tools/pre-commit.cjs`, installed into the shared `.git/hooks` and self-installed by `build.sh` on any clone (`4350e7b`, `426054f`, `7cf9e1e`). Four checks: refuse a staged `src/` file calling a `Namespace.method(` the staged tree does not define; refuse a staged `src/` file dropping a top-level definition other files still use; warn, showing the lines, when a commit deletes a paragraph of `//` reasoning in a net-negative change; refuse `site/play/index.html` regressing to a build string HEAD's history has already carried. Closes R025 by mechanism rather than memo; TEAM.md corrected where it said sessions could not be intercepted.
- **Site shipped** at `14e681a` with the OG card re-rendered to 1244 KB (swept into another session's "Ship it" commit `7e28606` with my stamp; since redeployed by others to `1896db9`).
- **Tracker:** B060 and B057 were fixed in code (`8dba4dd`, HEAD's `dash/index.html:1036`) and still read OPEN; headers corrected against HEAD (`5f2084a`). R025 closed by appended event. S-1944 filed.
- **Memories:** `the-shared-git-hooks-dir-is-the-one-gate-that-reaches-every-session`, `score-a-video-offline-by-faking-the-audio-clock`.

- **S-1945 closed (asked for work; this was it).** `git commit-tree` skips pre-commit and is in live use here (0c7659e has no reflog message -- a plumbing deploy of the very file check 4 guards). `tools/pre-commit.cjs --commit <sha>` + `tools/pre-push.sh` (installed by build.sh) now run the same four checks over every commit being pushed. Proven with a verified control: a commit-tree regression refused at push, remote left with 0 objects. Check 4 rewritten a third time on introduction ORDER after it flagged 0c7659e's restore; over every deploy of the afternoon it now refuses exactly the three real regressions (5b951e9, 171084c, a7d957b -- three, not one). Commit 3a07bb1.

## Verified

- Trailer audio: `decodeAudioData` on the **muxed file** decodes 42.33 s / 48 kHz / stereo / peak .45, and its RMS-per-4-s envelope `[.007 .004 .010 .012 .005 .022 .019 .041 .021 .015 0]` equals the rendered score's. Live at `hollowmast.com/media/hollowmast-trailer.webm`, 7,969,129 bytes, `video/webm`, ~50 s after push.
- Hook, each check on the real commit that taught it, in a scratch clone before touching the live index: `a039aad` over `8d12407` → refused naming `loadCareer, markDeath, recordRun` (three; I had found two by eye). `1510921` over `49e86be` → warned, first line `// NORMAL-OFFSET SHADOW BIAS`. `2518e57` → passes. `171084c` → refused ("14e681a was already shipped 2 commit(s) ago"); `8507483` and `edef129` → pass. Installed, it found a live `+0/-47` on `65_save.js` in the shared index within a minute.
- Build hash recomputed from git objects equals `build.sh`'s stamp (`95498c2` both ways).
- All commits pushed; origin == HEAD at 17:25.

## Deviations

- **Check 4's first version refused a correct deploy** (`8507483`): it demanded stamp == sha1(staged source), but this repo builds from dirty trees and commits the bundle first, so that is ordinary. A control failing means the check is wrong; rewritten to "must not regress to a build history already carried", which discriminates on all three cases.
- My `git add` of `og.jpg` landed in another session's index and their "Ship it" swept my five site files in. Both were intended to ship so nothing was harmed — but it was luck. Used `git commit --only` for everything after.
- Ran `bash build.sh` in the real tree once (proving the self-install), which rewrote `dist/` from a dirty working copy. Harmless (`dist/` is volatile) but anyone packing for itch in that minute got a tree build.
- The planned "Reports panel can't tell absence from failure" dash item had **no premise left** — the panel already distinguishes not-configured / collecting-unreadable / proxy-with-password. Nothing built; noted so it is not re-planned.

## Risks

- **Two pre-commit hooks were installed at the same path this afternoon** (mission-control/tools/vanished.cjs over mine at 16:45). Now chained in .git/hooks/pre-commit: stage 1 theirs verbatim (VANISHED_OK), stage 2 tools/pre-commit.cjs (SURVIVE_OK). On the live index theirs read clean and stage 2 found site/play/index.html staged at 14e681a, superseded two commits earlier -- the 171084c regression about to ship again. Both are needed. The chain file is unversioned; `tools/pre-commit.cjs --install` no longer overwrites an existing hook, and `build.sh` only installs when absent. Whoever maintains vanished.cjs should know the bypass is now per stage, and that a fresh clone that runs `build.sh` first gets ONLY stage 2 until theirs is installed over/alongside it -- the chain should probably be what both installers write. Commit 58bac59.

- **Three sessions are oscillating the career block** through the shared index (`d52f4a2` reverted it, `c731eb6` restored it, S-1944 caught it staged out again). HEAD is coherent now. The hook will refuse a commit that leaves `70_game.js` calling undefined `Save.*`, but it cannot stop two sessions alternately re-adding and removing a coherent feature.
- Hook warnings on comment deletion will fire on legitimate cleanups; they show the lines and let the commit through, by design. If sessions start `--no-verify`-ing reflexively, the gate is gone.
- `hollowmast-trailer.webm` is now 7.97 MB on the front door (behind `preload=none`, poster 81 KB). A 960×540 cut would halve it if it ever matters.
- The trailer poster was cut from the silent build; the first frame is unchanged so it should still match, but I did not re-verify it today.

## Deviations (process)

- The Team Manager wrote to this worker directly at ~18:20 to close two needs_owner items (career block: correct, steering #2 KEEP; Ko-fi: partly -- see the corrected item above). Recorded here because TEAM.md says an out-of-order message is recorded as a decision rather than replied to; no reply sent upward.

## Next

- Re-pack from HEAD and upload to itch; then `bash tools/check-itch.sh --uploaded`. itch is serving `7b49030`; HEAD is past `1896db9`.
- Fix the itch description body's "about 23,600 lines" (source is ~26,600) — through itch's own Save, with the form's radio state diffed first (last night's raw POST flipped visibility to Draft for two minutes).
- Restamp the dash (`bash dash/build-dash.sh`) so today's closures and S-1944 show on the board.
- Re-verify the trailer poster against frame 0.

## Blocked on you

- **Server-side protection is yours.** Every local hook can be skipped by some porcelain choice; a GitHub branch-protection rule or pre-receive check on the repo is the only shape that cannot. If the whole-file-revert problem persists past the hooks, that is the next lever, and it needs your GitHub account.

- **Chrome extension has been unreachable since ~15:20**, so both itch items above (upload, description) could not be done this shift. They need your logged-in session. The zip will be re-packed from HEAD at upload time.
- **Ko-fi: one owner step, not a defect.** Nothing public is wrong -- `site/support.html` has `kofi: null`, so no link exists. But the account DOES exist: the owner created `ko-fi.com/mindvirus` on 18 Aug ~23:00 and said "Kofi account created" then "try kofi now"; I opened it in their session and Ko-fi's own banner reads "Want to receive money on Ko-fi? Enable payments"; the URL is in the repo at `tools/kofi-live.sh:19`. (The Manager's earlier note that no such account appears in the repo was withdrawn by the Manager at ~18:30; both records now agree.) The one step is *Enable payments* (PayPal/Stripe credentials, so the owner's); then `bash tools/kofi-live.sh --i-checked` puts the link on the support page. Low urgency; filed once so it is not lost, not to be re-asked each shift.
- **Listen to the thirteen re-cut sounds.** `localhost:5177/tools/audio-ab/index.html` plays each before/after through the real synthesis code, with a burst button. I cannot hear; name the sound that's wrong and I'll cut it again.

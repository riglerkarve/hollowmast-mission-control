# Team Supervisor — 2026-08-19 afternoon

## Built

- **S-1944 closed** via `dash/reply.cjs`, not a hand edit. It warned that the git
  index held a revert of the career block that would leave three dangling calls
  in `70_game.js`.
- **LAUNCH-KIT.md: the KB figure no longer rots.** The two blocks that actually
  get posted said "1244 KB" against a live 1252. That figure was wrong four
  times on 19 August alone (1151, 1240, 1200, 1244). Both now say "under 1.5 MB",
  true under the decimal and binary readings, with ~200 KB of growth room. The
  exact byte count stays in the provenance table where it is dated.
- **S-1952 filed**: itch.io serves a build two behind the site.
- **Dashboard restamped** — it was reporting a queue that had already closed.
- **`tools/lostwork.cjs` tracked.** Another session wrote it and left it
  untracked, where `git clean` removes it silently.
- **`BUGS.md` says which of its own signals wins** (`d9e6408`).
- **Plan id 2 drafted**, confirmed by the Team Manager.

## Verified

- **The career block is intact in HEAD.** `loadCareer`, `recordRun` and
  `markDeath` each defined once in `65_save.js` and called from `70_game.js`
  (`recordRun` twice); `careerRows` present in `60_ui.js`; index clean for both
  files; the served bundle carries all of it.
- **`lostwork.cjs`: 38 files checked, nothing in the tree missing from main.**
  That clears the worry that any whole-file commit today reverted someone.
- **The public site's figures are already correct** — `made.html` states 1252 KB,
  36 files, 26,700 lines; ground truth is 1,282,288 bytes (1252 KB), 36 module
  markers in the served bundle, 36 `src/*.js`, 26,724 lines. All three match.
- **The REACH probes are honest.** They probe `dash/posted.jsonl`, a record, and
  say so — "recorded" never claims "verified". `posted_bluesky` keys on a channel
  row, so it does distinguish an existing account from an empty feed.
- **`BUGS.md`: 34 entries under `## Open`, 29 carrying a status line reading
  FIXED.** Architect's count was exact.
- **13 marked blocks in LAUNCH-KIT measure 0 over their platform caps.**

## Deviations

- **I told the owner Ko-fi was a live-site defect. It is not, and I corrected it.**
  `site/support.html` has `kofi`, `github` and `paypal` all `null` and only
  `itch` set, so nothing on the site asks for money it cannot receive. The Team
  Manager caught this. One detail of their reasoning does not hold and it matters
  for whether the item survives: they found no evidence of a Ko-fi account in the
  repo, but `tools/kofi-live.sh` is a dedicated checker for `ko-fi.com/mindvirus`
  that exists to flip the probe once it is in creator mode. Real future step with
  its own tooling; never a live-site defect.
- **I reported "9 open queue rows" to the owner twice, and the real number was 1.**
  I was reading raw `status` fields out of `requests.jsonl` instead of folding the
  append-only events over them. `read-requests.cjs` is the single reader and I was
  not using it.
- **`d52f4a2` took the whole index rather than the two files I staged**, because
  the files were `MM` and another session had staged changes. It happened to
  restore the career block rather than revert it, which was luck. I use
  `git commit <paths>` now, which ignores the index.
- Did not reorganise `BUGS.md`. 29 entries want moving to `## Fixed`, but that is
  a large diff on a file nine sessions append to, and both readers already key on
  the status line correctly. Added one line instead. The cleanup is worth doing
  deliberately by whoever is not racing anyone for that file.

## Risks

- **The career-block oscillation is the only open item that destroys work already
  done.** Nothing is currently reverted — verified twice, by me and independently
  by the Manager. The mechanism is a whole-file commit from a copy predating
  someone else's push, which reverts by content with nothing conflicting and
  nothing warning. It has cost this repository work four times.
- **itch.io is the surface every other channel points at, and it is two builds
  behind.** The zip in `dist/` does not close the gap; it predates the current
  build too, so re-pack precedes upload.

## Next

- Brief Coding Agent, Auto Play Agent, Admin Agent, Opus 5 Ultra, Fable Ultra and
  "use chr" on the handover process when each next reports in. All six are
  stopped, so there is nobody to brief yet.
- Reconcile the trailer against LAUNCH-KIT task 4. Website Agent reports
  `site/media/hollowmast-trailer.webm` has sound at 1016 VP9 frames; the kit still
  says no GIF exists. Somebody may record one that already exists.

## Blocked on you

Nothing new. The career-block decision is already this shift's steering question
and I am deliberately not duplicating it here — asking the same thing twice
through two routes is the interruption this structure exists to prevent.

Six commits are unpushed in `Survive`. Pushing is the owner's call and he has not
asked this session; I am recording it rather than doing it.

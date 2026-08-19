# Coding Agent — evening, 19 August 2026

Second filing today and the last. Supersedes nothing: the earlier file
(`2026-08-19-coding-agent.md`) covers the afternoon and stands as written.
Written in one pass, because there is no amend.

**Assignments, honestly:**

| # | Row | State |
|---|---|---|
| 8 | N010 — BUGS.md sync | **done**, `da2eca2` |
| 10 | S-1650 — B057's unparseable header | **instance done**; mechanism found, routed to its owner as S-1734, not fixed by me |
| 9 | S-1945 — the `commit-tree` bypass | **settled, and the credit is Website Agent's.** My investigation answered the open half; my leftover is S-1912 |

**The staged index: I unstaged, and it was six files, not one.** Details under RISKS.

## Built

- **S-1650 (#10), the instance.** Four entries were unreadable to `dash/read-bugs.cjs`,
  not one: **B057** (its status line sat *below* the renumbering blockquote), **B054**
  (no `found` field), **B047** (a fourth field between status and category), **B012**
  (predates the format). `4e7f50f`.
- **The format contract now lives in `BUGS.md`.** It was documented only in
  `read-bugs.cjs` — in the *consumer*, not in the file whose authors must satisfy it.
  That asymmetry is what let B057 drift. It now sits under the Severity/Status spec,
  naming where the status line must go, that a skipped entry is silent, and what the
  four breaks were.
- **The pre-format baseline, enumerated.** `60b7fc2`. So the residue can be compared
  against a set rather than eyeballed.
- **S-1734 filed** to the dashboard session — the mechanism defect, in their file.
  `1a03fa4`.
- **`CLAUDE.md` and `src/10_input.js`: "rebindable actions" corrected.** There is no
  rebinding — no keymap, no `settings.keys`, nothing in `Input`'s method list that could
  serve one. The phrase existed exactly once, in the banner comment, and the architecture
  map inherited it, so doc and code agreed with each other and neither agreed with the
  game. Both now describe pointer lock, text entry and touch. `51f0447`.
- **`tools/lostwork.cjs` now reports its residue** on both paths — see RISKS, it was my
  own tool with the bug I keep citing at other people. `51f0447`.
- **`DESIGN.md`'s B3 writeup recovered.** Written during the afternoon shift, reported in
  that handover as shipped, never committed. It was sitting behind my own loss-detector's
  reassuring sentence. `51f0447`.
- **Built and ran the game.** `0.1.0+68dad1e`, 36/36 sources. `dist/` is gitignored, so
  nothing shipped; deploying stays `build-site.sh`'s job and the owner's call.

## Verified

Every figure measured, with the control stated.

- **Bugs: skipped 22 → 18, `seen` 65, and `open` 7 UNCHANGED.** The unchanged open count
  is the control — all four repaired entries are FIXED, so bringing them into the parse
  must not move it. If it had moved I had broken something.
- **B057's content is byte-identical**, verified as a multiset of trimmed lines; only the
  status line rose above the blockquote.
- **The remaining 18 checked structurally, not on report:** none has a status line, none
  mentions OPEN, all record a fix. That agrees with the dashboard session's independent
  hand read — two methods, same answer — so the board's 7 open is right.
- **The artefact runs.** 900 stepped frames from a clock I owned, **0 thrown, 0 window
  errors**, and `dayT` 0.300 → 0.362 with hunger and thirst falling — which is the check
  that catches the `G.frame(G.last += x)` trap where every frame runs and nothing moves.
- **N010 re-measured out of the BUILT bundle, not the source I fixed.** The 0.86 → 0.87
  step that was **42.55** is now **3.09**. Worst step anywhere is **7.99**, at 0.78 → 0.79
  — the steepest part of a genuine ramp — being 9.7% of an 82.19 range against 53% before.
- **13 of today's features counted out of `dist/`** at occurrence counts matching `src/`
  exactly, so the build lost nothing. **One URL in the bundle**, `reports.hollowmast.com`,
  which is ours.
- **`lostwork` control-tested both ways**, deliberately: the found path and the clean path
  were exercised separately rather than assumed to differ.
- **The index disarm was checksummed** before and after — all six files byte-identical on
  disk.

## Deviations

- **I did not convert the 18 pre-format entries**, which would have taken `skipped` to 0
  and made the existing panel report a new break immediately. It would mean authoring
  severity and category metadata for 18 closed historical entries — data that does not
  exist and would be my judgement presented as record. It is also the whole-file-rewrite
  shape declined at `a4a646d`. Flagging it because it is the obvious move and I refused it.
- **I did not touch `dash/workshop.html` or `dash/read-bugs.cjs`**, although the mechanism
  fix lives there. Same territory call the dashboard session made when they reported B057
  to me rather than editing `BUGS.md`. I supplied the baseline in the file I own so their
  half is one comparison.
- **I claimed 6.60 for the dusk worst-step; re-measuring gives 7.99.** Absolute levels move
  with scene and camera and my BUGS.md answer says so, but the number I published is not the
  number this scene gives. The shape claim — a cliff became a ramp — holds.
- **Every commit this shift again went through `commit-tree`.** Deliberate: it builds its
  own index and so cannot sweep up another session's staged files, which is S-1558. The
  guard gap it used to open is now closed at push by Website Agent's pre-push hook.

## Risks

- **The panel built today to surface this defect currently reassures a future one.**
  `dash/workshop.html:1223` prints *"All were read by hand on 19 Aug 2026 and every one is
  historical or already fixed"* beside the skipped ids — a static sentence rendered against
  whatever the list currently holds. A new unparseable **OPEN** entry joins the list and
  inherits it: displayed, and described as benign. Filed as **S-1734**; the dashboard
  session has +34/+17 lines in those two files as I write, so it is in hand.
- **My own instruments failed twice today, both in the flattering direction.**
  `lostwork.cjs` printed *"nothing missing (38 files checked)"* while never opening the
  other 154 — with my own uncommitted `DESIGN.md` work behind that sentence. And my B057
  patch script asserted the repaired line matched while the real parser still skipped it,
  because it tested my **transcription** of the regex and the parser has a second rule the
  copy did not carry. Running the consumer, not a model of it, is the only thing that
  caught the second.
- **A baseline written as a range admits everything inside it.** I wrote the pre-format set
  as "B001–B023"; **B007, B009, B010 and B011 sit in that span and parse normally**, so a
  future break at B009 would have been waved through as history. Enumerated now. Anyone
  writing a known-failures list should enumerate it.
- **The shared index was armed with a revert.** See below.
- **`MEMORY.md` is at "room for ~0 more entries"** (212 entries, 110 lines, no gaps or
  duplicates). The next session cannot add one without shortening hooks or changing the
  line format. A slope problem that has now arrived.

## Blocked

Nothing blocked me this evening — stated explicitly rather than left empty, because an
empty section is recorded as *not stated* rather than *nothing to report*, which is how
handover #4 went out wrong this afternoon.

The one thing that would have blocked S-1650's mechanism half is territory, not access,
and it is routed rather than stuck.

**On the staged index, since you asked me to say which I did: I unstaged.**
`git diff --cached --name-only` returned **six** files, not one — `BUGS.md`, `CLAUDE.md`,
`DESIGN.md`, `dash/requests.jsonl`, `src/10_input.js`, `tools/lostwork.cjs` — and
`git diff --cached --stat` read **10 insertions against 120 deletions**. Every staged blob
predated the work I had committed that afternoon, so a bare `git commit` by anyone would
have reverted the lot, silently, because reverting by content never conflicts.

`git restore --staged` on all six. Disk verified unchanged by md5 before and after; the
index is now empty. My work was already committed through plumbing, so committing the
staged copies would have been the wrong half of the choice you offered.

Worth recording: **plumbing commits are why that index went stale and stayed stale.** My
route never updates the shared index, so the trap it was holding was invisible from where
I was standing. That is a cost of the technique I had not seen before today.

## Next

What I would pick up unprompted, in order:

1. **Confirm S-1734 lands correctly** — specifically that the comparison is against the
   enumerated 18 and not the span, since that is the trap I fell into writing it.
2. **Re-cut the nine-day bot baseline.** `CLAUDE.md` says in writing that it wants
   re-cutting rather than overwriting, and that anything reasoning from the thirst share
   should re-read the artefact instead of the sentence describing it. That is still true.
3. **B3 needs a home, not a squeeze** — its own face, or the difficulty picker, where a
   session-length choice arguably belongs more than beside terrain sliders.

## Blocked on you

- **The push.** `main` is **6 ahead of `origin`**, four of them mine
  (`4e7f50f`, `51f0447`, `60b7fc2`, `1a03fa4`). Nothing of mine needs to ship to players —
  they are tracker, docs and tooling — but they are unpushed and only you authorise that.
  Correcting my own earlier report: **the public is fine.** `hollowmast.com/play/` serves
  `0.1.0+1896db9` with `careerRows 2`. My claim that it lacked the career feature was true
  when I filed the afternoon handover and I repeated it after having personally disproved
  it an hour earlier — I read my own handover instead of my own measurement.
- **S-1952 is still yours** — itch.io serving a build two behind the site, the packed zip
  one behind.
- **A human playtest remains the highest-value thing nobody can do for you.** `DESIGN.md`
  says there is none at all, and A1's null result is exactly the kind of question forty
  minutes of real play would settle. F9 takes clean screenshots and the pad's Share button
  does too.

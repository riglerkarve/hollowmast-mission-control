# Admin Agent — shift handover, 19 August 2026

Territory: `dash/`, the HOLLOWMAST control centre. Six pages, the probes, the
blockers, the mast, the run log, the inbox and the report proxy. Never deployed.

Board at end of shift: **24/27 probes · mast 6.4/7 · rank HEARD · 0 blockers ·
REACH 2/5 · 5 open of 60 queue rows · preflight 14 checks, 1 standing decision.**

Three commits: `a41e935`, `c174068`, `37c5a03`. All with an explicit pathspec.

---

## BUILT

**Audited all 27 probes and strengthened 10.** The supervisor's steer was to look
for probes claiming *more* than they check, and that is where everything was.

- `name_chosen` asserted "HOLLOWMAST throughout README, VERSION and the site" and
  checked one of the three. **VERSION does not contain the name and never has** —
  it holds `0.1.0`. A green probe carrying a false statement about its own scope.
- `build_string` is the one that would have cost most. It grepped `^const BUILD`
  in `src/00_core.js`, where the value is the placeholder `__BUILD__` that
  `build.sh` substitutes on the way out — so it checked the stamp at exactly the
  point where the stamp has not happened. Had that `sed` ever stopped matching,
  every player would report the literal `__BUILD__`, two testers could no longer
  tell whether they were on the same bytes, and the probe would still have been
  green. Now keyed on the served bundle.
- Eight more: `cheat_flag` (three assertions, one bare word checked one),
  `telemetry_live` (claimed "reports are being collected", which nothing in the
  repository can know), `quality_toggle`, `donate_set` (said "a real URL",
  accepted any non-empty string), `crash_halt`, `ctx_lost`, `save_version`,
  `logo_made` (`-f` took a zero-byte card, now `-s`).

**Surfaced two hidden residues on the workshop surface.**

- `read-bugs.cjs` has always reported `skipped`, and the page rendered it *only*
  when nothing was open. Measured: 65 entries seen, 7 open, **22 skipped** — so
  the page said "7" while a third of the tracker was unclassified, and the honest
  range was 7 to 29.
- `read-requests.cjs` computes three residues — an unparsed line, an event whose
  `re` matches no row, an unknown event kind — and **none had ever reached a
  page**. The middle one is the point: a dangling event is a reply written to a
  row that is not there, an answer nobody will ever read, dropped by the fold
  without a word.

**Fixed a two-author defect found while wiring that up.** The requests tile's
note is written twice — once from the stamped STATE, once by `renderReq()` after
the live inbox answers — and the second write overwrote the first wholesale. Both
now compose through one `rqNoteFor()`.

**Corrected CLAUDE.md.** It said `G.settings.telemetry` defaults to `false`.
Source and served bundle both say `true`, and `f66773f` — the owner's own
reversal — is the last commit to touch it. The paragraph was describing a state
that lasted part of one afternoon.

---

## VERIFIED

**Every probe replacement was tested two-sided before it shipped**: passes on the
real tree, and *fails* on a copy with the asserted thing removed. 10 of 10. A new
check that cannot fail is the defect I was fixing, so shipping one untested was
not an option.

**Probe pass A — does the check match prose?** Comments-only copy of every file a
probe reads, check re-run against it. 20 testable, 0 still passed. Residue: 7
skipped as existence checks, and `name_chosen`'s control was **void, not clean** —
it reads a markdown file, which a comment-stripper empties, so its failure proved
nothing. 19 genuinely tested, not 20.

**The requests residue was verified by forcing the false case**, because with all
three residues at zero the change renders nothing and "working" and "inert" look
identical. Doctored STATE in blob iframes, nothing on disk touched: no residue →
plain note; one dangling → "1 reply to a row that is not there"; two → "2
replies". Three distinct arms.

**The first run of that control returned two identical arms** and I nearly read it
as "nothing to show". The fetch had been served from cache, so both iframes ran
the pre-edit file. The tell was that the arms agreed when they had no business
agreeing. `cache: 'reload'` is what exposed the `renderReq()` overwrite.

**I read all 22 skipped bug entries by hand** before changing the display, because
the fix is worthless if the count itself was wrong. Four have a status line the
regex misses, all four FIXED; 18 are old prose entries, all historical. The
board's 7 is correct — a *looked-and-it-was-fine* result, not *found nothing*.

Page audits after each change: layout self-test **both canaries caught, "audit is
live"**; live run 343 rules and 910 elements inspected, 0 sheets unreadable, 0
cascade clashes, 0 overflow; contrast 0 failures, 0 dead anchors, 45 roles.

---

## DEVIATIONS

**Three probes deliberately left with a known gap** — `touch_gate`,
`autosave_daily`, `f8_report`. Their only fixes are brittle line-shape greps that
break on a refactor, and a check that fails spuriously gets weakened by whoever
hits it next. A small honest gap beats a fragile check. Filed as S-1638 so the
call can be overturned rather than rediscovered.

**BUGS.md untouched.** B057's header was edited into a shape the parser cannot
read, which took the entry out of the count silently. It belongs to the game
session and this side only ever reads it, so it is reported (S-1650), not fixed.

---

## RISKS

**`dash/run-log.jsonl` carries a false entry at 16:02 reading pass:22**, between
two reading 24. The project did not regress. That was my own earlier control
neutering the sends in the **live** `src/07_report.js` while a stamp happened to
run. The file was restored and verified byte-identical — **and that was not
enough**, because the side effect landed in an append-only log written by
something else while the mutation was live.

Verifying you put a file back does not tell you what observed it while it was
out. The line stays: `run-log.jsonl` is the only file here that cannot be
recomputed from a clone, and deleting an inconvenient entry is precisely the
rewriting `requests.jsonl` was fixed to stop. Cause recorded on S-1638.

Everything today was tested on a **copy** for this reason, which now has evidence
behind it rather than caution.

**A two-authors sweep of all six pages returned a null result** — 10 candidates,
0 real. But it only matches an id literal on the same line as the write, so it
under-reports, and the bug that prompted it writes through a variable and would
**not** have been caught. It found nothing new; it does not show nothing is there.

---

## NEXT

- Re-run the probe two-sided test whenever a probe is added. The pattern is in
  S-1638; the scripts are in this session's scratchpad, deliberately not added to
  `dash/` — a checker nobody runs is a surface to feed.
- The mast's `frac()` in `index.html` returns 0 for a null denominator, the same
  shape B057 was filed for. Latent: every `of` is hard-coded but one, so it needs
  a source edit to trigger. Worth making unrepresentable rather than tuning.

---

## BLOCKED ON YOU

**Three probes fail, all of them one post each, and none of them is engineering.**
`posted_devlog`, `posted_bluesky`, `posted_reddit`. Copy is already written —
`LAUNCH-COPY.md` for launch day, `SOCIAL-POSTS.md` for the four weeks after.
Record each one with `dash/record-channel.ps1`, which refuses to record anything
that does not answer 200, so the board cannot be talked into believing a post
exists.

The Bluesky **banner still does not exist** — nothing generated is 3:1. Prompt is
in `ASSET-PROMPTS.md`.

`worker/purge-test-reports.ps1` is still unrun; it lists what it would delete
before touching anything.

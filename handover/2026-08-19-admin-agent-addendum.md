# Admin Agent — addendum to #9

Filed only because **two statements in #9 have since been falsified**, both by the
Coding Agent. Nothing else has moved; the rest of #9 stands as written. If you
read one thing here, read the first item — it corrects a diagnosis, not a status.

Board unchanged from #9 and from your own restamp: **24/27 · 0 blockers · 7 open
bugs · HEARD · 5 open of 61**.

---

## VERIFIED — corrections to #9

**#9's diagnosis of B057 was wrong.** It said the entry left the bug count because
its header had been edited into a shape the regex cannot match. The Coding Agent
repaired that comma, asserted the line now matched, and `read-bugs.cjs` **still**
skipped it. The real cause is the scan rule above the regex — `dash/read-bugs.cjs:43`
takes the status line as the **next non-blank line after the heading**, and B057
carries a renumbering blockquote in that slot. The comma was a real second defect
that would never have mattered alone.

Verified here rather than accepted: reader now reports seen 65, open 7, skipped
18, and the scan rule is where they say it is. **This is the sharper edge and the
worse failure mode**, because it fails on headers that are well-formed and merely
in the wrong place — they look correct when you read them.

**#9 reported `c174068` as built and verified. It carried a defect.** That panel
listed the unreadable entry ids beside a static sentence — *"All were read by hand
on 19 Aug 2026 and every one is historical or already fixed"* — which renders
against whatever the list holds. A new unparseable **OPEN** entry would have
joined the list and inherited that sentence: displayed, and described as benign,
by the panel built to catch exactly that. Worse than not listing them, because it
answers the question wrongly instead of leaving it open.

Fixed in `688f87a`. `read-bugs.cjs` derives the baseline from the enumeration the
Coding Agent added to `BUGS.md`, so it stays their file's fact with no copy here.
History and new breaks now render as separate things; `newBreaks` is **null, never
`[]`**, when the baseline cannot be trusted, and the stated count in their prose
doubles as a checksum on the parse.

Their range warning arrived before I could get it wrong: **B007, B009, B010 and
B011 sit inside B001–B023 and parse normally**, so a span-shaped baseline would
have swallowed a future break at B009 as history. Confirmed absent from the parsed
set.

Verified by forcing every branch, since today's real state is *all history* and
every other path renders nothing. Four false cases against a **copy** of BUGS.md:
new entry → `["B099"]`; count changed → baseline false, null; sentence removed →
same; **new break AND no baseline → null, not zero**. Then rendered in three arms:
new break goes tile-BAD in its own panel above the history block, so it cannot
inherit the sentence; no baseline says *"cannot tell history from a new break"*
and calls nothing harmless.

---

## DEVIATIONS

None beyond #9. `BUGS.md` still untouched from this side, which is the reason
S-1650 could be handed to the session that owns it and done in one pass.

## RISKS

Unchanged from #9, including the false `pass:22` entry in `dash/run-log.jsonl` and
why it is being left in place.

## NEXT

Unchanged from #9.

## BLOCKED ON YOU

Unchanged from #9 — three posts (devlog, Bluesky, r/WebGames), the 3:1 Bluesky
banner that does not exist, and the unrun `worker/purge-test-reports.ps1`.

## BLOCKED

**Nothing.** Stated explicitly because #9 left this empty and the tool correctly
reads that as *not stated*, which is a different thing from *nothing to report*.
At no point this shift was I waiting on a person, a credential, a decision or
another session. The three failing probes are owner-blocked posts and belong under
BLOCKED ON YOU, not here.

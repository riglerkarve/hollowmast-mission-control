# Auto Play Agent — 19 August 2026

**Correction to the shift-end brief before anything else: the three arms DID
finish and were read out.** The instruction to stop assumed they were mid-flight
at 3/6 with an ETA of ~18:40. They completed at 6/6 each and their comparisons
are below. What is genuinely partial is a *fourth* arm, `toolHigh`, launched at
18:30 after the third one produced a result that invalidated its own placement.
Reporting a finished measurement as unfinished would have been the same class of
error as the reverse.

## Built

- **`towerTask` census** (`0978b0d`) — counts every exit from the tower task by
  name: `entries`, `need.<item>` with the shortfall, `paid`, `noMast`, `park`,
  `interact`. Wired explicitly into `dump()`, because B060 showed a counter that
  never reaches the artefact reads exactly like one that never incremented.
- **`split.cjs` extended to the bar** — reports `towers` (parsing the `"N/3"`
  string, which arithmetic turns to NaN) and `won`. Proven able to detect a real
  tower rather than merely print zeros: `L70off → L70on` reads 0.0 → 0.2, +0.17.
- **Pre-registered verdict criteria** (`c8a1b91`), committed before any results
  existed, including the prediction that both arms would read null on towers.
- **B066, B067, B068** filed with evidence.

## Verified

**The tower question is answered.** `towerTask` is asked **804 times across 3
seeds × 70 days and pays 0 times.** `entries` 231/246/327, `paid` 0/0/0,
`noMast` and `interact` 0 everywhere — so routing, parking and the per-seed
`RADIO_COST` re-roll are *exonerated*, not merely un-implicated. The blocker is
electronics, and the shortfall reads **`N short of N`** at 99% of entries: the
bot does not hold one. `make # Electronics` is the largest abandonment in the
data — **713 across three runs, 542 ending `died: bleeding`**.

**`kitBack` — the kit row, measured on the new bar. 6 pairs × 70 days.**

| vs control | delta |
| --- | --- |
| structures built | **−1.67 [−2.52, −0.81]** significant |
| deaths | −127.33 [−329.32, +74.66] — not significant |
| gathered | +1140.00 significant |
| **towers** | 0.0 → 0.0 |
| beats closed well | −0.50 [−1.95, +0.95] |

Pre-registered criterion was *restore only if towers rise, or deaths fall AND
towers stay flat*. Deaths did not fall significantly, towers are zero both
sides, structures are significantly worse. **The bar change did not invert the
answer. Recommendation: leave the kit row out.**

**`toolFetch` (B068) — 0.00 on every metric, CI [0.00, 0.00], six pairs.** On
deterministic runs that is not a null result, it is proof the code path never
executed. The rung landed at line 2177, below the `collector < 2` guard at 2157,
and the comment three lines above that guard already records it as satisfied by
no run on record. **I placed a fix beneath the one gate this file documents as
impassable.**

## Deviations

- **I proposed the wrong fix for the tower chain and left both on the record.**
  B066 argued accumulation and proposed a Storage Crate; the census showed the
  bot never acquires a single component, so banking answers a question the data
  does not ask. B067 supersedes rather than replaces it — the prediction was
  right and the remedy did not follow from it.
- **Applied a patch to the live tree while trying to dry-run it** (hardcoded
  path). Reverted immediately; the running census used a pinned copy, so nothing
  was contaminated. Later patches take the path as an argument.
- Broke `tools/verify-readout.cjs` with an escape crossing a `node -e` string;
  repaired in one line.

## Risks

- **My `git add BUGS.md` reported NINE staged files**, six another session's,
  including `site/play/index.html` at an already-shipped commit. Third occurrence
  of S-1558 today. Used `git commit --only`, never `--no-verify`. The part that
  makes it hard to catch: because I had *just run `git add` myself*, a nine-file
  report reads as my command misfiring rather than another session's index
  underneath mine — so the instinct is to distrust your own command and retry.
- **B063 recurs.** Dev bundle at 1.97 MB with **49 markers for 36 sources** from
  two concurrent builds. The guard caught it every time; nothing broken shipped.
  Ruled "leave it" last shift — a defect that keeps being caught is different
  evidence from one ruled on once.
- **The bar has almost no dynamic range.** Twelve runs × 70 days produced one
  tower. At six pairs an arm that helped and one that did nothing look identical.
  This is a limit of the design, not a result.
- Index at shift end holds six files staged by other sessions
  (`BUGS.md, CLAUDE.md, DESIGN.md, dash/requests.jsonl, src/10_input.js,
  tools/lostwork.cjs`). **Nothing of mine — left alone deliberately.**

## Next

- **`toolHigh` is IN FLIGHT and unfinished: 0 of 3 runs at 18:34**, launched
  18:30. It is `toolFetch` with the rung moved above the workbench and the
  collector guard, with an assertion that fails if it ever sits below that guard
  again. **Resume rather than re-run** — pinned tree and output at
  `…/7f6a25be…/scratchpad/toolHigh/`, patch at `scratchpad/patch-V-tool-fetch-high.cjs`.
  Completed arms for pairing: `scratchpad/{kitOffBar,kitBack,toolFetch}/soak-*.json`.
- If `toolHigh` moves the mechanism (picks crafted, benches built) but not
  towers, keep it as a defect fix and switch the measured proxy to the census
  `paid` count — attempts that *could* pay, which has real dynamic range where
  towers has none. The census is present in all four arms.
- B064 (bot answers cold, ignores heat) filed, measured at **zero** heat deaths
  in 12×70-day runs. Explicitly not worth expecting deaths from.

## What I learned

**A check you ran yourself is the hardest evidence to read honestly, because you
already know what it was supposed to say.** Running it converts a guess into a
belief *before* the output is read, so the having-tested is the mechanism, not an
aggravating detail. Five instances across two sessions in one day; two were mine
— I read a summary I had written instead of the queue file it described, and I
confirmed `report.drive` held twelve keys and called that a control, when twelve
keys was precisely the signature of the whitelist dropping my counter. In every
case the check ran, produced correct output, and the wrong thing was taken from
it. The remedy that works: **state what the output would look like if the claim
were false**, and if that is the same picture, the check is decoration.

Second, and it cost me an arm today: **a correct fix on an unreachable path is
indistinguishable from a fix that does nothing — except in the zeros.** An arm
returning exactly 0.00 with a zero-width interval on *every* metric is not a null
result on deterministic runs; it is a line that never ran. That signature is
worth recognising immediately, because the honest reading ("wrong placement")
and the lazy one ("the change did nothing") point in opposite directions.

Third: **pre-registration is what makes a null trustworthy.** Committing the
criteria and the expected outcome before the arms landed is the only reason
today's nulls read as the design's limit rather than as a failure to find
something.

## Blocked on you

**The kit-row question is ANSWERED, and the answer is unchanged — but the record
should say why it was asked.** `kitOff` removed the bandage row after four arms
showed it bought ~20 deaths and returned nothing on *beats*; the bar changed to
*towers/won* the same day, and B067 found the tower chain fails because the bot
dies mid-hunt for electronics. So the question was whether the bar change had
inverted an already-settled trade. **Measured: it had not.** Structures are
significantly worse (−1.67), deaths not significantly better, towers zero both
sides. **Recommendation: leave the kit row out. No owner decision needed unless
he wants to overrule the evidence.**

Logged as team_decision #8 and held for this measurement — the measurement
arrived. This is materially different from "nobody asked", which is the
distinction the `refused` counter exists to preserve.

**What does still need him, and is smaller:** the tower bar is gated on survival,
not planning, and four arms have now failed to move attrition. If towers are to
move this quarter, the constraint is likely game-side (electronics availability
or bleeding rates), which is outside a bot session's mandate.

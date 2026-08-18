# Published beginner exercise programmes — a catalogue, not a prescription

**What this is:** a list of programmes other people published, with links and verification
dates. Every entry says who published it, what it assumes you own, and when the link was
last confirmed to work.

**What this is not, and the boundary is deliberate rather than modest.** Backlog #30 asked
for workout advice. Its own rationale set the limit: *"this is the closest thing on the list
to advice about your body. Keep it to published beginner programmes with sources, never
generated prescriptions, and never adaptive to your health metrics."* So:

- **Nothing here was designed by Claude.** No sets, reps, weights or schedules are mine.
  Where a routine's structure is described, it is described as the publisher wrote it.
- **Nothing here reads `health_metrics`.** The 95 days of imported step and sleep data are
  not consulted, now or later. A programme that changes based on your body is advice about
  your body.
- **Nothing here is ranked or recommended.** There is no "best", no ★, no ordering by
  suitability. Ordering is by equipment needed, because that is a fact about the programme
  rather than a judgement about you.
- **This is not medical advice.** If something hurts, the programme is not the authority.

Verified **18 August 2026** by reading each source. Run `node tools/link-check.cjs` to
re-check; it distinguishes *gone*, *could not look*, and *fine*, which matters because five
of the NHS URLs below moved or died while other sites still linked them as live.

---

## Needs no equipment at all

### StartBodyweight — Basic Routine
`https://www.startbodyweight.com/p/start-bodyweight-basic-routine.html`
Published by StartBodyweight. Free, no signup, no account. Bodyweight progressions with
no bar required. Verified 18 Aug 2026 — reachable, free, and no signup wall.

### NHS — Strength exercises
`https://www.nhs.uk/live-well/exercise/strength-exercises/`
NHS England. Seven home movements: sit-to-stand, mini-squats, calf raises, sideways leg
lift, leg extension, wall press-up, biceps curls. Chair-based, no equipment.
**It is a page of exercises, not a programme** — measured, it contains no weeks, sessions,
progression scheme or equipment list. Use it as a movement reference, not a plan.

### NHS — exercise videos
`https://www.nhs.uk/live-well/exercise/aerobic-exercises/`
`https://www.nhs.uk/live-well/exercise/strength-and-resistance/`
`https://www.nhs.uk/live-well/exercise/pilates-and-yoga/`
What survives of the retired *NHS Fitness Studio*. Videos only, no programme structure.

---

## Needs somewhere to hang or row

### r/bodyweightfitness — Recommended Routine
`https://www.reddit.com/r/bodyweightfitness/wiki/kb/recommended_routine/`
Published by the r/bodyweightfitness moderators. Free, no paywall, no signup.

Full-body, three times a week with a rest day between sessions, explicitly not to be split
across days. Around an hour: a dynamic warm-up, six strength exercises worked in three
pairs, then a three-exercise core triplet.

Progression is the part that makes it a programme rather than a list — you pick a variation
at your current level, work three sets of five, add one rep per set each session until three
sets of eight with good form, then move to the next harder variation and drop back to five.
Isometric holds progress by time instead, advancing at thirty seconds. The wiki publishes
explicit reductions for beginners: fewer sets, more reps before progressing, or fewer days.

**Equipment, which is why this is not in the section above.** Something to row on is stated
as non-negotiable and explicitly unsubstitutable — a low bar, rings, a sturdy table, even a
knotted bedsheet in a door. A pull-up bar is needed once you reach that stage; parallel bars
are wanted though there are progressions around them.

The wiki names free logging apps and states that the routine should never be monetised — if
an app charges for it, don't use it.

Verified 18 Aug 2026, read in full.

---

## Running

### NHS — Couch to 5K
`https://www.nhs.uk/better-health/get-active/get-running-with-couch-to-5k/couch-to-5k-running-plan/`
NHS England / Department of Health and Social Care. Free. Nine weeks, three runs a week,
alternating walking and running, ending at thirty minutes of running.

There is a **free printable PDF** and a **free app** on both stores (`com.phe.couchto5K` /
`id1082307672`), published by DHSC at £0.

**Note the URL.** It lives under `/better-health/`; the old `/live-well/exercise/` path is a
genuine 404. Verified 18 Aug 2026 — nine week-headings present in the served page.

**This is the only surviving UK-official structured plan.** That is a finding, not a
preference — see the withdrawal below.

---

## Withdrawn — kept because other sites still link it as live

### NHS Strength and Flex — **no longer published by the NHS**
The plan page `https://www.nhs.uk/live-well/exercise/strength-and-flex-exercise-plan/`
returns a **permanent redirect** to the generic exercise hub. Verified 18 Aug 2026, and the
withdrawal was corroborated: three plausible replacement paths all 404, the hub's own
navigation contains no plan page, and two sibling retired pages redirect identically.

What survives on nhs.uk is a video library only —
`https://www.nhs.uk/live-well/exercise/strength-and-flex-exercise-plan-how-to-videos/` —
**fifteen** how-to videos with no programme structure at all (measured: zero occurrences of
podcast, week, session or equipment in the served page).

The **audio is now third-party**, on Podbean and Apple Podcasts. It is still titled *NHS
Strength and Flexibility*, but **the NHS neither hosts nor maintains it**. Anything
describing it as a current NHS resource is describing authority the NHS no longer holds.

An NHS regional site still carries the programme description, and its own links to nhs.uk
now redirect to the hub — a silent downgrade rather than a broken link, which is exactly the
kind of rot the checker exists to catch.

---

## The official guidance the programmes sit under

`https://www.nhs.uk/live-well/exercise/physical-activity-guidelines-for-adults-aged-19-to-64/`
NHS England, last reviewed 22 May 2024, next review 22 May 2027. Adults 19–64: at least 150
minutes of moderate or 75 minutes of vigorous activity a week; strengthening activities
working all major muscle groups on **at least two days a week**; spread across four to five
days or every day.

---

## What was searched and not found

**There is no NHS or gov.uk beginner gym, barbell or weights programme.** Searched on those
domains specifically. The NHS publishes guidelines and home videos; it does not publish a
structured gym programme. Every structured gym routine in circulation is community- or
commercially-published, so none of them carries official backing — worth knowing before
treating any of them as authoritative.

**Not covered here, and the gap is named rather than hidden:** gym and barbell programmes
(StrongLifts, GZCLP, 5/3/1 and similar) rest largely on a single community curator and were
not independently verified, so they are deliberately absent rather than listed unchecked.
NHS Wales, NHS Inform (Scotland) and HSC Northern Ireland were not searched — given NHS
England withdrew its only strength programme, a devolved-nation equivalent is the obvious
next place to look and nobody has looked.

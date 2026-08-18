# Handover — 18 August 2026, evening

Second handover of the day; the morning one is `handover-2026-08-18.md` and still
stands. Everything below was measured, not recalled.

---

## The one thing to read if you read nothing else

**Five capabilities were found built and never connected, in a single day.** Not
missing — written, exported, documented, and reached by nothing:

| Capability | State when found |
| --- | --- |
| `schedule.upcoming()` | returned exactly what a briefing wants; zero callers |
| `budget.breaches()` | zero callers |
| `safety.limits()` / `authorisedThisMonth()` | zero callers |
| `shell.js` abort signal | passed to every panel, consumed by none |
| `F8` bug report | advertised in the HUD *and* the settings panel, no handler |

**Grep for call sites before building anything.** Four of those five needed wiring,
not code. And the mirror image cost as much: **three of eight open bugs were already
fixed** — B047, B055 and B045 — so verify an entry before working it.

---

## What shipped

### Mission Control

| Commit | What |
| --- | --- |
| `48ca1e9` `36d4bda` `4f25932` | provenance: 13 in-process callers now attribute themselves; `schedule` added as a fourth actor |
| `d8f780a` `d55df5d` | deferred backlog items carry a re-check date; the briefing surfaces them |
| `33f44e4` | **Machine panel** — live CPU/GPU/RAM/disk at `/machine` |
| `97aa829` | **Analytics module** — site probes now, CSV import when you have tokens |
| `412a281` | ten panel reads were logging as `unknown` |
| `6f50ba8` | **backups were inside the thing they backed up** |
| `4047be3` `d0a3f64` `c084cd1` | **the briefing now asks 15 of 28 modules**, up from 8 |

### PrintProfit

`97518d9` `66c9603` `ced34be` `55cc689` `41fc335` — scaffolding removed from the live
buyer guide, and **CP-6 completed**: `printprofit@hollowmast.com` created, proved to
forward, and the legal pages published.

### HOLLOWMAST

`48ca1e9`…`c084cd1` in `Survive` — F8 now reports a bug and has a box to type in
(B058, B059), plus a full sweep of the tracker. **Already pushed and live.**

---

## What is on you

**1. PrintProfit CP-10 — and another session is on it.** Their `2884d86` is a £20
Microsoft Ads test. I have stayed off distribution. Their `5818b16` also found the
**paid spreadsheet shipping an 800% failure rate** — a buyer saw that and a $75
"articulated dragon" as the worked example. Fixed by them, before any traffic.

**2. Mission Control has no off-machine backup — M64.** I fixed what I could: the
database *and* a full git bundle now go out-of-tree, verified, with a non-zero exit
if nothing lands. Proved by restoring: 101 commits, identical HEAD, 129 files. But
`Win32_LogicalDisk` reports **one fixed drive**, so it survives losing the project
folder and not the disk failing. Either point `MC_BACKUP_EXTRA` at a synced folder,
or give the repo a private remote. **101 commits still exist in one place.**

**3. M65 — the schedule and the backlog hold the same commitments separately.** The
diary's three overdue items are backlog #47 and #48. My recommendation: the schedule
owns dates *other people* set, the backlog owns intent.

**4. M55 and #16 re-check on 1 Sept**, when rows attributed to `you` across all
`by_whom` tables should reach 20. It was **7 of 392** tonight.

---

## The briefing, as it now stands

Twelve sections, ninety lines, **every one silent unless it has something to say**:

```
What got done · Picked up from a past session · Diary · Body · Money left
The machine is tight · Goals — the next step · Alerts raised · Due today
Ledger · Spending · Mission Control
```

Live tonight: **three overdue diary items** (provisional licence 12 days, passport
photos 5 days, GP yesterday), £191.52 headroom *with* the incomplete-coverage
caveat, memory at 92.9%, and all five goals naming their next physical step.

**Income is silent while it is zero on purpose** — a £0 line every morning is one you
stop seeing, and then the morning it says £4.20 you skip that too.

**Mail was measured and rejected**: 93% of all mail is unread, 96% of the last week.
Unread cannot separate "needs you" from "normal" at any window. The helper was
deleted rather than left unused. The other twelve unwired modules carry their reasons
in the `briefing.cjs` header.

---

## Traps this machine set, beyond the morning list

- **Never pass code through bash.** Five times today a backtick or backslash was
  executed or eaten, and *every time the output looked right* — a readable commit
  message with words missing, valid JavaScript with four lines collapsed into one.
  Write the payload to a file and splice it.
- **`git add X` does not scope a commit.** `git commit` commits the whole index, so
  another session's staged files ride along. Use `git commit --only <paths>`, and
  check `git show --stat` afterwards.
- **A console buffer is not current state.** I filed a bug from errors that predated
  a fix. Reproduce before filing.
- **A cache TTL shorter than the sample it caches is a busy loop**, not a cache.
- **Requiring a module can start its background work.** `machine.js` spawned
  `nvidia-smi` and set a timer as a side effect of an import.

---

## Standing constraints, unchanged

I do not sign in, accept terms, complete verification steps, create accounts, or post
as you. Credential files are gitignored before they can exist, verified by grepping
the secret's **value**. Secret values are never printed. **"pineapple" means stop.**

Tonight I did change Cloudflare settings and send mail from your account — both only
after you gave explicit consent for those four specific steps, and I stopped at the
one that would have meant posting as you.

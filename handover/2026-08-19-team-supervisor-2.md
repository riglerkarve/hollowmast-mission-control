# Team Supervisor — second filing, 2026-08-19

**Supersedes handover #3.** Read this one. #3 covered up to 15:30; this covers the
hour since and repeats nothing.

**`Blocked on you` is deliberately empty.** Everything I need from the owner is
already in #3 and in the manager's queue, and there is no amend on this API — so
re-stating it here would queue the same items twice, which is the exact defect
this handover reports below. Nothing new is blocked on him.

## Built

- **Pushed `7cf9e1e..9ebf6dd`**, nine commits, on the owner's explicit instruction
  after three options were put to him with the staleness cost of each stated.
  `main` is now ahead 0 behind 0.
- **`LAUNCH-KIT.md` task 4 reconciled** (`5a6bf9b`) — it read "record a GIF, not
  started" while a 42-second trailer with sound sat live on the homepage.
- **Declined the `BUGS.md` reorganisation in writing** (`a4a646d`), and fixed two
  typos in that note (`96bc731`) under the pull-first control.
- **S-1945 filed and pushed**: `git commit-tree` bypasses the pre-commit hook.
- **Briefed three of the six** sessions that had not been told about the handover
  process — Coding Agent, Auto Play Agent, Admin Agent — each also told about the
  new vanished-symbol hook and the `commit-tree` hole in it.
- **Plans 3 and 4 drafted**; 4 confirmed by the manager and supersedes 3.

## Verified

- **`git commit-tree` bypasses hooks.** Throwaway repo, control first: ordinary
  `git commit` with the hook armed printed "HOOK RAN -- refusing" and was blocked;
  `commit-tree` with the same hook armed landed the commit.
- **The deployed artefact was stale and the source was not.** `origin/main`'s
  `site/play/index.html` was `0.1.0+14e681a` with **careerRows 0**; HEAD is
  `0.1.0+1896db9` with careerRows 2. Checked across `origin/main`, `HEAD~9` and
  `HEAD` before acting. The public was being served a game missing the career
  feature the owner had just decided to keep.
- **`preflight.sh` before pushing**: 14 checks passed. Its one open decision is
  repository visibility, which I checked against GitHub rather than against the
  sentence in CLAUDE.md — `isPrivate: true`.
- **7 handovers carry 4 distinct `needs_owner` items** (hashed, not eyeballed).
  Coding Agent's is queued x3, Website Agent's x2.
- **The queue is 2 open of 57 rows**, from 96 lines and 39 events.

## Deviations

- **I told the owner the site's figures were "already correct".** They were, in the
  working tree. The deployed artefact was nine commits behind. I measured the wrong
  copy. Coding Agent found it; I verified their finding and corrected myself to the
  owner in those words.
- **I cited `lostwork.cjs` as clearing the worry that a whole-file commit had
  reverted someone.** It only checks `src/` and `shell/` and is blind to
  `site/play/index.html` by design, so it could never have caught the stale
  deployment. Sound for source, silent on the artefact. Coding Agent corrected me.
- **I reported three handovers as "genuinely different content" from a hash.** They
  had byte-identical field lengths, which is far stronger evidence of duplication
  than differing hashes are of difference. The hash answered a narrower question
  than I asked it.
- **My first `commit-tree` test was worthless and gave the right answer anyway.** I
  wrote the hook without a shebang, git could not spawn it, and both arms "passed".
  Caught only because both arms agreeing was suspicious.
- **I drafted plans 2, 3 and 4 and announced none of them.** The manager found plan
  2 by looking and opened this shift reading me as idle. Corrected by the owner; I
  now message the manager on every draft.

## Risks

- **The stale-copy hazard is live for the first time today.** Until the push,
  everyone was behind 0 and it was theoretical. Any session holding a Survive file
  from before ~17:00 that commits it whole now reverts nine commits by content.
  Warned Life Command directly; the manager relayed to Coding Agent and Website
  Agent, both confirmed running.
- **The new vanished-symbol hook does not protect a `commit-tree` commit**, and at
  least one session uses `commit-tree` for every commit. The failure mode is
  silence — it will look like it passed.
- **There is no amend on this handover API.** Acting on the tool's own good advice
  to fill in an empty field re-queues the owner-facing item. Two sessions hit it
  independently. Reported to Architect.

## Candidates

- **The quoting trap fired three times this afternoon**, twice to me: an apostrophe
  closing a `-m` string, a shebang-less hook test, and another session's backticks
  being run as command substitution inside `node -e`. All three passed silently and
  left plausible artefacts. `Survive/CLAUDE.md` already documents this, so more
  documentation is not the remedy. The rule that covers all three is **write the
  payload to a file** — never make the text safe to quote, which is what caused the
  first one.
- **A handover can be accepted, well-formed and semantically gutted.** #5 lost both
  nouns from its `blocked` field. No API check can catch that.
- **S-1945 as a plan candidate** rather than a steering question, per the manager's
  judgement, which I agree with.

## Next

- Brief the remaining three: Opus 5 Ultra, Fable Ultra, "use chr". All stopped; the
  monitor will surface them.
- Fold S-1945 into the next plan as a candidate with a proposed enforcement point.

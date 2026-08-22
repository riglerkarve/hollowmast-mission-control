# Codex Worker — M149 structured owner decision register

## Built

- Added `brain_decisions` to the existing Second Brain module rather than a new module or
  competing store. Each record has venture, decision, rationale, cost if wrong, revisit
  condition, optional dated recheck, evidence, and an optional superseded decision.
- Added local API endpoints:
  `POST /api/brain/decisions`, `GET /api/brain/decisions?venture=…`, and
  `GET /api/brain/decisions?due=1`.
- The due endpoint exposes `due` versus `none-due` explicitly and keeps future, undated,
  malformed, and superseded decisions in named residue. Prose is never guessed into a date.
- Regenerates `_decisions.md` in Claude's memory directory from the database, making the
  owner-authored structured decisions visible to local sessions without allowing this route
  to edit hand-maintained Claude memory files.
- Marked M149 `in_progress` through the audited backlog PATCH route. The backend is complete;
  the Brain panel is currently being edited in another session and should add the form/list
  only after those changes are settled.

## Verified

- `node tools/verify-brain-decisions.cjs` passed decision creation, invalid-date rejection,
  due retrieval, venture filtering, and generated-register content.
- The verifier used and removed
  `C:\Users\jcwhi\AppData\Local\Temp\mc-brain-decisions-n45fuI`.
  It used a temporary memory directory and temporary database; it did not open or write
  `data/dashboard.db` or the real Claude memory directory.
- `node --check server/routes/brain.js`, `node --check tools/verify-brain-decisions.cjs`,
  and `git diff --check` passed.

## Blocked on you

- None.

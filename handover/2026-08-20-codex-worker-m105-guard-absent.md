# Codex Worker — M105 commit-guard audit

## Built

No code was changed. M105 was claimed by CODEX, checked read-only, recorded on the board, and closed as a completed verification task.

## Verified

**Result: the pre-commit guard is not installed, so it cannot stop stale-file reverts at commit time.**

Reproduction (read-only):

```powershell
$hook = git rev-parse --git-path hooks/pre-commit
Test-Path $hook
git config --get core.hooksPath
```

`$hook` resolves to `.git/hooks/pre-commit`; it does not exist, and there is no configured alternate hook path. `tools/vanished.cjs` exists, but it is only a manually invoked detector. `tools/verify-suite.cjs` independently states its manual-only reason: “the configured pre-commit hook is currently absent”.

No source file was staged, edited, or reverted. No test opened or wrote `data/dashboard.db`.

The board note is `todo_notes` #211 on M105. M105 is marked done because the requested audit has a definite result.

## Blocked

The unattended-week plan requires stopping when a check uncovers a failure not caused by this session. This is a pre-existing failed protection boundary. Do not treat the detector's historic replay result as evidence that live commits are protected while the hook is absent.

## Deviations

`task-start` routed M105 as `opus / high` because it touches git history. I performed only a read-only configuration audit and did not stage the task's planned synthetic deletion once the missing hook made the claimed automatic protection impossible.

The user also requested a per-venture safety-ceiling design and interactive backlog controls for Remote Control. Source inspection found that the existing Backlog panel already updates task priority/status and has a single `todo_items` API writer, but it does not offer reassignment for an existing row. No implementation was begun after the failed M105 check.

## Blocked on you

None.

## Next

Decide whether to install and validate the commit hook before relying on `vanished.cjs`; run its stale-revert test only after it can actually run automatically. Then scope Remote Control as an extension of the existing Backlog panel/API: add an existing-task owner control with an append-only audit note, rather than create a second task store.

# M71 — `briefing.cjs --dry` is genuinely read-only

## Built

- Chose option (a): `--dry` now produces a genuinely read-only preview from stored data.
- Updated `scripts/briefing.cjs` usage text and the rendered preview to state that Gmail sync, queued work, the `CLAUDE.md` count stamp, and access logging are skipped; the preview may therefore be stale.
- Guarded the ordinary side effects behind the non-dry path. The dry path also records SQLite's connection-local `total_changes()` before and after fact gathering and exits non-zero instead of claiming read-only if it observes a write.
- Added the process-local `MC_DISABLE_ACCESS_LOG` guard in `server/db.js`, because the access log otherwise turns sensitive-table reads into a persistent database write.

## Verified

Before the final dry run:

```text
git status --short
 M handover/2026-08-19-website-agent.md
 M public/panels/brain/brain.css
 M public/panels/finance/finance.css
 M public/panels/finance/finance.js
 M public/panels/focus/focus.css
 M public/panels/projects/projects.css
 M public/shared.css
 M public/shell.css
?? handover/2026-08-19-admin-agent-addendum.md
?? handover/2026-08-19-coding-agent-evening.md
?? handover/2026-08-19-opus-5-ultra.md
?? handover/2026-08-19-use-chr.md
?? tools/read-hollowmast-telemetry.cjs
gmail_messages=69112
```

Final command:

```text
node --check scripts/briefing.cjs
node --check server/db.js
node scripts/briefing.cjs --dry 2>&1 | Select-String -Pattern 'dry-run:|Dry run|REFUSED'
```

Output:

```text
dry-run: Gmail sync, queued work, CLAUDE.md stamp and database access logging skipped; preview uses stored data and may be stale
> **Dry run — read-only preview.** Gmail sync, queued work, the CLAUDE.md count stamp, and database access logging were not run. This uses the current stored data, so it may be stale.
briefing_exit=0
```

After that run:

```text
git status --short
 M handover/2026-08-19-website-agent.md
 M public/panels/brain/brain.css
 M public/panels/finance/finance.css
 M public/panels/finance/finance.js
 M public/panels/focus/focus.css
 M public/panels/projects/projects.css
 M public/shared.css
 M public/shell.css
 M scripts/briefing.cjs
 M server/db.js
?? handover/2026-08-19-admin-agent-addendum.md
?? handover/2026-08-19-coding-agent-evening.md
?? handover/2026-08-19-opus-5-ultra.md
?? handover/2026-08-19-use-chr.md
?? tools/read-hollowmast-telemetry.cjs
gmail_messages=69112
```

`git diff --check` exited 0. No `CLAUDE.md` change appeared in either status capture; the only new tracked modifications were this task's two source files.

## Deviations

- The full dry preview emits unrelated `git` "dubious ownership" diagnostics while its projects accessor inspects sibling repositories. It still exited 0 and is unrelated to M71; no safe-directory configuration was changed.

## Risks

- The chosen design intentionally trades freshness for a truthful dry-run guarantee. A dry preview can omit newly arrived Gmail and queued-work results until a normal scheduled run.
- `MC_DISABLE_ACCESS_LOG=1` is process-local and opt-in. It must remain reserved for callers that explicitly promise no persistent writes; using it in a normal importer or server process would create an audit gap.

## Next

- No further M71 work is needed. A future test harness could assert `--dry` preserves the mail-row count automatically.

## Blocked

- Cannot commit: the sandbox denies writes to `.git` (known M75). The working-tree changes to commit are `scripts/briefing.cjs` and `server/db.js`; this handover file is also uncommitted.

## Blocked on you

- Nothing.

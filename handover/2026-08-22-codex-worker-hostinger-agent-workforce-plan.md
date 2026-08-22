# Codex Worker — Hostinger agent workforce plan

## Built

- Wrote `documents/hostinger-agent-workforce-plan.md`, an implementation-ready, stage-gated plan for extending the existing Mission Control team with a Hostinger-hosted Hermes worker and Buzz relay.
- Kept Mission Control as the only board, approval route, and authoritative decision store. Buzz is the deliberately selected chat surface and owns message delivery/history; Hermes owns its hosted session and runtime state.
- Defined the Hostinger topology, local outbound-only bridge, role routing, job contract and state machine, security boundary, seven implementation stages, operational recovery, deliverables, and explicit non-goals.
- Recommended Hostinger KVM 2 and the Ubuntu 24.04 Docker template from current Hostinger documentation; did not invent a purchase price or API model budget.
- Revised the plan on owner direction to select Hermes Agent as the persistent hosted worker and Buzz as the hosted human/agent chat relay.
- Removed the proposed custom control API, PostgreSQL queue and scheduler from the pilot. Buzz now owns message delivery/event history, Hermes owns hosted session/runtime state, and Mission Control remains the only work/approval authority.
- Added the official Hermes Buzz adapter, one-identity/one-home rule, owner-only public-key access, role-scoped Buzz channels, Nostr key custody, stable relay-hostname gate, Hermes restart/reconciliation behaviour, and a signed Mission Control assignment envelope that free-form Buzz chat cannot bypass.
- Revised the plan again on owner direction to use all three existing capacity sources: ChatGPT through Codex, Claude subscription through a separate Claude Code worker, and local qwen3.5:9b through Ollama/Scribe.
- Added a three-lane routing table, capacity-state vocabulary, no-surprise-API-billing rule, cross-engine review matrix, separate credential volumes, re-authentication-based restore, and staged tests for caps, expired logins, local offline state and reviewer unavailability.
- Kept Claude Code separate from Hermes because current Hermes documentation says its direct Anthropic OAuth path does not consume the base Claude Pro allowance and may use Max extra/overage credit. Hermes uses its documented ChatGPT/Codex OAuth path; Claude uses the official Claude Code browser login.
- Added a standard small-business structure with six operational seats: Team Manager, Operations Supervisor/Chief of Staff, Software Engineer, Research Analyst, QA & Risk Reviewer, and local Data Steward/Scribe. Added the org chart, engine assignment, authority/prohibitions, accountable-work matrix, shift cadence, factual business reporting and criteria for adding later departments.
- Applied the owner's explicit greenfield reset: the hosted workforce is `hosted-v1` and inherits no current workspace session, title, role, manager, assignment, project ownership or engine mapping. Existing records remain read-only history and require an exclusion report; any legacy/missing-workforce assignment is refused before Buzz.

## Verified

- Read the workspace `CLAUDE.md`, `mission-control/CLAUDE.md`, `mission-control/TEAM.md`, `Agent-AI-Integration-Guide.md`, and the existing work/team routes before planning. The result reuses the confirmed-plan gate, handovers, independent-engine review, local Scribe custody, one-board rule, and failure-state conventions.
- Checked current Hostinger primary documentation for VPS resources, Docker, firewall, backups and Buzz deployment; official Nous Research Hermes Docker/Buzz/provider documentation; official OpenAI Codex CLI sign-in/automation documentation; and official Claude Code installation/authentication documentation.
- Revised artefact check: `Bytes=40379`, `Lines=492`, `StageHeadings=7`, `SourceLinks=11`, `SelectedLanes=3`, `CoreSeats=6`, `HostedV1References=10`, `HasCRLF=True`, `BareLF=False`.
- `git diff --check -- mission-control/documents/hostinger-agent-workforce-plan.md` returned no output and exit 0.
- The gates cover relay membership, identity access, Buzz/Hermes restart recovery, restore onto an empty instance, replay/idempotency, local path refusal, stale/unreachable display, provider error distinctions, pre-egress sensitive canary refusal, same-engine review blocking, evidence inversion, and artifact-bound approval invalidation.

## Blocked

- Implementation must not start until Stage 0 confirms the permanent Buzz hostname, owner public identity, four initial lane fixtures, remote-source-access policy, and an external encrypted backup destination.
- ChatGPT and Claude are subscription-authenticated CLI sessions, not generic server API keys. Interactive device/browser authentication must be completed by the owner during provisioning; automatic API-credit fallback stays disabled.
- New remote-service dependencies (Buzz and Hermes images, Buzz CLI, and the chosen model provider/auth path) require approval before build under workspace policy.

## Deviations

- No second dashboard, tracker, or database was added. The plan is a document only.
- No current workspace team record, role or assignment was edited; the reset exists only in the future hosted-workforce plan until an explicit cutover gate.
- The plan deliberately keeps repositories local during the pilot. That means hosted code work requiring those repositories waits for the local bridge while the PC is offline; accepting a private Git remote later is an explicit custody tradeoff.
- No delivery-date or cost forecast was invented before the Stage 0 workload and provider decisions exist.

## Candidates

- The existing `work_items` and `team_*` schemas appear to provide most of the local integration surface. Before implementation, map their existing fields to the remote job contract and add only missing ownership references rather than creating parallel local records.
- KVM 1 may be enough for Buzz plus one Hermes instance, but KVM 2 is the safer pilot baseline. Treat any later KVM 4 upgrade as a measurement-triggered operations decision.
- Hostinger states Buzz has no browser chat client; the owner uses Buzz Desktop. The relay hostname determines community identity and must be selected before deployment.

## Blocked on you

None.

## Next

- Supervisor reviews the plan against the current team plan and board, then proposes a Stage 0 assignment.
- Manager confirms or returns that plan with a verdict and routes the four remaining material choices through the normal steering block.
- Once confirmed, implement Stage 0 only: Buzz hostname/public identity, one fixture per capacity lane, data classes, tool grants, authorship/review map, subscription-cap policy, and backup decision. Stop at its gate before provisioning the VPS.

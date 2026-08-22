# Hostinger AI Agent Workforce — Implementation Plan

**Status:** implementation-ready proposal — Hermes Agent + Buzz selected  
**Prepared:** 22 August 2026  
**Scope:** create a greenfield hosted workforce; do not inherit the workspace's current roster, roles or assignments; Buzz is the chat transport, not a second work board

## Outcome

Run an always-on, greenfield AI workforce on a Hostinger VPS using **Hermes Agent** as the persistent hosted router/worker and **Buzz** as the human-and-agent chat relay. The workforce uses the owner's **ChatGPT subscription through Codex**, **Claude subscription through Claude Code**, and **local Ollama model**. Mission Control remains authoritative for work, confirmed plans, approvals, handovers, and final decisions, but none of its current team identities, role labels, assignments, managers or project ownership rules are inherited. Buzz carries conversations, signed assignments, progress, and result links; it never becomes a second backlog.

The first production release is successful when it can take a confirmed plan, dispatch an allowed job, survive a worker or server restart without losing or duplicating it, return evidence and a handover, require an independent engine for review, and refuse sensitive or unauthorised actions before any data leaves the machine.

## Recommendation

Use a **Hostinger KVM 2 VPS** with the **Ubuntu 24.04 Docker template**. Hostinger currently lists KVM 2 as 2 vCPU, 8 GB RAM, 100 GB storage, and 8 TB bandwidth. KVM 1 could run Buzz plus one Hermes process, but its 4 GB RAM leaves little operating margin for the relay, agent gateway, sandbox, and upgrades. KVM 4 should be an upgrade triggered by measured resource pressure, not bought in anticipation.

Hostinger documents an Ubuntu 24.04 template with Docker Engine and Docker Compose preinstalled, a managed VPS firewall, and automated backups plus short-lived manual snapshots. These are the appropriate Hostinger facilities for this system:

- [Current Hostinger VPS resource limits](https://www.hostinger.com/support/6976044-parameters-and-limits-of-hosting-plans-in-hostinger/)
- [Hostinger Docker VPS template](https://www.hostinger.com/support/8306612-how-to-use-the-docker-vps-template-at-hostinger/)
- [Hostinger VPS firewall](https://www.hostinger.com/support/4805502-how-to-set-up-a-firewall-at-vps/)
- [Hostinger VPS backups and snapshots](https://www.hostinger.com/support/1583232-how-to-back-up-or-restore-a-vps-at-hostinger/)
- [Hostinger Buzz deployment](https://www.hostinger.com/support/how-to-install-buzz-on-a-hostinger-vps-using-docker/)
- [Hermes Agent official repository](https://github.com/NousResearch/hermes-agent)
- [Hermes Agent Docker deployment](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/docker.md)
- [Hermes Agent's official Buzz adapter](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/messaging/buzz.md)
- [Official OpenAI Codex CLI sign-in and automation](https://learn.chatgpt.com/docs/codex/cli)
- [Official Claude Code installation and subscription authentication](https://code.claude.com/docs/en/getting-started)
- [Hermes Agent provider compatibility](https://hermes-agent.nousresearch.com/docs/integrations/providers)

Do not use shared web hosting for this. The workforce needs long-running gateway processes, container isolation, controlled networking, and durable volumes.

Buzz currently requires its desktop app for chat; the hosted relay URL is not a browser chat interface. The relay hostname is part of the community identity, so choose the final hostname before admitting agents or users. Changing it later creates a separate Buzz community.

## Greenfield authority reset

This plan deliberately ignores the team currently assigned in the workspace.

- Do not import current session IDs, titles, roles, managers, assignments, project ownership, engine mappings, availability or reporting lines.
- Create a fresh roster namespace, `hosted-v1`, with new stable role IDs and one new Buzz/Nostr identity per externally visible seat.
- Existing team records and handovers remain read-only history. They may inform a work brief, but they grant no authority in `hosted-v1`.
- Open work may be referenced from the single Mission Control board, but its current assignee is discarded. The new Team Manager and Operations Supervisor assign it afresh.
- No current agent becomes manager, reviewer or owner of a function merely because it has that label today.
- The adapter refuses any assignment without `workforce_id: hosted-v1`, a current hosted roster member, and a plan confirmed under the new hierarchy.
- Planning this reset does not silently retire or edit the current workspace team. Cutover is a separate, explicit implementation gate after the hosted roster passes its tests.

The new workforce is therefore integrated with existing work records without being governed by the existing team configuration.

## System boundary

```text
Owner
  |
  v
Mission Control (authoritative board and approvals, local)
  |  confirmed, signed job envelopes
  |  outbound-only bridge using Buzz CLI / relay WebSocket
  v
Buzz relay on Hostinger
  +-- #manager       daily steering and approvals only
  +-- #team-ops      handovers and operational state
  +-- #jobs          one thread per immutable job id
  +-- #alerts        P0 and infrastructure failure only
  |
  v
Hermes Agent gateway on Hostinger
  +-- native Buzz adapter and agent identity
  +-- memory, skills, sessions and cron on its own volume
  +-- ChatGPT OAuth -> Codex models (primary hosted lane)
  +-- restricted non-sensitive hosted tools
  +-- final results back to the originating Buzz thread

Claude Code worker on Hostinger
  +-- separate Claude subscription login and credential store
  +-- independent author/reviewer lane
  +-- no shared Hermes home or provider token

Local bridge (outbound connection only)
  +-- local repositories and test tools
  +-- qwen3.5:9b through local Ollama
  +-- finance/wellbeing custody
  +-- import accepted results into Mission Control handovers
```

Buzz is a conversation and delivery surface, not another Mission Control. A message typed in Buzz is not automatically an authorised job. Executable work requires a signed assignment envelope referencing a confirmed Mission Control plan.

### One owner for every fact

| Fact | Authoritative owner | Other side's behaviour |
|---|---|---|
| Work item, priority, plan, approval | Local Mission Control | Buzz receives an immutable signed assignment and source reference |
| Conversation, delivery, thread event ID | Buzz relay | Mission Control stores only the link needed to retrieve the thread |
| Hosted session, skill, memory, runtime state | Hermes data volume | Mission Control imports only accepted results and handovers |
| ChatGPT capacity and Codex session | Codex/ChatGPT account and isolated hosted auth store | Hermes records only capacity state and result metadata |
| Claude capacity and Claude Code session | Claude account and isolated hosted auth store | Hermes delegates a job envelope but cannot read or reuse Claude credentials |
| Local-model capability and private inference | Local Ollama/Scribe | Hostinger sees only `local_offline`, `running`, or an approved non-sensitive result |
| Code and local project files | Existing local repository | Hosted agents cannot see them unless a later private Git remote is deliberately approved |
| Finance, wellbeing, journal, local credentials | Local machine only | The local bridge refuses the payload before transmission |
| Final decision and owner answer | Local Mission Control | Buzz may carry the discussion but is not the authoritative record |

No editable status is synchronised in both directions. Buzz messages are immutable events and Mission Control records only the accepted outcome. If the Buzz relay or Hermes gateway cannot be reached, Mission Control must say **unreachable / last checked at ...**, never show an empty queue.

## Roles and routing

Create a new `hosted-v1` worker → supervisor → manager reporting chain. These are new seats, not renamed current sessions.

1. **Supervisor** converts unread handovers and the board into a draft plan.
2. **Manager** confirms or returns it with a verdict. No confirmed plan, no dispatch.
3. **Router** chooses deterministic code, hosted Hermes/Codex, hosted Claude Code, local Scribe/Ollama, an explicitly allowed local CLI, or refusal. It uses an ordered decision table, not a weighted score.
4. **Hermes worker** receives only the minimum Buzz channels, tools, and non-sensitive data required for one job.
5. **Reviewer** must use a different engine from the author. Unknown authorship blocks review rather than being treated as independent.
6. **Manager** receives exceptions and unresolved owner items, posting at most the existing daily steering block in `#manager`.

Start with **one Hermes identity and one Hermes home directory**. Do not run two Hermes processes against the same data volume or Nostr private key. Additional team identities are added only after the single worker is measured; each receives its own Nostr keypair, Hermes profile/home, provider credential, channel allowlist, and resource ceiling.

## Three-capacity model routing

The three subscriptions/models are not interchangeable capacity. Route from privacy, capability and authorship before considering which lane has quota left.

| Lane | How it is used | Primary work | Must not do |
|---|---|---|---|
| **Local Ollama — qwen3.5:9b** | Existing local Scribe through the outbound bridge; no cloud egress | Measured classification, extraction, constrained drafting, finance custody, wellbeing proposals through review | Unmeasured jobs, final factual/code assertions, manager verdicts, independent review, internet-dependent work |
| **Claude subscription** | Separate Claude Code installation on the VPS, authenticated interactively with the owner's Claude Pro/Max account | Long multi-step implementation, architecture, supervisor work, and independent review of Codex/Hermes output | Review Claude-authored work; silently switch to Anthropic API billing after a subscription cap |
| **ChatGPT subscription** | Hermes `openai-codex` provider using ChatGPT device-code OAuth; direct Codex CLI remains available for purpose-built review | Hosted Hermes reasoning, systems/code work, routing, and independent review of Claude output | Review its own Codex/Hermes-authored work; silently switch to OpenAI API billing |

Official OpenAI documentation says the Codex CLI offers **Sign in with ChatGPT** and supports repeatable scripted use. Official Claude documentation says Claude Code accepts Pro, Max, Team, Enterprise or Console accounts through browser login. These are CLI subscription sessions, not generic server API keys.

Hermes documents direct ChatGPT/Codex OAuth support. Its documented Anthropic OAuth path does **not** provide the base Claude Pro subscription and may use Max overage/extra credits rather than base allowance. Therefore Claude subscription work runs through a separate Claude Code worker. Do not configure `ANTHROPIC_API_KEY` as an invisible fallback.

### Capacity and failover

- Record each lane as `available`, `rate_limited`, `auth_expired`, `local_offline`, `policy_refused`, or `unknown`; an empty result is not a capacity signal.
- A subscription cap pauses eligible work in `waiting_capacity`. It is not a failed job and does not automatically spend API credit.
- A job may move to another lane only if its data class permits that lane, the lane has been measured for that job type, and review independence still holds.
- Local Scribe is the continuity tier for measured local jobs when both subscriptions are capped. It cannot inherit work merely because it is the only lane available.
- Quota detection is declarative: use the CLI's explicit status/error output or a recorded cap event. Do not infer remaining allowance from recent success.
- Record author as both harness and underlying lane, for example `hermes/openai-codex`, `claude-code/claude`, or `scribe/ollama-qwen3.5:9b`.

### Review matrix

| Author | Required reviewer |
|---|---|
| Hermes using ChatGPT/Codex | Claude Code |
| Claude Code | Codex directly, not Hermes reusing the author's evidence summary |
| Local Ollama/Scribe | Claude Code or Codex, selected by task custody; never Ollama itself |

Unknown authorship blocks review. If the required reviewer is capped, the job waits; same-engine review is not accepted as a cheaper substitute.

## Business team design

Use the structure of a small professional services/software business: one accountable manager, functional specialists, independent quality control, and an administrative records function. Roles describe authority and expected output; they are not decorative personas.

```text
Owner / Director
  |
  v
Team Manager — Claude Code
  |
  +-- Operations Supervisor / Chief of Staff — Hermes + ChatGPT/Codex
  |     +-- Data Steward / Scribe — local Ollama
  |
  +-- Product & Engineering
  |     +-- Software Engineer / Coder — direct Codex
  |
  +-- Research & Intelligence
  |     +-- Research Analyst — separate Hermes research profile
  |
  +-- Quality & Risk
        +-- QA Reviewer — opposite engine from the author
```

The owner sets direction and makes irreversible decisions. The Team Manager is the only agent role permitted to interrupt or directly request a decision from the owner. Every other role reports through handover → supervisor → manager.

### Core roster

Stable role IDs are `team_manager`, `operations_supervisor`, `software_engineer`, `research_analyst`, `qa_reviewer`, and `data_steward`. Display names may change; IDs, authority and audit history do not.

| Seat | Runtime | Accountable output | Authority | Prohibited |
|---|---|---|---|---|
| **Team Manager** | Dedicated Claude Code profile using the Claude subscription | Confirmed/returned plan with verdict; one daily steering block; final priority and escalation decision | Confirm plans, return weak work, assign accountability, ask the owner through `#manager` | Production implementation, reviewing Claude-authored work, silently changing policy, bypassing the owner for irreversible actions |
| **Operations Supervisor / Chief of Staff** | Primary Hermes profile using ChatGPT/Codex | Shift plan from board + handovers; confirmed assignments; queue/capacity report; consolidated end-of-shift handover | Draft plans, dispatch only after manager confirmation, cancel safe pending work, route blockers | Contacting the owner, confirming its own plan, accepting worker claims without evidence |
| **Software Engineer / Coder** | Direct Codex worker using ChatGPT subscription | Focused code change, tests, evidence, touched-path list and handover | Edit only assigned repositories/paths; run allowed tests; prepare commit | Production deploy, merge/publish, dependency addition, broad repository cleanup, reviewing Codex/Hermes-authored work |
| **Research Analyst** | Separate Hermes profile/home using ChatGPT/Codex | Sourced research brief, facts vs inference, options, recommendation, uncertainties and excluded residue | Browse approved sources; prepare comparisons and decision briefs | Presenting unsourced facts, contacting people, purchases, account creation, treating research as owner approval |
| **QA & Risk Reviewer** | Dynamic: Claude reviews Codex/Hermes; direct Codex reviews Claude | Reproduced findings, acceptance result, untested scope and review verdict | Read artefacts, run non-destructive checks, return or accept against declared criteria | Same-engine review, editing the artefact under review, calling an unreproduced candidate a defect |
| **Data Steward / Scribe** | Local qwen3.5:9b through Ollama | Measured classifications, constrained drafts, private-data records and local capability report | Finance custody; wellbeing proposals through owner review; only measured job types | Internet access, manager verdicts, code/factual sign-off, unreviewed wellbeing enactment, sending private source data to Buzz |

### Accountable workflows

| Work type | Accountable | Responsible | Required check |
|---|---|---|---|
| Priorities and daily plan | Team Manager | Operations Supervisor drafts | Manager verdict before assignment |
| Code or infrastructure change | Team Manager | Software Engineer | Claude QA review plus tests against shipped artefact |
| Research or recommendation | Team Manager | Research Analyst | Independent source/claim check; inference labelled |
| Claude-authored architecture or management artefact | Team Manager remains accountable, not self-reviewing | Claude profile | Direct Codex review before enactment |
| Finance classification | Owner | Local Scribe | Deterministic rules first; unresolved suggestions enter review |
| Wellbeing record | Owner | Local Scribe proposes | Owner release required; no diagnosis, advice or score |
| Publication, spending, account, identity or production deployment | Owner | Relevant agent prepares only | Exact action and artefact require explicit owner approval |

### Shift cadence

1. Workers and Scribe file handovers with evidence, blockers, candidates and next work.
2. Operations Supervisor reads every handover and the single Mission Control board, then drafts the shift plan.
3. Team Manager confirms or returns the plan with a reasoned verdict.
4. Supervisor posts signed assignments into `#jobs`; one Buzz thread is one immutable `job_id`.
5. Coder, Researcher or Scribe executes within the assigned tool/data boundary.
6. QA uses the opposite engine and records reproduced findings or an explicit acceptance result.
7. Supervisor consolidates outcomes; Team Manager sends only the daily steering block or a genuine P0 interruption.

### Business reporting

The existing briefing should report facts, not a composite productivity score:

- completed assignments with evidence;
- work returned by the manager and the stated reason;
- review findings reproduced, rejected or still candidates;
- open work by accountable seat and age;
- subscription lanes available, capped, expired or unknown;
- local Scribe reachable and the measured capability set still current;
- jobs waiting for review, approval, owner action or capacity;
- failed/refused work and the unprocessed residue;
- last successful backup and last successful restore test.

### Seats deferred until demand exists

Do not create separate Marketing, Sales, Finance Director, HR, Security Officer or DevOps agents during the pilot. Marketing/content preparation can initially be a Research Analyst job; DevOps is a Coder specialism; finance custody remains with the local Scribe and owner; security is part of QA. Add a permanent seat only when real work repeatedly waits on that specialism and cannot be absorbed without breaking review independence or the interrupt budget.

Hard routing rules come before cost:

- Finance and wellbeing never go to Hostinger or a cloud model.
- Deterministic work uses a script, not a model.
- Reviews never share the author's engine.
- Publication, purchases, account creation, identity, payments, credentials, production deployment, and final merge require explicit human approval.
- A failed or refused job remains visible with its reason. It is never silently rerouted to a weaker or less-private model.

## Selected Hostinger components

Keep the first release deliberately small:

| Component | Responsibility |
|---|---|
| Buzz relay | Nostr community, membership, channels, message delivery and immutable event history |
| Buzz desktop app | The owner's chat client; also creates the initial public identity required by Hostinger setup |
| Hermes Agent gateway | Persistent agent, native Buzz adapter, model access, skills, memory, sessions and cron |
| Codex subscription auth | ChatGPT device-code OAuth stored only in the Hermes/Codex credential volume |
| Claude Code worker | Separate container/process, Claude subscription browser login, workspace and credential volume |
| Buzz CLI | Hermes outbound messages and the local Mission Control bridge |
| Hermes execution sandbox | Restricted terminal/file execution for hosted jobs |
| Backup job | Encrypted non-secret Buzz/Hermes/worker state, independently restorable; credentials are re-authenticated |

Do **not** build the custom control API, PostgreSQL queue, or scheduler proposed in the first draft. Buzz already owns delivery and Hermes already owns persistent sessions, cron, skills and memory. The pilot should add only a narrow Mission Control bridge and a Hermes skill that validates assignment envelopes. A custom execution ledger is reconsidered only if measured failures show that Hermes session state and Buzz event history cannot support the declared job contract.

Do not mount the Docker socket inside the Hermes or Claude worker container. Each runs non-root with a separate credential/state volume. Hermes receives a dedicated persistent `/opt/data` volume and uses a separate restricted execution sandbox with a temporary writable workspace, CPU/RAM/PID limits, a wall-clock timeout, safe write roots, and an explicit outbound-domain allowlist. Claude cannot read the Hermes auth store, and Hermes cannot read the Claude credential store.

## Job contract and state machine

Every executable assignment is posted as a signed Buzz event or attachment and carries:

- immutable `job_id` and idempotency key;
- source board reference and confirmed `plan_id`;
- declared author engine and required review engine;
- data classification and allowed egress destinations;
- tool grants, working scope, timeout, and maximum attempts;
- model/provider budget ceiling;
- expected output schema and acceptance command/check;
- approval requirements for any side effect.

The Hermes assignment skill enforces explicit transitions and posts each accepted transition into the originating Buzz thread:

```text
submitted -> policy_checked -> queued -> leased -> running
                                      -> refused
running -> awaiting_review -> awaiting_approval -> completed
        -> retryable_failure -> queued
        -> terminal_failure
        -> cancelled
```

Hermes records the active job and attempt in its own data volume before starting work. On restart it reconciles that record against the Buzz thread and either resumes safely or posts **recovery required**; it never guesses that an external side effect did not happen. Side-effecting tools require their own idempotency key so retrying cannot repeat a publication, message, or write. Buzz event IDs provide delivery de-duplication and a reproducible thread trail.

## Security baseline

### Network

- Open only HTTPS and restricted SSH in both the Hostinger firewall and the OS firewall.
- Disable SSH password login and direct root login after the initial bootstrap; use named keys.
- The local bridge initiates its own outbound authenticated WebSocket/HTTPS connection to the Buzz relay. Hostinger receives no inbound route to the home LAN.
- Do not publish Hermes port 8642 to the internet. Bind it to the internal Docker network or loopback; Buzz is its communication path.
- Restrict the Hermes Buzz adapter to the owner's and manager's public keys. Leave `allow_all_users` false.

### Secrets and data

- Give each provider and external tool a separate credential so one can be revoked without stopping the workforce.
- Mount secrets from root-owned files at runtime; never place them in prompts, job rows, images, repository files, or normal logs.
- Give every Hermes/Buzz identity a separate Nostr keypair. Store the private `nsec` only in its secret file; Buzz channels, Mission Control, logs and handovers may contain only the public `npub`.
- Authenticate ChatGPT/Codex and Claude interactively on the VPS using their documented browser/device flows. Never copy the desktop's complete Codex or Claude credential directories to Hostinger.
- Keep Hermes/Codex, Claude Code and Buzz private keys in separate volumes with separate Unix users and permissions.
- Exclude live OAuth tokens, Hermes `auth.json`, Claude credentials, `.env` files and Nostr private keys from application-level backups. A restore must require fresh login and identity-key recovery from the separately secured secret procedure.
- Redact known secret forms at intake and before log persistence, while treating redaction failure as **could not safely log**, not a clean result.
- Store no sensitive personal payload on Hostinger. Prefer references and derived non-sensitive facts over copied source material.
- Disable automatic API-credit fallback. Set provider spending ceilings outside the agent prompt as well as per-job limits inside the Hermes assignment skill.

### Tool authority

Default grants are read-only. Separate tools into read, draft, reversible write, and irreversible/external action. The worker cannot expand its grant. Approval is attached to the exact proposed action and expires if its content changes.

Treat web pages, email, documents, repository issues, and tool output as untrusted content. They can supply data but cannot grant permissions, reveal secrets, replace system rules, or approve an action.

## Implementation stages and gates

Each stage ends with something usable and stops at its gate. Do not begin the next stage in the same deployment window.

### Stage 0 — Identity, hostname and workload decisions

**Build**

- Record four initial fixtures: one deterministic scheduled job, one Hermes/Codex job, one Claude Code job, and one constrained local-Ollama job.
- Create the `hosted-v1` roster from the six stable role IDs in this plan. Generate an exclusion report counting every current workspace identity, role and assignment that was deliberately not imported.
- Define data classifications, tool grants, retention periods, provider budget ceilings, and explicit forbidden actions.
- Capture baseline examples and expected outputs before building the runner.
- Select the permanent Buzz relay hostname before deployment; changing it later creates a separate community.
- Create the owner's Buzz identity in the Buzz desktop app and record only its public `npub` for provisioning. The private `nsec` is never pasted into an online converter, plan, or chat.
- Approve the Buzz and Hermes images, Codex CLI, Claude Code, Buzz CLI, and their authentication placement.
- Declare the three selected lanes: Hermes with ChatGPT/Codex OAuth, separate Claude Code subscription worker, and local qwen3.5:9b through Ollama. Record that neither subscription may fall through to pay-as-you-go API billing automatically.
- Capture each subscription's plan identity without copying credentials and define what happens at a cap: wait, use another already-qualified lane, or refuse.

**Gate**

- Every initial job has an independent oracle or concrete acceptance check.
- The authoritative owner of every field is written down.
- No job requires Hostinger to receive finance, wellbeing, credentials, or an unrestricted local filesystem.
- The final relay hostname, owner public key, and backup destination are recorded; no private key is present in the artefact.
- A dry authentication test has named three distinct outcomes for each subscription: authenticated, rate-limited, and could-not-authenticate.
- The roster contains only new `hosted-v1` identities. The exclusion report distinguishes found-and-excluded current records from a failure to inspect them.

### Stage 1 — Secure Buzz relay

**Build**

- Provision KVM 2 with the Docker template.
- Apply SSH hardening, Hostinger firewall rules, OS firewall rules, unattended security updates, TLS, and clock synchronisation.
- Deploy Buzz from Hostinger's Docker Manager using the final hostname and the owner's public identity.
- Join from Buzz Desktop using the `wss://` relay URL; create `#manager`, `#team-ops`, `#jobs`, and `#alerts` with deliberately restricted membership.
- Verify relay health, membership enforcement, event de-duplication and reconnect behaviour before installing Hermes.
- Add resource limits and encrypted backups of the Buzz application data.

**Gate / evidence**

- A non-member cannot read or post; the owner can do both; the two outcomes are visibly different.
- Replaying one signed event does not create two visible messages.
- Restarting the relay preserves the four channels and their test events.
- Restore the Buzz state onto an empty test instance and compare channel/event counts and selected event IDs. A successful backup command without a restore does not pass.

### Stage 2 — Restricted Hermes/Codex and Claude workers

**Build**

- Deploy one pinned Hermes Agent container with one dedicated `/opt/data` volume and no Docker socket.
- Authenticate Hermes's `openai-codex` provider using the ChatGPT device-code flow. The owner completes the browser step; no ChatGPT password is entered into a file or chat.
- Install direct Codex CLI as the purpose-built review path and authenticate with ChatGPT in its own store.
- Install Claude Code in a separate worker/container and authenticate with the Claude subscription through its documented browser flow. Do not configure an Anthropic API key.
- Configure Hermes gateway mode, the official Buzz adapter, a dedicated agent Nostr identity, owner-only allowed users, and only `#jobs` plus `#team-ops`.
- Suppress interim reasoning and tool-progress chatter in Buzz; post final responses and declared state changes only.
- Install/build the Buzz CLI required by the official Hermes adapter and record its checksum/version.
- Run Hermes/Codex and Claude with read-only/default-deny tools first; no local bridge or repository access yet.

**Gate / evidence**

- Only the allowlisted owner/manager identities can trigger Hermes; another community member's mention is ignored/refused.
- Hermes survives a container restart with its identity, configuration, memory, ChatGPT authentication and test session intact.
- Claude survives a worker restart with its Claude authentication and test session intact, while remaining unable to read Hermes/Codex credentials.
- Hermes and Claude cannot reach the Docker socket, host filesystem, Mission Control, finance, wellbeing, or unapproved channels.
- A ChatGPT cap, Claude cap, expired login, Hermes outage and Buzz outage are reported as five distinct states.

### Stage 3 — Mission Control assignment bridge

**Build**

- Add one Mission Control Buzz adapter, not a new panel or queue. Existing team/work views produce a signed assignment event only after plan confirmation.
- Require `workforce_id: hosted-v1`; current workspace assignees and plans are never translated implicitly.
- Add the Hermes assignment skill that validates `job_id`, `plan_id`, source reference, data class, tool grants, budget, expected output, review engine, and approval requirements.
- Add the local outbound bridge with an allowlist of repository roots and commands plus the existing qwen3.5:9b Ollama route.
- Route finance and wellbeing only to the local Scribe path; no prompt, source row, or generated private content is copied to Buzz.
- Require schema-constrained result attachments and record the Buzz event/thread ID, Hermes version, provider/model, prompt/skill version, token use, duration and attempt.
- Import accepted results into the existing handover path; render live, stale, unreachable, empty, refused, failed and completed as distinct states.

**Gate / evidence**

- A plan without a manager verdict cannot produce an executable Buzz assignment.
- An otherwise valid assignment referencing a current/legacy session or missing `hosted-v1` is refused before it reaches Buzz.
- Replaying the same assignment event returns the existing job/thread rather than executing again.
- A forged local path is refused locally and never appears in the Buzz relay or Hermes logs.
- A sensitive canary payload is refused by the local bridge before any Buzz or model-provider request; remote request/event counts remain unchanged.
- Invalid schema, provider error, timeout, budget exhaustion, empty output and gateway disconnection produce different reasons.
- The measured hosted job clears its declared quality floor on the held-out oracle.
- The local model is offered only job types present in its unexpired measured capability list; an unmeasured assignment is visibly refused.

### Stage 4 — Independent review and approvals

**Build**

- Route review by declared author engine and block same-engine or unknown-engine review.
- Store findings as candidates until reproduced.
- Add approval records bound to an exact artifact hash and proposed action.
- Deliver the final result through the originating Buzz thread and existing handover/daily briefing paths.
- Keep the manager/reviewer independent of Hermes-authored work. Hermes may prepare the evidence but cannot approve its own plan, work or review.
- Enforce the review matrix: Hermes/Codex → Claude; Claude → direct Codex; Ollama → Claude or Codex.

**Gate / evidence**

- Inverting the evidence in a review fixture changes the verdict; identical verdicts block the reviewer capability.
- Changing an artifact after approval invalidates that approval.
- A refused review is displayed as not reviewed, never passed.
- Deliberately cap/disable each reviewer lane in a fixture and prove the work waits instead of falling back to its author engine.
- No worker can mention/DM the owner or post in `#manager`; only the declared manager identity can use that path.

### Stage 5 — Production pilot

**Build**

- Enable only the four measured job types for a two-week pilot.
- Begin with one Hermes/Codex job, one Claude job and one local job at a time; add concurrency only from measured delay, subscription capacity and resource headroom.
- Include yesterday's completed, failed, refused, retried, awaiting-review, and awaiting-approval counts in the existing briefing, with the unprocessed residue.
- Add alerts only for P0 conditions, repeated infrastructure failure, backup failure, or budget cutoff.

**Gate / evidence**

- No lost jobs, duplicate external actions, policy bypasses, or sensitive-data egress.
- Every completed job links to its plan, attempts, evidence, review status, and handover.
- Every Buzz conversation that caused work links to its immutable assignment event; free-form chat cannot bypass the plan gate.
- A full restore drill has been run after production data exists.
- The owner is doing less manual routing and checking. If the pilot adds a queue the owner must continually feed, stop and remove it.

### Stage 6 — Expansion by measurement

Add a job type only when a labelled sample and an independent acceptance check exist. Re-measure capability after model or prompt-version changes. Possible later additions are scheduled research briefs, inbox triage into a review queue, report generation, code review on an approved private remote, and website monitoring. Autonomous publishing, spending, account creation, and production merging remain out of scope unless separately authorised.

## Operations

### Deployment

- Pin Buzz, Hermes, Codex CLI and Claude Code versions and record image digests/checksums; never deploy `latest` to production.
- Build in CI or a controlled local process; deploy immutable images, not live-edited server files.
- Apply Buzz/Hermes/Codex/Claude upgrades as a separate, reversible deployment step after a Hostinger snapshot and independent sanitised exports. Exclude all live subscription and Nostr credentials.
- Use rolling replacement only after the single-instance path is proven; complexity is not availability.

### Backups

Hostinger's platform backup is one layer, not the restore proof. Keep encrypted, sanitised exports of Buzz state, Hermes memories/skills/sessions, and job evidence outside the VPS. Exclude ChatGPT OAuth, Claude credentials, Hermes `auth.json`, `.env` files and Nostr private keys; restore requires fresh subscription authentication. Test restoring without reusing a live Nostr identity concurrently. Hostinger states that automated backups may retain up to four copies and that a manual snapshot is temporary and only one is retained; snapshots are deployment checkpoints, not the sole backup strategy.

### Observability

Report relay health, Hermes gateway state, Claude worker state, local Ollama reachability, last accepted Buzz event, active jobs, attempts by outcome, container restarts, each subscription's declared capacity state, policy refusals, review backlog, approval backlog, last sanitised backup, and last restore test. Every filter reports what it excluded. A clean report must distinguish **looked and fine** from **could not inspect**.

### Upgrade triggers

Do not scale from a forecast. Upgrade or add worker concurrency only after the VPS shows sustained memory pressure, CPU saturation, or queue age breaching the agreed service target. Model inference remains with the two subscription services or the local GPU; the Hostinger VPS is an agent host, not a GPU inference host.

## Deliverables

1. Architecture decision record and threat model.
2. Hostinger provisioning checklist and recovery runbook.
3. Fresh `hosted-v1` roster, identity manifest, authority matrix and current-workspace exclusion report.
4. Pinned Buzz and Hermes containers plus verified Codex CLI and Claude Code installations, with separate persistent credential/state volumes.
5. Buzz community with new hosted identities plus four role-scoped channels.
6. Restricted Hermes Buzz gateway and assignment-validation skill.
7. Mission Control Buzz adapter and outbound-only local bridge.
8. Policy decision table and data-classification tests.
9. One deterministic, one Hermes/Codex, one Claude Code, and one local-Ollama job type.
10. Independent review and artifact-bound approval gates.
11. Relay/Hermes/Claude backup-and-restore, re-authentication, restart, duplicate-prevention, identity-access, capacity-state, and sensitive-egress evidence.
12. Two-week pilot report with residue and a separate go/stop/cutover decision.

## Decisions required before implementation

These choices materially change the build and should be confirmed at the Stage 0 gate:

1. **Permanent Buzz relay hostname.** Recommendation: use a dedicated subdomain decided before deployment; Hostinger warns that changing it creates a new community.
2. **Initial workload.** Recommendation: deterministic scheduled report + Hermes/Codex systems task + Claude implementation/review task + local constrained classification. This exercises all lanes without granting irreversible authority.
3. **Remote source access.** Recommendation: keep repositories local during the pilot. Add a private Git remote only if offline hosted code work is worth the new custody and merge workflow.
4. **External backup destination.** Recommendation: an encrypted destination independent of Hostinger, selected before production data is admitted.

## Explicit non-goals for the first release

- No second backlog or approval store. Buzz is a deliberate new chat surface selected by the owner, but it must not become another place work status is edited.
- No migration of current workspace team roles, assignments or authority into `hosted-v1`.
- No model hosted on the VPS for serious inference.
- No access to local finance, wellbeing, journal, browser sessions, or credential stores.
- No arbitrary shell endpoint, unrestricted Docker socket, or general-purpose remote desktop.
- No automatic purchase, post, message, account creation, identity action, production merge, or deployment.
- No autonomous Hermes skill installation or self-modification in the pilot; proposed skills enter review before activation.
- No claim of autonomy based only on jobs having run; the restore, refusal, review, and failure paths are part of the product.

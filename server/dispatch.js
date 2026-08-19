//
// dispatch.js — which agent, which model, how much effort, for one work item.
//
// Owner instruction, 19 Aug 2026: "Find a way to append each task a model and effort to use —
// the goal is to use the right tool for the right job and keep token expenditure minimal."
//
// DERIVED, NEVER TYPED, and that is the whole design. A `model` column somebody has to fill in
// on every item is a surface he must feed, which the workspace gate rejects outright — and it
// would be wrong within a week, because the item changes and the stored answer does not. This
// reads the fields an item already carries (kind, priority, cluster, project, the DET/LOC/FRO
// tier, and its own text) and returns a recommendation with the reason attached.
//
// IT IS A DECISION TABLE, NOT A SCORE. No weights, no points, no composite number. A score
// built from coefficients I chose is the one figure nobody can audit, and this project has a
// standing rule against presenting one as a measurement. Every rule below reads as a sentence
// you can agree or disagree with, and the FIRST matching rule wins so the outcome is traceable
// to one line rather than to an accumulation.
//
// THE CHEAPEST THING THAT CAN DO THE JOB IS THE DEFAULT. Escalation must be earned by a
// property of the task; de-escalation is free. The measured precedent is this project's own:
// on the real categorisation job, deterministic rules did 95.3% and the model 4.7%. So the
// first question is never "which model" but "does this need a model at all".
'use strict';

// What is actually available here, so a recommendation cannot name something that does not
// exist. Costs are ORDINAL, not prices — cheap/mid/dear — because I do not have per-token
// figures for a ChatGPT subscription and an invented number would be worse than an ordering.
const AGENTS = {
  script: { engine: 'none', cost: 'free', what: 'a .cjs script or a SQL query — no model at all' },
  // TWO LOCAL MODELS ARE INSTALLED and only one of them fits. The hardware ceiling is 8 GB of
  // VRAM on the RTX 5050 laptop, of which ~6.9 GB is usable in practice.
  //   qwen3.5:9b   6.6 GB  fits, with ~16% already spilling to the CPU. The measured one.
  //   gemma4:12b   7.6 GB  EXCEEDS the usable VRAM, so expect heavy CPU spill and a large
  //                        slowdown. Installed since the docs were written; it is offered
  //                        here as a fact, not a recommendation, and nothing routes to it
  //                        until somebody measures it against the same probe qwen was run on.
  // OLLAMA NOW MEANS TWO DIFFERENT PRIVACY DECISIONS, and one word for both is how a
  // governance rule gets lost. Until Ollama Pro, "local" carried an implicit guarantee that
  // the whole finance policy rests on: the data does not leave the machine. Ollama runs on
  // 127.0.0.1:11434, so sending it a bank counterparty is not disclosure.
  //
  // A cloud model reached through the same client, the same API and the same word is a
  // DISCLOSURE, and it looks identical in code. That is the same shape as a route that is
  // safe bound to 127.0.0.1 and publishes the ledger bound to 0.0.0.0 -- the mount inherits
  // its host's exposure, and the label does not change with it.
  //
  // So the tiers are named for WHERE THE DATA GOES, not for which client sends it.
  local: { engine: 'ollama', cost: 'free', private: true, what: 'qwen3.5:4b ON THIS MACHINE -- 100% on GPU, honours schemas, nothing leaves it' },
  'local-big': { engine: 'ollama', cost: 'free', private: true, what: 'gemma4:12b on this machine -- 7.6 GB against ~6.9 GB usable VRAM, unmeasured' },
  'ollama-cloud': { engine: 'ollama-cloud', cost: 'subscription', private: false, what: 'gpt-oss:120b-cloud via ollama.com -- OFF THIS MACHINE. 120B, ~1.25s, no VRAM ceiling, NO privacy guarantee.' },
  haiku: { engine: 'claude', cost: 'cheap', what: 'Claude Haiku 4.5' },
  sonnet: { engine: 'claude', cost: 'mid', what: 'Claude Sonnet 5' },
  opus: { engine: 'claude', cost: 'dear', what: 'Claude Opus 5' },
  // CODEX HAS TIERS TOO. The ordering below is the vendor's own wording, read out of
  // ~/.codex/models_cache.json rather than ranked by me:
  //   sol   "Latest frontier agentic coding model."
  //   terra "Balanced agentic coding model for everyday work."  <- the configured default
  //   luna  "Fast and affordable agentic coding model."
  // They map onto opus / sonnet / haiku, so the same cost discipline applies on both sides.
  //
  // codex-auto-review is NOT a code reviewer despite the name -- "Automatic approval review
  // model for Codex", i.e. it decides whether to approve a sandboxed command. Routing reviews
  // to it on the strength of the word "review" would be a name match, not a capability match.
  luna: { engine: 'codex', cost: 'subscription', what: 'Codex gpt-5.6-luna -- fast and affordable' },
  terra: { engine: 'codex', cost: 'subscription', what: 'Codex gpt-5.6-terra -- balanced, the configured default' },
  sol: { engine: 'codex', cost: 'subscription', what: 'Codex gpt-5.6-sol -- frontier' },
};

const EFFORT = ['low', 'medium', 'high', 'xhigh', 'max'];

// Text signals. Deliberately narrow: a word that appears in half the backlog is not a signal,
// it is noise wearing a regex.
const IRREVERSIBLE = /\bmigrat|schema|drop table|delete|credential|secret|api key|token|rotate|publish|post to|deploy|git history|force[- ]push|backup\b/i;
const AMBIGUOUS = /\binvestigat|diagnos|why |root cause|unclear|unknown|figure out|work out|research|explore|decide|design\b/i;
const MECHANICAL = /\brename|typo|wording|copy|label|comment|format|lint|bump|tidy|move the|spelling\b/i;

function has(item, re) {
  return re.test(`${item.title || ''} ${item.rationale || ''}`);
}

/**
 * @returns {{agent, model, engine, effort, cost, why, escalateIf, rule}}
 */
function dispatch(item = {}) {
  const kind = String(item.kind || '').toLowerCase();
  const pri = String(item.priority || '').toUpperCase();
  const cluster = String(item.cluster || '').toLowerCase();
  const text = `${item.title || ''} ${item.rationale || ''}`;

  const out = (rule, agent, effort, why, escalateIf) => ({
    rule,
    agent,
    model: agent,
    engine: AGENTS[agent].engine,
    cost: AGENTS[agent].cost,
    what: AGENTS[agent].what,
    effort,
    why,
    escalateIf: escalateIf || null,
  });

  // ---------------------------------------------------------------- hard rules first
  // These are not preferences and not economies. They come from decisions the owner made,
  // and a cheaper answer does not override them.

  // NOTHING SENSITIVE LEAVES THE MACHINE, and this rule exists because I asserted it in a
  // comment before writing it. The first version of the cloud tier said "the finance and
  // wellbeing prohibitions apply to it exactly as they apply to a frontier model" — wellbeing
  // was guarded below and FINANCE WAS NOT GUARDED ANYWHERE. A ledger item marked cleared
  // routed straight to ollama.com, and only testing the claim found it.
  //
  // A guarantee is only what the code checks. This is the check.
  //
  // Deliberately BEFORE the cloud rule and before every cost rule, because it is not a cost
  // decision: it is the owner's standing position that personal finance data going to a
  // frontier model is a reviewable disclosure, and ollama.com is one by destination whatever
  // the client is called.
  const SENSITIVE = /\bledger|finance|bank|transaction|statement|counterpart|salary|pension|credit rating|health|wellbeing|medical|mood|journal|credential|secret|api key|token\b/i;
  if (SENSITIVE.test(text) || ['finance', 'money', 'health', 'wellbeing'].includes(cluster)) {
    const priv = ['script', 'local', 'local-big'];
    // It may still use a LOCAL model — that is the whole point of having one — but never a
    // tier that leaves this machine, and never on the strength of a cleared flag.
    return out('sensitive data never leaves the machine',
      String(item.owner || '').toUpperCase() === 'LOC' ? 'local' : 'script', 'low',
      'This names finance, health, wellbeing or a credential. It may use a model that runs on this machine, because nothing is disclosed by doing so; it may NOT use ollama.com, Codex or a frontier model, regardless of any cloud clearance on the item. The owner allowed personal finance data to a frontier model under review, and "under review" means a recorded decision each time, not a flag on a backlog row.',
      `Never automatically. Escalating past ${priv.join('/')} here is the owner's decision, made deliberately and recorded, not a routing outcome.`);
  }

  if (cluster === 'wellbeing' || /wellbeing/i.test(text)) {
    return out('wellbeing is never a model', 'script', 'low',
      'Nothing in the wellbeing module may be generated by a model — not prose, not a pattern, not a risk score. That is fixed policy, not a cost decision.',
      'Never. If it cannot be done deterministically it is not done.');
  }

  if (/\.css\b|stylesheet|contrast|spacing|palette|theme|visual|layout/i.test(text)) {
    // The design system reaches all 21 panels; one panel's spacing reaches one. Same owner,
    // different blast radius, and that is the only thing separating the tiers here.
    const systemWide = /shared\.css|shell\.css|design system|token|all panels|every panel/i.test(text);
    return out(systemWide ? 'CSS, and it reaches every panel' : 'CSS belongs to Codex',
      systemWide ? 'sol' : 'terra', systemWide ? 'high' : 'medium',
      'Every stylesheet in this project is Codex\'s by the owner\'s decision of 19 Aug (#18). No other agent edits them; a session that needs a style change files it for Codex.',
      'A design-system change to shared.css or shell.css reaches all 21 panels — raise the effort and check every panel, not the one you were looking at.');
  }

  if (kind === 'review' || /\breview\b/i.test(item.title || '')) {
    const authorEngine = String(item.author_engine || 'unknown');
    const reviewer = authorEngine === 'codex' ? 'opus' : 'sol';
    return out('a review must not share the author\'s engine', reviewer, 'high',
      `The author's engine is ${authorEngine}, so the reviewer must be the other one. A checker sharing the author's assumptions confirms the author's bugs, which is the whole reason a second engine exists here (#16).`,
      'If no independent engine is available the review is REFUSED and recorded as not reviewed — never run same-engine and never recorded as a pass.');
  }

  // ---------------------------------------------------------- does it need a model at all

  // THE OWNER'S OWN WORK, and missing this was the single biggest error in the first version.
  // I handled DET and LOC and never checked YOU — so 15 of 33 open items fell through to the
  // catch-all and were recommended a mid-tier model for work no agent can do. I then reported
  // that as "the middle lacks granularity", which was a misdiagnosis of my own table: the
  // catch-all was not undifferentiated, it was swallowing a category I had forgotten.
  //
  // These are NOT no-agent tasks. Every one has a preparable half, and the items say so
  // themselves: #72 "CSV export, same importer shape. You do the export." #78 "I can prepare
  // the Pension Tracing Service request and compare providers on fees. You submit it."
  //
  // So the recommendation is CHEAP AND BOUNDED. Producing a checklist, a costing, a drafted
  // letter or a comparison is ordinary work; what makes these items sit open for weeks is the
  // half no model may do — creating an account, submitting a form, entering identity or
  // payment details, taking a decision that is his. Spending a dear model on the preparable
  // half does not move the blocked half one inch.
  if (String(item.owner || '').toUpperCase() === 'YOU') {
    return out('the owner must act; an agent can only prepare', 'haiku', 'low',
      'Blocked on something only he can do — an account, a submission, an export, identity or payment details, or a decision that is his. The preparable half (a checklist, a costing, a draft, a comparison) is ordinary work and does not need a dear model. Spending one on it does not unblock the half that is actually stuck.',
      'If preparing it needs real judgement — weighing options he will act on, or anything that would read as professional advice — that is a DIFFERENT task and it is opus. Split it rather than raising the effort on this one.');
  }

  if (String(item.owner || '').toUpperCase() === 'DET' && !has(item, AMBIGUOUS)) {
    return out('a deterministic answer exists', 'script', 'low',
      'Already tagged DET, and nothing in the text says the diagnosis is unknown. A deterministic answer is exact, auditable, reproducible by inspection, and free. Measured here: rules did 95.3% of the real categorisation job, the model 4.7%.',
      'If the first attempt shows the rule cannot be stated exactly, that is the signal to escalate — not the fact that writing it is dull.');
  }

  // NOTHING ROUTES TO THE CLOUD TIER BY DEFAULT, and that is deliberate rather than
  // unfinished. The owner has not yet decided what may leave the machine, and the failing
  // direction here is silent: a sensitive item routed to ollama.com would look exactly like
  // one routed to 127.0.0.1 in every log, every panel and every commit message.
  //
  // Fails closed, like the safety guard: `ollama-cloud` is reachable only by an explicit
  // cloudAllowed flag on the item, and the finance and wellbeing prohibitions apply to it
  // exactly as they apply to a frontier model, because it is one -- by destination, which
  // is the only definition that matters.
  if (item.cloudAllowed && String(item.owner || '').toUpperCase() === 'LOC') {
    return out('explicitly cleared to leave the machine', 'ollama-cloud', 'low',
      'Tagged LOC and explicitly cleared for the cloud tier. No VRAM ceiling, so a model far larger than 8 GB is available -- but the data leaves this machine, which makes it a disclosure decision rather than a cost one.',
      'It is NOT private. Every rule that keeps the ledger and the wellbeing module away from a frontier model applies here identically.');
  }

  if (String(item.owner || '').toUpperCase() === 'LOC') {
    return out('tagged for the local model', 'local', 'low',
      'Low-stakes, reviewable, structurally constrained — the binding conditions for Ollama. It is free and private, so volume argues against the frontier tier, never against this one.',
      'It must degrade to "not done, do it yourself" when Ollama is not running, and must never emit a figure.');
  }

  // ------------------------------------------------------------------- now cost vs risk
  // Effort scales with what a wrong answer COSTS, not with how interesting the task is.

  if (pri === 'P0') {
    return out('P0 never economises', 'opus', 'high',
      'Active data loss, a live security hole, or a defect invalidating work in flight. The cheapest model is not the cheapest outcome here — the cost of a wrong answer dwarfs the cost of the tokens.',
      'Already at the top of the ordinary range. Go to xhigh only if the first pass cannot reproduce the failure.');
  }

  if (has(item, IRREVERSIBLE)) {
    return out('irreversible work', 'opus', 'high',
      'This touches something that cannot be undone by editing a file back — a migration, a credential, git history, or something published. Migrations here are append-only by rule; a published post cannot be recalled.',
      'Stay at high. The saving from a cheaper model is one task; the cost of a bad migration is the ledger.');
  }

  if (has(item, AMBIGUOUS)) {
    return out('the diagnosis is unknown', 'opus', 'high',
      'The task is to work out WHAT is wrong, not to apply a known fix. That is where a weaker model spends more tokens than a stronger one by exploring in the wrong direction, so the cheap choice is usually the expensive one.',
      'Once the diagnosis is written down, the FIX is usually a separate, much cheaper task. Split it rather than carrying high effort through the whole thing.');
  }

  if (has(item, MECHANICAL) && (pri === 'P3' || kind === 'chore')) {
    return out('mechanical and specified', 'haiku', 'low',
      'A rename, a label, a wording change: the answer is stated in the task and the work is applying it. Reversible in one commit, and nothing derives from it.',
      'If it turns out to touch more files than expected, stop and re-dispatch — breadth is the signal, not difficulty.');
  }

  if (kind === 'bug' && !has(item, AMBIGUOUS)) {
    return out('a bug with a known cause', 'sonnet', 'medium',
      'A reproduction and a cause are already recorded, so the work is implementing and verifying a fix rather than finding one.',
      'If the reproduction does not reproduce, it is no longer this task — it is a diagnosis task, and that is opus/high.');
  }

  if (pri === 'P3') {
    return out('low stakes, ordinary work', 'sonnet', 'low',
      'P3 is cosmetic or marginal by definition. Reversible, nothing derives from it, and no figure depends on it.',
      'Raise it only if the change turns out to touch a shared file.');
  }

  return out('ordinary implementation', 'sonnet', 'medium',
    'A clear enough specification, reversible, and blast radius limited to what it names. The middle of the range is the honest default when nothing about the task argues for either end.',
    'Escalate on discovering ambiguity, irreversibility, or that it touches a shared file. Any of those three, not a feeling that it is hard.');
}

// The whole table, for reading rather than for calling. A router nobody can audit is a router
// nobody should trust.
function explain() {
  const cases = [
    ['a wellbeing pattern', { cluster: 'Wellbeing' }],
    ['panel spacing is wrong', { title: 'fix spacing in the budget panel css' }],
    ['review commit abc123', { kind: 'review', title: 'review abc123', author_engine: 'claude' }],
    ['categorise known merchants', { owner: 'DET', title: 'add merchant rules' }],
    ['a P0 data-loss defect', { priority: 'P0', title: 'rows are being dropped on import' }],
    ['add a migration', { priority: 'P2', title: 'add a schema migration for handover items' }],
    ['why is the bot dying', { priority: 'P2', title: 'investigate why the bot dies at night' }],
    ['rename a nav label', { priority: 'P3', kind: 'chore', title: 'rename the nav label' }],
    ['a bug with a repro', { priority: 'P2', kind: 'bug', title: 'panel shows 0 when the API is down' }],
    ['ordinary feature', { priority: 'P2', kind: 'feature', title: 'add a filter to the board' }],
  ];
  return cases.map(([label, item]) => ({ label, ...dispatch(item) }));
}

module.exports = { dispatch, explain, AGENTS, EFFORT };

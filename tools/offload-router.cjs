#!/usr/bin/env node
//
// offload-router.cjs — where a task should run, and whether the code already agrees.
//
//   node tools/offload-router.cjs           audit the call sites, then show the policy
//   node tools/offload-router.cjs --policy  just the decision table
//
// Backlog #21 and #13, which are one item: "check whether a cheaper model suits the prompt".
//
// THE MEASURED FINDING THIS ENCODES. The lever on this project was never a smaller model —
// it was DETERMINISM. On the real categorisation job, the rules table did 95.3% of the work
// and the model 4.7%. And prompt context actively hurt: naming the 3D-printing business in
// the prompt broke four answers that were already right (Sainsbury's, Nando's and Greggs all
// became "Business supplies") while fixing none of the two it was meant to. So merchant
// knowledge lives in a rules table, not a prompt.
//
// Hence the order is rules -> local -> frontier, and the first question is never "which
// model" but "is a model needed at all".
//
// WHAT THIS FILE IS NOT. It cannot tell whether a task is low-stakes, produces numbers, or
// touches wellbeing — those are properties of intent, and it asks the caller to declare
// them. The audit half checks only what is mechanically visible in the source. Both halves
// say so out loud, because an audit that looks green while checking three things out of
// seven is worse than no audit.
'use strict';
require('./_run-log.cjs').record();

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

// ---------------------------------------------------------------------- the policy
// Straight from ARCHITECTURE.md "The policy". Each refusal carries the reason, because a
// refusal without one gets argued with and then worked around.
const NEVER = [
  ['producesNumbers', 'Any number that appears anywhere. Arithmetic is SQL\'s job — a model that computes a total gives you a PLAUSIBLE total, which is worse than no total.'],
  ['autoApplied', 'Anything auto-applied without review. 20/20 is not 100% on the next 20.'],
  ['wellbeing', 'Anything in the wellbeing module. Pattern surfacing there must be deterministic and inspectable; a model must never generate advice about mental health.'],
  ['assertsFactAboutCode', 'Architecture, project memory, or anything asserting a fact about the code. A confabulated CLAUDE.md is worse than none, because it reads as verified.'],
];

// THE WRITTEN POLICY CONTRADICTS ITS OWN EXAMPLES, and the router found it. ARCHITECTURE.md
// says offload when the task is 'high-volume, low-stakes, reviewable, and structurally
// constrained' — then lists 'summarising a day's data into briefing prose' as a local task.
// One sentence a day is not high volume, so as a conjunction the rule refuses the very
// example it gives. Resolved the way the evidence points: the LOCAL MODEL IS FREE, so
// volume is an argument for preferring local over FRONTIER on cost, never a barrier to
// using it. The binding three are below; highVolume is recorded but not required.
const LOCAL_GATES = ['lowStakes', 'reviewable', 'outputConstrained'];

const LOCAL_REQUIREMENTS = [
  'Constrain the output with a JSON SCHEMA whose vocabulary is an enum — not bare format:\'json\', which returned an object where an array was wanted. An enum makes an out-of-vocabulary answer structurally impossible.',
  'temperature: 0, so a re-run of the same input gives the same answer.',
  'Batch. 25 transactions in one call is ~11s; 25 calls is minutes.',
  'Degrade to "not done, do it yourself" when Ollama is not running. It is a desktop app that will sometimes not be.',
];

function route(task = {}) {
  const reasons = [];

  const refusals = NEVER.filter(([key]) => (key === 'wellbeing' ? task.module === 'wellbeing' : !!task[key]));
  if (refusals.length) {
    return {
      tier: 'refuse',
      reasons: refusals.map(([, why]) => why),
      requirements: [],
      note: 'No model tier is acceptable for this. Do it deterministically or not at all.',
    };
  }

  if (task.hasDeterministicOracle) {
    return {
      tier: 'rules',
      reasons: ['A deterministic answer exists, so no model is needed. Measured on this project: rules did 95.3% of categorisation, the model 4.7%.'],
      requirements: ['Keep the rules exact and auditable. A rule cannot destabilise the rows it does not match, which a prompt can.'],
      note: 'Cheapest, fastest, and the only tier that is reproducible by inspection.',
    };
  }

  const failed = LOCAL_GATES.filter((g) => !task[g]);
  if (!failed.length) {
    return {
      tier: 'local',
      reasons: [`Low-stakes, reviewable and structurally constrained${task.highVolume ? ', and high-volume' : ''} — the binding conditions for Ollama${task.highVolume ? '' : '. Volume is not one of them: the local model is free, so low volume argues against FRONTIER, never against local'}.`],
      requirements: LOCAL_REQUIREMENTS,
      note: 'qwen3.5:9b at num_ctx 16384. Free, private, ~440ms per item batched.',
    };
  }

  return {
    tier: 'frontier',
    reasons: [`Not suitable for the local model: ${failed.join(', ')} ${failed.length === 1 ? 'is' : 'are'} not satisfied.`],
    requirements: [
      'Use it for design work over samples, not bulk processing — that is where the cost actually lands.',
      'It still may not produce a number that appears anywhere, or assert a fact about the code.',
    ],
    note: 'Last resort by cost and by privacy, not by capability.',
  };
}

// ---------------------------------------------------------------------- the audit
// Finds every place the code talks to a model and checks what is MECHANICALLY visible.
const MECHANICAL = [
  {
    id: 'constrained-output',
    want: 'a JSON schema or an enum',
    test: (src) => /schema|enum/.test(src),
    why: 'Bare format:\'json\' returned one object where an array was wanted.',
  },
  {
    id: 'temperature-zero',
    want: 'temperature: 0',
    test: (src) => /temperature:\s*0(?!\.[1-9])/.test(src),
    why: 'The policy says temperature 0 throughout, so a re-run gives the same answer.',
  },
  {
    id: 'no-bare-json-format',
    want: 'no bare format:\'json\'',
    test: (src) => !/format:\s*'json'/.test(src),
    why: 'Explicitly called out in ARCHITECTURE.md as the thing that failed. NOTE: this test cannot tell a file that USES the string from one that MENTIONS it — llm-probe.cjs contains it because it measured the difference.',
  },
];

function findCallSites() {
  const dirs = ['server', 'scripts', 'tools'];
  const hits = [];
  for (const d of dirs) {
    const dir = path.join(ROOT, d);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (!/\.(c?js)$/.test(name)) continue;
      const full = path.join(dir, name);
      const src = fs.readFileSync(full, 'utf8');
      if (full === __filename) continue;   // this file names ollama in its own prose
      if (!/11434|ollama/i.test(src)) continue;
      hits.push({ file: `${d}/${name}`, src });
    }
  }
  return hits;
}

function audit() {
  return findCallSites().map(({ file, src }) => ({
    file,
    checks: MECHANICAL.map((c) => ({ id: c.id, want: c.want, pass: c.test(src), why: c.why })),
  }));
}

// ---------------------------------------------------------------------- cli
if (require.main === module) {
  const policyOnly = process.argv.includes('--policy');

  if (!policyOnly) {
    const results = audit();
    console.log(`MODEL CALL SITES — ${results.length} found by scanning for 11434/ollama\n`);
    let failures = 0;
    for (const r of results) {
      console.log(`  ${r.file}`);
      for (const c of r.checks) {
        if (!c.pass) failures++;
        console.log(`     ${c.pass ? 'ok  ' : 'DIFFERS'}  ${c.want}${c.pass ? '' : `\n              ${c.why}`}`);
      }
      console.log('');
    }
    console.log(failures
      ? `${failures} difference(s) from the stated policy. Each is a decision to record or correct, not automatically a bug.`
      : 'Every call site matches the mechanical rules.');

    // The residue, and the more important half. A green audit above checks three things.
    console.log('\nWHAT THIS AUDIT CANNOT SEE, and nothing here should be read as covering it:');
    console.log('  - whether the task is low-stakes, high-volume, or reviewable');
    console.log('  - whether the output is ever auto-applied without review');
    console.log('  - whether any number in the output came from the model rather than SQL');
    console.log('  - whether there is a working path when Ollama is not running');
    console.log('  Those are properties of intent, not of source text. Declare them to route().');
  }

  console.log('\nTHE DECISION TABLE — route({ ...task })\n');
  const examples = [
    ['a briefing total', { producesNumbers: true }],
    ['wellbeing journal tagging', { module: 'wellbeing', highVolume: true, lowStakes: true, reviewable: true, outputConstrained: true }],
    ['categorising a known merchant', { hasDeterministicOracle: true }],
    ['categorising the long tail', { highVolume: true, lowStakes: true, reviewable: true, outputConstrained: true }],
    ['one sentence of briefing prose', { lowStakes: true, reviewable: true, outputConstrained: true }],
  ];
  for (const [label, task] of examples) {
    const r = route(task);
    console.log(`  ${label.padEnd(32)} -> ${r.tier.toUpperCase()}`);
    console.log(`     ${r.reasons[0]}`);
  }
}

module.exports = { route, audit, findCallSites, NEVER, LOCAL_GATES, LOCAL_REQUIREMENTS };

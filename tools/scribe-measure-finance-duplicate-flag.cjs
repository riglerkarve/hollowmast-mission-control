#!/usr/bin/env node
'use strict';
// scribe-measure-finance-duplicate-flag.cjs -- registers 'finance-duplicate-flag' in
// scribe_capabilities, per t_4d01696e.
//
// The job: given a pair of transactions, decide DUPLICATE or NOT_DUPLICATE. This is a
// flag for a human to check, never an auto-merge/delete -- the model has no write path
// here at all, only a classification the review UI could surface. That is why the oracle
// only needs a binary verdict, same shape as the DISCRIMINATE gate in model-bakeoff.cjs
// (evidence in, verdict out, no partial credit).
//
// All pairs are hand-built and invented. None reference real finance_transactions rows.
//
//   node tools/scribe-measure-finance-duplicate-flag.cjs

require('./_run-log.cjs').record();
const db = require('../server/db');
db.setProcessActor('scribe');
const { checkAvailable, scoreOracle } = require('./ollama-run.cjs');
const scribe = require('../server/scribe.js');

const MODEL = process.env.PROBE_MODEL || 'qwen3.5:4b';
const FLOOR = 0.8;
const JOB = 'finance-duplicate-flag';

const SYSTEM = `You check pairs of UK bank transactions for accidental duplicates -- e.g. the same
card payment submitted twice, or a bank export containing the same row twice.
Reply ONLY with JSON: {"results":[{"i":<index>,"v":"DUPLICATE"|"NOT_DUPLICATE"}]}
DUPLICATE means: almost certainly the same real-world payment recorded more than once
(same or near-identical amount, same counterparty, same or adjacent date).
NOT_DUPLICATE means: two genuinely separate payments, even if they look similar --
e.g. a recurring subscription charged twice a month apart, or two different people
paying the same amount to the same shop on the same day.
No prose, no explanation.`;

const SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: { i: { type: 'integer' }, v: { type: 'string', enum: ['DUPLICATE', 'NOT_DUPLICATE'] } },
        required: ['i', 'v'],
      },
    },
  },
  required: ['results'],
};

// HAND-BUILT ORACLE. 12 pairs, invented, 6 true duplicates and 6 genuine near-misses that
// a naive "same amount, same day" rule would get wrong -- that asymmetry is the point:
// a model that flags everything similar as a duplicate would pass a set of pure
// duplicates at 100% while being useless, so the discriminating cases are what score it.
const ORACLE = [
  { id: 'p1', a: 'Tesco Superstore, -18.42, 2026-03-04, CONTACTLESS', b: 'Tesco Superstore, -18.42, 2026-03-04, CONTACTLESS', truth: 'DUPLICATE' },
  { id: 'p2', a: 'Netflix.com, -10.99, 2026-04-02, DIRECT DEBIT', b: 'Netflix.com, -10.99, 2026-05-02, DIRECT DEBIT', truth: 'NOT_DUPLICATE' }, // monthly sub, different months
  { id: 'p3', a: 'Shell A1 Services, -56.00, 2026-06-11, CONTACTLESS', b: 'Shell A1 Services, -56.00, 2026-06-11, CONTACTLESS', truth: 'DUPLICATE' },
  { id: 'p4', a: 'M Whitfield, -45.00, 2026-01-07, FASTER PAYMENT', b: 'J Whitfield, -45.00, 2026-01-07, FASTER PAYMENT', truth: 'NOT_DUPLICATE' }, // different people, same amount/day
  { id: 'p5', a: 'Amazon Marketplace, -23.10, 2026-02-14, CARD PAYMENT', b: 'Amazon Marketplace, -23.10, 2026-02-15, CARD PAYMENT', truth: 'DUPLICATE' }, // same amount, adjacent day -- a card auth/settle double-post pattern
  { id: 'p6', a: 'Costa Coffee, -3.65, 2026-07-01, CONTACTLESS', b: 'Costa Coffee, -3.65, 2026-07-03, CONTACTLESS', truth: 'NOT_DUPLICATE' }, // two separate coffees, same price, two days apart
  { id: 'p7', a: 'British Gas, -87.00, 2026-08-01, DIRECT DEBIT', b: 'British Gas, -87.00, 2026-08-01, DIRECT DEBIT', truth: 'DUPLICATE' },
  { id: 'p8', a: 'Vodafone, -35.00, 2026-03-01, DIRECT DEBIT', b: 'Vodafone, -35.00, 2026-04-01, DIRECT DEBIT', truth: 'NOT_DUPLICATE' }, // monthly plan
  { id: 'p9', a: 'Ryanair, -89.00, 2026-05-20, CARD PAYMENT', b: 'Ryanair, -89.00, 2026-05-20, CARD PAYMENT', truth: 'DUPLICATE' },
  { id: 'p10', a: 'Nandos, -18.40, 2026-06-06, CONTACTLESS', b: 'Nandos, -18.40, 2026-06-06, CONTACTLESS', truth: 'DUPLICATE' }, // exact same amount, same restaurant, same day -- flagged for a human to check even though a couple splitting a bill is possible
  { id: 'p11', a: 'Odeon Cinemas, -14.00, 2026-09-09, CONTACTLESS', b: 'Vue Cinemas, -14.00, 2026-09-09, CONTACTLESS', truth: 'NOT_DUPLICATE' }, // different counterparty entirely
  { id: 'p12', a: 'Cash Machine, -60.00, 2026-10-01, ATM', b: 'Cash Machine, -60.00, 2026-10-15, ATM', truth: 'NOT_DUPLICATE' }, // two weeks apart, routine withdrawal pattern
];

function buildPrompt(rows) {
  const list = rows.map((r, i) => `${i}. A: ${r.a}\n   B: ${r.b}`).join('\n');
  return `Check these ${rows.length} pairs:\n${list}`;
}

function parseResponse(text, chunk) {
  const parsed = JSON.parse(text).results;
  if (!Array.isArray(parsed)) throw new Error('results was not an array');
  const byIdx = new Map(parsed.map((o) => [Number(o.i), String(o.v || '').trim()]));
  const got = new Map();
  const badKeys = [];
  chunk.forEach((row, i) => {
    const v = byIdx.get(i);
    if (v !== 'DUPLICATE' && v !== 'NOT_DUPLICATE') { badKeys.push(row.id); return; }
    got.set(String(row.id), v);
  });
  return { got, badKeys };
}

async function main() {
  const avail = await checkAvailable();
  if (!avail.up) {
    scribe.recordRun(db, { job: JOB, model: MODEL, refused: true, reason: avail.why || 'ollama unreachable' });
    process.exit(2);
  }

  console.log(`model        ${MODEL}`);
  console.log(`oracle       ${ORACLE.length} hand-built pairs (6 true duplicates, 6 designed near-misses), no real data\n`);

  const score = await scoreOracle({
    model: MODEL, system: SYSTEM, schema: SCHEMA, oracle: ORACLE, buildPrompt, parseResponse,
    keyOf: (o) => o.id, floor: FLOOR, batchSize: 25,
  });

  console.log(`scored ${score.matched}/${score.seen} of ${ORACLE.length} = ${score.accuracy == null ? 'n/a' : Math.round(score.accuracy * 100) + '%'} vs floor ${Math.round(FLOOR * 100)}%`);
  for (const m of score.misses) console.log(`  MISS ${m.id}  truth ${m.truth}  got ${m.got}`);
  if (score.seen < ORACLE.length) console.log(`  ${ORACLE.length - score.seen} item(s) unanswered/unparseable`);

  scribe.recordRun(db, {
    job: JOB, model: MODEL, items: ORACLE.length, wrote: 0,
    refused: !score.ok, reason: score.ok ? 'measurement complete' : score.why,
    detail: { accuracy: score.accuracy, seen: score.seen, matched: score.matched, floor: FLOOR },
  });

  if (score.accuracy == null) {
    console.log(`\n${score.why}\nNOT registering: no accuracy figure to record.`);
    process.exit(1);
  }

  const body = {
    job: JOB,
    score: score.accuracy,
    floor: FLOOR,
    sample_n: ORACLE.length,
    oracle: `${ORACLE.length} hand-built, invented transaction pairs (6 true duplicates, 6 near-miss `
          + `pairs designed to catch a naive same-amount/same-day rule) -- no real finance data, 24 Aug 2026`,
    misses: score.misses.length ? score.misses : undefined,
    model: MODEL,
    measured_by: 'build',
    notes: score.ok
      ? 'Passed the floor distinguishing true duplicates from similar-but-genuine pairs. This is a FLAG for review, never an auto-merge/delete -- Scribe has no write path for this job.'
      : 'Failed to distinguish true duplicates from similar-but-genuine pairs at the required floor.',
  };

  const base = process.env.MC_BASE || 'http://127.0.0.1:3000';
  const r = await fetch(`${base}/api/team/scribe/measure`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const j = await r.json();
  console.log(`\nPOST /api/team/scribe/measure -> ${r.status}`, JSON.stringify(j));
}

main().catch((e) => { console.error(e.message); process.exit(1); });

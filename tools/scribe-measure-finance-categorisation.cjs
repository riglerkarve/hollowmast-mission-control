#!/usr/bin/env node
'use strict';
// scribe-measure-finance-categorisation.cjs -- registers the 'finance-categorisation' job
// in scribe_capabilities for real, per t_4d01696e.
//
// categorise-model.cjs already re-scores accuracy against a LIVE oracle (real rule-tagged
// rows) on every run, which is stronger evidence than a cached table row -- but its own
// comment says registering the job formally in scribe_capabilities is separate work, and
// that had never been done. This script does that registration, with a HAND-BUILT oracle
// instead of live rows, because the task this serves is explicit: do not touch real
// finance data, synthetic/hand-constructed cases only.
//
// Every counterparty/reference below is invented. None of it is drawn from
// finance_transactions or any real account. The category vocabulary IS real -- pulled
// from finance_rules, same as categorise-model.cjs -- because scoring against a vocabulary
// the model won't actually use in production data would not measure the real job.
//
//   node tools/scribe-measure-finance-categorisation.cjs

require('./_run-log.cjs').record();
const db = require('../server/db');
db.setProcessActor('scribe');
require('../server/routes/finance'); // ensures finance_rules table + migrations exist
const { checkAvailable, scoreOracle } = require('./ollama-run.cjs');
const scribe = require('../server/scribe.js');

const MODEL = process.env.PROBE_MODEL || 'qwen3.5:4b';
const FLOOR = 0.8;
const JOB = 'finance-categorisation';

const CATEGORIES = db.prepare('SELECT DISTINCT category FROM finance_rules ORDER BY category')
  .all().map((r) => r.category).concat('Other');

const SYSTEM = `You categorise UK bank transaction descriptors for a personal ledger.
Reply ONLY with JSON: {"results":[{"i":<index>,"c":"<category>"}]}
One category per transaction, from this list, spelled identically:
${CATEGORIES.join(' | ')}
"Other" is the correct answer when the descriptor does not clearly indicate any of the rest.
No prose, no explanation.`;

const SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: { i: { type: 'integer' }, c: { type: 'string', enum: CATEGORIES } },
        required: ['i', 'c'],
      },
    },
  },
  required: ['results'],
};

// HAND-BUILT ORACLE. Invented counterparties, unambiguous by design -- this measures
// whether the model can do the job at all, not whether it can resolve edge cases nobody
// labelled correctly either. 16 cases, one or two per real category, plus two that should
// land on 'Other'.
const ORACLE = [
  { id: 'c1', counterparty: 'Sainsburys Superstore', reference: '', type: 'CONTACTLESS', amount_pence: -4210, truth: 'Groceries' },
  { id: 'c2', counterparty: 'Netflix.com', reference: 'NETFLIX SUBSCRIPTION', type: 'DIRECT DEBIT', amount_pence: -1099, truth: 'Subscriptions' },
  { id: 'c3', counterparty: 'Shell A1 Services', reference: 'FUEL', type: 'CONTACTLESS', amount_pence: -5600, truth: 'Fuel' },
  { id: 'c4', counterparty: 'DWP', reference: 'UNIVERSAL CREDIT', type: 'FASTER PAYMENT', amount_pence: 62000, truth: 'Benefits' },
  { id: 'c5', counterparty: 'Cash Machine', reference: '', type: 'ATM', amount_pence: -6000, truth: 'Cash withdrawn' },
  { id: 'c6', counterparty: 'Ryanair', reference: 'FLIGHT BOOKING', type: 'CARD PAYMENT', amount_pence: -8900, truth: 'Travel' },
  { id: 'c7', counterparty: 'Uber', reference: 'TRIP', type: 'CONTACTLESS', amount_pence: -1150, truth: 'Transport' },
  { id: 'c8', counterparty: 'British Gas', reference: 'ENERGY BILL', type: 'DIRECT DEBIT', amount_pence: -8700, truth: 'Housing' },
  { id: 'c9', counterparty: 'Vodafone', reference: 'MOBILE PLAN', type: 'DIRECT DEBIT', amount_pence: -3500, truth: 'Phone & internet' },
  { id: 'c10', counterparty: 'Betfred', reference: '', type: 'CARD PAYMENT', amount_pence: -2000, truth: 'Gambling' },
  { id: 'c11', counterparty: 'Nandos', reference: '', type: 'CONTACTLESS', amount_pence: -1840, truth: 'Eating out' },
  { id: 'c12', counterparty: 'Odeon Cinemas', reference: '', type: 'CONTACTLESS', amount_pence: -1400, truth: 'Entertainment' },
  { id: 'c13', counterparty: 'J Whitfield', reference: 'RENT SPLIT', type: 'FASTER PAYMENT', amount_pence: -45000, truth: 'Payments to people' },
  { id: 'c14', counterparty: 'ASOS', reference: 'ORDER 88231', type: 'CARD PAYMENT', amount_pence: -3299, truth: 'Shopping' },
  { id: 'c15', counterparty: 'Quantum Consulting Ltd', reference: 'INVOICE Q22-014 STRUCTURAL SURVEY', type: 'FASTER PAYMENT', amount_pence: -12000, truth: 'Other' },
  { id: 'c16', counterparty: 'Meridian Print Supplies', reference: 'PO 4471 BULK ORDER', type: 'FASTER PAYMENT', amount_pence: -7650, truth: 'Other' },
];

function buildPrompt(rows) {
  const list = rows.map((r, i) => {
    const dir = r.amount_pence >= 0 ? 'money in' : 'money out';
    const desc = [r.counterparty, r.reference].filter(Boolean).join(' / ');
    return `${i}. [${dir}, ${r.type}] ${desc}`;
  }).join('\n');
  return `Categorise these ${rows.length} transactions:\n${list}`;
}

function parseResponse(text, chunk) {
  const parsed = JSON.parse(text).results;
  if (!Array.isArray(parsed)) throw new Error('results was not an array');
  const byIdx = new Map(parsed.map((o) => [Number(o.i), String(o.c || '').trim()]));
  const got = new Map();
  const badKeys = [];
  chunk.forEach((row, i) => {
    const c = byIdx.get(i);
    if (!c || !CATEGORIES.includes(c)) { badKeys.push(row.id); return; }
    got.set(String(row.id), c);
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
  console.log(`vocabulary   ${CATEGORIES.length} categories, read from finance_rules`);
  console.log(`oracle       ${ORACLE.length} hand-built, invented transactions (no real data)\n`);

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
    oracle: `${ORACLE.length} hand-built, invented UK bank transactions covering ${new Set(ORACLE.map(o=>o.truth)).size} categories, incl. 2 designed to land on 'Other' -- no real finance data, 24 Aug 2026`,
    misses: score.misses.length ? score.misses : undefined,
    model: MODEL,
    measured_by: 'build',
    notes: score.ok ? 'Passed the floor on unambiguous, invented transactions.'
                    : 'Failed to reproduce known-correct categories on unambiguous, invented transactions.',
  };

  const base = process.env.MC_BASE || 'http://127.0.0.1:3000';
  const r = await fetch(`${base}/api/team/scribe/measure`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const j = await r.json();
  console.log(`\nPOST /api/team/scribe/measure -> ${r.status}`, JSON.stringify(j));
}

main().catch((e) => { console.error(e.message); process.exit(1); });

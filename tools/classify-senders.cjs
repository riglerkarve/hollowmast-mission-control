#!/usr/bin/env node
//
// classify-senders.cjs — label mail senders. Rules first, Ollama for the tail, nothing
// auto-applied as settled.
//
//   node tools/classify-senders.cjs             rules, then the model on what is left
//   node tools/classify-senders.cjs --rules     rules only, never touch Ollama
//   node tools/classify-senders.cjs --dry       decide nothing, report what would happen
//
// ---------------------------------------------------------------------------------------
// THE ORDER IS RULES -> LOCAL, and the first question was whether a model was needed at all.
// Measured on 48,021 messages / 1,132 senders before any of this was written: pattern rules
// reach 50.4% of senders and 73.1% of message VOLUME. That is a real tail, unlike bank
// transactions where rules did 95.3% and there was almost nothing left to offload.
//
// WHAT THE MODEL IS TRUSTED WITH. tools/llm-probe-mail.cjs scored qwen3.5:9b at 10/10 on
// unambiguous senders and 2/5 on judgement calls. So its answers are written with
// class_source = 'model', which means SUGGESTED. A rule or a human ('manual') always wins,
// and nothing downstream may treat 'model' as decided.
//
// IT DEGRADES TO RULES-ONLY. If Ollama is not running the tail stays NULL and the run says
// so. NULL means "not classified" and is never rendered as 'other' — a fabricated category
// would be indistinguishable from a real one.
//
// NO DOMAIN CONTEXT IN THE PROMPT, deliberately: naming the owner's business in the
// transaction probe broke four answers that were already right.
//
// ROUTES THROUGH tools/ollama-run.cjs, not a direct fetch to 11434 — this used to call the
// Ollama HTTP API straight, which skips server/ollama.js's cloud-privacy gate entirely. This
// script hands the model mail sender addresses, which is exactly the kind of payload that
// gate exists to keep off a `-cloud` model. Also adds the accuracy-floor gate ollama-shift.cjs
// already had and this script did not: rule-classified senders already on file are the
// oracle, scored fresh every run rather than trusted from llm-probe-mail.cjs's one-time number.
// ---------------------------------------------------------------------------------------
'use strict';
require('./_run-log.cjs').record();

const db = require('../server/db');
// Provenance: every read this process makes is logged against this actor. Without it the
// access log records 'unknown', which is honest but useless. See server/provenance.js.
db.setProcessActor('claude');
require('../server/routes/mail');
const { checkAvailable, scoreOracle, askBatched } = require('./ollama-run.cjs');

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const RULES_ONLY = args.includes('--rules');
const MODEL = 'qwen3.5:9b';
const BATCH = 25;
const ACCURACY_FLOOR = 0.8;

const CLASSES = ['marketing', 'transactional', 'social', 'survey', 'adult', 'jobs', 'finance', 'personal', 'other'];

// Seeded once. Every one is a property of the ADDRESS, decidable without knowing anything
// about the owner — which is what keeps them auditable.
const SEED = [
  ['^(no-?reply|do-?not-?reply|noreply|donotreply|bounce|mailer-daemon)@', 'transactional', 'send-only address'],
  ['^(notifications?|notify|alerts?|updates?)@', 'transactional', 'notification sender'],
  ['^(news|newsletter|digest|weekly|marketing|promo|offers?|deals?)@', 'marketing', 'bulk mail address'],
  ['^(receipts?|orders?|billing|invoice|payments?)@', 'transactional', 'order or billing address'],
  ['^(support|help|care|service|contact|info|hello|team)@', 'transactional', 'inbound service address'],
  ['@(gmail|outlook|hotmail|yahoo|icloud|live|aol)\\.', 'personal', 'consumer mail provider'],
  ['@(linkedin|facebook|instagram|twitter|x|tiktok|reddit|discord)\\.', 'social', 'social platform'],
  ['(survey|panel|opinions|populuslive|yougov)', 'survey', 'survey panel'],
  ['(onlyfans|chaturbate|pornhub|fansly)', 'adult', 'adult platform'],
  ['(jobs?|recruit|indeed|totaljobs|reed\\.co)', 'jobs', 'jobs board'],
  ['(revolut|monzo|starling|paypal|klarna|barclays|natwest|lloyds|hsbc)', 'finance', 'bank or payment provider'],
];

function seedRules() {
  const ins = db.prepare('INSERT OR IGNORE INTO gmail_sender_rules (pattern, kind, class, note) VALUES (?, ?, ?, ?)');
  db.withTransaction(() => { SEED.forEach(([p, c, n]) => ins.run(p, 'regex', c, n)); });
}

function applyRules() {
  const rules = db.prepare('SELECT * FROM gmail_sender_rules').all()
    .map((r) => ({ ...r, re: new RegExp(r.pattern, 'i') }));
  const addrs = db.prepare(
    `SELECT DISTINCT m.from_addr AS a FROM gmail_messages m
      WHERE m.from_addr IS NOT NULL`
  ).all().map((r) => r.a);

  // A MANUAL classification is never overwritten. A rule may correct a model suggestion,
  // because the rule is the more trustworthy of the two — but neither outranks a human.
  const existing = new Map(db.prepare('SELECT addr, class, class_source FROM gmail_senders').all()
    .map((r) => [r.addr, r]));

  const up = db.prepare(
    `INSERT INTO gmail_senders (addr, class, class_source, classified_at)
     VALUES (?,?,?,datetime('now','localtime'))
     ON CONFLICT(addr) DO UPDATE SET class = excluded.class, class_source = excluded.class_source,
       classified_at = excluded.classified_at`
  );

  let hit = 0, skippedManual = 0;
  const unmatched = [];
  db.withTransaction(() => {
    for (const a of addrs) {
      const prior = existing.get(a);
      if (prior && prior.class_source === 'manual') { skippedManual++; continue; }
      const r = rules.find((x) => x.re.test(a));
      if (!r) { if (!prior || prior.class_source !== 'model') unmatched.push(a); continue; }
      if (!DRY) up.run(a, r.class, 'rule');
      hit++;
    }
  });
  return { total: addrs.length, hit, skippedManual, unmatched };
}

const SCHEMA = {
  type: 'object',
  required: ['results'],
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        required: ['n', 'c'],
        properties: { n: { type: 'integer' }, c: { type: 'string', enum: CLASSES } },
      },
    },
  },
};

function buildPrompt(chunk) {
  return 'Classify each email sender address by what kind of mail it sends.\n'
    + `Allowed categories: ${CLASSES.join(', ')}.\n`
    + 'Answer for every address, in the same order.\n\n'
    + chunk.map((item, i) => `${i + 1}. ${item.addr}`).join('\n');
}

// n is 1-based position in THIS chunk (the model does not have to echo the address back
// correctly). Resolved here to the address itself, so askBatched's answers Map is keyed the
// same way every other caller keys it.
function parseResponse(text, chunk) {
  const parsed = JSON.parse(text).results;
  if (!Array.isArray(parsed)) throw new Error('results was not an array');
  const got = new Map();
  const badKeys = [];
  for (const x of parsed) {
    const item = chunk[x.n - 1];
    if (!item || !CLASSES.includes(x.c)) { if (item) badKeys.push(item.id); continue; }
    got.set(String(item.id), String(x.c));
  }
  return { got, badKeys };
}

(async () => {
  // A REAL SAFETY FAILURE, found by Codex on independent review (M103, usage-contract-audit):
  // seedRules() ran unconditionally, before the DRY/RULES_ONLY check below, and it INSERTs
  // into gmail_sender_rules. `--dry`'s own docstring says "decide nothing, report what would
  // happen" and its own output claimed "nothing written" -- both false while this ran first.
  // applyRules() already guards its own write on `!DRY`; seedRules() is the one call site that
  // did not. Idempotent (INSERT OR IGNORE) and low-stakes on its own, but the contract is
  // "nothing written under --dry", not "nothing IMPORTANT written".
  if (!DRY) seedRules();
  const r = applyRules();

  const byVolume = db.prepare(
    `SELECT COUNT(*) AS n FROM gmail_messages WHERE from_addr IN
       (SELECT addr FROM gmail_senders WHERE class_source = 'rule')`
  ).get().n;
  const allMsgs = db.prepare('SELECT COUNT(*) AS n FROM gmail_messages WHERE from_addr IS NOT NULL').get().n;

  console.log(`  RULES: ${r.hit}/${r.total} senders (${(100 * r.hit / r.total).toFixed(1)}%)`
    + `, ${byVolume}/${allMsgs} messages (${(100 * byVolume / allMsgs).toFixed(1)}% by volume)`);
  if (r.skippedManual) console.log(`         ${r.skippedManual} left alone — classified by you`);
  console.log(`  TAIL : ${r.unmatched.length} senders no rule reaches`);

  if (RULES_ONLY || DRY) {
    console.log(DRY ? '  --dry, nothing written.' : '  --rules, the model was not asked.');
    console.log('  Those senders stay NULL, which means NOT CLASSIFIED — never "other".');
    return;
  }
  if (!r.unmatched.length) return;

  const avail = await checkAvailable();
  if (!avail.up) { console.log('  Rule-based classifications are already saved; the tail stays NULL.'); return; }

  // THE GATE. Senders already classified BY RULE are the oracle — reproducible, not hand
  // labelled — and re-scored every run rather than trusted from llm-probe-mail.cjs's one-time
  // number, which cannot know if the model or the prompt has since moved.
  const oracleRows = db.prepare(
    `SELECT addr, class AS truth FROM gmail_senders WHERE class_source = 'rule' ORDER BY RANDOM() LIMIT 40`
  ).all().map((o) => ({ id: o.addr, addr: o.addr, truth: o.truth }));

  console.log(`  scoring against ${oracleRows.length} rule-classified senders before touching the tail...`);
  const score = await scoreOracle({
    model: MODEL, schema: SCHEMA, oracle: oracleRows, buildPrompt, parseResponse,
    keyOf: (o) => o.id, floor: ACCURACY_FLOOR, batchSize: BATCH,
  });
  if (score.accuracy != null) {
    console.log(`  agreement with the rules: ${score.matched}/${score.seen}  ${Math.round(score.accuracy * 100)}%`);
  }
  if (!score.ok) {
    console.log(`\n  ${score.why}`);
    console.log('  Rule-based classifications are already saved; the tail stays NULL.\n');
    return;
  }

  const up = db.prepare(
    `INSERT INTO gmail_senders (addr, class, class_source, classified_at)
     VALUES (?,?, 'model', datetime('now','localtime'))
     ON CONFLICT(addr) DO UPDATE SET class = excluded.class, class_source = 'model',
       classified_at = excluded.classified_at`
  );

  const items = r.unmatched.map((addr) => ({ id: addr, addr }));
  const { answers, failed } = await askBatched({
    model: MODEL, schema: SCHEMA, items, buildPrompt, parseResponse, batchSize: BATCH,
    onBatch: (p) => process.stdout.write(`\r  MODEL: ${p.done}/${p.total}`),
  });
  process.stdout.write('\n');

  let done = 0;
  db.withTransaction(() => {
    for (const [addr, c] of answers) { up.run(addr, c); done++; }
  });

  const left = db.prepare('SELECT COUNT(*) AS n FROM gmail_senders WHERE class IS NULL').get().n;
  console.log(`  ${done} senders SUGGESTED by the model (class_source='model').`);
  console.log('  Suggested is not decided: senders are for review, and a rule or your own');
  console.log('  correction overrides them.');
  if (failed.length) console.log(`  ${failed.length} sender(s) failed — that many stay unclassified.`);
  if (left) console.log(`  ${left} sender(s) remain NULL.`);
})();

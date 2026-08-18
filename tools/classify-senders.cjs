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
// ---------------------------------------------------------------------------------------
'use strict';

const db = require('../server/db');
// Provenance: every read this process makes is logged against this actor. Without it the
// access log records 'unknown', which is honest but useless. See server/provenance.js.
db.setProcessActor('claude');
require('../server/routes/mail');

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const RULES_ONLY = args.includes('--rules');
const MODEL = 'qwen3.5:9b';
const BATCH = 25;

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

async function askModel(addrs) {
  const res = await fetch('http://127.0.0.1:11434/api/generate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      stream: false,
      prompt: 'Classify each email sender address by what kind of mail it sends.\n'
        + `Allowed categories: ${CLASSES.join(', ')}.\n`
        + 'Answer for every address, in the same order.\n\n'
        + addrs.map((a, i) => `${i + 1}. ${a}`).join('\n'),
      format: {
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
      },
      // Load-bearing: qwen3.5 is a thinking model and with a strict schema it spends the
      // whole output budget in `thinking`, returning an EMPTY response with done_reason
      // "stop". That reads as a failure to connect when it is in fact an answer with no
      // content. Measured; see tools/llm-probe-mail.cjs.
      think: false,
      options: { temperature: 0 },
    }),
  });
  if (!res.ok) throw new Error(`ollama ${res.status}`);
  const b = await res.json();
  if (!b.response) throw new Error('ollama answered with an empty response');
  return JSON.parse(b.response).results || [];
}

(async () => {
  seedRules();
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

  const up = db.prepare(
    `INSERT INTO gmail_senders (addr, class, class_source, classified_at)
     VALUES (?,?, 'model', datetime('now','localtime'))
     ON CONFLICT(addr) DO UPDATE SET class = excluded.class, class_source = 'model',
       classified_at = excluded.classified_at`
  );

  let done = 0, failedBatches = 0;
  for (let i = 0; i < r.unmatched.length; i += BATCH) {
    const slice = r.unmatched.slice(i, i + BATCH);
    let out;
    try { out = await askModel(slice); }
    catch (err) {
      failedBatches++;
      // DEGRADES, and says how far it got. The alternative — carrying on silently — would
      // leave a partial classification that reads as a complete one.
      console.error(`\n  ollama failed on batch ${1 + i / BATCH}: ${err.message}`);
      console.error('  Stopping. Rules-based classifications are already saved; the rest stay NULL.');
      break;
    }
    db.withTransaction(() => {
      for (const x of out) {
        const addr = slice[x.n - 1];
        if (addr && CLASSES.includes(x.c)) { up.run(addr, x.c); done++; }
      }
    });
    process.stdout.write(`\r  MODEL: ${done}/${r.unmatched.length} suggested`);
  }
  process.stdout.write('\n');

  const left = db.prepare('SELECT COUNT(*) AS n FROM gmail_senders WHERE class IS NULL').get().n;
  console.log(`  ${done} senders SUGGESTED by the model (class_source='model').`);
  console.log('  Suggested is not decided: the probe scored 10/10 on unambiguous senders and');
  console.log('  2/5 on judgement calls, so these are for review, and a rule or your own');
  console.log('  correction overrides them.');
  if (failedBatches) console.log(`  ${failedBatches} batch(es) failed — that many senders are still unclassified.`);
  if (left) console.log(`  ${left} sender(s) remain NULL.`);
})();

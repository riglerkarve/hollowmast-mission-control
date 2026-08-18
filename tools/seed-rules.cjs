// Proposes the ledger's category vocabulary and its deterministic rules table, derived
// from the real five-year history rather than invented.
//
//   node tools/seed-rules.cjs            report coverage, write nothing   (default)
//   node tools/seed-rules.cjs --apply    write the rules and categorise
//
// Nothing here is a guess dressed as a measurement: the categories come from what the
// top 110 counterparties (89.5% of rows) actually are, and the coverage number below is
// computed against the imported ledger, not estimated.
'use strict';
require('./_run-log.cjs').record();

const db = require('../server/db');
// Provenance: every read this process makes is logged against this actor. Without it the
// access log records 'unknown', which is honest but useless. See server/provenance.js.
db.setProcessActor('claude');
require('../server/routes/finance');

// --- the vocabulary --------------------------------------------------------------
// Deliberately small. Every category here is one you would filter or budget by; none is
// a mechanism ("Faster Payment") or a direction ("Payments"), which is the mistake the
// bank's own 14 categories make with 67.6% of the rows.
const CATEGORIES = [
  // Neither spending nor income. MUST be excluded from every total.
  'Own transfer',

  // In
  'Benefits', 'Income - people', 'Interest', 'Refunds',

  // Out
  'Groceries', 'Eating out', 'Transport', 'Fuel', 'Housing', 'Phone & internet',
  'Subscriptions', 'Shopping', 'Entertainment', 'Travel', 'Gambling', 'Investing',
  'Payments to people', 'Cash withdrawn', 'Fees & charges', 'Other',
];

// 'Entertainment' and 'Travel' were added after the first pass, because the leftover rows
// asked for them: Wetherspoon, Steam, Skiddle, Travelodge and a hotel had nowhere honest
// to go. The vocabulary follows the data rather than the other way round.

// --- the rules -------------------------------------------------------------------
// [matchType, pattern, direction, category, note]
//   counterparty_exact     exact, case-insensitive
//   counterparty_contains  substring, case-insensitive
//   reference_contains     substring of the reference, case-insensitive
// direction: 'in' | 'out' | null (either). Measured worth: keying on counterparty ALONE
// leaves 51.1% of rows unambiguous; adding direction lifts it to 73.7%.
const RULES = [
  // --- own accounts: the single most consequential group ------------------------
  // 1,153 rows, 27.9% of the ledger. Jonathan Whiteford's references are explicit:
  // "Sent from Revolut" x104, "To Revolut" x98, "Paid with Starling" x73, "CHASE" x42.
  // Private Security Services is 724 rows of type TRANSFER, which is Starling's label for
  // movement between your own accounts and spaces.
  ['counterparty_exact', 'Jonathan Whiteford', null, 'Own transfer', 'Revolut / Chase / Starling, own accounts'],
  ['counterparty_exact', 'Private Security Services', null, 'Own transfer', '724 rows, all type TRANSFER'],
  ['counterparty_exact', 'My Revolut', null, 'Own transfer', null],
  ['counterparty_exact', 'Revolut', null, 'Own transfer', null],

  // --- income -------------------------------------------------------------------
  ['counterparty_contains', 'DWP', 'in', 'Benefits', 'PIP and Universal Credit'],
  ['counterparty_exact', 'Starling Bank', 'in', 'Interest', 'deposit interest'],
  ['counterparty_exact', 'Freetrade', null, 'Investing', null],
  ['counterparty_exact', 'Freetrade Limited', null, 'Investing', null],

  // --- groceries ----------------------------------------------------------------
  ...['Tesco', 'ALDI', 'Asda', 'Lidl', 'Iceland', "Sainsbury's", 'Poundland', "McColl's",
    'Martin Mccoll', 'Bosc Vegas', 'Welcome Bournemouth', 'Sea Road Food And Wine',
    'Central Convenience', 'Premier - Crescent Exp', 'Poole Convenience', 'Cornish Bakehouse',
    'Southern Co-Op', 'Co-op']
    .map((m) => ['counterparty_exact', m, 'out', 'Groceries', null]),

  // --- eating out ---------------------------------------------------------------
  ...["McDonald's", 'Greggs', 'Deliveroo', 'Just Eat', 'Subway Dolphin C', 'Drift',
    'Selecta Vending Machine', 'Cranford Festival Cate', 'Too Good To Go']
    .map((m) => ['counterparty_exact', m, 'out', 'Eating out', null]),

  // --- transport ----------------------------------------------------------------
  ...['Go South Coast', 'Beryl', 'Uber', 'Yellow Buses', 'Lansdowne Service Stat']
    .map((m) => ['counterparty_exact', m, 'out', 'Transport', null]),
  ['counterparty_exact', 'Shell', 'out', 'Fuel', null],

  // --- bills --------------------------------------------------------------------
  ...['Lebara', 'giffgaff'].map((m) => ['counterparty_exact', m, 'out', 'Phone & internet', null]),
  ['counterparty_exact', 'LA Poole Ltd', 'out', 'Housing', null],
  ['counterparty_contains', 'HOPE HOUSING', null, 'Housing', null],

  // --- subscriptions ------------------------------------------------------------
  ...['Spotify', 'Netflix', 'Microsoft', 'Patreon', 'PlayStation', 'Google Play', 'Google',
    'TikTok', 'OnlyFans', 'Chaturbill', 'Klarna', 'Vscott3510', 'Of']
    .map((m) => ['counterparty_exact', m, 'out', 'Subscriptions', null]),

  // --- shopping -----------------------------------------------------------------
  ...['Amazon', 'Amazon Marketplace', 'Primark', 'Cash Generator Bournem', 'CeX',
    'Tidal Vape', 'Mnk*tidal Vape', 'PayPal']
    .map((m) => ['counterparty_exact', m, 'out', 'Shopping', null]),

  // --- gambling -----------------------------------------------------------------
  ...['MrQ', 'BetMGM', 'Virgin Games'].map((m) => ['counterparty_exact', m, null, 'Gambling', null]),

  // --- cash ---------------------------------------------------------------------
  // 449 rows, GBP 38,219 out over 63 months. Categorised honestly as withdrawn, not as
  // spending: once it leaves the account the ledger genuinely does not know where it went.
  ['counterparty_exact', 'Cash Machine', null, 'Cash withdrawn', 'ATM'],
  ['counterparty_exact', 'Post Office Banking Services', null, 'Cash withdrawn', null],

  // --- fees ---------------------------------------------------------------------
  ['counterparty_exact', 'GoCardless', 'out', 'Fees & charges', 'direct debit processor'],

  // --- second pass: merchant families the exact matches missed --------------------
  // "Subway Dolphin C Poole" vs the rule "Subway Dolphin C"; "Sainsburys Loc4825" vs
  // "Sainsbury's". Branch names and store codes defeat exact matching, and a substring
  // rule is the right instrument. Kept narrow enough not to catch something else:
  // 'esso' as a substring would match plenty of words, so that one stays exact.
  ...[['subway', 'Eating out'], ['wetherspoon', 'Entertainment'], ['costa coffee', 'Eating out'],
    ['coffee no 1', 'Eating out'], ['promenade cafe', 'Eating out'], ['monicafe', 'Eating out'],
    ['american candy', 'Groceries'], ['usa sweet shop', 'Groceries'],
    ['sainsburys loc', 'Groceries'], ['home bargains', 'Shopping'], ['the range', 'Shopping'],
    ['taxi', 'Transport'], ['more bus', 'Transport'], ['south western railway', 'Transport'],
    ['asda petrol', 'Fuel'], ['tesco pfs', 'Fuel'],
    ['amzn', 'Shopping'], ['amazon', 'Shopping'], ['google', 'Subscriptions'],
    ['travelodge', 'Travel'], ['hotel', 'Travel'], ['skiddle', 'Entertainment']]
    .map(([m, c]) => ['counterparty_contains', m, 'out', c, 'branch names defeat exact match']),

  ...[['Esso', 'Fuel'], ['Wilko', 'Shopping'], ['Argos', 'Shopping'], ['Halfords', 'Shopping'],
    ['Steam', 'Entertainment'], ['Audible', 'Subscriptions'], ['Three', 'Phone & internet'],
    ['KFC', 'Eating out'], ['Mcdonalds', 'Eating out'], ['Southcote News', 'Groceries'],
    ]
    .map(([m, c]) => ['counterparty_exact', m, 'out', c, 'exact: substring would over-match']),

  // Gambling is direction-agnostic: Virgingames rows are winnings coming IN, which the
  // dead-rule check caught after the first pass filed it as 'out' and it matched nothing.
  ['counterparty_exact', 'Virgingames', null, 'Gambling', null],

  // Two bookmakers that were sitting in 'Payments to people' (#M23). Small in cash terms
  // -- GBP 100 of GBP 24,328 -- but 'Payments to people' is one of the two categories the
  // affordability tool treats as OPAQUE, on the grounds that money to a named individual
  // has no recorded purpose. These two DO have a known purpose, so leaving them there
  // makes the opacity figure look worse than it is, and that figure is load-bearing.
  //
  // EXACT, and for both the reason is a real collision rather than caution:
  //   'admiral'  is also a large UK insurer. A substring rule would sweep car insurance
  //              into Gambling.
  //   'coral'    is a first name as well as a bookmaker, and 'Ladbrokes Coral Group' is a
  //              separate counterparty already correctly filed. Checked the whole ledger:
  //              no person of that name appears.
  // One rule each covers every casing -- norm() lowercases, so 'Coral' also matches 'CORAL'.
  //
  // Direction-agnostic on purpose: the single 'CORAL' row is a CREDIT of GBP 68.31, i.e. a
  // win, which had been filed as 'Income - people'. An 'out' rule would leave it there.
  ['counterparty_exact', 'Admiral Casino', null, 'Gambling', null],
  ['counterparty_exact', 'Coral', null, 'Gambling', null],

  // Inbound PayPal is money coming back, not a purchase.
  // One rule, not two: matching is case-insensitive, so 'PayPal' also covers 'PAYPAL'.
  ['counterparty_exact', 'PayPal', 'in', 'Refunds', null],

  // --- direction defaults, LOWEST priority --------------------------------------
  // What remains after every merchant rule is 69% person-to-person Faster Payments
  // across 415 counterparties, most appearing once or twice. Direction is the honest
  // default: it says which way the money went and claims nothing about who they are.
  // These are matched LAST, so LA Poole Ltd stays Housing and Freetrade stays Investing.
  ['type_exact', 'FASTER PAYMENT', 'in', 'Income - people', 'default; refine per person'],
  ['type_exact', 'FASTER PAYMENT', 'out', 'Payments to people', 'default; refine per person'],
];

// --- matching --------------------------------------------------------------------
// "Jonathan Whiteford" and "Jonathan  Whiteford " are different strings and the same
// person: the second spelling appears 47 times in the business export. Normalising
// whitespace is not cosmetic, it is 47 rows that would otherwise fall to the model.
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

function categorise(tx, rules) {
  const dir = tx.amount_pence >= 0 ? 'in' : 'out';
  const cp = norm(tx.counterparty);
  const ref = norm(tx.reference);

  // Specific beats general, always. type_exact is a whole-mechanism default and must be
  // last, or "FASTER PAYMENT / out" would swallow rent, investing and every named
  // supplier that happens to be paid the same way.
  const order = ['counterparty_exact', 'counterparty_contains', 'reference_contains', 'type_exact'];
  for (const kind of order) {
    for (const r of rules) {
      if (r.match_type !== kind) continue;
      if (r.direction && r.direction !== dir) continue;
      const p = norm(r.pattern);
      const hit = kind === 'counterparty_exact' ? cp === p
        : kind === 'counterparty_contains' ? cp.includes(p)
        : kind === 'reference_contains' ? ref.includes(p)
        : norm(tx.type) === p;
      if (hit) return r;
    }
  }
  return null;
}

function main() {
  const APPLY = process.argv.includes('--apply');

  const rules = RULES.map(([match_type, pattern, direction, category, note]) => {
    if (!CATEGORIES.includes(category)) throw new Error(`rule uses unknown category "${category}"`);
    // '' means "either direction", NOT null. finance_rules.direction became NOT NULL in
    // finance migration 4, because SQLite treats NULLs as DISTINCT in a UNIQUE index -- so
    // UNIQUE(match_type, pattern, direction) never constrained a direction-less rule, the
    // ON CONFLICT below silently degraded to a plain INSERT, and this seed duplicated 12
    // rules the second time it ran. The RULES table above still writes null for "either",
    // which reads better there; it is normalised here, at the single point of entry.
    //
    // '' rather than a word like 'any' on purpose: the matcher tests `if (r.direction && ...)`
    // to mean "applies to either", and '' is falsy where 'any' would not be. So the
    // matching logic keeps working with no second edit that could be missed.
    return { match_type, pattern, direction: direction || '', category, note };
  });

  const seen = new Set();
  for (const r of rules) {
    const k = `${r.match_type}|${r.pattern.toLowerCase()}|${r.direction}`;
    if (seen.has(k)) throw new Error(`duplicate rule: ${k}`);
    seen.add(k);
  }

  const tx = db.prepare('SELECT id, counterparty, reference, type, amount_pence FROM finance_transactions').all();

  const byCat = new Map();
  const hits = [];
  let matched = 0;
  for (const t of tx) {
    const r = categorise(t, rules);
    if (!r) continue;
    matched += 1;
    hits.push([t.id, r.category]);
    byCat.set(r.category, (byCat.get(r.category) || 0) + 1);
  }

  const pct = (v) => `${((100 * v) / tx.length).toFixed(1)}%`;
  console.log(`\ntransactions   ${tx.length}`);
  console.log(`rules          ${rules.length}`);
  console.log(`matched        ${matched}  (${pct(matched)})`);
  console.log(`unmatched      ${tx.length - matched}  (${pct(tx.length - matched)})  <- the model's entire scope\n`);

  for (const [c, n] of [...byCat].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(5)}  ${pct(n).padStart(6)}  ${c}`);
  }

  // Which rules never fired? A rule that matches nothing is either a typo in the pattern
  // or a merchant that no longer appears — either way it should not sit there unnoticed.
  const fired = new Set();
  for (const t of tx) { const r = categorise(t, rules); if (r) fired.add(`${r.match_type}|${r.pattern}`); }
  const dead = rules.filter((r) => !fired.has(`${r.match_type}|${r.pattern}`));
  if (dead.length) {
    console.log(`\nRULES THAT MATCHED NOTHING (${dead.length}) — check the pattern:`);
    dead.forEach((r) => console.log(`  ${r.pattern}  -> ${r.category}`));
  }

  // The biggest things still uncategorised, so the next rules are chosen by evidence.
  const unmatchedCp = new Map();
  for (const t of tx) {
    if (categorise(t, rules)) continue;
    const k = t.counterparty;
    if (!unmatchedCp.has(k)) unmatchedCp.set(k, { n: 0, out: 0, inn: 0 });
    const e = unmatchedCp.get(k);
    e.n += 1;
    if (t.amount_pence < 0) e.out -= t.amount_pence; else e.inn += t.amount_pence;
  }
  // What KIND of thing is left? Computed with the real matcher — a second, cheaper
  // reimplementation of this same question disagreed with it by a factor of two,
  // because it silently missed every rule generated by .map().
  const leftover = new Map();
  for (const t of tx) {
    if (categorise(t, rules)) continue;
    const k = `${t.type} / ${t.amount_pence >= 0 ? 'in' : 'out'}`;
    leftover.set(k, (leftover.get(k) || 0) + 1);
  }
  const rem = tx.length - matched;
  console.log('\nWHAT IS LEFT, by type and direction:');
  [...leftover].sort((a, b) => b[1] - a[1]).forEach(([k, v]) =>
    console.log(`  ${String(v).padStart(4)}  ${((100 * v) / rem).toFixed(1).padStart(5)}%  ${k}`));

  console.log(`\nLARGEST UNCATEGORISED COUNTERPARTIES (${unmatchedCp.size} distinct):`);
  [...unmatchedCp].sort((a, b) => b[1].n - a[1].n).slice(0, 15)
    .forEach(([k, e]) => console.log(`  ${String(e.n).padStart(4)}  out ${(e.out / 100).toFixed(0).padStart(6)}  in ${(e.inn / 100).toFixed(0).padStart(6)}  ${k}`));

  if (!APPLY) {
    console.log('\nnothing written. re-run with --apply to save the rules and categorise.');
    return;
  }

  db.exec('BEGIN');
  try {
    const ins = db.prepare(
      `INSERT INTO finance_rules (match_type, pattern, direction, category, note) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(match_type, pattern, direction) DO UPDATE SET category = excluded.category, note = excluded.note`
    );
    rules.forEach((r) => ins.run(r.match_type, r.pattern, r.direction, r.category, r.note));

    // Never overwrite a manual decision. A rule is a default, not an authority.
    const upd = db.prepare(
      `UPDATE finance_transactions SET category = ?, category_source = 'rule'
       WHERE id = ? AND (category_source IS NULL OR category_source = 'rule')`
    );
    let n = 0;
    hits.forEach(([id, cat]) => { n += upd.run(cat, id).changes; });
    db.exec('COMMIT');
    console.log(`\napplied: ${rules.length} rules stored, ${n} transactions categorised (manual ones left alone)`);
  } catch (err) {
    db.exec('ROLLBACK');
    console.error('FAILED, rolled back:', err.message);
    process.exit(1);
  }
}

main();

#!/usr/bin/env node
//
// verify-m73-needs-owner.cjs -- prove migration 9 against the pre-M73 control snapshot.
//
// This reads baselines/m73-needs-owner-before.json; it never regenerates or writes it.
// Run after the route has loaded (requiring it applies outstanding migrations):
//
//   node tools/verify-m73-needs-owner.cjs
//
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const db = require('../server/db');
// Written by the Codex Worker; reads only. Attributed by the architect session on commit,
// because provenance-check refuses an in-process database user that names nobody.
db.setProcessActor('claude');
const team = require('../server/routes/team'); // applies migration 9 before inspection

const baselinePath = path.join(__dirname, '..', 'baselines', 'm73-needs-owner-before.json');
const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
const blocks = baseline.rows || [];
const controlTotal = baseline.total_bytes;
let failures = 0;
const fail = (message) => { failures += 1; console.log(`FAIL  ${message}`); };
const hash = (text) => crypto.createHash('sha256').update(text).digest('hex');

console.log(`M73 control: ${blocks.length} blocks, ${controlTotal} characters (the committed key is named total_bytes, but its value is the character total)`);
console.log(`Control file: ${baselinePath} (read only)`);

let recovered = 0;
let actualChars = 0;
const expectedKeys = new Set();
const residue = [];

for (const block of blocks) {
  const row = db.prepare('SELECT id, title, needs_owner, owner_items_state FROM team_handovers WHERE id = ?').get(block.id);
  if (!row) {
    fail(`#${block.id} ${block.title}: handover no longer exists`);
    continue;
  }
  const text = row.needs_owner;
  const chars = String(text == null ? '' : text).length;
  const digest = text == null ? null : hash(text);
  if (text !== block.needs_owner || chars !== block.needs_owner_chars || digest !== block.needs_owner_sha256) {
    fail(`#${block.id} ${block.title}: original block differs (chars ${chars}/${block.needs_owner_chars}, sha ${digest || 'null'})`);
    continue;
  }
  recovered += 1;
  actualChars += chars;

  const parsed = team.ownerItemsFromBlock(text);
  const filings = db.prepare(`SELECT f.item_id, f.source_text, f.parse_state, o.title, o.text
                              FROM team_owner_item_filings f
                              JOIN team_owner_items o ON o.id = f.item_id
                              WHERE f.handover_id = ? ORDER BY f.item_id`).all(block.id);
  if (row.owner_items_state !== parsed.state) {
    fail(`#${block.id} ${block.title}: stored state ${row.owner_items_state || 'NULL'} is not ${parsed.state}`);
  }
  if (filings.length !== parsed.items.length) {
    fail(`#${block.id} ${block.title}: ${filings.length} item filing(s), expected ${parsed.items.length}`);
  }
  const got = filings.map((f) => f.source_text);
  for (const item of parsed.items) {
    const n = got.indexOf(item);
    if (n < 0) fail(`#${block.id} ${block.title}: an expected item has no exact filing`);
    else got.splice(n, 1);
    expectedKeys.add(team.ownerItemKey(block.title, item));
  }
  if (got.length) fail(`#${block.id} ${block.title}: ${got.length} unexpected item filing(s)`);
  if (parsed.state === 'unsplit') residue.push(`#${block.id} ${block.title} (${chars} chars; preserved whole)`);
}

const duplicateRows = db.prepare(`SELECT fingerprint, COUNT(*) n FROM team_owner_items
                                  GROUP BY fingerprint HAVING COUNT(*) > 1`).all();
if (duplicateRows.length) fail(`${duplicateRows.length} duplicate canonical fingerprint(s) exist`);

const baselineItemRows = db.prepare(`SELECT DISTINCT o.fingerprint
                                     FROM team_owner_items o
                                     JOIN team_owner_item_filings f ON f.item_id = o.id
                                     WHERE f.handover_id IN (${blocks.map(() => '?').join(',')})`).all(...blocks.map((b) => b.id));
const actualKeys = new Set(baselineItemRows.map((r) => r.fingerprint));
for (const key of expectedKeys) if (!actualKeys.has(key)) fail('a baseline ask has no canonical item');
for (const key of actualKeys) if (!expectedKeys.has(key)) fail('a canonical item is not traceable to a baseline ask');

if (actualChars !== controlTotal) fail(`recovered characters ${actualChars}, control total ${controlTotal}`);
console.log(`Recovered verbatim: ${recovered}/${blocks.length} blocks; ${actualChars}/${controlTotal} characters.`);
console.log(`Canonical asks from control: ${actualKeys.size}; expected after exact re-filing collapse: ${expectedKeys.size}.`);
console.log(`Duplicate canonical rows: ${duplicateRows.length}.`);
if (residue.length) {
  console.log(`Residue — ${residue.length} block(s) not confidently split:`);
  for (const line of residue) console.log(`  ${line}`);
} else {
  console.log('Residue — none. Every block met the deliberately strict top-level-list rule.');
}

if (failures) {
  console.log(`PROOF FAILED — ${failures} discrepancy(s).`);
  process.exitCode = 1;
} else {
  console.log('PROOF PASSED — control text survives, every derived filing matches it, and canonical asks are unique.');
}

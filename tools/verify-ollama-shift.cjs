#!/usr/bin/env node
'use strict';

// verify-ollama-shift.cjs — audit existing kind labels against deterministic rules only.
//
// The table has no kind_source column, so current rows cannot establish which 21 labels came
// from a model. This reports that provenance absence, then checks the broadest honest scope:
// every existing label for which the deterministic rule itself has an answer. It never calls a
// model and opens the live database read-only.

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.join(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data', 'dashboard.db');

function byRule(title) {
  const t = String(title || '').toLowerCase();
  if (/\bdoes not|is not|cannot|fails|broken|wrong|silently|incorrect|regress|leak\b/.test(t)) return 'bug';
  if (/^(add|build|create|implement|expand|introduce) /.test(t)) return 'feature';
  if (/\b(investigate|research|decide|which|whether|should we|\?)\b/.test(t)) return 'question';
  if (/\b(rename|tidy|update the doc|consolidate|archive|clean up|move the)\b/.test(t)) return 'chore';
  return null;
}

let db;
try {
  if (!fs.existsSync(DB_PATH)) throw new Error(`database absent: ${DB_PATH}`);
  db = new DatabaseSync(DB_PATH, { readOnly: true });
  const columns = new Set(db.prepare('PRAGMA table_info(todo_items)').all().map((row) => row.name));
  const hasProvenance = columns.has('kind_source');
  const shiftSource = fs.readFileSync(path.join(ROOT, 'tools', 'ollama-shift.cjs'), 'utf8');
  const ollama = require('../server/ollama');
  const namedModel = /qwen\d|gpt-oss/i.test(shiftSource);
  const rows = db.prepare('SELECT id, title, kind FROM todo_items WHERE kind IS NOT NULL ORDER BY id').all();
  const comparable = rows.map((row) => ({ ...row, rule: byRule(row.title) })).filter((row) => row.rule);
  const disagreements = comparable.filter((row) => row.kind !== row.rule);

  console.log(`LIVE DATABASE OPENED READ-ONLY: ${DB_PATH}`);
  console.log(`KIND PROVENANCE: ${hasProvenance ? 'recorded' : 'ABSENT — model-written rows cannot be isolated from existing data'}`);
  console.log(`MODEL DEFAULT: ${!namedModel && ollama.LOCAL_DEFAULT && ollama.CLOUD_DEFAULT ? 'shared client only' : 'FAIL — tool still names a model or client default is absent'}`);
  console.log(`RULE-COMPARABLE LABELS: ${comparable.length}; disagreements: ${disagreements.length}`);
  for (const row of disagreements) console.log(`  ${row.id}: stored ${row.kind}, deterministic rule ${row.rule}`);
  console.log(hasProvenance
    ? 'This scope can be narrowed to the recorded model rows.'
    : 'No labels were overwritten. Adding provenance would be a separate schema/ownership decision.');
  process.exitCode = disagreements.length || namedModel || !ollama.LOCAL_DEFAULT || !ollama.CLOUD_DEFAULT ? 1 : 0;
} catch (error) {
  console.error(`COULD NOT AUDIT kind labels: ${error.message}`);
  process.exitCode = 2;
} finally {
  try { if (db) db.close(); } catch { /* read-only handle cleanup */ }
}

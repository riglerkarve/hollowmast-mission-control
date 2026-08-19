#!/usr/bin/env node
//
// schema-integrity.cjs — Batch E (M94–M98): read the shipped schema and the
// code that accesses it, then report integrity and provenance gaps.
//
// This tool deliberately opens the database read-only. It never requires
// server/db.js: requiring that module runs migrations and opens the live file
// writable, which would turn an audit into a database write.
//
//   node tools/schema-integrity.cjs
//   node tools/schema-integrity.cjs --db C:\path\to\copy.db
//
'use strict';
// A run against an explicit --db path is a test/probe. Do not let telemetry turn that
// into a write to the live dashboard database: the report itself is self-contained and
// the test command prints its temporary path instead.
if (!process.argv.includes('--db') && !process.argv.includes('--self-test')) require('./_run-log.cjs').record();

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.join(__dirname, '..');
const LIVE_DB = path.join(ROOT, 'data', 'dashboard.db');
const argv = process.argv.slice(2);
const dbArg = argv.indexOf('--db');
const selfTest = argv.includes('--self-test');
let probeDir = null;
let dbPath = path.resolve(dbArg >= 0 && argv[dbArg + 1] ? argv[dbArg + 1] : LIVE_DB);

if (selfTest) {
  probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-control-schema-integrity-'));
  dbPath = path.join(probeDir, 'batch-e-probe.db');
  const probe = new DatabaseSync(dbPath);
  probe.exec('PRAGMA foreign_keys = OFF; CREATE TABLE parent (id TEXT PRIMARY KEY); CREATE TABLE child (parent_id TEXT REFERENCES parent(id)); CREATE UNIQUE INDEX child_parent_unique ON child(parent_id);');
  probe.prepare('INSERT INTO child(parent_id) VALUES (?)').run(null);
  probe.prepare('INSERT INTO child(parent_id) VALUES (?)').run(null);
  probe.prepare('INSERT INTO child(parent_id) VALUES (?)').run('missing-parent');
  probe.close();
}

if (!fs.existsSync(dbPath)) {
  console.error(`COULD NOT LOOK: database does not exist: ${dbPath}`);
  process.exit(2);
}

// node:sqlite's readOnly option is part of the safety claim this tool makes.
const db = new DatabaseSync(dbPath, { readOnly: true });

const q = (name) => `"${String(name).replace(/"/g, '""')}"`;
const cleanIdent = (name) => String(name || '').trim().replace(/^[\[\`"]|[\]\`"]$/g, '').replace(/^.*\./, '');
const escaped = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const lineAt = (text, offset) => text.slice(0, offset).split(/\r?\n/).length;

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(file));
    else if (/\.(?:cjs|js|mjs)$/i.test(entry.name)) out.push(file);
  }
  return out;
}

function sourceFiles(relative) {
  const dir = path.join(ROOT, relative);
  return fs.existsSync(dir) ? walk(dir).map((file) => ({
    file,
    relative: path.relative(ROOT, file).replace(/\\/g, '/'),
    text: fs.readFileSync(file, 'utf8'),
  })) : [];
}

const serverFiles = sourceFiles('server');
const toolFiles = sourceFiles('tools');
const accessFiles = [...serverFiles, ...toolFiles];

function tables() {
  return db.prepare("SELECT name, sql FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all('table');
}

const tableRows = tables();
const tableNames = new Set(tableRows.map((row) => row.name));
const columnsByTable = new Map(tableRows.map((row) => [
  row.name,
  db.prepare(`PRAGMA table_info(${q(row.name)})`).all(),
]));

function findColumnWrites(table, column) {
  const hits = [];
  const insert = new RegExp(`\\bINSERT(?:\\s+OR\\s+\\w+)?\\s+INTO\\s+(?:[\\[\\x60\"]?${escaped(table)}[\\]\\x60\"]?)\\s*\\(([^)]*)\\)`, 'gi');
  const update = new RegExp(`\\bUPDATE\\s+(?:[\\[\\x60\"]?${escaped(table)}[\\]\\x60\"]?)\\s+SET\\s+([\\s\\S]{0,2000}?)(?=\\bWHERE\\b|;|\\n\\s*[\\x60\"]?\\)|$)`, 'gi');

  for (const source of accessFiles) {
    let match;
    while ((match = insert.exec(source.text))) {
      const cols = match[1].split(',').map(cleanIdent);
      if (cols.includes(column)) hits.push(`${source.relative}:${lineAt(source.text, match.index)} INSERT`);
    }
    while ((match = update.exec(source.text))) {
      const assignments = match[1].split(',');
      if (assignments.some((part) => new RegExp(`^\\s*[\\[\\x60\"]?${escaped(column)}[\\]\\x60\"]?\\s*=`).test(part))) {
        hits.push(`${source.relative}:${lineAt(source.text, match.index)} UPDATE`);
      }
    }
  }
  return [...new Set(hits)];
}

function reportUniqueIndexes() {
  console.log('\nM94 — UNIQUE indexes with nullable key columns');
  const results = [];
  for (const table of tableRows) {
    const cols = columnsByTable.get(table.name);
    const byName = new Map(cols.map((col) => [col.name, col]));
    for (const index of db.prepare(`PRAGMA index_list(${q(table.name)})`).all()) {
      // PRIMARY KEY backing indexes are not UNIQUE constraints. Treating SQLite's
      // implementation index as one makes nullable TEXT primary keys false positives.
      if (!index.unique || index.origin === 'pk') continue;
      const keys = db.prepare(`PRAGMA index_info(${q(index.name)})`).all().sort((a, b) => a.seqno - b.seqno);
      const expressions = keys.filter((key) => !key.name);
      const nullable = keys.filter((key) => key.name && !byName.get(key.name)?.notnull).map((key) => key.name);
      const keyNames = keys.map((key) => key.name || '<expression>');
      const row = { table: table.name, index: index.name, origin: index.origin, keyNames, nullable, expressions };
      if (!nullable.length || expressions.length) {
        results.push(row);
        continue;
      }

      const missing = nullable.map((name) => `${q(name)} IS NULL`).join(' OR ');
      const fixed = keys.filter((key) => key.name && !nullable.includes(key.name)).map((key) => q(key.name));
      const missingKeyRows = db.prepare(`SELECT COUNT(*) AS n FROM ${q(table.name)} WHERE ${missing}`).get().n;
      let groups = [];
      if (fixed.length) {
        groups = db.prepare(
          `SELECT COUNT(*) AS n FROM ${q(table.name)} WHERE ${missing} GROUP BY ${fixed.join(', ')} HAVING COUNT(*) > 1`,
        ).all();
      } else if (missingKeyRows > 1) {
        groups = [{ n: missingKeyRows }];
      }
      row.missingKeyRows = missingKeyRows;
      row.potentialCollisionGroups = groups.length;
      row.rowsInPotentialCollisionGroups = groups.reduce((sum, group) => sum + group.n, 0);
      results.push(row);
    }
  }

  for (const row of results) {
    const nullable = row.nullable.length ? `nullable=[${row.nullable.join(', ')}]` : 'all key columns NOT NULL';
    let evidence = '';
    if (row.expressions.length) evidence = ' expression key: nullability could not be derived';
    else if (row.nullable.length) evidence = ` missing-key rows=${row.missingKeyRows}; potential collision groups=${row.potentialCollisionGroups}; rows in groups=${row.rowsInPotentialCollisionGroups}`;
    console.log(`  ${row.table}.${row.index} (${row.origin || 'unknown'}): keys=[${row.keyNames.join(', ')}]; ${nullable}.${evidence}`);
  }
  const atRisk = results.filter((row) => row.nullable.length && !row.expressions.length);
  const primaryBacking = tableRows.reduce((n, table) => n + db.prepare(`PRAGMA index_list(${q(table.name)})`).all()
    .filter((index) => index.unique && index.origin === 'pk').length, 0);
  console.log(`  RESULT: ${results.length} UNIQUE constraint/index(es); ${atRisk.length} contain nullable key columns. Excluded ${primaryBacking} primary-key backing index(es), which are not UNIQUE constraints.`);
  return { total: results.length, nullable: atRisk.length };
}

function parentColumns(parentTable, fk) {
  if (!tableNames.has(parentTable)) return { error: `parent table ${parentTable} is missing` };
  if (fk.every((part) => part.to)) return { columns: fk.map((part) => part.to) };
  const primary = (columnsByTable.get(parentTable) || []).filter((col) => col.pk).sort((a, b) => a.pk - b.pk).map((col) => col.name);
  if (primary.length !== fk.length) return { error: `parent key is implicit but ${parentTable} has ${primary.length} primary-key column(s) for ${fk.length} child column(s)` };
  return { columns: primary };
}

function sqlValue(value) {
  if (value === null) return 'NULL';
  const text = String(value);
  return JSON.stringify(text.length > 120 ? `${text.slice(0, 117)}...` : text);
}

function reportForeignKeys() {
  console.log('\nM95 — orphaned foreign-key rows');
  let totalRelations = 0;
  let orphanRows = 0;
  let couldNotInspect = 0;
  for (const table of tableRows) {
    const raw = db.prepare(`PRAGMA foreign_key_list(${q(table.name)})`).all();
    const groups = new Map();
    for (const fk of raw) groups.set(fk.id, [...(groups.get(fk.id) || []), fk]);
    for (const [id, parts] of groups) {
      totalRelations += 1;
      const ordered = parts.sort((a, b) => a.seq - b.seq);
      const parentTable = ordered[0].table;
      const parent = parentColumns(parentTable, ordered);
      const childCols = ordered.map((part) => part.from);
      if (parent.error || childCols.some((name) => !name)) {
        couldNotInspect += 1;
        console.log(`  ${table.name} FK #${id} -> ${ordered[0].table}: COULD NOT LOOK — ${parent.error || 'child column missing'}`);
        continue;
      }
      const allPresent = childCols.map((name) => `c.${q(name)} IS NOT NULL`).join(' AND ');
      const match = childCols.map((name, index) => `p.${q(parent.columns[index])} = c.${q(name)}`).join(' AND ');
      const where = `${allPresent} AND NOT EXISTS (SELECT 1 FROM ${q(parentTable)} p WHERE ${match})`;
      const count = db.prepare(`SELECT COUNT(*) AS n FROM ${q(table.name)} c WHERE ${where}`).get().n;
      orphanRows += count;
      const samples = db.prepare(
        `SELECT ${childCols.map((name) => `c.${q(name)} AS ${q(name)}`).join(', ')} FROM ${q(table.name)} c WHERE ${where} LIMIT 3`,
      ).all();
      const sampleText = samples.length
        ? ` sample=${samples.map((sample) => Object.entries(sample).map(([k, v]) => `${k}=${sqlValue(v)}`).join(', ')).join(' | ')}`
        : '';
      console.log(`  ${table.name} FK #${id} (${childCols.join(', ')} -> ${parentTable}.${parent.columns.join(', ')}): orphan rows=${count}.${sampleText}`);
    }
  }
  console.log(`  RESULT: ${totalRelations} foreign-key relation(s); orphan rows=${orphanRows}; could not inspect=${couldNotInspect}.`);
  return { totalRelations, orphanRows, couldNotInspect };
}

function reportAlteredColumns() {
  console.log('\nM96 — columns added by ALTER TABLE and their static writers');
  const altered = [];
  const dynamicMigrations = new Set();
  const re = /ALTER\s+TABLE\s+([\[\]`"\w.]+)\s+ADD\s+(?:COLUMN\s+([\[\]`"\w]+)|([\[\]`"\w]+))/gi;
  for (const source of serverFiles) {
    let match;
    while ((match = re.exec(source.text))) {
      if (match[0].includes('${') || /ADD\s+COLUMN\s+\$\{/.test(source.text.slice(match.index, match.index + 200))) {
        dynamicMigrations.add(`${source.relative}:${lineAt(source.text, match.index)}`);
        continue;
      }
      altered.push({ table: cleanIdent(match[1]), column: cleanIdent(match[2] || match[3]), source: `${source.relative}:${lineAt(source.text, match.index)}` });
    }
  }
  const unique = new Map();
  for (const entry of altered) unique.set(`${entry.table}\u0000${entry.column}`, entry);
  let noWriter = 0;
  for (const entry of [...unique.values()].sort((a, b) => a.table.localeCompare(b.table) || a.column.localeCompare(b.column))) {
    const writers = findColumnWrites(entry.table, entry.column);
    if (!writers.length) noWriter += 1;
    const dynamicCandidates = accessFiles.filter((source) => source.text.includes(entry.table) && source.text.includes(entry.column)
      && /\b(?:INSERT|UPDATE)\b/.test(source.text) && source.text.includes('${')).map((source) => source.relative);
    console.log(`  ${entry.table}.${entry.column} (added ${entry.source}): ${writers.length ? `written by ${writers.join('; ')}` : 'NO STATIC INSERT/UPDATE WRITER FOUND'}${dynamicCandidates.length ? `; dynamic SQL blind spot in ${dynamicCandidates.join(', ')}` : ''}`);
  }
  console.log(`  RESULT: ${unique.size} statically named altered column(s); ${noWriter} with no static writer. Dynamic or positional SQL is reported as a blind spot, not a clean result.`);
  console.log(`  MIGRATION BLIND SPOT: dynamic ALTER TABLE column names in ${dynamicMigrations.size ? [...dynamicMigrations].join(', ') : 'none found'}.`);
  return { altered: unique.size, noWriter };
}

function sourceAccess(table, source) {
  const name = `(?:[\\[\\x60\"]?${escaped(table)}[\\]\\x60\"]?)`;
  const reads = new RegExp(`\\b(?:FROM|JOIN)\\s+${name}\\b`, 'i').test(source.text);
  const writes = new RegExp(`\\b(?:INSERT(?:\\s+OR\\s+\\w+)?\\s+INTO|UPDATE|DELETE\\s+FROM)\\s+${name}\\b`, 'i').test(source.text);
  return { reads, writes };
}

function reportTableReads() {
  console.log('\nM97 — static table read/write crosswalk');
  const totals = { read: 0, writtenOnly: 0, untouched: 0 };
  for (const table of tableRows) {
    const readers = [];
    const writers = [];
    for (const source of accessFiles) {
      const use = sourceAccess(table.name, source);
      if (use.reads) readers.push(source.relative);
      if (use.writes) writers.push(source.relative);
    }
    const status = readers.length ? 'read' : writers.length ? 'written-only' : 'untouched';
    totals[status === 'written-only' ? 'writtenOnly' : status] += 1;
    console.log(`  ${table.name}: ${status}; readers=${readers.length ? readers.join(', ') : '-'}; writers=${writers.length ? writers.join(', ') : '-'}`);
  }
  const dynamic = accessFiles.filter((source) => /\b(?:SELECT|INSERT|UPDATE|DELETE)\b[\s\S]{0,300}\$\{|\$\{[\s\S]{0,300}\b(?:SELECT|INSERT|UPDATE|DELETE)\b/.test(source.text))
    .map((source) => source.relative);
  console.log(`  RESULT: read=${totals.read}; written-only=${totals.writtenOnly}; untouched=${totals.untouched}.`);
  console.log(`  BLIND SPOT: dynamic SQL may evade this static scan. Files containing SQL interpolation: ${dynamic.length ? dynamic.join(', ') : 'none found'}.`);
  return totals;
}

const DECISION_COLUMNS = /^(?:status|done|completed_at|title|text|label|category|priority|owner|project|kind|rationale|decision|note|pinned|reviewed|enabled|active|goal|target|choice|preference|assigned_to|visibility)$/i;
const INFRA_TABLES = new Set(['schema_meta', 'data_access_log', 'tool_runs']);
const ACTOR_ALIASES = new Set(['set_by', 'asked_by', 'prose_by', 'claimed_by', 'arbiter', 'resolved_by', 'owner_resolved_by']);

function reportProvenance() {
  console.log('\nM98 — provenance coverage and actorless decision candidates');
  let stamped = 0;
  let candidates = 0;
  for (const table of tableRows) {
    const cols = columnsByTable.get(table.name).map((col) => col.name);
    if (cols.includes('by_whom')) {
      stamped += 1;
      console.log(`  ${table.name}: by_whom PRESENT — provenance is stored with the row.`);
      continue;
    }
    const actorAliases = cols.filter((col) => ACTOR_ALIASES.has(col));
    if (actorAliases.length) {
      console.log(`  ${table.name}: by_whom ABSENT — actor field(s) ${actorAliases.join(', ')} provide table-specific provenance; no unaccounted decision candidate from the schema.`);
      continue;
    }
    const decisionFields = cols.filter((col) => DECISION_COLUMNS.test(col));
    if (INFRA_TABLES.has(table.name)) {
      console.log(`  ${table.name}: by_whom ABSENT — no decision candidate; infrastructure metadata (${cols.join(', ')}).`);
    } else if (decisionFields.length) {
      candidates += 1;
      console.log(`  ${table.name}: by_whom ABSENT — ACTORLESS DECISION CANDIDATE because persisted field(s) ${decisionFields.join(', ')} can record a human/session choice. Columns: ${cols.join(', ')}.`);
    } else {
      console.log(`  ${table.name}: by_whom ABSENT — no decision-shaped persisted field found; columns: ${cols.join(', ')}.`);
    }
  }
  console.log(`  RESULT: ${stamped}/${tableRows.length} table(s) store by_whom; ${candidates} actorless decision candidate(s). The classification is schema-based, not a claim about every row's origin.`);
  return { stamped, candidates };
}

try {
  console.log('Schema Integrity — Batch E (M94–M98)');
  console.log(`DATABASE: ${dbPath}`);
  console.log('MODE: DatabaseSync(..., { readOnly: true }); the database was never opened writable.');
  console.log(`SOURCE SCOPE: ${serverFiles.length} server file(s), ${toolFiles.length} tool file(s); ${tableRows.length} table(s).`);
  const results = {
    unique: reportUniqueIndexes(),
    foreignKeys: reportForeignKeys(),
    altered: reportAlteredColumns(),
    reads: reportTableReads(),
    provenance: reportProvenance(),
  };
  console.log(`\nSUMMARY: ${JSON.stringify(results)}`);
} finally {
  db.close();
  if (probeDir) fs.rmSync(probeDir, { recursive: true, force: true });
}

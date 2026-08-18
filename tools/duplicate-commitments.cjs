#!/usr/bin/env node
//
// duplicate-commitments.cjs — the same commitment held in two modules.
//
//   node tools/duplicate-commitments.cjs
//
// M65, decided 18 Aug 2026. THE RULE THE OWNER CHOSE:
//
//   The SCHEDULE owns a date somebody else set   — a GP appointment, a course, a hearing.
//   The BACKLOG owns intent                      — renewing a passport, replacing a licence.
//
// It splits on who chose the date, which is a question answerable without thinking, and that is
// what makes a rule survive contact with a busy week.
//
// WHY THIS ONLY REPORTS. Applying the rule means deciding, per item, who set the date — and
// that is a fact about your life, not about the data. A script that guessed would delete diary
// entries on a hunch. So this finds the overlaps and states which side the rule points to; a
// person spends five minutes and it is done once.
//
// IT IS A TOOL, NOT A MODULE, and reads both tables directly. The one-owner rule governs
// modules computing figures that then disagree; a read-only audit that computes nothing and
// stores nothing is not that. It is also why this lives in tools/ rather than inside either
// module — neither owns the boundary between them.
'use strict';

const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DB = path.join(__dirname, '..', 'data', 'dashboard.db');
const db = new DatabaseSync(DB, { readOnly: true });

// Words too common to imply two things are the same commitment. Kept short and visible rather
// than tuned: a long stop-list quietly decides what counts as a match.
const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'for', 'to', 'my', 'personal', 'goal',
  'new', 'get', 'do', 'book', 'sort', 'out', 'up', 'in', 'on', 'at', 'with']);

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
  .filter((w) => w.length > 2 && !STOP.has(w));

const events = db.prepare(
  "SELECT id, title, starts_at, status FROM schedule_events WHERE status IS NULL OR status != 'cancelled'"
).all();
const items = db.prepare(
  "SELECT id, title, status FROM todo_items WHERE status IN ('open', 'in_progress')"
).all();

const pairs = [];
for (const e of events) {
  const a = norm(e.title);
  if (!a.length) continue;
  for (const t of items) {
    const b = norm(t.title);
    if (!b.length) continue;
    const shared = a.filter((w) => b.includes(w));
    // Two significant words in common, or one title's words wholly inside the other.
    const containment = a.every((w) => b.includes(w)) || b.every((w) => a.includes(w));
    if (shared.length >= 2 || (containment && shared.length >= 1)) {
      pairs.push({ event: e, item: t, shared });
    }
  }
}

console.log(`  ${events.length} live schedule event(s), ${items.length} open backlog item(s)`);

if (!pairs.length) {
  console.log('\n  No overlaps found.');
  console.log('  Note that is a weak result, not a strong one: this matches on words, so the same');
  console.log('  commitment worded two different ways is invisible to it.');
  process.exit(0);
}

console.log(`\n  ${pairs.length} pair(s) look like the same commitment held twice:\n`);
for (const p of pairs) {
  const day = String(p.event.starts_at || '').slice(0, 10);
  console.log(`    schedule #${p.event.id}  ${day}  ${p.event.title}`);
  console.log(`    backlog  ${p.item.id}${' '.repeat(Math.max(1, 12 - String(p.item.id).length))}${p.item.title}`);
  console.log(`      shared: ${p.shared.join(', ')}`);
  console.log('      → ask who set the date. Someone else: the schedule keeps it and the backlog');
  console.log('        item closes. You did: the backlog keeps it and the diary entry goes.');
  console.log('');
}

console.log('  Nothing was changed. Deciding who set a date is a fact about your life, not the data.');
console.log('  Blind to: differently-worded duplicates, cancelled events, and closed backlog items.');

const express = require('express');
const db = require('../db');
const finance = require('./finance');

// ------------------------------------------------------------------------------------
// BROWSING. Where your attention actually goes, imported from Edge. Backlog #12.
//
// DOMAINS AND COUNTS ONLY. No URLs, no page titles, ever — not in this table, not in the
// importer. The reasoning is not squeamishness: this database is served on 0.0.0.0 behind
// one shared secret, and it already holds ten account-years of bank transactions. A full
// URL history would mean a single leaked key exposes every page you have read, which is a
// materially different loss from exposing a spending total. Domain-level aggregates answer
// the question the backlog item actually asks and cost far less if they escape.
//
// WHAT IT DERIVES, because an import that only stores would fail the gate:
//
//   - where attention concentrates, as visits per domain over the imported window
//   - PAID FOR BUT NOT VISITED: services the ledger is still being charged for that do not
//     appear in browsing at all. That is the one cross-module question neither half can
//     answer alone, and it is the reason this module asks finance rather than duplicating
//     its figures.
//
// It does not judge what you browse. Same rule as the services audit: inventory, never
// verdict. There is no "wasted time" figure here and there will not be one — that would be
// a weighting I invented, presented as a measurement.
db.migrate('browsing', [
  (d) => {
    d.exec(`
      CREATE TABLE browsing_domains (
        domain      TEXT PRIMARY KEY,
        visits      INTEGER NOT NULL,
        pages       INTEGER NOT NULL,   -- distinct URLs seen, kept as a COUNT only
        first_seen  TEXT,               -- ISO date
        last_seen   TEXT,
        source      TEXT NOT NULL,      -- 'edge'
        imported_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
      );

      CREATE INDEX idx_browsing_visits ON browsing_domains(visits DESC);
    `);
  },
]);

const router = express.Router();

// The window the import actually covers. A browser prunes its own history, so this is not
// "all time" and must never be presented as it.
function span() {
  return db.prepare(
    'SELECT MIN(first_seen) a, MAX(last_seen) b, COUNT(*) n, SUM(visits) v FROM browsing_domains'
  ).get();
}

// Normalises a domain for comparison against a merchant name. Deliberately crude and
// deliberately reported as crude: 'www.netflix.com' -> 'netflix'.
const stem = (d) => String(d || '').toLowerCase()
  .replace(/^www\./, '')
  .replace(/\.(co\.uk|com|net|org|io|dev|app|tv|gg)$/, '')
  .split('.').pop();

router.get('/', (req, res) => {
  const s = span();
  if (!s.n) {
    return res.json({
      state: 'empty',
      message: 'Nothing imported yet. Run: node tools/import-browsing.cjs',
      note: 'Empty because no import has run — not because you have not browsed.',
    });
  }

  const top = db.prepare('SELECT * FROM browsing_domains ORDER BY visits DESC LIMIT 25').all();

  // PAID FOR BUT NOT VISITED. Asked of finance rather than read from its tables.
  const services = finance.recurring().services || [];
  const domains = db.prepare('SELECT domain FROM browsing_domains').all().map((r) => stem(r.domain));
  const seen = new Set(domains);

  const paidNotVisited = services
    .filter((sv) => !seen.has(stem(sv.name.replace(/\s+/g, ''))) && !domains.some((d) => d && sv.name.toLowerCase().includes(d)))
    .map((sv) => ({ name: sv.name, status: sv.status, lastOn: sv.lastOn, totalPence: sv.totalPence }));

  res.json({
    state: 'ok',
    window: { from: s.a, to: s.b, domains: s.n, visits: s.v },
    windowNote: 'The browser prunes its own history, so this is the window Edge still held at '
      + 'import time — not all time, and not a claim about anything before it.',
    top,
    paidNotVisited,
    matchNote: 'Matching a merchant name to a domain is crude — "Google Play" against '
      + '"google.com" is a guess about a string, not a fact. Read the list below as '
      + 'candidates to check, never as proof that a service went unused.',
    privacy: 'Domains and counts only. No URLs and no page titles are imported or stored.',
  });
});

module.exports = router;
module.exports.span = span;

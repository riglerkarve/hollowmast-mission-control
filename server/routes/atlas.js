const express = require('express');
const db = require('../db');
const provenance = require('../provenance');

// ------------------------------------------------------------------------------------
// ATLAS. Where you have been, and what fraction of the world that is. Backlog #65.
//
// Self-contained by design: it owns its own list and depends on no other module. Nothing
// in the ledger could drive it — 21 Travel transactions across five years is not a travel
// history — so this is a ONE-OFF capture. That is the distinction the gate cares about: a
// surface you must keep feeding is rejected, a list you tick once and then read forever is
// not. Marking a country is a thing you do a handful of times a decade.
//
// IT IS A GRID, AND IT SAYS SO. A geographic projection needs real country path data, and
// authoring outlines from memory would be fabricating geography that looks authoritative.
// So the panel draws a labelled cell per country, grouped by region. It is honest about
// being a schematic rather than a map that is quietly wrong about coastlines.
//
// THE PERCENTAGE IS BY COUNT, NOT BY AREA, and that is deliberate. An area-weighted figure
// needs 193 land-area values, and quoting those from memory is exactly the kind of
// plausible number this project has been bitten by. Count is arithmetic on a list you can
// see and check. If area figures ever arrive from a real source, the route can add a second
// percentage — clearly labelled as a different measure, never blended into this one.
//
// The base list is the 193 UN member states, grouped into six regions. If something is
// missing or you disagree with a grouping, POST it: the table is the owner, not the seed.
db.migrate('atlas', [
  (d) => {
    d.exec(`
      CREATE TABLE atlas_countries (
        name       TEXT PRIMARY KEY,
        region     TEXT NOT NULL,
        seeded     INTEGER NOT NULL DEFAULT 1,   -- 0 = you added it
        visited    INTEGER NOT NULL DEFAULT 0,
        visited_at TEXT
      );
    `);

    const SEED = {
      'Europe': ['Albania', 'Andorra', 'Austria', 'Belarus', 'Belgium', 'Bosnia and Herzegovina', 'Bulgaria', 'Croatia', 'Cyprus', 'Czechia', 'Denmark', 'Estonia', 'Finland', 'France', 'Germany', 'Greece', 'Hungary', 'Iceland', 'Ireland', 'Italy', 'Latvia', 'Liechtenstein', 'Lithuania', 'Luxembourg', 'Malta', 'Moldova', 'Monaco', 'Montenegro', 'Netherlands', 'North Macedonia', 'Norway', 'Poland', 'Portugal', 'Romania', 'Russia', 'San Marino', 'Serbia', 'Slovakia', 'Slovenia', 'Spain', 'Sweden', 'Switzerland', 'Ukraine', 'United Kingdom'],
      'Africa': ['Algeria', 'Angola', 'Benin', 'Botswana', 'Burkina Faso', 'Burundi', 'Cabo Verde', 'Cameroon', 'Central African Republic', 'Chad', 'Comoros', 'Congo', 'DR Congo', 'Djibouti', 'Egypt', 'Equatorial Guinea', 'Eritrea', 'Eswatini', 'Ethiopia', 'Gabon', 'Gambia', 'Ghana', 'Guinea', 'Guinea-Bissau', 'Ivory Coast', 'Kenya', 'Lesotho', 'Liberia', 'Libya', 'Madagascar', 'Malawi', 'Mali', 'Mauritania', 'Mauritius', 'Morocco', 'Mozambique', 'Namibia', 'Niger', 'Nigeria', 'Rwanda', 'Sao Tome and Principe', 'Senegal', 'Seychelles', 'Sierra Leone', 'Somalia', 'South Africa', 'South Sudan', 'Sudan', 'Tanzania', 'Togo', 'Tunisia', 'Uganda', 'Zambia', 'Zimbabwe'],
      'Asia': ['Afghanistan', 'Armenia', 'Azerbaijan', 'Bahrain', 'Bangladesh', 'Bhutan', 'Brunei', 'Cambodia', 'China', 'Georgia', 'India', 'Indonesia', 'Iran', 'Iraq', 'Israel', 'Japan', 'Jordan', 'Kazakhstan', 'Kuwait', 'Kyrgyzstan', 'Laos', 'Lebanon', 'Malaysia', 'Maldives', 'Mongolia', 'Myanmar', 'Nepal', 'North Korea', 'Oman', 'Pakistan', 'Philippines', 'Qatar', 'Saudi Arabia', 'Singapore', 'South Korea', 'Sri Lanka', 'Syria', 'Tajikistan', 'Thailand', 'Timor-Leste', 'Turkey', 'Turkmenistan', 'United Arab Emirates', 'Uzbekistan', 'Vietnam', 'Yemen'],
      'North America': ['Antigua and Barbuda', 'Bahamas', 'Barbados', 'Belize', 'Canada', 'Costa Rica', 'Cuba', 'Dominica', 'Dominican Republic', 'El Salvador', 'Grenada', 'Guatemala', 'Haiti', 'Honduras', 'Jamaica', 'Mexico', 'Nicaragua', 'Panama', 'Saint Kitts and Nevis', 'Saint Lucia', 'Saint Vincent and the Grenadines', 'Trinidad and Tobago', 'United States'],
      'South America': ['Argentina', 'Bolivia', 'Brazil', 'Chile', 'Colombia', 'Ecuador', 'Guyana', 'Paraguay', 'Peru', 'Suriname', 'Uruguay', 'Venezuela'],
      'Oceania': ['Australia', 'Fiji', 'Kiribati', 'Marshall Islands', 'Micronesia', 'Nauru', 'New Zealand', 'Palau', 'Papua New Guinea', 'Samoa', 'Solomon Islands', 'Tonga', 'Tuvalu', 'Vanuatu'],
    };

    const ins = d.prepare('INSERT INTO atlas_countries (name, region) VALUES (?, ?)');
    for (const [region, names] of Object.entries(SEED)) {
      for (const n of names) ins.run(n, region);
    }
  },

  // Provenance. Default 'unknown' rather than 'you' — see server/provenance.js.
  (d) => {
    provenance.addColumn(d, 'atlas_countries');
  },
]);

const router = express.Router();

router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM atlas_countries ORDER BY region, name').all();
  const visited = rows.filter((r) => r.visited);

  const byRegion = {};
  for (const r of rows) {
    if (!byRegion[r.region]) byRegion[r.region] = { total: 0, visited: 0 };
    byRegion[r.region].total++;
    if (r.visited) byRegion[r.region].visited++;
  }

  res.json({
    state: 'ok',
    total: rows.length,
    visited: visited.length,
    // One decimal, and the basis named on the same line so the number cannot travel alone.
    percent: rows.length ? Number(((visited.length / rows.length) * 100).toFixed(1)) : 0,
    basis: `${visited.length} of ${rows.length} countries. BY COUNT, not by land area or `
      + 'population — those need figures from a real source, and a plausible one quoted from '
      + 'memory is worse than none. The list is the 193 UN member states as seeded; add or '
      + 'correct anything and the denominator moves with it.',
    byRegion,
    countries: rows.map((r) => ({ name: r.name, region: r.region, visited: !!r.visited, visitedAt: r.visited_at, seeded: !!r.seeded })),
  });
});

router.post('/visit', (req, res) => {
  const { name, visited } = req.body || {};
  const n = String(name || '').trim();
  if (!n) return res.status(400).json({ error: 'name is required' });

  const row = db.prepare('SELECT * FROM atlas_countries WHERE name = ? COLLATE NOCASE').get(n);
  if (!row) return res.status(404).json({ error: `no country called "${n}" — POST /countries to add it` });

  const to = visited === undefined ? !row.visited : !!visited;
  db.prepare(
    `UPDATE atlas_countries SET visited = ?, visited_at = CASE WHEN ? = 1 THEN date('now','localtime') ELSE NULL END
      WHERE name = ?`
  ).run(to ? 1 : 0, to ? 1 : 0, row.name);
  db.prepare('UPDATE atlas_countries SET by_whom = ? WHERE name = ?').run(req.by, row.name);

  res.json({ name: row.name, visited: to });
});

// The seed is a starting point, not the vocabulary. Territories, dependencies and anywhere
// the list disagrees with you belong here rather than in an argument with the seed.
router.post('/countries', (req, res) => {
  const { name, region } = req.body || {};
  const n = String(name || '').trim();
  const r = String(region || '').trim();
  if (!n || !r) return res.status(400).json({ error: 'name and region are required' });
  if (db.prepare('SELECT 1 FROM atlas_countries WHERE name = ? COLLATE NOCASE').get(n)) {
    return res.status(409).json({ error: 'already on the list' });
  }
  db.prepare('INSERT INTO atlas_countries (name, region, seeded, by_whom) VALUES (?, ?, 0, ?)').run(n, r, req.by);
  res.status(201).json({ name: n, region: r, seeded: false });
});

module.exports = router;

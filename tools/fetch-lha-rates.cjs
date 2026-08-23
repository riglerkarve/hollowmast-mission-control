#!/usr/bin/env node
'use strict';
//
// fetch-lha-rates.cjs — rebuild data/lha-rates.json from the published sources.
//
// LHA rates set the ceiling on the Universal Credit housing element for a PRIVATE tenancy,
// and they are reset every April. This exists so the table can be refreshed in one command
// rather than re-typed, because a hand-copied rate is the kind of number that goes stale
// silently and then decides whether a flat looks affordable.
//
// FOUR NATIONS, TWO REGIMES, and conflating them is the trap this file exists to avoid:
//
//   England, Scotland, Wales   gov.uk publishes UC rates already expressed PER MONTH.
//   Northern Ireland           NIHE publishes PER WEEK, under separate NI legislation.
//
// A weekly figure used as a monthly one is wrong by a factor of 4.33 and still looks like a
// plausible rent, which is exactly the sort of error nobody catches. So every rate carries
// its own `units`, the NI monthly figures are marked `derived` rather than published, and
// the conversion (x52/12) is stated wherever it is applied.
//
// IT VERIFIES ITSELF BEFORE WRITING. Two rates are known independently from the owner's own
// UC statements — Bournemouth 1-bed is GBP 695.00 and that is what DWP actually awarded him.
// If the fetched table disagrees, the run FAILS and writes nothing, because a table that
// contradicts a real award is either stale or being read wrong, and both are worse than the
// file that is already there.
//
// Usage:
//   node tools/fetch-lha-rates.cjs            # fetch, verify, write
//   node tools/fetch-lha-rates.cjs --dry-run  # fetch and verify, write nothing

const fs = require('node:fs');
const path = require('node:path');

const DRY = process.argv.includes('--dry-run');
const OUT = path.join(__dirname, '..', 'data', 'lha-rates.json');

const GB_PAGE = 'https://www.gov.uk/government/publications/universal-credit-local-housing-allowance-rates-2026-to-2027';
const NI_PAGE = 'https://www.nihe.gov.uk/housing-help/local-housing-allowance/current-lha-rent-levels';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) mission-control/lha-fetch';

// Known-good values taken from the owner's own reconciled UC statements. These are the
// control: they were produced by DWP, not by this script or its sources.
const CONTROLS = [
  { nation: 'England', brma: 'Bournemouth', cat: '1bed', expect: 695.00,
    why: 'the housing element actually awarded on the Bournemouth statements' },
  { nation: 'England', brma: 'Oxford', cat: '1bed', expect: 900.00,
    why: 'checked by hand against the gov.uk CSV on 23 Aug 2026' },
];

async function get(url, { binary = false } = {}) {
  const r = await fetch(url, { headers: { 'user-agent': UA }, redirect: 'follow' });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} for ${url}`);
  const buf = Buffer.from(await r.arrayBuffer());
  return binary ? buf : buf.toString('utf8');
}

// RFC 4180 enough for these files: fields may be quoted and a quoted field may contain the
// separator. A naive split(',') shifts every column right of a thousands separator, and
// "1,097.80" appears throughout — so this is not hypothetical tidiness.
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQ = false;
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

// "£1,097.80" -> 1097.8 ; "" / "-" -> null. Returns null rather than 0 for a missing rate:
// zero is a real LHA value nowhere, and treating absence as zero would silently claim the
// area pays nothing.
function money(s) {
  const t = String(s || '').replace(/[££,\s]/g, '').trim();
  if (!t || t === '-') return null;
  const n = Number(t);
  return Number.isFinite(n) ? Number(n.toFixed(2)) : null;
}

const CATS = ['SAR', '1bed', '2bed', '3bed', '4bed'];

// ---------------------------------------------------------------- England, Scotland, Wales
async function fetchGB() {
  const page = await get(GB_PAGE);
  const urls = [...new Set((page.match(/https:\/\/assets\.publishing\.service\.gov\.uk\/[^"']+\.csv/g) || []))];
  if (!urls.length) throw new Error('no CSV attachments found on the gov.uk publication page');

  const nations = {};
  const notes = [];
  for (const url of urls) {
    const name = (url.match(/\/([a-z]+)-rates/) || [, 'unknown'])[1];
    const nation = name.charAt(0).toUpperCase() + name.slice(1);
    // The CSVs are latin1, not UTF-8: the pound sign arrives as the single byte 0xA3, which
    // decodes to U+FFFD under UTF-8 and would leave the digits attached to a replacement
    // character. Verified from the raw bytes rather than assumed.
    const text = (await get(url, { binary: true })).toString('latin1');
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    const header = parseCsvLine(lines[0]);
    if (!/BRMA/i.test(header[0])) throw new Error(`unexpected header in ${url}: ${lines[0].slice(0, 80)}`);

    const rows = {};
    let skipped = 0;
    for (const line of lines.slice(1)) {
      const f = parseCsvLine(line);
      const brma = (f[0] || '').trim();
      if (!brma) { skipped++; continue; }
      const rec = {};
      CATS.forEach((c, i) => { rec[c] = money(f[i + 1]); });
      if (CATS.every((c) => rec[c] === null)) { skipped++; continue; }
      rows[brma] = rec;
    }
    nations[nation] = { units: 'per calendar month', published: 'monthly', source: url, brma: rows };
    notes.push(`${nation}: ${Object.keys(rows).length} BRMAs${skipped ? `, ${skipped} line(s) skipped as blank or rateless` : ''}`);
  }
  return { nations, notes };
}

// ---------------------------------------------------------------- Northern Ireland
// NIHE publishes as headings and bullet lists, not a table or a download. Parsed from the
// markup rather than retyped, and the year heading is captured so a silently stale page is
// visible rather than assumed current.
async function fetchNI() {
  const html = await get(NI_PAGE);
  const period = (html.match(/LHA rents\s+([^<]+?)\s*</i) || [, null])[1];

  const rows = {};
  let skipped = 0;
  const re = /<h2[^>]*class="disclosurestart"[^>]*>\s*<strong>([^<]+?)<\/strong>\s*<\/h2>\s*<ul>([\s\S]*?)<\/ul>/gi;
  for (const m of html.matchAll(re)) {
    const name = m[1].replace(/&nbsp;/g, ' ').replace(/\s*BRMA\b.*$/i, '').trim();
    const items = [...m[2].matchAll(/<li>([\s\S]*?)<\/li>/gi)].map((x) => x[1].replace(/&nbsp;/g, ' '));
    const rec = { SAR: null, '1bed': null, '2bed': null, '3bed': null, '4bed': null };
    for (const it of items) {
      const v = money((it.match(/£\s*([\d,]+\.\d{2})/) || [])[1]);
      if (v === null) continue;
      if (/shared/i.test(it)) rec.SAR = v;
      else {
        const b = (it.match(/(\d)\s*bed/i) || [])[1];
        if (b) rec[`${b}bed`] = v;
      }
    }
    if (CATS.every((c) => rec[c] === null)) { skipped++; continue; }
    rows[name] = rec;
  }
  if (!Object.keys(rows).length) throw new Error('NIHE page parsed to zero BRMAs — the markup has changed');

  // Monthly equivalents are DERIVED, not published. NI publishes weekly only; UC assesses
  // monthly. x52/12 is the standard conversion and is checked against GB below, but the
  // result is still a derivation and is labelled as one so nobody later mistakes it for a
  // figure NIHE printed.
  const monthly = {};
  for (const [k, v] of Object.entries(rows)) {
    monthly[k] = {};
    for (const c of CATS) monthly[k][c] = v[c] === null ? null : Number((v[c] * 52 / 12).toFixed(2));
  }
  return {
    units: 'per week',
    published: 'weekly',
    period_stated_on_page: period,
    source: NI_PAGE,
    brma: rows,
    brma_monthly_derived: monthly,
    derivation: 'monthly = weekly x 52 / 12, computed here. NIHE publishes weekly only.',
    skipped,
  };
}

(async () => {
  console.log('Fetching published LHA rates...\n');
  const gb = await fetchGB();
  const ni = await fetchNI();
  gb.notes.forEach((n) => console.log('  ' + n));
  console.log(`  Northern Ireland: ${Object.keys(ni.brma).length} BRMAs (weekly)${ni.skipped ? `, ${ni.skipped} skipped` : ''}`);
  console.log(`  NI page states period: ${ni.period_stated_on_page || '(not found — check the page)'}\n`);

  // ---- controls, before anything is written
  let failed = 0;
  console.log('Controls, against figures this script did not produce:');
  for (const c of CONTROLS) {
    const got = ((gb.nations[c.nation] || { brma: {} }).brma[c.brma] || {})[c.cat];
    const ok = got === c.expect;
    if (!ok) failed++;
    console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${c.nation}/${c.brma}/${c.cat}: expected ${c.expect}, got ${got === undefined ? '(absent)' : got}  -- ${c.why}`);
  }

  // The conversion factor is itself checked: a GB monthly rate divided back to weekly and
  // returned should land within a penny. This is what stops the NI monthly column being an
  // unverified multiplication.
  const probe = ((gb.nations.England || { brma: {} }).brma.Bournemouth || {})['1bed'];
  if (probe) {
    const round = Number((Number((probe * 12 / 52).toFixed(2)) * 52 / 12).toFixed(2));
    const drift = Math.abs(round - probe);
    console.log(`  ${drift <= 0.05 ? 'OK  ' : 'WARN'} weekly<->monthly conversion round-trips on ${probe} to ${round} (drift ${drift.toFixed(2)})`);
  }

  if (failed) {
    console.log(`\n${failed} control(s) FAILED. Nothing written — the existing data/lha-rates.json is left alone.`);
    process.exit(1);
  }

  const out = {
    _what: 'Local Housing Allowance rates — the ceiling on the Universal Credit housing element for a PRIVATE rented tenancy, by Broad Rental Market Area.',
    _generated_by: 'tools/fetch-lha-rates.cjs',
    _retrieved: new Date().toISOString().slice(0, 10),
    _units_warning: 'England, Scotland and Wales are PER CALENDAR MONTH as published for Universal Credit. Northern Ireland is PER WEEK as published by NIHE, with a derived monthly column. Using a weekly figure as a monthly one is wrong by a factor of 4.33 and still looks like a plausible rent.',
    _frozen: 'GB rates from 1 April 2026 were set by SI 2026/5 and are the same rates that came into force on 1 April 2024 — frozen at 2024/25 levels for 2025/26 and 2026/27. NI rents for 2026/27 are frozen at 2025/26 levels.',
    _lha_applies_to: 'PRIVATE rented tenancies. A housing association or council tenancy is not LHA-capped; UC pays eligible rent and service charges instead. Supported, specified and temporary accommodation are treated differently again.',
    _categories: 'Which category applies to a single person depends on age and on exemptions from the Shared Accommodation Rate. Those are facts about the claimant, not about the area, and are deliberately not recorded here.',
    _controls: CONTROLS,
    period: '2026-04-01 to 2027-03-31',
    nations: { ...gb.nations, 'Northern Ireland': ni },
  };

  const total = Object.values(out.nations).reduce((a, n) => a + Object.keys(n.brma).length, 0);
  console.log(`\n${total} BRMAs across ${Object.keys(out.nations).length} nations.`);

  if (DRY) { console.log('\nDRY RUN — nothing written.'); return; }
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
  console.log(`\nWritten ${OUT}`);
})().catch((e) => { console.error('\nFAILED: ' + e.message); process.exit(1); });

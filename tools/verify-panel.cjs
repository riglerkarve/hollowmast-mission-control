#!/usr/bin/env node
//
// verify-panel.cjs — the four checks a panel needs, in one command.
//
//   node tools/verify-panel.cjs finance      one panel
//   node tools/verify-panel.cjs --all        every registered panel
//
//   1. the module PARSES (as an ES module, without resolving browser-absolute imports)
//   2. every static CSS class it writes is DEFINED in a stylesheet the page actually loads
//   3. every var(--token) it uses is DEFINED in one of those sheets
//   4. its API route ANSWERS
//
// EXISTS BECAUSE I RAN THESE SEPARATELY AND INCONSISTENTLY ~8 TIMES ON 18 AUG, and two of
// the ad-hoc versions were wrong:
//   * the first syntax check tried to RESOLVE imports, so a panel importing '/shared.js'
//     reported a syntax error it did not have. Node cannot resolve a browser-absolute path;
//     `node --check` parses without resolving, which is the correct check.
//   * the first class audit carried a HAND-TYPED list of "house" classes to ignore and
//     reported 13 false positives — a control I invented rather than measured, which is the
//     same defect the audit exists to catch. The shared sheets are now READ.
//
// An invented CSS class renders as nothing and raises no error. An invented custom property
// does the same. Neither is visible in a screenshot of a page that mostly works.
'use strict';
require('./_run-log.cjs').record();

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const PUB = path.join(ROOT, 'public');
const BASE = process.env.MC_BASE || 'http://127.0.0.1:3000';

// The sheets the page actually loads, in order, read from index.html — not assumed. A class
// defined in another panel's sheet still applies, because index.html loads all of them
// eagerly; pretending otherwise produces false positives (.panel-wide lives in reports.css
// and ten panels depend on it).
const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
const sheets = [...html.matchAll(/<link[^>]+href="([^"]+\.css)"/g)]
  .map((m) => path.join(PUB, m[1].replace(/^\//, '')))
  .filter((p) => fs.existsSync(p));

// PANEL SHEETS ARE NO LONGER IN index.html — they load with their panel as of 18 Aug. So
// the defined-class set is built from the sheets index.html DOES load PLUS every panel
// stylesheet on disk. Without this the audit would report every panel class as undefined
// the moment the CSS went lazy: a correct check, against a source that had moved.
for (const d of fs.readdirSync(path.join(PUB, 'panels'))) {
  const f = path.join(PUB, 'panels', d, `${d}.css`);
  if (fs.existsSync(f) && !sheets.includes(f)) sheets.push(f);
}

const definedClasses = new Map();
const definedTokens = new Map();
for (const s of sheets) {
  const css = fs.readFileSync(s, 'utf8');
  const rel = path.relative(PUB, s).replace(/\\/g, '/');
  [...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].forEach((m) => { if (!definedClasses.has(m[1])) definedClasses.set(m[1], rel); });
  [...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].forEach((m) => { if (!definedTokens.has(m[1])) definedTokens.set(m[1], rel); });
}

const registry = fs.readFileSync(path.join(PUB, 'shell.js'), 'utf8');
const panels = [...registry.matchAll(/^\s{2}([a-z0-9]+):\s*\(\)\s*=>\s*import/gm)].map((m) => m[1]);

const want = process.argv.includes('--all') ? panels : process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!want.length) {
  console.error(`  name a panel, or --all. Registered: ${panels.join(', ')}`);
  process.exitCode = 1;
  return;
}

function checkOne(name) {
  const js = path.join(PUB, 'panels', name, `${name}.js`);
  const out = { name, problems: [], notes: [] };
  if (!fs.existsSync(js)) { out.problems.push(`no such panel file: panels/${name}/${name}.js`); return out; }
  const src = fs.readFileSync(js, 'utf8');

  // 1. parse, WITHOUT resolving imports
  const tmp = path.join(os.tmpdir(), `vp-${name}.mjs`);
  fs.writeFileSync(tmp, src);
  try { execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' }); }
  catch (e) { out.problems.push(`syntax: ${String(e.stderr).split('\n').slice(0, 3).join(' ').slice(0, 160)}`); }
  fs.unlinkSync(tmp);

  // 2. classes. Interpolated fragments are counted as RESIDUE, not as classes — a name built
  //    at runtime cannot be checked here and pretending otherwise would be a false negative.
  const used = new Set();
  const interpolated = [];
  const classVars = new Set();
  for (const m of src.matchAll(/class="([^"]*)"/g)) {
    if (/\$\{/.test(m[1])) interpolated.push(m[1].slice(0, 50));
    // A conditional written INSIDE the attribute is a class: class="btn${x ? ' primary' : ''}"
    for (const c of m[1].matchAll(/\?\s*'\s+([a-z][\w-]*)'\s*:\s*''/g)) used.add(c[1]);
    // …and record which variables land here, so their definitions can be read below.
    for (const v of m[1].matchAll(/\$\{(\w+)\}/g)) classVars.add(v[1]);
    m[1].replace(/\$\{[^}]*\}/g, ' ').split(/[\s ]+/).filter(Boolean).forEach((c) => used.add(c));
  }
  // A conditional assigned to a VARIABLE is a class only if that variable lands in a class
  // attribute, so the interpolation target is read rather than assumed. Two false positives
  // on the first run, two different causes, and this is the second:
  //   `const open = opened.has(id) ? ' open' : ''`  →  `<details${open}>`  — an ATTRIBUTE,
  // syntactically identical to a conditional class and not one. The first is prose:
  //   `devices.length === 1 ? ' has' : 's have'`  — excluded by requiring an empty
  // alternative, since a class toggles against nothing and a sentence continues.
  for (const m of src.matchAll(/(?:const|let)\s+(\w+)\s*=[^;\n]*\?\s*'\s+([a-z][\w-]*)'\s*:\s*''/g)) {
    if (classVars.has(m[1])) used.add(m[2]);
  }
  const real = [...used].filter((c) => !c.endsWith('-'));

  // A class no sheet styles is a defect ONLY IF nothing uses it either. Event delegation
  // here reads `closest('.prj-toggle')` — a hook that must never be styled, and three of the
  // five first-run findings were exactly that. So the question is not "is it in a stylesheet"
  // but "is it in a stylesheet OR a selector"; asking only the first cries wolf every time,
  // and a check that always cries wolf gets switched off, which is worse than not having it.
  // The span from quote to dot must look like a SELECTOR — `summary.parentElement.open` is a
  // property access, and a laxer pattern counted it as one.
  const unstyled = real.filter((c) => !definedClasses.has(c));
  const hooks = unstyled.filter((c) => new RegExp(`['"\`][-\\w\\s.#\\[\\]=>,:]*\\.${c}\\b|classList\\.\\w+\\('${c}'`).test(src));
  const missingClasses = unstyled.filter((c) => !hooks.includes(c));

  // 3. tokens
  const css = path.join(PUB, 'panels', name, `${name}.css`);
  const cssText = fs.existsSync(css) ? fs.readFileSync(css, 'utf8') : '';
  const usedTokens = new Set([...(`${src}${cssText}`).matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]));
  const missingTokens = [...usedTokens].filter((t) => !definedTokens.has(t));

  if (missingClasses.length) out.problems.push(`classes defined nowhere: ${missingClasses.join(', ')}`);
  if (missingTokens.length) out.problems.push(`custom properties defined nowhere: ${missingTokens.join(', ')}`);
  // The residue, always printed. Two of these three numbers are things this check CANNOT
  // see, and a run that reports only what it examined reads like a run that examined
  // everything.
  out.notes.push(`${real.length} static classes, ${usedTokens.size} tokens`
    + `, ${hooks.length} unstyled selector hook(s) (fine)`
    + `, ${interpolated.length} interpolated class attribute(s) NOT checkable here`);
  return out;
}

(async () => {
  // One git call for the whole run, not one per panel. A failure here must not be silent: an
  // empty set would read as "everything is committed", which is the flattering answer.
  const dirty = new Set();
  let dirtyKnown = true;
  try {
    const out = require('node:child_process')
      .execSync('git status --porcelain -- public/panels', { cwd: path.join(__dirname, '..'), encoding: 'utf8' });
    for (const m of out.matchAll(/public\/panels\/([A-Za-z0-9-]+)\//g)) dirty.add(m[1]);
  } catch { dirtyKnown = false; }
  if (!dirtyKnown) console.log('  NOTE  could not read git status — cannot tell in-flight edits from defects\n');

  let bad = 0;
  for (const name of want) {
    const r = checkOne(name);

    // 4. the route. THE COMMENT HERE USED TO SAY this "only reports what it finds rather than
    //    insisting on the convention" -- and the regex under it captured `/api/([a-z0-9-]+)`,
    //    which is the module segment and nothing else. It threw away the rest of every path
    //    and probed the module ROOT. So it insisted on the convention absolutely, and what it
    //    verified was "does /api/<name> happen to have a root route", never "does the URL this
    //    panel actually calls work". Finance has no root route, so it printed 404 beside a FAIL
    //    it had not caused. A comment is not the code.
    //
    //    Now: every distinct static /api/ path in the panel is probed. A path that continues
    //    into a template interpolation cannot be built here and is reported as unprobeable
    //    rather than silently trimmed back to something that does answer.
    const js = path.join(PUB, 'panels', name, `${name}.js`);
    const probes = [];
    let wrapperNote = null;
    if (fs.existsSync(js)) {
      const src = fs.readFileSync(js, 'utf8');
      const seen = new Set();
      for (const m of src.matchAll(/fetch\(\s*[`'"](\/api\/[A-Za-z0-9\-_/.]*)/g)) {
        const p = m[1].replace(/\/$/, '');
        // What follows the literal decides whether the URL is complete or merely a prefix.
        const after = src.slice(m.index + m[0].length);
        const interpolated = after.startsWith('$') || after.startsWith('{');
        // AND WHICH VERB IT USES, because probing everything with GET is how this cried wolf
        // on its first run: /api/work/run, /api/exercise/sessions and /api/analytics/probe all
        // came back 404 and all three are router.post. Express answers 404 for a path that
        // exists under a different method, so a GET probe cannot tell "missing" from
        // "wrong verb" -- and reporting the first when it is the second is a false alarm on
        // three working panels. Only GETs are probed; the rest are named and left alone.
        const opts = after.slice(0, 260);
        const verb = (opts.match(/method:\s*['"]([A-Za-z]+)['"]/) || [])[1];
        const method = (verb || 'GET').toUpperCase();
        const key = `${p}|${interpolated}|${method}`;
        if (seen.has(key)) continue;
        seen.add(key);
        probes.push({ path: p, interpolated, method, base: interpolated ? p : null });
      }

      // FOLLOW THE PANEL'S OWN api() WRAPPER. Fourteen panels define one -- CLAUDE.md counts
      // them -- so their only literal fetch is inside the helper and reads `/api/income${path}`.
      // Stopping there reported "0 of 1 URL(s) probeable" for nine panels that in fact call
      // four endpoints each: an honest sentence about a blind spot, where the blind spot was
      // one regex wide and covered most of the dashboard.
      //
      // ONLY WHEN THERE IS EXACTLY ONE BASE. The safety panel has two wrappers -- /api/safety
      // and /api/gate -- and composing every api() call site against both bases invented
      // /api/gate, which 404s because nothing fetches it. A checker that manufactures the URL
      // it then reports as broken is worse than one that says it cannot tell. Two bases means
      // the call sites cannot be attributed from source, so they are named and not composed.
      const bases = probes.filter((x) => x.interpolated && /^\/api\/[a-z0-9-]+$/.test(x.path));
      if (bases.length > 1) {
        wrapperNote = `${bases.length} api() wrappers (${bases.map((b) => b.path).join(', ')})`
          + ' — call sites cannot be attributed to one base from source, so they are not probed';
      }
      for (const w of (bases.length === 1 ? bases : [])) {
        for (const c of src.matchAll(/\bapi\(\s*[`'"](\/[A-Za-z0-9\-_/?=&.]*)/g)) {
          const tail = src.slice(c.index + c[0].length);
          if (tail.startsWith('$') || tail.startsWith('{')) continue;   // still parameterised
          const verb2 = (tail.slice(0, 200).match(/method:\s*['"]([A-Za-z]+)['"]/) || [])[1];
          const full = (w.path + c[1]).replace(/\/$/, '') || w.path;
          const method2 = (verb2 || 'GET').toUpperCase();
          const key2 = `${full}|false|${method2}`;
          if (seen.has(key2)) continue;
          seen.add(key2);
          probes.push({ path: full, interpolated: false, method: method2, viaWrapper: true });
        }
      }
    }
    // The headline names what was ACTUALLY PROBED, not the first path found. Naming probes[0]
    // printed "/api/budget not probed" on a panel where a different URL had answered 200, and
    // "/api/finance 404" beside a FAIL that a CSS class had caused. The label has to describe
    // the measurement it is standing next to.
    let route = null;
    let code = 'not probed';
    let probed = 0;
    if (wrapperNote) r.notes.push(wrapperNote);
    if (!probes.length) {
      r.notes.push('no /api/ call found in the panel — nothing to probe');
    } else {
      for (const p of probes) {
        if (p.interpolated) {
          r.notes.push(`${p.path}/… takes a path parameter — not probeable from source alone`);
          continue;
        }
        if (p.method !== 'GET') {
          // Not probed on purpose. Sending the real verb would EXECUTE it -- POST /api/work/run
          // starts a job. A checker must not have side effects on the thing it is checking.
          r.notes.push(`${p.path} is ${p.method} — not probed, because probing it would run it`);
          continue;
        }
        let c;
        try { c = (await fetch(BASE + p.path, { signal: AbortSignal.timeout(8000) })).status; }
        catch (e) { c = `ERR ${e.name}`; }
        probed += 1;
        if (route === null || (typeof c === 'number' && c >= 400)) { route = p.path; code = c; }
        // A 404 on a URL the panel really fetches IS a defect: the panel is calling something
        // that is not there, and it renders as an empty section rather than an error.
        if (typeof c === 'number' && c >= 400) r.problems.push(`${p.path} answered ${c} — the panel fetches this`);
        else if (typeof c !== 'number') r.problems.push(`${p.path} ${c}`);
      }
    }

    // IS ANOTHER SESSION HALFWAY THROUGH THIS PANEL? Several sessions share this one working
    // tree, so a repo-wide check meets other people's unfinished edits and reports them as
    // defects. Measured 19 Aug: `fin-pnl-month` was "defined nowhere" and correct -- it lived
    // in 107 uncommitted lines of finance.js, with the matching CSS presumably still being
    // written. Filing that as a bug would have been filing someone else's work in progress.
    // The finding still prints; it is the CLAIM attached to it that changes.
    if (dirty.has(name)) r.notes.push('UNCOMMITTED CHANGES in this panel — another session may be'
      + ' mid-edit, so treat anything above as a candidate, not a defect');

    const ok = !r.problems.length;
    if (!ok) bad++;
    const label = route ? `${route} ${code}${probes.length > 1 ? `  (${probed} of ${probes.length} URLs probed)` : ''}`
      : probes.length ? `0 of ${probes.length} URL(s) probeable — see below` : '';
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(12)} ${label}`);
    r.problems.forEach((p) => console.log(`        ! ${p}`));
    r.notes.forEach((n) => console.log(`        · ${n}`));
  }
  console.log(bad ? `\n  ${bad} panel(s) with problems` : `\n  ${want.length} panel(s) clean`);
  process.exitCode = bad ? 1 : 0;
})();

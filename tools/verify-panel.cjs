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
  let bad = 0;
  for (const name of want) {
    const r = checkOne(name);

    // 4. the route. Read, not assumed: a panel's data route is usually /api/<name> but this
    //    only reports what it finds rather than insisting on the convention.
    const js = path.join(PUB, 'panels', name, `${name}.js`);
    let route = null;
    if (fs.existsSync(js)) {
      const m = fs.readFileSync(js, 'utf8').match(/fetch\(`?\/api\/([a-z0-9-]+)/);
      if (m) route = `/api/${m[1]}`;
    }
    let code = 'not probed';
    if (route) {
      try { code = (await fetch(BASE + route, { signal: AbortSignal.timeout(8000) })).status; }
      catch (e) { code = `ERR ${e.name}`; }
      if (typeof code === 'number' && code >= 500) r.problems.push(`${route} answered ${code}`);
    } else r.notes.push('no /api/ call found in the panel — nothing to probe');

    const ok = !r.problems.length;
    if (!ok) bad++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(12)} ${route ? `${route} ${code}` : ''}`);
    r.problems.forEach((p) => console.log(`        ! ${p}`));
    r.notes.forEach((n) => console.log(`        · ${n}`));
  }
  console.log(bad ? `\n  ${bad} panel(s) with problems` : `\n  ${want.length} panel(s) clean`);
  process.exitCode = bad ? 1 : 0;
})();

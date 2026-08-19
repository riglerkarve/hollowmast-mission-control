#!/usr/bin/env node
//
// usage-contract-audit.cjs — Batch F (M99–M103): compare the promises in each
// tools/*.cjs header with its argument handling and possible side effects.
//
// Static only. It neither requires another tool nor opens any database. A command described
// as report-only must be audited without running it: M71 showed that testing a false dry-run
// promise by invoking it can be the harmful action itself.
//
//   node tools/usage-contract-audit.cjs
//   node tools/usage-contract-audit.cjs --group 1
//
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const TOOLS = path.join(ROOT, 'tools');
const argv = process.argv.slice(2);
const requested = argv.indexOf('--group');
const groupArg = requested >= 0 ? Number(argv[requested + 1]) : null;
if (groupArg != null && (!Number.isInteger(groupArg) || groupArg < 1 || groupArg > 4)) {
  console.error('Usage: node tools/usage-contract-audit.cjs [--group 1|2|3|4]');
  process.exit(2);
}

const files = fs.readdirSync(TOOLS).filter((file) => file.endsWith('.cjs')).sort();
const width = Math.ceil(files.length / 4);

const lineOf = (text, offset) => text.slice(0, offset).split(/\r?\n/).length;
const unique = (list) => [...new Set(list)];
const firstLines = (text, n = 110) => text.split(/\r?\n/).slice(0, n).join('\n');

function usageBlock(text) {
  // Flag-looking text in an explanatory paragraph (or a copied git command) is not a usage
  // contract. Restrict the source claim to explicit usage invocations in the header.
  return firstLines(text).split(/\r?\n/)
    .filter((line) => /\busage\s*:|\bnode\s+(?:tools[\\/])|^\s*\/\/\s+--/i.test(line))
    .join('\n');
}

function flags(text) {
  return unique([...text.matchAll(/--[a-z][a-z0-9-]*/gi)].map((match) => match[0].slice(2).toLowerCase()));
}

function codeText(text) {
  // Preserve line numbers while excluding header comments from implementation findings.
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (match) => '\n'.repeat(match.split(/\r?\n/).length - 1))
    .replace(/^\s*\/\/.*$/gm, '');
}

function codeFlags(text) {
  // This deliberately lists only literal flag names. A computed flag is a blind spot, not a
  // supported flag we pretend to understand.
  return unique([
    ...text.matchAll(/(?:includes|indexOf)\(\s*['"]--([a-z][a-z0-9-]*)['"]\s*\)/gi),
    ...text.matchAll(/(?:arg|flag|has)\(\s*['"]([a-z][a-z0-9-]*)['"]\s*\)/gi),
  ].map((match) => match[1].toLowerCase()));
}

function flagVariables(text) {
  const found = new Map();
  const re = /\b(?:const|let|var)\s+(\w+)\s*=\s*(?:has|arg|flag)\(\s*['"]([a-z][a-z0-9-]*)['"]\s*\)/gi;
  for (const match of text.matchAll(re)) found.set(match[2].toLowerCase(), match[1]);
  return found;
}

function occurrences(text, re) {
  const out = [];
  re.lastIndex = 0;
  let match;
  while ((match = re.exec(text))) out.push(lineOf(text, match.index));
  return out;
}

function sideEffects(text) {
  const effects = [];
  const patterns = [
    ['filesystem write', /\b(?:writeFile(?:Sync)?|appendFile(?:Sync)?|mkdir(?:Sync)?|rm(?:Sync)?|unlink(?:Sync)?|rename(?:Sync)?|copyFile(?:Sync)?)\s*\(/g],
    ['database write', /\b\w+\.(?:prepare|exec)\s*\(\s*(?:`|['"])[\s\S]{0,400}?\b(?:INSERT\s+INTO|UPDATE\s+[A-Za-z_]|DELETE\s+FROM|CREATE\s+TABLE|ALTER\s+TABLE|DROP\s+TABLE|BEGIN)\b/gi],
    ['process/network', /\b(?:execFile(?:Sync)?|spawn(?:Sync)?|execSync|fetch)\s*\(/g],
    ['database module import', /require\(\s*['"][^'"]*server\/db['"]\s*\)/g],
  ];
  for (const [kind, re] of patterns) {
    for (const line of occurrences(text, re)) effects.push({ kind, line });
  }
  return effects.sort((a, b) => a.line - b.line || a.kind.localeCompare(b.kind));
}

function guardAudit(text, documented, handled) {
  const safetyFlags = unique([...documented, ...handled].filter((flag) => /^(?:dry|report|check|readonly|read-only|no-write|no-write-test)/.test(flag)));
  const effects = sideEffects(text);
  const variables = flagVariables(text);
  const out = [];
  for (const flag of safetyFlags) {
    const variable = variables.get(flag);
    const terms = [`['"]--${flag}['"]`];
    if (variable) terms.push(`\\b${variable}\\b`);
    const direct = new RegExp(`\\bif\\s*\\([^\\n]{0,160}(?:${terms.join('|')})[^\\n]{0,160}\\)`, 'g');
    const guards = occurrences(text, direct);
    const guardLine = guards.length ? Math.min(...guards) : null;
    const before = guardLine == null ? effects : effects.filter((effect) => effect.line < guardLine);
    out.push({ flag, guardLine, before });
  }
  return out;
}

function audit(file) {
  const text = fs.readFileSync(path.join(TOOLS, file), 'utf8');
  const header = firstLines(text);
  const documented = flags(usageBlock(text));
  const executable = codeText(text);
  const handled = codeFlags(executable);
  const undocumented = handled.filter((flag) => !documented.includes(flag));
  const absent = documented.filter((flag) => !handled.includes(flag));
  const safety = guardAudit(executable, documented, handled);
  const reportingClaim = /\b(?:report-only|read-only|only report|write nothing|does not write|never write)\b/i.test(header);
  const writes = sideEffects(executable).filter((effect) => /write/.test(effect.kind));
  return { file, documented, handled, undocumented, absent, safety, reportingClaim, writes };
}

function printAudit(row) {
  console.log(`\n${row.file}`);
  console.log(`  documented flags: ${row.documented.length ? row.documented.map((flag) => `--${flag}`).join(', ') : '(none found in header usage lines)'}`);
  console.log(`  literal handled flags: ${row.handled.length ? row.handled.map((flag) => `--${flag}`).join(', ') : '(none detected)'}`);
  if (row.absent.length) console.log(`  DOCUMENTED BUT NOT LITERALLY HANDLED: ${row.absent.map((flag) => `--${flag}`).join(', ')}`);
  if (row.undocumented.length) console.log(`  LITERALLY HANDLED BUT NOT DOCUMENTED: ${row.undocumented.map((flag) => `--${flag}`).join(', ')}`);
  for (const safety of row.safety) {
    const before = safety.before.length ? safety.before.map((effect) => `${effect.kind}@${effect.line}`).join(', ') : 'none detected';
    console.log(`  --${safety.flag} guard=${safety.guardLine == null ? 'NOT DETECTED' : `line ${safety.guardLine}`}; possible effects before guard: ${before}`);
  }
  if (row.reportingClaim) {
    console.log(`  REPORT-ONLY CLAIM: possible write operations at ${row.writes.length ? row.writes.map((effect) => `${effect.kind}@${effect.line}`).join(', ') : 'none detected'}.`);
  }
}

const all = files.map(audit);
const groups = Array.from({ length: 4 }, (_, index) => all.slice(index * width, (index + 1) * width));
const selectedGroups = groupArg == null ? groups : [groups[groupArg - 1]];

console.log(`Usage Contract Audit — Batch F (M99–M103)`);
console.log(`STATIC ONLY: ${files.length} tools/*.cjs files; no tool was required or run; no database was opened.`);
for (const group of selectedGroups) {
  const number = groups.indexOf(group) + 1;
  console.log(`\nGROUP ${number}: files ${all.indexOf(group[0]) + 1}-${all.indexOf(group[group.length - 1]) + 1} of ${all.length}`);
  group.forEach(printAudit);
}

const selected = selectedGroups.flat();
const summary = {
  files: selected.length,
  documentedButNotLiteral: selected.filter((row) => row.absent.length).map((row) => row.file),
  literalButUndocumented: selected.filter((row) => row.undocumented.length).map((row) => row.file),
  safetyFlagsWithoutGuard: selected.filter((row) => row.safety.some((safety) => safety.guardLine == null)).map((row) => row.file),
  possibleEffectsBeforeSafetyGuard: selected.filter((row) => row.safety.some((safety) => safety.before.length)).map((row) => row.file),
  reportOnlyClaimsWithPossibleWrites: selected.filter((row) => row.reportingClaim && row.writes.length).map((row) => row.file),
};
console.log(`\nSUMMARY: ${JSON.stringify(summary)}`);

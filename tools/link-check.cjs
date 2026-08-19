#!/usr/bin/env node
//
// link-check.cjs — re-verify the URLs in reference/*.md and report THREE states.
//
//   node tools/link-check.cjs                 check every reference doc
//   node tools/link-check.cjs workout         only docs whose name matches
//   node tools/link-check.cjs --json          machine-readable, for the briefing
//
// ---------------------------------------------------------------------------------------
// WHY THIS EXISTS. A catalogue of other people's pages is a list of things that will rot,
// and it rots silently: the link still resolves, the page still returns 200, and the
// content it promised has been withdrawn. That is not hypothetical here — assembling
// reference/workout-programmes.md found FIVE nhs.uk URLs that had moved or been retired
// while third-party sites still linked them as live, including one whole programme.
//
// THREE STATES, NEVER TWO. This project's standing rule is that absence and failure must
// not render the same, and a link checker is where that rule earns its keep:
//
//   OK        reachable, and did not redirect somewhere that means "this is gone"
//   MOVED     a redirect to a different page — a 200 that is NOT the thing you linked.
//             This is the state a two-state checker misses entirely, and it is the one
//             that actually happened.
//   GONE      4xx/5xx
//   UNKNOWN   could not look: timeout, DNS, TLS, or a bot-challenge body
//
// UNKNOWN IS NOT A FAILURE AND MUST NOT BE COUNTED AS ONE. A network blip reported as a
// dead link teaches you to ignore the report, which is worse than not having it.
//
// AND IT REPORTS ITS RESIDUE. It prints what it could not judge and why, because a checker
// that quietly drops the awkward cases makes the surviving list look healthier than it is.
// ---------------------------------------------------------------------------------------
'use strict';
require('./_run-log.cjs').record();

// Does the file that contains this URL already say it is retired? Looks for an explicit
// marker, or for the URL appearing after a "Withdrawn" heading in the same document.
function makeKnown(files) {
  const marked = new Set();
  for (const f of files) {
    let text = "";
    try { text = require("node:fs").readFileSync(f, "utf8"); } catch { continue; }
    const lines = text.split("\n");
    let withdrawnLevel = 0;   // 0 = not inside a Withdrawn section
    for (const line of lines) {
      const h = line.match(/^(#{1,4})\s/);
      if (h) {
        const lvl = h[1].length;
        // A SUB-heading does not leave the section. Only a heading at the same or higher
        // level does. The first version reset on any heading, so "### NHS Strength and Flex"
        // immediately cancelled the "## Withdrawn" it sat under, and the whole mechanism
        // silently did nothing.
        if (/withdrawn/i.test(line)) withdrawnLevel = lvl;
        else if (withdrawnLevel && lvl <= withdrawnLevel) withdrawnLevel = 0;
      }
      const marker = /@link-known-moved/.test(line);
      if (!withdrawnLevel && !marker) continue;
      for (const m of line.matchAll(/https?:\/\/[^\s`"'<>)]+/g)) marked.add(m[0].replace(/[.,)]+$/, ""));
    }
  }
  return (u) => marked.has(u);
}

const fs = require('node:fs');
const path = require('node:path');

// Fixture runs set LINK_DIR to a disposable directory. Normal runs retain reference/.
const DIR = process.env.LINK_DIR || path.join(__dirname, '..', 'reference');
const JSON_OUT = process.argv.includes('--json');
const filter = process.argv.slice(2).find((a) => !a.startsWith('--'));

const TIMEOUT_MS = 20000;

// A body this short from a host known for JS challenges is not content. Detected rather
// than assumed: reddit returns HTTP 200 with ~8 characters of visible text and a script
// that computes a token. Reporting that as OK would be a checker certifying a wall.
const CHALLENGE_MAX_BYTES = 20000;
const CHALLENGE_HINTS = /js_challenge|enable javascript|verifying you are human|captcha|cf-browser-verification/i;

function urlsIn(md) {
  // Bare URLs in backticks, and markdown links. Both forms appear in the reference docs.
  const found = new Set();
  for (const m of md.matchAll(/`(https?:\/\/[^`\s]+)`/g)) found.add(m[1]);
  for (const m of md.matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)) found.add(m[1]);
  return [...found];
}

// Two URLs are "the same page" if they differ only by trailing slash or case of host.
const canon = (u) => {
  try {
    const x = new URL(u);
    return (x.origin + x.pathname).toLowerCase().replace(/\/+$/, '');
  } catch { return String(u).toLowerCase(); }
};

async function check(url, known) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ctl.signal,
      headers: {
        // A plain fetch is refused by several of these hosts. This is a normal browser
        // string, not an attempt to defeat anything: a host that serves a challenge still
        // serves it, and that is reported as UNKNOWN rather than worked around.
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36',
        accept: 'text/html,application/xhtml+xml',
      },
    });
    const body = await res.text().catch(() => '');
    clearTimeout(t);

    if (!res.ok) return { state: 'GONE', code: res.status, url };

    if (body.length < CHALLENGE_MAX_BYTES && CHALLENGE_HINTS.test(body + ' ' + res.url)) {
      return { state: 'UNKNOWN', why: 'bot-detection challenge, not content', code: res.status, url };
    }

    if (canon(res.url) !== canon(url)) {
      // A link the source already documents as retired is not an open finding. Two ways to
      // say so: an explicit @link-known-moved marker, or the URL sitting under a heading
      // that says Withdrawn. The second is what workout-programmes.md already does, so the
      // checker now reads the document instead of contradicting it.
      if (typeof known === "function" && known(url)) {
        return { state: "KNOWN-MOVED", code: res.status, url, to: res.url };
      }
      return { state: 'MOVED', code: res.status, url, to: res.url };
    }

    return { state: 'OK', code: res.status, url, bytes: body.length };
  } catch (err) {
    clearTimeout(t);
    const why = err.name === 'AbortError' ? `no answer in ${TIMEOUT_MS / 1000}s` : err.message.slice(0, 80);
    return { state: 'UNKNOWN', why, url };
  }
}

(async () => {
  if (!fs.existsSync(DIR)) {
    console.error(`No reference/ directory at ${DIR} — nothing to check.`);
    console.error('That is "nothing to look at", not "every link is fine".');
    process.exit(2);
  }

  const docs = fs.readdirSync(DIR)
    .filter((f) => f.endsWith('.md'))
    .filter((f) => !filter || f.includes(filter));

  if (!docs.length) {
    console.error(filter ? `No reference doc matches "${filter}".` : 'reference/ contains no .md files.');
    process.exit(2);
  }

  const report = [];
  const known = makeKnown(docs.map((x) => path.join(DIR, x)));
  for (const doc of docs) {
    const urls = urlsIn(fs.readFileSync(path.join(DIR, doc), 'utf8'));
    // Sequential on purpose. A dozen links is not worth hammering five hosts in parallel,
    // and a burst is the fastest way to turn a working check into a rate-limited one.
    const results = [];
    for (const u of urls) results.push(await check(u, known));
    report.push({ doc, results });
  }

  if (JSON_OUT) { console.log(JSON.stringify(report, null, 1)); return; }

  let gone = 0; let knownMoved = 0; let moved = 0; let unknown = 0; let ok = 0;
  for (const { doc, results } of report) {
    console.log(`\n  ${doc}  —  ${results.length} link(s)`);
    for (const r of results) {
      const tag = { OK: 'ok     ', MOVED: 'MOVED  ', GONE: 'GONE   ', UNKNOWN: 'unknown', 'KNOWN-MOVED': 'known  ' }[r.state];
      const short = r.url.replace(/^https?:\/\//, '').slice(0, 62);
      console.log(`    ${tag} ${short}${r.state === 'MOVED' ? `\n            -> ${r.to.replace(/^https?:\/\//, '').slice(0, 62)}` : ''}${r.why ? `  (${r.why})` : ''}`);
      if (r.state === 'OK') ok += 1;
      else if (r.state === 'MOVED') moved += 1;
      else if (r.state === 'GONE') gone += 1;
      else if (r.state === 'KNOWN-MOVED') knownMoved += 1;
      else unknown += 1;
    }
  }

  console.log(`\n  ${ok} fine · ${moved} moved · ${gone} gone · ${unknown} could not judge`);
  if (knownMoved) {
    console.log(`  ${knownMoved} link(s) MOVED and the document already says so - counted separately,`);
    console.log('  because a finding the source has already explained is not an open finding.');
  }
  if (moved) console.log('  MOVED is the one to read: a 200 that is no longer the page you linked.');
  if (unknown) console.log('  "could not judge" is NOT a dead link and is not counted as one.');

  // Exit non-zero only for states that mean the catalogue is now wrong. An unreachable
  // host is a fact about today, not about the entry.
  process.exitCode = (gone || moved) ? 1 : 0;
})();

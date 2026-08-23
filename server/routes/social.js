//
// social — every social account in one place, and the numbers that can be had for free.
//
// WHY THIS IS NOT A LIST YOU MAINTAIN. The workspace gate rejects a module that only accepts
// input and shows it back, and a hand-typed table of profile links is exactly that: a surface
// you feed, stale the first time a handle changes and wrong in the direction that flatters.
// So nothing here is typed.
//
//   the accounts   come from Survive/LAUNCH.md's identity table, which is already the one
//                  place that answers "which account owns this". This module reads it; it
//                  never writes it, and it is not a second copy.
//   what is posted comes from Survive/dash/posted.jsonl, the file the REACH probes read.
//   the numbers    come from public APIs that need no credential at all.
//
// This mirrors trackers.js and /api/board: the project's files stay the place to WRITE, and
// the dashboard is one place to LOOK.
//
// WHAT IT DELIBERATELY DOES NOT DO. There is no engagement score, no "social health" figure
// and no ranking. A number assembled from weights I chose is the one figure nobody can audit,
// which the workspace file rules out in writing. Counts, and change since the last snapshot.
// Both are arithmetic you can check.
'use strict';

const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
// db.js exports the database itself with the helpers hung off it, so this is not a
// destructure — `const { db } = require('../db')` yields undefined and fails at first query.
const db = require('../db');
const { migrate } = db;

const router = express.Router();
const WORKSPACE = path.join(__dirname, '..', '..', '..');
const LAUNCH_MD = path.join(WORKSPACE, 'Survive', 'LAUNCH.md');
const POSTED_JSONL = path.join(WORKSPACE, 'Survive', 'dash', 'posted.jsonl');

migrate('social', [
  (d) => {
    // One row per account per metric per snapshot. Deltas are derived by comparing
    // snapshots, never stored — a stored delta is a second owner for the same fact and
    // goes wrong silently the first time a backfill lands.
    d.exec(`
      CREATE TABLE IF NOT EXISTS social_metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        surface TEXT NOT NULL,
        metric TEXT NOT NULL,
        value INTEGER NOT NULL,
        at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
      );
      CREATE INDEX IF NOT EXISTS ix_social_metrics_lookup
        ON social_metrics (surface, metric, at DESC);
    `);
  },
]);

// ------------------------------------------------------------------ the identity table

// The table sits under a heading and ends at the first line that is not a table row. Parsing
// by that shape rather than by line number means an edit above it cannot silently shift what
// is read — which is how a "correct" parser starts returning someone else's table.
function parseIdentityTable(text) {
  const lines = text.split(/\r?\n/);
  const head = lines.findIndex((l) => /^\|\s*Surface\s*\|/i.test(l));
  if (head === -1) return { rows: [], skipped: [], found: false };

  const rows = [];
  const skipped = [];
  for (let i = head + 2; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim().startsWith('|')) break;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length < 4) { skipped.push({ line: i + 1, why: `${cells.length} cells, expected 4`, text: line.slice(0, 80) }); continue; }
    const [surface, account, controlledBy, evidence] = cells;
    if (!surface) { skipped.push({ line: i + 1, why: 'no surface name', text: line.slice(0, 80) }); continue; }
    rows.push({
      surface,
      account: strip(account),
      // A blank here is deliberate in the source file: "a guess in this column is worse than
      // a gap, because it is the column recovery depends on". Preserve the blank as null.
      controlledBy: /^[—-]?$/.test(strip(controlledBy)) ? null : strip(controlledBy),
      evidence: strip(evidence),
    });
  }
  return { rows, skipped, found: true };
}

const strip = (s) => String(s || '').replace(/\*\*/g, '').trim();

function readPosted() {
  if (!fs.existsSync(POSTED_JSONL)) return { channels: {}, skipped: [{ why: 'posted.jsonl missing' }] };
  const skipped = [];
  const channels = {};
  fs.readFileSync(POSTED_JSONL, 'utf8').split(/\r?\n/).filter(Boolean).forEach((line, i) => {
    let row;
    try { row = JSON.parse(line); } catch (e) { skipped.push({ line: i + 1, why: 'unparseable JSON' }); return; }
    if (!row.channel || row.channel === 'note') return;
    channels[row.channel] = { at: row.at || null, url: row.url || null, verified: row.verified === true };
  });
  return { channels, skipped };
}

// ------------------------------------------------------------------ free public metrics

// Only sources that need NO credential. An API key belongs in a Worker secret, not in a
// module that a browser panel calls, and half this dashboard's value is that it works with
// nothing configured. Where a number cannot be had for free, the surface says so explicitly
// rather than reporting zero — see the note on `state` below.
const TIMEOUT_MS = 6000;

async function getJson(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { 'user-agent': 'mission-control/social' } });
    if (!r.ok) return { ok: false, why: `HTTP ${r.status}` };
    return { ok: true, body: await r.json() };
  } catch (e) {
    return { ok: false, why: e.name === 'AbortError' ? `timed out after ${TIMEOUT_MS}ms` : e.message };
  } finally {
    clearTimeout(timer);
  }
}

// ABSENCE AND FAILURE MUST NOT LOOK THE SAME. A brand-new account with no followers and an
// endpoint that could not be reached both want to render as "0" if you let them, and the
// second one is the case you need to notice. Every metric therefore carries a state:
//
//   ok             the number is real and current
//   unreachable    we asked and could not get an answer — the number is unknown, NOT zero
//   no-public-api  there is no way to get this without a credential; nobody is at fault
//
// The panel renders the last two as text, never as a figure.
// The blank green "@" that Bluesky uploads as a real blob on signup. Content-addressed, so
// this CID is the picture rather than the account — see the note in blueskyMetrics.
const BSKY_PLACEHOLDER_AVATAR_CID = 'bafkreieebsvvdngfpwxdzhuu2xrghrqrh5bcslyfilfuhk5o6pi4rgqlk4';
const isPlaceholderAvatar = (url) => String(url || '').includes(BSKY_PLACEHOLDER_AVATAR_CID);

async function blueskyMetrics(handle) {
  const res = await getJson(`https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(handle)}`);
  if (!res.ok) return { state: 'unreachable', why: res.why, metrics: {} };
  const p = res.body;
  return {
    state: 'ok',
    metrics: { followers: p.followersCount ?? 0, following: p.followsCount ?? 0, posts: p.postsCount ?? 0 },
    extra: {
      // These are why this module exists at all. On 23 Aug 2026 the account was live, had a
      // bio and had never posted, and nothing anywhere reported that.
      //
      // AVATAR IS NOT A BOOLEAN, AND `Boolean(p.avatar)` IS THE WRONG TEST. It fooled me on
      // 23 Aug: the field held a CDN URL, I concluded an avatar had been uploaded, and the
      // profile was still showing the blank green "@". The URL is real — a genuine blob was
      // uploaded — but its CONTENT is the placeholder art. Asking "is the field set" answers
      // a narrower question than "is this profile dressed", which is the claim it was being
      // used for.
      //
      // Blob URLs are content-addressed, so the placeholder has the same CID wherever it
      // appears and an exact match is auditable rather than heuristic. Scope of this check,
      // stated because it matters: the CID below was verified by downloading and LOOKING at
      // the image on 23 Aug 2026. It identifies that exact picture and nothing else — a
      // different default, or a new one, will read as a real avatar until someone checks.
      hasAvatar: Boolean(p.avatar) && !isPlaceholderAvatar(p.avatar),
      avatarIsPlaceholder: Boolean(p.avatar) && isPlaceholderAvatar(p.avatar),
      hasBanner: Boolean(p.banner),
      displayName: p.displayName || null,
    },
  };
}

async function discordMetrics(inviteCode) {
  const res = await getJson(`https://discord.com/api/v10/invites/${encodeURIComponent(inviteCode)}?with_counts=true`);
  if (!res.ok) return { state: 'unreachable', why: res.why, metrics: {} };
  const b = res.body;
  return {
    state: 'ok',
    metrics: { members: b.approximate_member_count ?? 0, online: b.approximate_presence_count ?? 0 },
    // LAUNCH.md records that the invite dialog once claimed "will never expire" about a code
    // the API said expired. The API is the artefact; read expiry from it.
    extra: { expiresAt: b.expires_at ?? null, permanent: b.expires_at == null },
  };
}

// Which surfaces can be measured for free, and how to find their identifier in the row.
const MEASURABLE = {
  bluesky: {
    match: /bluesky/i,
    id: (row) => (row.account.match(/@([a-z0-9.-]+\.bsky\.social)/i) || [])[1] || null,
    fetch: blueskyMetrics,
    url: (id) => `https://bsky.app/profile/${id}`,
  },
  discord: {
    match: /discord/i,
    id: (row) => (row.account.match(/discord\.gg\/([A-Za-z0-9]+)/) || [])[1] || null,
    fetch: discordMetrics,
    url: (id) => `https://discord.gg/${id}`,
  },
};

// Surfaces with no free number, and the honest reason. Stated per surface so the panel can
// explain a blank instead of leaving the reader to assume the fetch broke.
const NO_FREE_METRIC = {
  'itch.io storefront': 'itch has no public stats API — views and downloads are behind the creator dashboard',
  'youtube brand channel': 'YouTube subscriber and view counts need an API key',
  reddit: 'Reddit blocks unauthenticated server-side reads of user karma',
  'google analytics': 'GA needs OAuth; it is the owner of site traffic, not this module',
};

function linkFor(row) {
  const a = row.account;
  let m;
  if ((m = a.match(/@([a-z0-9.-]+\.bsky\.social)/i))) return `https://bsky.app/profile/${m[1]}`;
  if ((m = a.match(/discord\.gg\/([A-Za-z0-9]+)/))) return `https://discord.gg/${m[1]}`;
  if ((m = a.match(/([a-z0-9-]+\.itch\.io\/[a-z0-9-]+)/i))) return `https://${m[1]}`;
  if (/youtube/i.test(row.surface) && (m = a.match(/@([A-Za-z0-9_.-]+)/))) return `https://www.youtube.com/${m[0]}`;
  if (/reddit/i.test(row.surface) && (m = a.match(/u\/([A-Za-z0-9_-]+)/))) return `https://www.reddit.com/user/${m[1]}`;
  if ((m = a.match(/github/i))) return null;
  return null;
}

function snapshot(surface, metrics) {
  const ins = db.prepare('INSERT INTO social_metrics (surface, metric, value) VALUES (?, ?, ?)');
  for (const [metric, value] of Object.entries(metrics)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    ins.run(surface, metric, Math.round(value));
  }
}

// The previous DISTINCT value, not simply the previous row: polling twice in a minute would
// otherwise report "no change since a minute ago", which is true and useless. What the reader
// wants is "last time this number was different, and when".
function previousDifferent(surface, metric, current) {
  return db.prepare(
    `SELECT value, at FROM social_metrics
      WHERE surface = ? AND metric = ? AND value != ?
      ORDER BY at DESC, id DESC LIMIT 1`
  ).get(surface, metric, current) || null;
}

// ------------------------------------------------------------------ the post queue
//
// Nineteen Bluesky posts were written in advance and live in Survive/SOCIAL-POSTS.md. This
// reads them and works out which are still unposted — by comparing them against the ACCOUNT'S
// ACTUAL FEED, not against a checklist somebody ticks. There is no "posted" flag to maintain
// anywhere: post something and it leaves the queue on the next load, because the queue is
// derived from what the world says rather than from what we remember telling it.
const SOCIAL_POSTS_MD = path.join(WORKSPACE, 'Survive', 'SOCIAL-POSTS.md');
const POST_IMAGE_DIR = path.join(WORKSPACE, 'Survive', 'social', 'bluesky');

// The bank wraps its prose to about 78 columns, so a line break is usually SOFT and must be
// joined — except where the previous line ends a sentence, which is where the author meant a
// paragraph. Getting this wrong is visible rather than subtle: join too eagerly and two
// paragraphs run together, split too eagerly and the post arrives full of ragged breaks.
// The rendered text is returned in full so it can be read before it is used, never summarised.
function joinWrapped(lines) {
  const out = [];
  let para = '';
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { if (para) { out.push(para); para = ''; } continue; }
    para = para ? `${para} ${line}` : line;
    if (/[.!?][)"']?$/.test(line)) { out.push(para); para = ''; }
  }
  if (para) out.push(para);
  return out.join('\n\n');
}

function parseBank(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s+Bluesky/i.test(l));
  if (start === -1) return { posts: [], skipped: [{ why: 'no "## Bluesky" section in SOCIAL-POSTS.md' }], cadence: null };
  // The bank ends where the next top-level section begins — devlog skeletons and the Discord
  // rhythm follow it, and reading past this point would post a devlog draft to Bluesky.
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) if (/^##\s+/.test(lines[i])) { end = i; break; }

  const cadence = (lines.slice(start, end).find((l) => /a week/i.test(l)) || '').trim() || null;

  const posts = [];
  const skipped = [];
  let cur = null;
  for (let i = start; i < end; i += 1) {
    const line = lines[i];
    const head = line.match(/^\*\*(\d+)\.\*\*\s*(.*)$/);
    if (head) {
      if (cur) posts.push(cur);
      cur = { n: Number(head[1]), lines: [head[2]], imageHint: null };
      continue;
    }
    if (!cur) continue;
    const img = line.match(/^\s*🖼️\s*\*?(.*?)\*?\s*$/);
    if (img) { cur.imageHint = img[1].trim(); continue; }
    if (/^###\s+/.test(line)) { posts.push(cur); cur = null; continue; }  // week heading ends a post
    cur.lines.push(line);
  }
  if (cur) posts.push(cur);

  const built = posts.map((p) => {
    const body = joinWrapped(p.lines);
    if (!body) skipped.push({ n: p.n, why: 'no text after the number' });
    return { n: p.n, text: body, imageHint: p.imageHint };
  }).filter((p) => p.text);

  return { posts: built, skipped, cadence };
}

// Matching a written post to a published one cannot be an equality test: the bank is wrapped,
// carries markdown, and an em dash may be typed differently. Normalise hard, then compare a
// prefix long enough to be unambiguous across nineteen posts that deliberately share a voice.
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const MATCH_CHARS = 60;

function matchPublished(bank, published) {
  const pubNorm = published.map((t) => norm(t));
  return bank.map((p) => {
    const key = norm(p.text).slice(0, MATCH_CHARS);
    const at = pubNorm.findIndex((t) => t.startsWith(key) || t.includes(key));
    return { ...p, published: at !== -1, publishedText: at !== -1 ? published[at] : null };
  });
}

// An image is "ready" only if a file actually exists for it. The bank's own hint is prose
// about what to look for and is not a filename, so it is shown as guidance and never as if a
// file were waiting. Posts 1-4 have cut images; 5-19 do not, and the panel says so.
function imageFor(n) {
  if (!fs.existsSync(POST_IMAGE_DIR)) return null;
  const hit = fs.readdirSync(POST_IMAGE_DIR).find((f) => new RegExp(`^post${n}[-_.]`, 'i').test(f));
  return hit ? { file: hit, path: `Survive/social/bluesky/${hit}` } : null;
}

// The cadence is READ FROM THE BANK, not chosen here — "Three to four a week" is the author's
// instruction and this takes the lower, safer end of whatever range it states. A cadence I
// picked would be a number nobody could audit.
function perWeekFrom(cadence) {
  const words = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7 };
  const found = String(cadence || '').toLowerCase().match(/\b(one|two|three|four|five|six|seven|\d+)\b/g) || [];
  const nums = found.map((w) => words[w] ?? Number(w)).filter((n) => n >= 1 && n <= 7);
  return nums.length ? Math.min(...nums) : null;
}

const addDaysISO = (iso, days) => {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
};

async function buildQueue() {
  const notes = [];
  if (!fs.existsSync(SOCIAL_POSTS_MD)) {
    return { available: false, why: 'Survive/SOCIAL-POSTS.md not found', posts: [], pending: [], notes };
  }
  const bank = parseBank(fs.readFileSync(SOCIAL_POSTS_MD, 'utf8'));

  // What has actually been published, from the account itself.
  let published = [];
  let feedState = 'ok';
  const feed = await getJson('https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=hollowmast.bsky.social&limit=100');
  if (feed.ok) {
    published = (feed.body.feed || []).map((f) => f.post?.record?.text || '');
  } else {
    feedState = 'unreachable';
    // NOT the same as "nothing is published". If the feed cannot be read, every post would
    // otherwise look pending and the panel would invite you to repost things you already have.
    notes.push(`Could not read the feed (${feed.why}) — the queue below is the WHOLE bank, not what is outstanding.`);
  }

  const marked = matchPublished(bank.posts, published);
  const perWeek = perWeekFrom(bank.cadence);
  const gapDays = perWeek ? Math.round(7 / perWeek) : null;

  // The suggested day is arithmetic from the last post and the stated cadence, and it is
  // labelled a SUGGESTION everywhere it appears. See the note in the schedule integration.
  const lastPostedAt = (() => {
    if (!feed.ok) return null;
    const first = (feed.body.feed || [])[0];
    return first?.post?.record?.createdAt ? String(first.post.record.createdAt).slice(0, 10) : null;
  })();

  let i = 0;
  const posts = marked.map((p) => {
    const image = imageFor(p.n);
    if (p.published) return { ...p, image, suggestedFor: null, composeUrl: null };
    i += 1;
    const suggestedFor = (lastPostedAt && gapDays) ? addDaysISO(lastPostedAt, gapDays * i) : null;
    return {
      ...p,
      image,
      suggestedFor,
      // Bluesky's compose intent pre-fills the text. It cannot attach an image — that is a
      // platform limit, not an oversight — so the panel names the file to attach by hand.
      composeUrl: `https://bsky.app/intent/compose?text=${encodeURIComponent(p.text)}`,
    };
  });

  return {
    available: true,
    source: 'Survive/SOCIAL-POSTS.md',
    cadence: bank.cadence,
    cadencePerWeek: perWeek,
    feedState,
    lastPostedAt,
    counts: { total: posts.length, published: posts.filter((p) => p.published).length, pending: posts.filter((p) => !p.published).length },
    posts,
    pending: posts.filter((p) => !p.published),
    residue: { bankEntriesSkipped: bank.skipped },
    notes,
  };
}

// ------------------------------------------------------------------ the route

router.get('/', async (req, res) => {
  const notes = [];

  let identity = { rows: [], skipped: [], found: false };
  if (fs.existsSync(LAUNCH_MD)) {
    identity = parseIdentityTable(fs.readFileSync(LAUNCH_MD, 'utf8'));
    if (!identity.found) notes.push('LAUNCH.md has no identity table heading — nothing to read');
  } else {
    notes.push(`LAUNCH.md not found at ${LAUNCH_MD}`);
  }

  const posted = readPosted();

  const accounts = await Promise.all(identity.rows.map(async (row) => {
    const key = row.surface.toLowerCase();
    const base = {
      surface: row.surface,
      account: row.account,
      controlledBy: row.controlledBy,
      evidence: row.evidence,
      url: linkFor(row),
      posted: null,
      metrics: {},
      state: 'no-public-api',
      why: NO_FREE_METRIC[key] || 'no free source for this surface',
      extra: null,
    };

    for (const [name, spec] of Object.entries(MEASURABLE)) {
      if (!spec.match.test(row.surface)) continue;
      const id = spec.id(row);
      if (!id) { base.state = 'unreachable'; base.why = `could not find a ${name} identifier in the identity row`; break; }
      const got = await spec.fetch(id);
      base.state = got.state;
      base.why = got.why || null;
      base.extra = got.extra || null;
      if (got.state === 'ok') {
        snapshot(row.surface, got.metrics);
        base.metrics = Object.fromEntries(Object.entries(got.metrics).map(([m, v]) => {
          const prev = previousDifferent(row.surface, m, v);
          return [m, { value: v, prevValue: prev ? prev.value : null, prevAt: prev ? prev.at : null, change: prev ? v - prev.value : null }];
        }));
      }
      break;
    }

    for (const [channel, info] of Object.entries(posted.channels)) {
      if (new RegExp(channel, 'i').test(row.surface)) { base.posted = { channel, ...info }; break; }
    }
    return base;
  }));

  // A filter that drops rows makes the survivors look cleaner than they are, so say what was
  // dropped and why. This is the residue rule the board's parsers already follow.
  const residue = {
    identityRowsSkipped: identity.skipped,
    postedLinesSkipped: posted.skipped,
    surfacesWithoutLink: accounts.filter((a) => !a.url).map((a) => a.surface),
  };

  res.json({
    generatedAt: new Date().toISOString(),
    sources: {
      identity: { file: 'Survive/LAUNCH.md', rows: identity.rows.length },
      posted: { file: 'Survive/dash/posted.jsonl', channels: Object.keys(posted.channels).length },
      live: 'public.api.bsky.app and discord.com invite API — no credentials used',
    },
    accounts,
    residue,
    notes,
  });
});

// History for one surface, so the panel can show a shape rather than a single number.
router.get('/history/:surface', (req, res) => {
  const rows = db.prepare(
    `SELECT metric, value, at FROM social_metrics WHERE surface = ? ORDER BY at ASC LIMIT 500`
  ).all(req.params.surface);
  res.json({ surface: req.params.surface, points: rows.length, rows });
});

// The written post bank, and which of it is still outstanding.
router.get('/queue', async (req, res) => {
  try {
    res.json(await buildQueue());
  } catch (err) {
    // A failed read is not an empty queue, and must not render as one.
    res.status(500).json({ available: false, why: err.message, note: 'This is a failed read, not an empty queue.' });
  }
});

module.exports = router;

// Attached AFTER the router export, because `module.exports = router` replaces the object and
// would silently drop anything hung off it beforehand — the schedule would then see
// `pendingQueue` as undefined and quietly show no posts.
//
// Exported so the schedule can ASK for these rather than keeping a copy. The schedule module
// forbids seeded events in its own words — "an invented date in a schedule is indistinguishable
// from one you set" — and these dates are derived from a cadence, not chosen by the owner. So
// they are handed over as clearly-labelled suggestions and never written to its table.
module.exports.pendingQueue = buildQueue;

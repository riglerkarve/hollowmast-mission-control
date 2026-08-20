#!/usr/bin/env node
'use strict';

// Proves the browsing briefing helpers against an isolated database. The worker receives a
// named MC_DB_PATH, never data/dashboard.db; the parent removes that directory after it exits.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

if (process.argv.includes('--worker')) {
  (async () => {
    const db = require('../server/db');
    const browsing = require('../server/routes/browsing');
    assert.equal(db.prepare(`SELECT version FROM schema_meta WHERE module = 'browsing'`).get().version, 4);
    db.prepare(`INSERT INTO browsing_domains (domain, visits, pages, first_seen, last_seen, source)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run('example.test', 12, 4, '2026-08-01', '2026-08-08', 'fixture');
    db.prepare(`INSERT INTO browsing_domain_days (source, domain, day, visits, pages)
      VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)`)
      .run('fixture', 'example.test', '2026-08-01', 3, 2,
        'fixture', 'example.test', '2026-08-08', 9, 4,
        'fixture', 'another.test', '2026-08-08', 2, 1);

    const recent = browsing.recentAttention();
    assert.equal(recent.state, 'ok');
    assert.equal(recent.asOf, '2026-08-08');
    assert.deepEqual(recent.rows[0], { domain: 'example.test', recent: 9, previous: 3, change: 6 });

    const parsed = browsing.parseRss(`<?xml version="1.0"?><rss><channel><item>
      <title><![CDATA[Public &amp; useful]]></title><link>https://news.example/item</link>
      <pubDate>Wed, 20 Aug 2026 10:00:00 GMT</pubDate></item></channel></rss>`, 'Fixture News');
    assert.deepEqual(parsed, [{ title: 'Public & useful', url: 'https://news.example/item', published: 'Wed, 20 Aug 2026 10:00:00 GMT', source: 'Fixture News' }]);
    const deduped = browsing.dedupeArticles([
      { title: 'Public & useful', url: 'https://news.example/item', source: 'Fixture News' },
      { title: 'Public & useful', url: 'https://news.example/item/', source: 'Duplicate News' },
    ]);
    assert.equal(deduped.duplicatesRemoved, 1);
    assert.deepEqual(deduped.articles.map((article) => article.id), [1]);
    assert.ok(browsing.NEWS_FEEDS.every((feed) => !feed.url.includes('example.test')));

    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/', browsing);
    const server = await new Promise((resolve) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    try {
      const base = `http://127.0.0.1:${server.address().port}`;
      const create = await fetch(`${base}/topics`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ topic: '3D printing' }) });
      assert.equal(create.status, 201);
      const savedFeedback = await fetch(`${base}/briefing/feedback`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision: 'relevant', url: 'https://news.example/item', title: 'Public & useful', source: 'Fixture News' }),
      });
      assert.equal(savedFeedback.status, 201);
      assert.deepEqual(await savedFeedback.json(), { saved: true, decision: 'relevant' });
      assert.equal(db.prepare('SELECT decision FROM browsing_news_feedback WHERE url = ?').get('https://news.example/item').decision, 'relevant');
      const overview = await fetch(`${base}/`).then((r) => r.json());
      assert.deepEqual(overview.topics.map((row) => row.topic), ['3D printing']);
      assert.deepEqual(overview.newsSources, ['BBC News', 'BBC Business', 'BBC Technology']);
      const removed = await fetch(`${base}/topics/${encodeURIComponent('3D printing')}`, { method: 'DELETE' });
      assert.equal(removed.status, 200);
      const needsTopic = await fetch(`${base}/briefing/refresh`, { method: 'POST' });
      assert.equal(needsTopic.status, 400);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
    process.stdout.write('worker checks passed\n');
  })().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
  return;
}

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-browsing-briefing-'));
const dbPath = path.join(tempDir, 'browsing-briefing-test.db');
const out = spawnSync(process.execPath, [__filename, '--worker'], {
  cwd: path.join(__dirname, '..'), encoding: 'utf8',
  env: { ...process.env, MC_DB_PATH: dbPath, MC_DISABLE_ACCESS_LOG: '1', MC_ACTOR: 'verify-browsing-briefing' },
});
try {
  if (out.status !== 0) throw new Error(`${out.stdout}\n${out.stderr}`.trim());
  process.stdout.write(`passed: ${out.stdout.trim()}\n`);
  process.stdout.write(`temporary database used (and removed): ${dbPath}\n`);
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

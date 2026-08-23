// social — one place to reach every account, and the numbers that come free with it.
//
// Reads only /api/social. Nothing on this panel is typed by anyone: the accounts come from
// HOLLOWMAST's own identity table and the figures from public APIs, so there is nothing here
// to keep up to date and nothing to forget to update.
//
// The one rule this panel exists to honour: A MISSING NUMBER AND A BROKEN FETCH MUST NOT
// LOOK THE SAME. Both would render as "0" if allowed to, and the broken one is the case worth
// noticing. Anything not in state 'ok' renders as words, never as a figure.

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

let root = null;
let timer = null;

const TEMPLATE = `
  <div class="panel">
    <div class="panel-header">
      <h1>Social</h1>
      <button class="soc-refresh" id="socRefresh">Refresh</button>
    </div>
    <p class="panel-lede" id="socLede">Loading…</p>
    <div id="socQueue"></div>
    <div id="socBody"></div>
  </div>`;

function fmt(n) {
  return typeof n === 'number' ? n.toLocaleString('en-GB') : '—';
}

function changeChip(m) {
  if (!m || m.change == null) return '<span class="soc-chip soc-chip-flat">first reading</span>';
  if (m.change === 0) return '';
  const up = m.change > 0;
  const when = m.prevAt ? ` since ${esc(String(m.prevAt).slice(0, 10))}` : '';
  return `<span class="soc-chip ${up ? 'soc-chip-up' : 'soc-chip-down'}">${up ? '+' : ''}${fmt(m.change)}${when}</span>`;
}

function metricsBlock(a) {
  if (a.state === 'ok') {
    const keys = Object.keys(a.metrics);
    if (!keys.length) return '<p class="soc-muted">No figures returned.</p>';
    return `<div class="soc-metrics">${keys.map((k) => `
      <div class="soc-metric">
        <span class="soc-metric-value">${fmt(a.metrics[k].value)}</span>
        <span class="soc-metric-label">${esc(k)}</span>
        ${changeChip(a.metrics[k])}
      </div>`).join('')}</div>`;
  }
  // Deliberately words, not a number. See the header note.
  const cls = a.state === 'unreachable' ? 'soc-warn' : 'soc-muted';
  const label = a.state === 'unreachable' ? 'Could not read' : 'No free figure';
  return `<p class="${cls}"><strong>${label}.</strong> ${esc(a.why || '')}</p>`;
}

// The flags that made this panel worth building: an account can be live, correct and
// completely inert, and nothing else in the workspace reports that.
function flags(a) {
  const out = [];
  // Two different states, deliberately worded differently: no avatar at all, versus an
  // avatar that is really there and is the signup placeholder. The second is the one that
  // looks fine in an API response and blank on the page.
  if (a.extra && a.extra.avatarIsPlaceholder) out.push('placeholder avatar');
  else if (a.extra && a.extra.hasAvatar === false) out.push('no avatar');
  if (a.extra && a.extra.hasBanner === false) out.push('no banner');
  if (a.state === 'ok' && a.metrics.posts && a.metrics.posts.value === 0) out.push('never posted');
  if (a.state === 'ok' && a.metrics.followers && a.metrics.followers.value === 0) out.push('no followers');
  if (!a.controlledBy) out.push('owner not recorded');
  if (a.extra && a.extra.permanent === false) out.push('invite expires');
  if (!out.length) return '';
  return `<div class="soc-flags">${out.map((f) => `<span class="soc-flag">${esc(f)}</span>`).join('')}</div>`;
}

function card(a) {
  const link = a.url
    ? `<a class="soc-open" href="${esc(a.url)}" target="_blank" rel="noopener noreferrer">Open ↗</a>`
    : '<span class="soc-muted soc-open">no link</span>';
  const posted = a.posted
    ? `<span class="soc-posted">posted ${esc(a.posted.at || '')}${a.posted.verified ? ' ✓' : ''}</span>`
    : '';
  return `
    <div class="soc-card">
      <div class="soc-card-head">
        <div>
          <h3>${esc(a.surface)}</h3>
          <p class="soc-account">${esc(a.account)}</p>
        </div>
        ${link}
      </div>
      ${metricsBlock(a)}
      ${flags(a)}
      <p class="soc-owner">${a.controlledBy ? `owner ${esc(a.controlledBy)}` : '<em>owner not recorded — a guess here is worse than a gap</em>'} ${posted}</p>
    </div>`;
}

function render(data) {
  const body = root.querySelector('#socBody');
  const lede = root.querySelector('#socLede');

  const measured = data.accounts.filter((a) => a.state === 'ok').length;
  const broken = data.accounts.filter((a) => a.state === 'unreachable').length;
  lede.textContent =
    `${data.accounts.length} accounts, read from LAUNCH.md. ${measured} measured live, ` +
    `${broken} could not be read, ${data.accounts.length - measured - broken} have no free figure. ` +
    'Nothing on this page is typed.';

  const residueBits = [];
  if (data.residue.identityRowsSkipped.length) residueBits.push(`${data.residue.identityRowsSkipped.length} identity row(s) unparsed`);
  if (data.residue.postedLinesSkipped.length) residueBits.push(`${data.residue.postedLinesSkipped.length} posted.jsonl line(s) unparsed`);
  if (data.residue.surfacesWithoutLink.length) residueBits.push(`no link for: ${data.residue.surfacesWithoutLink.join(', ')}`);

  body.innerHTML = `
    <div class="soc-grid">${data.accounts.map(card).join('')}</div>
    ${data.notes.length ? `<p class="soc-warn">${data.notes.map(esc).join(' · ')}</p>` : ''}
    <p class="soc-residue">${residueBits.length ? `Residue: ${esc(residueBits.join(' · '))}` : 'Residue: nothing dropped.'}
      <br><span class="soc-muted">Sources: ${esc(data.sources.identity.file)} (${data.sources.identity.rows} rows) ·
      ${esc(data.sources.posted.file)} (${data.sources.posted.channels} channels) · ${esc(data.sources.live)}</span></p>`;
}

// ------------------------------------------------------------------ the post queue

// There is no "mark as posted" button anywhere on this panel, and that is the point. Status
// comes from the account's own feed, so posting something removes it from the queue on the
// next load. A tick box would be a second place the same fact lives, and the one that goes
// stale is always the tick box.
function queueItem(p, isNext) {
  const img = p.image
    ? `<span class="socq-img socq-img-ready">image ready — <code>${esc(p.image.file)}</code></span>`
    : `<span class="socq-img socq-img-none">no image cut yet — look for: ${esc(p.imageHint || 'unspecified')}</span>`;
  return `
    <div class="socq-item${isNext ? ' socq-next' : ''}">
      <div class="socq-head">
        <span class="socq-n">#${p.n}</span>
        ${isNext ? '<span class="socq-badge">next up</span>' : ''}
        <span class="socq-when">${p.suggestedFor ? `suggested ${esc(p.suggestedFor)}` : 'no suggested day'}</span>
      </div>
      <pre class="socq-text" data-text="${esc(p.text)}">${esc(p.text)}</pre>
      ${img}
      <div class="socq-actions">
        <button class="socq-copy" data-copy="${esc(p.text)}">Copy text</button>
        ${p.composeUrl ? `<a class="socq-compose" href="${esc(p.composeUrl)}" target="_blank" rel="noopener noreferrer">Open composer ↗</a>` : ''}
      </div>
    </div>`;
}

function renderQueue(q) {
  const el = root.querySelector('#socQueue');
  if (!q || !q.available) {
    el.innerHTML = `<p class="soc-warn">Post queue unavailable: ${esc((q && q.why) || 'unknown')}</p>`;
    return;
  }
  // A feed we could not read makes everything look unposted. Say so loudly rather than
  // inviting a repost of something already out.
  const warn = q.feedState !== 'ok'
    ? `<p class="soc-warn"><strong>Feed unreadable.</strong> ${esc(q.notes.join(' '))}</p>` : '';

  const pending = q.pending;
  el.innerHTML = `
    <div class="socq">
      <div class="socq-bar">
        <h2>Post queue</h2>
        <span class="socq-count">${q.counts.pending} pending of ${q.counts.total} written · ${q.counts.published} already out</span>
        <button class="socq-toggle" id="socqToggle">${pending.length > 3 ? 'Show all' : ''}</button>
      </div>
      ${warn}
      <p class="socq-note">
        Written in <code>${esc(q.source)}</code>. Status is read from the account's own feed, so a post
        leaves this queue once it is out — there is nothing here to tick.
        ${q.cadencePerWeek ? `Cadence from the bank: <strong>${q.cadencePerWeek} a week</strong>, so suggested days are ${Math.round(7 / q.cadencePerWeek)} apart from the last post (${esc(q.lastPostedAt || 'unknown')}).` : ''}
        <strong>Suggested days are arithmetic, not commitments</strong> — nothing here is in your diary unless you put it there.
      </p>
      <div class="socq-list" id="socqList">
        ${pending.slice(0, 3).map((p, i) => queueItem(p, i === 0)).join('')}
      </div>
      <div class="socq-list socq-hidden" id="socqRest">
        ${pending.slice(3).map((p) => queueItem(p, false)).join('')}
      </div>
      ${q.residue.bankEntriesSkipped.length
        ? `<p class="soc-residue">Residue: ${q.residue.bankEntriesSkipped.length} bank entr(y/ies) unread — ${esc(JSON.stringify(q.residue.bankEntriesSkipped))}</p>`
        : '<p class="soc-residue">Residue: every entry in the bank was read.</p>'}
    </div>`;

  const toggle = el.querySelector('#socqToggle');
  const rest = el.querySelector('#socqRest');
  if (toggle && pending.length > 3) {
    toggle.addEventListener('click', () => {
      const hidden = rest.classList.toggle('socq-hidden');
      toggle.textContent = hidden ? 'Show all' : 'Show fewer';
    });
  }
  el.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('.socq-copy');
    if (!btn) return;
    try {
      await navigator.clipboard.writeText(btn.dataset.copy);
      btn.textContent = 'Copied';
      setTimeout(() => { btn.textContent = 'Copy text'; }, 1600);
    } catch (e) {
      // Clipboard can be refused by permissions. Say so instead of pretending it worked.
      btn.textContent = 'Copy blocked — select the text above';
      setTimeout(() => { btn.textContent = 'Copy text'; }, 2600);
    }
  });
}

async function load() {
  if (!root) return;
  try {
    // Fetched together but rendered independently: the queue reads local files and the
    // accounts hit the network, so one being slow or broken must not blank the other.
    const [r, rq] = await Promise.all([
      fetch('/api/social', { headers: { 'x-mc-by': 'you' } }),
      fetch('/api/social/queue', { headers: { 'x-mc-by': 'you' } }).catch(() => null),
    ]);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    if (!root) return;
    render(data);
    if (rq && rq.ok) renderQueue(await rq.json());
    else renderQueue({ available: false, why: rq ? `HTTP ${rq.status}` : 'request failed' });
  } catch (e) {
    if (!root) return;
    // The panel failing and every account failing are different things, and this is the first.
    root.querySelector('#socBody').innerHTML =
      `<p class="soc-warn">Could not load /api/social: ${esc(e.message)}. This is the panel failing, not the accounts.</p>`;
    root.querySelector('#socLede').textContent = '';
  }
}

export default {
  mount(el) {
    root = el;
    el.innerHTML = TEMPLATE;
    el.querySelector('#socRefresh').addEventListener('click', load);
    load();
    // Every load takes a live snapshot, so a fast poll would fill the history table with
    // duplicates and make "change since" meaningless. Ten minutes is slow enough that a
    // reading means something and fast enough to be current when you open the page.
    timer = setInterval(load, 10 * 60 * 1000);
  },
  unmount() {
    if (timer) clearInterval(timer);
    timer = null;
    root = null;
  },
};

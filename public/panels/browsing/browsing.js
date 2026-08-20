// Browsing — where attention goes. Reads only /api/browsing.
//
// Domains and counts. No URLs and no page titles exist in the store, so none can be shown
// here even by accident — see the migration note in server/routes/browsing.js.
//
// It does not judge what is on the list. There is no "wasted time" figure and there will
// not be one: that would be a weighting I invented, presented back as a measurement.

let root = null;
let loadToken = 0;

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));
const gbp = (p) => `£${((p || 0) / 100).toFixed(2)}`;

const TEMPLATE = `
  <div class="panel panel-wide">
    <div class="panel-header">
      <h1>Browsing</h1>
      <div class="badge"><span class="badge-icon">◷</span><span id="brWindow">—</span></div>
    </div>
    <section class="card" id="brTop"></section>
    <section class="card" id="brRecent"></section>
    <section class="card" id="brNews"></section>
    <section class="card" id="brCross"></section>
  </div>
`;

function briefingMarkup(briefing) {
  if (!briefing) return '<p class="empty-hint">No local news briefing has been built yet.</p>';
  const sourceFailure = briefing.feedFailures && briefing.feedFailures.length
    ? `<p class="br-note failure-hint">Partial feed check: ${briefing.feedFailures.map(esc).join(' · ')}</p>` : '';
  if (briefing.state !== 'ok' || !briefing.briefing) {
    return `<p class="empty-hint failure-hint">The last briefing was not completed locally.<br><small>${esc(briefing.failure || 'No usable local-model answer.')}</small></p>${sourceFailure}`;
  }
  return `
    <p class="br-note"><strong>${esc(briefing.briefing.headline)}</strong> · built ${esc(briefing.fetchedAt)} with ${esc(briefing.model || 'the local model')}</p>
    <ul class="br-brief-list">${briefing.briefing.items.map((item) => `
      <li><a href="${esc(item.url)}" target="_blank" rel="noopener noreferrer">${esc(item.title)}</a>
        <span class="br-source">${esc(item.source)}</span>
        <span class="br-why">${esc(item.why)}</span>
        <span class="br-feedback"><button type="button" data-br-feedback="relevant" data-br-url="${esc(item.url)}" data-br-title="${esc(item.title)}" data-br-source="${esc(item.source)}">Relevant</button><button type="button" data-br-feedback="hide" data-br-url="${esc(item.url)}" data-br-title="${esc(item.title)}" data-br-source="${esc(item.source)}">Hide</button></span></li>`).join('')}</ul>${sourceFailure}`;
}

function wireNewsActions() {
  const form = root && root.querySelector('#brTopicForm');
  if (form) form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const input = root.querySelector('#brTopic');
    const status = root.querySelector('#brNewsStatus');
    status.textContent = 'Saving local topic…';
    try {
      const response = await fetch('/api/browsing/topics', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ topic: input.value }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      input.value = '';
      load();
    } catch (error) { status.textContent = `Could not save topic: ${error.message}`; }
  });
  root.querySelectorAll('[data-br-remove-topic]').forEach((button) => button.addEventListener('click', async () => {
    const status = root.querySelector('#brNewsStatus');
    status.textContent = 'Removing local topic…';
    try {
      const response = await fetch(`/api/browsing/topics/${encodeURIComponent(button.dataset.brRemoveTopic)}`, { method: 'DELETE' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      load();
    } catch (error) { status.textContent = `Could not remove topic: ${error.message}`; }
  }));
  const refresh = root && root.querySelector('#brRefreshBriefing');
  if (refresh) refresh.addEventListener('click', async () => {
    const status = root.querySelector('#brNewsStatus');
    refresh.disabled = true;
    status.textContent = 'Reading fixed public feeds and asking the local model…';
    try {
      const response = await fetch('/api/browsing/briefing/refresh', { method: 'POST' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || data.briefing?.failure || `HTTP ${response.status}`);
      load();
    } catch (error) { refresh.disabled = false; status.textContent = `Could not build briefing: ${error.message}`; }
  });
  root.querySelectorAll('[data-br-feedback]').forEach((button) => button.addEventListener('click', async () => {
    const controls = button.closest('.br-feedback');
    const decision = button.dataset.brFeedback;
    controls.querySelectorAll('button').forEach((control) => { control.disabled = true; });
    try {
      const response = await fetch('/api/browsing/briefing/feedback', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision, url: button.dataset.brUrl, title: button.dataset.brTitle, source: button.dataset.brSource }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      controls.textContent = decision === 'relevant' ? 'Saved as relevant locally' : 'Hidden from future local rankings';
    } catch (error) {
      controls.querySelectorAll('button').forEach((control) => { control.disabled = false; });
      const status = root.querySelector('#brNewsStatus');
      status.textContent = `Could not save local feedback: ${error.message}`;
    }
  }));
}

async function load() {
  if (!root) return;   // may be CALLED after teardown, not only resumed after it
  const token = ++loadToken;
  let d;
  try {
    const r = await fetch('/api/browsing');
    if (!root || token !== loadToken) return;
    d = await r.json();
    if (!root || token !== loadToken) return;
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
  } catch (err) {
    if (!root || token !== loadToken) return;
    root.querySelector('#brTop').innerHTML = `<p class="empty-hint failure-hint">Could not read browsing: ${esc(err.message)}<br><small>That is a failure to look, not an empty browsing record.</small></p>`;
    return;
  }

  if (d.state === 'empty') {
    // Nothing imported and nothing browsed must not read the same.
    root.querySelector('#brTop').innerHTML = `<p class="empty-hint">${esc(d.message)}<br><small>${esc(d.note)}</small></p>`;
    root.querySelector('#brRecent').innerHTML = '';
    root.querySelector('#brNews').innerHTML = '';
    root.querySelector('#brCross').innerHTML = '';
    return;
  }

  root.querySelector('#brWindow').textContent = `${d.window.domains} domains`;

  const max = Math.max(...d.top.map((t) => t.visits), 1);
  root.querySelector('#brTop').innerHTML = `
    <h2 class="br-h2">Where the visits went</h2>
    <p class="br-note">${esc(d.window.from)} to ${esc(d.window.to)} · ${d.window.visits.toLocaleString('en-GB')} visits
      across ${d.window.domains} domains · last imported ${esc(d.window.importedAt || 'unknown')}.</p>
    <p class="br-note br-dim">${esc(d.windowNote)}</p>
    <ul class="br-list">
      ${d.top.map((t) => `
        <li>
          <span class="br-bar" style="width:${Math.max(2, (t.visits / max) * 100)}%"></span>
          <span class="br-name">${esc(t.domain)}</span>
          <span class="br-n">${t.visits.toLocaleString('en-GB')} visits · ${t.pages} pages</span>
        </li>`).join('')}
    </ul>
    <p class="br-note br-dim">${esc(d.privacy)}</p>`;

  root.querySelector('#brRecent').innerHTML = d.recent.state === 'ok' ? `
    <h2 class="br-h2">Recent attention</h2>
    <p class="br-note">Seven days ending ${esc(d.recent.asOf)} (latest imported day), compared with the seven before it.</p>
    <ul class="br-cross">${d.recent.rows.map((row) => `
      <li><span class="br-name">${esc(row.domain)}</span><span class="br-n">${row.recent.toLocaleString('en-GB')} visits · ${row.change >= 0 ? '+' : ''}${row.change.toLocaleString('en-GB')} vs previous week</span></li>`).join('')}</ul>`
    : `<h2 class="br-h2">Recent attention</h2><p class="empty-hint">${esc(d.recent.reason)}</p>`;

  root.querySelector('#brNews').innerHTML = `
    <h2 class="br-h2">Local news briefing</h2>
    <p class="br-note">Choose topics you want to follow. They stay on this machine; requests use fixed public RSS feeds (${d.newsSources.map(esc).join(', ')}), and the local model ranks only public feed metadata.</p>
    <form class="br-topic-form" id="brTopicForm">
      <label for="brTopic">Local topic</label><input id="brTopic" maxlength="80" required placeholder="e.g. 3D printing" />
      <button class="br-btn" type="submit">Add topic</button>
    </form>
    <div class="br-topics">${d.topics.length ? d.topics.map((topic) => `<span class="br-topic">${esc(topic.topic)} <button type="button" aria-label="Remove ${esc(topic.topic)}" data-br-remove-topic="${esc(topic.topic)}">×</button></span>`).join('') : '<span class="br-note">No topics chosen yet.</span>'}</div>
    <button class="br-btn" id="brRefreshBriefing" type="button" ${d.topics.length ? '' : 'disabled'}>Build local briefing</button>
    <span class="br-action-state" id="brNewsStatus"></span>
    <div class="br-briefing">${briefingMarkup(d.briefing)}</div>`;
  wireNewsActions();

  root.querySelector('#brCross').innerHTML = `
    <h2 class="br-h2">Paid for, but not visited</h2>
    ${d.paidNotVisited.length ? `
      <ul class="br-cross">
        ${d.paidNotVisited.map((s) => `
          <li><span class="br-name">${esc(s.name)}</span>
            <span class="br-n">${esc(s.status)} · last charge ${esc(s.lastOn)} · ${gbp(s.totalPence)} in total</span></li>`).join('')}
      </ul>`
    : '<p class="empty-hint">No active recurring services were unmatched.</p>'}
    <p class="br-note br-dim">${esc(d.matchNote)}</p>`;
}

export default {
  mount(el) { root = el; el.innerHTML = TEMPLATE; load(); },
  unmount() { loadToken++; root = null; },
};

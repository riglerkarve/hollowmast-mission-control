// Work — write a prompt, hand it over, walk away.
//
// The checkboxes are the interesting part of this panel and they are NOT a settings form.
// They are the only input tools/offload-router.cjs reads, and only the person writing the
// prompt knows the answers. Every one defaults to OFF, which routes to FRONTIER — the tier
// that WAITS. Defaulting them on would route everything to the local model and would be the
// flattering default: it would look like the queue was working.
//
// Nothing on this panel applies a result anywhere. There is no "apply" button to add later
// without someone noticing it was added.
let root = null;
let timer = null;
let loadToken = 0;

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Every status renders differently, and DONE-WITH-NO-RESULT can never look like FAILED.
const STATUS = {
  queued: ['queued', 'Waiting for the next run.'],
  running: ['running', 'In flight now.'],
  done: ['done', ''],
  failed: ['FAILED', 'This did not run. It is not an empty answer.'],
  refused: ['refused by policy', ''],
  waiting_session: ['waiting for a session', 'Frontier work. This server holds no frontier credential and will not quietly run it locally instead.'],
  cancelled: ['cancelled', ''],
};

const GATES = [
  ['lowStakes', 'Low stakes', 'Being wrong here costs little and is easy to spot.'],
  ['reviewable', 'Reviewable', 'You will read the answer before anything happens because of it.'],
  ['outputConstrained', 'Output constrained', 'The answer has a shape — a list, a category, a sentence — not free rein.'],
  ['highVolume', 'High volume', 'Many items. Recorded, not required.'],
];
const NEVERS = [
  ['producesNumbers', 'Produces a number', 'Any figure that ends up displayed. Arithmetic is SQL’s job.'],
  ['autoApplied', 'Applied without review', '20 out of 20 is not 100% on the next 20.'],
  ['assertsFactAboutCode', 'Asserts a fact about the code', 'A confabulated project memory reads as verified.'],
];

const TEMPLATE = `
  <div class="panel">
    <div class="panel-header"><h1>Work</h1></div>

    <section class="card">
      <h2 class="wk-h2">Hand something over</h2>
      <p class="wk-note">The router decides the tier from what you tick — not from the prompt.
        Everything unticked means <strong>frontier</strong>, which waits for a session rather
        than running on the local model.</p>
      <textarea id="wkPrompt" class="wk-prompt" rows="4" placeholder="What do you want done?"></textarea>
      <div class="wk-gates">
        <fieldset class="wk-set"><legend>True of this task</legend>
          ${GATES.map(([k, label, why]) => `
            <label class="wk-check"><input type="checkbox" data-flag="${k}">
              <span><strong>${label}</strong><small>${why}</small></span></label>`).join('')}
        </fieldset>
        <fieldset class="wk-set wk-never"><legend>Also true — these refuse the job</legend>
          ${NEVERS.map(([k, label, why]) => `
            <label class="wk-check"><input type="checkbox" data-flag="${k}">
              <span><strong>${label}</strong><small>${why}</small></span></label>`).join('')}
        </fieldset>
      </div>
      <div class="wk-actions">
        <button class="btn primary" id="wkSend">Queue it</button>
        <button class="btn" id="wkRun">Run queued now</button>
        <span id="wkSaid" class="wk-note"></span>
      </div>
    </section>

    <section class="card" id="wkList"><p class="empty-hint">Reading the queue…</p></section>
  </div>`;

function itemHtml(i) {
  const [label, hint] = STATUS[i.status] || [i.status, ''];
  const timing = i.ms ? `${(i.ms / 1000).toFixed(1)}s${i.tokens ? ` · ${i.tokens} tokens` : ''}` : '';
  return `
    <li class="wk-item wk-${i.status}">
      <div class="wk-head">
        <span class="wk-title">${esc(i.title)}</span>
        <span class="wk-status">${label}</span>
      </div>
      <p class="wk-meta">${esc(i.tier)}${i.model ? ` · ${esc(i.model)}` : ''}${timing ? ` · ${timing}` : ''}
        · ${esc(i.created_at)}</p>
      ${hint ? `<p class="wk-hint">${hint}</p>` : ''}
      ${i.router_reason ? `<p class="wk-hint">${esc(i.router_reason)}</p>` : ''}
      ${i.error ? `<p class="wk-err">${esc(i.error)}</p>` : ''}
      ${i.result ? `<pre class="wk-result">${esc(i.result)}</pre>` : ''}
      ${['queued', 'running', 'waiting_session'].includes(i.status)
        ? `<button class="btn wk-cancel" data-id="${i.id}">Cancel</button>` : ''}
    </li>`;
}

async function load() {
  if (!root) return;
  const token = ++loadToken;
  let d;
  try {
    const r = await fetch('/api/work/items', { headers: { 'X-MC-By': 'you' } });
    d = await r.json();
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
  } catch (err) {
    if (!root || token !== loadToken) return;
    root.querySelector('#wkList').innerHTML =
      `<p class="empty-hint failure-hint">Could not read the queue: ${esc(err.message)}<br>`
      + '<small>That is a failure to look, not an empty queue.</small></p>';
    return;
  }
  if (!root || token !== loadToken) return;

  const list = root.querySelector('#wkList');
  if (!d.items.length) {
    list.innerHTML = '<h2 class="wk-h2">The queue</h2>'
      + '<p class="empty-hint">Nothing handed over yet.</p>';
    return;
  }
  list.innerHTML = `<h2 class="wk-h2">The queue</h2>
    <p class="wk-note">${esc(d.note)} ${esc(d.frontierNote)}</p>
    <ul class="wk-list">${d.items.map(itemHtml).join('')}</ul>`;
}

function flags() {
  const out = {};
  root.querySelectorAll('[data-flag]').forEach((el) => { out[el.dataset.flag] = el.checked; });
  return out;
}

function say(msg) { if (root) root.querySelector('#wkSaid').textContent = msg; }

async function onClick(ev) {
  if (!root) return;
  const send = ev.target.closest('#wkSend');
  const run = ev.target.closest('#wkRun');
  const cancel = ev.target.closest('.wk-cancel');

  if (send) {
    const prompt = root.querySelector('#wkPrompt').value.trim();
    if (!prompt) return say('A prompt is required.');
    say('queueing…');
    const r = await fetch('/api/work/items', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-MC-By': 'you' },
      body: JSON.stringify({ prompt, flags: flags() }),
    });
    const b = await r.json();
    if (!root) return;
    // The tier is reported back immediately, including when it is a refusal, so the routing
    // decision is visible at the moment it is made rather than discovered in the list.
    say(r.ok ? `routed to ${b.tier}` : `refused: ${b.error || r.status}`);
    if (r.ok) root.querySelector('#wkPrompt').value = '';
    load();
  }

  if (run) {
    say('running…');
    const r = await fetch('/api/work/run', {
      method: 'POST', headers: { 'content-type': 'application/json', 'X-MC-By': 'you' },
      body: JSON.stringify({ limit: 5 }),
    });
    const b = await r.json();
    if (!root) return;
    say(b.unreachable
      ? 'Ollama is not running, so nothing ran. The jobs are still queued, not failed.'
      : `${b.done} done, ${b.failed} failed of ${b.attempted}`);
    load();
  }

  if (cancel) {
    await fetch(`/api/work/items/${cancel.dataset.id}/cancel`, {
      method: 'POST', headers: { 'X-MC-By': 'you' },
    });
    if (!root) return;
    load();
  }
}

export default {
  mount(el) {
    root = el;
    el.innerHTML = TEMPLATE;
    el.addEventListener('click', onClick);
    load();
    // A queue you have to refresh by hand is a queue you stop watching. Cleared in unmount,
    // or it keeps firing against a dead DOM.
    timer = setInterval(load, 8000);
  },
  unmount() {
    loadToken++;
    if (timer) clearInterval(timer);
    timer = null;
    root = null;
  },
};

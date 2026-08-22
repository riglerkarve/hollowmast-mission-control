//
// digest — a plain-language version of the team report, for the owner.
//
// The full shift report (/api/team/report) is written for the supervisor.  This
// panel renders the simplified /api/digest view: one summary sentence, the top
// few events with agent badges, who is working right now, and anything that
// looks like a gap or risk.  A "Read aloud" button formats the digest as text
// and sends it to /api/voice/tts, the same pattern as the briefing panel.
//
// NOTHING HERE DERIVES GAPS OF ITS OWN — it renders what the digest route
// returns.  A panel that recomputed "what the process missed" would agree with
// the report until one of them was edited, and then disagree without either
// erroring, which is the failure the team route was written to prevent.
let root = null;
let loadToken = 0;
let audioEl = null;

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

// Relative time: "2h ago", "just now", "3d ago".  Falls back to the raw stamp.
function relTime(iso) {
  if (!iso) return '';
  const then = new Date(String(iso).replace(' ', 'T'));
  if (isNaN(then)) return String(iso).slice(0, 16);
  const diff = Date.now() - then.getTime();
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

function highlightItem(h) {
  return `<li class="dg-hi">
    <span class="dg-badge">${esc(h.who || '?')}</span>
    <span class="dg-hi-text">${esc(h.text)}</span>
    <span class="dg-when">${esc(relTime(h.when))}</span>
  </li>`;
}

function workingItem(w) {
  const dot = w.status === 'active' ? 'dg-dot-active' : 'dg-dot-quiet';
  return `<span class="dg-work ${dot}">
    <span class="dg-work-agent">${esc(w.agent)}</span>
    <span class="dg-work-sep">—</span>
    <span class="dg-work-task">${esc(w.task)}</span>
  </span>`;
}

function concernItem(c) {
  const sev = c.severity === 'severe' ? ' dg-concern-severe' : '';
  return `<li class="dg-concern${sev}">
    <span class="dg-concern-mark" aria-hidden="true">${c.severity === 'severe' ? '!' : '•'}</span>
    <span class="dg-concern-text">${esc(c.text)}</span>
  </li>`;
}

function render(data) {
  if (!root) return;
  const d = data || {};
  const highlights = (d.highlights || []);
  const working = (d.working || []);
  const concerns = (d.concerns || []);

  const hiBody = highlights.length
    ? `<ul class="dg-list">${highlights.map(highlightItem).join('')}</ul>`
    : `<p class="dg-empty">No events filed this shift yet.</p>`;

  const workBody = working.length
    ? `<div class="dg-work-row">${working.map(workingItem).join('')}</div>`
    : `<p class="dg-empty">No agents are reporting right now.</p>`;

  const concernBody = concerns.length
    ? `<ul class="dg-list">${concerns.map(concernItem).join('')}</ul>`
    : `<p class="dg-empty">Nothing flagged — the shift looks clean.</p>`;

  root.innerHTML = `
    <div class="panel">
      <div class="panel-header">
        <h1 class="dg-summary">${esc(d.summary || 'No summary available.')}</h1>
        <button class="btn dg-read-aloud" id="dgReadAloud">Read aloud</button>
      </div>

      ${d.note ? `<p class="dg-note">${esc(d.note)}</p>` : ''}

      <section class="card dg-card">
        <h2>Highlights</h2>
        ${hiBody}
      </section>

      <section class="card dg-card">
        <h2>Working now</h2>
        ${workBody}
      </section>

      <section class="card dg-card dg-concerns-card">
        <h2>Concerns</h2>
        ${concernBody}
      </section>

      <audio class="dg-audio" id="dgAudio"></audio>
    </div>`;

  audioEl = root.querySelector('#dgAudio');
  const btn = root.querySelector('#dgReadAloud');
  if (btn) btn.addEventListener('click', readAloud);
}

async function load() {
  if (!root) return;
  const token = loadToken;
  try {
    const r = await fetch('/api/digest');
    if (!root || token !== loadToken) return;
    if (!r.ok) {
      root.innerHTML = `<div class="panel"><div class="panel-header"><h1 class="dg-summary">Digest unavailable</h1></div>
        <p class="failure-hint">Could not load the digest (HTTP ${r.status}). This is a failure to look, not an empty shift.</p></div>`;
      return;
    }
    const data = await r.json();
    if (!root || token !== loadToken) return;
    render(data);
  } catch (e) {
    if (!root || token !== loadToken) return;
    root.innerHTML = `<div class="panel"><div class="panel-header"><h1 class="dg-summary">Digest unavailable</h1></div>
      <p class="failure-hint">Could not reach the server: ${esc(e.message)}.</p></div>`;
  }
}

// Format the digest as plain text for TTS.  The route is the source of truth;
// we fetch it fresh rather than reading the rendered DOM, so the spoken version
// always matches the API shape rather than whatever the panel happened to show.
function digestToText(d) {
  const lines = [];
  lines.push('Team digest.');
  lines.push('');
  if (d.summary) { lines.push(d.summary); lines.push(''); }

  if (d.highlights && d.highlights.length) {
    lines.push('Highlights:');
    for (const h of d.highlights) lines.push(`  ${h.who || 'a session'}: ${h.text}`);
    lines.push('');
  }

  if (d.working && d.working.length) {
    lines.push('Working now:');
    for (const w of d.working) lines.push(`  ${w.agent} is ${w.status === 'active' ? 'working on' : 'not reporting —'} ${w.task}`);
    lines.push('');
  }

  if (d.concerns && d.concerns.length) {
    lines.push('Concerns:');
    for (const c of d.concerns) lines.push(`  ${c.severity === 'severe' ? '[needs attention] ' : ''}${c.text}`);
  } else {
    lines.push('Concerns: none — the shift looks clean.');
  }

  return lines.join('\n');
}

async function readAloud() {
  if (!root) return;
  const btn = root.querySelector('#dgReadAloud');
  if (btn) { btn.disabled = true; btn.textContent = 'Reading…'; }
  try {
    const r = await fetch('/api/digest');
    if (!r.ok) { if (btn) { btn.disabled = false; btn.textContent = 'Read aloud'; } return; }
    const d = await r.json();
    const text = digestToText(d);
    const ttsRes = await fetch('/api/voice/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!ttsRes.ok) { if (btn) { btn.disabled = false; btn.textContent = 'Read aloud'; } return; }
    const blob = await ttsRes.blob();
    const url = URL.createObjectURL(blob);
    if (audioEl) { audioEl.src = url; audioEl.play().catch(() => {}); }
  } catch {
    // Silent — the button label resets below.
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Read aloud'; }
  }
}

export default {
  mount(el, opts) {
    root = el;
    loadToken++;
    load();
  },
  unmount() {
    loadToken++;
    root = null;
    audioEl = null;
  },
};
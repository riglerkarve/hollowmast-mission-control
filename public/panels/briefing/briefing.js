//
// briefing — the morning briefing panel.
//
// Three cards: NEEDS YOU, HAPPENED, MOVED. Each is a section of the morning briefing
// from /api/briefing/morning. A "Read aloud" button fetches /api/briefing/text and
// sends it to /api/voice/tts, then plays the audio.
//
// ABSENCE AND FAILURE MUST NOT LOOK THE SAME. An empty section shows a quiet "Nothing
// needs you." message; a failed data source shows a warning line with the reason. The
// API returns a `failed` array alongside the three sections, and every failure is
// rendered distinctly from absence.
let root = null;
let loadToken = 0;
let audioEl = null;

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

// Relative time: "2h ago", "just now", "3d ago". Falls back to the raw timestamp.
function relTime(iso) {
  if (!iso) return '';
  const then = new Date(iso.replace(' ', 'T'));
  if (isNaN(then)) return String(iso).slice(0, 16);
  const diff = Date.now() - then.getTime();
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

function needsYouItem(item) {
  const p1 = item.urgency === 'P1';
  const word = p1 ? 'Urgent' : 'Normal';
  return `<li class="bf-item${p1 ? ' bf-p1' : ''}">
    <span class="bf-urgency ${p1 ? 'bf-p1-badge' : 'bf-p2-badge'}">${esc(word)}</span>
    <span class="bf-text">${esc(item.text)}</span>
    <span class="bf-source">${esc(item.source)}</span>
  </li>`;
}

function happenedItem(item) {
  return `<li class="bf-item">
    <span class="bf-who">${esc(item.who || '?')}</span>
    <span class="bf-text">${esc(item.text)}</span>
    <span class="bf-when">${esc(relTime(item.when))}</span>
  </li>`;
}

function movedItem(item) {
  return `<li class="bf-item">
    <span class="bf-text">${esc(item.text)}</span>
    <span class="bf-transition">${esc(item.from || '?')} &rarr; ${esc(item.to || '?')}</span>
    <span class="bf-when">${esc(relTime(item.when))}</span>
  </li>`;
}

function sectionCard(title, items, renderFn, emptyMsg) {
  const body = items.length
    ? `<ul class="bf-list">${items.map(renderFn).join('')}</ul>`
    : `<p class="bf-empty">${esc(emptyMsg)}</p>`;
  return `<section class="card bf-card">
    <h2>${esc(title)}</h2>
    ${body}
  </section>`;
}

function failureNote(failed) {
  if (!failed || !failed.length) return '';
  const lines = failed.map((f) =>
    `<li class="bf-fail-item"><span class="bf-fail-src">${esc(f.source)}</span> ${esc(f.reason)}</li>`
  ).join('');
  return `<section class="card bf-card bf-fail-card">
    <h2>Sources that could not be read</h2>
    <ul class="bf-fail-list">${lines}</ul>
  </section>`;
}

function render(data) {
  if (!root) return;
  const d = data || {};
  root.innerHTML = `
    <div class="panel">
      <div class="panel-header">
        <h1>Morning Briefing</h1>
        <button class="btn bf-read-aloud" id="bfReadAloud">Read aloud</button>
      </div>

      ${sectionCard('Needs you', d.needsYou || [], needsYouItem, 'Nothing needs you.')}
      ${sectionCard('Happened', d.happened || [], happenedItem, 'Quiet since last briefing.')}
      ${sectionCard('Moved', d.moved || [], movedItem, 'Nothing moved.')}
      ${failureNote(d.failed || [])}

      <audio class="bf-audio" id="bfAudio"></audio>
    </div>`;

  audioEl = root.querySelector('#bfAudio');
  const btn = root.querySelector('#bfReadAloud');
  if (btn) btn.addEventListener('click', readAloud);
}

async function load() {
  if (!root) return;
  const token = loadToken;
  try {
    const r = await fetch('/api/briefing/morning');
    if (!root || token !== loadToken) return;
    if (!r.ok) {
      root.innerHTML = `<div class="panel"><div class="panel-header"><h1>Morning Briefing</h1></div>
        <p class="failure-hint">Could not load the briefing (HTTP ${r.status}). This is a failure to look, not an empty briefing.</p></div>`;
      return;
    }
    const data = await r.json();
    if (!root || token !== loadToken) return;
    render(data);
  } catch (e) {
    if (!root || token !== loadToken) return;
    root.innerHTML = `<div class="panel"><div class="panel-header"><h1>Morning Briefing</h1></div>
      <p class="failure-hint">Could not reach the server: ${esc(e.message)}.</p></div>`;
  }
}

async function readAloud() {
  if (!root) return;
  const btn = root.querySelector('#bfReadAloud');
  if (btn) { btn.disabled = true; btn.textContent = 'Reading…'; }
  try {
    // Fetch the plain-text version of the briefing.
    const textRes = await fetch('/api/briefing/text');
    if (!textRes.ok) {
      if (btn) { btn.disabled = false; btn.textContent = 'Read aloud'; }
      return;
    }
    const text = await textRes.text();
    // Send to TTS.
    const ttsRes = await fetch('/api/voice/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!ttsRes.ok) {
      if (btn) { btn.disabled = false; btn.textContent = 'Read aloud'; }
      return;
    }
    const blob = await ttsRes.blob();
    const url = URL.createObjectURL(blob);
    if (audioEl) {
      audioEl.src = url;
      audioEl.play().catch(() => {});
    }
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

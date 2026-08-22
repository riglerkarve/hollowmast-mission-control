// journal — voice journal: speak a reflection, it transcribes and stores.
//
// Private, local, searchable. Uses the existing /api/voice/stt for
// transcription and /api/journal for storage. No data leaves the machine.
let root = null;
let loadToken = 0;
let recorder = null, chunks = [], recording = false, stream = null;

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const TEMPLATE = `
  <div class="panel">
    <div class="panel-header"><h1>Journal</h1></div>

    <section class="card jr-card">
      <h2 class="jr-h2">Speak or write</h2>
      <div class="jr-input-row">
        <textarea class="jr-text" id="jrText" placeholder="What's on your mind?" rows="3"></textarea>
      </div>
      <div class="jr-controls">
        <button class="jr-mic" id="jrMic" aria-label="Record">
          <svg viewBox="0 0 24 24" class="jr-mic-icon" aria-hidden="true">
            <path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/>
            <path d="M19 11a7 7 0 0 1-14 0M12 18v4M8 22h8" fill="none"
              stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          </svg>
          <span class="jr-mic-label" id="jrMicLabel">Speak</span>
        </button>
        <input class="jr-mood" id="jrMood" placeholder="mood (optional)" maxlength="20">
        <button class="btn primary" id="jrSave">Save</button>
      </div>
      <div class="jr-status" id="jrStatus"></div>
    </section>

    <section class="card jr-card">
      <h2 class="jr-h2">Entries</h2>
      <div class="jr-search-row">
        <input class="jr-search" id="jrSearch" placeholder="Search entries...">
      </div>
      <div id="jrEntries"></div>
    </section>

    <section class="card jr-card">
      <h2 class="jr-h2">Stats</h2>
      <div id="jrStats"></div>
    </section>
  </div>`;

async function loadEntries(q) {
  if (!root) return;
  const el = root.querySelector('#jrEntries');
  if (!el) return;
  const url = q ? `/api/journal/entries?q=${encodeURIComponent(q)}&limit=30` : '/api/journal/entries?limit=30';
  try {
    const r = await fetch(url);
    if (!r.ok) { el.innerHTML = '<p class="jr-err">Could not load.</p>'; return; }
    const d = await r.json();
    if (!root) return;
    const entries = d.entries || [];
    el.innerHTML = entries.length
      ? entries.map((e) => `
        <div class="jr-entry" data-id="${e.id}">
          <p class="jr-entry-text">${esc(e.text)}</p>
          <div class="jr-entry-meta">
            ${(e.tags || []).map((t) => `<span class="jr-tag">${esc(t)}</span>`).join('')}
            ${e.mood ? `<span class="jr-mood-tag">${esc(e.mood)}</span>` : ''}
            <span class="jr-date">${esc(String(e.created_at || '').slice(0, 16))}</span>
            <button class="jr-del" data-id="${e.id}">Delete</button>
            <button class="jr-read" data-id="${e.id}">Read</button>
          </div>
        </div>`).join('')
      : '<p class="jr-empty">No entries yet. Speak or write one above.</p>';
  } catch {
    el.innerHTML = '<p class="jr-err">Could not reach server.</p>';
  }
}

async function loadStats() {
  if (!root) return;
  const el = root.querySelector('#jrStats');
  if (!el) return;
  try {
    const r = await fetch('/api/journal/stats');
    if (!r.ok) return;
    const d = await r.json();
    if (!root) return;
    const tags = Object.entries(d.tags || {}).sort((a, b) => b[1] - a[1]);
    el.innerHTML = `
      <div class="jr-stat-row">
        <span class="jr-stat-num">${d.total}</span> total entries ·
        <span class="jr-stat-num">${d.thisWeek}</span> this week
      </div>
      ${tags.length ? '<div class="jr-tag-cloud">' + tags.map(([t, n]) =>
        `<span class="jr-tag-stat">${esc(t)} <b>${n}</b></span>`).join('') + '</div>' : ''}`;
  } catch {}
}

async function save() {
  if (!root) return;
  const text = root.querySelector('#jrText').value.trim();
  const mood = root.querySelector('#jrMood').value.trim();
  if (!text) return;
  const status = root.querySelector('#jrStatus');
  if (status) status.textContent = 'Saving...';
  try {
    const r = await fetch('/api/journal/entries', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, mood, source: recording ? 'voice' : 'text' }),
    });
    if (!r.ok) { if (status) status.textContent = 'Failed to save.'; return; }
    root.querySelector('#jrText').value = '';
    root.querySelector('#jrMood').value = '';
    if (status) status.textContent = 'Saved.';
    loadEntries();
    loadStats();
  } catch {
    if (status) status.textContent = 'Could not reach server.';
  }
}

async function startRec() {
  if (recording) return;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch { root.querySelector('#jrStatus').textContent = 'Microphone unavailable.'; return; }
  chunks = [];
  recorder = new MediaRecorder(stream);
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  recorder.onstop = transcribe;
  recorder.start();
  recording = true;
  const btn = root.querySelector('#jrMic');
  btn.classList.add('recording');
  root.querySelector('#jrMicLabel').textContent = 'Stop';
}

function stopRec() {
  if (!recording) return;
  recorder.stop();
  stream.getTracks().forEach((t) => t.stop());
  recording = false;
  root.querySelector('#jrMic').classList.remove('recording');
  root.querySelector('#jrMicLabel').textContent = 'Speak';
}

async function transcribe() {
  if (!chunks.length) return;
  const status = root.querySelector('#jrStatus');
  if (status) status.textContent = 'Transcribing...';
  const blob = new Blob(chunks, { type: 'audio/webm' });
  try {
    const r = await fetch('/api/voice/stt', { method: 'POST',
      headers: { 'Content-Type': 'audio/webm' }, body: blob });
    if (!r.ok) { if (status) status.textContent = 'Transcription failed.'; return; }
    const d = await r.json();
    const text = (d.text || '').trim();
    if (!text) { if (status) status.textContent = 'No speech detected.'; return; }
    // Append to the text area so the user can edit before saving
    const ta = root.querySelector('#jrText');
    ta.value = ta.value ? ta.value + ' ' + text : text;
    if (status) status.textContent = 'Transcribed — review and save.';
  } catch {
    if (status) status.textContent = 'Could not transcribe.';
  }
}

async function readAloud(id) {
  try {
    const r = await fetch(`/api/journal/entries/${id}`);
    if (!r.ok) return;
    const d = await r.json();
    const tts = await fetch('/api/voice/tts', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: d.text }),
    });
    if (!tts.ok) return;
    const blob = await tts.blob();
    const audio = root.querySelector('audio') || (() => {
      const a = document.createElement('audio'); root.appendChild(a); return a;
    })();
    audio.src = URL.createObjectURL(blob);
    audio.play().catch(() => {});
  } catch {}
}

export default {
  mount(el) {
    root = el;
    loadToken++;
    el.innerHTML = TEMPLATE;

    el.querySelector('#jrSave').addEventListener('click', save);
    el.querySelector('#jrMic').addEventListener('click', () => {
      if (!recording) startRec(); else stopRec();
    });
    el.querySelector('#jrSearch').addEventListener('input', (ev) => {
      loadEntries(ev.target.value.trim());
    });

    el.addEventListener('click', (ev) => {
      const del = ev.target.closest('.jr-del');
      if (del) {
        fetch(`/api/journal/entries/${del.dataset.id}`, { method: 'DELETE' })
          .then(() => { loadEntries(); loadStats(); });
        return;
      }
      const read = ev.target.closest('.jr-read');
      if (read) { readAloud(Number(read.dataset.id)); return; }
    });

    loadEntries();
    loadStats();
  },
  unmount() {
    if (recording) stopRec();
    loadToken++;
    root = null;
  },
};
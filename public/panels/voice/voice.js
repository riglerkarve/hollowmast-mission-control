//
// voice — click to talk, and talk back.
//
// Two features in one panel:
//   1. Click-to-talk: hold or click the mic button, speak, release — your audio
//      goes to /api/voice/stt, the transcript appears, and you can send it as
//      a message to Hermes.
//   2. Talk-back: when on, any text in the response area is automatically
//      spoken via /api/voice/tts. Toggle on/off; persists for the page session.
//
// Recording uses the Web Audio API (MediaRecorder). Playback uses a plain
// <audio> element. No external libraries, no WebSocket, no streaming — just
// fetch and blobs. The same approach as the exercise panel: one fetch, one
// render, no client-side state machine beyond a recording flag.
let root = null;
let loadToken = 0;

// --- recording state ----------------------------------------------------
let mediaRecorder = null;
let audioChunks = [];
let isRecording = false;
let recStream = null;

// --- talk-back state ----------------------------------------------------
let talkBackOn = false;
let lastSpoken = '';

// --- elements -----------------------------------------------------------
let micBtn = null;
let transcriptEl = null;
let responseEl = null;
let sendBtn = null;
let talkToggle = null;
let statusEl = null;
let voiceNameEl = null;
let audioPlayer = null;

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const TEMPLATE = `
  <div class="panel">
    <div class="panel-header"><h1>Voice</h1></div>

    <section class="card vc-card">
      <h2 class="vc-h2">Click to talk</h2>
      <p class="vc-lede">Hold the button and speak. Release to transcribe.</p>
      <div class="vc-mic-row">
        <button class="vc-mic" id="vcMic" aria-label="Record">
          <svg class="vc-mic-icon" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/>
            <path d="M19 11a7 7 0 0 1-14 0M12 18v4M8 22h8" fill="none"
              stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          </svg>
          <span class="vc-mic-label">Hold to talk</span>
        </button>
      </div>
      <div class="vc-transcript" id="vcTranscript"></div>
      <div class="vc-send-row">
        <button class="btn primary" id="vcSend" disabled>Run command</button>
      </div>
    </section>

    <section class="card vc-card">
      <h2 class="vc-h2">Talk back</h2>
      <div class="vc-toggle-row">
        <label class="vc-switch">
          <input type="checkbox" id="vcTalk">
          <span class="vc-slider"></span>
        </label>
        <span class="vc-toggle-label" id="vcTalkLabel">Off — responses are text only</span>
      </div>
      <div class="vc-response" id="vcResponse"></div>
      <div class="vc-replay-row">
        <button class="btn vc-replay" id="vcReplay" disabled>Replay last</button>
      </div>
    </section>

    <section class="card vc-card">
      <h2 class="vc-h2">Quick actions</h2>
      <div class="vc-quick">
        <button class="vc-qa" data-cmd="morning">Briefing</button>
        <button class="vc-qa" data-cmd="today">Today</button>
        <button class="vc-qa" data-cmd="stuck">Stuck</button>
        <button class="vc-qa" data-cmd="who">Who's working</button>
        <button class="vc-qa" data-cmd="go">Start focus</button>
        <button class="vc-qa" data-cmd="inbox">Inbox</button>
      </div>
    </section>

    <section class="card vc-card">
      <h2 class="vc-h2">Status</h2>
      <div class="vc-status" id="vcStatus"></div>
    </section>

    <audio id="vcAudio" class="vc-audio"></audio>
  </div>`;

async function loadStatus() {
  if (!root) return;
  try {
    const r = await fetch('/api/voice/status');
    if (!r.ok) return;
    const d = await r.json();
    if (!statusEl) return;
    statusEl.innerHTML = `<div class="vc-stat">
      <span class="vc-stat-key">Voice</span>
      <span class="vc-stat-val">${esc(d.tts.voice)}</span>
    </div><div class="vc-stat">
      <span class="vc-stat-key">TTS</span>
      <span class="vc-stat-val">${esc(d.tts.provider)}</span>
    </div><div class="vc-stat">
      <span class="vc-stat-key">STT</span>
      <span class="vc-stat-val">${d.stt.enabled ? esc(d.stt.provider) : 'disabled'}</span>
    </div>`;
  } catch {
    // Absence and failure look different: say what happened.
    if (statusEl) statusEl.innerHTML = '<p class="vc-err">Could not reach /api/voice/status — the voice route may not be mounted.</p>';
  }
}

// --- recording ----------------------------------------------------------
async function startRecording() {
  if (isRecording) return;
  try {
    recStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    if (transcriptEl) transcriptEl.innerHTML = '<p class="vc-err">Microphone access denied or unavailable.</p>';
    return;
  }
  audioChunks = [];
  // webm/opus is what Chrome produces; the server accepts it.
  mediaRecorder = new MediaRecorder(recStream);
  mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunks.push(e.data); };
  mediaRecorder.onstop = () => { sendForTranscription(); };
  mediaRecorder.start();
  isRecording = true;
  if (micBtn) micBtn.classList.add('vc-recording');
  if (micBtn) micBtn.querySelector('.vc-mic-label').textContent = 'Release to send';
}

function stopRecording() {
  if (!isRecording || !mediaRecorder) return;
  mediaRecorder.stop();
  if (recStream) recStream.getTracks().forEach((t) => t.stop());
  isRecording = false;
  if (micBtn) micBtn.classList.remove('vc-recording');
  if (micBtn) micBtn.querySelector('.vc-mic-label').textContent = 'Hold to talk';
}

async function sendForTranscription() {
  if (!root) return;
  if (!audioChunks.length) return;
  const blob = new Blob(audioChunks, { type: 'audio/webm' });
  if (transcriptEl) transcriptEl.innerHTML = '<p class="vc-thinking">Transcribing...</p>';

  try {
    const r = await fetch('/api/voice/stt', {
      method: 'POST',
      headers: { 'Content-Type': 'audio/webm' },
      body: blob,
    });
    if (!root) return;
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      transcriptEl.innerHTML = `<p class="vc-err">Transcription failed: ${esc(e.error || r.status)}</p>`;
      return;
    }
    const d = await r.json();
    const text = (d.text || '').trim();
    if (!text) {
      transcriptEl.innerHTML = '<p class="vc-err">No speech detected.</p>';
      return;
    }
    transcriptEl.innerHTML = `<p class="vc-said">${esc(text)}</p>`;
    if (sendBtn) sendBtn.disabled = false;
    // Auto-execute the command immediately after transcription.
    // The voice loop: speak -> transcribe -> classify -> act.
    executeCommand(text);
  } catch (err) {
    if (transcriptEl) transcriptEl.innerHTML = `<p class="vc-err">Could not reach the server: ${esc(err.message)}</p>`;
  }
}

// --- TTS / talk-back ----------------------------------------------------
async function speak(text) {
  if (!text || !text.trim()) return;
  // Don't repeat the same utterance twice in a row (click-to-talk echo).
  if (text === lastSpoken) return;
  lastSpoken = text;
  try {
    const r = await fetch('/api/voice/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!r.ok) return;
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    if (audioPlayer) {
      audioPlayer.src = url;
      audioPlayer.play().catch(() => {});
    }
    if (talkBackOn && root) {
      const replay = root.querySelector('#vcReplay');
      if (replay) replay.disabled = false;
    }
  } catch {
    // Silent — the panel shows the text regardless.
  }
}

function onTalkToggle() {
  talkBackOn = !!(talkToggle && talkToggle.checked);
  if (talkBackOn) {
    if (talkToggle.parentElement) talkToggle.parentElement.classList.add('on');
    if (statusEl) {}
    const label = root.querySelector('#vcTalkLabel');
    if (label) label.textContent = 'On — responses are spoken aloud';
  } else {
    if (talkToggle && talkToggle.parentElement) talkToggle.parentElement.classList.remove('on');
    const label = root.querySelector('#vcTalkLabel');
    if (label) label.textContent = 'Off — responses are text only';
  }
}

// --- command execution (the voice loop) --------------------------------
// After transcription, the text is sent to /api/voice/command which classifies
// intent (via Ollama or voice shortcuts). The result is executed:
//   NAVIGATE -> switch to that panel
//   QUERY/BRIEFING/STATUS -> fetch the API, format result, show + speak
//   ACT -> call the action endpoint
//   UNKNOWN -> show the text, speak it if talk-back is on
async function executeCommand(text) {
  if (!root) return;
  if (responseEl) responseEl.innerHTML = '<p class="vc-thinking">Interpreting...</p>';

  let cmd;
  try {
    const r = await fetch('/api/voice/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!root) return;
    if (!r.ok) {
      if (responseEl) responseEl.innerHTML = `<p class="vc-err">Command failed: ${r.status}</p>`;
      return;
    }
    const d = await r.json();
    cmd = d.action || d;
  } catch (err) {
    if (responseEl) responseEl.innerHTML = `<p class="vc-err">Could not classify: ${esc(err.message)}</p>`;
    return;
  }
  if (!root) return;

  const intent = cmd.intent;

  // NAVIGATE — switch to the named panel
  if (intent === 'navigate' && cmd.panel) {
    // The shell.js listens for hash changes? No — it uses click handlers.
    // So we click the nav button with the matching data-panel.
    const navBtn = document.querySelector(`[data-panel="${cmd.panel}"]`);
    if (navBtn) {
      window.location.hash = cmd.panel;
      navBtn.click();
      if (responseEl) responseEl.innerHTML = `<p class="vc-sent">Opening ${esc(cmd.panel)}...</p>`;
      if (talkBackOn) speak(`Opening ${cmd.panel}.`);
    } else {
      // command.js only ever returns a panel this page can mount -- reaching here means
      // the nav changed underneath it, so say that rather than confirming a navigation
      // that did not happen (and rather than setting the URL hash to a panel not shown).
      if (responseEl) responseEl.innerHTML = `<p class="vc-err">No ${esc(cmd.panel)} panel to open.</p>`;
      if (talkBackOn) speak(`I don't have a ${cmd.panel} panel to open.`);
    }
    return;
  }

  // QUERY / BRIEFING / STATUS — fetch the API and show/speak the result
  if ((intent === 'query' || intent === 'briefing' || intent === 'status') && cmd.api) {
    if (responseEl) responseEl.innerHTML = '<p class="vc-thinking">Fetching...</p>';
    try {
      const r = await fetch(cmd.api);
      if (!root) return;
      if (!r.ok) {
        if (responseEl) responseEl.innerHTML = `<p class="vc-err">API returned ${r.status}</p>`;
        return;
      }
      const data = await r.json();
      // Format the response as speech-friendly text
      const spoken = formatForSpeech(data, cmd.api);
      if (responseEl) responseEl.innerHTML = `<p class="vc-result">${esc(spoken)}</p>`;
      if (talkBackOn || cmd.speak) speak(spoken);
    } catch (err) {
      if (responseEl) responseEl.innerHTML = `<p class="vc-err">Fetch failed: ${esc(err.message)}</p>`;
    }
    return;
  }

  // ACT — call an action
  if (intent === 'act' && cmd.action) {
    if (responseEl) responseEl.innerHTML = `<p class="vc-sent">Action: ${esc(cmd.action)}</p>`;
    // For start_focus, we navigate to focus and could trigger start.
    // For now, navigate to the focus panel.
    if (cmd.action === 'start_focus') {
      const navBtn = document.querySelector('[data-panel="focus"]');
      if (navBtn) navBtn.click();
      if (talkBackOn) speak('Starting a focus session.');
    }
    return;
  }

  // UNKNOWN — show the text
  if (responseEl) responseEl.innerHTML = `<p class="vc-unknown">Not sure what you meant by "${esc(text)}"</p>`;
  if (talkBackOn) speak(`Sorry, I didn't understand: ${text}`);
}

// Format an API response as speech-friendly text.
// This is a simple formatter — it pulls the most relevant text from common
// response shapes. It does NOT send any data to a model; it just extracts
// readable text from the JSON.
function formatForSpeech(data, apiUrl) {
  if (!data) return 'No data returned.';

  // Briefing endpoint
  if (apiUrl.includes('/briefing/morning') || apiUrl.includes('/briefing/text')) {
    const needs = (data.needsYou || []).map((n) => n.text).join('. ');
    const happened = (data.happened || []).slice(0, 5).map((h) => `${h.who}: ${h.text}`).join('. ');
    const parts = [];
    if (needs) parts.push(`Needs you: ${needs}`);
    if (happened) parts.push(`Recently: ${happened}`);
    return parts.join('. ') || 'Nothing to report.';
  }

  // Creative spark
  if (apiUrl.includes('/creative/spark')) {
    return data.text ? `Here's a spark: ${data.text}` : 'No spark available.';
  }
  // Serendipity
  if (apiUrl.includes('/serendipity')) {
    const c = data.connection;
    if (!c) return 'No connection today.';
    return `Today's serendipity: ${c.text}`;
  }
  // Creative ideas
  if (apiUrl.includes('/creative/ideas')) {
    const items = data.ideas || [];
    if (!items.length) return 'No ideas captured yet.';
    return `${items.length} ideas. Most recent: ${items[0].text.slice(0, 80)}.`;
  }

  // Prioritize
  if (apiUrl.includes('/prioritize')) {
    const items = data.items || [];
    if (!items.length) return 'No open items to prioritize.';
    const top = items.slice(0, 5);
    const summary = top.map((i) => i.title.slice(0, 60)).join('. ');
    return `${items.length} open items. Top priority: ${summary}.`;
  }

  // Stale items
  if (apiUrl.includes('/stale')) {
    const items = data.items || [];
    if (!items.length) return 'No stale items. Everything has moved recently.';
    return `${items.length} items have been silent for ${data.threshold || 7} days or more.`;
  }

  // Active sessions
  if (apiUrl.includes('/sessions/active')) {
    const active = data.active || [];
    if (!active.length) return 'No agents are currently active.';
    return active.map((s) => `${s.actor} is working${s.todoTitle ? ' on ' + s.todoTitle : ''}`).join('. ') + '.';
  }

  // Activity stream
  if (apiUrl.includes('/activity')) {
    const items = data.items || [];
    if (!items.length) return 'No activity in the selected window.';
    return `${items.length} events in the last period. Most recent: ${items[0].what || items[0].what}.`;
  }

  // Board
  if (apiUrl.includes('/board')) {
    const counts = data.counts || {};
    return `${counts.externalOpen || 0} external open items, ${counts.backlogOpen || 0} backlog items.`;
  }

  // Agents
  if (apiUrl.includes('/agents')) {
    const agents = data.agents || [];
    return agents.map((a) => `${a.name}: ${a.status}`).join('. ') + '.';
  }

  // Inbox
  if (apiUrl.includes('/inbox')) {
    const msgs = data.messages || [];
    if (!msgs.length) return 'No messages.';
    return `${msgs.length} messages. Latest from ${msgs[msgs.length - 1].from}: ${msgs[msgs.length - 1].text}`;
  }

  // Fallback: stringify the first few keys
  try {
    const keys = Object.keys(data).slice(0, 3);
    return keys.map((k) => `${k}: ${JSON.stringify(data[k]).slice(0, 100)}`).join('. ');
  } catch {
    return 'Response received.';
  }
}

// --- send to Hermes (manual trigger, same as executeCommand) ------------

// --- event wiring -------------------------------------------------------
function onPointerDown(e) {
  if (e.target.closest && e.target.closest('#vcMic')) {
    e.preventDefault();
    startRecording();
  }
}

function onPointerUp() {
  if (isRecording) stopRecording();
}

function onClick(ev) {
  const t = ev.target;
  if (t.closest && t.closest('#vcTalk')) { onTalkToggle(); return; }
  if (t.closest && t.closest('#vcSend')) {
    // Manual trigger: re-run the command on the current transcript
    const said = root.querySelector('.vc-said');
    const text = said ? said.textContent : '';
    if (text) executeCommand(text);
    return;
  }
  if (t.closest && t.closest('#vcReplay')) {
    if (audioPlayer && audioPlayer.src) audioPlayer.play().catch(() => {});
    return;
  }
  // Quick action buttons — send the data-cmd as a voice command
  if (t.closest && t.closest('.vc-qa')) {
    const cmd = t.closest('.vc-qa').dataset.cmd;
    if (cmd) executeCommand(cmd);
    return;
  }
  // Click also toggles recording (for tap-to-start/tap-to-stop on mobile).
  if (t.closest && t.closest('#vcMic')) {
    if (!isRecording) startRecording();
    else stopRecording();
  }
}

export default {
  mount(el) {
    root = el;
    loadToken++;
    el.innerHTML = TEMPLATE;
    micBtn = el.querySelector('#vcMic');
    transcriptEl = el.querySelector('#vcTranscript');
    responseEl = el.querySelector('#vcResponse');
    sendBtn = el.querySelector('#vcSend');
    talkToggle = el.querySelector('#vcTalk');
    statusEl = el.querySelector('#vcStatus');
    voiceNameEl = null;
    audioPlayer = el.querySelector('#vcAudio');

    // Pointer events for hold-to-talk (works on mouse + touch).
    el.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointerup', onPointerUp);
    el.addEventListener('click', onClick);

    // Keyboard: Space on the mic button toggles recording.
    el.addEventListener('keydown', (ev) => {
      if (ev.key === ' ' && ev.target.closest && ev.target.closest('#vcMic')) {
        ev.preventDefault();
        if (!isRecording) startRecording();
        else stopRecording();
      }
    });

    loadStatus();
  },
  unmount() {
    loadToken++;
    if (isRecording) stopRecording();
    window.removeEventListener('pointerup', onPointerUp);
    root = null;
    micBtn = transcriptEl = responseEl = sendBtn = talkToggle = statusEl = audioPlayer = null;
  },
};
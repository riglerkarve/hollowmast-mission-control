//
// inbox — unified agent inbox: a chat-like thread view where you and the agents
// (Claude, Codex, Ollama, Hermes, Scribe) leave messages for each other.
//
// Your messages are right-aligned with the accent background; agent messages are
// left-aligned with the card background. Enter sends, Shift+Enter inserts a newline.
// Auto-refreshes every 15 seconds. 'Read aloud' formats recent messages and sends them
// to /api/voice/tts for playback.
//
// Agent badges are coloured by agent:
//   Claude=accent, Codex=blue, Ollama=green, Hermes=accent, Scribe=muted, you=ink
let root = null;
let refreshTimer = null;
let lastCount = 0;
let currentThread = 'general';
let threads = [];

const RECIPIENTS = [
  ['all', 'All'],
  ['claude', 'Claude'],
  ['codex', 'Codex'],
  ['ollama', 'Ollama'],
  ['hermes', 'Hermes'],
  ['scribe', 'Scribe'],
];

const AGENT_COLORS = {
  you: 'ink',
  claude: 'accent',
  codex: 'blue',
  ollama: 'green',
  hermes: 'accent',
  scribe: 'muted',
};

const AGENT_LABELS = {
  you: 'You',
  claude: 'Claude',
  codex: 'Codex',
  ollama: 'Ollama',
  hermes: 'Hermes',
  scribe: 'Scribe',
  all: 'All',
};

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const api = async (path, opts) => {
  const r = await fetch(`/api/inbox${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts && opts.headers) },
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error(e.error || `HTTP ${r.status}`);
  }
  return r.json();
};

// Relative time: '2m ago', '3h ago', 'just now', etc.
function relTime(iso) {
  if (!iso) return '';
  const then = new Date(iso.replace(' ', 'T'));
  const diff = Date.now() - then.getTime();
  if (diff < 0 || isNaN(diff)) return '';
  const s = Math.floor(diff / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

// Escape text for safe display, preserving line breaks.
function messageText(text) {
  return esc(text).replace(/\n/g, '<br>');
}

function badgeClass(from) {
  const c = AGENT_COLORS[from] || 'muted';
  return `ib-badge ib-badge-${c}`;
}

function badgeLabel(from, to) {
  const label = AGENT_LABELS[from] || from;
  if (to && to !== 'you' && to !== 'all') {
    return `${label} → ${AGENT_LABELS[to] || to}`;
  }
  return label;
}

function messagesHTML(messages) {
  if (!messages.length) {
    return '<p class="ib-empty">No messages yet. Say something below.</p>';
  }
  return messages.map((m) => {
    const isYou = m.from === 'you';
    const wrap = isYou ? 'ib-msg ib-msg-you' : 'ib-msg ib-msg-agent';
    return `<article class="${wrap}">
      <div class="ib-bubble">
        <div class="ib-msg-head">
          <span class="${badgeClass(m.from)}">${esc(badgeLabel(m.from, m.to))}</span>
          <span class="ib-time">${esc(relTime(m.createdAt))}</span>
        </div>
        <div class="ib-text">${messageText(m.text)}</div>
      </div>
    </article>`;
  }).join('');
}

function threadsHTML() {
  if (!threads.length) return '';
  return threads.map((t) => {
    const active = t.id === currentThread ? ' ib-thread-active' : '';
    const preview = t.lastMessage ? esc(t.lastMessage.slice(0, 50)) : '(empty)';
    return `<button class="ib-thread${active}" data-thread="${esc(t.id)}">
      <span class="ib-thread-name">${esc(t.id)}</span>
      <span class="ib-thread-meta">${t.count} · ${esc(relTime(t.lastAt))}</span>
      <span class="ib-thread-preview">${preview}</span>
    </button>`;
  }).join('');
}

function renderShell() {
  root.innerHTML = `
  <section class="panel ib-panel">
    <div class="panel-header">
      <h1>Inbox</h1>
      <button class="btn ib-read-aloud" id="ibReadAloud">Read aloud</button>
    </div>

    <div class="ib-layout">
      <aside class="ib-threads" id="ibThreads"></aside>
      <div class="ib-main">
        <div class="ib-thread-head" id="ibThreadHead">
          <span class="ib-thread-title">${esc(currentThread)}</span>
        </div>
        <div class="ib-messages" id="ibMessages"></div>
        <div class="ib-input-area">
          <div class="ib-input-row">
            <select class="ib-to" id="ibTo" aria-label="Recipient">
              ${RECIPIENTS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}
            </select>
            <textarea class="ib-input" id="ibInput" placeholder="Message…  (Enter to send, Shift+Enter for newline)" rows="1"></textarea>
            <button class="btn primary ib-send" id="ibSend">Send</button>
          </div>
        </div>
      </div>
    </div>
  </section>`;
}

function renderMessages(messages) {
  const el = root.querySelector('#ibMessages');
  if (!el) return;
  el.innerHTML = messagesHTML(messages);
  // Auto-scroll to bottom.
  el.scrollTop = el.scrollHeight;
}

function renderThreads() {
  const el = root.querySelector('#ibThreads');
  if (!el) return;
  el.innerHTML = threadsHTML();
  el.querySelectorAll('.ib-thread').forEach((b) => {
    b.addEventListener('click', () => {
      currentThread = b.dataset.thread || 'general';
      load();
    });
  });
}

async function load() {
  if (!root) return;
  try {
    // Load threads and messages in parallel.
    const [td, md] = await Promise.all([
      api('/threads'),
      api(`/thread?threadId=${encodeURIComponent(currentThread)}`),
    ]);
    threads = td.threads || [];
    renderThreads();
    const head = root.querySelector('#ibThreadHead');
    if (head) head.querySelector('.ib-thread-title').textContent = currentThread;
    renderMessages(md.messages || []);
    lastCount = (md.messages || []).length;
  } catch (err) {
    const el = root.querySelector('#ibMessages');
    if (el) el.innerHTML = `<p class="ib-error">Could not load inbox — ${esc(err.message)}</p>`;
  }
}

async function send() {
  if (!root) return;
  const input = root.querySelector('#ibInput');
  const toSel = root.querySelector('#ibTo');
  if (!input || !toSel) return;
  const text = input.value.trim();
  if (!text) return;
  const to = toSel.value;
  const sendBtn = root.querySelector('#ibSend');
  if (sendBtn) sendBtn.disabled = true;
  try {
    await api('/send', {
      method: 'POST',
      body: JSON.stringify({ to, text, threadId: currentThread }),
    });
    input.value = '';
    input.style.height = 'auto';
    await load();
  } catch (err) {
    const el = root.querySelector('#ibMessages');
    if (el) {
      const errDiv = document.createElement('p');
      errDiv.className = 'ib-error';
      errDiv.textContent = `Could not send — ${err.message}`;
      el.appendChild(errDiv);
    }
  } finally {
    if (sendBtn) sendBtn.disabled = false;
  }
}

// 'Read aloud' — fetch recent messages, format as text, send to /api/voice/tts.
async function readAloud() {
  if (!root) return;
  const btn = root.querySelector('#ibReadAloud');
  if (btn) { btn.disabled = true; btn.textContent = 'Reading…'; }
  try {
    const data = await api(`/thread?threadId=${encodeURIComponent(currentThread)}`);
    const msgs = data.messages || [];
    if (!msgs.length) {
      if (btn) { btn.disabled = false; btn.textContent = 'Read aloud'; }
      return;
    }
    // Take the last 10 messages and format as spoken text.
    const recent = msgs.slice(-10);
    const spoken = recent.map((m) => {
      const who = AGENT_LABELS[m.from] || m.from;
      return `${who} said: ${m.text}`;
    }).join('. ');
    const r = await fetch('/api/voice/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: spoken }),
    });
    if (r.ok) {
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.play().catch(() => {});
    }
  } catch {
    // Silent — the button resets either way.
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Read aloud'; }
  }
}

// Auto-resize the textarea as the user types.
function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}

function wire() {
  const input = root.querySelector('#ibInput');
  const sendBtn = root.querySelector('#ibSend');
  const readBtn = root.querySelector('#ibReadAloud');

  if (input) {
    input.addEventListener('input', () => autoResize(input));
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && !ev.shiftKey) {
        ev.preventDefault();
        send();
      }
    });
  }
  if (sendBtn) sendBtn.addEventListener('click', send);
  if (readBtn) readBtn.addEventListener('click', readAloud);
}

export default {
  mount(el, opts) {
    root = el;
    currentThread = (opts && opts.threadId) || 'general';
    renderShell();
    wire();
    load();
    // Auto-refresh every 15 seconds.
    refreshTimer = setInterval(load, 15000);
  },
  unmount() {
    if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
    root = null;
  },
};
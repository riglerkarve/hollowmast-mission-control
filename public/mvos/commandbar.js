// commandbar — the MindVirus OS command overlay.
//
// This is the "OS" layer. Instead of clicking through 25 panels, you press
// a key (or tap a button) and the command bar drops down from the top.
// Type or speak — it routes to the same /api/voice/command route that the
// voice panel uses, but it also handles navigation, search, and quick
// actions in one unified interface.
//
// Open: Ctrl+K (desktop), or the floating button (mobile)
// Close: Escape, or click outside
//
// The bar is a DOM overlay, not a panel. It sits above everything at
// z-index 10000. It is created once on first open and reused.

let barEl = null;
let inputEl = null;
let resultsEl = null;
let isOpen = false;
let activeIndex = 0;
let lastResults = [];

// All the things the command bar can route to.
const COMMANDS = [
  // Navigation
  { label: 'Briefing', cmd: 'briefing', type: 'navigate', icon: 'B' },
  { label: 'Board', cmd: 'board', type: 'navigate', icon: '#' },
  { label: 'Activity', cmd: 'activity', type: 'navigate', icon: 'A' },
  { label: 'Inbox', cmd: 'inbox', type: 'navigate', icon: 'M' },
  { label: 'Focus', cmd: 'focus', type: 'navigate', icon: 'F' },
  { label: 'Creative', cmd: 'creative', type: 'navigate', icon: '*' },
  { label: 'Journal', cmd: 'journal', type: 'navigate', icon: 'J' },
  { label: 'Digest', cmd: 'digest', type: 'navigate', icon: 'D' },
  { label: 'Decisions', cmd: 'decisions', type: 'navigate', icon: 'V' },
  { label: 'Changes', cmd: 'changes', type: 'navigate', icon: 'C' },
  { label: 'Money', cmd: 'money', type: 'navigate', icon: '$' },
  { label: 'Life', cmd: 'life', type: 'navigate', icon: 'L' },
  { label: 'System', cmd: 'system', type: 'navigate', icon: 'S' },
  { label: 'Voice', cmd: 'voice', type: 'navigate', icon: 'mic' },
  { label: 'Team', cmd: 'team', type: 'navigate', icon: 'T' },
  { label: 'Projects', cmd: 'projects', type: 'navigate', icon: 'P' },
  { label: 'Goals', cmd: 'goals', type: 'navigate', icon: 'G' },
  { label: 'Schedule', cmd: 'schedule', type: 'navigate', icon: 'C' },
  { label: 'Mail', cmd: 'mail', type: 'navigate', icon: '@' },
  { label: 'Brain', cmd: 'brain', type: 'navigate', icon: 'B' },
  { label: 'Safety', cmd: 'safety', type: 'navigate', icon: '!' },
  { label: 'Atlas', cmd: 'atlas', type: 'navigate', icon: 'M' },
  { label: 'Browsing', cmd: 'browsing', type: 'navigate', icon: 'W' },
  // Quick actions
  { label: 'What should I do today?', cmd: 'today', type: 'action', icon: '>' },
  { label: 'What\'s stuck?', cmd: 'stuck', type: 'action', icon: '!' },
  { label: 'Who\'s working?', cmd: 'who', type: 'action', icon: '?' },
  { label: 'Give me a spark', cmd: 'spark', type: 'action', icon: '*' },
  { label: 'Today\'s connection', cmd: 'connect', type: 'action', icon: '+' },
  { label: 'Start focus session', cmd: 'go', type: 'action', icon: 'F' },
  { label: 'Read the briefing', cmd: 'morning', type: 'action', icon: 'B' },
  { label: 'Agent status', cmd: 'agents', type: 'action', icon: 'A' },
  { label: 'Venture status', cmd: 'ventures', type: 'action', icon: 'V' },
];

function ensureBar() {
  if (barEl) return;
  barEl = document.createElement('div');
  barEl.id = 'mvOS-bar';
  barEl.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:10000;pointer-events:none;transition:transform 220ms cubic-bezier(.22,.61,.36,1);transform:translateY(-100%)';

  barEl.innerHTML = `
    <div style="max-width:680px;margin:0 auto;padding:16px;pointer-events:auto">
      <div style="background:var(--card,#fff);border:1px solid var(--border-strong,#d3d0c6);border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.18);overflow:hidden">
        <div style="display:flex;align-items:center;gap:10px;padding:12px 16px">
          <span style="color:var(--accent,#d9663d);font-weight:900;font-size:18px">MVOS</span>
          <input id="mvOS-input" type="text" placeholder="Type a command, or press the mic..." style="flex:1;border:none;background:transparent;color:var(--ink,#1f2320);font:inherit;font-size:15px;outline:none" autocomplete="off" />
          <button id="mvOS-mic" style="background:var(--accent-soft,#f6ddd0);border:1px solid var(--accent,#d9663d);border-radius:50%;width:32px;height:32px;cursor:pointer;display:flex;align-items:center;justify-content:center;color:var(--accent-text,#bb5834);font-size:14px">mic</button>
          <button id="mvOS-close" style="background:none;border:none;color:var(--muted,#5f665d);font-size:13px;cursor:pointer;padding:4px 8px">Esc</button>
        </div>
        <div id="mvOS-results" style="border-top:1px solid var(--border,#e5e3db);max-height:360px;overflow-y:auto"></div>
      </div>
    </div>
  `;
  document.body.appendChild(barEl);

  inputEl = barEl.querySelector('#mvOS-input');
  resultsEl = barEl.querySelector('#mvOS-results');

  inputEl.addEventListener('input', () => { filter(); });
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    if (e.key === 'ArrowDown') { e.preventDefault(); moveActive(1); }
    if (e.key === 'ArrowUp') { e.preventDefault(); moveActive(-1); }
    if (e.key === 'Enter') { e.preventDefault(); runActive(); }
  });

  barEl.querySelector('#mvOS-close').addEventListener('click', close);
  barEl.querySelector('#mvOS-mic').addEventListener('click', startVoice);

  // Click outside closes
  barEl.addEventListener('click', (e) => {
    if (e.target === barEl || e.target.querySelector('#mvOS-bar')) close();
  });
}

function open() {
  ensureBar();
  isOpen = true;
  barEl.style.pointerEvents = 'auto';
  barEl.style.transform = 'translateY(0)';
  inputEl.value = '';
  filter();
  setTimeout(() => inputEl.focus(), 50);
}

function close() {
  if (!barEl) return;
  isOpen = false;
  barEl.style.transform = 'translateY(-100%)';
  barEl.style.pointerEvents = 'none';
}

function toggle() {
  if (isOpen) close(); else open();
}

function filter() {
  const q = inputEl.value.toLowerCase().trim();
  if (!q) {
    // Show all commands when empty
    lastResults = COMMANDS.slice();
  } else {
    lastResults = COMMANDS.filter((c) =>
      c.label.toLowerCase().includes(q) || c.cmd.includes(q));
  }
  activeIndex = 0;
  render();
}

function render() {
  if (!resultsEl) return;
  if (!lastResults.length) {
    resultsEl.innerHTML = '<div style="padding:16px;color:var(--muted,#5f665d);font-size:13px">No matches. Press Enter to send "' + (inputEl.value || '...') + '" to the voice command route.</div>';
    return;
  }
  resultsEl.innerHTML = lastResults.map((c, i) => {
    const active = i === activeIndex;
    const bg = active ? 'var(--accent-soft,#f6ddd0)' : 'transparent';
    const fg = active ? 'var(--accent-text,#bb5834)' : 'var(--ink,#1f2320)';
    return `<div class="mvOS-item" data-index="${i}" style="padding:10px 16px;cursor:pointer;display:flex;align-items:center;gap:10px;background:${bg};color:${fg};font-size:14px">
      <span style="width:24px;height:24px;border-radius:6px;background:var(--bg,#f4f3ef);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:12px;color:var(--muted,#5f665d)">${c.icon}</span>
      <span style="flex:1">${c.label}</span>
      <span style="font-size:11px;color:var(--muted,#5f665d);text-transform:uppercase;letter-spacing:.05em">${c.type}</span>
    </div>`;
  }).join('');

  // Click handlers
  resultsEl.querySelectorAll('.mvOS-item').forEach((el) => {
    el.addEventListener('click', () => {
      activeIndex = Number(el.dataset.index);
      runActive();
    });
    el.addEventListener('mouseenter', () => {
      activeIndex = Number(el.dataset.index);
      render();
    });
  });
}

function moveActive(dir) {
  activeIndex = Math.max(0, Math.min(lastResults.length - 1, activeIndex + dir));
  render();
  // Scroll into view
  const el = resultsEl.querySelector('.mvOS-item[data-index="' + activeIndex + '"]');
  if (el) el.scrollIntoView({ block: 'nearest' });
}

async function runActive() {
  if (!lastResults.length) {
    // No match — send the raw text to the voice command route
    const text = inputEl.value.trim();
    if (text) await sendCommand(text);
    close();
    return;
  }
  const c = lastResults[activeIndex];
  if (c.type === 'navigate') {
    // Navigate to the panel
    const navBtn = document.querySelector(`[data-panel="${c.cmd}"]`);
    if (navBtn) navBtn.click();
  } else if (c.type === 'action') {
    await sendCommand(c.cmd);
  }
  close();
}

async function sendCommand(text) {
  try {
    const r = await fetch('/api/voice/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!r.ok) return;
    const d = await r.json();
    const action = d.action || d;
    if (action.intent === 'navigate' && action.panel) {
      const navBtn = document.querySelector(`[data-panel="${action.panel}"]`);
      if (navBtn) navBtn.click();
    } else if (action.api) {
      // Fetch and speak
      const res = await fetch(action.api);
      if (!res.ok) return;
      const data = await res.json();
      let spoken = 'Done.';
      if (action.api.includes('/briefing')) spoken = (data.needsYou||[]).length + ' items need you, ' + (data.happened||[]).length + ' things happened.';
      else if (action.api.includes('/prioritize')) spoken = (data.items||[]).length + ' open items. Top: ' + (data.items||[])[0]?.title?.slice(0,60) || 'none';
      else if (action.api.includes('/stale')) spoken = (data.items||[]).length + ' items are stale.';
      else if (action.api.includes('/sessions/active')) { const a = data.active||[]; spoken = a.length ? a.length + ' agents active.' : 'No agents active.'; }
      else if (action.api.includes('/creative/spark')) spoken = data.text || 'No spark.';
      else if (action.api.includes('/serendipity')) spoken = data.connection?.text || 'No connection.';
      else if (action.api.includes('/journal')) spoken = (data.entries||[]).length + ' journal entries.';
      else if (action.api.includes('/ventures')) spoken = (data.ventures||[]).length + ' ventures.';
      else if (action.api.includes('/agents')) spoken = (data.agents||[]).map(a => a.name + ': ' + a.status).join('. ') + '.';
      // Speak if talk-back is on (check the voice panel's toggle)
      const talkToggle = document.querySelector('#vcTalk');
      if (talkToggle?.checked || action.speak) {
        fetch('/api/voice/tts', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: spoken }),
        }).then(r => r.blob()).then(blob => {
          const audio = document.querySelector('#mvOS-audio') || (() => {
            const a = document.createElement('audio'); a.id = 'mvOS-audio'; document.body.appendChild(a); return a;
          })();
          audio.src = URL.createObjectURL(blob);
          audio.play().catch(() => {});
        }).catch(() => {});
      }
    }
  } catch {}
}

// Voice input from the command bar
let recorder = null, chunks = [], recording = false, stream = null;

async function startVoice() {
  if (recording) { stopVoice(); return; }
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch { return; }
  chunks = [];
  recorder = new MediaRecorder(stream);
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  recorder.onstop = async () => {
    stream.getTracks().forEach(t => t.stop());
    if (!chunks.length) return;
    const blob = new Blob(chunks, { type: 'audio/webm' });
    try {
      const r = await fetch('/api/voice/stt', { method: 'POST', headers: { 'Content-Type': 'audio/webm' }, body: blob });
      if (!r.ok) return;
      const d = await r.json();
      const text = (d.text || '').trim();
      if (text) {
        inputEl.value = text;
        filter();
        // Auto-run after voice input
        setTimeout(() => runActive(), 300);
      }
    } catch {}
  };
  recorder.start();
  recording = true;
  const btn = barEl.querySelector('#mvOS-mic');
  btn.style.background = 'var(--accent,#d9663d)';
  btn.style.color = '#fff';
}

function stopVoice() {
  if (!recording) return;
  recorder.stop();
  recording = false;
  const btn = barEl.querySelector('#mvOS-mic');
  btn.style.background = 'var(--accent-soft,#f6ddd0)';
  btn.style.color = 'var(--accent-text,#bb5834)';
}

// Keyboard shortcut: Ctrl+K
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
    e.preventDefault();
    toggle();
  }
});

// Export for use by other modules
export { open, close, toggle, isOpen };
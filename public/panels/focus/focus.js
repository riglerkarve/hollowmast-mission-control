import { renderBarChart } from '/shared.js';
// The backlog is not reimplemented here. This is the same panel the nav used to serve,
// mounted into a div — one implementation, one owner. Owner's instruction, 18 Aug 2026:
// the backlog's native home is Focus.
import backlogPanel from '/panels/todo/todo.js';
import steeringCard from '/panels/team/team.js';
// A panel mounted from here is NOT mounted from the registry, so nothing else loads its
// stylesheet. That is M72: the backlog rendered 1,378 elements against zero matching rules
// for as long as it has lived inside Focus, because `todo` left the PANELS map and its sheet
// went with it. Nothing errored — it just looked wrong, which is why it survived review.
// Every panel embedded here loads its own sheet through shell.js's loader, so there is one
// owner for "load this panel's CSS" rather than two that disagree by omission.
import { panelStyles } from '/shell.js';

const DURATIONS = { work: 25 * 60, short: 5 * 60, long: 15 * 60 };
const RING_CIRCUMFERENCE = 2 * Math.PI * 100;
const DAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

const TEMPLATE = `
  <div class="panel panel-wide focus-panel">
    <div class="panel-header">
      <h1>Focus</h1>
      <div class="badge" id="streak">
        <span class="badge-icon">🔥</span>
        <span id="streakCount">0</span>
        <span class="badge-label">day streak</span>
      </div>
    </div>

    <section class="card">
      <div class="mode-tabs">
        <button class="mode-tab active" data-mode="work">Focus</button>
        <button class="mode-tab" data-mode="short">Short Break</button>
        <button class="mode-tab" data-mode="long">Long Break</button>
      </div>

      <div class="ring-wrap">
        <svg class="ring" viewBox="0 0 220 220">
          <circle class="ring-bg" cx="110" cy="110" r="100"></circle>
          <circle class="ring-progress" id="ringProgress" cx="110" cy="110" r="100"></circle>
        </svg>
        <div class="time-display" id="timeDisplay">25:00</div>
      </div>

      <div class="controls">
        <button id="startPauseBtn" class="btn primary">Start</button>
        <button id="resetBtn" class="btn">Reset</button>
        <button id="skipBtn" class="btn">Skip</button>
      </div>

      <label class="focus-contributor">Record this timer as
        <select id="focusSessionActor">
          <option value="you" selected>You</option>
          <option value="claude">Claude</option>
          <option value="codex">Codex</option>
          <option value="ollama">Ollama</option>
          <option value="scribe">Scribe</option>
        </select>
      </label>
      <label class="focus-contributor">Focus interval
        <select id="focusWorkLength">
          <option value="25" selected>25 minutes</option>
          <option value="50">50 minutes</option>
          <option value="90">90 minutes</option>
        </select>
      </label>
      <p class="focus-contributor-note">This is an explicit contributor declaration, not a model label. Exact models and cost come only from telemetry.</p>

      <div class="session-count">
        Sessions today: <span id="sessionCount">0</span>
      </div>
    </section>

    <section class="card focus-voice-card">
      <div class="focus-voice-row">
        <button class="fv-mic" id="fvMic" aria-label="Click to talk">
          <svg class="fv-mic-icon" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/>
            <path d="M19 11a7 7 0 0 1-14 0M12 18v4M8 22h8" fill="none"
              stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          </svg>
          <span class="fv-mic-label" id="fvMicLabel">Click to talk</span>
        </button>
        <div class="fv-transcript" id="fvTranscript"></div>
        <label class="fv-talkback">
          <input type="checkbox" id="fvTalk">
          <span class="fv-talkback-text">Talk back</span>
        </label>
      </div>
      <audio id="fvAudio" class="fv-audio"></audio>
    </section>

    <section class="card" id="focusNowCard">
      <h2>What are you working on?</h2>
      <div id="focusNow"></div>
    </section>

    <section class="card focus-active-card">
      <h2>Active Focus</h2>
      <p class="focus-active-lede">Live heartbeats only; a completed session is not treated as current work.</p>
      <div id="focusActive" aria-live="polite">Checking active contributors…</div>
    </section>

    <div id="focusSteering"></div>

    <div id="focusBacklog"></div>

    <section class="card">
      <h2>This Week</h2>
      <div class="stats-summary">
        <div class="stat-block">
          <span class="stat-value" id="weekSessions">0</span>
          <span class="stat-label">sessions</span>
        </div>
        <div class="stat-block">
          <span class="stat-value" id="weekMinutes">0</span>
          <span class="stat-label">focus minutes</span>
        </div>
      </div>
      <div class="bar-chart" id="barChart"></div>
      <div class="focus-stats-state" data-state="loading">
        <span id="focusStatsState" role="status" aria-live="polite">Loading focus history…</span>
        <button type="button" class="focus-stats-retry" id="focusStatsRetry" hidden>Retry</button>
      </div>
    </section>

    <section class="card focus-ledger-card">
      <div class="focus-ledger-head"><h2>Time ledger</h2>
        <div><label>Window <select id="focusLedgerRange"><option value="7">7 days</option><option value="30" selected>30 days</option><option value="90">90 days</option></select></label>
          <a class="focus-ledger-export" id="focusLedgerExport" href="/api/sessions/ledger/report.csv?days=30">Download allocation CSV</a></div>
      </div>
      <p class="focus-ledger-lede">Work time by contributor and project. Unknown and unlinked time stays visible rather than being assigned by guesswork.</p>
      <div id="focusLedger" aria-live="polite">Loading time ledger…</div>
    </section>
  </div>

  <div id="celebrateOverlay" class="celebrate-overlay">
    <div class="celebrate-card">
      <div class="celebrate-emoji">🎉</div>
      <div class="celebrate-text" id="celebrateText">Session complete!</div>
    </div>
  </div>
`;

async function api(path, options = {}) {
  const { signal, headers, ...requestOptions } = options;
  // A pending request is not evidence that statistics are loading successfully. Bound it
  // so the panel can state "could not look" instead of showing a permanent loading state.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  const abortForCaller = () => controller.abort();
  if (signal) signal.addEventListener('abort', abortForCaller, { once: true });
  if (signal?.aborted) controller.abort();
  try {
    const res = await fetch(`/api${path}`, {
      // This is the owner-facing browser surface. Its future work rows must not fall into
      // the "unknown" bucket that exists precisely to prevent an attribution guess.
      headers: { 'Content-Type': 'application/json', 'X-MC-By': 'you', ...headers },
      ...requestOptions,
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`API ${path} failed: ${res.status}`);
    if (res.status === 204) return null;
    return res.json();
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', abortForCaller);
  }
}

function createPanel() {
  let el = {};
  let mode = 'work';
  let secondsLeft = DURATIONS.work;
  let running = false;
  let tickHandle = null;
  let activeTaskId = null;
  let activeTaskTitle = '';
  let runningTodoId = null;
  let workDurationSeconds = DURATIONS.work;
  let runningDurationSeconds = DURATIONS.work;
  let container = null;
  let presenceHandle = null;
  let activePollHandle = null;
  let onBacklogFocus = null;
  let onBacklogChanged = null;
  let ledgerDays = 30;
  let sessionActor = 'you';
  let openBacklogItems = [];
  let linkTargetsState = 'loading';

  // --- voice state (click-to-talk embedded in Focus) ---
  let fvRecorder = null;
  let fvChunks = [];
  let fvRecording = false;
  let fvStream = null;
  let fvTalkBack = false;
  let fvAudioEl = null;

  async function fvStart() {
    if (fvRecording) return;
    try {
      fvStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      if (el.fvTranscript) el.fvTranscript.innerHTML = '<span class="fv-err">Microphone unavailable.</span>';
      return;
    }
    fvChunks = [];
    fvRecorder = new MediaRecorder(fvStream);
    fvRecorder.ondataavailable = (e) => { if (e.data.size > 0) fvChunks.push(e.data); };
    fvRecorder.onstop = fvTranscribe;
    fvRecorder.start();
    fvRecording = true;
    const btn = container.querySelector('#fvMic');
    if (btn) btn.classList.add('fv-recording');
    const label = container.querySelector('#fvMicLabel');
    if (label) label.textContent = 'Listening… click to stop';
  }

  function fvStop() {
    if (!fvRecording || !fvRecorder) return;
    fvRecorder.stop();
    if (fvStream) fvStream.getTracks().forEach((t) => t.stop());
    fvRecording = false;
    const btn = container.querySelector('#fvMic');
    if (btn) btn.classList.remove('fv-recording');
    const label = container.querySelector('#fvMicLabel');
    if (label) label.textContent = 'Click to talk';
  }

  async function fvTranscribe() {
    if (!container) return;
    if (!fvChunks.length) return;
    const blob = new Blob(fvChunks, { type: 'audio/webm' });
    const tr = container.querySelector('#fvTranscript');
    if (tr) tr.innerHTML = '<span class="fv-thinking">Transcribing…</span>';
    try {
      const r = await fetch('/api/voice/stt', {
        method: 'POST',
        headers: { 'Content-Type': 'audio/webm' },
        body: blob,
      });
      if (!container) return;
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        if (tr) tr.innerHTML = `<span class="fv-err">${escapeHtml(e.error || 'Transcription failed')}</span>`;
        return;
      }
      const d = await r.json();
      const text = (d.text || '').trim();
      if (!text) {
        if (tr) tr.innerHTML = '<span class="fv-err">No speech detected.</span>';
        return;
      }
      if (tr) tr.innerHTML = `<span class="fv-said">${escapeHtml(text)}</span>`;
      // Send the transcript to the command route and execute the result.
      fvCommand(text);
    } catch (err) {
      if (tr) tr.innerHTML = `<span class="fv-err">Could not reach server: ${escapeHtml(err.message)}</span>`;
    }
  }

  async function fvSpeak(text) {
    if (!text || !text.trim()) return;
    try {
      const r = await fetch('/api/voice/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (!r.ok) return;
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      if (fvAudioEl) {
        fvAudioEl.src = url;
        fvAudioEl.play().catch(() => {});
      }
    } catch { /* silent — text is still visible */ }
  }

  // Send transcript to the command route, then execute the returned intent.
  // NAVIGATE switches panels. QUERY/BRIEFING/STATUS fetches data and speaks it.
  async function fvCommand(text) {
    if (!container || !text) return;
    let cmd;
    try {
      const r = await fetch('/api/voice/command', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (!r.ok) return;
      const d = await r.json();
      cmd = d.action || d;
    } catch { return; }
    if (!cmd || !container) return;

    if (cmd.intent === 'navigate' && cmd.panel) {
      const navBtn = document.querySelector(`[data-panel="${cmd.panel}"]`);
      if (navBtn) {
        navBtn.click();
        if (fvTalkBack) fvSpeak(`Opening ${cmd.panel}.`);
      } else if (fvTalkBack) {
        // command.js only ever returns a panel name this page can mount, so reaching
        // here means the nav changed underneath it -- say so instead of confirming a
        // navigation that did not happen.
        fvSpeak(`I don't have a ${cmd.panel} panel to open.`);
      }
      return;
    }
    if ((cmd.intent === 'query' || cmd.intent === 'briefing' || cmd.intent === 'status') && cmd.api) {
      try {
        const r = await fetch(cmd.api);
        if (!r.ok) return;
        const data = await r.json();
        // Simple spoken summary for the focus voice bar
        let spoken = 'Response received.';
        if (cmd.api.includes('/briefing')) {
          const n = (data.needsYou || []).length;
          const h = (data.happened || []).length;
          spoken = `${n} items need you, ${h} things happened.`;
        } else if (cmd.api.includes('/stale')) {
          spoken = `${(data.items || []).length} items are stale.`;
        } else if (cmd.api.includes('/prioritize')) {
          const items = data.items || [];
          spoken = items.length ? `${items.length} open items. Top: ${items[0].title.slice(0, 60)}.` : 'No open items.';
        } else if (cmd.api.includes('/ventures')) {
          const v = data.ventures || [];
          spoken = v.length ? `${v.length} ventures.` : 'No ventures.';
        } else if (cmd.api.includes('/serendipity')) {
          spoken = data.connection ? data.connection.text : 'No connection today.';
        } else if (cmd.api.includes('/journal')) {
          const e = data.entries || [];
          spoken = e.length ? `${e.length} journal entries.` : 'No journal entries.';
        } else if (cmd.api.includes('/sessions/active')) {
          const a = data.active || [];
          spoken = a.length ? `${a.length} agents active.` : 'No agents active.';
        } else if (cmd.api.includes('/board')) {
          spoken = `${(data.counts || {}).externalOpen || 0} open items.`;
        }
        const tr = container.querySelector('#fvTranscript');
        if (tr) tr.innerHTML = `<span class="fv-said">${escapeHtml(spoken)}</span>`;
        if (fvTalkBack) fvSpeak(spoken);
      } catch {}
      return;
    }
    if (cmd.intent === 'act' && cmd.action === 'start_focus') {
      // We're already on the focus panel — just press start.
      const startBtn = container.querySelector('#startPauseBtn');
      if (startBtn && startBtn.textContent === 'Start') startBtn.click();
      if (fvTalkBack) fvSpeak('Focus session started.');
      return;
    }
  }

  function onFvClick(ev) {
    const mic = ev.target.closest && ev.target.closest('#fvMic');
    if (mic) {
      if (!fvRecording) fvStart();
      else fvStop();
      return;
    }
    const talk = ev.target.closest && ev.target.closest('#fvTalk');
    if (talk) {
      fvTalkBack = talk.checked;
      return;
    }
  }

  function formatTime(s) {
    const m = Math.floor(s / 60).toString().padStart(2, '0');
    const sec = Math.floor(s % 60).toString().padStart(2, '0');
    return `${m}:${sec}`;
  }

  function durationForMode(kind) {
    return kind === 'work' ? workDurationSeconds : DURATIONS[kind];
  }

  function updateRing() {
    const total = running && mode === 'work' ? runningDurationSeconds : durationForMode(mode);
    const fraction = secondsLeft / total;
    el.ring.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - fraction));
  }

  function renderTimer() {
    el.timeDisplay.textContent = formatTime(secondsLeft);
    updateRing();
    el.startPauseBtn.textContent = running ? 'Pause' : 'Start';
    const modeColors = { work: '#d9663d', short: '#4d8b6f', long: '#3f6fa6' };
    el.ring.style.stroke = modeColors[mode];
    if (el.focusSessionActor) el.focusSessionActor.disabled = running;
    if (el.focusWorkLength) el.focusWorkLength.disabled = running || mode !== 'work';
    document.title = running ? `${formatTime(secondsLeft)} · Focus Flow` : 'Ground Control';
  }

  // The list lives in the embedded backlog panel now. This panel keeps only the ONE fact
  // that is genuinely its own: which item the timer is recording against.
  //
  // Worth keeping the history, because I got the neighbouring judgement wrong once. I first
  // shipped the compact list read-only, reasoning that "a second surface writing the same
  // list is two owners". That misapplies the rule: the one-writer rule is about two STORES
  // holding the same fact, not two BUTTONS calling one route. The cost was immediate — the
  // owner ordered Huel, a real backlog item, and the panel showing that item had no way to
  // tick it. Hosting the real panel here settles it permanently: there is exactly one
  // implementation of the list, so the question cannot come back.

  function renderFocusNow() {
    if (!el || !el.focusNow) return;
    el.focusNow.innerHTML = activeTaskId
      ? `<p class="focus-now-has">Recording ${escapeHtml(actorLabel(sessionActor))} against
           <b class="focus-now-title">${escapeHtml(activeTaskTitle || activeTaskId)}</b>
           <button type="button" class="btn focus-now-clear">Clear</button></p>`
      : `<p class="empty-hint">No backlog item selected for ${escapeHtml(actorLabel(sessionActor))}. Press <b>Focus</b> on any item below and
           the timer will record against it. A session with nothing selected still counts —
           it just records no subject.</p>`;
    const clear = el.focusNow.querySelector('.focus-now-clear');
    if (clear) clear.addEventListener('click', () => setActiveTask(null));
  }

  function escapeHtml(v) {
    return String(v).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // Pressing Focus on the item already selected clears it, so the same button is both
  // set and unset and there is no state you can get stuck in.
  function setActiveTask(id, title) {
    if (running) return;
    if (id === null || activeTaskId === id) {
      activeTaskId = null;
      activeTaskTitle = '';
    } else {
      activeTaskId = id;
      activeTaskTitle = title || '';
    }
    renderFocusNow();
  }

  // Something in the backlog panel changed. If the item the timer points at is no longer
  // open, stop pointing at it — a timer recording against a closed item is a wrong record,
  // not a harmless one.
  async function refreshActiveTask() {
    if (!activeTaskId) return;
    try {
      const body = await api('/todo/items?status=open');
      const still = (body.items || []).some((t) => String(t.id) === String(activeTaskId));
      if (!still) setActiveTask(null);
    } catch {
      // Could not look. Leave the selection alone rather than clearing it on a network
      // blip -- silently dropping the subject would make the next session record nothing.
    }
  }

  function renderActive(data) {
    if (!container || !el.focusActive) return;
    const active = data.active || [];
    el.focusActive.innerHTML = active.length
      ? `<ul class="focus-active-list">${active.map((row) => `<li><b>${escapeHtml(actorLabel(row.actor))}</b><span>${escapeHtml(row.todoTitle ? `${row.project || 'Unprojected'} — ${row.todoTitle}` : 'No backlog item selected')}</span><small>Started ${escapeHtml(row.startedAt)} · heartbeat ${escapeHtml(row.lastSeenAt)}</small></li>`).join('')}</ul>`
      : `<p class="focus-ledger-empty">${escapeHtml(data.recordedNothing || 'No active contributors reported.')}</p>`;
  }

  function showActiveUnavailable() {
    if (container && el.focusActive) el.focusActive.innerHTML = '<p class="focus-ledger-error">Could not read active Focus presence. This is not a report that nobody is working.</p>';
  }

  async function loadActive() {
    renderActive(await api('/sessions/active'));
  }

  async function sendPresence() {
    try {
      await api('/sessions/active', {
        method: 'PUT', body: JSON.stringify({ todoId: runningTodoId }), headers: { 'X-MC-By': sessionActor },
      });
      loadActive().catch(showActiveUnavailable);
    } catch {
      showActiveUnavailable();
    }
  }

  function clearPresence() {
    api('/sessions/active', { method: 'DELETE', headers: { 'X-MC-By': sessionActor } })
      .then(() => loadActive())
      .catch(showActiveUnavailable);
  }

  async function loadStats() {
    setStatsState('loading', 'Loading focus history…');
    const [summary, daily] = await Promise.all([
      api('/stats/summary'),
      api('/stats/daily?days=7'),
    ]);
    el.sessionCount.textContent = summary.today;
    el.streakCount.textContent = summary.streak;
    renderWeekChart(daily);
  }

  function formatMinutes(minutes) {
    const n = Math.max(0, Number(minutes) || 0);
    const hours = Math.floor(n / 60);
    const rest = n % 60;
    return hours ? `${hours}h ${rest}m` : `${rest}m`;
  }

  function formatUsd(microusd) {
    if (microusd === null || microusd === undefined || microusd === '') return 'Not recorded';
    const dollars = Number(microusd) / 1000000;
    return Number.isFinite(dollars) ? `$${dollars.toFixed(2)}` : 'Not recorded';
  }

  function coverage(part, total) {
    if (!total) return 'No recorded sessions';
    return `${part} of ${total} (${Math.round((part / total) * 100)}%)`;
  }

  function actorLabel(actor, model) {
    const labels = { you: 'You', claude: 'Claude (model)', codex: 'Codex (model)', ollama: 'Ollama (model)', scribe: 'Scribe (model)', import: 'Import', schedule: 'Schedule', unknown: 'Unattributed' };
    const base = labels[actor] || actor;
    return model ? `${base} · ${model}` : base;
  }

  function daysInWindow(days) {
    const out = [];
    const cursor = new Date();
    cursor.setHours(0, 0, 0, 0);
    cursor.setDate(cursor.getDate() - (days - 1));
    for (let i = 0; i < days; i += 1) {
      out.push(`${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(cursor.getDate()).padStart(2, '0')}`);
      cursor.setDate(cursor.getDate() + 1);
    }
    return out;
  }

  function bars(rows, days, filter = {}) {
    const byDay = new Map(rows.map((row) => [row.day, Number(row.minutes) || 0]));
    const max = Math.max(1, ...byDay.values());
    return `<div class="focus-ledger-bars" style="grid-template-columns:repeat(${days}, minmax(2px, 1fr))" aria-label="${days}-day activity trend">${daysInWindow(days).map((day) => {
      const minutes = byDay.get(day) || 0;
      const data = [filter.actor ? `data-ledger-actor="${escapeHtml(filter.actor)}"` : '', filter.project ? `data-ledger-project="${escapeHtml(filter.project)}"` : ''].filter(Boolean).join(' ');
      return `<button type="button" class="focus-ledger-bar" data-ledger-day="${day}" ${data} title="Show ${day}: ${formatMinutes(minutes)}" aria-label="Show ${day}: ${formatMinutes(minutes)}" style="height:${Math.max(minutes ? 8 : 2, Math.round((minutes / max) * 100))}%"></button>`;
    }).join('')}</div>`;
  }

  function renderLedger(data) {
    if (!container || !el.focusLedger) return;
    const actors = data.actors || [];
    const projects = data.projects || [];
    const actorDays = data.actorDays || [];
    const projectDays = data.projectDays || [];
    const models = data.models || [];
    const unlinked = data.unlinked || [];
    const missing = data.missing || {};
    const quality = data.quality || {};
    const targetByProject = new Map((data.targets || []).map((target) => [target.project, target]));
    const projectByName = new Map(projects.map((project) => [project.project, project]));
    const actorRows = actors.length
      ? `<ul class="focus-ledger-actors">${actors.map((row) => `<li>
          <b>${escapeHtml(actorLabel(row.actor, row.model))}</b><strong>${formatMinutes(row.minutes)}</strong>
          <span>${row.sessions} work session${row.sessions === 1 ? '' : 's'} · ${formatUsd(row.costMicrousd)}${row.unlinkedMinutes ? ` · ${formatMinutes(row.unlinkedMinutes)} not linked to an item` : ''}</span>
        </li>`).join('')}</ul>`
      : `<p class="focus-ledger-empty">${escapeHtml(data.recordedNothing || 'No work sessions in this window.')}</p>`;
    const projectRows = projects.length
      ? `<div class="focus-ledger-projects"><h3>By project</h3><table><thead><tr><th>Project</th><th>Time</th><th>Sessions</th><th>Contributors</th><th>Plan</th></tr></thead><tbody>
          ${projects.map((row) => {
            const name = row.project === 'unassigned' ? 'Linked item without project' : row.project;
            const target = targetByProject.get(row.project);
            const targetWindow = target ? Math.round((target.weeklyTargetMinutes * data.days) / 7) : 0;
            const targetText = target
              ? `${formatMinutes(target.weeklyTargetMinutes)} / week · ${formatMinutes(targetWindow)} planned in this window`
              : 'Not set';
            const targetControl = row.project === 'unassigned'
              ? 'Needs a project label'
              : `<span class="focus-target-summary">${escapeHtml(targetText)}</span>`;
            return `<tr><td>${escapeHtml(name)}</td><td>${formatMinutes(row.minutes)} · ${formatUsd(row.costMicrousd)}</td><td>${row.sessions}</td><td>${row.contributors}</td><td>${targetControl}</td></tr>`;
          }).join('')}
        </tbody></table></div>`
      : '<p class="focus-ledger-empty">No work session is linked to a project in this window.</p>';
    const targetProjects = [...new Set([...(data.knownProjects || []), ...(data.targets || []).map((target) => target.project)])];
    const targetManager = targetProjects.length
      ? `<div class="focus-ledger-targets"><h3>Project time targets</h3><p>Weekly targets are plans, not estimates. The selected-window comparison is simple calendar scaling.</p><table><thead><tr><th>Project</th><th>Weekly target</th><th>${data.days}-day actual / plan</th><th></th></tr></thead><tbody>${targetProjects.map((project) => {
        const target = targetByProject.get(project);
        const actual = projectByName.get(project);
        const windowTarget = target ? Math.round((target.weeklyTargetMinutes * data.days) / 7) : null;
        const comparison = target ? `${formatMinutes(actual ? actual.minutes : 0)} / ${formatMinutes(windowTarget)}` : 'Set a target to compare';
        return `<tr><td>${escapeHtml(project)}</td><td><label class="focus-target-control"><input type="number" min="1" max="10080" step="1" value="${target ? target.weeklyTargetMinutes : ''}" placeholder="Minutes" data-target-project="${escapeHtml(project)}" aria-label="Weekly minutes target for ${escapeHtml(project)}"><span>minutes / week</span></label></td><td>${escapeHtml(comparison)}</td><td><button type="button" data-save-target="${escapeHtml(project)}">Save</button>${target ? `<button type="button" data-clear-target="${escapeHtml(project)}">Clear</button>` : ''}</td></tr>`;
      }).join('')}</tbody></table></div>`
      : '<p class="focus-ledger-empty">No canonical project labels are available for time targets yet.</p>';
    const timeline = actors.length
      ? `<div class="focus-ledger-timeline"><h3>Contributor timeline</h3><p>Choose a day to inspect its recorded sessions.</p>${[...new Set(actorDays.map((r) => r.actor))].map((actor) => `<div class="focus-ledger-lane"><b>${escapeHtml(actorLabel(actor))}</b>${bars(actorDays.filter((r) => r.actor === actor), data.days, { actor })}</div>`).join('')}</div>`
      : '';
    const projectTrends = projects.length
      ? `<div class="focus-ledger-trends"><h3>Project trends</h3>${projects.map((row) => `<div class="focus-ledger-lane"><b>${escapeHtml(row.project === 'unassigned' ? 'Linked item without project' : row.project)}</b>${bars(projectDays.filter((d) => d.project === row.project), data.days, { project: row.project })}</div>`).join('')}</div>`
      : '';
    const modelRows = models.length
      ? `<div class="focus-ledger-models"><h3>Model evidence</h3><table><thead><tr><th>Model</th><th>Time</th><th>Sessions</th><th>USD cost</th></tr></thead><tbody>${models.map((row) => `<tr><td>${escapeHtml(actorLabel(row.actor, row.model))}</td><td>${formatMinutes(row.minutes)}</td><td>${row.sessions}</td><td>${formatUsd(row.costMicrousd)}</td></tr>`).join('')}</tbody></table></div>`
      : '<p class="focus-ledger-empty">No session in this window carries an unambiguous model label.</p>';
    const queueRows = unlinked.length
      ? `<div class="focus-ledger-queue"><h3>Time without project evidence <span>${unlinked.length}</span></h3><p>Selecting a backlog item here records a manual link by the current contributor. It does not infer a project from time, model, cost, or files.</p><table><thead><tr><th>Completed</th><th>Contributor / model</th><th>Time</th><th>Direct link</th></tr></thead><tbody>${unlinked.slice(0, 20).map((row) => `<tr><td>${escapeHtml(row.completedAt)}</td><td>${escapeHtml(actorLabel(row.actor, row.model))}</td><td>${formatMinutes(row.minutes)} · ${formatUsd(row.costMicrousd)}</td><td><label class="focus-link-control"><select data-link-target="${row.id}" aria-label="Backlog item for this session"><option value="">Choose backlog item…</option></select><button type="button" data-link-session="${row.id}">Link</button></label></td></tr>`).join('')}</tbody></table>${unlinked.length > 20 ? `<p>Showing the latest 20 of ${unlinked.length}; the total remains unallocated.</p>` : ''}</div>`
      : '<p class="focus-ledger-empty">Every recorded work session in this window has direct project evidence.</p>';
    const qualityRows = [
      ['Project evidence', coverage(quality.linkedSessions || 0, quality.sessions || 0)],
      ['Contributor attribution', coverage(quality.attributedSessions || 0, quality.sessions || 0)],
      ['Exact model telemetry', coverage(quality.modelKnownSessions || 0, quality.sessions || 0)],
      ['Source cost telemetry', coverage(quality.costKnownSessions || 0, quality.sessions || 0)],
    ];
    const gaps = [
      missing.unlinkedMinutes ? `${formatMinutes(missing.unlinkedMinutes)} has no linked backlog item` : null,
      missing.unprojectedMinutes ? `${formatMinutes(missing.unprojectedMinutes)} links to an item without a project` : null,
      missing.unattributedMinutes ? `${formatMinutes(missing.unattributedMinutes)} has no contributor attribution` : null,
    ].filter(Boolean);
    const gapsBlock = gaps.length
      ? `<div class="focus-ledger-note"><b>Not allocated by evidence</b><ul class="focus-ledger-gaps">${gaps.map((g) => `<li>${escapeHtml(g)}</li>`).join('')}</ul></div>`
      : `<p class="focus-ledger-note">Every recorded work session in this window has a contributor and a linked project.</p>`;
    el.focusLedger.innerHTML = `
      <div class="focus-ledger-quality"><h3>Evidence coverage</h3><ul>${qualityRows.map(([label, value]) => `<li><b>${label}</b><span>${value}</span></li>`).join('')}</ul></div>
      <h3>People and models</h3>${actorRows}${timeline}${projectRows}${targetManager}${projectTrends}${modelRows}${queueRows}<div id="focusLedgerDrilldown"></div>
      ${gapsBlock}
      <p class="focus-ledger-basis">${escapeHtml(data.note || '')}</p>`;
    populateLinkTargets();
  }

  function showLedgerUnavailable() {
    if (!container || !el.focusLedger) return;
    el.focusLedger.innerHTML = '<p class="focus-ledger-error">Could not read the time ledger. This is a failure to look, not a report that no time was recorded.</p>';
  }

  async function loadLedger() {
    const data = await api(`/sessions/ledger?days=${ledgerDays}`);
    if (el.focusLedgerExport) el.focusLedgerExport.href = `/api/sessions/ledger/report.csv?days=${data.days}`;
    renderLedger(data);
  }

  function populateLinkTargets() {
    if (!el.focusLedger) return;
    const selects = el.focusLedger.querySelectorAll('[data-link-target]');
    for (const select of selects) {
      if (linkTargetsState === 'loading') {
        select.innerHTML = '<option value="">Loading open backlog items…</option>';
        select.disabled = true;
      } else if (linkTargetsState === 'error') {
        select.innerHTML = '<option value="">Backlog choices unavailable</option>';
        select.disabled = true;
      } else {
        select.innerHTML = `<option value="">Choose backlog item…</option>${openBacklogItems.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(`${item.status === 'open' ? '' : `[${item.status}] `}${item.project ? `${item.project} — ` : ''}${item.title}`)}</option>`).join('')}`;
        select.disabled = !openBacklogItems.length;
      }
    }
  }

  async function loadLinkTargets() {
    linkTargetsState = 'loading';
    try {
      // A historical session can honestly belong to a completed or declined item, so
      // restricting this repair list to open work would manufacture a new evidence gap.
      const body = await api('/todo/items');
      openBacklogItems = body.items || [];
      linkTargetsState = 'ready';
    } catch {
      // The queue remains a clear evidence gap if its repair choices cannot be read.
      linkTargetsState = 'error';
    }
    populateLinkTargets();
  }

  function renderLedgerDrilldown(state, content) {
    const target = el.focusLedger && el.focusLedger.querySelector('#focusLedgerDrilldown');
    if (target) target.innerHTML = `<div class="focus-ledger-drilldown" data-state="${state}">${content}</div>`;
  }

  async function showLedgerSessions(button) {
    const params = new URLSearchParams({ day: button.dataset.ledgerDay });
    if (button.dataset.ledgerActor) params.set('actor', button.dataset.ledgerActor);
    if (button.dataset.ledgerProject) params.set('project', button.dataset.ledgerProject);
    renderLedgerDrilldown('loading', '<p>Loading recorded sessions…</p>');
    try {
      const body = await api(`/sessions/ledger/sessions?${params}`);
      const rows = body.sessions || [];
      const title = button.dataset.ledgerProject
        ? `${button.dataset.ledgerDay} · ${button.dataset.ledgerProject}`
        : `${button.dataset.ledgerDay} · ${actorLabel(button.dataset.ledgerActor)}`;
      renderLedgerDrilldown(rows.length ? 'ready' : 'empty', rows.length
        ? `<h3>Recorded sessions — ${escapeHtml(title)}</h3><table><thead><tr><th>Completed</th><th>Contributor / model</th><th>Time</th><th>Project evidence</th><th>USD cost</th></tr></thead><tbody>${rows.map((row) => `<tr><td>${escapeHtml(row.completedAt)}</td><td>${escapeHtml(actorLabel(row.actor, row.model))}</td><td>${formatMinutes(row.minutes)}</td><td>${escapeHtml(row.todoTitle ? `${row.project}: ${row.todoTitle} (${row.todoLinkSource || 'legacy'} link)` : 'No project link')}</td><td>${formatUsd(row.costMicrousd)}</td></tr>`).join('')}</tbody></table>`
        : `<p>${escapeHtml(body.recordedNothing || 'No recorded sessions matched this bar.')}</p>`);
    } catch {
      renderLedgerDrilldown('error', '<p>Could not read this day’s sessions. The bar remains an aggregate; no empty result is being claimed.</p>');
    }
  }

  async function saveProjectTarget(button) {
    const row = button.closest('tr');
    const input = row && row.querySelector('[data-target-project]');
    if (!input || !input.value) return;
    button.disabled = true;
    try {
      await api(`/sessions/ledger/targets/${encodeURIComponent(button.dataset.saveTarget)}`, {
        method: 'PUT', body: JSON.stringify({ weeklyTargetMinutes: Number(input.value) }),
      });
      await loadLedger();
    } catch {
      button.disabled = false;
      button.textContent = 'Could not save';
    }
  }

  async function clearProjectTarget(button) {
    button.disabled = true;
    try {
      await api(`/sessions/ledger/targets/${encodeURIComponent(button.dataset.clearTarget)}`, { method: 'DELETE' });
      await loadLedger();
    } catch {
      button.disabled = false;
      button.textContent = 'Could not clear';
    }
  }

  async function linkUnallocatedSession(button) {
    const row = button.closest('tr');
    const select = row && row.querySelector('[data-link-target]');
    if (!select || !select.value) return;
    button.disabled = true;
    try {
      await api(`/sessions/${encodeURIComponent(button.dataset.linkSession)}/link`, {
        method: 'PATCH', body: JSON.stringify({ todoId: select.value }), headers: { 'X-MC-By': sessionActor },
      });
      await loadLedger();
    } catch {
      button.disabled = false;
      button.textContent = 'Could not link';
    }
  }

  function onLedgerClick(event) {
    const bar = event.target.closest('[data-ledger-day]');
    if (bar) { showLedgerSessions(bar); return; }
    const link = event.target.closest('[data-link-session]');
    if (link) { linkUnallocatedSession(link); return; }
    const saveTarget = event.target.closest('[data-save-target]');
    if (saveTarget) { saveProjectTarget(saveTarget); return; }
    const clearTarget = event.target.closest('[data-clear-target]');
    if (clearTarget) clearProjectTarget(clearTarget);
  }

  function renderWeekChart(daily) {
    el.weekSessions.textContent = daily.totalSessions;
    el.weekMinutes.textContent = daily.totalMinutes;

    const today = new Date();
    const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

    renderBarChart(el.barChart, daily.days, {
      value: (d) => d.count,
      label: (d) => DAY_LABELS[new Date(`${d.date}T00:00:00`).getDay()],
      tooltip: (d) => (d.count === 1 ? '1 session' : `${d.count} sessions`),
      isHighlighted: (d) => d.date === todayKey,
    });

    setStatsState(
      daily.totalSessions === 0 ? 'empty' : 'ready',
      daily.totalSessions === 0 ? 'No completed focus sessions in the last 7 days.' : '',
    );
  }

  // Zero is a real, useful answer from /stats. It must not be the same UI as a failed
  // request: otherwise an unavailable record tells the owner they have done no sessions.
  function setStatsState(state, message) {
    if (!container || !el.focusStatsState) return;
    el.focusStatsState.parentElement.dataset.state = state;
    el.focusStatsState.textContent = message;
    el.focusStatsRetry.hidden = state !== 'error';
  }

  function showStatsUnavailable(message = 'Focus history could not be loaded. The timer is still available; no statistics are shown.') {
    if (!container) return;
    el.sessionCount.textContent = '—';
    el.streakCount.textContent = '—';
    el.weekSessions.textContent = '—';
    el.weekMinutes.textContent = '—';
    el.barChart.replaceChildren();
    setStatsState('error', message);
  }

  function setMode(newMode) {
    mode = newMode;
    secondsLeft = durationForMode(mode);
    running = false;
    clearInterval(tickHandle);
    clearInterval(presenceHandle);
    presenceHandle = null;
    clearPresence();
    el.modeTabs.forEach((tab) => tab.classList.toggle('active', tab.dataset.mode === newMode));
    renderTimer();
  }

  function tick() {
    secondsLeft -= 1;
    if (secondsLeft <= 0) {
      completeSession();
      return;
    }
    renderTimer();
  }

  async function completeSession() {
    running = false;
    clearInterval(tickHandle);
    clearInterval(presenceHandle);
    presenceHandle = null;
    clearPresence();
    secondsLeft = 0;
    renderTimer();

    let sessionRecorded = mode !== 'work';
    if (mode === 'work') {
      try {
        await api('/sessions', {
          method: 'POST',
          // todoId, not taskId. activeTaskId now holds a backlog id ('49', 'M3'), and the
          // old field expects an INTEGER tasks.id -- sending it there would silently store
          // null and the session would record no subject at all.
          body: JSON.stringify({ todoId: runningTodoId, kind: 'work', durationMinutes: runningDurationSeconds / 60 }),
          headers: { 'X-MC-By': sessionActor },
        });
        sessionRecorded = true;
      } catch {
        // The timer did end, but the record did not. Say that plainly rather than playing
        // the completion state for a session the API never accepted.
        setStatsState('error', 'Session ended, but it was not recorded. Check the connection before starting another.');
      }
      if (sessionRecorded) {
        try {
          await Promise.all([refreshActiveTask(), loadStats()]);
          celebrate('Session complete! Take a break 🎉');
        } catch {
          // The write already returned 201. A stale dashboard must not rewrite that fact as
          // a failed session merely because its follow-up read is unavailable.
          showStatsUnavailable('Session recorded, but the statistics could not refresh. Retry when the connection returns.');
          celebrate('Session recorded! Take a break 🎉');
        }
      }
    } else {
      celebrate("Break's over — back to it!");
    }

    if (sessionRecorded) playChime();
    const nextMode = mode === 'work' ? 'short' : 'work';
    setTimeout(() => setMode(nextMode), 1600);
  }

  function celebrate(text) {
    el.celebrateText.textContent = text;
    el.celebrateOverlay.classList.add('show');
    setTimeout(() => el.celebrateOverlay.classList.remove('show'), 1500);
  }

  function playChime() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.15, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.8);
      osc.start();
      osc.stop(ctx.currentTime + 0.8);
    } catch {
      /* ignore audio errors */
    }
  }

  function startPause() {
    running = !running;
    if (running) {
      runningTodoId = activeTaskId;
      runningDurationSeconds = durationForMode(mode);
      tickHandle = setInterval(tick, 1000);
      sendPresence();
      presenceHandle = setInterval(sendPresence, 60000);
    } else {
      clearInterval(tickHandle);
      clearInterval(presenceHandle);
      presenceHandle = null;
      clearPresence();
    }
    renderTimer();
  }

  return {
    mount(el0) {
      container = el0;
      container.innerHTML = TEMPLATE;
      el = {
        modeTabs: container.querySelectorAll('.mode-tab'),
        ring: container.querySelector('#ringProgress'),
        timeDisplay: container.querySelector('#timeDisplay'),
        startPauseBtn: container.querySelector('#startPauseBtn'),
        resetBtn: container.querySelector('#resetBtn'),
        skipBtn: container.querySelector('#skipBtn'),
        sessionCount: container.querySelector('#sessionCount'),
        streakCount: container.querySelector('#streakCount'),
        focusNow: container.querySelector('#focusNow'),
        focusActive: container.querySelector('#focusActive'),
        focusBacklog: container.querySelector('#focusBacklog'),
        focusSteering: container.querySelector('#focusSteering'),
        focusLedger: container.querySelector('#focusLedger'),
        focusLedgerRange: container.querySelector('#focusLedgerRange'),
        focusLedgerExport: container.querySelector('#focusLedgerExport'),
        focusSessionActor: container.querySelector('#focusSessionActor'),
        focusWorkLength: container.querySelector('#focusWorkLength'),
        focusStatsState: container.querySelector('#focusStatsState'),
        focusStatsRetry: container.querySelector('#focusStatsRetry'),
        celebrateOverlay: container.querySelector('#celebrateOverlay'),
        celebrateText: container.querySelector('#celebrateText'),
        barChart: container.querySelector('#barChart'),
        weekSessions: container.querySelector('#weekSessions'),
        weekMinutes: container.querySelector('#weekMinutes'),
      };

      // Voice: capture the audio element and attach the click handler for click-to-talk.
      fvAudioEl = container.querySelector('#fvAudio');
      container.addEventListener('click', onFvClick);

      el.ring.style.strokeDasharray = String(RING_CIRCUMFERENCE);

      el.modeTabs.forEach((tab) => tab.addEventListener('click', () => setMode(tab.dataset.mode)));
      el.startPauseBtn.addEventListener('click', startPause);
      el.focusSessionActor.addEventListener('change', () => {
        sessionActor = el.focusSessionActor.value;
        renderFocusNow();
      });
      el.focusWorkLength.addEventListener('change', () => {
        workDurationSeconds = Number(el.focusWorkLength.value) * 60;
        if (mode === 'work' && !running) {
          secondsLeft = workDurationSeconds;
          renderTimer();
        }
      });
      el.focusStatsRetry.addEventListener('click', () => loadStats().catch(showStatsUnavailable));
      el.focusLedger.addEventListener('click', onLedgerClick);
      el.focusLedgerRange.addEventListener('change', () => {
        ledgerDays = Number(el.focusLedgerRange.value) || 30;
        loadLedger().catch(showLedgerUnavailable);
      });
      el.resetBtn.addEventListener('click', () => {
        running = false;
        clearInterval(tickHandle);
        clearInterval(presenceHandle);
        presenceHandle = null;
        clearPresence();
        secondsLeft = durationForMode(mode);
        renderTimer();
      });
      el.skipBtn.addEventListener('click', () => {
        running = false;
        clearInterval(tickHandle);
        clearInterval(presenceHandle);
        presenceHandle = null;
        clearPresence();
        // Skipping means this interval was abandoned, not completed. Recording its full
        // planned duration would fabricate time in the ledger.
        setMode(mode === 'work' ? 'short' : 'work');
      });
      // The backlog panel announces; this panel decides. It is mounted AFTER el is built,
      // so container.querySelectorAll('.mode-tab') above captured only the timer's three
      // tabs and not the backlog's two.
      onBacklogFocus = (ev) => setActiveTask(ev.detail.id, ev.detail.title);
      onBacklogChanged = () => refreshActiveTask();
      container.addEventListener('td:focus', onBacklogFocus);
      container.addEventListener('td:changed', onBacklogChanged);
      // Load the embedded panels' stylesheets before mounting them. Fire-and-forget: the
      // loader resolves on error too, because unstyled beats absent — but nothing here may
      // wait on a stylesheet, since a slow sheet must not delay the timer.
      panelStyles('todo');
      panelStyles('team');

      // { card: 'steering' } keeps this to the decisions-waiting card. The same module is the
      // full shift view when the nav mounts it, so without this Focus would render the whole
      // panel inside itself -- one implementation, two modes, and the mode has to be asked for.
      steeringCard.mount(el.focusSteering, { card: 'steering' });
      backlogPanel.mount(el.focusBacklog, { embedded: true });

      renderTimer();
      if (running) {
        tickHandle = setInterval(tick, 1000);
      }
      renderFocusNow();
      loadStats().catch(showStatsUnavailable);
      loadLedger().catch(showLedgerUnavailable);
      loadLinkTargets();
      loadActive().catch(showActiveUnavailable);
      activePollHandle = setInterval(() => loadActive().catch(showActiveUnavailable), 30000);
    },

    unmount() {
      clearInterval(tickHandle);
      clearInterval(presenceHandle);
      clearInterval(activePollHandle);
      // Voice: stop recording if in progress and remove listener.
      if (fvRecording) fvStop();
      if (container && onFvClick) container.removeEventListener('click', onFvClick);
      fvAudioEl = null;
      if (running) clearPresence();
      // The embedded panel holds an AbortController and three listeners of its own. Not
      // unmounting it leaks a fetch that resolves into a dead DOM.
      backlogPanel.unmount();
      steeringCard.unmount();
      if (container && onBacklogFocus) container.removeEventListener('td:focus', onBacklogFocus);
      if (container && onBacklogChanged) container.removeEventListener('td:changed', onBacklogChanged);
      if (el.focusLedger) el.focusLedger.removeEventListener('click', onLedgerClick);
      onBacklogFocus = onBacklogChanged = null;
      container = null;
      document.title = 'Ground Control';
    },
  };
}

export default createPanel();

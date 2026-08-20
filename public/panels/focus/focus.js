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

      <div class="session-count">
        Sessions today: <span id="sessionCount">0</span>
      </div>
    </section>

    <section class="card" id="focusNowCard">
      <h2>What are you working on?</h2>
      <div id="focusNow"></div>
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
      <p class="focus-stats-state" id="focusStatsState" role="status" aria-live="polite">Loading focus history…</p>
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
  const { signal, ...requestOptions } = options;
  // A pending request is not evidence that statistics are loading successfully. Bound it
  // so the panel can state "could not look" instead of showing a permanent loading state.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  const abortForCaller = () => controller.abort();
  if (signal) signal.addEventListener('abort', abortForCaller, { once: true });
  if (signal?.aborted) controller.abort();
  try {
    const res = await fetch(`/api${path}`, {
      headers: { 'Content-Type': 'application/json' },
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
  let container = null;
  let onBacklogFocus = null;
  let onBacklogChanged = null;

  function formatTime(s) {
    const m = Math.floor(s / 60).toString().padStart(2, '0');
    const sec = Math.floor(s % 60).toString().padStart(2, '0');
    return `${m}:${sec}`;
  }

  function updateRing() {
    const total = DURATIONS[mode];
    const fraction = secondsLeft / total;
    el.ring.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - fraction));
  }

  function renderTimer() {
    el.timeDisplay.textContent = formatTime(secondsLeft);
    updateRing();
    el.startPauseBtn.textContent = running ? 'Pause' : 'Start';
    const modeColors = { work: '#d9663d', short: '#4d8b6f', long: '#3f6fa6' };
    el.ring.style.stroke = modeColors[mode];
    document.title = running ? `${formatTime(secondsLeft)} · Focus Flow` : 'Mission Control';
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
      ? `<p class="focus-now-has">Recording against
           <b class="focus-now-title">${escapeHtml(activeTaskTitle || activeTaskId)}</b>
           <button type="button" class="btn focus-now-clear">Clear</button></p>`
      : `<p class="empty-hint">Nothing selected. Press <b>Focus</b> on any item below and
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

  async function loadStats() {
    const [summary, daily] = await Promise.all([
      api('/stats/summary'),
      api('/stats/daily?days=7'),
    ]);
    el.sessionCount.textContent = summary.today;
    el.streakCount.textContent = summary.streak;
    renderWeekChart(daily);
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
    el.focusStatsState.dataset.state = state;
    el.focusStatsState.textContent = message;
  }

  function showStatsUnavailable() {
    if (!container) return;
    el.sessionCount.textContent = '—';
    el.streakCount.textContent = '—';
    el.weekSessions.textContent = '—';
    el.weekMinutes.textContent = '—';
    el.barChart.replaceChildren();
    setStatsState('error', 'Focus history could not be loaded. The timer is still available; no statistics are shown.');
  }

  function setMode(newMode) {
    mode = newMode;
    secondsLeft = DURATIONS[mode];
    running = false;
    clearInterval(tickHandle);
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
    secondsLeft = 0;
    renderTimer();

    if (mode === 'work') {
      try {
        await api('/sessions', {
          method: 'POST',
          // todoId, not taskId. activeTaskId now holds a backlog id ('49', 'M3'), and the
          // old field expects an INTEGER tasks.id -- sending it there would silently store
          // null and the session would record no subject at all.
          body: JSON.stringify({ todoId: activeTaskId, kind: 'work', durationMinutes: DURATIONS.work / 60 }),
        });
        await Promise.all([refreshActiveTask(), loadStats()]);
        celebrate('Session complete! Take a break 🎉');
      } catch {
        // The timer did end, but the record did not. Say that plainly rather than playing
        // the completion state for a session the API never accepted.
        setStatsState('error', 'Session ended, but it was not recorded. Check the connection before starting another.');
      }
    } else {
      celebrate("Break's over — back to it!");
    }

    playChime();
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
      tickHandle = setInterval(tick, 1000);
    } else {
      clearInterval(tickHandle);
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
        focusBacklog: container.querySelector('#focusBacklog'),
        focusSteering: container.querySelector('#focusSteering'),
        celebrateOverlay: container.querySelector('#celebrateOverlay'),
        celebrateText: container.querySelector('#celebrateText'),
        barChart: container.querySelector('#barChart'),
        weekSessions: container.querySelector('#weekSessions'),
        weekMinutes: container.querySelector('#weekMinutes'),
      };

      el.ring.style.strokeDasharray = String(RING_CIRCUMFERENCE);

      el.modeTabs.forEach((tab) => tab.addEventListener('click', () => setMode(tab.dataset.mode)));
      el.startPauseBtn.addEventListener('click', startPause);
      el.resetBtn.addEventListener('click', () => {
        running = false;
        clearInterval(tickHandle);
        secondsLeft = DURATIONS[mode];
        renderTimer();
      });
      el.skipBtn.addEventListener('click', () => {
        running = false;
        clearInterval(tickHandle);
        secondsLeft = 1;
        tick();
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
    },

    unmount() {
      clearInterval(tickHandle);
      // The embedded panel holds an AbortController and three listeners of its own. Not
      // unmounting it leaks a fetch that resolves into a dead DOM.
      backlogPanel.unmount();
      steeringCard.unmount();
      if (container && onBacklogFocus) container.removeEventListener('td:focus', onBacklogFocus);
      if (container && onBacklogChanged) container.removeEventListener('td:changed', onBacklogChanged);
      onBacklogFocus = onBacklogChanged = null;
      container = null;
      document.title = 'Mission Control';
    },
  };
}

export default createPanel();

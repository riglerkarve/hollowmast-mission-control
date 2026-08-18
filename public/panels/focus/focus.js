import { renderBarChart } from '/shared.js';

const DURATIONS = { work: 25 * 60, short: 5 * 60, long: 15 * 60 };
const RING_CIRCUMFERENCE = 2 * Math.PI * 100;
const DAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

const TEMPLATE = `
  <div class="panel">
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

    <section class="card">
      <h2>What are you working on?</h2>
      <p class="task-source-note">Straight from the backlog — this is the same list the
        Backlog panel shows, not a second copy. Pick one and the timer records against it.
        Adding and closing items stays in Backlog: one list, one writer.</p>
      <div class="task-filter">
        <input type="search" id="taskSearch" class="task-search" placeholder="Filter…" autocomplete="off">
        <label class="task-mine"><input type="checkbox" id="taskMineOnly" checked> yours only</label>
      </div>
      <ul id="taskList" class="task-list"></ul>
      <p class="empty-hint" id="emptyHint">Nothing open in the backlog.</p>
    </section>

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
    </section>
  </div>

  <div id="celebrateOverlay" class="celebrate-overlay">
    <div class="celebrate-card">
      <div class="celebrate-emoji">🎉</div>
      <div class="celebrate-text" id="celebrateText">Session complete!</div>
    </div>
  </div>
`;

async function api(path, options) {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) throw new Error(`API ${path} failed: ${res.status}`);
  if (res.status === 204) return null;
  return res.json();
}

function createPanel() {
  let el = {};
  let tasks = [];
  let mode = 'work';
  let secondsLeft = DURATIONS.work;
  let running = false;
  let tickHandle = null;
  let activeTaskId = null;

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

  // READ-ONLY over the backlog. No add, no complete, no delete here — those live in the
  // Backlog panel. A second surface that writes the same list is two owners for "what is
  // there to do", which is the defect this change exists to remove, and it would be absurd
  // to fix it by introducing it again one card lower.
  function renderTasks() {
    el.taskList.innerHTML = '';

    const q = (el.taskSearch.value || '').trim().toLowerCase();
    const mineOnly = el.taskMineOnly.checked;
    const shown = tasks.filter((t) => {
      if (mineOnly && t.owner !== 'YOU') return false;
      if (q && !String(t.title).toLowerCase().includes(q)) return false;
      return true;
    });

    // Three states, not two: nothing open at all, nothing matching the filter, and a list.
    // "No results" and "nothing to do" are very different things to read at 9am.
    el.emptyHint.style.display = shown.length === 0 ? 'block' : 'none';
    if (shown.length === 0) {
      el.emptyHint.textContent = tasks.length === 0
        ? 'Nothing open in the backlog.'
        : `None of the ${tasks.length} open items match that filter.`;
    }

    shown.forEach((task) => {
      const li = document.createElement('li');
      li.className = 'task-item' + (task.id === activeTaskId ? ' active-task' : '');

      const pri = document.createElement('span');
      pri.className = `task-pri task-pri-${String(task.priority || '').toLowerCase()}`;
      pri.textContent = task.priority || '';

      const text = document.createElement('span');
      text.className = 'task-text';
      text.textContent = task.title;
      text.title = 'Click to work on this';
      text.addEventListener('click', () => setActiveTask(task.id));

      const owner = document.createElement('span');
      owner.className = 'task-owner';
      owner.textContent = task.owner === 'YOU' ? 'yours' : String(task.owner || '').toLowerCase();

      li.append(pri, text, owner);
      el.taskList.appendChild(li);
    });
  }

  async function loadTasks() {
    // Asks the todo module's own route. The focus panel never reads todo_items directly.
    const body = await api('/todo/items?status=open');
    tasks = (body.items || []).sort((a, b) => String(a.priority).localeCompare(String(b.priority)));
    renderTasks();
  }

  function setActiveTask(id) {
    activeTaskId = activeTaskId === id ? null : id;
    renderTasks();
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
      await api('/sessions', {
        method: 'POST',
        // todoId, not taskId. activeTaskId now holds a backlog id ('49', 'M3'), and the
        // old field expects an INTEGER tasks.id -- sending it there would silently store
        // null and the session would record no subject at all.
        body: JSON.stringify({ todoId: activeTaskId, kind: 'work', durationMinutes: DURATIONS.work / 60 }),
      });
      await Promise.all([loadTasks(), loadStats()]);
      celebrate('Session complete! Take a break 🎉');
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
    mount(container) {
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
        taskSearch: container.querySelector('#taskSearch'),
        taskMineOnly: container.querySelector('#taskMineOnly'),
        taskList: container.querySelector('#taskList'),
        emptyHint: container.querySelector('#emptyHint'),
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
      // Filtering is local to the already-loaded list, so it never re-queries the backlog
      // on a keystroke.
      el.taskSearch.addEventListener('input', renderTasks);
      el.taskMineOnly.addEventListener('change', renderTasks);

      renderTimer();
      if (running) {
        tickHandle = setInterval(tick, 1000);
      }
      loadTasks();
      loadStats();
    },

    unmount() {
      clearInterval(tickHandle);
      document.title = 'Mission Control';
    },
  };
}

export default createPanel();

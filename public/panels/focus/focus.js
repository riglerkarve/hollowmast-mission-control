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
      <h2>Tasks</h2>
      <form id="taskForm" class="task-form">
        <input type="text" id="taskInput" placeholder="What are you working on?" autocomplete="off" maxlength="200">
        <button type="submit" class="btn primary">Add</button>
      </form>
      <ul id="taskList" class="task-list"></ul>
      <p class="empty-hint" id="emptyHint">No tasks yet — add one to get started.</p>
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

  function renderTasks() {
    el.taskList.innerHTML = '';
    el.emptyHint.style.display = tasks.length === 0 ? 'block' : 'none';
    tasks.forEach((task) => {
      const li = document.createElement('li');
      li.className = 'task-item' + (task.done ? ' done' : '') + (task.id === activeTaskId ? ' active-task' : '');

      const checkbox = document.createElement('button');
      checkbox.className = 'task-checkbox' + (task.done ? ' checked' : '');
      checkbox.textContent = task.done ? '✓' : '';
      checkbox.setAttribute('aria-label', 'Toggle done');
      checkbox.addEventListener('click', () => toggleTask(task.id, !task.done));

      const text = document.createElement('span');
      text.className = 'task-text';
      text.textContent = task.text;
      text.title = 'Click to set as active task';
      text.addEventListener('click', () => setActiveTask(task.id));

      const pomo = document.createElement('span');
      pomo.className = 'task-pomo-count';
      pomo.textContent = task.pomodoros ? `🍅 ${task.pomodoros}` : '';

      const del = document.createElement('button');
      del.className = 'task-delete';
      del.textContent = '×';
      del.setAttribute('aria-label', 'Delete task');
      del.addEventListener('click', () => deleteTask(task.id));

      li.append(checkbox, text, pomo, del);
      el.taskList.appendChild(li);
    });
  }

  async function loadTasks() {
    tasks = await api('/tasks');
    renderTasks();
  }

  async function toggleTask(id, done) {
    await api(`/tasks/${id}`, { method: 'PATCH', body: JSON.stringify({ done }) });
    await loadTasks();
  }

  function setActiveTask(id) {
    activeTaskId = activeTaskId === id ? null : id;
    renderTasks();
  }

  async function deleteTask(id) {
    await api(`/tasks/${id}`, { method: 'DELETE' });
    if (activeTaskId === id) activeTaskId = null;
    await loadTasks();
  }

  async function handleAddTask(e) {
    e.preventDefault();
    const text = el.taskInput.value.trim();
    if (!text) return;
    el.taskInput.value = '';
    await api('/tasks', { method: 'POST', body: JSON.stringify({ text }) });
    await loadTasks();
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
        body: JSON.stringify({ taskId: activeTaskId, kind: 'work', durationMinutes: DURATIONS.work / 60 }),
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
        taskForm: container.querySelector('#taskForm'),
        taskInput: container.querySelector('#taskInput'),
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
      el.taskForm.addEventListener('submit', handleAddTask);

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

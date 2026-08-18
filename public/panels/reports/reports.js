import { renderBarChart } from '/shared.js';

const TEMPLATE = `
  <div class="panel panel-wide">
    <div class="panel-header">
      <h1>Reports</h1>
      <div class="badge" id="sinceBadge">
        <span class="badge-icon">📅</span>
        <span id="sinceText">—</span>
      </div>
    </div>

    <section class="card" id="rpBriefingCard">
      <div class="rp-brief-head">
        <h2>This morning's briefing</h2>
        <span class="rp-brief-when" id="rpBriefWhen"></span>
      </div>
      <div id="rpBriefing"></div>

      <div class="rp-say">
        <button class="btn" id="rpSayBtn">Say it out loud</button>
        <span class="rp-say-line" id="rpSayLine"></span>
      </div>
    </section>

    <section class="card">
      <div class="mode-tabs" id="rangeTabs">
        <button class="mode-tab active" data-range="30d">Last 30 Days</button>
        <button class="mode-tab" data-range="12m">Last 12 Months</button>
      </div>
      <div class="stats-summary">
        <div class="stat-block">
          <span class="stat-value" id="rangeSessions">0</span>
          <span class="stat-label">sessions</span>
        </div>
        <div class="stat-block">
          <span class="stat-value" id="rangeMinutes">0</span>
          <span class="stat-label">focus minutes</span>
        </div>
      </div>
      <div class="bar-chart" id="reportChart"></div>
    </section>

    <section class="card">
      <h2>All-Time Totals</h2>
      <div class="stats-summary">
        <div class="stat-block">
          <span class="stat-value" id="allTimeSessions">0</span>
          <span class="stat-label">total sessions</span>
        </div>
        <div class="stat-block">
          <span class="stat-value" id="allTimeHours">0</span>
          <span class="stat-label">total hours</span>
        </div>
      </div>
    </section>

    <section class="card">
      <h2>Export</h2>
      <div class="export-row">
        <p class="empty-hint">Download every logged session as a CSV file for your own records or backup.</p>
        <a class="btn primary" href="/api/stats/export" download>Download CSV</a>
      </div>
    </section>
  </div>
`;

function monthLabel(monthKey) {
  const [y, m] = monthKey.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'short' });
}

async function api(path) {
  const res = await fetch(`/api${path}`);
  if (!res.ok) throw new Error(`API ${path} failed: ${res.status}`);
  return res.json();
}

function createPanel() {
  let el = {};
  let range = '30d';

  async function loadRange() {
    if (range === '30d') {
      const data = await api('/stats/daily?days=30');
      el.rangeSessions.textContent = data.totalSessions;
      el.rangeMinutes.textContent = data.totalMinutes;
      el.reportChart.classList.add('compact');
      renderBarChart(el.reportChart, data.days, {
        value: (d) => d.count,
        tooltip: (d) => `${d.date}: ${d.count === 1 ? '1 session' : `${d.count} sessions`}`,
      });
    } else {
      const data = await api('/stats/monthly?months=12');
      el.rangeSessions.textContent = data.totalSessions;
      el.rangeMinutes.textContent = data.totalMinutes;
      el.reportChart.classList.remove('compact');
      renderBarChart(el.reportChart, data.months, {
        value: (m) => m.count,
        label: (m) => monthLabel(m.month),
        tooltip: (m) => `${monthLabel(m.month)}: ${m.count === 1 ? '1 session' : `${m.count} sessions`}`,
      });
    }
  }

  async function loadAllTime() {
    const data = await api('/stats/all-time');
    el.allTimeSessions.textContent = data.totalSessions;
    el.allTimeHours.textContent = (data.totalMinutes / 60).toFixed(1);
    el.sinceText.textContent = data.trackingSince ? `Tracking since ${data.trackingSince}` : 'No sessions yet';
  }

  // The briefing is generated at 07:00 into reports/ and the database, and until now was
  // visible NOWHERE in the dashboard — you had to open a markdown file to read the one
  // artefact that answers "what did I actually get done". Backlog #45. It leads this
  // panel because focus statistics are one input to that question, not the answer.
  //
  // ESCAPE FIRST, THEN MARKUP. The briefing quotes ledger data, and counterparty names
  // come from bank descriptors — text nobody here authored. Everything is HTML-escaped
  // before a single tag is introduced, so the only tags in the output are ours.
  const rpEsc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  const rpInline = (t) => rpEsc(t)
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|\s)_([^_]+)_/g, '$1<i>$2</i>');

  function rpMarkdown(md) {
    const out = [];
    let list = null;
    let table = null;

    const closeList = () => {
      if (list) { out.push(`<ul class="rp-list">${list.join('')}</ul>`); list = null; }
    };
    const closeTable = () => {
      if (!table) return;
      const [head, ...rows] = table;
      out.push(`<div class="rp-tablewrap"><table class="rp-table"><thead><tr>${
        head.map((c) => `<th>${rpInline(c)}</th>`).join('')
      }</tr></thead><tbody>${
        rows.map((r) => `<tr>${r.map((c) => `<td>${rpInline(c)}</td>`).join('')}</tr>`).join('')
      }</tbody></table></div>`);
      table = null;
    };

    for (const raw of String(md || '').split('\n')) {
      const line = raw.trimEnd();

      if (/^\|/.test(line)) {
        const cells = line.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
        if (cells.every((c) => /^-{2,}$/.test(c))) continue;   // the |---|---| separator row
        closeList();
        (table = table || []).push(cells);
        continue;
      }
      closeTable();

      if (/^- /.test(line)) { (list = list || []).push(`<li>${rpInline(line.slice(2))}</li>`); continue; }
      closeList();

      if (!line) continue;
      if (/^# /.test(line)) { out.push(`<h3 class="rp-b-h1">${rpInline(line.slice(2))}</h3>`); continue; }
      if (/^## /.test(line)) { out.push(`<h4 class="rp-b-h2">${rpInline(line.slice(3))}</h4>`); continue; }
      if (/^---+$/.test(line)) { out.push('<hr class="rp-hr">'); continue; }
      out.push(`<p class="rp-p">${rpInline(line)}</p>`);
    }
    closeList();
    closeTable();
    return out.join('');
  }

  async function loadBriefing(container) {
    const box = container.querySelector('#rpBriefing');
    const when = container.querySelector('#rpBriefWhen');
    let d;
    try {
      const r = await fetch('/api/briefing/latest');
      if (r.status === 404) {
        // Never generated and failed-to-generate are different states, and only one is a bug.
        box.innerHTML = '<p class="empty-hint">No briefing has been generated yet. '
          + 'MissionControl-Briefing runs at 07:00; until it has run once there is nothing '
          + 'to show — that is absence, not failure.</p>';
        return;
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      d = await r.json();
    } catch (err) {
      // .rp-error, NOT .empty-hint. The 404 branch above gets this exactly right and says so
      // in its own comment -- and then this branch rendered a real failure in the same muted
      // style as "nothing generated yet", so the two states the code carefully separates
      // looked identical on screen.
      box.innerHTML = `<p class="rp-error">Could not read the briefing: ${rpEsc(err.message)}`
        + ' &mdash; that is a failure to look, not a report that no briefing exists.</p>';
      return;
    }
    when.textContent = d.date || '';
    box.innerHTML = rpMarkdown(d.markdown);
  }

  return {
    mount(container) {
      range = '30d';
      container.innerHTML = TEMPLATE;
      el = {
        rangeTabs: container.querySelectorAll('.mode-tab'),
        rangeSessions: container.querySelector('#rangeSessions'),
        rangeMinutes: container.querySelector('#rangeMinutes'),
        reportChart: container.querySelector('#reportChart'),
        allTimeSessions: container.querySelector('#allTimeSessions'),
        allTimeHours: container.querySelector('#allTimeHours'),
        sinceText: container.querySelector('#sinceText'),
      };

      el.rangeTabs.forEach((tab) => {
        tab.addEventListener('click', () => {
          range = tab.dataset.range;
          el.rangeTabs.forEach((t) => t.classList.toggle('active', t === tab));
          loadRange();
        });
      });

      // Backlog #22, Major Tom. ON REQUEST ONLY — the voice never speaks unprompted, and
      // the words are shown BEFORE the button is pressed so you are never surprised by
      // what comes out of the speakers.
      const sayBtn = container.querySelector('#rpSayBtn');
      const sayLine = container.querySelector('#rpSayLine');

      fetch('/api/briefing/speak', { headers: { 'x-mc-by': 'you' } })
        .then((r) => r.json())
        .then((d) => { sayLine.textContent = d.line ? `“${d.line}”` : ''; })
        .catch(() => { sayLine.textContent = 'could not compose a line'; });

      sayBtn.addEventListener('click', async () => {
        sayBtn.disabled = true;
        const was = sayBtn.textContent;
        sayBtn.textContent = 'Speaking…';
        try {
          const r = await fetch('/api/briefing/speak', {
            method: 'POST', headers: { 'x-mc-by': 'you' },
          });
          const d = await r.json();
          sayLine.textContent = d.line ? `“${d.line}”` : '';
          // Spoken and could-not-speak must not look the same. A silent machine with a
          // broken synthesiser would otherwise read as a successful quiet line.
          if (!d.spoken) sayLine.textContent += ' — not spoken: speech is unavailable on this machine.';
        } catch (err) {
          sayLine.textContent = `could not speak: ${err.message}`;
        } finally {
          sayBtn.disabled = false;
          sayBtn.textContent = was;
        }
      });

      loadRange();
      loadAllTime();
      loadBriefing(container);
    },

    unmount() {},
  };
}

export default createPanel();

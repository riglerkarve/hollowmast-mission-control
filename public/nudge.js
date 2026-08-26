// nudge.js — the shell-level prompts that live outside any one panel: monthly statement
// gathering, and the evening meal check. Both exist because "you have to remember to open
// the panel" is exactly the chore-with-a-nice-font the workspace gate rejects (CLAUDE.md).
//
// This renders into #nudgeBar, which sits above #panelRoot in index.html and is therefore
// never cleared by a panel switch — the one thing that must be true for a prompt to survive
// navigation. It reuses two capture surfaces that already exist and are already correct:
// lifestyle's month_end chores (for the statements) and lifestyle's intake count (for
// meals). No new table, no new module — a second owner for either figure is the one thing
// the module contract forbids outright.
//
// A dismiss ("later") only clears the render for this page view, exactly like the quiet
// curtain's override in shell.js — it is not persisted and not counted, because the moment
// a dismiss is tracked the feature becomes a judgement rather than a reminder. Only the real
// action (marking a chore done, logging meals) ever makes an item stop appearing on reload.

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function api(path, opts) {
  const res = await fetch(path, opts);
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error((body && body.error) || `HTTP ${res.status}`);
  return body;
}

// A month_end chore's own `state` only looks FORWARD to the next month-end (see
// decorateMonthEnd in lifestyle.js) — on the 1st it has already rolled over to a due date a
// whole month away, with no memory of whether last month's was ever done. So this checks the
// fact the chore's state deliberately doesn't: was it marked done since THIS calendar month
// started. Restricted to the first few days so it asks around the 1st, not all month.
const REMINDER_WINDOW_DAYS = 5;
const STATEMENT_CHORE_NAMES = ['UC statement', 'Bank & payment processor statements', 'Freetrade statement'];

function localToday() {
  // Matches the server's SQLite localtime convention (see lifestyle.js) closely enough for
  // a client-side date comparison — both just need the same YYYY-MM-DD 'today'.
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function statementItems() {
  const today = localToday();
  const dayOfMonth = Number(today.slice(8, 10));
  if (dayOfMonth > REMINDER_WINDOW_DAYS) return [];

  const firstOfMonth = `${today.slice(0, 7)}-01`;
  let data;
  try { data = await api('/api/lifestyle/chores'); } catch { return []; }
  if (data.state !== 'ok') return [];

  return data.chores
    .filter((c) => STATEMENT_CHORE_NAMES.includes(c.name))
    .filter((c) => !c.lastDone || c.lastDone < firstOfMonth)
    .map((c) => ({
      key: `chore-${c.id}`,
      text: `Gather ${c.name} for last month?`,
      action: 'Got it',
      run: () => api(`/api/lifestyle/chores/${c.id}/done`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-mc-by': 'you' }, body: '{}',
      }),
    }));
}

async function mealItem() {
  if (new Date().getHours() < 18) return null;   // evening only
  let data;
  try { data = await api('/api/lifestyle/intake?days=1'); } catch { return null; }
  const todayRow = data.series && data.series[data.series.length - 1];
  if (!todayRow || todayRow.recorded) return null;

  return {
    key: 'meals',
    text: 'How many meals today?',
    quickAmounts: [0, 1, 2, 3],
    run: (meals) => api('/api/lifestyle/intake', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-mc-by': 'you' },
      body: JSON.stringify({ meals }),
    }),
  };
}

export async function mountNudgeBar(root) {
  if (!root) return;

  // Respect quiet hours the same way shell.js's own curtain does — a wellbeing boundary
  // should not be undermined by a different module popping something up alongside it.
  try {
    const q = await api('/api/wellbeing/quiet');
    if (q.active) { root.innerHTML = ''; return; }
  } catch { /* a failed check must not block the nudge bar either */ }

  const [statements, meal] = await Promise.all([statementItems(), mealItem()]);
  const items = [...statements, ...(meal ? [meal] : [])];
  if (!items.length) { root.innerHTML = ''; return; }

  root.innerHTML = items.map((item) => `
    <div class="nudge-item" data-key="${esc(item.key)}">
      <span class="nudge-text">${esc(item.text)}</span>
      <span class="nudge-actions">
        ${item.quickAmounts
          ? item.quickAmounts.map((n) => `<button class="btn nudge-btn" data-amount="${n}">${n}</button>`).join('')
          : `<button class="btn primary nudge-btn" data-run>${esc(item.action)}</button>`}
        <button class="nudge-close" data-dismiss aria-label="Not now">&times;</button>
      </span>
    </div>`).join('');

  for (const item of items) {
    const row = root.querySelector(`[data-key="${item.key}"]`);
    if (!row) continue;
    row.querySelector('[data-dismiss]').addEventListener('click', () => row.remove());
    if (item.quickAmounts) {
      row.querySelectorAll('[data-amount]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          try { await item.run(Number(btn.dataset.amount)); row.remove(); } catch { /* leave it for a retry */ }
        });
      });
    } else {
      row.querySelector('[data-run]').addEventListener('click', async () => {
        try { await item.run(); row.remove(); } catch { /* leave it for a retry */ }
      });
    }
  }
}

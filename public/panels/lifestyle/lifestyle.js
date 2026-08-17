// Lifestyle. Reads only /api/lifestyle.
//
// Two halves, and the second one has rules.
//
// CHORES: the panel never holds a schedule. Every "due in 3 days" on screen came from the
// server this render, computed from last-done + interval. There is nothing to tick off and
// nothing to keep up to date — the only control is "Did it".
//
// MEALS: counts, and nothing else. No streak, no percentage, no grade, no colour that
// turns red, and no sentence that tells you how you are doing. A day you did not record is
// drawn as a day you did not record — not as a day you fell short. The floor is 1 because
// that is the number you set; the panel states it and does not argue about it.
//
// There is deliberately no polling, no reminder and no growing badge. An alert you learn
// to dismiss is worse than no alert, so this panel says what is true when you open it and
// is silent the rest of the time.

const TEMPLATE = `
  <div class="panel panel-wide">
    <div class="panel-header">
      <h1>Lifestyle</h1>
      <div class="badge"><span class="badge-icon">◷</span><span id="lfToday">—</span></div>
    </div>

    <div class="lf-split">
      <section class="card">
        <h2 class="lf-h2">Chores</h2>
        <p class="lf-hint">You only ever record “did it”. What is due is worked out from the
        last time you did it plus the interval, every time this loads.</p>
        <div id="lfChores"></div>
        <p class="lf-echo" id="lfChoreEcho"></p>
        <form class="lf-add" id="lfAdd">
          <input id="lfName" class="lf-in" placeholder="Add a chore" required>
          <input id="lfEvery" class="lf-in lf-every" type="number" min="1" max="365" step="1" placeholder="every N days" required>
          <button class="btn" type="submit">Add</button>
        </form>
      </section>

      <section class="card">
        <h2 class="lf-h2">Meals</h2>
        <div id="lfCapture"></div>
        <p class="lf-echo" id="lfEcho"></p>
        <div id="lfIntake"></div>
      </section>
    </div>
  </div>
`;

let root = null;
let onKey = null;
let onVisible = null;
// Bumped on mount and on unmount. Every async handler checks it before touching the DOM,
// so a slow fetch that lands after you switch panels writes into nothing rather than into
// a dead tree.
let token = 0;

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

async function api(p, opts) {
  const res = await fetch(`/api/lifestyle${p}`, opts);
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error((body && body.error) || `HTTP ${res.status}`);
  return body;
}

// Both echo lines live outside the containers that get re-rendered, so a message survives
// the reload that follows the action which produced it.
function echo(id, text, kind) {
  const el = root && root.querySelector(id);
  if (el) { el.textContent = text; el.className = `lf-echo ${kind || ''}`; }
}

// --------------------------------------------------------------------------- chores
// One line of plain English per chore, built from the numbers the server derived. Nothing
// here recomputes a due date — if this disagreed with the API it would be a second owner
// of the same figure, and the two would drift without either erroring.
function choreLine(c) {
  if (c.state === 'never done') {
    return `Never recorded${c.daysSinceAdded > 0 ? ` · added ${plural(c.daysSinceAdded, 'day')} ago` : ' · added today'}`;
  }
  if (c.dueInDays < 0) return `Overdue by ${plural(c.overdueByDays, 'day')} · last done ${c.lastDone}`;
  if (c.dueInDays === 0) return `Due today · last done ${c.lastDone}`;
  return `Due in ${plural(c.dueInDays, 'day')} · ${c.nextDueOn}`;
}

// The measured half: how often it actually comes round, against the interval you set. Only
// rendered once there are enough gaps to take a median of, and it carries its own sample
// size so the figure can be judged rather than just believed.
function typicalLine(c) {
  if (!c.typical || c.typical.medianDays === null) return '';
  const drift = c.typical.medianDays - c.intervalDays;
  const cmp = drift === 0
    ? 'the same as the interval you set'
    : `${plural(Math.abs(drift), 'day')} ${drift > 0 ? 'longer' : 'shorter'} than the ${plural(c.intervalDays, 'day')} you set`;
  return `<span class="lf-typ">Typically every ${plural(c.typical.medianDays, 'day')} — ${cmp}
    <span class="lf-dim">(median of ${plural(c.typical.gapsCounted, 'gap')})</span></span>`;
}

function choreItem(c) {
  return `
    <li class="lf-chore lf-${c.state.replace(/\s+/g, '-')}">
      <span class="lf-c-main">
        <span class="lf-c-name">${esc(c.name)}${c.active ? '' : '<span class="lf-tag">paused</span>'}</span>
        <span class="lf-c-when">${esc(choreLine(c))}</span>
        ${typicalLine(c)}
      </span>
      <span class="lf-c-acts">
        <button class="btn lf-did" data-id="${c.id}">Did it</button>
        <button class="lf-del" data-del="${c.id}" title="Remove this chore and its history">×</button>
      </span>
    </li>`;
}

function group(title, items, sub) {
  if (!items.length) return '';
  return `<h3 class="lf-h3">${esc(title)}${sub ? ` <span class="lf-dim">${esc(sub)}</span>` : ''}</h3>
    <ul class="lf-chores">${items.map(choreItem).join('')}</ul>`;
}

function renderChores(d) {
  const el = root.querySelector('#lfChores');

  if (d.state === 'no-chores') {
    // "There are none" is a different sentence from "that did not load", and the two must
    // not look the same on screen.
    el.innerHTML = `<p class="empty-hint">${esc(d.message)}</p>`;
    return;
  }

  const g = d.chores;
  el.innerHTML = `
    ${group('Due', g.due)}
    ${group('Never recorded', g.neverDone, 'no last-done date to count from')}
    ${group('Coming up', g.soon, `within ${plural(d.soonWithinDays, 'day')}`)}
    ${group('Not due', g.ok)}
    ${d.counts.paused ? group('Paused', d.paused, 'excluded from the groups above') : ''}
    <p class="lf-hint lf-dim">${esc(d.derived)}</p>
  `;

  el.querySelectorAll('.lf-did').forEach((b) => b.addEventListener('click', async () => {
    const mine = token;
    b.disabled = true;
    let msg = null;
    try {
      const r = await api(`/chores/${b.dataset.id}/done`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      });
      // The value comes straight back: what was recorded, and when it next comes round.
      msg = r.duplicate
        ? [`${r.name}: ${r.duplicateNote}`, 'ok']
        : [`${r.name} recorded for ${r.recordedOn}. Next due ${r.nextDueOn}.`, 'ok'];
    } catch (err) {
      msg = [`Not recorded: ${err.message}`, 'bad'];
    }
    if (mine !== token) return;
    await load();                        // reload first, then speak — otherwise the
    if (mine !== token) return;          // re-render wipes the line it just produced
    echo('#lfChoreEcho', msg[0], msg[1]);
  }));

  el.querySelectorAll('.lf-del').forEach((b) => b.addEventListener('click', async () => {
    const mine = token;
    let msg = null;
    try {
      const r = await api(`/chores/${b.dataset.del}`, { method: 'DELETE' });
      // Never silent about the cascade: deleting a chore takes its history with it.
      msg = r.deletedHistoryRows ? [r.note, 'ok'] : ['Removed.', 'ok'];
    } catch (err) {
      msg = [`Not deleted: ${err.message}`, 'bad'];
    }
    if (mine !== token) return;
    await load();
    if (mine !== token) return;
    echo('#lfChoreEcho', msg[0], msg[1]);
  }));
}

// --------------------------------------------------------------------------- meals
function renderIntake(d) {
  const cap = root.querySelector('#lfCapture');
  const el = root.querySelector('#lfIntake');
  const c = d.counts;
  const todayRow = d.series[d.series.length - 1];

  cap.innerHTML = `
    <p class="lf-hint">How many proper meals today? Press <kbd>0</kbd>–<kbd>3</kbd>, or click.
    Your floor is ${plural(d.floorMeals, 'meal')} a day.</p>
    <div class="lf-meals">
      ${[0, 1, 2, 3].map((n) => `<button class="lf-meal" data-meals="${n}">${n}${n === 3 ? '+' : ''}</button>`).join('')}
    </div>
    <p class="lf-today">${todayRow.recorded
      ? `Today: ${plural(todayRow.meals, 'meal')} recorded.`
      : 'Today: not recorded.'}</p>
  `;
  cap.querySelectorAll('.lf-meal').forEach((b) => {
    b.addEventListener('click', () => saveMeals(Number(b.dataset.meals)));
  });

  // Three visual states, and they differ by fill, by border style AND by the presence of a
  // mark — never by shade alone. Three tints of one colour could not be told apart when
  // that was measured elsewhere in this dashboard, and colouring a short day red would turn
  // a private note to yourself into a verdict.
  const cell = (s) => {
    const cls = !s.recorded ? 'none' : (s.atOrAboveFloor ? 'met' : 'below');
    const label = !s.recorded
      ? 'no record'
      : `${plural(s.meals, 'meal')}${s.atOrAboveFloor ? '' : ` (below ${d.floorMeals})`}`;
    return `<span class="lf-day lf-${cls}" title="${esc(s.date)} — ${esc(label)}"></span>`;
  };

  el.innerHTML = `
    <h3 class="lf-h3">Last ${plural(d.days, 'day')} <span class="lf-dim">${esc(d.from)} to ${esc(d.to)}</span></h3>
    <div class="lf-strip">${d.series.map(cell).join('')}</div>
    <ul class="lf-legend">
      <li><span class="lf-day lf-met"></span> ${d.floorMeals} or more</li>
      <li><span class="lf-day lf-below"></span> recorded, fewer</li>
      <li><span class="lf-day lf-none"></span> not recorded</li>
    </ul>
    <ul class="lf-facts">
      <li><b>${c.daysRecorded}</b> of the last ${c.daysInWindow} days recorded</li>
      <li><b>${c.daysAtOrAboveFloor}</b> at or above ${plural(d.floorMeals, 'meal')}</li>
      <li><b>${c.daysBelowFloor}</b> below it</li>
      <li><b>${c.daysNotRecorded}</b> with no record</li>
    </ul>
    <p class="lf-hint lf-dim">${esc(d.note)}</p>
  `;
}

async function saveMeals(n) {
  const mine = token;
  echo('#lfEcho', 'saving…', '');
  try {
    const r = await api('/intake', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ meals: n }),
    });
    const d = await api('/intake?days=14');
    if (mine !== token) return;
    renderIntake(d);
    // Recall, not assessment: four counts of rows that are already in the table. Nothing
    // here congratulates, encourages, warns or reacts to what the numbers happen to be.
    echo('#lfEcho', `${r.date}: ${plural(r.meals, 'meal')}. Last 7 days — `
      + `${r.recall.daysRecordedInLast7} recorded, ${r.recall.daysAtOrAboveFloorInLast7} at or above ${r.floorMeals}, `
      + `${r.recall.daysBelowFloorInLast7} below, ${r.recall.daysNotRecordedInLast7} with no record.`, 'ok');
  } catch (err) {
    if (mine === token) echo('#lfEcho', `Not saved: ${err.message}`, 'bad');
  }
}

// --------------------------------------------------------------------------- load
async function load() {
  const mine = token;
  let d;
  try {
    d = await api('/');
  } catch (err) {
    if (mine !== token) return;
    // A failed request says so, in its own words, in both halves. It must never be
    // mistaken for "nothing due" and "nothing eaten" — which is exactly what a silent
    // empty render would claim.
    root.querySelector('#lfChores').innerHTML = `<p class="lf-error">Could not load your chores: ${esc(err.message)}</p>`;
    root.querySelector('#lfCapture').innerHTML = '';
    root.querySelector('#lfIntake').innerHTML = `<p class="lf-error">Could not load your meal records: ${esc(err.message)}</p>`;
    root.querySelector('#lfToday').textContent = 'not loaded';
    return;
  }
  if (mine !== token) return;

  root.querySelector('#lfToday').textContent = d.counts.due
    ? `${plural(d.counts.due, 'chore')} due`
    : (d.counts.total ? 'nothing due' : 'no chores');

  renderChores(d);
  renderIntake(d.intake);
}

export default {
  mount(el) {
    root = el;
    token += 1;
    el.innerHTML = TEMPLATE;

    el.querySelector('#lfAdd').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const mine = token;
      const name = el.querySelector('#lfName').value.trim();
      const every = Number(el.querySelector('#lfEvery').value);
      if (!name || !Number.isInteger(every)) return;
      try {
        await api('/chores', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name, intervalDays: every }),
        });
        if (mine !== token) return;
        el.querySelector('#lfName').value = '';
        el.querySelector('#lfEvery').value = '';
        await load();
        if (mine !== token) return;
        echo('#lfChoreEcho', `Added “${name}”, every ${plural(every, 'day')}. It stays "never recorded" until the first time you record it.`, 'ok');
      } catch (err) {
        if (mine === token) echo('#lfChoreEcho', `Not added: ${err.message}`, 'bad');
      }
    });

    // One keystroke, as the gate requires. Ignored while typing, so "had 2 today" in a text
    // field cannot silently record a 2.
    onKey = (ev) => {
      const t = ev.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
      if (ev.key >= '0' && ev.key <= '3') { ev.preventDefault(); saveMeals(Number(ev.key)); }
    };
    document.addEventListener('keydown', onKey);

    // Refreshes when you come back to the tab. This is not polling and not a reminder: it
    // fires only when you are already looking, so a day rolling over cannot leave stale due
    // dates on screen without anything ever demanding your attention.
    onVisible = () => { if (!document.hidden && root) load(); };
    document.addEventListener('visibilitychange', onVisible);

    load();
  },

  // Not optional. A document-level key handler left behind would keep recording meals from
  // whatever panel you switched to, and the visibility handler would fetch against a dead
  // DOM. Bumping the token also strands anything still in flight.
  unmount() {
    token += 1;
    if (onKey) document.removeEventListener('keydown', onKey);
    if (onVisible) document.removeEventListener('visibilitychange', onVisible);
    onKey = null;
    onVisible = null;
    root = null;
  },
};

// Goals. Reads only /api/goals.
//
// Every goal here is multi-step admin that stalls, and it stalls for one reason: the next
// action is never obvious. So the loudest thing on each card is a single sentence saying
// what to do next, and that sentence is computed on the server from the steps. The panel
// does not work it out, does not cache it and does not have a second opinion about it —
// if it did, the two would disagree eventually and neither would error.
//
// Three rules held throughout, all of them the codebase's rather than mine:
//   - A cost that is not known prints "cost not set". It never prints as blank and never
//     as £0.00, because both of those read as "free". The cost-to-finish figure always
//     carries the number of unpriced steps next to it, so it can never be mistaken for a
//     complete total.
//   - There is no percentage bar and no progress ring. Steps done and steps total, as
//     counts. A bar at 50% implies a schedule, and there is no schedule in this data.
//   - A failed fetch and an empty table are drawn differently and say which happened. The
//     four ways a read can fail are told apart in api() below, because "nothing here" that
//     is actually a broken parser is the one piece of bad news nobody investigates.
//
// No timers, no polling, no badge. The panel says what is true when you open it.

const TEMPLATE = `
  <div class="panel panel-wide gl-panel">
    <div class="panel-header">
      <h1>Goals</h1>
      <div class="badge"><span class="badge-icon">◷</span><span id="glToday">—</span></div>
    </div>

    <section class="card">
      <div id="glErr"></div>
      <div id="glTop"></div>
    </section>

    <div id="glList"></div>

    <section class="card">
      <h2 class="gl-h2">Add a goal</h2>
      <form class="gl-add" id="glAddGoal">
        <input id="glTitle" class="gl-in wide" placeholder="What do you want to have done?" required>
        <input id="glTarget" class="gl-in date" type="date" title="Target date — optional, and nothing invents one">
        <button class="btn primary" type="submit">Add</button>
      </form>
      <p class="gl-note">A goal with no steps has no next action, and the card will say so
      rather than pretending. Add the steps and the next action appears on its own.</p>
    </section>
  </div>
`;

let root = null;
let onClick = null;
let onSubmit = null;
let onChange = null;
// Bumped on mount and unmount. Every async handler checks it before touching the DOM, so a
// slow fetch that lands after you switch panels writes into nothing rather than a dead tree.
let token = 0;
let filter = 'active';
// Which step lists you had open, so saving a cost does not collapse everything you were
// reading. Panel state only — nothing here is persisted or sent anywhere.
const opened = new Set();

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const gbp = (p) => `£${(p / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// The four ways this can fail are given different names on purpose. "Could not look" must
// never arrive looking like "looked, and there is nothing".
async function api(path, opts) {
  let res;
  try {
    res = await fetch(`/api/goals${path}`, opts);
  } catch (e) {
    const err = new Error(`could not reach the server — ${e.message}`);
    err.kind = 'unreachable';
    throw err;
  }
  let body = null;
  try { body = await res.json(); } catch { body = null; }

  if (!res.ok) {
    const err = new Error((body && body.error) || `HTTP ${res.status}`);
    err.kind = body && body.failed ? 'query-failed' : 'rejected';
    throw err;
  }
  if (body === null) {
    const err = new Error('the server answered with something that was not JSON');
    err.kind = 'unreadable';
    throw err;
  }
  return body;
}

function errorBox(err, headline, offerRetry) {
  const what = {
    unreachable: 'The dashboard server did not answer.',
    'query-failed': 'The server reached the database and the query failed.',
    rejected: 'The server refused that.',
    unreadable: 'The server answered, but not with data this panel can read.',
  }[err.kind] || 'Something failed and it is not clear what.';
  return `<p class="gl-error"><b>${esc(headline)}</b> ${esc(what)}
    <br>${esc(err.message)}
    ${offerRetry ? `<br>This is a failure, not an empty list — nothing was read, so the absence
    of goals below does not mean there are none.
    <span class="gl-next-do"><button class="btn gl-mini" type="button" data-act="retry">Try again</button></span>` : ''}</p>`;
}

// ---------------------------------------------------------------------------- rendering
function targetChip(g) {
  if (g.targetState === 'unreadable') {
    return `<span class="gl-chip overdue">target date unreadable</span>`;
  }
  if (g.daysToTarget === null) return '';
  if (g.daysToTarget < 0) return `<span class="gl-chip overdue">${plural(-g.daysToTarget, 'day')} past ${esc(g.targetDate)}</span>`;
  if (g.daysToTarget === 0) return `<span class="gl-chip overdue">target is today</span>`;
  return `<span class="gl-chip on-target">${plural(g.daysToTarget, 'day')} to ${esc(g.targetDate)}</span>`;
}

function stepRow(s) {
  const costValue = s.costPence === null || s.costPence === undefined ? '' : (s.costPence / 100).toFixed(2);
  return `
    <li class="gl-step${s.done ? ' done' : ''}">
      <span class="gl-step-pos">${s.position}</span>
      <span class="gl-step-body">
        <span class="gl-step-title">${esc(s.title)}</span>
        <span class="gl-step-meta">
          <span class="gl-cost${s.costPence === null || s.costPence === undefined ? '' : ' set'}">${
            s.costPence === null || s.costPence === undefined ? 'cost not set' : gbp(s.costPence)}</span>
          ${s.blockedBy ? `<span class="gl-blockchip">waiting on ${esc(s.blockedBy)}</span>` : ''}
          ${s.done ? `<span class="gl-donechip">done ${esc(s.doneOn)}</span>` : ''}
        </span>
        ${s.note ? `<span class="gl-step-note">${esc(s.note)}</span>` : ''}
      </span>
      <form class="gl-step-acts" data-savestep="${s.id}">
        <button class="btn gl-mini" type="button" data-act="${s.done ? 'undone' : 'done'}" data-step="${s.id}">${s.done ? 'Undo' : 'Did it'}</button>
        <input class="gl-in money" name="cost" type="number" step="0.01" min="0" placeholder="£" value="${costValue}" title="Cost in pounds. Empty means not known, which is not the same as free.">
        <input class="gl-in" name="blockedBy" placeholder="waiting on…" value="${esc(s.blockedBy || '')}" title="What this step is waiting on. Empty means nothing.">
        <button class="btn gl-mini" type="submit">Save</button>
        <button class="gl-x" type="button" data-act="delstep" data-step="${s.id}" title="Remove step">×</button>
      </form>
    </li>`;
}

function goalCard(g) {
  const cls = g.stepsTotal === 0 ? 'is-empty' : g.blocked ? 'is-blocked' : 'is-actionable';
  const open = opened.has(g.id) ? ' open' : '';

  const costFact = g.costToFinishPence === null
    ? `<span>cost to finish <b>not known</b></span>`
    : `<span>cost to finish <b>${gbp(g.costToFinishPence)}</b>${g.costComplete ? '' : ' so far'}</span>`;

  return `
    <li class="gl-goal ${cls}" data-goal="${g.id}">
      <div class="gl-top">
        <h2 class="gl-title">${esc(g.title)}</h2>
        <span class="gl-top-chips">
          ${targetChip(g)}
          ${g.status !== 'active' ? `<span class="gl-chip">${esc(g.status)}</span>` : ''}
        </span>
      </div>
      ${g.why ? `<p class="gl-why">${esc(g.why)}</p>` : ''}

      <p class="gl-next${g.nextAction ? '' : ' none'}">${esc(g.sentence)}
        ${g.nextAction ? `<span class="gl-next-do">
          <button class="btn gl-mini" type="button" data-act="done" data-step="${g.nextAction.id}">Mark that done</button>
        </span>` : ''}
      </p>

      ${g.laterBlocks.length ? `<p class="gl-blockline">Further on: ${
        g.laterBlocks.map((b) => `step ${b.position} is waiting on ${esc(b.blockedBy)}`).join('; ')}.</p>` : ''}

      <div class="gl-facts">
        <span><b>${g.stepsDone}</b> of <b>${g.stepsTotal}</b> steps done</span>
        ${costFact}
        ${g.costUnknownSteps ? `<span class="gl-unpriced">${plural(g.costUnknownSteps, 'remaining step')} with no cost set</span>` : ''}
      </div>
      <p class="gl-note">${esc(g.costBasis)}</p>

      <details class="gl-steps" data-details="${g.id}"${open}>
        <summary>Steps and settings — ${plural(g.stepsTotal, 'step')}, ${g.stepsDone} done</summary>
        ${g.stepsTotal
    ? `<ul class="gl-step-list">${g.steps.map(stepRow).join('')}</ul>`
    : '<p class="empty-hint">No steps on this goal yet. Until there are, there is no next action to work out.</p>'}

        <form class="gl-row" data-addstep="${g.id}">
          <input class="gl-in wide" name="title" placeholder="Add the next step" required>
          <input class="gl-in money" name="cost" type="number" step="0.01" min="0" placeholder="£">
          <button class="btn gl-mini" type="submit">Add step</button>
        </form>

        <form class="gl-row tight" data-savegoal="${g.id}">
          <input class="gl-in date" name="targetDate" type="date" value="${esc(g.targetDate || '')}">
          <select class="gl-select" name="status">
            ${['active', 'done', 'parked', 'abandoned'].map((s) =>
    `<option value="${s}"${s === g.status ? ' selected' : ''}>${s}</option>`).join('')}
          </select>
          <button class="btn gl-mini" type="submit">Save goal</button>
          <button class="gl-x" type="button" data-act="delgoal" data-goal="${g.id}" title="Delete this goal and its steps">×</button>
        </form>
        ${g.allStepsDone && g.status === 'active'
    ? '<p class="gl-note">Every step is ticked. Setting the goal itself to done is your call — nothing here does it for you.</p>'
    : ''}
      </details>
    </li>`;
}

function render(d) {
  const top = root.querySelector('#glTop');
  const list = root.querySelector('#glList');
  root.querySelector('#glToday').textContent = d.today;

  const filterUI = `
    <div class="gl-row tight">
      <select class="gl-select" id="glFilter">
        ${[['active', 'active goals'], ['all', 'everything'], ['done', 'done'], ['parked', 'parked'], ['abandoned', 'abandoned']]
    .map(([v, label]) => `<option value="${v}"${v === d.filter ? ' selected' : ''}>${label}</option>`).join('')}
      </select>
      <span class="gl-tally">${d.counts.active} active · ${d.counts.done} done · ${d.counts.parked} parked · ${d.counts.abandoned} abandoned</span>
    </div>`;

  if (d.state === 'empty') {
    top.innerHTML = `${filterUI}<p class="empty-hint">${esc(d.message)}</p>
      <p class="gl-note">This is an empty list, and the server said so explicitly — it is not
      a failed read. A failure would be in an orange box saying which part failed.</p>`;
    list.innerHTML = '';
    return;
  }

  top.innerHTML = `
    ${filterUI}
    <div class="gl-counts">
      <span class="gl-count"><span class="gl-count-v">${d.actionableCount}</span><span class="gl-count-l">actionable today</span></span>
      <span class="gl-count"><span class="gl-count-v">${d.blockedCount}</span><span class="gl-count-l">blocked on something</span></span>
      <span class="gl-count"><span class="gl-count-v">${d.noStepsCount}</span><span class="gl-count-l">with no steps yet</span></span>
      <span class="gl-count"><span class="gl-count-v">${d.costToFinishPence === null ? '—' : gbp(d.costToFinishPence)}</span><span class="gl-count-l">${
  d.costToFinishPence === null ? 'no costs set anywhere' : 'priced so far'}</span></span>
    </div>
    ${d.costUnknownSteps
    ? `<p class="gl-note">${plural(d.costUnknownSteps, 'remaining step')} across these goals ${d.costUnknownSteps === 1 ? 'has' : 'have'} no cost set,
       so the figure above is a floor and not what these goals will cost. Nothing here estimates the gap —
       a fee I made up would be summed and then planned against.</p>`
    : '<p class="gl-note">Every remaining step has a cost set, so the figure above is the whole of it.</p>'}
    <p class="gl-note">${esc(d.order)}</p>
    <p class="gl-note">${esc(d.scope)}</p>`;

  list.innerHTML = `<ul class="gl-goals">${d.goals.map(goalCard).join('')}</ul>`;
}

async function load() {
  const mine = token;
  let d;
  try {
    d = await api(`/?status=${encodeURIComponent(filter)}`);
  } catch (err) {
    if (mine !== token || !root) return;
    // Nothing was read, so nothing below is drawn. An error box over a stale list would be
    // the worst of both — you would read the list and believe it.
    root.querySelector('#glErr').innerHTML = errorBox(err, 'Could not load your goals.', true);
    root.querySelector('#glTop').innerHTML = '';
    root.querySelector('#glList').innerHTML = '';
    return;
  }
  if (mine !== token || !root) return;
  root.querySelector('#glErr').innerHTML = '';
  render(d);
}

const patch = (path, payload) => api(path, {
  method: 'PATCH',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(payload),
});

// A save that fails must say so where you were looking, not vanish. Every mutation goes
// through here so none of them can fail silently — and the page is left standing, because
// what is on screen is still the last thing that was genuinely read.
async function act(fn) {
  const mine = token;
  try {
    await fn();
  } catch (err) {
    if (mine !== token || !root) return;
    root.querySelector('#glErr').innerHTML = errorBox(err, 'That change was not saved.', false);
    return;
  }
  if (mine !== token) return;
  await load();
}

// ---------------------------------------------------------------------------- wiring
export default {
  mount(el) {
    root = el;
    token += 1;
    el.innerHTML = TEMPLATE;

    onClick = (ev) => {
      // <details> does not bubble its toggle event, so which lists you had open is tracked
      // from the click on the summary. Same listener, so unmount only has three to remove.
      const summary = ev.target.closest('.gl-steps > summary');
      if (summary) {
        const id = Number(summary.parentElement.dataset.details);
        if (summary.parentElement.open) opened.delete(id); else opened.add(id);
        return undefined;
      }

      const btn = ev.target.closest('[data-act]');
      if (!btn || !root.contains(btn)) return undefined;
      const { act: what, step, goal } = btn.dataset;

      if (what === 'retry') { load(); return undefined; }
      if (what === 'done') return act(() => patch(`/steps/${step}`, { done: true }));
      if (what === 'undone') return act(() => patch(`/steps/${step}`, { done: false }));
      if (what === 'delstep') {
        // Destructive and irreversible, so it asks. This server is on the LAN.
        if (!window.confirm('Remove this step? It cannot be undone.')) return undefined;
        return act(() => api(`/steps/${step}`, { method: 'DELETE' }));
      }
      if (what === 'delgoal') {
        if (!window.confirm('Delete this goal and every step on it? It cannot be undone.')) return undefined;
        return act(() => api(`/goals/${goal}`, { method: 'DELETE' }));
      }
      return undefined;
    };

    onSubmit = (ev) => {
      const form = ev.target;
      ev.preventDefault();
      const value = (name) => {
        const f = form.elements[name];
        return f ? f.value.trim() : '';
      };

      if (form.id === 'glAddGoal') {
        const title = root.querySelector('#glTitle').value.trim();
        if (!title) return undefined;
        const targetDate = root.querySelector('#glTarget').value || null;
        return act(async () => {
          await api('/goals', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ title, targetDate }),
          });
          root.querySelector('#glTitle').value = '';
          root.querySelector('#glTarget').value = '';
        });
      }

      if (form.dataset.addstep) {
        const title = value('title');
        if (!title) return undefined;
        opened.add(Number(form.dataset.addstep));
        return act(() => api(`/goals/${form.dataset.addstep}/steps`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title, cost: value('cost') }),
        }));
      }

      if (form.dataset.savestep) {
        // Both inputs are pre-filled with what is stored, so saving writes back exactly
        // what you are looking at. Clearing the money box sets the cost to "not known"
        // rather than to zero — realising your number was a guess has to be as easy as
        // typing it was.
        const goalId = form.closest('[data-goal]');
        if (goalId) opened.add(Number(goalId.dataset.goal));
        return act(() => patch(`/steps/${form.dataset.savestep}`, {
          cost: value('cost'),
          blockedBy: value('blockedBy') || null,
        }));
      }

      if (form.dataset.savegoal) {
        opened.add(Number(form.dataset.savegoal));
        return act(() => patch(`/goals/${form.dataset.savegoal}`, {
          targetDate: value('targetDate') || null,
          status: value('status'),
        }));
      }
      return undefined;
    };

    onChange = (ev) => {
      if (ev.target.id === 'glFilter') {
        filter = ev.target.value;
        load();
      }
    };

    el.addEventListener('click', onClick);
    el.addEventListener('submit', onSubmit);
    el.addEventListener('change', onChange);
    load();
  },

  // Nothing here polls and nothing sets a timer, so there is no interval to clear. What
  // does need clearing is the three listeners and the token: an in-flight save that lands
  // after you have switched panels must write into nothing.
  unmount() {
    if (root) {
      root.removeEventListener('click', onClick);
      root.removeEventListener('submit', onSubmit);
      root.removeEventListener('change', onChange);
      root.innerHTML = '';
    }
    token += 1;
    onClick = null;
    onSubmit = null;
    onChange = null;
    opened.clear();
    root = null;
  },
};

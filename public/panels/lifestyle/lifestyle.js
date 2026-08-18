// Lifestyle. Reads only /api/lifestyle.
//
// Three halves, and two of them have rules.
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
// FOOD DIARY (#M17): the UI for the meal tracker #M12 shipped as routes only. Everything
// above applies to it, plus three things measured out of the live API before a line of it
// was written. Each is a rendering rule, not a preference:
//
//   1. A TOTAL OF ZERO IS NOT A MEASUREMENT OF ZERO. GET /meals sums only items whose
//      figures are known. When NOTHING known contributes, the route returns 0 — not null.
//      Curled against the running server: two meals logged with no figures on 2020-01-01
//      returned {"kcal":0,...} with both labels under incomplete.kcal. Printed as "0 kcal"
//      that reads as a day of starvation, which in this module is the harmful direction.
//      So totalState() below reports THREE states and never prints a bare 0:
//        no meals at all                     -> "not recorded"   (route sends null)
//        meals, but none has a figure        -> "no figures"     (route sends 0)
//        meals, some or all have figures     -> the sum, with what was left out named
//      The comparison that separates the middle case is incomplete[n].length ===
//      meals.length. That is a fact about the route's own two arrays, not a second
//      derivation of the total — the number itself is only ever rendered, never recomputed.
//
//   2. NOT FOUND AND COULD NOT LOOK ARE DRAWN DIFFERENTLY, because the route already
//      distinguishes them and throwing that away here would be the one bug this panel
//      cannot afford. state:'not_found' means Open Food Facts answered and does not have
//      it; state:'error' means the question never got answered, and it carries `why`.
//      Both are shown, in different boxes, and `why` is printed verbatim — see the note on
//      renderLookup() for the reason that last part matters.
//
//   3. THE TARGET IS DISPLAYED AND NEVER COMMENTED ON. No bar, no percentage, no colour
//      that changes with the number, no "x to go", no streak. The targets table ships
//      EMPTY and nothing here proposes a value — the placeholder is the words "not set",
//      never a number, because a greyed-out 2000 is a suggestion wearing a disguise.
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

    <section class="card mt-card">
      <div class="mt-head">
        <h2 class="lf-h2">Food diary</h2>
        <label class="mt-daylab">Day
          <input type="date" id="mtDate" class="lf-in mt-date">
        </label>
      </div>
      <p class="lf-hint">Search for what you ate, pick the match, say how many servings.
      Totals add up only the items whose figures are known — anything unknown is named
      underneath them rather than quietly left out of the sum.</p>

      <form class="mt-search" id="mtSearch">
        <input id="mtQ" class="lf-in" placeholder="Search a food, or type a barcode" autocomplete="off">
        <button class="btn" type="submit" id="mtGo">Search</button>
      </form>
      <div id="mtLookup"></div>
      <div id="mtCompose"></div>
      <p class="lf-echo" id="mtEcho"></p>

      <div id="mtDay"></div>
      <div id="mtTargets"></div>
    </section>
  </div>
`;

let root = null;
let onKey = null;
let onVisible = null;
// Bumped on mount and on unmount. Every async handler checks it before touching the DOM,
// so a slow fetch that lands after you switch panels writes into nothing rather than into
// a dead tree.
let token = 0;

// --- food diary state. All of it is reset in unmount(), not just the listeners: a stale
// selection surviving a remount would let you log a food you picked on a different day.
let mtDate = null;      // the day being shown AND logged to. Seeded from the server's today.
let mtLookup = null;    // the last lookup result, verbatim from the route. null = not searched yet.
let mtPicked = null;    // one match out of mtLookup.matches, or null

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// The five the route publishes, in GET /targets.nutrients. Kept in this order so the
// totals row and the targets row line up. The labels are display only — every key sent to
// or read from the API is the route's own spelling.
const NUTRIENTS = [
  { key: 'kcal', label: 'Calories', unit: 'kcal' },
  { key: 'protein_g', label: 'Protein', unit: 'g' },
  { key: 'carbs_g', label: 'Carbs', unit: 'g' },
  { key: 'fat_g', label: 'Fat', unit: 'g' },
  { key: 'fibre_g', label: 'Fibre', unit: 'g' },
];

// Numbers come off the API as REALs. Printed with at most one decimal and no trailing
// '.0', so 808.5 stays 808.5 and 12.0 reads 12. Nothing is rounded before it is summed —
// the sum arrives already done, from the one place that owns it.
const num = (v) => (Math.round(v * 10) / 10).toLocaleString('en-GB');

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
        method: 'POST', headers: { 'content-type': 'application/json', 'x-mc-by': 'you' }, body: '{}',
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
      method: 'POST', headers: { 'content-type': 'application/json', 'x-mc-by': 'you' },
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

// ----------------------------------------------------------------------- food diary
// LOOKUP. Four things can come back and they must not be four shades of the same box.
//
//   searching   we asked and are waiting
//   found       matches, pick one
//   not_found   Open Food Facts answered, and does not have this
//   error       the question was never answered. `why` says what happened.
//
// The last two are the pair the module contract cares about. They differ here by border
// STYLE, by heading, and by the sentence underneath — not by shade, because three tints of
// one hue were measured indistinguishable elsewhere in this dashboard.
//
// `why` IS PRINTED VERBATIM, and that is deliberate rather than lazy. Measured against the
// live API on 18 Aug: a barcode that Open Food Facts does not hold answers HTTP 404, and
// the route's `if (!res.ok)` files that as state:'error' — so a genuine "not in the
// database" arrives here wearing "could not reach the database". The panel cannot fix that
// (the route owns the classification and this agent does not own the route), but printing
// the reason means a misfiled 404 is READABLE on screen instead of laundered into a
// network fault. Filed as a backlog item with the curl that shows it.
function renderLookup() {
  const el = root.querySelector('#mtLookup');
  if (!mtLookup) { el.innerHTML = ''; return; }

  if (mtLookup.state === 'searching') {
    el.innerHTML = '<p class="mt-state mt-searching">Searching Open Food Facts…</p>';
    return;
  }

  // COULD NOT LOOK. Never phrased as an absence of nutrition.
  if (mtLookup.state === 'error') {
    el.innerHTML = `
      <div class="mt-state mt-failed">
        <b class="mt-state-h">Could not reach the food database.</b>
        <span class="mt-why">What happened: ${esc(mtLookup.why || 'no reason given')}</span>
        <span class="mt-state-sub">${esc(mtLookup.note
          || 'That is a failure to look, NOT a statement that this food has no nutrition.')}</span>
        <span class="mt-state-sub">You can still log it with no figures attached, and add them later.</span>
      </div>`;
    return;
  }

  // LOOKED, AND IT IS NOT THERE. A different fact, in a different box.
  if (mtLookup.state === 'not_found') {
    el.innerHTML = `
      <div class="mt-state mt-absent">
        <b class="mt-state-h">Not found: “${esc(mtLookup.query)}”.</b>
        <span class="mt-state-sub">${esc(mtLookup.note
          || 'You can still log the meal — it will be recorded with no nutrition attached.')}</span>
      </div>`;
    return;
  }

  const m = mtLookup.matches || [];
  el.innerHTML = `
    <p class="mt-found">${plural(m.length, 'match')} for “${esc(mtLookup.query)}”. Pick one, or log it with no figures.</p>
    <ul class="mt-results">
      ${m.map((x, i) => `
        <li class="mt-result">
          <button class="mt-pick" data-i="${i}">
            <span class="mt-r-name">${esc(x.name)}${x.brand ? `<span class="lf-dim"> · ${esc(x.brand)}</span>` : ''}</span>
            <span class="mt-r-figs">${figsLine(x)}</span>
            <span class="mt-r-basis">${esc(basisLine(x))}</span>
          </button>
        </li>`).join('')}
    </ul>`;

  el.querySelectorAll('.mt-pick').forEach((b) => b.addEventListener('click', () => {
    mtPicked = m[Number(b.dataset.i)];
    renderCompose();
    const lab = root.querySelector('#mtLabel');
    if (lab) lab.focus();
  }));
}

// One line of the figures a match carries. A nutrient the source did not publish prints as
// "—", never as 0 — the same rule the totals follow, one level down.
function figsLine(x) {
  return NUTRIENTS.map((n) => `<span class="mt-fig">${esc(n.label)}
    <b>${x[n.key] == null ? '—' : `${num(x[n.key])}${n.unit === 'g' ? 'g' : ''}`}</b></span>`).join('');
}

// PER SERVING AND PER 100g ARE DIFFERENT NUMBERS FOR THE SAME FOOD, so which one this is
// gets said out loud on every row. The route already decides and reports it as `basis`.
function basisLine(x) {
  return x.basis === 'serving'
    ? `figures are per serving — ${x.serving || 'one serving'}`
    : 'figures are per 100g, so one serving = 100g';
}

function renderCompose() {
  const el = root.querySelector('#mtCompose');
  if (!mtLookup || mtLookup.state === 'searching') { el.innerHTML = ''; return; }

  // Nothing picked: the only offer is to log it with no figures. That is a first-class
  // outcome in this module, not a degraded one, so it is a real button and not fine print.
  if (!mtPicked) {
    const q = mtLookup.query || '';
    el.innerHTML = `
      <form class="mt-compose" id="mtForm">
        <input id="mtLabel" class="lf-in" value="${esc(q)}" placeholder="What did you eat?" required>
        <button class="btn mt-bare" type="submit">Log with no figures</button>
      </form>
      <p class="lf-hint lf-dim mt-tight">It will be recorded either way. An item with no figures is
      left out of the totals and named underneath them, so nothing goes missing silently.</p>`;
  } else {
    const p = mtPicked;
    el.innerHTML = `
      <div class="mt-picked">
        <div class="mt-p-head">
          <span class="mt-p-name">${esc(p.name)}${p.brand ? `<span class="lf-dim"> · ${esc(p.brand)}</span>` : ''}</span>
          <button class="mt-clear" id="mtUnpick" title="Choose a different match">change</button>
        </div>
        <span class="mt-r-figs">${figsLine(p)}</span>
        <span class="mt-r-basis">${esc(basisLine(p))} · source: ${esc(p.source)}</span>
      </div>
      <form class="mt-compose" id="mtForm">
        <input id="mtLabel" class="lf-in" value="${esc(p.name)}" placeholder="What did you eat?" required>
        <label class="mt-servlab">servings
          <input id="mtServings" class="lf-in mt-serv" type="number" min="0.1" step="0.1" value="1">
        </label>
        <button class="btn primary" type="submit">Log it</button>
      </form>`;
    el.querySelector('#mtUnpick').addEventListener('click', () => { mtPicked = null; renderCompose(); });
  }

  el.querySelector('#mtForm').addEventListener('submit', (ev) => { ev.preventDefault(); logMeal(); });
}

// TWO REQUESTS WHEN A FOOD IS PICKED, IN THIS ORDER, because the meal must point at a
// stored food row: POST /foods caches the looked-up figures (with their source and the
// moment they were fetched), then POST /meals references the id it returns. If the first
// fails the second is never sent — a meal pointing at nothing would look like a meal whose
// figures are unknown, which is a different and untrue statement.
async function logMeal() {
  const mine = token;
  const label = (root.querySelector('#mtLabel').value || '').trim();
  if (!label) return;
  const servEl = root.querySelector('#mtServings');
  const servings = servEl ? Number(servEl.value) : 1;

  echo('#mtEcho', 'saving…', '');
  try {
    let foodId = null;
    if (mtPicked) {
      const p = mtPicked;
      const f = await api('/foods', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-mc-by': 'you' },
        body: JSON.stringify({
          name: p.name, brand: p.brand, barcode: p.barcode, serving: p.serving,
          kcal: p.kcal, protein_g: p.protein_g, carbs_g: p.carbs_g, fat_g: p.fat_g,
          fibre_g: p.fibre_g, source: p.source, source_ref: p.source_ref,
        }),
      });
      if (mine !== token) return;
      foodId = f.id;
    }

    const r = await api('/meals', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-mc-by': 'you' },
      body: JSON.stringify({ label, date: mtDate, foodId, servings }),
    });
    if (mine !== token) return;

    // Clear the search only on success, so a failed save leaves what you typed on screen.
    mtLookup = null; mtPicked = null;
    root.querySelector('#mtQ').value = '';
    renderLookup(); renderCompose();
    await loadDay();
    if (mine !== token) return;
    // Recall of the row just written, in the route's own words about whether figures came
    // with it. No comment on the food and no comment on the day.
    echo('#mtEcho', `Logged “${r.label}” for ${r.date} — nutrition ${r.nutrition}.`, 'ok');
  } catch (err) {
    if (mine === token) echo('#mtEcho', `Not logged: ${err.message}`, 'bad');
  }
}

// THE THREE STATES A TOTAL CAN BE IN. See the note at the top of this file for the curl
// that produced the middle one. Nothing here adds, scales or re-sums anything: `value` is
// handed straight through from the route, which is the only owner of that figure.
function totalState(key, d) {
  const meals = d.meals.length;
  const missing = (d.incomplete && d.incomplete[key]) || [];
  if (!meals) return { state: 'no-record', missing: [] };
  // The route pushes one label per MEAL that could not be counted, so this length is a
  // count of meals and the comparison is exact even when two meals share a label.
  if (missing.length >= meals) return { state: 'no-figures', missing };
  return { state: 'sum', value: d.totals[key], missing };
}

function totalCell(n, d) {
  const t = totalState(n.key, d);
  const target = d.targets ? d.targets[n.key] : undefined;

  // A target is shown as a plain adjacent number and nothing else. No bar, no share, no
  // difference, no colour that moves with the value. The route's contract line says this
  // module never reacts to being over or under, and a progress bar IS a reaction.
  const targetLine = target == null
    ? ''
    : `<span class="mt-target">your target ${num(target)}${n.unit === 'g' ? 'g' : ''}</span>`;

  if (t.state === 'no-record') {
    return `<div class="mt-tot mt-tot-blank">
      <span class="mt-tot-n">${esc(n.label)}</span>
      <span class="mt-tot-v mt-tot-na">not recorded</span>
      ${targetLine}
    </div>`;
  }

  if (t.state === 'no-figures') {
    // NEVER "0". The route sends 0 here because nothing known contributed to the sum, and
    // printing that as a measurement would claim the day was empty when it was unmeasured.
    return `<div class="mt-tot mt-tot-blank">
      <span class="mt-tot-n">${esc(n.label)}</span>
      <span class="mt-tot-v mt-tot-na">no figures</span>
      <span class="mt-tot-why">none of ${plural(t.missing.length, 'logged item')} has a figure for this</span>
      ${targetLine}
    </div>`;
  }

  return `<div class="mt-tot">
    <span class="mt-tot-n">${esc(n.label)}</span>
    <span class="mt-tot-v">${num(t.value)}<span class="mt-tot-u">${esc(n.unit)}</span></span>
    ${t.missing.length
      // QUOTED, not comma-joined. Seen in the live render: an item legitimately called
      // "Coffee, no figures" made a two-item exclusion list read as three. The label is
      // free text the owner typed, so it can contain the separator.
      ? `<span class="mt-tot-why">excludes ${t.missing.length} of ${plural(d.meals.length, 'item')}:
         ${t.missing.map((x) => `“${esc(x)}”`).join(', ')}</span>`
      : ''}
    ${targetLine}
  </div>`;
}

function mealRow(m) {
  // Two different reasons an item has no figures, and they are not the same fact:
  // no food attached at all, versus a food whose figures were never found.
  const why = m.foodId == null
    ? 'no food attached — logged by name only'
    : 'this food has no figures on record';
  const known = NUTRIENTS.some((n) => m[n.key] != null);

  return `
    <li class="mt-item${known ? '' : ' mt-item-bare'}">
      <span class="mt-i-main">
        <span class="mt-i-name">${esc(m.label)}${m.servings !== 1
          ? `<span class="lf-dim"> × ${num(m.servings)}</span>` : ''}</span>
        ${known
          // LABELLED "per serving", because these are the food's stored figures and the
          // total is those times `servings`. Unlabelled beside "× 1.5" they read as this
          // meal's contribution, which they are not. Shown this way the arithmetic behind
          // the total is checkable by hand: 539 × 1.5 = 808.5.
          ? `<span class="mt-r-figs"><span class="mt-per">per serving</span>${figsLine(m)}</span>
             <span class="mt-i-src">${esc(m.foodName || '')}${m.brand ? ` · ${esc(m.brand)}` : ''}
               ${m.serving ? `· ${esc(m.serving)}` : ''}${m.source ? ` · ${esc(m.source)}` : ''}</span>`
          : `<span class="mt-i-nofig">${esc(why)}</span>`}
      </span>
      <button class="lf-del mt-i-del" data-meal="${m.id}" title="Remove this item">×</button>
    </li>`;
}

function renderDay(d) {
  const el = root.querySelector('#mtDay');
  const anyMissing = d.meals.length && !d.complete;

  el.innerHTML = `
    <h3 class="lf-h3">${esc(d.date)}${d.date === mtDate ? '' : ''}
      <span class="lf-dim">${d.meals.length ? plural(d.meals.length, 'item') : 'nothing recorded'}</span></h3>

    ${d.meals.length
      ? `<ul class="mt-list">${d.meals.map(mealRow).join('')}</ul>`
      // A day with no record is a day with no record. Not a day of zero.
      : `<p class="empty-hint mt-none">${esc(d.caveat)}</p>`}

    ${anyMissing
      // PROMINENT, because a total that quietly omits a meal reads as a shortfall, and a
      // shortfall is the harmful direction here. Full-width box above the numbers, the
      // route's own caveat at full size — not a footnote under them.
      ? `<div class="mt-warn">
           <b class="mt-warn-h">These totals do not cover everything you logged.</b>
           <span class="mt-warn-b">${esc(d.caveat)}</span>
         </div>`
      : ''}

    ${d.meals.length ? `<div class="mt-totals">${NUTRIENTS.map((n) => totalCell(n, d)).join('')}</div>` : ''}

    ${d.meals.length && d.complete
      ? `<p class="lf-hint lf-dim mt-tight">${esc(d.caveat)}</p>` : ''}
    <p class="lf-hint lf-dim mt-tight">${esc(d.contract)}</p>
  `;

  el.querySelectorAll('.mt-i-del').forEach((b) => b.addEventListener('click', async () => {
    const mine = token;
    let msg;
    try {
      await api(`/meals/${b.dataset.meal}`, { method: 'DELETE', headers: { 'x-mc-by': 'you' } });
      msg = ['Removed.', 'ok'];
    } catch (err) {
      msg = [`Not removed: ${err.message}`, 'bad'];
    }
    if (mine !== token) return;
    await loadDay();
    if (mine !== token) return;
    echo('#mtEcho', msg[0], msg[1]);
  }));
}

// TARGETS. Rendered from GET /targets, which ships empty and stays empty until you set
// one. Every input starts blank with the words "not set" as its placeholder — a greyed-out
// number would be this module proposing a target, which is exactly what it must not do.
function renderTargets(t) {
  const el = root.querySelector('#mtTargets');
  const set = Object.fromEntries((t.targets || []).map((x) => [x.nutrient, x]));

  el.innerHTML = `
    <h3 class="lf-h3">Targets <span class="lf-dim">yours, and only if you want them</span></h3>
    <p class="lf-hint">${esc(t.note)}</p>
    <div class="mt-targets">
      ${NUTRIENTS.map((n) => {
    const cur = set[n.key];
    return `<div class="mt-t-row">
          <span class="mt-t-name">${esc(n.label)}<span class="lf-dim"> ${esc(n.unit)}</span></span>
          <input class="lf-in mt-t-in" data-t="${n.key}" type="number" min="0.1" step="0.1"
                 value="${cur ? esc(cur.amount) : ''}" placeholder="not set">
          <button class="btn mt-t-set" data-set="${n.key}">Save</button>
          ${cur
      ? `<button class="mt-clear" data-clear="${n.key}">clear</button>
             <span class="mt-t-when lf-dim">set ${esc(String(cur.set_at).slice(0, 10))}</span>`
      : '<span class="mt-t-when lf-dim">not set</span>'}
        </div>`;
  }).join('')}
    </div>`;

  el.querySelectorAll('.mt-t-set').forEach((b) => b.addEventListener('click', async () => {
    const mine = token;
    const key = b.dataset.set;
    const input = el.querySelector(`.mt-t-in[data-t="${key}"]`);
    const amount = Number(input.value);
    let msg;
    try {
      if (!Number.isFinite(amount) || amount <= 0) throw new Error('type a positive number first');
      await api(`/targets/${key}`, {
        method: 'PUT', headers: { 'content-type': 'application/json', 'x-mc-by': 'you' },
        body: JSON.stringify({ amount }),
      });
      msg = [`Target saved for ${key}. It is yours; nothing here will comment on it.`, 'ok'];
    } catch (err) {
      msg = [`Not saved: ${err.message}`, 'bad'];
    }
    if (mine !== token) return;
    await loadDay();
    if (mine !== token) return;
    echo('#mtEcho', msg[0], msg[1]);
  }));

  el.querySelectorAll('[data-clear]').forEach((b) => b.addEventListener('click', async () => {
    const mine = token;
    let msg;
    try {
      await api(`/targets/${b.dataset.clear}`, { method: 'DELETE', headers: { 'x-mc-by': 'you' } });
      msg = ['Target cleared. No comparison will be shown for it.', 'ok'];
    } catch (err) {
      msg = [`Not cleared: ${err.message}`, 'bad'];
    }
    if (mine !== token) return;
    await loadDay();
    if (mine !== token) return;
    echo('#mtEcho', msg[0], msg[1]);
  }));
}

async function doLookup(q) {
  const mine = token;
  if (!q) return;
  mtPicked = null;
  mtLookup = { state: 'searching' };
  renderLookup(); renderCompose();
  try {
    const r = await api(`/foods/lookup?q=${encodeURIComponent(q)}`);
    if (mine !== token) return;
    mtLookup = r;
  } catch (err) {
    if (mine !== token) return;
    // A transport failure the route never got to classify. Same box as its own 'error',
    // because it is the same fact: the question did not get answered.
    mtLookup = { state: 'error', query: q, why: err.message };
  }
  renderLookup(); renderCompose();
}

// Loads the day and the targets together — both feed one render, and fetching them apart
// would let the totals draw against a target that had just been cleared.
async function loadDay() {
  const mine = token;
  let d; let t;
  try {
    [d, t] = await Promise.all([
      api(`/meals?date=${encodeURIComponent(mtDate || '')}`),
      api('/targets'),
    ]);
  } catch (err) {
    if (mine !== token) return;
    // Could not load is not an empty day, and this is the module where that distinction
    // does the most damage: a blank food diary reads as "you ate nothing".
    root.querySelector('#mtDay').innerHTML =
      `<p class="lf-error">Could not load this day's food diary: ${esc(err.message)}.
       This is a failure to read your records, not an empty day.</p>`;
    root.querySelector('#mtTargets').innerHTML = '';
    return;
  }
  if (mine !== token) return;
  renderDay(d);
  renderTargets(t);
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
    // The overview is what tells us the date. Without it the diary has no day to show, and
    // saying so is better than defaulting to a date the server might not agree with.
    root.querySelector('#mtDay').innerHTML =
      `<p class="lf-error">Could not load today's date from the server, so the food diary
       has nothing to show a day for: ${esc(err.message)}</p>`;
    return;
  }
  if (mine !== token) return;

  root.querySelector('#lfToday').textContent = d.counts.due
    ? `${plural(d.counts.due, 'chore')} due`
    : (d.counts.total ? 'nothing due' : 'no chores');

  renderChores(d);
  renderIntake(d.intake);

  // ONE OWNER FOR "TODAY". It comes from the overview route (SQLite localtime), the same
  // clock the chore half counts days against — never from the browser, whose timezone is
  // not necessarily the server's and which would silently shift the diary by a day.
  const dateEl = root.querySelector('#mtDate');
  if (!mtDate) mtDate = d.today;
  dateEl.max = d.today;
  if (!dateEl.value) dateEl.value = mtDate;
  await loadDay();
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
          method: 'POST', headers: { 'content-type': 'application/json', 'x-mc-by': 'you' },
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

    // Search on submit only — never as you type. This calls a third-party API on someone
    // else's server, and a request per keystroke would be rude to Open Food Facts and slow
    // for you. Enter in the box counts as submit, so it is still one gesture.
    el.querySelector('#mtSearch').addEventListener('submit', (ev) => {
      ev.preventDefault();
      doLookup(el.querySelector('#mtQ').value.trim());
    });

    // Changing the day re-reads it. The selection is cleared with it: a food picked while
    // looking at Monday must not silently get logged against Tuesday.
    el.querySelector('#mtDate').addEventListener('change', (ev) => {
      const v = ev.target.value;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return;   // a cleared date input reads as ''
      mtDate = v;
      mtLookup = null; mtPicked = null;
      renderLookup(); renderCompose();
      echo('#mtEcho', '', '');
      loadDay();
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
    // The food diary's state goes too, not just its listeners. mtDate is the one that
    // matters: left behind, coming back to this panel after midnight would show and log to
    // yesterday, because load() only seeds it when it is null. Clearing it makes the server
    // the source of the date on every mount.
    mtDate = null;
    mtLookup = null;
    mtPicked = null;
  },
};

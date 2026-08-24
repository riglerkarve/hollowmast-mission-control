//
// suno — Suno Ground Control: prompt library + per-take queue + credit rollup.
//
// This is a staging area for suno.com, not a control room. The owner still
// clicks generate himself; this panel exists to cut round-trip friction —
// copy a prompt, open suno.com, come back and log what happened. NOTHING HERE
// derives credits_used_today itself; that figure comes from GET /api/suno/summary,
// which is the one place SUM(queue_items.credits_spent) is computed. A panel
// that recomputed it from the queue list would agree until one of the two
// changed shape, then disagree without either erroring.
//
// v2 CHANGES (kanban t_2b8e1657) — what changed here and why:
//
// 1. FOCUS TIMER. One "Start/Stop" button per queue row. Only one timer can run
//    across the whole panel — clicking Start on a row calls POST .../focus/start,
//    which the SERVER (not this file) is responsible for auto-stopping whichever
//    other row was running, so the single-timer rule holds even if two browser
//    tabs are open. This file just reflects whatever focus_started_at the server
//    returns and ticks a local display timer for the running row between polls —
//    it does not compute or persist elapsed time itself.
//    LIMITATION, DOCUMENTED PER TASK SPEC: if the tab is closed while a timer is
//    running, nothing fires a stop request (no sendBeacon / no server-side
//    heartbeat-timeout in v2 — deliberately, to avoid the idle-detection /
//    background-tracking complexity the task explicitly ruled out). The row will
//    keep showing as "running" and its accumulated time will be understated until
//    the owner reopens the panel and clicks Stop, at which point elapsed banks
//    from focus_started_at same as any other stop. best-effort, not exact.
//
// 2. PUBLISHED REVENUE. A nullable published_revenue_pence field, same
//    only-when-published gating as published_url, same input pattern. This file
//    NEVER combines it with focus_seconds into a rate, a total, or a badge —
//    see the boundary comment in server/routes/suno.js. That combination is the
//    Scribe's job, not this panel's.
//
// 3. WORKFLOW SIMPLIFICATION. The nightly loop is: write/pick a prompt -> copy it
//    -> generate on suno.com -> come back -> log a take -> tag the outcome. Two
//    per-take actions ("Copy prompt" then "Open suno.com") that are ALWAYS done
//    together are now one button, "Generate ->": it copies the prompt to the
//    clipboard and opens suno.com in one click instead of two, and its label
//    confirms what just happened ("Copied, opening…") so there's no separate
//    "Copied" toast to read before the tab switch. Everything else — status,
//    outcome, credits, notes, published url — is unchanged from v1; the task
//    asked for less friction on the actual repeated action, not a redesign.
//
import { renderLede } from '/panels/lede/lede.js';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\"/g, '&quot;');

const STATUSES = ['planned', 'generated', 'rejected', 'published'];
const OUTCOMES = ['usable', 'unusable', 'unreviewed'];

// FIRST-BATCH WALKTHROUGH (kanban t_7888fb1b) — a hand-held, one-step-at-a-time
// panel for the specific Signal Sickness / "The Diagnostician" 5-track test batch.
// This is NOT a rebuild of the prompt library/queue below (those stay generic,
// reusable for whatever the owner writes next) — it's a fixed, read-only copy of
// what Lena (niche) and Nadia (prompts) already produced, reused verbatim per the
// task brief ("don't re-derive"). Source of truth:
//   reports/mindvirus-test-batch-niche-recommendation.md
//   reports/mindvirus-test-batch-suno-prompts.md
// If the owner starts a different batch later, this section is superseded by a
// new one — it is not meant to be edited in place into something generic.
const WALK_NICHE = {
  title: 'Signal Sickness — "The Diagnostician"',
  lines: [
    'Dark industrial electro-rock. A cold, clinical male voice reads out '
      + '"case files" that build into anthemic, half-shouted choruses.',
    'He reports what he observes — he never pitches, sells, or invites. That\u2019s '
      + 'the one rule every lyric below is written to.',
    '5 tracks, numbered CASE ###/SYMPTOM LOG style, all built from one base '
      + 'style prompt with a per-track mood tag.',
  ],
};

// One shared base style prompt (Lena's), reused per track with a mood tag appended —
// kept here as plain text so Step 2's per-track style boxes don't have to repeat a
// 500-character string five times in the DOM by hand; they're built from this.
const WALK_BASE_STYLE = 'Dark industrial electro-rock, aggressive synth-driven bassline, distorted '
  + 'analog synth stabs, glitchy digital artifacts and signal-interference texture throughout. '
  + 'Confident, sharp-tongued male vocalist with a slight vocal-fry rasp \u2014 speaks more than sings '
  + 'on verses, breaks into a hooky half-shouted melodic chorus. Cold, clinical verses (like a '
  + 'diagnosis being read aloud) building into an anthemic, distorted-but-euphoric chorus. '
  + 'Mid-tempo, 110-120 BPM, minor key. Production: tight, modern, radio-ready low end, sparse '
  + 'verse arrangement that explodes into a wall-of-synth chorus.';

const WALK_TRACKS = [
  {
    title: 'CASE 001',
    track: 'Case File 001',
    mood: 'cold intake report building to anthemic release',
    style: WALK_BASE_STYLE + ' Mood: clinical intake report escalating to anthemic release. '
      + 'Exclude: acoustic instruments, orchestral strings, lo-fi/bedroom production.',
    lyrics: `[Intro - sparse synth pulse, signal-interference crackle]

[Verse 1 - spoken, cold, unhurried]
Subject presents at oh-two-hundred hours
Pulse steady, pupils fine
Symptoms logged: attention drifting
Every third thought isn't mine
I don't diagnose to worry you
I diagnose because it's there
A pattern under the pattern
Cataloged, filed, aware

[Pre-Chorus - building, half-shouted]
Case open. Case open.
Nothing here that needs your yes.

[Chorus - anthemic, distorted, euphoric]
This is Case File Zero-Zero-One
Read it back, it's already done
Not a pitch, not a cure, not a cause
Just the shape of what the signal was
Case File Zero-Zero-One

[Verse 2 - spoken, clinical]
No hook in this, no hand held out
I'm not asking you to stay
I report what the scan is showing
Then the scan looks away
File it under "observed, not caused"
File it under "true"

[Chorus - anthemic, distorted, euphoric]
This is Case File Zero-Zero-One
Read it back, it's already done
Not a pitch, not a cure, not a cause
Just the shape of what the signal was
Case File Zero-Zero-One

[Bridge - half-spoken, half-shouted, tension building]
I don't need you to believe me
I already wrote it down

[Outro - wall of synth fading into interference static]
Case closed. Case open. Case closed.`,
  },
  {
    title: 'SYMPTOM LOG',
    track: 'Useful Is Not Memorable',
    mood: 'dry clinical needling, deadpan-to-defiant',
    style: WALK_BASE_STYLE + ' Mood: dry deadpan needling turning defiant. Exclude: acoustic '
      + 'instruments, orchestral strings, lo-fi/bedroom production.',
    lyrics: `[Intro - glitch stutter, single synth stab repeating]

[Verse 1 - spoken, flat, clinical]
You built a life that runs on time
Efficient, tidy, clean
Nothing in it snags the eye
Nothing in it's seen
Useful things get used and shelved
Useful isn't loud
Symptom noted: you optimized
The part that stood out from the crowd

[Pre-Chorus - rising, half-shouted]
Not an insult. Not a warning.
Just the log. Just the log.

[Chorus - anthemic, distorted, euphoric]
Useful is not memorable
That's not a verdict, that's a fact
Sand smooths everything the same shape
Until there's nothing left to catch
Useful is not memorable
I'm not telling you to change

[Verse 2 - spoken, clinical]
I watched you round your own edges
Called it growing up
I logged it, didn't flinch at it
I don't hand you a cup
Drink or don't. Not my concern.
The data's what I'm here to earn

[Chorus - anthemic, distorted, euphoric]
Useful is not memorable
That's not a verdict, that's a fact
Sand smooths everything the same shape
Until there's nothing left to catch
Useful is not memorable
I'm not telling you to change

[Bridge - half-spoken, tension, building]
Smooth things don't scar
Scars are the only thing that lasts

[Outro - wall of synth collapsing into static]
Filed. Filed. Filed under: forgettable.`,
  },
  {
    title: 'CASE 002',
    track: 'Everyone I Know Is Selling Something',
    mood: 'contemptuous clinical observation of manipulation in others, never performing it himself',
    style: WALK_BASE_STYLE + ' Mood: contemptuous, clipped observation curdling into anthemic '
      + 'disgust. Exclude: acoustic instruments, orchestral strings, lo-fi/bedroom production.',
    lyrics: `[Intro - signal-interference static, distant synth stab]

[Verse 1 - spoken, cold, clipped]
Everyone I scan today
Is running the same little script
Smile first, ask your name second
Third move: here's the pitch
I'm not built like that. I don't have a close.
I don't need you to say yes
I just log what I'm observing:
Everyone's a business, more or less

[Pre-Chorus - rising, half-shouted]
Not me. Not me.
I don't have anything to sell you.

[Chorus - anthemic, distorted, euphoric]
Everyone I know is selling something
A version, a system, a "just hear me out"
I take notes. I don't take orders.
I report the noise, I am not the mouth
Everyone I know is selling something
I'm just telling you what I found

[Verse 2 - spoken, clinical]
Watched a man sell you his sadness
Watched a girl sell you her name
Watched a hundred feeds this morning
Running the exact same game
I don't do that. Read the file.
No offer here. No close. No frame.

[Chorus - anthemic, distorted, euphoric]
Everyone I know is selling something
A version, a system, a "just hear me out"
I take notes. I don't take orders.
I report the noise, I am not the mouth
Everyone I know is selling something
I'm just telling you what I found

[Bridge - half-spoken, half-shouted, building]
This isn't a pitch against pitching
It's just what the scan came back with

[Outro - wall of synth into interference static]
Nothing for sale. Nothing for sale. Filed.`,
  },
  {
    title: 'SYMPTOM LOG',
    track: 'The Ordinary Fights Back',
    mood: 'confrontational, escalating clinical-to-combative',
    style: WALK_BASE_STYLE + ' Mood: confrontational, escalating from clinical calm to combative '
      + 'anthem. Exclude: acoustic instruments, orchestral strings, lo-fi/bedroom production.',
    lyrics: `[Intro - low synth throb, glitch artifacts panning]

[Verse 1 - spoken, flat, direct]
They said the ordinary breaks first
Said it folds, said it bends
I've been logging the ordinary
Longer than most trends
It gets up. It clocks in.
It doesn't post about the fight
It just does the exact same thing again
The morning after last night

[Pre-Chorus - rising, half-shouted]
Watch it. Watch it.
It's still standing. It's still standing.

[Chorus - anthemic, distorted, euphoric]
The ordinary fights back
No cape, no headline, no name
It just keeps showing up
Long after the extraordinary flames out and fades
The ordinary fights back
That's the whole diagnosis. That's the whole case.

[Verse 2 - spoken, clinical, harder edge]
I've seen the loud ones burn out fast
I've seen the quiet ones remain
No signal I've traced is louder
Than the same hand doing the same thing again
This isn't a call to arms
I don't recruit. I just record what stays

[Chorus - anthemic, distorted, euphoric]
The ordinary fights back
No cape, no headline, no name
It just keeps showing up
Long after the extraordinary flames out and fades
The ordinary fights back
That's the whole diagnosis. That's the whole case.

[Bridge - half-spoken, half-shouted, building]
Nobody sold me on this conclusion
The data just kept saying it

[Outro - wall of synth collapsing into static]
Still here. Still here. Filed: still here.`,
  },
  {
    title: 'CASE 003',
    track: 'Strategic Chaos',
    mood: 'verse-as-clinical-explanation, chorus-as-the-chaos-itself',
    style: WALK_BASE_STYLE + ' chorus should feel like the chaos being described actually '
      + 'happening in the mix (heavier glitch stutter, denser synth stacking). Mood: explanation '
      + 'detonating into engineered chaos. Exclude: acoustic instruments, orchestral strings, '
      + 'lo-fi/bedroom production.',
    lyrics: `[Intro - sparse synth pulse, single glitch tick, count building]

[Verse 1 - spoken, precise, unhurried]
Every system needs a variable
It can't fully control
That's not an accident, that's design
That's the oldest trick in the protocol
I'm not the one who built this pattern
I just noticed it was there
A little planned disorder
Dropped in on purpose, everywhere

[Pre-Chorus - rising, half-shouted, glitch stutter intensifying]
Watch the count. Watch the count.
Three. Two. One\u2014

[Chorus - anthemic, distorted, chaotic, dense wall of synth]
Strategic chaos. Nothing random. Every crack accounted for.
Strategic chaos. Watch the static tear the signal to the core.
I don't start it. I just clock it.
I don't fix it. I just log the roar.
Strategic chaos.

[Verse 2 - spoken, clinical]
People think disorder's a mistake
Something that got loose
I've traced this signal seven ways
There's a reason for the noise
It isn't chosen for you. It isn't aimed.
I'm reporting what the pattern does
Not asking you to join the game

[Chorus - anthemic, distorted, chaotic, dense wall of synth]
Strategic chaos. Nothing random. Every crack accounted for.
Strategic chaos. Watch the static tear the signal to the core.
I don't start it. I just clock it.
I don't fix it. I just log the roar.
Strategic chaos.

[Bridge - half-spoken, glitch stutter dominant, tension peaking]
This isn't an invitation
This is just what the noise looks like up close

[Outro - full wall of synth and interference static collapsing to silence]
Logged. Logged. Case closed. Signal lost.`,
  },
];

const WALK_CHECKLIST = [
  { id: 'generate', label: 'Generate on suno.com — paste the Style box and Lyrics box for the track you\u2019re on.' },
  { id: 'log', label: 'Log the take — add it to the queue below (or a new queue row) so it has a record.' },
  { id: 'tag', label: 'Tag outcome — mark it usable, unusable, or leave unreviewed until you\u2019ve listened.' },
];

const WALK_STORAGE_KEY = 'suno_walk_state_v1';

function loadWalkState() {
  try {
    const raw = localStorage.getItem(WALK_STORAGE_KEY);
    if (!raw) return { openStep: 1, checklist: {} };
    const parsed = JSON.parse(raw);
    return {
      openStep: [1, 2, 3].includes(parsed.openStep) ? parsed.openStep : 1,
      checklist: parsed.checklist && typeof parsed.checklist === 'object' ? parsed.checklist : {},
    };
  } catch (e) {
    return { openStep: 1, checklist: {} };
  }
}

function saveWalkState() {
  try { localStorage.setItem(WALK_STORAGE_KEY, JSON.stringify(walkState)); } catch (e) { /* best-effort only */ }
}

let root = null;
let state = null;
let tickTimer = null;
let walkState = loadWalkState();

function optionsHTML(values, selected) {
  return values.map((v) => `<option value="${esc(v)}" ${v === selected ? 'selected' : ''}>${esc(v)}</option>`).join('');
}

// Human format for accumulated seconds — '0m', '12m', '1h 24m'. Never raw seconds; the
// owner reads this as a glance figure, not a stopwatch readout.
function humanDuration(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds || 0));
  const mins = Math.floor(s / 60);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// Live-displayed seconds for a row: banked focus_seconds plus, if this row's timer is
// currently running, whatever has elapsed since focus_started_at. Purely a DISPLAY
// computation — the authoritative bank only happens server-side on /focus/stop (or the
// next /focus/start that auto-stops it).
function liveSeconds(item) {
  if (!item.focus_started_at) return item.focus_seconds;
  const startedMs = Date.parse(item.focus_started_at);
  if (!Number.isFinite(startedMs)) return item.focus_seconds;
  return item.focus_seconds + Math.max(0, Math.round((Date.now() - startedMs) / 1000));
}

function penceToGBPInput(pence) {
  if (pence == null) return '';
  return (pence / 100).toFixed(2);
}

function promptCardHTML(p) {
  const rate = p.success_rate == null ? '—' : `${p.success_rate}%`;
  return `<div class="suno-prompt-card" data-prompt-id="${p.id}">
    <div class="suno-prompt-head">
      <span class="suno-prompt-name">${esc(p.name)}</span>
      <span class="suno-prompt-rate" title="usable takes / total takes">${rate}</span>
    </div>
    <pre class="suno-prompt-style">${esc(p.style_text)}</pre>
    ${p.tags ? `<div class="suno-prompt-tags">${esc(p.tags)}</div>` : ''}
    <div class="suno-prompt-stats">${p.takes} take${p.takes === 1 ? '' : 's'} · ${p.published} published · ${p.usable} usable</div>
    <div class="suno-prompt-actions">
      <button class="suno-btn suno-btn-copy" data-copy="${esc(p.style_text)}">Copy prompt</button>
      <button class="suno-btn suno-btn-queue" data-queue-prompt="${p.id}">Add to queue</button>
      <button class="suno-btn suno-btn-edit" data-edit-prompt="${p.id}">Edit</button>
    </div>
  </div>`;
}

function queueRowHTML(item) {
  const running = Boolean(item.focus_started_at);
  const secs = liveSeconds(item);
  return `<tr class="suno-q-row${running ? ' suno-q-row-running' : ''}" data-item-id="${item.id}">
    <td class="suno-q-prompt">${esc(item.prompt_name)}</td>
    <td>
      <select class="suno-status-select" data-item-id="${item.id}" data-field="status">
        ${optionsHTML(STATUSES, item.status)}
      </select>
    </td>
    <td>
      <select class="suno-outcome-select" data-item-id="${item.id}" data-field="outcome">
        ${optionsHTML(OUTCOMES, item.outcome)}
      </select>
    </td>
    <td class="suno-q-num">
      <input class="suno-credits-input" type="number" min="0" step="1" value="${esc(item.credits_spent)}"
        data-item-id="${item.id}" data-field="credits_spent" />
    </td>
    <td class="suno-q-focus">
      <button class="suno-btn suno-btn-focus${running ? ' suno-btn-focus-running' : ''}"
        data-focus-toggle="${item.id}" data-running="${running ? '1' : '0'}">${running ? 'Stop' : 'Start'}</button>
      <span class="suno-q-focus-time" data-focus-display="${item.id}">${humanDuration(secs)}</span>
    </td>
    <td class="suno-q-notes">
      <input class="suno-notes-input" type="text" value="${esc(item.notes || '')}" placeholder="notes…"
        data-item-id="${item.id}" data-field="notes" />
    </td>
    <td class="suno-q-url">
      ${item.status === 'published'
        ? `<input class="suno-url-input" type="text" value="${esc(item.published_url || '')}" placeholder="published url…"
             data-item-id="${item.id}" data-field="published_url" />`
        : '<span class="suno-q-url-dim">—</span>'}
    </td>
    <td class="suno-q-revenue">
      ${item.status === 'published'
        ? `<input class="suno-revenue-input" type="number" min="0" step="0.01" placeholder="£"
             value="${penceToGBPInput(item.published_revenue_pence)}"
             data-item-id="${item.id}" data-field="published_revenue_pence" />`
        : '<span class="suno-q-url-dim">—</span>'}
    </td>
    <td class="suno-q-actions">
      <button class="suno-btn suno-btn-generate" data-generate="${item.id}"
        data-copy="${esc(item.prompt_style_text || '')}">Generate →</button>
    </td>
    <td class="suno-q-date">${esc(String(item.created_at || '').slice(0, 10))}</td>
  </tr>`;
}

// One step's HTML: a clickable header (always visible) plus a body that only
// renders open (not just hidden with CSS) when it's the open step — per the task
// spec this must show one step "visible/expandable at a time (not all at once, so
// it never overwhelms)", so the other two steps' bodies aren't in the DOM at all
// while collapsed, not merely display:none.
function walkStepHTML(n, title, bodyHTML) {
  const isOpen = walkState.openStep === n;
  return `<div class="suno-walk-step${isOpen ? ' suno-walk-step-open' : ''}" data-walk-step="${n}">
    <button class="suno-walk-step-head" data-walk-toggle="${n}" aria-expanded="${isOpen ? 'true' : 'false'}">
      <span class="suno-walk-step-num">Step ${n}</span>
      <span class="suno-walk-step-title">${esc(title)}</span>
      <span class="suno-walk-step-chevron">${isOpen ? '\u2212' : '+'}</span>
    </button>
    ${isOpen ? `<div class="suno-walk-step-body">${bodyHTML}</div>` : ''}
  </div>`;
}

function walkTrackCardHTML(t, i) {
  return `<div class="suno-walk-track">
    <div class="suno-walk-track-head">
      <span class="suno-walk-track-title">${esc(t.title)} — ${esc(t.track)}</span>
      <span class="suno-walk-track-mood">${esc(t.mood)}</span>
    </div>
    <div class="suno-walk-track-field">
      <div class="suno-walk-track-field-head">
        <span>Style box</span>
        <button class="suno-btn suno-btn-copy" data-copy="${esc(t.style)}">Copy</button>
      </div>
      <pre class="suno-walk-track-text">${esc(t.style)}</pre>
    </div>
    <div class="suno-walk-track-field">
      <div class="suno-walk-track-field-head">
        <span>Lyrics box</span>
        <button class="suno-btn suno-btn-copy" data-copy="${esc(t.lyrics)}">Copy</button>
      </div>
      <pre class="suno-walk-track-text suno-walk-track-lyrics">${esc(t.lyrics)}</pre>
    </div>
  </div>`;
}

function walkChecklistHTML() {
  return `<ul class="suno-walk-checklist">
    ${WALK_CHECKLIST.map((c) => {
      const checked = Boolean(walkState.checklist[c.id]);
      return `<li class="suno-walk-checklist-item${checked ? ' suno-walk-checklist-done' : ''}">
        <label>
          <input type="checkbox" data-walk-check="${c.id}" ${checked ? 'checked' : ''} />
          <span>${esc(c.label)}</span>
        </label>
      </li>`;
    }).join('')}
  </ul>
  <p class="suno-walk-checklist-note">Repeat per track — this checklist doesn't reset itself
    between tracks, it's just a reminder of the three things to do each time.</p>`;
}

function renderWalkthrough() {
  const step1 = `<p class="suno-walk-p">${esc(WALK_NICHE.lines.join(' '))}</p>`;
  const step2 = WALK_TRACKS.map(walkTrackCardHTML).join('');
  const step3 = walkChecklistHTML();
  return `<section class="suno-walk">
    <h2>First batch walkthrough — ${esc(WALK_NICHE.title)}</h2>
    <div class="suno-walk-steps">
      ${walkStepHTML(1, 'The niche, in brief', step1)}
      ${walkStepHTML(2, 'The 5 prompts, ready to paste', step2)}
      ${walkStepHTML(3, 'Checklist — generate, log, tag', step3)}
    </div>
  </section>`;
}

function render() {
  if (!root || !state) return;

  if (state.error) {
    root.innerHTML = `<section class="panel suno-panel">
      <h1>Suno Ground Control</h1>
      <p class="suno-alarm">Could not load — ${esc(state.error)}. That is a failure to look, not an empty result.</p>
    </section>`;
    return;
  }

  if (!state.prompts || !state.queue || !state.summary) {
    root.innerHTML = `<section class="panel suno-panel"><h1>Suno Ground Control</h1>
      <p class="suno-loading">Loading…</p></section>`;
    return;
  }

  const { prompts } = state.prompts;
  const { items } = state.queue;
  const s = state.summary;

  const capPct = s.daily_free_cap ? Math.min(100, Math.round((s.credits_used_today / s.daily_free_cap) * 100)) : 0;

  root.innerHTML = `<section class="panel suno-panel">
    <h1>Suno Ground Control</h1>
    <p class="suno-lede">A staging area for suno.com — a prompt library, a per-take queue, and a
      credit rollup. Not an embed, not auto-generation: you still click generate yourself. This
      just cuts the round trip between "which prompt was that" and "did it work".</p>

    ${renderWalkthrough()}

    <div class="suno-summary${s.over_cap ? ' suno-summary-over' : ''}">
      <span class="suno-summary-label">Credits today</span>
      <span class="suno-summary-value">${s.credits_used_today} / ${s.daily_free_cap}</span>
      <span class="suno-summary-bar"><span class="suno-summary-bar-fill" style="width:${capPct}%"></span></span>
      <span class="suno-summary-note">${esc(s.cap_note)}</span>
    </div>

    <div class="suno-cols">
      <div class="suno-col-prompts">
        <div class="suno-col-head">
          <h2>Prompt library</h2>
          <button class="suno-btn suno-btn-add" id="sunoAddPrompt">+ New prompt</button>
        </div>
        <div id="sunoPromptForm" class="suno-form suno-hidden">
          <input id="sunoPromptName" type="text" placeholder="Name" />
          <textarea id="sunoPromptStyle" placeholder="Style / prompt text" rows="3"></textarea>
          <input id="sunoPromptTags" type="text" placeholder="Tags (optional)" />
          <div class="suno-form-actions">
            <button class="suno-btn suno-btn-save" id="sunoSavePrompt">Save</button>
            <button class="suno-btn suno-btn-cancel" id="sunoCancelPrompt">Cancel</button>
          </div>
        </div>
        <div class="suno-prompt-list">
          ${prompts.length
            ? prompts.map(promptCardHTML).join('')
            : '<p class="suno-empty">No prompts yet. Add one to start staging takes.</p>'}
        </div>
      </div>

      <div class="suno-col-queue">
        <h2>Queue — one row per take</h2>
        ${items.length ? `<div class="suno-table-wrap"><table class="suno-table">
          <thead><tr>
            <th>Prompt</th><th>Status</th><th>Outcome</th><th class="suno-q-num">Credits</th>
            <th>Focus</th><th>Notes</th><th>Published URL</th><th>Revenue</th><th>Actions</th><th>Added</th>
          </tr></thead>
          <tbody>${items.map(queueRowHTML).join('')}</tbody>
        </table></div>` : '<p class="suno-empty">No queue items yet. Generate on suno.com, then log each take here.</p>'}
      </div>
    </div>
  </section>`;

  wireEvents();
  wireTicker();
}

// Ticks the visible focus-time label(s) once a second for whichever row is running,
// without re-fetching or re-rendering the whole panel. Purely cosmetic — the source of
// truth is still the server's focus_seconds + focus_started_at, re-synced on every
// start/stop/reload.
function wireTicker() {
  if (tickTimer) clearInterval(tickTimer);
  const running = (state.queue?.items || []).find((i) => i.focus_started_at);
  if (!running) return;
  tickTimer = setInterval(() => {
    const el = root && root.querySelector(`[data-focus-display="${running.id}"]`);
    if (!el) { clearInterval(tickTimer); tickTimer = null; return; }
    el.textContent = humanDuration(liveSeconds(running));
  }, 1000);
}

function wireEvents() {
  // Walkthrough: step toggles (accordion — clicking the open step's own header
  // closes it back to none-open rather than trapping the owner on one step) and
  // per-track checklist checkboxes. Both just flip walkState and re-render; state
  // persists to localStorage so a reload doesn't dump the owner back to Step 1
  // mid-batch.
  root.querySelectorAll('[data-walk-toggle]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const n = Number(btn.dataset.walkToggle);
      walkState.openStep = walkState.openStep === n ? 0 : n;
      saveWalkState();
      render();
    });
  });
  root.querySelectorAll('[data-walk-check]').forEach((cb) => {
    cb.addEventListener('change', () => {
      const id = cb.dataset.walkCheck;
      walkState.checklist[id] = cb.checked;
      saveWalkState();
      render();
    });
  });

  const addBtn = root.querySelector('#sunoAddPrompt');
  const form = root.querySelector('#sunoPromptForm');
  if (addBtn && form) {
    addBtn.addEventListener('click', () => {
      form.classList.toggle('suno-hidden');
      delete form.dataset.editId;
      root.querySelector('#sunoPromptName').value = '';
      root.querySelector('#sunoPromptStyle').value = '';
      root.querySelector('#sunoPromptTags').value = '';
    });
  }
  const cancelBtn = root.querySelector('#sunoCancelPrompt');
  if (cancelBtn) cancelBtn.addEventListener('click', () => form.classList.add('suno-hidden'));

  const saveBtn = root.querySelector('#sunoSavePrompt');
  if (saveBtn) {
    saveBtn.addEventListener('click', async () => {
      const name = root.querySelector('#sunoPromptName').value.trim();
      const styleText = root.querySelector('#sunoPromptStyle').value.trim();
      const tags = root.querySelector('#sunoPromptTags').value.trim();
      if (!name || !styleText) return;
      const editId = form.dataset.editId;
      const url = editId ? `/api/suno/prompts/${editId}` : '/api/suno/prompts';
      const method = editId ? 'PATCH' : 'POST';
      await fetch(url, {
        method, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, style_text: styleText, tags: tags || null }),
      });
      form.classList.add('suno-hidden');
      await loadPrompts();
      render();
    });
  }

  root.querySelectorAll('[data-copy]:not([data-generate])').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(btn.dataset.copy);
        const orig = btn.textContent;
        btn.textContent = 'Copied';
        setTimeout(() => { btn.textContent = orig; }, 1200);
      } catch (e) {
        btn.textContent = 'Copy failed';
      }
    });
  });

  // "Generate →" — the v2 workflow simplification: copy + open suno.com in one click
  // instead of two separate buttons doing the same two things every single take.
  root.querySelectorAll('[data-generate]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const orig = btn.textContent;
      try {
        await navigator.clipboard.writeText(btn.dataset.copy || '');
        btn.textContent = 'Copied, opening…';
      } catch (e) {
        btn.textContent = 'Copy failed';
      }
      window.open('https://suno.com', '_blank', 'noopener');
      setTimeout(() => { btn.textContent = orig; }, 1500);
    });
  });

  root.querySelectorAll('[data-edit-prompt]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.editPrompt;
      const p = state.prompts.prompts.find((x) => String(x.id) === String(id));
      if (!p) return;
      form.classList.remove('suno-hidden');
      form.dataset.editId = id;
      root.querySelector('#sunoPromptName').value = p.name;
      root.querySelector('#sunoPromptStyle').value = p.style_text;
      root.querySelector('#sunoPromptTags').value = p.tags || '';
      form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
  });

  root.querySelectorAll('[data-queue-prompt]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const promptId = btn.dataset.queuePrompt;
      await fetch('/api/suno/queue', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt_id: Number(promptId) }),
      });
      await Promise.all([loadQueue(), loadPrompts(), loadSummary()]);
      render();
    });
  });

  root.querySelectorAll('[data-focus-toggle]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.focusToggle;
      const running = btn.dataset.running === '1';
      await fetch(`/api/suno/queue/${id}/focus/${running ? 'stop' : 'start'}`, { method: 'POST' });
      await Promise.all([loadQueue(), loadPrompts(), loadSummary()]);
      render();
    });
  });

  root.querySelectorAll('[data-item-id][data-field]').forEach((el) => {
    const fire = async () => {
      const id = el.dataset.itemId;
      const field = el.dataset.field;
      let value = el.value;
      if (field === 'credits_spent') value = Number(value) || 0;
      if (field === 'published_revenue_pence') {
        value = value === '' ? null : Math.round(Number(value) * 100);
        if (value !== null && !Number.isFinite(value)) return;
      }
      await fetch(`/api/suno/queue/${id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [field]: value }),
      });
      await Promise.all([loadQueue(), loadPrompts(), loadSummary()]);
      render();
    };
    if (el.tagName === 'SELECT') el.addEventListener('change', fire);
    else el.addEventListener('change', fire);
  });
}

// Best-effort: if the tab is closing while a timer runs, ask the server to stop it so the
// row doesn't sit "running" forever. keepalive lets the request survive page teardown, but
// this is NOT guaranteed to fire (killed process, crash, offline) — see the file-header
// comment. No retry, no idle detection; document the gap rather than chase it.
window.addEventListener('beforeunload', () => {
  const running = state && state.queue?.items?.find((i) => i.focus_started_at);
  if (!running) return;
  try {
    fetch(`/api/suno/queue/${running.id}/focus/stop`, { method: 'POST', keepalive: true });
  } catch { /* best-effort only */ }
});

async function loadPrompts() {
  try {
    state.prompts = await (await fetch('/api/suno/prompts')).json();
    state.error = null;
  } catch (e) { state.error = e.message; }
}
async function loadQueue() {
  try {
    state.queue = await (await fetch('/api/suno/queue')).json();
    state.error = null;
  } catch (e) { state.error = e.message; }
}
async function loadSummary() {
  try {
    state.summary = await (await fetch('/api/suno/summary')).json();
    state.error = null;
  } catch (e) { state.error = e.message; }
}

async function loadAll() {
  await Promise.all([loadPrompts(), loadQueue(), loadSummary()]);
  render();
}

export default {
  mount(el, opts) {
    root = el;
    state = { prompts: null, queue: null, summary: null, error: null };
    render();
    loadAll();
    renderLede('suno', el);
  },
  unmount() {
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
    root = null; state = null;
  },
};

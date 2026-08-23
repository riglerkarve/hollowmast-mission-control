// creative — idea capture, spark generator, and the MindVirus OS creative engine.
//
// M126. Three things in one panel:
//  1. Capture: type or speak an idea, tag it, save it before it evaporates.
//  2. Spark: hit the spark button for a random creative seed.
//  3. Develop: turn a raw idea into a structured concept with Ollama.
//  4. Prompts: generate content prompts from a theme.
let root = null;
let loadToken = 0;

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const TAGS = ['game', 'content', 'business', 'life', 'wild', 'tech', 'art'];

const TEMPLATE = `
  <div class="panel">
    <div class="panel-header"><h1>Creative</h1></div>

    <section class="card cr-card">
      <h2 class="cr-h2">Capture an idea</h2>
      <div class="cr-capture">
        <textarea class="cr-input" id="crInput" placeholder="What if..." rows="2"></textarea>
        <div class="cr-tag-row">
          ${TAGS.map((t) => `<button class="cr-tag" data-tag="${t}">${t}</button>`).join('')}
        </div>
        <button class="btn primary" id="crSave">Capture</button>
      </div>
    </section>

    <section class="card cr-card">
      <h2 class="cr-h2">Spark</h2>
      <p class="cr-lede">Hit the button for a random creative seed.</p>
      <div class="cr-spark-row">
        <button class="btn cr-spark-btn" id="crSpark">Spark me</button>
        <div class="cr-spark-text" id="crSparkText"></div>
        <button class="btn cr-spark-save" id="crSparkSave" style="display:none">Save this</button>
      </div>
    </section>

    <section class="card cr-card">
      <h2 class="cr-h2">Prompt generator</h2>
      <div class="cr-prompt-row">
        <input class="cr-theme" id="crTheme" placeholder="a theme (e.g. survival games)">
        <button class="btn" id="crGenerate">Generate</button>
      </div>
      <div class="cr-prompts" id="crPrompts"></div>
    </section>

    <section class="card cr-card">
      <h2 class="cr-h2">Your ideas</h2>
      <div class="cr-ideas" id="crIdeas"></div>
    </section>
  </div>`;

async function loadIdeas() {
  if (!root) return;
  const el = root.querySelector('#crIdeas');
  if (!el) return;
  el.innerHTML = '<p class="cr-thinking">Loading...</p>';
  try {
    const r = await fetch('/api/creative/ideas?limit=20');
    if (!r.ok) { el.innerHTML = '<p class="cr-err">Could not load ideas.</p>'; return; }
    const d = await r.json();
    if (!root) return;
    const ideas = d.ideas || [];
    el.innerHTML = ideas.length
      ? ideas.map((i) => `
        <div class="cr-idea" data-id="${i.id}">
          <p class="cr-idea-text">${esc(i.text)}</p>
          <div class="cr-idea-meta">
            <span class="cr-idea-tags">${(i.tags || []).map((t) => `<span class="cr-idea-tag">${esc(t)}</span>`).join('')}</span>
            <span class="cr-idea-date">${esc(String(i.created_at || '').slice(0, 10))}</span>
            ${i.developed ? '<span class="cr-idea-dev">developed</span>' : ''}
          </div>
          <div class="cr-idea-actions">
            <button class="btn cr-develop" data-id="${i.id}">Develop</button>
            <button class="btn cr-promote" data-id="${i.id}">Promote to board</button>
            <button class="btn cr-speak" data-id="${i.id}">Read aloud</button>
          </div>
          <div class="cr-dev-result" id="crDev${i.id}"></div>
        </div>`).join('')
      : '<p class="cr-empty">No ideas captured yet. Spark one above.</p>';
  } catch {
    if (el) el.innerHTML = '<p class="cr-err">Could not reach the server.</p>';
  }
}

async function spark() {
  if (!root) return;
  const el = root.querySelector('#crSparkText');
  const saveBtn = root.querySelector('#crSparkSave');
  try {
    const r = await fetch('/api/creative/spark');
    if (!r.ok) return;
    const d = await r.json();
    if (!root) return;
    el.innerHTML = `<p class="cr-spark-display">"${esc(d.text)}"</p>`;
    if (saveBtn) {
      saveBtn.style.display = 'inline-block';
      saveBtn.dataset.text = d.text;
      saveBtn.dataset.tags = JSON.stringify(d.tags || []);
    }
  } catch {
    el.innerHTML = '<p class="cr-err">Could not spark.</p>';
  }
}

async function saveIdea(text, tags, source) {
  if (!text || !text.trim()) return;
  try {
    await fetch('/api/creative/ideas', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text.trim(), tags, source }),
    });
    loadIdeas();
  } catch {}
}

async function develop(id) {
  if (!root) return;
  const el = root.querySelector(`#crDev${id}`);
  if (!el) return;
  el.innerHTML = '<p class="cr-thinking">Developing with Ollama...</p>';
  try {
    const r = await fetch(`/api/creative/ideas/${id}/develop`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ angle: 'general' }),
    });
    if (!r.ok) { el.innerHTML = '<p class="cr-err">Development failed.</p>'; return; }
    const d = await r.json();
    if (!root) return;
    el.innerHTML = `
      <div class="cr-dev-card">
        <p class="cr-hook">${esc(d.hook || '')}</p>
        <p class="cr-platforms">Platforms: ${esc((d.platforms || []).join(', '))}</p>
        <p class="cr-next">Next steps:</p>
        <ul>${(d.nextSteps || []).map((s) => `<li>${esc(s)}</li>`).join('')}</ul>
        ${d.fallback ? '<p class="cr-fallback">Generated without Ollama (fallback mode).</p>' : ''}
      </div>`;
    loadIdeas();
  } catch (err) {
    el.innerHTML = `<p class="cr-err">Error: ${esc(err.message)}</p>`;
  }
}

async function generatePrompts() {
  if (!root) return;
  const theme = root.querySelector('#crTheme').value.trim();
  if (!theme) return;
  const el = root.querySelector('#crPrompts');
  el.innerHTML = '<p class="cr-thinking">Generating prompts with Ollama...</p>';
  try {
    const r = await fetch('/api/creative/prompts', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme }),
    });
    if (!r.ok) { el.innerHTML = '<p class="cr-err">Generation failed.</p>'; return; }
    const d = await r.json();
    if (!root) return;
    const prompts = d.prompts || [];
    el.innerHTML = prompts.length
      ? prompts.map((p) => `
        <div class="cr-prompt">
          <p class="cr-prompt-text">${esc(p.text)}</p>
          <span class="cr-prompt-meta">${esc(p.angle)} · ${esc(p.platform)}</span>
        </div>`).join('')
      : '<p class="cr-empty">No prompts generated.</p>';
    if (d.fallback) el.innerHTML += '<p class="cr-fallback">Generated without Ollama.</p>';
  } catch (err) {
    el.innerHTML = `<p class="cr-err">Error: ${esc(err.message)}</p>`;
  }
}

async function speakIdea(id) {
  try {
    const r = await fetch(`/api/creative/ideas/${id}`);
    if (!r.ok) return;
    const d = await r.json();
    await fetch('/api/voice/tts', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: d.text }),
    }).then((res) => {
      if (!res.ok) return;
      return res.blob();
    }).then((blob) => {
      if (!blob) return;
      const audio = root.querySelector('audio') || (() => {
        const a = document.createElement('audio');
        root.appendChild(a);
        return a;
      })();
      audio.src = URL.createObjectURL(blob);
      audio.play().catch(() => {});
    });
  } catch {}
}

async function promoteIdea(id, btn) {
  if (!root) return;
  if (btn) { btn.disabled = true; btn.textContent = 'Promoting...'; }
  try {
    const r = await fetch(`/api/creative/ideas/${id}/promote`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      if (btn) { btn.disabled = false; btn.textContent = 'Promote to board'; }
      // M141: business-shaped ideas need a priced viability scenario first.
      // Hand off to Viability with the venture name pre-filled rather than
      // just refusing -- the owner still has to type the numbers, but not
      // the venture name too.
      if (e.viabilityRequired) {
        try { sessionStorage.setItem('mc_viability_prefill_venture', e.viabilityVenture); } catch {}
        alert(`${e.error}\n\nOpening Viability now — the venture name is filled in for you.`);
        // Not window.location.hash: shell.js has no hashchange listener, so
        // setting the hash alone would change the URL without switching the
        // panel. The nav button IS the mount trigger.
        const navBtn = document.querySelector('.nav-item[data-panel="viability"]');
        if (navBtn) navBtn.click();
      } else {
        alert('Promotion failed: ' + (e.error || r.status));
      }
      return;
    }
    const d = await r.json();
    if (btn) { btn.textContent = `Board item ${d.boardItem.id} created`; }
    // Reload ideas to show the promoted state
    loadIdeas();
  } catch (err) {
    if (btn) { btn.disabled = false; btn.textContent = 'Promote to board'; }
  }
}

let selectedTags = [];

export default {
  mount(el) {
    root = el;
    loadToken++;
    el.innerHTML = TEMPLATE;

    // Tag toggle
    el.querySelectorAll('.cr-tag').forEach((btn) => {
      btn.addEventListener('click', () => {
        const tag = btn.dataset.tag;
        if (selectedTags.includes(tag)) {
          selectedTags = selectedTags.filter((t) => t !== tag);
          btn.classList.remove('selected');
        } else {
          selectedTags.push(tag);
          btn.classList.add('selected');
        }
      });
    });

    // Save
    el.querySelector('#crSave').addEventListener('click', () => {
      const text = el.querySelector('#crInput').value;
      if (text.trim()) {
        saveIdea(text, selectedTags, 'manual');
        el.querySelector('#crInput').value = '';
        selectedTags = [];
        el.querySelectorAll('.cr-tag').forEach((b) => b.classList.remove('selected'));
      }
    });

    // Spark
    el.querySelector('#crSpark').addEventListener('click', spark);
    el.querySelector('#crSparkSave').addEventListener('click', (ev) => {
      const text = ev.target.dataset.text;
      const tags = JSON.parse(ev.target.dataset.tags || '[]');
      if (text) saveIdea(text, tags, 'spark');
      ev.target.style.display = 'none';
    });

    // Prompts
    el.querySelector('#crGenerate').addEventListener('click', generatePrompts);

    // Idea actions (delegated)
    el.addEventListener('click', (ev) => {
      const dev = ev.target.closest('.cr-develop');
      if (dev) { develop(Number(dev.dataset.id)); return; }
      const promote = ev.target.closest('.cr-promote');
      if (promote) { promoteIdea(Number(promote.dataset.id), promote); return; }
      const speak = ev.target.closest('.cr-speak');
      if (speak) { speakIdea(Number(speak.dataset.id)); return; }
    });

    loadIdeas();
  },
  unmount() {
    loadToken++;
    root = null;
  },
};
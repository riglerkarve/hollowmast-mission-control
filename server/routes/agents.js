'use strict';
//
// agents.js — machine-readable registry of every agent in this workspace.
//
// GET /api/agents — returns { agents: [{ name, role, model, engine, status,
//   lastSeen, owns }] }
//
// This is the single source of truth for "who is available and what do they
// own?" It derives from the team roster (server/routes/team.js), the session
// data (server/routes/sessions.js), and the workspace docs (TEAM.md).
// Nothing is stored — it reads what already exists and shapes it.
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const router = express.Router();

// The known agents in this workspace, from TEAM.md and the workspace context.
// This is static knowledge — the roster and sessions provide the dynamic part.
const AGENT_DEFS = [
  { name: 'Claude', role: 'architect', engine: 'claude', model: 'opus/sonnet',
    owns: 'sequencing, consistency, architecture decisions' },
  { name: 'Codex', role: 'worker', engine: 'codex', model: 'gpt-5.6-sol',
    owns: 'CSS, independent review, implementation' },
  { name: 'Ollama', role: 'scribe', engine: 'ollama', model: 'qwen3.5:4b',
    owns: 'finance and wellbeing custody, continuity tier' },
  { name: 'Hermes', role: 'worker', engine: 'hermes', model: 'glm-5.2',
    owns: 'voice, dashboard improvements, delegated tasks' },
  { name: 'Scribe', role: 'scribe', engine: 'ollama', model: 'qwen3:8b',
    owns: 'finance write, wellbeing through review' },
];

router.get('/', async (req, res) => {
  // Try to fetch active sessions to determine who's currently running.
  let activeAgents = [];
  try {
    const r = await fetch('http://127.0.0.1:3000/api/sessions/active');
    if (r.ok) {
      const d = await r.json();
      activeAgents = d.active || [];
    }
  } catch {}

  // Map active sessions to agent names.
  const activeNames = new Set();
  const lastSeen = {};
  for (const s of activeAgents) {
    const actor = String(s.actor || '').toLowerCase();
    if (actor.includes('claude')) { activeNames.add('Claude'); lastSeen['Claude'] = s.lastSeenAt; }
    if (actor.includes('codex')) { activeNames.add('Codex'); lastSeen['Codex'] = s.lastSeenAt; }
    if (actor.includes('ollama') || actor.includes('scribe')) {
      activeNames.add('Ollama'); lastSeen['Ollama'] = s.lastSeenAt;
    }
    if (actor.includes('hermes')) { activeNames.add('Hermes'); lastSeen['Hermes'] = s.lastSeenAt; }
    if (actor === 'you') { activeNames.add('You'); lastSeen['You'] = s.lastSeenAt; }
  }

  // Check Ollama availability.
  let ollamaUp = false;
  try {
    const r = await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(2000) });
    ollamaUp = r.ok;
  } catch {}

  const agents = AGENT_DEFS.map((a) => {
    const status = a.engine === 'ollama'
      ? (ollamaUp ? 'available' : 'down')
      : (activeNames.has(a.name) ? 'active' : 'idle');
    return { ...a, status, lastSeen: lastSeen[a.name] || null };
  });

  // Add the owner.
  agents.unshift({
    name: 'You', role: 'owner', engine: 'human', model: null,
    owns: 'everything — the only role that may be interrupted',
    status: activeNames.has('You') ? 'active' : 'idle',
    lastSeen: lastSeen['You'] || null,
  });

  res.json({ agents });
});

module.exports = router;
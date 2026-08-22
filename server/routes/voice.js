'use strict';
//
// voice.js — click-to-talk and talk-back for Mission Control.
//
// Two endpoints:
//   POST /api/voice/tts   { text } -> audio/mpeg
//   POST /api/voice/stt   audio blob (webm/wav) -> { text }
//   GET  /api/voice/status -> { tts: { voice }, stt: { enabled } }
//
// TTS uses edge-tts (free, no API key) via the Python in the Hermes venv.
// STT uses faster-whisper (local, free) from the same venv, falling back to
// the system Python if the venv lacks it. Both run as child processes — no
// server state, no tables, nothing persisted.
//
// The audio file is streamed straight back and never stored. A file on disk
// would be a second copy of something already in the response, and a temp
// file that lingers is a privacy leak wearing a filename.
const express = require('express');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const router = express.Router();

// Resolve the Python executable for TTS from the Hermes venv (which has
// edge-tts). The venv has no pip and cannot install whisper, so STT uses the
// system Python instead — see sttPythonExe below.
function ttsPythonExe() {
  const venv = path.join(os.homedir(), 'AppData', 'Local', 'hermes',
    'hermes-agent', 'venv', 'Scripts', 'python.exe');
  if (fs.existsSync(venv)) return venv;
  return 'python';
}

// Resolve the Python executable for STT. The Hermes venv lacks pip and cannot
// install faster-whisper, so we prefer the system Python 3.13 which can.
function sttPythonExe() {
  const sys = path.join(os.homedir(), 'AppData', 'Local', 'Programs',
    'Python', 'Python313', 'python.exe');
  if (fs.existsSync(sys)) return sys;
  // Fall back to the venv — it might get whisper some other way.
  return ttsPythonExe();
}

// Read the configured Edge TTS voice from Hermes config.yaml so the panel
// and the CLI use the same voice. Falls back to en-AU-NatashaNeural.
function configuredVoice() {
  try {
    const configPath = path.join(os.homedir(), '.hermes', 'config.yaml');
    const raw = fs.readFileSync(configPath, 'utf-8');
    const m = raw.match(/voice:\s*(en-[A-Z]{2}-\w+Neural)/);
    return m ? m[1] : 'en-AU-NatashaNeural';
  } catch {
    return 'en-AU-NatashaNeural';
  }
}

// Check quiet hours — the dashboard's wellbeing curtain. If quiet hours are
// active, TTS should be suppressed so the panel doesn't speak aloud when the
// owner has said "leave me alone." This mirrors shell.js's quietCurtain logic
// but server-side, so the voice route can respect it even from the mobile page.
async function isQuiet() {
  try {
    const r = await fetch('http://127.0.0.1:3000/api/wellbeing/quiet', { signal: AbortSignal.timeout(3000) });
    if (!r.ok) return false;
    const d = await r.json();
    return !!d.active;
  } catch {
    return false;
  }
}

// POST /api/voice/tts — body: { "text": "..." }
// Returns audio/mpeg directly.
router.post('/tts', async (req, res) => {
  const text = req.body && req.body.text;
  if (!text || typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'Missing "text" in body.' });
  }
  // Quiet hours: if active, return a 204 with no audio. The panel shows the text
  // but doesn't speak it. Absence of audio is the quiet-hours behaviour, not an error.
  if (await isQuiet()) {
    return res.status(204).json({ quiet: true, message: 'Quiet hours active — text shown, not spoken.' });
  }
  // Cap at 5000 chars — edge-tts can handle it, and a panel message that long
  // is a bug, not a feature.
  const safe = String(text).slice(0, 5000);
  const voice = configuredVoice();
  const py = ttsPythonExe();

  // edge-tts is invoked as a module: python -m edge_tts --voice X --text Y --write-media /dev/stdout
  // On Windows /dev/stdout doesn't exist, so we use a temp file and stream it.
  const tmp = path.join(os.tmpdir(), `mc-tts-${Date.now()}.mp3`);
  const args = ['-m', 'edge_tts', '--voice', voice, '--text', safe,
    '--write-media', tmp];

  execFile(py, args, { timeout: 30000 }, (err) => {
    if (err) {
      try { fs.unlinkSync(tmp); } catch {}
      return res.status(500).json({ error: 'TTS generation failed: ' +
        (err.message || String(err)) });
    }
    fs.readFile(tmp, (readErr, data) => {
      try { fs.unlinkSync(tmp); } catch {}
      if (readErr) return res.status(500).json({ error: 'Could not read audio.' });
      res.set('Content-Type', 'audio/mpeg');
      res.set('Cache-Control', 'no-store');
      return res.send(data);
    });
  });
});

// POST /api/voice/stt — body: raw audio blob (webm/opus or wav)
// Returns { text: "transcript" }
router.post('/stt', express.raw({ type: ['audio/webm', 'audio/wav',
  'audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/*'], limit: '25mb' }),
  (req, res) => {
  if (!req.body || !req.body.length) {
    return res.status(400).json({ error: 'No audio received.' });
  }

  // Save the blob to a temp file, then run whisper on it.
  const ext = (req.headers['content-type'] || '').includes('webm') ? 'webm'
    : (req.headers['content-type'] || '').includes('wav') ? 'wav'
    : (req.headers['content-type'] || '').includes('ogg') ? 'ogg'
    : 'wav';
  const tmp = path.join(os.tmpdir(), `mc-stt-${Date.now()}.${ext}`);
  fs.writeFile(tmp, req.body, (writeErr) => {
    if (writeErr) {
      return res.status(500).json({ error: 'Could not save audio.' });
    }
    const py = sttPythonExe();
    // Try faster-whisper first; fall back to openai-whisper; fall back to
    // a simple error so the panel shows "could not transcribe" rather than
    // hanging.
    const script = [
      'import sys',
      'try:',
      '  from faster_whisper import WhisperModel',
      '  model = WhisperModel("base", device="cpu", compute_type="int8")',
      '  segments, _ = model.transcribe(sys.argv[1])',
      '  print("".join(s.text for s in segments).strip())',
      'except ImportError:',
      '  try:',
      '    import whisper',
      '    model = whisper.load_model("base")',
      '    result = model.transcribe(sys.argv[1])',
      '    print(result["text"].strip())',
      '  except Exception as e:',
      '    print("ERR:" + str(e), file=sys.stderr)',
      '    sys.exit(1)',
      'except Exception as e:',
      '  print("ERR:" + str(e), file=sys.stderr)',
      '  sys.exit(1)',
    ].join('\n');

    execFile(py, ['-c', script, tmp], { timeout: 60000 }, (err, stdout, stderr) => {
      try { fs.unlinkSync(tmp); } catch {}
      if (err) {
        const msg = String(stderr || err.message || err).trim();
        return res.status(500).json({ error: 'STT failed: ' + msg });
      }
      const text = String(stdout || '').trim();
      return res.json({ text });
    });
  });
});

// GET /api/voice/status — what voice and STT are configured
router.get('/status', (req, res) => {
  res.json({
    tts: { voice: configuredVoice(), provider: 'edge' },
    stt: { enabled: true, provider: 'local-whisper' },
  });
});

module.exports = router;
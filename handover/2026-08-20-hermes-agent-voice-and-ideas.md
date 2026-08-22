# Hermes Agent — voice panel + five ideas build

## Built

- **Voice panel** (`/panels/voice/`): click-to-talk + talk-back. Server route
  `/api/voice` with TTS (edge-tts via Hermes venv, Natasha voice) and STT
  (faster-whisper via system Python 3.13). Tested end-to-end: TTS plays,
  STT transcribes, round-trip verified.
- **Focus panel voice bar**: compact click-to-talk embedded in the Focus
  panel between the timer and the task card.
- **five-ideas.md**: detailed plan for 5 improvements, written from a
  10-question quiz with the owner.

## In progress

- **5 ideas being built by parallel subagents**:
  1. Panel Decoder (lede route + utility) — done
  2. Morning Briefing (route + panel) — in progress
  3. Agent Activity Stream (route + panel) — done
  4. Voice Command Mode (Ollama intent route) — in progress
  5. Unified Agent Inbox (DB table + route + panel) — in progress
- **8 additional improvements** identified, building one at a time:
  1. Mobile shell (/m/) — started
  2. Stale detector cron
  3. Panel consolidation
  4. Agent registry (/api/agents)
  5. Voice shortcuts
  6. Quiet hours for voice
  7. Nightly digest cron
  8. Panel health check

## Verified

- `GET /api/voice/status` returns config (Natasha, edge, local-whisper)
- `POST /api/voice/tts` generates MP3 — played via pygame, audible
- `POST /api/voice/stt` transcribes audio — round-trip test returned exact text
- Server restarted successfully after route addition (restart.cjs confirmed
  new PID + /api/status 200)
- faster-whisper installed on system Python 3.13 (venv has no pip)
- Voice config saved to Hermes memory (en-AU-NatashaNeural)

## Blocked

- The Hermes venv has no pip and cannot install packages. STT uses system
  Python 3.13 as a workaround. TTS still uses the venv (edge-tts is there).

## Deviations

- Installed faster-whisper into system Python 3.13 (not the venv) because
  the venv has no pip. Owner approved this install.
- Installed pygame into system Python 3.13 for audio playback testing.
- Added voice panel to Focus panel (not just as a standalone nav panel) per
  owner instruction.

## Blocked on you

- None. All work is proceeding.

## Next

- Wire the 5 subagent-built routes + panels into server/index.js, shell.js,
  and index.html nav once all subagents finish.
- Restart server and test all 5 features end-to-end.
- Continue with the 8 improvements, one at a time, starting with the mobile
  shell.
# Handover — Focus panel speech-to-text diagnosis

## Built

No implementation changes. This was a read-only diagnosis from the focus-panel error `STT failed: ERR:No module named 'whisper'`.

## Verified

- `server/routes/voice.js` chooses `C:\Users\jcwhi\AppData\Local\Programs\Python\Python313\python.exe` for STT when it exists.
- That executable exists and runs.
- A read-only module probe using that exact interpreter reported `faster_whisper=False`, `whisper=False`, and `pip=True`.
- `python -m pip show faster-whisper openai-whisper` reported both packages absent.
- The Hermes venv also has neither module.
- `/api/voice/status` currently reports `stt.enabled: true` without probing either dependency, so the UI advertises a usable local Whisper provider before the first transcription fails.

## Blocked

`server/routes/voice.js` and `public/panels/focus/focus.js` are already dirty in the shared checkout. Do not amend either file from this block.

## Next

After the active editor commits or releases those paths, install one explicitly chosen supported dependency into the selected Python 3.13 environment (`faster-whisper` preferred by the route, or `openai-whisper`), then make the status endpoint report unavailable rather than enabled when neither import resolves. The package addition is a dependency decision and needs its normal approval.

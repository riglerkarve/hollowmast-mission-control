# Hermes Agent — creative module (M126)

## Built

- **Creative module** (M126) — the MindVirus OS idea engine. Route +
  panel + voice shortcuts.

  Route: /api/creative
  - GET /spark — random creative seed from 20 hand-written sparks
  - POST /ideas — capture an idea with tags (game, content, business,
    life, wild, tech, art)
  - GET /ideas — list captured ideas
  - GET /ideas/:id — one idea with developments
  - POST /ideas/:id/develop — develop an idea with Ollama into a
    structured concept (hook, platforms, next steps)
  - POST /prompts — generate 5 content prompts from a theme via Ollama

  Panel: /panels/creative
  - Capture: type an idea, tag it, save it
  - Spark: tap for a random creative seed, one-tap save
  - Prompts: enter a theme, get 5 content angles from Ollama
  - Ideas list: see all captured ideas, develop with Ollama, read aloud
  - Tags filter and color-code ideas

  Voice shortcuts: "spark" (random idea), "ideas" (list recent)
  Database: creative_ideas + creative_developments tables (SQLite)

  Nav: Creative button added after Second Brain, with a sparkle icon

## Verified

- /api/creative/spark returns random spark
- POST /api/creative/ideas captures and persists (id:1)
- /api/creative/ideas lists captured ideas
- Voice shortcut "spark" -> /api/creative/spark
- Panel JS/CSS serve 200
- Server restarted, PID changed, /api/status 200

## Deviations

- Used Ollama (qwen3.5:4b) for idea development and prompt generation,
  with fallback to static templates when Ollama is unavailable. No
  finance/wellbeing data sent to Ollama — this is a pure creativity tool.

## Blocked on you

- None.

## Next

- M129: Connect creative module to the board so developed ideas become
  backlog items. Route developed ideas through M128 (venture-viability
  calculator) before promoting them to the board.
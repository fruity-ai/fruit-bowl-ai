# Fruit Bowl AI

Build your own AI agent stack in a controlled, production-minded setup.

<p align="center">
  <img src="docs/images/fruit-bowl.png" alt="Fruit Bowl AI by Fruity-AI" width="980" />
</p>

**Fruit Bowl AI** by **Fruity-AI** is an open boilerplate for teams that want OpenClaw-style agent concepts in a simpler architecture where you decide exactly which skills, data surfaces, and integrations are enabled.

## Why Fruit Bowl AI
- **Bring-your-own skills**: start with one skill, expand to many.
- **Controlled environment**: local-first memory model and explicit roots.
- **Telegram-first UX**: chat with your agent from day one.
- **Stateful conversations**: follow-ups stay contextual across turns.
- **Security by default**: allowlisted users and bounded file access.

## What You Can Build
- Your own agent, tailored to your workflows, with only the skills and integrations that make sense for your team
- Ops copilots with custom automations and approval patterns
- Team-specific assistants with domain logic, internal tools, and controlled data access
- Production-ready agent foundations you can start simple and scale over time
- Data assistants as one optional example use case, not the default direction

## Core Capabilities
- General LLM chat + skill orchestration in one assistant
- Multi-skill runtime (`python_stdio` and `node_module` executors)
- Skill-specific execution loops (example: `plan -> execute -> evaluate` for data tasks)
- Session persistence per chat for continuity
- Live file discovery from memory directories while app is running

## Architecture
- `src/index.mjs`: Telegram bot transport (long polling)
- `src/agent-server.mjs`: agent orchestrator (`route -> execute -> respond`)
- `src/skills-runtime.mjs`: pluggable skill execution layer
- `src/session-store.mjs`: persistent per-chat session state
- `src/session-events.mjs`: per-session event queue
- `agent/`: agent identity, instructions, skill registry
- `memory/`: local memory surface (data, notes, knowledge)

## Quick Start

### 1) Clone repo
```bash
git clone https://github.com/fruity-ai/fruit-bowl-ai.git
cd fruit-bowl-ai
```

### 2) Install
```bash
npm install
```

### 3) Configure
```bash
cp .env.example .env
```

Set at minimum:
- `TELEGRAM_BOT_TOKEN=...`
- `OPENAI_API_KEY=...`
- `ALLOWED_USER_IDS=123456789`

Recommended:
- `CODEX_MODEL=gpt-codex-5.2`
- `MEMORY_ROOT=./memory`
- `STATE_ROOT=./state`

### 4) (Optional) Install Python dependencies for the example data skill
```bash
python3 -m pip install pandas openpyxl pyarrow pydantic
```
If that fails, create and activate a virtual environment first:
```bash
python3 -m venv .venv
source .venv/bin/activate
python3 -m pip install pandas openpyxl pyarrow pydantic
```
If you don't want to use the example skill, you can skip this step. You should also remove the `excel-data-handler` from `agent/skills/index.json` and delete the `agent/skills/excel-data-handler` directory.

### 5) Start services
```bash
npm start
```

## Security First (Important)
For public or shared environments:
1. Set `ALLOWED_USER_IDS` so only approved Telegram users can trigger the bot.
2. Optionally set `ALLOWED_CHAT_ID` for additional chat-level restriction.
3. Never commit `.env`.
4. Keep sensitive business files outside git-tracked paths.
5. Rotate API keys and bot tokens immediately if exposed.

## Memory Model
`memory/` is the agent's accessible knowledge surface:
- `memory/data/`: structured files used by data-oriented skills (optional)
- `memory/notes/`: operational notes or working docs
- `memory/knowledge/`: long-lived reference material

You can add files while the app is running. The agent refreshes context on subsequent turns.

## Stateful Conversations
Fruit Bowl AI persists conversation state per chat under `STATE_ROOT/sessions`:
- recent dialogue history
- active objective and skill context
- selected file references
- recent result summaries

This allows natural follow-ups like "same file", "continue", and "what about the dates?" without hardcoded intent scripts.

## Example Skill (Included)
### `excel-data-handler` (reference implementation)
- Supports: CSV, XLSX, XLS, Parquet
- Operations:
  - `preview`
  - `columns`
  - `describe`
  - `filter_eq`
  - `filter_contains`
  - `search_text_any_column`
  - `groupby_sum`
  - `value_counts`
  - `python_code`

For advanced asks, the agent can generate and run pandas logic via `python_code`.
This skill is included as an example of the skill contract and runtime pattern. You can replace it, disable it, or add your own skills without changing the core architecture.

## Add Your Own Skills
1. Copy the template in `agent/skills/template-skill/`
2. Register skill in `agent/skills/index.json`
3. Add `self_test_questions` for regression coverage
4. Run self-test before enabling in production

Detailed guide: `docs/SKILL_IMPLEMENTATION.md`

## Local Testing

Run full self-chat regression (without Telegram):
```bash
npm run test:self-chat
```

## Validation Commands
```bash
node --check src/index.mjs
node --check src/agent-server.mjs
node --check src/skills-runtime.mjs
node --check src/session-store.mjs
node --check src/session-events.mjs
# optional (only if using excel-data-handler)
python3 -m py_compile agent/skills/excel-data-handler/executor.py
```

## Fruity-AI
Fruit Bowl AI is built by **Fruity-AI** as a practical foundation for organizations that want to own their agent architecture and roll out capabilities safely, incrementally, and with full control.

If you want help adapting this boilerplate to your internal workflows, add your first custom skill and iterate from there.
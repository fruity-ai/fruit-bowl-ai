# Skill Implementation Guide

This guide defines the standard process for adding new skills to Fruit Bowl AI.

## Skill model
A skill is a local capability that the main agent can call when useful.

- The **agent** handles conversation, intent routing, and final responses.
- A **skill** handles domain execution.
- The contract between them is JSON through `agent/skills/index.json`.

## 1) Create the skill folder
Create a folder under `agent/skills/<skill-id>/`.

Recommended files:
- `SKILL.md`: scope, operations, constraints, examples
- executor code:
  - `executor.mjs` for `node_module`, or
  - `executor.py` for `python_stdio`

Start from template:
- `agent/skills/template-skill/SKILL.md`
- `agent/skills/template-skill/executor.mjs`

## 2) Register the skill
Add an entry to `agent/skills/index.json`.

Required fields:
- `id`
- `name`
- `description`
- `when_to_use`
- `enabled`
- `root` (recommended: `${MEMORY_ROOT}/<category>`)
- `operations`
- `examples`
- `self_test_questions` (**required for enabled skills**)
- `executor`

Recommended fields:
- `action_contract`: explicit instruction for router payload shape
- `entry`: path to `SKILL.md`

## 3) Choose executor type

### A) `python_stdio`
Use for pandas/data science/etc.

Registry example:
```json
{
  "executor": {
    "type": "python_stdio",
    "script": "agent/skills/my-skill/executor.py",
    "contextTimeoutMs": 30000,
    "executeTimeoutMs": 45000,
    "context": { "mode": "catalog", "payload": {} },
    "execute": { "mode": "execute", "payload": {} }
  }
}
```

Runtime payload fields include:
- `message`
- `action`
- `history`
- `skill_root`
- `data_root` (compat alias)
- `memory_root`
- `project_root`

### B) `node_module`
Use for JS-native skills.

Module contract:
- `async execute(payload)` -> returns `{ ok: boolean, ... }`
- optional `async getContext(payload)`

## 4) Design action contract
`action_contract` should tell the router exactly how to build actions.

Good contract includes:
- Allowed `operation` values
- Required `action.args` keys per operation
- Fallback behavior for ambiguous inputs
- Safety constraints (allowed files/paths/network)

## 5) Implement context discovery
`getContext` / context mode should return lightweight metadata only.

Good context examples:
- available files
- known entities
- table schemas
- API capability summary

Avoid heavy full-data outputs in context.

## 6) Implement execute behavior
Execution should be deterministic and structured.

Return shape recommendation:
```json
{
  "ok": true,
  "operation": "...",
  "result": "human-readable output",
  "meta": {}
}
```

On failure:
```json
{
  "ok": false,
  "error": "clear actionable error"
}
```

## 7) Safety and limits checklist
- Keep reads/writes inside `skill_root` unless explicitly intended.
- Never run shell commands from skill executors unless you intentionally add that capability.
- Validate user-provided operation args.
- Add operation-level guardrails for destructive actions.
- Use timeout settings (`contextTimeoutMs`, `executeTimeoutMs`).

## 8) Test checklist (before enabling)
1. Syntax check executor.
2. Run context path manually.
3. Run at least 3 execute scenarios:
- happy path
- ambiguous path
- failure path
4. Verify router selects skill for intended prompts.
5. Verify chat-only prompts remain in `chat` mode.
6. Add those prompts to `self_test_questions` in `agent/skills/index.json`.
7. Run `npm run test:self-chat` and ensure all skill prompts return concrete output.

## 9) Rollout checklist
1. Add skill entry with `enabled: false`.
2. Validate behavior locally.
3. Add/update `self_test_questions`.
4. Run `npm run test:self-chat`.
5. Flip to `enabled: true`.
6. Restart `npm run start:agent`.
7. Run Telegram acceptance prompts.

## 10) Versioning convention (recommended)
For non-trivial skills, add:
- `version` in registry entry
- `CHANGELOG.md` in skill folder

This keeps upgrades safe as your multi-skill system grows.

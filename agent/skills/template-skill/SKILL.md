# Skill Template

Use this folder as a starter for new skills.

## Files
- `SKILL.md`: human-readable instructions and scope.
- `executor.mjs`: runtime executor module.

## Required registry fields (`agent/skills/index.json`)
- `id`
- `name`
- `description`
- `when_to_use`
- `enabled`
- `operations`
- `examples`
- `self_test_questions` (required when `enabled: true`)
- `executor`

## Node module executor contract
If `executor.type = "node_module"`, the module must export:

- `async execute(payload)` -> `{ ok: boolean, ... }`
- optional `async getContext(payload)` -> `{ ok: boolean, ... }`

The runtime passes these payload fields:
- `message`: original user text
- `action`: router-selected action object
- `history`: recent chat history
- `skill_root`: resolved root path for this skill
- `data_root`: compatibility alias for `skill_root`
- `memory_root`: resolved memory root
- `project_root`: absolute project root

Optional executor tuning in registry:
- `executor.contextTimeoutMs`
- `executor.executeTimeoutMs`

Return machine-friendly JSON and keep text summaries short.

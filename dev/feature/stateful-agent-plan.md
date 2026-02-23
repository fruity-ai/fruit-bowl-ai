# Stateful Multi-Skill Agent Plan

## Goal
Upgrade Fruit Bowl AI from single-turn behavior to a stateful, conversation-aware Telegram agent without hardcoded intent/reply rules.

## Scope
- Keep existing transport split (`start:bot`, `start:agent`).
- Keep existing skill runtime contract.
- Add persistent session state and event-driven context injection in `agent-server`.

## Target Outcome
- Follow-ups like "ja", "ja tak", "fortsæt", "den fil" work from context.
- Fewer dead-end clarifications.
- Multi-turn skill flows (plan -> execute -> evaluate) remain coherent.
- Generic boilerplate remains skill-agnostic.

## Architecture Changes

### 1. Persistent Session Store
- Add `state/sessions/<chatKey>.json` persistence.
- Replace RAM-only dependence with load/update/save per turn.
- Keep in-memory cache as optional performance layer.

Session shape (`v1`):
- `session_id`
- `chat_key`
- `updated_at`
- `history` (bounded)
- `objective`
- `active_skill_id`
- `active_plan`
- `awaiting_user_input` (`none | confirmation | missing_param`)
- `missing_fields` (array)
- `last_selected_file`
- `last_result_summary`
- `last_error`

### 2. Turn Lifecycle (Server)
For each `/agent/turn`:
1. Load session state by `chatKey`.
2. Build prompt context from:
- persisted session state
- recent history
- skill contexts/catalog
- queued system events
3. Route (`chat | skill | clarify`) with stateful router contract.
4. Execute selected path.
5. Update session state from outcome.
6. Persist session.
7. Return final user-facing reply.

### 3. Router Contract Extension
Extend router JSON to include:
- `conversation_state`: `normal | awaiting_confirmation | awaiting_missing_param | executing`
- `resolved_references`: object (e.g. selected file)
- `missing_fields`: array
- `state_updates`: optional object for session state patching

Rules:
- No hardcoded lexical trigger handling for specific words.
- Model must infer short replies using session context.

### 4. System Events Queue
Add lightweight event queue per session:
- Example events:
- `clarification_asked`
- `skill_selected`
- `skill_failed`
- `file_selected`
- `plan_step_failed`
- Drain events into next prompt as `System:` lines.
- Clear queue after prompt construction.

### 5. Skill Loop State Integration
After skill execution / iterative Python loop:
- Write back:
- selected file
- compact result summary
- failure reason and retriable hint (if any)
- active plan snapshot

This allows next user turn to continue naturally.

### 6. Reply Composition Standards
- Chat mode: direct answer, context-aware, no template boilerplate.
- Skill mode: always include concrete result values.
- If long-running analysis: brief progress message + final result.
- Avoid "plan-only" outputs.

## Implementation Steps

### Phase A: Session Foundation
- Add `src/session-store.mjs`:
- `loadSession(chatKey)`
- `saveSession(chatKey, session)`
- `patchSession(chatKey, patch)`
- `appendHistory(chatKey, role, text)`
- Wire into `src/agent-server.mjs`.

### Phase B: Stateful Router + Events
- Add `src/session-events.mjs`.
- Extend router prompt + parser for state fields.
- Feed state + events into router/user prompts.

### Phase C: Skill Continuation
- Persist skill context outputs into session.
- Use those fields in follow-up route/plan decisions.

### Phase D: Regression Tests
Expand `src/self-test-chat.mjs` with multi-turn cases:
- Clarify -> confirm -> execute.
- Pronoun/reference follow-up ("den", "den fil").
- Post-result follow-up ("hvilke datoer var det?").
- Skill failure -> retry path.

Fail criteria:
- generic fallback loop
- missing concrete output on skill test prompts
- loss of context in follow-up turns

## Telegram Compatibility
No protocol changes required.
- Bot already forwards `chatId` and `source`.
- Agent remains behind `/agent/turn`.
- Existing `.env` and scripts continue to work.

## Risks
- Over-growing session files -> mitigate via hard caps and truncation.
- State drift -> mitigate with explicit `state_updates` and bounded schema.
- Router JSON drift -> mitigate with strict parser + fallback path.

## Definition of Done
- Persistent session survives agent restart.
- Follow-up confirmations are handled contextually without hardcoded lexical intent handlers.
- Self-test multi-turn suite passes.
- Telegram user experience remains stable and non-generic.

# Skill: Memory Writer

## Goal
Save text content to `memory/notes` or `memory/knowledge` folders.
Runtime executor: `agent/skills/memory-writer/executor.mjs`.

## When to use
- **notes**: Operational observations, session summaries, working documents, temporary findings.
- **knowledge**: Long-lived reference material, confirmed insights, stable facts worth remembering across sessions.

## Workflow
1. Router picks `folder` (`notes` or `knowledge`) based on content type.
2. Router picks a `filename` (short, descriptive, kebab-case, `.md` extension).
3. Router picks `operation`:
   - `write` — create or overwrite a file.
   - `append` — add content to the end of an existing file.
   - `list` — list existing files in a folder.
4. Executor writes to `MEMORY_ROOT/<folder>/<filename>`.

## Rules
- Always resolve paths inside MEMORY_ROOT. Never escape.
- Filenames must be `.md` or `.txt`.
- Keep notes concise and well-structured.
- Prefer append for adding to existing topics; write for new topics.

## Output style
- Confirm what was written and where.

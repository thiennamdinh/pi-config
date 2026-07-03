---
name: session-recall
description: Search prior Pi session history for previous decisions, old bugs, rationale, agent/project context, or “what did we say about…” questions. Use when continuity or historical recall matters.
---

# Session Recall Skill

Use the `session_search` tool when the user asks about prior conversations, old decisions, previous bugs/fixes, historical rationale, cross-agent context, or anything like “what did we say/decide/do about X?”

Guidelines:

- Prefer targeted filters:
  - current agent first when the question is local to this agent;
  - a named agent when obvious, e.g. `agent: "bartimaeus"`, `agent: "louise"`, `agent: "rocky"`;
  - current `cwd`/project when the question is project-specific.
- Search all agents only when the user asks broadly or the responsible agent is unclear.
- If the index is missing/stale and recall matters, call `session_index_status`, then `session_index_update` if needed.
- Treat search hits as pointers/evidence, not guaranteed truth. Important details should be verified against the source session/file or current repository state before acting.
- Do not dump large retrieved context into the answer. Summarize relevant hits and cite the source pointer when useful.
- Prefer recall before asking the user to re-explain old context.

Current implementation note: the index defaults to local Ollama embeddings (`nomic-embed-text`) when available, with a deterministic hash backend reserved for smoke tests/fallback. Phrase queries with concrete names, file paths, agents, tools, and distinctive terms still help retrieval quality.

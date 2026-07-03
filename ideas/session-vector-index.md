# Session Vector Index / Agent Recall

Goal: make Pi's long-lived JSONL sessions searchable indefinitely without replacing Pi's canonical session storage.

## Design stance

- Keep Pi JSONL sessions as source of truth.
- Treat LanceDB as a rebuildable sidecar index/cache, not canonical history.
- Do not refactor Pi core session storage.
- Prefer agent/tool use over human-facing search UI. Thien-Nam does not expect to query the index manually.
- Keep initial implementation simple and local. Avoid daemons, cloud vector DBs, or background complexity until the index proves useful.

## Storage

Use embedded LanceDB OSS, SQLite-style in-process:

```text
~/.pi/cache/session-index/
  lancedb/              # LanceDB tables
  state.json            # optional incremental scan state
```

LanceDB on disk is a directory of table fragments/manifests/indexes, not one mutable SQLite file. It is safe to delete and rebuild because JSONL remains canonical.

## Extension

Global extension location:

```text
~/.pi/agent/extensions/session-index/index.ts
```

Responsibilities:

1. Backfill/update index from agent session JSONL files.
2. Optionally index the current session incrementally after turns or on shutdown later.
3. Register agent-facing tools:
   - `session_search`
   - `session_index_update` or maintenance-only equivalent
   - `session_index_status`
4. Avoid a human `/session-search` command unless Thien-Nam later asks; this is primarily for agent recall.

## What to index

Index chunks derived from session entries, not whole files.

Good v1 chunks:

- user messages;
- assistant text responses;
- custom messages such as reflection summaries;
- compaction summaries;
- branch summaries;
- bash commands plus short output previews;
- tool results selectively, especially errors or compact textual outputs.

Skip or limit by default:

- huge tool outputs;
- binary/image content;
- raw secret/auth files;
- reflection logs/snapshots;
- generated caches, dependency directories, build artifacts;
- private token material.

## Metadata / tags

Attach enough structured metadata for filtering, ranking, and source recovery:

```ts
{
  chunkId,
  source: "pi-session",
  agent,
  sessionId,
  sessionFile,
  entryId,
  parentId,
  chunkIndex,
  role,
  entryType,
  timestamp,
  cwd,
  sessionName,
  textHash,
  contentKind,
  language,
  paths,
  tools,
  provider,
  model,
  inputTokens,
  outputTokens,
  cost,
  isError,
  embeddingModel,
  chunkerVersion,
  indexedAt,
  sourceMtime,
  sourceSize,
  includeInRecall,
  sensitivity
}
```

Initial implementation can store arrays as JSON strings if LanceDB/Arrow typing makes list columns annoying.

## Embeddings

Preferred long-term path: real local or API embedding model with versioned config.

Initial real backend: local Ollama embeddings via `nomic-embed-text` (`ollama:nomic-embed-text`). This keeps recall private/local and avoids OpenAI API billing. A deterministic hash backend remains useful only as a fast smoke-test/fallback via `PI_SESSION_INDEX_EMBED_BACKEND=hash`.

CPU embedding backfill can be slow. Prefer scoped/current-agent updates first; full all-agent backfills should be incremental/overnight or moved to a faster embedding stack later.

Embedding metadata must include:

```text
embeddingModel
embeddingVersion / chunkerVersion
```

so reindexing is straightforward.

## Agent-facing use

Register a tool like:

```ts
session_search({
  query,
  agent?,
  cwd?,
  since?,
  until?,
  limit?,
  mode?: "vector" | "fts" | "hybrid"
})
```

MVP can use vector search only. Add FTS/hybrid after the table/index path is stable.

Returned hits should be compact pointers, not giant transcript dumps:

```text
agent · timestamp · role/contentKind · sessionFile · entryId · score
snippet
```

Treat hits as evidence/pointers. If exactness matters, read the source JSONL/session entry.

## Cross-agent skill

Create a global skill:

```text
~/.pi/agent/skills/session-recall/SKILL.md
```

Behavior guidance:

- Use `session_search` when asked about prior decisions, old bugs, previous conversations, rationale, agent/project history, or “what did we say about X?”
- Prefer filters: current agent first, relevant named agent if obvious, current cwd/project for project-specific questions.
- Search all agents only when the user asks broadly or the responsible agent is unclear.
- Retrieval is not truth. Verify important details in the source session/log/file before acting on them.
- Do not automatically inject large retrieved context.
- Use search before asking the user to remember old context.

## Implementation sequence

1. Add this design note.
2. Implement session-index extension skeleton with embedded LanceDB.
3. Add `session_index_update` maintenance tool to scan `~/.pi/agents/*/session/*.jsonl` and root `~/.pi/agent/sessions/**/*.jsonl` later if desired.
4. Add `session_index_status`.
5. Add `session_search` tool.
6. Add `session-recall` skill.
7. Smoke-test with a small subset/backfill.
8. Later: real embeddings, FTS/hybrid search, incremental `turn_end`/`session_shutdown` indexing, source-entry reader, and richer chunk metadata.

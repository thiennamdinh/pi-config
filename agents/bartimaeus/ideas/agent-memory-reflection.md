# Agent Memory, Notebooks, and Reflection

Goal: keep persistent named agents useful over long sessions without letting always-injected memory become stale, bloated, or misleading.

## Current model

Named-agent context currently has three durable layers:

- `AGENTS.md` — durable identity, role, operating rules, and high-priority instructions. Always injected.
- `memory/*.md` — reflected/sticky agent memory. Currently injected wholesale by the agent-workspaces extension.
- `session/*.jsonl` — canonical conversation/session history. Recent history is model-facing through Pi's normal session/compaction behavior; older history is raw audit/search material.

New convention:

- `notebook/` — durable agent-owned notes, research, maps, scratch writeups, and details the agent may search/read later. Not injected by default.
- `artifacts/` — task outputs, generated files, consultation clone logs/sessions, and run-specific byproducts.

Key distinction: the important design axis is **injected vs not injected**, not an elaborate memory taxonomy.

## Desired memory semantics

Memory should be persistent, but not append-only or unlimited.

Injected memory is prompt budget. It should contain only concise, durable, currently useful context:

- current mission / active project state;
- decisions still in force;
- durable user/project preferences;
- known pitfalls that remain true;
- pointers to notebook files for deeper detail.

Large histories, stale branch maps, completed TODOs, detailed research notes, and old implementation notes should move to `notebook/` or remain discoverable through sessions/search.

## File structure

Prefer a few topical memory files over one giant file:

```text
memory/
  current.md      # active state and open work
  durable.md      # stable lessons/preferences/constraints
  project.md      # optional project-specific sticky context
notebook/
  projects/...
  research/...
  debugging/...
```

Benefits of multiple files:

- selective injection later;
- per-file budgets/freshness metadata;
- easier reflection maintenance;
- easier archival to notebook;
- lower conflict risk;
- better human browsing.

Avoid arbitrary sprawl; notebooks are for freeform detail.

## Budgets

Add per-agent memory budget configuration, with sensible defaults.

Possible manifest fields:

```json
{
  "memoryBudgetTokens": 6000,
  "memoryInject": ["memory/*.md"],
  "memoryExclude": ["memory/archive/**", "memory/reports/**"]
}
```

Default budget policy:

- default target: 10% of model context window, or about 25k tokens when the context window is unknown/around 272k;
- acceptable reflection band: ±25% of target, i.e. 75%–125% of the configured budget;
- if memory is below the lower band, reflection should bootstrap/expand memory with useful durable observations from recent sessions;
- if memory is above the upper band, reflection should reduce/compress memory while preserving high-value durable learnings;
- warning threshold: 15% of context window;
- hard pressure threshold: 25% of context window;
- 25% is acceptable only as an explicit heavy/specialist-agent mode, not the default.

Initial behavior:

- estimate injected memory tokens on agent start;
- report whether memory is below band, within band, or above band;
- warn if above the upper band or over the warning threshold;
- do not silently truncate at first;
- later add status/audit commands.

Possible commands:

```text
/agent-memory-status [agent]
/agent-memory-audit [agent]
```

## Reflection

Reflection is per-agent memory maintenance. It should modify memory, nothing more and nothing less. The goal is balanced reflection: promote useful durable learnings from recent sessions while pruning stale or oversized always-injected memory.

Proposed process:

```text
fork/orphan session for target agent
read current memory + recent session context + notebook as needed
add concise durable learnings from recent sessions
remove/compress stale, redundant, or oversized memory
edit only ~/.pi/agents/<agent>/memory/**
exit
```

The main agent does not need an explicit "reflection happened" message. Next time it runs, it simply receives better memory. The reflection transcript is already preserved in the fork/orphan session for audit/debug if needed.

## Trigger policy

Primary trigger should be usage/compaction-based, not nightly wall-clock scheduling.

Rationale:

- memory changes should track actual agent activity;
- idle agents should not rewrite memory pointlessly;
- heavily used agents may need reflection multiple times per day;
- compaction is a natural boundary for "what did this context segment teach us?";
- reflection should happen after the conversation loop is idle, never mid-turn.

Default trigger shape:

```json
{
  "memoryReflection": {
    "enabled": true,
    "afterCompactions": 8,
    "mode": "usage-triggered"
  }
}
```

Operational flow:

```text
agent session reaches 8 compactions by default, or another configured usage milestone
extension records memory-reflection-needed for that agent
after current turn is idle:
  snapshot memory
  fork/orphan reflection session
  allow reads only under the target agent workspace
  allow edits only under the target agent's memory/
  atomically publish updated memory files
next main-agent turn receives updated memory
```

Keep manual reflection as an override, analogous to manual compaction:

```text
/reflect                    # reflect current agent memory
/reflect <agent>            # optionally reflect another named agent if implemented safely
/agent-memory-reflect [agent] # explicit/verbose alias
```

`/reflect` should run after the current conversation turn is idle, fork/orphan a reflection session, snapshot memory, and atomically publish memory edits. It should not mutate memory mid-turn.

Scheduled/nightly reflection can remain an optional fallback, but should not be the primary mechanism.

Guardrails:

- Reflection may read only under the target agent workspace: `~/.pi/agents/<agent>/`.
- Reflection must not read project repositories, other agents' workspaces, global user memory, credentials, or unrelated local files.
- Only the local target agent's `memory/` may be updated.
- Do not edit `AGENTS.md`, `notebook/`, `artifacts/`, or `session/` during reflection.
- Enforce or at least report the memory token target band after edits.
- Run per-agent, not as a single global rewrite.
- Do not only shrink memory: add high-value facts, decisions, user preferences, pitfalls, and active state when recent sessions reveal them.
- Prefer moving stale detail to `notebook/` only if explicitly allowed; otherwise reduce injected memory by summarizing/pointering.

## Snapshot guardrail: option B

Use local snapshots instead of per-agent Git repos.

Before a reflection edits memory:

```text
~/.pi/agents/<agent>/memory/.snapshots/<timestamp>/
```

contains a copy of the pre-reflection memory files.

Recovery/diff can be simple:

```bash
diff -ru memory/.snapshots/<timestamp>/ memory/
```

Potential helper commands later:

```text
/agent-memory-diff <agent> [snapshot]
/agent-memory-rollback <agent> [snapshot]
```

Rationale: avoids tiny Git repos and public repo concerns while preserving rollback/audit for memory maintenance.

## Implementation order

1. Keep `notebook/` convention and creation for new/cloned agents.
2. Add memory injection include/exclude + token-budget settings.
3. Add `/agent-memory-status` to show injected files and estimated tokens.
4. Add reflection-mode tool guard: reads only under target agent workspace; writes only under target `memory/`.
5. Add snapshot helper around memory edits.
6. Add manual `/reflect` command, with `/agent-memory-reflect [agent]` as explicit alias, that edits only local `memory/`.
7. Add usage/compaction-triggered reflection after idle, with atomic memory publish.
7. Consider optional scheduled fallback later.
8. Consider session/FTS indexing later if retrospective search becomes painful.

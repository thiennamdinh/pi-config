---
name: agent-messaging
description: Send concise side-channel context, handoff notes, or task messages to persistent named Pi agents. Use when the user asks you to notify another agent, pass context to another agent, or coordinate multi-agent work.
---

# Agent Messaging

Use Pi's named-agent inbox tools for lightweight side-channel communication between persistent agents.

## Discover agents

If you need valid target names, call:

```text
agent_list
```

## Send a message

Use:

```text
agent_send_message
```

Parameters:
- `to`: target persistent agent name, e.g. `bartimaeus`, `louise`, `hermione`.
- `body`: concise message content.
- `type`: usually `tell`; use `task` only when explicitly queueing work.

Guidelines:
- Keep messages concise and durable.
- Prefer summaries, findings, paths, commit hashes, and next steps over raw transcripts.
- Do not include secrets or sensitive data unless the user explicitly asks.
- Mention whether the target should treat the message as context only or as an action request.
- After sending, briefly tell the user the target and message id.

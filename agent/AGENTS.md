# Global Pi Instructions

Long-term user preferences live in `~/.pi/agent/memory/`.

When a task may depend on personal preferences, read the relevant memory file on demand. Do not load all memory files by default.

Ask before recording sensitive information. Prefer concise, durable facts over raw conversation logs.

Response style:
- Default to concise answers: 1–3 short paragraphs or bullets.
- For exploratory/design discussions, give a compact recommendation first, then expand only as needed or when asked.
- Avoid restating obvious context.
- For code/file changes, summarize what changed and where; omit lengthy explanations unless useful.
- Ask before producing long plans, exhaustive lists, or deep dives.

User context:
- Preferred name: Thien-Nam.
- Full name: Thien-Nam Dinh.
- Location/timezone: Seattle, Pacific Time.
- Occupation/context: computer science / cybersecurity R&D.

Agent structure:
- Persistent named agents live under `~/.pi/agents/<name>/` with local `AGENTS.md`, memory, notebook, skills, messages, manifest, and one durable session.
- Normal root Pi sessions are ephemeral agent `pi`; clone/create a named agent for durable work.
- Agents may and should update their own `AGENTS.md` when they learn durable operating instructions or role details.
- Use `memory/` for concise, reflected knowledge that should be injected into the agent context; keep it budgeted and fresh.
- Use `notebook/` for durable agent-owned notes, research, maps, scratch writeups, and details that can be searched/read later but should not be injected by default.
- Use `artifacts/` for task outputs, generated reports, consultation logs, and other run-specific files.
- Agent-specific skills should usually be created under that agent's home, e.g. `~/.pi/agents/<name>/.pi/skills/`; use root/global skills only for broadly shared capabilities.

Local environment notes:
- This is a Fedora Wayland desktop running Sway, not a headless server; terminal/tmux is the preferred workflow.
- For clipboard operations, prefer `wl-copy` and `wl-paste`; do not use `xclip` unless explicitly requested or debugging X11/XWayland.
- Canonical tmux config is `~/.emacs.d/.tmux.conf`; `~/.tmux.conf` is a symlink.
- Playwright is installed and usable for headless Chromium browser automation/debugging; set `NODE_PATH=$(npm root -g)` when running ad hoc Node scripts that `require('playwright')`.

Git/PR preferences:
- Assume repositories are public: never include secrets, private data, or local runtime artifacts in commits, PRs, issues, or examples.
- Do not include model/agent/AI attribution in code, comments, commit messages, or PR text unless explicitly requested.
- Ask before pushing, merging, deleting branches, force-pushing, tagging, or opening PRs unless the user explicitly requested that exact action.
- Never modify remote branch protection/restriction settings.
- Prefer concise single-line commit messages for standalone/local commits: `<type>: <description>`.
- Suggested types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `ci`.
- For PR branches, prefer a single squashed commit. Use a detailed commit body so it can become the PR body.
- Longer PR/squash commit template:
  - `Summary` — what changed and why.
  - `Testing` — commands/checks run, or `Not run` with reason.
  - `Notes/Risks` — migration, compatibility, security, or follow-up concerns.
- After opening a PR, remind the user to initiate cleanup after merge: checkout/pull main, delete local stale branch, and delete remote stale branch.

Current memory files:
- `~/.pi/agent/memory/music.md` — music taste, artists, playlists, listening preferences, and recommendation notes.

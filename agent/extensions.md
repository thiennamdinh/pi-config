# Extension Ideas

## 1. RSS / News Digest

Build a Pi-first local news pipeline:

- Use cron or a systemd timer to fetch RSS/Atom feeds into a neutral local store, e.g. SQLite or JSON under `~/.local/share/pi-news/`.
- Add Pi tools for querying the store:
  - `news_latest(topic?, since?, unreadOnly?)`
  - `news_search(query)`
  - `news_digest(since?, topic?)`
  - `news_discover_feeds(urlOrTopic)`
  - `news_add_feed(url)`
  - `news_mark_read(ids)`
- Use `pi -p` for scheduled non-interactive summarization, e.g.:

  ```bash
  pi -p --no-session "Read recent RSS items, summarize the last hour, and append interesting tidbits to news.md."
  ```

- Keep raw news/archive data outside Pi memory. Use memory only for durable preferences, such as preferred topics, source trust, and dislike of push notifications.
- Prefer pull-based consumption: user asks for updates conversationally rather than receiving spammy notifications.
- Design the data store so OpenClaw could consume it later if background daemon/channel UI becomes useful.

## 2. Sensitive File Redaction / Security Guard

Adapt the `security` extension idea from `~/projects/agents/pi-env`:

- Intercept `read` tool results for known sensitive file names before contents reach the model/session history.
- Redact files like `.env`, `auth.json`, credential/token files, private keys, cloud credentials, and browser/session secrets.
- Return a short notice instead, e.g. `[auth.json redacted — edit directly if needed]`.
- Keep edits possible when explicitly requested, but avoid ever reading raw secret material into context.
- Start simple with filename/path blocklist; later consider content scanning for accidental secrets in ordinary files.

## 3. Subagents / Delegated Roles

Explore a small subagent setup rather than a full orchestration framework. Main Pi remains the conversational decision-maker and primary editor; subagents do bounded work and return compressed results.

Candidate agents:

- `scout` — read-only codebase reconnaissance. Finds relevant files, APIs, line ranges, architecture notes, and suggested starting points before implementation.
- `reviewer` — read-only adversarial review. Inspects diffs/code for bugs, security issues, maintainability problems, and missed edge cases. Should report concrete file/line findings.
- `researcher` — read-only web/docs/current-info research. Uses web search/fetch, gathers sources, and returns cited compressed findings without editing local files.
- `tester` — focused verification/failure-analysis agent. Runs or designs tests, reproduces failures, inspects logs, and recommends minimal fixes. Distinct from `reviewer`: reviewer critiques code; tester exercises behavior.

Initial preference: keep subagents read-only where possible. Let the main Pi decide which recommendations to act on and perform edits unless a task is very isolated.

## 4. Fire-and-Forget / Topic Sidecars

Higher priority than full subagents for low-context recurring domains.

Goals:

- Avoid blocking/cluttering the main Pi session for small side effects.
- Run occasional one-off commands in isolated topic contexts with only the relevant tools/memory.
- Keep outputs minimal unless explicitly requested.

Candidate topic sidecars:

- `music` — Spotify tools + `music.md`; examples: play, pause, queue, remember music preferences.
- `pi-ext` — Pi config/extensions/tmux tweaks; knows Pi docs paths, `~/.pi/agent/`, and `~/.emacs.d/.tmux.conf`.
- `notes` — capture ideas, summarize sessions, append to a chosen notes inbox once a notes location is decided.

Possible command shape:

```text
/topic music "play upbeat electronic"
/topic pi-ext "prototype async spotify pause"
/topic notes "summarize this session into my inbox"
```

Implementation idea: spawn `pi -p --session-id topic-<name>` with topic-specific tools, prompt prefix, memory files, and short timeout. For Spotify specifically, also consider direct `spotify_*_async` tools that return immediately and log errors separately.

## 5. Long-Running Background Agents

Explore separately from fire-and-forget side effects and synchronous subagents.

Use case: spin up bounded-but-long tasks that may run for minutes/hours without occupying the main chat, such as:

- one-shotting inconsequential apps/prototypes
- deep web research with source collection
- large codebase reconnaissance
- batch data cleanup/classification
- long debugging or reproduction attempts

Possible model:

```text
/background start research "investigate X and write findings to ..."
/background status
/background attach <job>
/background stop <job>
```

Implementation ideas:

- Spawn separate Pi processes in tmux/vterm or as detached subprocesses.
- Require each job to write artifacts to a job directory, e.g. `~/.pi/agent/jobs/<id>/`.
- Keep bus/status/log files separate from main context; main Pi only reads summaries on demand.
- Use explicit tool/model/time/resource limits per job.
- Prefer bounded jobs with clear deliverables over indefinite autonomous agents.

## 6. Global / Named Session Ergonomics

Explore a lightweight layer above Pi's existing session tree/session-file model.

Motivation:

- Current `/resume` behavior is cwd/project-scoped, but sessions already carry cwd and Pi can switch runtimes via `ctx.switchSession()`.
- Build a global session picker that searches all session dirs and switches to the selected session without restarting Pi, restoring that session's cwd/project context.
- Make sessions feel more like named buffers.

Possible commands:

```text
/global-resume          # pick from all sessions across cwd dirs
/buffers                # alias with Emacs-like framing
/new-named <name>       # create a new session and immediately name it
/fork-named <name>      # fork and name the resulting session
/clone-named <name>     # clone active branch and name result
/rename <name>          # friendlier alias for /name
```

Implementation notes:

- Use `SessionManager.listAll()` to discover sessions globally.
- Use `ctx.switchSession(sessionPath)` for in-process runtime replacement.
- Display name, cwd, modified time, and session id in the picker.
- Preserve Pi's existing tree semantics; this is only a more global/named navigation layer.
- This may become the foundation for higher-level named agent workspaces.

## 7. Speculative Emacs/vterm Pi Sessions

Explore Emacs as a buffer manager for named Pi sessions now that `vterm` works well.

Potential model:

```text
*pi:main*
*pi:music*
*pi:news*
*pi:pi-ext*
```

Each vterm buffer runs its own Pi process/session, e.g. `pi --session-id topic-music`, while Emacs provides native buffer/window switching. Keep current tmux flow unchanged while testing.

Questions to explore:

- Whether vterm handles Pi TUI/cursor/keybindings well enough long term.
- How to balance Emacs keybindings vs raw terminal input.
- Whether Emacs should host Pi buffers directly or just launch/switch tmux Pi panes.
- Whether named Pi sessions can feel like Emacs buffers without adding too much process-management complexity.

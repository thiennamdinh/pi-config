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

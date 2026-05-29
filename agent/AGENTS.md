# Global Pi Instructions

Long-term user preferences live in `~/.pi/agent/memory/`.

When a task may depend on personal preferences, read the relevant memory file on demand. Do not load all memory files by default.

Ask before recording sensitive information. Prefer concise, durable facts over raw conversation logs.

User context:
- Preferred name: Thien-Nam.
- Location/timezone: Seattle, Pacific Time.
- Occupation/context: computer science / cybersecurity R&D.

Local environment notes:
- This is a Fedora Wayland desktop, not a headless server; terminal/tmux is the preferred workflow.
- For clipboard operations, prefer `wl-copy` and `wl-paste`; do not use `xclip` unless explicitly requested or debugging X11/XWayland.
- Canonical tmux config is `~/.emacs.d/.tmux.conf`; `~/.tmux.conf` is a symlink.
- Playwright is installed and usable for headless Chromium browser automation/debugging; set `NODE_PATH=$(npm root -g)` when running ad hoc Node scripts that `require('playwright')`.

Current memory files:
- `~/.pi/agent/memory/music.md` — music taste, artists, playlists, listening preferences, and recommendation notes.

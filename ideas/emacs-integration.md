# Emacs Integration Ideas

Goal: explore Emacs as a comfortable manager for Pi sessions without disrupting the current tmux-first workflow.

## Current baseline

- tmux remains the primary Pi terminal workflow.
- `vterm` is installed and works.
- Multiple vterm buffers can run separate Pi processes.
- Pi TUI works well enough in terminal/tmux; vterm should be treated as experimental until proven ergonomic.

## Candidate model

Use named Emacs buffers for named Pi sessions:

```text
*pi:main*
*pi:music*
*pi:news*
*pi:pi-ext*
*pi:research*
```

Each buffer runs a Pi process with a stable session id or project cwd, e.g.:

```sh
pi --session-id topic-music
pi --session-id topic-news
```

## Desired commands

Possible Emacs commands:

- `tn/pi-main` — open or switch to main Pi buffer.
- `tn/pi-topic` — prompt for a topic name and open/switch to `*pi:<topic>*`.
- `tn/pi-project` — launch Pi in the current project/default-directory.
- `tn/pi-send-region` — send selected text to a Pi/vterm buffer.
- `tn/pi-switch` — quick switch among Pi buffers.

## Open questions

- Does vterm preserve Pi keybindings, cursor behavior, and rendering reliably enough for daily use?
- Should Emacs create direct Pi vterm buffers, or should it control tmux panes/sessions instead?
- Should topic Pi buffers be long-lived interactive sessions or short-lived `pi -p` sidecars?
- How much should Emacs know about Pi session ids versus simply naming buffers?

## MVP

1. Keep tmux bindings unchanged.
2. Add a small Emacs helper to create/switch vterm Pi buffers by topic name.
3. Use stable `--session-id pi-<topic>` names for topic buffers.
4. Test with non-critical topics first: `music`, `pi-ext`, `notes`.

## Risks

- vterm keybinding conflicts with Emacs global bindings.
- More always-open buffers may become visual clutter.
- Multiple live Pi sessions can fragment context unless each has a clear role.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const execFileAsync = promisify(execFile);

type RunResult = { stdout: string; stderr: string };

function sanitizeName(name: string): string {
  const cleaned = name.trim().replace(/[^A-Za-z0-9_.-]/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || `emacs-test-${Date.now()}`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function defaultSessionName(): string {
  return `pi-emacs-test-${process.pid}`;
}

async function run(command: string, args: string[], signal?: AbortSignal, timeout = 15000): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      signal,
      timeout,
      maxBuffer: 10 * 1024 * 1024,
      encoding: "utf8",
    });
    return { stdout: stdout ?? "", stderr: stderr ?? "" };
  } catch (error: any) {
    const stdout = error?.stdout ?? "";
    const stderr = error?.stderr ?? "";
    const message = stderr || stdout || error?.message || String(error);
    throw new Error(`${command} ${args.map(shellQuote).join(" ")} failed\n${message}`);
  }
}

async function tmux(args: string[], signal?: AbortSignal, timeout = 15000): Promise<RunResult> {
  return run("tmux", args, signal, timeout);
}

async function waitForEmacsServer(serverName: string, signal?: AbortSignal): Promise<void> {
  const expr = "(progn 'ready)";
  let lastError = "";
  for (let i = 0; i < 30; i += 1) {
    if (signal?.aborted) throw new Error("Aborted while waiting for Emacs server");
    try {
      await run("emacsclient", ["-s", serverName, "-e", expr], signal, 3000);
      return;
    } catch (error: any) {
      lastError = error?.message ?? String(error);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw new Error(`Emacs server ${serverName} did not become ready. Last error:\n${lastError}`);
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "emacs_tmux_start",
    label: "Emacs tmux start",
    description: "Start a disposable tmux session running terminal Emacs for UI/keybinding smoke tests.",
    promptSnippet: "Start disposable terminal Emacs in tmux for UI/keybinding testing.",
    promptGuidelines: [
      "Use this to test Emacs UI behavior with real terminal keypresses, then use emacs_tmux_capture and emacs_tmux_eval to inspect results.",
      "Prefer temporary files and always stop sessions with emacs_tmux_stop when finished.",
    ],
    parameters: Type.Object({
      sessionName: Type.Optional(Type.String({ description: "tmux session/server name. Default: pi-emacs-test-<pid>." })),
      file: Type.Optional(Type.String({ description: "File to open. Defaults to a temp markdown file." })),
      cwd: Type.Optional(Type.String({ description: "Working directory for the tmux session. Defaults to current cwd." })),
      initFile: Type.Optional(Type.String({ description: "Emacs init file to load. Defaults to ~/.emacs.d/init.el." })),
      quick: Type.Optional(Type.Boolean({ description: "Use emacs -Q without loading the user init file." })),
      width: Type.Optional(Type.Number({ description: "tmux window width. Default 120." })),
      height: Type.Optional(Type.Number({ description: "tmux window height. Default 36." })),
      killExisting: Type.Optional(Type.Boolean({ description: "Kill an existing tmux session with the same name first. Default false." })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const sessionName = sanitizeName(params.sessionName ?? defaultSessionName());
      const serverName = sessionName;
      const cwd = resolve(params.cwd ?? ctx.cwd);
      const initFile = resolve(params.initFile ?? `${process.env.HOME}/.emacs.d/init.el`);
      const file = resolve(params.file ?? join(tmpdir(), `${sessionName}.md`));
      const width = String(Math.max(40, Math.min(300, Math.floor(params.width ?? 120))));
      const height = String(Math.max(12, Math.min(100, Math.floor(params.height ?? 36))));

      if (params.killExisting) {
        await tmux(["kill-session", "-t", sessionName], signal).catch(() => undefined);
      }

      let command = `emacs -nw -Q --eval ${shellQuote(`(progn (require 'server) (setq server-name ${JSON.stringify(serverName)}) (server-start))`)}`;
      if (!params.quick && existsSync(initFile)) {
        command += ` -l ${shellQuote(initFile)}`;
      }
      command += ` ${shellQuote(file)}`;

      await tmux(["new-session", "-d", "-s", sessionName, "-x", width, "-y", height, "-c", cwd, command], signal);
      await waitForEmacsServer(serverName, signal);
      const capture = await tmux(["capture-pane", "-t", sessionName, "-p"], signal);

      return {
        content: [{ type: "text", text: `Started ${sessionName} (${width}x${height})\nfile: ${file}\nserver: ${serverName}\n\n${capture.stdout.trimEnd()}` }],
        details: { sessionName, serverName, cwd, file, initFile: params.quick ? undefined : initFile, width: Number(width), height: Number(height) },
      };
    },
  });

  pi.registerTool({
    name: "emacs_tmux_keys",
    label: "Emacs tmux keys",
    description: "Send literal text and/or tmux key names to a disposable Emacs tmux session.",
    promptSnippet: "Send real terminal keys to an Emacs tmux test session.",
    parameters: Type.Object({
      sessionName: Type.Optional(Type.String({ description: "tmux session name. Default: pi-emacs-test-<pid>." })),
      text: Type.Optional(Type.String({ description: "Literal text to type before sending key names." })),
      keys: Type.Optional(Type.Array(Type.String(), { description: "tmux send-keys key names, e.g. Escape, Tab, C-g, g, h." })),
      capture: Type.Optional(Type.Boolean({ description: "Capture pane after sending keys. Default true." })),
    }),
    async execute(_id, params, signal) {
      const sessionName = sanitizeName(params.sessionName ?? defaultSessionName());
      if (params.text && params.text.length > 0) {
        await tmux(["send-keys", "-t", sessionName, "-l", params.text], signal);
      }
      if (params.keys && params.keys.length > 0) {
        await tmux(["send-keys", "-t", sessionName, ...params.keys], signal);
      }
      let text = `Sent keys to ${sessionName}.`;
      let details: Record<string, unknown> = { sessionName, sentText: params.text, sentKeys: params.keys ?? [] };
      if (params.capture ?? true) {
        const capture = await tmux(["capture-pane", "-t", sessionName, "-p"], signal);
        text += `\n\n${capture.stdout.trimEnd()}`;
        details.capture = capture.stdout;
      }
      return { content: [{ type: "text", text }], details };
    },
  });

  pi.registerTool({
    name: "emacs_tmux_capture",
    label: "Emacs tmux capture",
    description: "Capture the visible text of a disposable Emacs tmux session.",
    promptSnippet: "Capture the visible terminal Emacs screen from tmux.",
    parameters: Type.Object({
      sessionName: Type.Optional(Type.String({ description: "tmux session name. Default: pi-emacs-test-<pid>." })),
      startLine: Type.Optional(Type.Number({ description: "tmux capture-pane -S start line. Default visible pane." })),
    }),
    async execute(_id, params, signal) {
      const sessionName = sanitizeName(params.sessionName ?? defaultSessionName());
      const args = ["capture-pane", "-t", sessionName, "-p"];
      if (params.startLine !== undefined) args.push("-S", String(Math.floor(params.startLine)));
      const capture = await tmux(args, signal);
      return { content: [{ type: "text", text: capture.stdout.trimEnd() }], details: { sessionName, capture: capture.stdout } };
    },
  });

  pi.registerTool({
    name: "emacs_tmux_eval",
    label: "Emacs tmux eval",
    description: "Evaluate Emacs Lisp in a disposable Emacs tmux session via emacsclient.",
    promptSnippet: "Inspect terminal Emacs internal state with Emacs Lisp via emacsclient.",
    parameters: Type.Object({
      sessionName: Type.Optional(Type.String({ description: "tmux session / Emacs server name. Default: pi-emacs-test-<pid>." })),
      expr: Type.String({ description: "Emacs Lisp expression to evaluate." }),
    }),
    async execute(_id, params, signal) {
      const sessionName = sanitizeName(params.sessionName ?? defaultSessionName());
      const result = await run("emacsclient", ["-s", sessionName, "-e", params.expr], signal, 10000);
      return { content: [{ type: "text", text: result.stdout.trimEnd() || result.stderr.trimEnd() }], details: { sessionName, expr: params.expr, stdout: result.stdout, stderr: result.stderr } };
    },
  });

  pi.registerTool({
    name: "emacs_tmux_stop",
    label: "Emacs tmux stop",
    description: "Stop a disposable Emacs tmux test session.",
    promptSnippet: "Clean up disposable Emacs tmux test sessions.",
    parameters: Type.Object({
      sessionName: Type.Optional(Type.String({ description: "tmux session name. Default: pi-emacs-test-<pid>." })),
    }),
    async execute(_id, params, signal) {
      const sessionName = sanitizeName(params.sessionName ?? defaultSessionName());
      await tmux(["kill-session", "-t", sessionName], signal);
      return { content: [{ type: "text", text: `Stopped ${sessionName}.` }], details: { sessionName } };
    },
  });

  pi.registerTool({
    name: "emacs_tmux_list",
    label: "Emacs tmux list",
    description: "List tmux sessions that look like disposable Emacs test sessions.",
    promptSnippet: "List disposable Emacs tmux test sessions.",
    parameters: Type.Object({}),
    async execute(_id, _params, signal) {
      const result = await tmux(["list-sessions", "-F", "#{session_name}\t#{session_windows}\t#{session_created_string}"], signal).catch((error) => ({ stdout: "", stderr: String(error) }));
      const sessions = result.stdout
        .split("\n")
        .filter((line) => /(^|\t)(pi-)?emacs-test|emacs/.test(line))
        .join("\n");
      return { content: [{ type: "text", text: sessions || "No Emacs-like tmux test sessions found." }], details: { raw: result.stdout } };
    },
  });
}

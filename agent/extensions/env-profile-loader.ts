import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { spawnSync } from "node:child_process";

const STATUS_KEY = "env-profile";
const PROFILE_FILES = ["~/.profile", "~/.bash_profile", "~/.bashrc"];
const DEFAULT_ALLOW = /^(BRAVE|SPOTIFY|OPENAI|ANTHROPIC|GOOGLE|GEMINI|GITHUB|GITLAB|AWS|AZURE|MCP|PI)_[A-Z0-9_]*(KEY|TOKEN|SECRET|CLIENT_ID|CLIENT_SECRET|URL|ENDPOINT|REGISTRY|AUTH|ID)$/;

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function safeNotify(ctx: ExtensionContext | undefined, message: string, level: "info" | "warning" = "info") {
  try {
    if (ctx?.hasUI) ctx.ui.notify(message, level);
  } catch {
    // Ignore stale UI contexts during reload/shutdown.
  }
}

function safeStatus(ctx: ExtensionContext | undefined, value: string | undefined) {
  try {
    if (ctx?.hasUI) ctx.ui.setStatus(STATUS_KEY, value);
  } catch {
    // Ignore stale UI contexts during reload/shutdown.
  }
}

function allowRegex() {
  const raw = process.env.PI_PROFILE_ENV_ALLOW_REGEX;
  if (!raw) return DEFAULT_ALLOW;
  try {
    return new RegExp(raw);
  } catch {
    return DEFAULT_ALLOW;
  }
}

function loadProfileEnv() {
  const sourceCommands = PROFILE_FILES.map((file) => `f=${shellQuote(file)}; f=\${f/#~/$HOME}; [ -r "$f" ] && . "$f" >/dev/null 2>/dev/null || true`).join("; ");
  const marker = `__PI_ENV_${process.pid}_${Date.now()}__`;
  const script = `${sourceCommands}; printf '${marker}\\0'; env -0`;
  const result = spawnSync("bash", ["-lc", script], {
    encoding: "buffer",
    env: { ...process.env },
    maxBuffer: 2 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`profile env load exited with code ${result.status}`);

  const stdout = result.stdout;
  const markerBuffer = Buffer.from(`${marker}\0`);
  const start = stdout.indexOf(markerBuffer);
  if (start < 0) throw new Error("profile env marker not found");
  const envBytes = stdout.subarray(start + markerBuffer.length);
  const allowed = allowRegex();
  const changed: string[] = [];

  for (const entry of envBytes.toString("utf8").split("\0")) {
    if (!entry) continue;
    const eq = entry.indexOf("=");
    if (eq <= 0) continue;
    const key = entry.slice(0, eq);
    const value = entry.slice(eq + 1);
    if (!allowed.test(key)) continue;
    if (process.env[key] !== value) {
      process.env[key] = value;
      changed.push(key);
    }
  }
  return changed.sort();
}

function reload(ctx?: ExtensionContext) {
  try {
    const changed = loadProfileEnv();
    safeStatus(ctx, changed.length ? `env reloaded: ${changed.length}` : undefined);
    setTimeout(() => safeStatus(ctx, undefined), 15_000);
    return changed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    safeStatus(ctx, undefined);
    safeNotify(ctx, `Profile env reload failed: ${message}`, "warning");
    return [];
  }
}

export default function envProfileLoader(pi: ExtensionAPI) {
  // Extension modules are re-evaluated on /reload, so this refreshes process.env
  // even if session_start is not re-emitted by the host.
  reload(undefined);

  pi.on("session_start", async (_event, ctx) => {
    reload(ctx);
  });
}

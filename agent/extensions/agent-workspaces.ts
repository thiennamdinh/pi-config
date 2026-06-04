import type { ExtensionAPI, ExtensionCommandContext, ReplacedSessionContext } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { constants } from "node:fs";
import { access, appendFile, cp, mkdir, open, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const HOME = process.env.HOME ?? ".";
const AGENTS_ROOT = join(HOME, ".pi", "agents");
const TRASH_ROOT = join(AGENTS_ROOT, ".trash");
const EPHEMERAL_PI_SESSION_DIR = join(HOME, ".pi", "agent", "tmp", "pi-ephemeral-sessions");
const EXT_CUSTOM_TYPE = "agent-workspaces";
const LOCK_STALE_MS = 24 * 60 * 60 * 1000;

let allowNextManagedSwitchToPi = false;

type Manifest = {
  name: string;
  description?: string;
  model?: string;
  thinkingLevel?: string;
  tools?: string[];
  permissions?: Record<string, unknown>;
  cwdPolicy: "agent-home";
  sessionFile?: string;
  maxRuntimeSeconds?: number;
};

type MessageType = "tell" | "ask" | "task" | "execute" | "answer" | "event";

type AgentMessage = {
  id: string;
  type: MessageType;
  from: string;
  to: string;
  body: string;
  replyTo?: string;
  createdAt: string;
  status: "queued" | "processing" | "done" | "failed";
};

let activeAgent: string | null = null;
let activeLockPath: string | null = null;

function validateAgentName(name: string, options: { allowPi?: boolean } = {}) {
  const trimmed = name.trim();
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(trimmed) || trimmed.includes("--") || trimmed.endsWith("-")) {
    throw new Error("Agent names must be lowercase kebab-case, start with a letter, and be 1-63 chars.");
  }
  if (trimmed === ".trash") throw new Error(`Reserved agent name: ${trimmed}`);
  if (trimmed === "pi" && !options.allowPi) throw new Error("Reserved agent name: pi");
  return trimmed;
}

function sanitizeName(name: string) {
  return validateAgentName(name);
}

function sanitizeTargetName(name: string) {
  return validateAgentName(name, { allowPi: true });
}

function agentDir(name: string) {
  return join(AGENTS_ROOT, name);
}

function manifestPath(name: string) {
  return join(agentDir(name), "manifest.json");
}

function sessionDir(name: string) {
  return join(agentDir(name), "session");
}

function messagesPath(name: string) {
  return join(agentDir(name), "messages.jsonl");
}

function lockPath(name: string) {
  return join(agentDir(name), ".active.lock");
}

async function exists(path: string) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJson(path: string, value: unknown) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function listAgents() {
  await mkdir(AGENTS_ROOT, { recursive: true });
  const { readdir } = await import("node:fs/promises");
  const names = await readdir(AGENTS_ROOT);
  const out: string[] = [];
  for (const name of names) {
    if (name.startsWith(".")) continue;
    if (await exists(manifestPath(name))) out.push(name);
  }
  return out.sort();
}

async function listAgentTargets() {
  return ["pi", ...(await listAgents())];
}

function currentAgentFromCwd(cwd: string) {
  const root = resolve(AGENTS_ROOT);
  const current = resolve(cwd);
  if (!current.startsWith(`${root}/`)) return null;
  const rel = current.slice(root.length + 1);
  const name = rel.split("/")[0];
  if (!name || name.startsWith(".")) return null;
  return existsSync(manifestPath(name)) ? name : null;
}

async function readManifest(name: string): Promise<Manifest> {
  return readJson<Manifest>(manifestPath(name));
}

async function writeManifest(manifest: Manifest) {
  await writeJson(manifestPath(manifest.name), manifest);
}

function nowIso() {
  return new Date().toISOString();
}

function makeId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function parseModel(model: string | undefined) {
  if (!model) return null;
  const slash = model.indexOf("/");
  if (slash <= 0) return null;
  return { provider: model.slice(0, slash), modelId: model.slice(slash + 1) };
}

async function forceWriteSession(manager: SessionManager) {
  const file = manager.getSessionFile();
  const header = manager.getHeader();
  if (!file || !header) throw new Error("Cannot write session without file/header.");
  await mkdir(dirname(file), { recursive: true });
  const entries = [header, ...manager.getEntries()];
  await writeFile(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
}

async function rewriteSessionWorkspace(sessionFile: string, name: string) {
  const cwd = agentDir(name);
  const lines = (await readFile(sessionFile, "utf8")).split("\n").filter((line) => line.trim());
  const entries = lines.map((line) => JSON.parse(line));
  let sawSessionInfo = false;
  for (const entry of entries) {
    if (entry.type === "session") entry.cwd = cwd;
    if (entry.type === "session_info") {
      entry.name = name;
      sawSessionInfo = true;
    }
  }
  if (!sawSessionInfo) {
    const manager = SessionManager.open(sessionFile, sessionDir(name), cwd);
    manager.appendSessionInfo(name);
    await forceWriteSession(manager);
    return;
  }
  await writeFile(sessionFile, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
}

async function createAgentWorkspace(name: string, description = "") {
  name = sanitizeName(name);
  const dir = agentDir(name);
  if (await exists(dir)) throw new Error(`Agent already exists: ${name}`);

  await mkdir(join(dir, "memory"), { recursive: true });
  await mkdir(join(dir, ".pi", "skills"), { recursive: true });
  await mkdir(sessionDir(name), { recursive: true });
  await mkdir(join(dir, "artifacts"), { recursive: true });
  await writeFile(join(dir, "AGENTS.md"), `# ${name}\n\nPersistent local Pi agent workspace.\n`);
  await writeFile(messagesPath(name), "");

  const manager = SessionManager.create(dir, sessionDir(name));
  manager.appendSessionInfo(name);
  await forceWriteSession(manager);
  const sessionFile = manager.getSessionFile();
  if (!sessionFile) throw new Error("Could not create persistent session file.");

  const manifest: Manifest = {
    name,
    description,
    cwdPolicy: "agent-home",
    sessionFile,
  };
  await writeManifest(manifest);
  return manifest;
}

async function ensureAgentSession(name: string) {
  const manifest = await readManifest(name);
  if (manifest.sessionFile && (await exists(manifest.sessionFile))) return manifest.sessionFile;

  const manager = SessionManager.create(agentDir(name), sessionDir(name));
  manager.appendSessionInfo(name);
  await forceWriteSession(manager);
  const sessionFile = manager.getSessionFile();
  if (!sessionFile) throw new Error("Could not create persistent session file.");
  manifest.sessionFile = sessionFile;
  await writeManifest(manifest);
  return sessionFile;
}

async function createEphemeralPiSession() {
  await mkdir(EPHEMERAL_PI_SESSION_DIR, { recursive: true });
  const manager = SessionManager.create(HOME, EPHEMERAL_PI_SESSION_DIR);
  manager.appendSessionInfo("pi");
  await forceWriteSession(manager);
  const sessionFile = manager.getSessionFile();
  if (!sessionFile) throw new Error("Could not create ephemeral pi session file.");
  return sessionFile;
}

async function switchToPi(ctx: ExtensionCommandContext, note?: string, runPrompt?: string) {
  const sessionFile = await createEphemeralPiSession();
  await ctx.waitForIdle();
  allowNextManagedSwitchToPi = true;
  await ctx.switchSession(sessionFile, {
    withSession: async (next: ReplacedSessionContext) => {
      next.ui.notify(note ?? "Switched to ephemeral agent pi", "info");
      next.ui.setStatus?.("agent-workspace", "agent:pi");
      if (runPrompt) {
        await next.sendUserMessage(runPrompt);
        await next.waitForIdle();
      }
    },
  });
}

async function switchToAgent(pi: ExtensionAPI, name: string, ctx: ExtensionCommandContext, note?: string, runPrompt?: string) {
  name = sanitizeTargetName(name);
  if (name === "pi") return switchToPi(ctx, note, runPrompt);
  const sessionFile = await ensureAgentSession(name);
  await ctx.waitForIdle();
  await ctx.switchSession(sessionFile, {
    withSession: async (next: ReplacedSessionContext) => {
      next.ui.notify(note ?? `Switched to agent ${name}`, "info");
      await applyManifest(pi, name, next);
      if (runPrompt) {
        await next.sendUserMessage(runPrompt);
        await next.waitForIdle();
      }
    },
  });
}

async function applyManifest(pi: ExtensionAPI, name: string, ctx: { modelRegistry: ExtensionCommandContext["modelRegistry"]; ui: ExtensionCommandContext["ui"] }) {
  const manifest = await readManifest(name);
  const model = parseModel(manifest.model);
  if (model) {
    const resolved = ctx.modelRegistry.find(model.provider, model.modelId);
    if (resolved) await pi.setModel(resolved);
    else ctx.ui.notify(`Agent ${name}: model not found: ${manifest.model}`, "warning");
  }
  if (manifest.thinkingLevel) pi.setThinkingLevel(manifest.thinkingLevel as any);
  if (manifest.tools) pi.setActiveTools(manifest.tools);
  ctx.ui.setStatus?.("agent-workspace", `agent:${name}`);
}

async function appendAgentMessage(to: string, message: Omit<AgentMessage, "id" | "to" | "createdAt" | "status"> & { status?: AgentMessage["status"] }) {
  to = sanitizeTargetName(to);
  const full: AgentMessage = {
    id: makeId("msg"),
    to,
    createdAt: nowIso(),
    status: message.status ?? "queued",
    ...message,
  };
  if (to === "pi") return full;
  if (!(await exists(manifestPath(to)))) throw new Error(`Unknown agent: ${to}`);
  await appendFile(messagesPath(to), `${JSON.stringify(full)}\n`);
  return full;
}

async function currentAgent(ctx: ExtensionCommandContext) {
  return currentAgentFromCwd(ctx.cwd) ?? "pi";
}

async function acquireLock(name: string, ctx: { cwd: string; sessionManager: { getSessionFile(): string | undefined } }) {
  if (name === "pi") return;
  const path = lockPath(name);
  await mkdir(dirname(path), { recursive: true });
  const payload = JSON.stringify({ pid: process.pid, cwd: ctx.cwd, sessionFile: ctx.sessionManager.getSessionFile(), startedAt: nowIso() }, null, 2);

  try {
    const fh = await open(path, "wx");
    await fh.writeFile(`${payload}\n`);
    await fh.close();
    activeAgent = name;
    activeLockPath = path;
    return;
  } catch (err: any) {
    if (err?.code !== "EEXIST") throw err;
  }

  try {
    const existing = JSON.parse(await readFile(path, "utf8"));
    const pid = Number(existing.pid);
    const sameProcess = pid === process.pid;
    const staleByTime = existing.startedAt && Date.now() - Date.parse(existing.startedAt) > LOCK_STALE_MS;
    const alive = Number.isFinite(pid) && pid > 0 ? process.kill(pid, 0) || true : false;
    if (sameProcess || staleByTime || !alive) {
      await rm(path, { force: true });
      return acquireLock(name, ctx);
    }
    throw new Error(`Agent ${name} is already active in pid ${pid}.`);
  } catch (err: any) {
    if (err?.code === "ESRCH") {
      await rm(path, { force: true });
      return acquireLock(name, ctx);
    }
    if (err instanceof SyntaxError) {
      await rm(path, { force: true });
      return acquireLock(name, ctx);
    }
    throw err;
  }
}

async function releaseLock() {
  if (!activeLockPath) return;
  await unlink(activeLockPath).catch(() => undefined);
  activeLockPath = null;
  activeAgent = null;
}

async function queuedMessages(name: string) {
  const path = messagesPath(name);
  if (!(await exists(path))) return [] as AgentMessage[];
  const lines = (await readFile(path, "utf8")).split("\n").filter((line) => line.trim());
  return lines
    .map((line) => {
      try {
        return JSON.parse(line) as AgentMessage;
      } catch {
        return undefined;
      }
    })
    .filter((msg): msg is AgentMessage => Boolean(msg) && (msg.status === "queued" || msg.status === "processing"));
}

async function agentInstructions(name: string) {
  const dir = agentDir(name);
  const chunks: string[] = [];
  const ag = join(dir, "AGENTS.md");
  if (await exists(ag)) chunks.push(`## Agent-local AGENTS.md\n\n${await readFile(ag, "utf8")}`);

  const memDir = join(dir, "memory");
  if (await exists(memDir)) {
    const { readdir } = await import("node:fs/promises");
    for (const file of (await readdir(memDir)).sort()) {
      if (!file.endsWith(".md")) continue;
      chunks.push(`## Agent memory: ${file}\n\n${await readFile(join(memDir, file), "utf8")}`);
    }
  }

  const messages = await queuedMessages(name);
  if (messages.length) {
    chunks.push(`## Pending agent messages\n\n${messages.map((msg) => JSON.stringify(msg)).join("\n")}`);
  }

  return chunks.join("\n\n");
}

function usage(ctx: ExtensionCommandContext, text: string) {
  ctx.ui.notify(text, "warning");
}

export default function agentWorkspaces(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    const name = currentAgentFromCwd(ctx.cwd);
    if (name) {
      try {
        await acquireLock(name, ctx);
        await applyManifest(pi, name, ctx as any);
      } catch (err) {
        ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
        ctx.shutdown();
      }
    } else {
      ctx.ui.setStatus?.("agent-workspace", "agent:pi");
    }
  });

  pi.on("session_shutdown", async () => {
    await releaseLock();
  });

  pi.on("session_before_switch", async (event, ctx) => {
    const name = currentAgentFromCwd(ctx.cwd);
    if (!name) return;
    if (allowNextManagedSwitchToPi) {
      allowNextManagedSwitchToPi = false;
      return;
    }
    if (!event.targetSessionFile) return { cancel: true };
    const target = resolve(event.targetSessionFile);
    const root = resolve(AGENTS_ROOT);
    const agentManagedTarget = target.startsWith(`${root}/`) && target.includes("/session/");
    if (!agentManagedTarget) {
      ctx.ui.notify(`Agent ${name} is managed. Use /agent-switch, /agent-new, or /agent-clone instead.`, "warning");
      return { cancel: true };
    }
  });

  pi.on("session_before_fork", async (_event, ctx) => {
    const name = currentAgentFromCwd(ctx.cwd);
    if (!name) return;
    ctx.ui.notify(`Agent ${name} is managed. Use /agent-clone <new-name> instead of /fork or /clone.`, "warning");
    return { cancel: true };
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const name = currentAgentFromCwd(ctx.cwd);
    if (!name) return;
    const extra = await agentInstructions(name);
    if (!extra.trim()) return;
    return {
      systemPrompt: `${event.systemPrompt}\n\n<agent-workspace name="${name}">\n${extra}\n</agent-workspace>`,
    };
  });

  pi.registerCommand("agent-list", {
    description: "List persistent named agents",
    handler: async (_args, ctx) => {
      const agents = await listAgents();
      const current = await currentAgent(ctx);
      ctx.ui.notify([`Current agent: ${current}`, `Agents:\n- pi${current === "pi" ? " (current)" : ""}${agents.length ? `\n${agents.map((a) => `- ${a}${a === current ? " (current)" : ""}`).join("\n")}` : ""}`].join("\n\n"), "info");
    },
  });

  pi.registerCommand("agent-new", {
    description: "Create a new persistent named agent",
    handler: async (args, ctx) => {
      const [name, ...rest] = args.trim().split(/\s+/).filter(Boolean);
      if (!name) return usage(ctx, "Usage: /agent-new <name> [description]");
      await createAgentWorkspace(name, rest.join(" "));
      await switchToAgent(pi, name, ctx, `Created agent ${name}`);
    },
  });

  pi.registerCommand("agent-switch", {
    description: "Switch to a named agent, including ephemeral pi",
    getArgumentCompletions: async (prefix) => (await listAgentTargets()).filter((a) => a.startsWith(prefix)).map((a) => ({ value: a, label: a })),
    handler: async (args, ctx) => {
      const name = args.trim();
      if (!name) return usage(ctx, "Usage: /agent-switch <name>");
      await switchToAgent(pi, name, ctx);
    },
  });

  pi.registerCommand("agent-clone", {
    description: "Clone the current agent/session into a new persistent agent",
    handler: async (args, ctx) => {
      const newName = sanitizeName(args.trim());
      const source = currentAgentFromCwd(ctx.cwd);
      if (await exists(agentDir(newName))) throw new Error(`Agent already exists: ${newName}`);

      if (source) {
        const currentFile = ctx.sessionManager.getSessionFile();
        await cp(agentDir(source), agentDir(newName), { recursive: true, force: false });
        await rm(lockPath(newName), { force: true });
        await rm(sessionDir(newName), { recursive: true, force: true });
        await mkdir(sessionDir(newName), { recursive: true });
        const manifest = await readManifest(newName);
        manifest.name = newName;
        if (currentFile) {
          const forked = SessionManager.forkFrom(currentFile, agentDir(newName), sessionDir(newName));
          forked.appendSessionInfo(newName);
          await forceWriteSession(forked);
          manifest.sessionFile = forked.getSessionFile();
        } else {
          manifest.sessionFile = undefined;
        }
        await writeJson(manifestPath(newName), manifest);
      } else {
        await createAgentWorkspace(newName, "Cloned from ephemeral pi session");
        const manifest = await readManifest(newName);
        const currentFile = ctx.sessionManager.getSessionFile();
        if (currentFile) {
          const forked = SessionManager.forkFrom(currentFile, agentDir(newName), sessionDir(newName));
          forked.appendSessionInfo(newName);
          await forceWriteSession(forked);
          manifest.sessionFile = forked.getSessionFile();
          await writeManifest(manifest);
        }
      }
      await switchToAgent(pi, newName, ctx, `Cloned current session to agent ${newName}`);
    },
  });

  pi.registerCommand("agent-rename", {
    description: "Rename the current persistent agent",
    handler: async (args, ctx) => {
      const source = currentAgentFromCwd(ctx.cwd);
      if (!source) throw new Error("Ephemeral pi cannot be renamed. Use /agent-clone <new-name>.");
      const newName = sanitizeName(args.trim());
      if (await exists(agentDir(newName))) throw new Error(`Agent already exists: ${newName}`);
      await releaseLock();
      await rename(agentDir(source), agentDir(newName));
      const manifest = await readManifest(newName);
      manifest.name = newName;
      if (manifest.sessionFile) {
        manifest.sessionFile = manifest.sessionFile.replace(agentDir(source), agentDir(newName));
        await rewriteSessionWorkspace(manifest.sessionFile, newName);
      }
      await writeJson(manifestPath(newName), manifest);
      await switchToAgent(pi, newName, ctx, `Renamed ${source} to ${newName}`);
    },
  });

  pi.registerCommand("agent-delete", {
    description: "Move the current persistent agent to ~/.pi/agents/.trash/",
    handler: async (_args, ctx) => {
      const name = currentAgentFromCwd(ctx.cwd);
      if (!name) throw new Error("Ephemeral pi cannot be deleted.");
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const dest = join(TRASH_ROOT, `${name}-${stamp}`);
      await mkdir(TRASH_ROOT, { recursive: true });
      await releaseLock();
      await rename(agentDir(name), dest);
      ctx.ui.notify(`Moved agent ${name} to ${dest}`, "info");
      await ctx.newSession();
    },
  });

  pi.registerCommand("agent-task", {
    description: "Append a queued user task to another agent without running it",
    getArgumentCompletions: async (prefix) => (await listAgentTargets()).filter((a) => a.startsWith(prefix)).map((a) => ({ value: a, label: a })),
    handler: async (args, ctx) => {
      const [to, ...bodyParts] = args.trim().split(/\s+/);
      const body = bodyParts.join(" ").trim();
      if (!to || !body) return usage(ctx, "Usage: /agent-task <agent> <message>");
      const from = await currentAgent(ctx);
      if (to === "pi") {
        ctx.ui.notify("Ephemeral pi has no durable task queue; use /agent-execute pi <message> to run now.", "warning");
        return;
      }
      const msg = await appendAgentMessage(to, { type: "task", from, body });
      ctx.ui.notify(`Queued task ${msg.id} for ${to}`, "info");
    },
  });

  pi.registerCommand("agent-tell", {
    description: "Send a blocking tell message to another agent",
    getArgumentCompletions: async (prefix) => (await listAgentTargets()).filter((a) => a.startsWith(prefix)).map((a) => ({ value: a, label: a })),
    handler: async (args, ctx) => {
      const [to, ...bodyParts] = args.trim().split(/\s+/);
      const body = bodyParts.join(" ").trim();
      if (!to || !body) return usage(ctx, "Usage: /agent-tell <agent> <message>");
      const from = await currentAgent(ctx);
      const msg = await appendAgentMessage(to, { type: "tell", from, body, status: "processing" });
      await switchToAgent(pi, to, ctx, `Tell from ${from} (${msg.id})`, `Process this agent-tell message. Metadata: ${JSON.stringify(msg)}\n\nBody:\n${body}`);
    },
  });

  pi.registerCommand("agent-ask", {
    description: "Ask another agent a question",
    getArgumentCompletions: async (prefix) => (await listAgentTargets()).filter((a) => a.startsWith(prefix)).map((a) => ({ value: a, label: a })),
    handler: async (args, ctx) => {
      const [to, ...bodyParts] = args.trim().split(/\s+/);
      const body = bodyParts.join(" ").trim();
      if (!to || !body) return usage(ctx, "Usage: /agent-ask <agent> <question>");
      const from = await currentAgent(ctx);
      const msg = await appendAgentMessage(to, { type: "ask", from, body, status: "processing" });
      await switchToAgent(pi, to, ctx, `Ask from ${from} (${msg.id})`, `Answer this agent-ask message. Metadata: ${JSON.stringify(msg)}\n\nQuestion:\n${body}`);
    },
  });

  pi.registerCommand("agent-execute", {
    description: "Run-now task for another agent",
    getArgumentCompletions: async (prefix) => (await listAgentTargets()).filter((a) => a.startsWith(prefix)).map((a) => ({ value: a, label: a })),
    handler: async (args, ctx) => {
      const [to, ...bodyParts] = args.trim().split(/\s+/);
      const body = bodyParts.join(" ").trim();
      if (!to || !body) return usage(ctx, "Usage: /agent-execute <agent> <message>");
      const from = await currentAgent(ctx);
      const msg = await appendAgentMessage(to, { type: "execute", from, body, status: "processing" });
      await switchToAgent(pi, to, ctx, `Execute from ${from} (${msg.id})`, `Execute this agent-execute message. Metadata: ${JSON.stringify(msg)}\n\nTask:\n${body}`);
    },
  });

  pi.registerTool({
    name: "agent_list",
    label: "Agent List",
    description: "List persistent named Pi agents.",
    promptSnippet: "List persistent named Pi agents.",
    parameters: Type.Object({}),
    async execute() {
      const agents = await listAgents();
      return { content: [{ type: "text", text: agents.length ? agents.join("\n") : "No persistent agents." }], details: { agents } };
    },
  });
}

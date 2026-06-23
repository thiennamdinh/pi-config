import type { ExtensionAPI, ExtensionCommandContext, ReplacedSessionContext } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { closeSync, constants, openSync } from "node:fs";
import { access, appendFile, cp, mkdir, open, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { spawn } from "node:child_process";

const HOME = process.env.HOME ?? ".";
const AGENTS_ROOT = join(HOME, ".pi", "agents");
const TRASH_ROOT = join(AGENTS_ROOT, ".trash");
const EPHEMERAL_PI_SESSION_DIR = join(HOME, ".pi", "agent", "tmp", "pi-ephemeral-sessions");
const EXT_CUSTOM_TYPE = "agent-workspaces";
const LOCK_STALE_MS = 24 * 60 * 60 * 1000;
const IS_EPHEMERAL_CLONE = Boolean(process.env.PI_AGENT_EPHEMERAL_CLONE);
const IS_REFLECTION = Boolean(process.env.PI_AGENT_REFLECTION);
const REFLECTION_TARGET = process.env.PI_AGENT_REFLECTION_TARGET;
const DEFAULT_MEMORY_BUDGET_TOKENS = 25_000;
const DEFAULT_REFLECTION_AFTER_COMPACTIONS = 8;

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
  memoryBudgetTokens?: number;
  memoryReflection?: {
    enabled?: boolean;
    afterCompactions?: number;
  };
};

type MessageType = "tell" | "ask" | "ask_request" | "task" | "execute" | "answer" | "ask_answer" | "event";

type AgentMessage = {
  id: string;
  type: MessageType;
  from: string;
  to: string;
  body: string;
  replyTo?: string;
  createdAt: string;
  status: "queued" | "processing" | "done" | "failed" | "absorbed";
  artifactPath?: string;
  error?: string;
  updatedAt?: string;
  absorbedAt?: string;
};

let activeAgent: string | null = null;
let activeLockPath: string | null = null;
let recoveryTimer: NodeJS.Timeout | undefined;
let inboxNoticeTimer: NodeJS.Timeout | undefined;
const reflectionWatchTimers = new Map<string, NodeJS.Timeout>();
const notifiedInboxMessageIds = new Map<string, Set<string>>();

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

function memoryDir(name: string) {
  return join(agentDir(name), "memory");
}

function reflectionStatePath(name: string) {
  return join(memoryDir(name), ".reflection-state.json");
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
  await mkdir(join(dir, "notebook"), { recursive: true });
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
      if (inboxNoticeTimer) clearInterval(inboxNoticeTimer);
      inboxNoticeTimer = undefined;
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
      startInboxNoticeLoop(name, next as any);
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
  if (IS_REFLECTION) pi.setActiveTools(["read", "grep", "find", "ls", "edit", "write"]);
  else if (manifest.tools) pi.setActiveTools(manifest.tools);
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

async function appendAgentMessageFrom(fromAgent: string, message: Omit<AgentMessage, "id" | "createdAt" | "status"> & { status?: AgentMessage["status"] }) {
  fromAgent = sanitizeTargetName(fromAgent);
  const full: AgentMessage = {
    id: makeId("msg"),
    from: fromAgent,
    createdAt: nowIso(),
    status: message.status ?? "queued",
    ...message,
  } as AgentMessage;
  if (fromAgent === "pi") return full;
  if (!(await exists(manifestPath(fromAgent)))) throw new Error(`Unknown agent: ${fromAgent}`);
  await appendFile(messagesPath(fromAgent), `${JSON.stringify(full)}\n`);
  return full;
}

function preview(text: string, max = 1200) {
  const oneLine = text.trim().replace(/\s+/g, " ");
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

function markdownEscapeFence(text: string) {
  return text.replace(/```/g, "`\\`\\`");
}

function estimateTokens(text: string) {
  return Math.ceil(text.length / 4);
}

function memoryBudgetTokens(manifest: Manifest) {
  return manifest.memoryBudgetTokens && manifest.memoryBudgetTokens > 0 ? Math.floor(manifest.memoryBudgetTokens) : DEFAULT_MEMORY_BUDGET_TOKENS;
}

function memoryBand(budget: number) {
  return { lower: Math.floor(budget * 0.75), upper: Math.ceil(budget * 1.25) };
}

function memoryReflectionAfterCompactions(manifest: Manifest) {
  return manifest.memoryReflection?.afterCompactions && manifest.memoryReflection.afterCompactions > 0
    ? Math.floor(manifest.memoryReflection.afterCompactions)
    : DEFAULT_REFLECTION_AFTER_COMPACTIONS;
}

function memoryReflectionEnabled(manifest: Manifest) {
  return manifest.memoryReflection?.enabled ?? true;
}

async function injectedMemoryFiles(name: string) {
  const { readdir } = await import("node:fs/promises");
  const dir = memoryDir(name);
  if (!(await exists(dir))) return [] as { path: string; relativePath: string; text: string; tokens: number }[];
  const files = (await readdir(dir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => entry.name)
    .sort();
  const out = [] as { path: string; relativePath: string; text: string; tokens: number }[];
  for (const file of files) {
    const path = join(dir, file);
    const text = await readFile(path, "utf8");
    out.push({ path, relativePath: `memory/${file}`, text, tokens: estimateTokens(text) });
  }
  return out;
}

async function memoryStatus(name: string) {
  const manifest = await readManifest(name);
  const files = await injectedMemoryFiles(name);
  const tokens = files.reduce((sum, file) => sum + file.tokens, 0);
  const budget = memoryBudgetTokens(manifest);
  const band = memoryBand(budget);
  const state = tokens < band.lower ? "below" : tokens > band.upper ? "above" : "within";
  return { name, files, tokens, budget, band, state };
}

function formatMemoryStatus(status: Awaited<ReturnType<typeof memoryStatus>>, reflectionState: Record<string, any> = {}) {
  const fileLines = status.files.length
    ? status.files.map((file) => `- ${file.relativePath}: ~${file.tokens} tokens`).join("\n")
    : "- no injected memory files";
  const reflectionLines = reflectionState.lastReflectionCompletedAt
    ? [
        "",
        "Last reflection:",
        `- completed: ${reflectionState.lastReflectionCompletedAt}`,
        reflectionState.lastReflectionBeforeTokens !== undefined && reflectionState.lastReflectionAfterTokens !== undefined
          ? `- memory: ~${reflectionState.lastReflectionBeforeTokens} → ~${reflectionState.lastReflectionAfterTokens} tokens`
          : undefined,
        reflectionState.lastReflectionSessionDir ? `- logs: ${reflectionState.lastReflectionSessionDir}` : undefined,
        reflectionState.lastReflectionSummary ? `\nSidecar summary:\n${preview(String(reflectionState.lastReflectionSummary), 3000)}` : undefined,
      ].filter(Boolean).join("\n")
    : "";
  return `Agent memory status: ${status.name}\n\nInjected memory: ~${status.tokens} tokens\nTarget: ${status.budget} tokens\nBand: ${status.band.lower}–${status.band.upper} tokens\nState: ${status.state}\n\nFiles:\n${fileLines}${reflectionLines}`;
}

async function snapshotMemory(name: string) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const src = memoryDir(name);
  const dest = join(src, ".snapshots", stamp);
  await mkdir(dest, { recursive: true });
  if (await exists(src)) {
    const { readdir } = await import("node:fs/promises");
    for (const entry of await readdir(src, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      await cp(join(src, entry.name), join(dest, entry.name), { force: true });
    }
  }
  return dest;
}

function parseTargetAndBody(args: string): [string, string] | undefined {
  const [to, ...bodyParts] = args.trim().split(/\s+/);
  const body = bodyParts.join(" ").trim();
  if (!to || !body) return undefined;
  return [to, body];
}

function consultationDir(agent: string, id: string) {
  return join(agentDir(agent), "artifacts", "consultations", id);
}

function artifactRelativePath(agent: string, artifactPath: string) {
  return relative(agentDir(agent), artifactPath);
}

async function latestAssistantText(sessionDirectory: string) {
  const { readdir } = await import("node:fs/promises");
  if (!(await exists(sessionDirectory))) return "";
  const files = (await readdir(sessionDirectory)).filter((file) => file.endsWith(".jsonl")).sort();
  const latest = files.at(-1);
  if (!latest) return "";
  const lines = (await readFile(join(sessionDirectory, latest), "utf8")).split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lines[i]);
      const message = entry.message;
      if (entry.type !== "message" || message?.role !== "assistant") continue;
      return (message.content ?? [])
        .filter((part: any) => part?.type === "text")
        .map((part: any) => part.text)
        .join("\n")
        .trim();
    } catch {
      // Ignore malformed lines in recovery path.
    }
  }
  return "";
}

function buildClonePrompt(target: string, from: string, requestId: string, body: string) {
  return `You are an ephemeral read-only consultation clone of agent ${target}.

Your answer will be returned to ${from} and logged for the real ${target}. You are advisory: do not assume your response is automatically absorbed by the live target session. If you make durable observations the real ${target} should remember, include a short section titled "Notes for ${target}".

Rules:
- Answer as ${target} in first person. Do not refer to ${target} in third person except inside "Notes for ${target}".
- Answer the caller's question directly and concisely, but include enough detail to be useful.
- Treat this as read-only consultation. Do not edit files or perform side effects.
- If more context is needed, say what would be needed.
- Request id: ${requestId}
- Caller: ${from}
- Target agent: ${target}

Caller request:
${body}`;
}

async function buildReflectionPrompt(target: string, budget: number) {
  const templatePath = join(HOME, ".pi", "prompts", "agent-memory-reflection.md");
  const template = await readFile(templatePath, "utf8");
  return template
    .replaceAll("{agent_name}", target)
    .replaceAll("{agent_dir}", agentDir(target))
    .replaceAll("{memory_budget_tokens}", String(budget));
}

async function startReflection(targetRaw: string, sourceSessionFile?: string) {
  const target = sanitizeName(targetRaw);
  if (!(await exists(manifestPath(target)))) throw new Error(`Unknown agent: ${target}`);
  const manifest = await readManifest(target);
  const budget = memoryBudgetTokens(manifest);
  const before = await memoryStatus(target);
  const snapshotPath = await snapshotMemory(target);
  const reflectionId = makeId("reflect");
  const reflectionSessionDir = join(sessionDir(target), "reflections", reflectionId);
  await mkdir(reflectionSessionDir, { recursive: true });
  const systemPrompt = await buildReflectionPrompt(target, budget);
  const systemPromptPath = join(reflectionSessionDir, "reflection-system.md");
  await writeFile(systemPromptPath, systemPrompt);
  const userPrompt = "Perform memory reflection now. Edit the target agent memory as needed according to the reflection-mode system instructions, then stop.";
  const model = manifest.model ? ["--model", manifest.model] : [];
  const thinking = manifest.thinkingLevel ? ["--thinking", manifest.thinkingLevel] : [];
  const fork = sourceSessionFile ? ["--fork", sourceSessionFile] : [];
  const args = [
    "-p",
    "--session-dir",
    reflectionSessionDir,
    ...fork,
    "--append-system-prompt",
    systemPromptPath,
    "--tools",
    "read,grep,find,ls,edit,write",
    ...model,
    ...thinking,
    userPrompt,
  ];
  const stdoutPath = join(reflectionSessionDir, "stdout.log");
  const stderrPath = join(reflectionSessionDir, "stderr.log");
  const jobPath = join(reflectionSessionDir, "job.json");
  await writeJson(jobPath, { target, reflectionId, cwd: agentDir(target), args, sourceSessionFile, budget, before, snapshotPath, systemPromptPath, userPrompt, stdoutPath, stderrPath, startedAt: nowIso() });

  let stdoutFd: number | undefined;
  let stderrFd: number | undefined;
  try {
    stdoutFd = openSync(stdoutPath, "a");
    stderrFd = openSync(stderrPath, "a");
    const child = spawn("pi", args, {
      cwd: agentDir(target),
      env: { ...process.env, PI_AGENT_REFLECTION: "1", PI_AGENT_REFLECTION_TARGET: target, PI_AGENT_REFLECTION_ID: reflectionId },
      detached: true,
      stdio: ["ignore", stdoutFd, stderrFd],
    });
    child.unref();
    closeSync(stdoutFd);
    closeSync(stderrFd);
    stdoutFd = undefined;
    stderrFd = undefined;
    return { target, reflectionId, reflectionSessionDir, snapshotPath, before, pid: child.pid, stdoutPath, stderrPath, jobPath };
  } catch (err) {
    if (stdoutFd !== undefined) closeSync(stdoutFd);
    if (stderrFd !== undefined) closeSync(stderrFd);
    throw err;
  }
}

async function updateReflectionState(name: string, patch: Record<string, unknown>) {
  const path = reflectionStatePath(name);
  let current: Record<string, unknown> = {};
  if (await exists(path)) {
    try {
      current = JSON.parse(await readFile(path, "utf8"));
    } catch {
      current = {};
    }
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ ...current, ...patch }, null, 2)}\n`);
}

async function readReflectionState(name: string) {
  const path = reflectionStatePath(name);
  if (!(await exists(path))) return {} as Record<string, any>;
  try {
    return JSON.parse(await readFile(path, "utf8")) as Record<string, any>;
  } catch {
    return {} as Record<string, any>;
  }
}

function reflectionStartedSummary(result: Awaited<ReturnType<typeof startReflection>>) {
  return [
    `Started ${result.target} memory reflection in the background.`,
    `Before: ~${result.before.tokens} tokens (${result.before.state})`,
    `Target band: ${result.before.band.lower}–${result.before.band.upper} tokens`,
    `Snapshot: ${result.snapshotPath}`,
    `Session/logs: ${result.reflectionSessionDir}`,
    result.pid ? `pid: ${result.pid}` : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}

function pidIsAlive(pid: number | undefined) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === "EPERM";
  }
}

async function fileSize(path: string) {
  try {
    const { stat } = await import("node:fs/promises");
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

async function trimmedFileText(path: string, maxChars = 3000) {
  try {
    const text = (await readFile(path, "utf8")).trim();
    if (text.length <= maxChars) return text;
    return `…${text.slice(-maxChars)}`;
  } catch {
    return "";
  }
}

function startReflectionWatcher(pi: ExtensionAPI, result: Awaited<ReturnType<typeof startReflection>>, ctx: { ui: { notify(message: string, level?: "info" | "warning" | "error" | "success"): void } }) {
  if (!result.pid) return;
  const key = `${result.target}:${result.reflectionId}`;
  const existing = reflectionWatchTimers.get(key);
  if (existing) clearInterval(existing);
  let checks = 0;
  const timer = setInterval(() => {
    checks += 1;
    if (pidIsAlive(result.pid) && checks < 720) return; // up to roughly one hour at 5s intervals
    clearInterval(timer);
    reflectionWatchTimers.delete(key);
    (async () => {
      const after = await memoryStatus(result.target);
      const stderrBytes = await fileSize(result.stderrPath);
      const sidecarSummary = await trimmedFileText(result.stdoutPath, 3000);
      await updateReflectionState(result.target, {
        lastReflectionCompletedAt: nowIso(),
        lastReflectionSessionDir: result.reflectionSessionDir,
        lastReflectionPid: result.pid,
        lastReflectionBeforeTokens: result.before.tokens,
        lastReflectionAfterTokens: after.tokens,
        lastReflectionStderrBytes: stderrBytes,
        lastReflectionSummary: sidecarSummary || undefined,
      });
      const timedOut = checks >= 720 && pidIsAlive(result.pid);
      const lines = [
        timedOut ? `Reflection watcher timed out for ${result.target}; process may still be running.` : `Reflection complete for ${result.target}.`,
        `Memory: ~${result.before.tokens} → ~${after.tokens} tokens (${after.state})`,
        `Target band: ${after.band.lower}–${after.band.upper} tokens`,
        `Session/logs: ${result.reflectionSessionDir}`,
        stderrBytes ? `stderr has ${stderrBytes} bytes; inspect logs if behavior looks wrong.` : undefined,
        sidecarSummary ? `\nSidecar summary:\n${sidecarSummary}` : undefined,
      ].filter(Boolean).join("\n");
      ctx.ui.notify(lines, timedOut || stderrBytes ? "warning" : "info");
      pi.sendMessage(
        {
          customType: "reflection-summary",
          content: lines,
          display: true,
          details: {
            target: result.target,
            reflectionId: result.reflectionId,
            sessionDir: result.reflectionSessionDir,
            beforeTokens: result.before.tokens,
            afterTokens: after.tokens,
            state: after.state,
            stderrBytes,
            timedOut,
          },
        },
        { deliverAs: "nextTurn" },
      );
    })().catch((err) => {
      ctx.ui.notify(`Reflection completion check failed for ${result.target}: ${err instanceof Error ? err.message : String(err)}`, "warning");
    });
  }, 5000);
  reflectionWatchTimers.set(key, timer);
}

async function finalizeRecoveredAsk(target: string, request: AgentMessage, answer: string, note = "recovered") {
  if (!request.artifactPath) return false;
  const artifactPath = join(agentDir(target), request.artifactPath);
  const askId = request.artifactPath.split("/").at(-2) ?? request.id;
  const sessionPath = join(dirname(artifactPath), "session");
  await mkdir(dirname(artifactPath), { recursive: true });
  await writeFile(
    artifactPath,
    `# Agent ask: ${request.from} → ${target}\n\n- request id: ${request.id}\n- clone id: ${askId}\n- status: done\n- ${note}: ${nowIso()}\n- session dir: ${sessionPath}\n\n## Question\n\n${request.body}\n\n## Answer\n\n${answer}\n`,
  );
  await updateAgentMessage(target, request.id, { status: "done" });
  const answerBody = preview(answer);
  const targetMessages = await readAgentMessages(target);
  if (!targetMessages.some((msg) => msg.type === "ask_answer" && msg.replyTo === request.id)) {
    await appendAgentMessage(target, {
      type: "ask_answer",
      from: `${target}:clone`,
      body: answerBody,
      replyTo: request.id,
      status: "done",
      artifactPath: request.artifactPath,
    });
  }
  if (request.from !== "pi" && (await exists(manifestPath(request.from)))) {
    const callerMessages = await readAgentMessages(request.from);
    for (const msg of callerMessages.filter((msg) => msg.replyTo === request.id && msg.status === "processing")) {
      await updateAgentMessage(request.from, msg.id, { status: "done" });
    }
    if (!callerMessages.some((msg) => msg.type === "ask_answer" && msg.replyTo === request.id)) {
      await appendAgentMessageFrom(request.from, {
        type: "ask_answer",
        to: request.from,
        from: `${target}:clone`,
        body: answerBody,
        replyTo: request.id,
        status: "done",
        artifactPath,
      } as any);
    }
  }
  return true;
}

async function recoverAgentAsks(target: string) {
  target = sanitizeName(target);
  const recovered: AgentMessage[] = [];
  for (const request of await readAgentMessages(target)) {
    if (request.type !== "ask_request" || request.status !== "processing" || !request.artifactPath) continue;
    const sessionPath = join(dirname(join(agentDir(target), request.artifactPath)), "session");
    const answer = await latestAssistantText(sessionPath).catch(() => "");
    if (!answer) continue;
    await finalizeRecoveredAsk(target, request, answer);
    recovered.push(request);
  }
  return recovered;
}

async function recoverAllAgentAsks() {
  const results: { agent: string; count: number }[] = [];
  for (const agent of await listAgents()) {
    const recovered = await recoverAgentAsks(agent).catch(() => []);
    if (recovered.length) results.push({ agent, count: recovered.length });
  }
  return results;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForAskAnswer(target: string, request: AgentMessage, timeoutMs: number) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const sessionPath = request.artifactPath ? join(dirname(join(agentDir(target), request.artifactPath)), "session") : undefined;
    const answer = sessionPath ? await latestAssistantText(sessionPath).catch(() => "") : "";
    if (answer) {
      await finalizeRecoveredAsk(target, request, answer, "completed");
      return answer;
    }
    await delay(1000);
  }
  return undefined;
}

function startRecoveryLoop(ctx: { ui: ExtensionCommandContext["ui"] }) {
  if (recoveryTimer || IS_EPHEMERAL_CLONE) return;
  recoveryTimer = setInterval(() => {
    recoverAllAgentAsks()
      .then((results) => {
        if (!results.length) return;
        ctx.ui.notify(`Recovered completed agent ask(s): ${results.map((r) => `${r.agent}:${r.count}`).join(", ")}`, "info");
      })
      .catch(() => undefined);
  }, 5_000);
}

async function runAgentAskClone(pi: ExtensionAPI, ctx: ExtensionCommandContext, targetRaw: string, body: string) {
  const target = sanitizeName(targetRaw);
  if (!(await exists(manifestPath(target)))) throw new Error(`Unknown agent: ${target}`);
  const from = await currentAgent(ctx);
  const manifest = await readManifest(target);
  const requestId = makeId("ask");
  const dir = consultationDir(target, requestId);
  const tmpSessionDir = join(dir, "session");
  const artifactPath = join(dir, "answer.md");
  await mkdir(tmpSessionDir, { recursive: true });

  const request = await appendAgentMessage(target, {
    type: "ask_request",
    from,
    body,
    status: "processing",
    artifactPath: artifactRelativePath(target, artifactPath),
  });
  let callerRequest: AgentMessage | undefined;
  if (from !== "pi") {
    callerRequest = await appendAgentMessageFrom(from, {
      type: "ask_request",
      to: target,
      body,
      status: "processing",
      replyTo: request.id,
      artifactPath: artifactRelativePath(target, artifactPath),
    });
  }

  const model = manifest.model ? ["--model", manifest.model] : [];
  const thinking = manifest.thinkingLevel ? ["--thinking", manifest.thinkingLevel] : [];
  const prompt = buildClonePrompt(target, from, request.id, body);
  const args = [
    "-p",
    "--session-dir",
    tmpSessionDir,
    "--no-context-files",
    "--tools",
    "read,grep,find,ls",
    ...model,
    ...thinking,
    prompt,
  ];

  const stdoutPath = join(dir, "stdout.log");
  const stderrPath = join(dir, "stderr.log");
  const metaPath = join(dir, "job.json");
  await writeJson(metaPath, {
    requestId: request.id,
    cloneId: requestId,
    target,
    from,
    body,
    args,
    cwd: agentDir(target),
    sessionDir: tmpSessionDir,
    artifactPath,
    stdoutPath,
    stderrPath,
    startedAt: nowIso(),
    callerRequestId: callerRequest?.id,
  });

  let stdoutFd: number | undefined;
  let stderrFd: number | undefined;
  try {
    stdoutFd = openSync(stdoutPath, "a");
    stderrFd = openSync(stderrPath, "a");
    const child = spawn("pi", args, {
      cwd: agentDir(target),
      env: { ...process.env, PI_AGENT_EPHEMERAL_CLONE: "1" },
      detached: true,
      stdio: ["ignore", stdoutFd, stderrFd],
    });
    child.unref();
    closeSync(stdoutFd);
    closeSync(stderrFd);
    stdoutFd = undefined;
    stderrFd = undefined;
    return { request, artifactPath, status: "processing" as const };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await updateAgentMessage(target, request.id, { status: "failed", error });
    if (callerRequest && from !== "pi") await updateAgentMessage(from, callerRequest.id, { status: "failed", error });
    if (stdoutFd !== undefined) closeSync(stdoutFd);
    if (stderrFd !== undefined) closeSync(stderrFd);
    await writeFile(stderrPath, `${error}\n`);
    ctx.ui.notify(`Failed to start ${target} clone ask: ${error}`, "warning");
    return { request, artifactPath, status: "failed" as const };
  }
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

async function readAgentMessages(name: string) {
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
    .filter((msg): msg is AgentMessage => Boolean(msg));
}

async function writeAgentMessages(name: string, messages: AgentMessage[]) {
  await writeFile(messagesPath(name), `${messages.map((msg) => JSON.stringify(msg)).join("\n")}\n`);
}

async function queuedMessages(name: string) {
  return (await readAgentMessages(name)).filter((msg) => {
    if (msg.status === "absorbed" || msg.status === "failed") return false;
    return msg.status === "queued" || msg.status === "processing" || msg.status === "done";
  });
}

async function updateAgentMessage(name: string, id: string, patch: Partial<AgentMessage>) {
  const messages = await readAgentMessages(name);
  let found = false;
  const updated = messages.map((msg) => {
    if (msg.id !== id) return msg;
    found = true;
    return { ...msg, ...patch, updatedAt: nowIso() };
  });
  if (!found) return false;
  await writeAgentMessages(name, updated);
  return true;
}

async function markMessageAbsorbed(name: string, id: string) {
  return updateAgentMessage(name, id, { status: "absorbed", absorbedAt: nowIso() });
}

function shouldNotifyInboxMessage(agent: string, msg: AgentMessage) {
  if (msg.from === agent) return false;
  if (msg.status === "absorbed" || msg.status === "failed") return false;
  return msg.status === "queued" || msg.status === "processing" || msg.status === "done";
}

async function notifyNewInboxMessages(name: string, ctx: ExtensionCommandContext) {
  const seen = notifiedInboxMessageIds.get(name) ?? new Set<string>();
  notifiedInboxMessageIds.set(name, seen);
  const messages = await readAgentMessages(name);
  const senders = new Set<string>();
  for (const msg of messages) {
    if (seen.has(msg.id)) continue;
    seen.add(msg.id);
    if (shouldNotifyInboxMessage(name, msg)) senders.add(msg.from);
  }
  for (const sender of [...senders].sort()) {
    ctx.ui.notify(`New agent message from ${sender}.`, "info");
  }
}

function startInboxNoticeLoop(name: string, ctx: ExtensionCommandContext) {
  if (inboxNoticeTimer) clearInterval(inboxNoticeTimer);
  inboxNoticeTimer = undefined;
  if (IS_EPHEMERAL_CLONE || IS_REFLECTION) return;
  const tick = () => {
    notifyNewInboxMessages(name, ctx).catch(() => undefined);
  };
  tick();
  inboxNoticeTimer = setInterval(tick, 5000);
}

async function agentInstructions(name: string) {
  const dir = agentDir(name);
  const chunks: string[] = [];
  const ag = join(dir, "AGENTS.md");
  if (await exists(ag)) chunks.push(`## Agent-local AGENTS.md\n\n${await readFile(ag, "utf8")}`);

  for (const file of await injectedMemoryFiles(name)) {
    chunks.push(`## Agent memory: ${file.relativePath}\n\n${file.text}`);
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

function isPathInside(path: string, root: string) {
  const resolvedPath = resolve(path);
  const resolvedRoot = resolve(root);
  return resolvedPath === resolvedRoot || resolvedPath.startsWith(`${resolvedRoot}/`);
}

function resolveToolPath(path: string, cwd: string) {
  return resolve(path.startsWith("/") ? path : join(cwd, path));
}

function reflectionGuard(event: any, ctx: { cwd: string }) {
  if (!IS_REFLECTION) return undefined;
  const target = REFLECTION_TARGET ? sanitizeName(REFLECTION_TARGET) : currentAgentFromCwd(ctx.cwd);
  if (!target) return { block: true, reason: "Reflection mode requires PI_AGENT_REFLECTION_TARGET or an agent cwd." };
  const root = agentDir(target);
  const writable = memoryDir(target);
  const block = (reason: string) => ({ block: true, reason });
  const allowed = new Set(["read", "grep", "find", "ls", "edit", "write"]);
  if (!allowed.has(event.toolName)) return block(`Reflection mode blocks tool: ${event.toolName}.`);
  if (event.toolName === "read" || event.toolName === "grep" || event.toolName === "find" || event.toolName === "ls") {
    const path = typeof event.input?.path === "string" ? event.input.path : ".";
    const resolved = resolveToolPath(path, ctx.cwd);
    if (!isPathInside(resolved, root)) return block(`Reflection may read only under ${root}.`);
    if (isPathInside(resolved, join(sessionDir(target), "reflections"))) return block("Reflection may not read reflection session logs.");
    if (isPathInside(resolved, join(memoryDir(target), ".snapshots"))) return block("Reflection may not read memory snapshots.");
  }
  if (event.toolName === "write" || event.toolName === "edit") {
    const path = event.input?.path;
    if (typeof path !== "string") return block("Reflection write/edit path is missing.");
    const resolved = resolveToolPath(path, ctx.cwd);
    if (!isPathInside(resolved, writable)) return block(`Reflection may write only under ${writable}.`);
    if (resolved.includes(`${resolve(join(writable, ".snapshots"))}/`)) return block("Reflection may not edit memory snapshots.");
  }
  return undefined;
}

export default function agentWorkspaces(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    startRecoveryLoop(ctx as any);
    const name = currentAgentFromCwd(ctx.cwd);
    if (name) {
      try {
        if (!IS_EPHEMERAL_CLONE && !IS_REFLECTION) await acquireLock(name, ctx);
        await applyManifest(pi, name, ctx as any);
        if (!IS_REFLECTION) {
          const status = await memoryStatus(name).catch(() => undefined);
          if (status && status.state !== "within") {
            ctx.ui.notify(`Agent ${name} memory is ${status.state} target band: ~${status.tokens} tokens, band ${status.band.lower}–${status.band.upper}. Use /agent-memory-status for details.`, status.state === "above" ? "warning" : "info");
          }
        }
        startInboxNoticeLoop(name, ctx as ExtensionCommandContext);
      } catch (err) {
        ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
        ctx.shutdown();
      }
    } else {
      ctx.ui.setStatus?.("agent-workspace", "agent:pi");
    }
  });

  pi.on("session_shutdown", async () => {
    if (IS_REFLECTION && REFLECTION_TARGET) {
      const target = sanitizeName(REFLECTION_TARGET);
      const after = await memoryStatus(target).catch(() => undefined);
      await updateReflectionState(target, {
        lastReflectionCompletedAt: nowIso(),
        lastReflectionId: process.env.PI_AGENT_REFLECTION_ID,
        lastReflectionAfterTokens: after?.tokens,
        lastReflectionAfterState: after?.state,
      }).catch(() => undefined);
    }
    if (recoveryTimer) clearInterval(recoveryTimer);
    recoveryTimer = undefined;
    if (inboxNoticeTimer) clearInterval(inboxNoticeTimer);
    inboxNoticeTimer = undefined;
    for (const timer of reflectionWatchTimers.values()) clearInterval(timer);
    reflectionWatchTimers.clear();
    await releaseLock();
  });

  pi.on("tool_call", async (event, ctx) => reflectionGuard(event, ctx));

  pi.on("session_compact", async (_event, ctx) => {
    if (IS_EPHEMERAL_CLONE || IS_REFLECTION) return;
    const name = currentAgentFromCwd(ctx.cwd);
    if (!name) return;
    const manifest = await readManifest(name).catch(() => undefined);
    if (!manifest || !memoryReflectionEnabled(manifest)) return;
    const every = memoryReflectionAfterCompactions(manifest);
    const state = await readReflectionState(name);
    const since = Number(state.compactionsSinceReflection ?? 0) + 1;
    await updateReflectionState(name, { compactionsSinceReflection: since, lastCompactionAt: nowIso() });
    if (since < every) return;
    await updateReflectionState(name, { compactionsSinceReflection: 0, lastReflectionQueuedAt: nowIso() });
    startReflection(name, ctx.sessionManager.getSessionFile())
      .then(async (result) => {
        await updateReflectionState(name, { lastReflectionStartedAt: nowIso(), lastReflectionSessionDir: result.reflectionSessionDir, lastReflectionPid: result.pid });
        ctx.ui.notify(reflectionStartedSummary(result), "info");
        startReflectionWatcher(pi, result, ctx);
      })
      .catch(async (err) => {
        await updateReflectionState(name, { lastReflectionError: err instanceof Error ? err.message : String(err), lastReflectionAt: nowIso() });
        ctx.ui.notify(`Memory reflection failed for ${name}: ${err instanceof Error ? err.message : String(err)}`, "warning");
      });
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

  pi.registerCommand("agent-memory-status", {
    description: "Show injected memory files and token budget status for the current agent",
    handler: async (args, ctx) => {
      if (args.trim()) return usage(ctx, "Usage: /agent-memory-status (current named agent only)");
      const name = currentAgentFromCwd(ctx.cwd);
      if (!name) return usage(ctx, "Usage: /agent-memory-status (inside a named agent)");
      ctx.ui.notify(formatMemoryStatus(await memoryStatus(name), await readReflectionState(name)), "info");
    },
  });

  async function reflectCommand(args: string, ctx: ExtensionCommandContext) {
    if (args.trim()) return usage(ctx, "Usage: /reflect (current named agent only)");
    const name = currentAgentFromCwd(ctx.cwd);
    if (!name) return usage(ctx, "Usage: /reflect (inside a named agent)");
    const result = await startReflection(name, ctx.sessionManager.getSessionFile());
    await updateReflectionState(name, { compactionsSinceReflection: 0, lastReflectionQueuedAt: nowIso(), lastReflectionStartedAt: nowIso(), lastReflectionSessionDir: result.reflectionSessionDir, lastReflectionPid: result.pid });
    ctx.ui.notify(reflectionStartedSummary(result), "info");
    startReflectionWatcher(pi, result, ctx);
  }

  pi.registerCommand("reflect", {
    description: "Reflect current agent memory in an orphan session",
    handler: reflectCommand,
  });

  pi.registerCommand("agent-memory-reflect", {
    description: "Explicit alias for /reflect",
    handler: reflectCommand,
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
        await mkdir(join(agentDir(newName), "notebook"), { recursive: true });
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
      ctx.ui.notify(`Cloned current session to agent ${newName}. Open or switch to it explicitly when ready.`, "info");
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
      await switchToPi(ctx, `Moved agent ${name} to ${dest}`);
    },
  });

  async function launchAgentAsk(args: string, ctx: ExtensionCommandContext, commandName: string) {
    const parsed = parseTargetAndBody(args);
    if (!parsed) return usage(ctx, `Usage: /${commandName} <agent> <question>`);
    const [to, body] = parsed;
    const target = sanitizeName(to);
    ctx.ui.setStatus?.("agent-ask", `asking ${target}…`);
    pi.sendMessage({
      customType: "agent-ask-status",
      content: `Asking ${target} via read-only clone…`,
      display: true,
      details: { target, status: "started" },
    });
    try {
      const started = await runAgentAskClone(pi, ctx, target, body);
      const answer = await waitForAskAnswer(target, started.request, 180_000);
      ctx.ui.setStatus?.("agent-ask", undefined);
      if (!answer) {
        ctx.ui.notify(`${target} has not answered yet. Artifact: ${started.artifactPath}\nTry /agent-ask-recover ${target} shortly.`, "warning");
        return;
      }
      const content = `## Agent answer: ${target}\n\n${answer}`;
      pi.sendMessage({
        customType: "agent-ask-answer",
        content,
        display: true,
        details: { target, artifactPath: started.artifactPath },
      });
      ctx.ui.notify(`${target} answered.`, "info");
    } catch (error) {
      ctx.ui.setStatus?.("agent-ask", undefined);
      ctx.ui.notify(`agent ask failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
    }
  }

  pi.registerCommand("agent-ask", {
    description: "Ask another agent via an ephemeral read-only clone",
    getArgumentCompletions: async (prefix) => (await listAgentTargets()).filter((a) => a !== "pi" && a.startsWith(prefix)).map((a) => ({ value: a, label: a })),
    handler: async (args, ctx) => launchAgentAsk(args, ctx, "agent-ask"),
  });

  pi.registerCommand("agent-consult", {
    description: "Alias for /agent-ask",
    getArgumentCompletions: async (prefix) => (await listAgentTargets()).filter((a) => a !== "pi" && a.startsWith(prefix)).map((a) => ({ value: a, label: a })),
    handler: async (args, ctx) => launchAgentAsk(args, ctx, "agent-consult"),
  });

  pi.registerCommand("agent-ask-recover", {
    description: "Recover completed clone ask answers from retained consultation sessions",
    getArgumentCompletions: async (prefix) => (await listAgentTargets()).filter((a) => a !== "pi" && a.startsWith(prefix)).map((a) => ({ value: a, label: a })),
    handler: async (args, ctx) => {
      const name = args.trim() ? sanitizeName(args.trim().split(/\s+/)[0]) : currentAgentFromCwd(ctx.cwd);
      if (!name) return usage(ctx, "Usage: /agent-ask-recover <agent>");
      const recovered = await recoverAgentAsks(name);
      ctx.ui.notify(recovered.length ? `Recovered ${recovered.length} ask(s) for ${name}.` : `No recoverable asks for ${name}.`, recovered.length ? "info" : "warning");
    },
  });

  pi.registerCommand("agent-inbox", {
    description: "List queued/unabsorbed messages for the current or named agent",
    getArgumentCompletions: async (prefix) => (await listAgentTargets()).filter((a) => a !== "pi" && a.startsWith(prefix)).map((a) => ({ value: a, label: a })),
    handler: async (args, ctx) => {
      const name = args.trim() ? sanitizeName(args.trim().split(/\s+/)[0]) : currentAgentFromCwd(ctx.cwd);
      if (!name) return usage(ctx, "Usage: /agent-inbox [agent]");
      const messages = await queuedMessages(name);
      if (!messages.length) return ctx.ui.notify(`No queued/unabsorbed messages for ${name}.`, "info");
      ctx.ui.notify(messages.map((msg) => `${msg.id}  ${msg.type}  ${msg.status}  from:${msg.from}\n${msg.body}${msg.artifactPath ? `\nartifact: ${join(agentDir(name), msg.artifactPath)}` : ""}`).join("\n\n"), "info");
    },
  });

  pi.registerCommand("agent-absorb", {
    description: "Mark an inbox/consultation message absorbed for the current agent",
    handler: async (args, ctx) => {
      const name = currentAgentFromCwd(ctx.cwd);
      if (!name) return usage(ctx, "Usage: /agent-absorb <message-id> (inside a named agent)");
      const id = args.trim();
      if (!id) return usage(ctx, "Usage: /agent-absorb <message-id>");
      const ok = await markMessageAbsorbed(name, id);
      if (!ok) return ctx.ui.notify(`No message ${id} in ${name}'s inbox.`, "warning");
      await appendAgentMessage(name, { type: "event", from: name, body: `absorbed ${id}`, replyTo: id, status: "absorbed", absorbedAt: nowIso() } as any);
      notifiedInboxMessageIds.get(name)?.add(id);
      ctx.ui.notify(`Marked ${id} absorbed for ${name}.`, "info");
    },
  });

  pi.registerTool({
    name: "agent_ask",
    label: "Agent Ask",
    description: "Ask another persistent Pi agent via an ephemeral read-only clone and return its answer.",
    promptSnippet: "Use agent_ask when you need an immediate answer from another named agent via a read-only clone.",
    promptGuidelines: [
      "Use agent_ask for synchronous consultation with another named agent when the user asks you to ask/consult/get input from that agent.",
      "Use agent_send_message for durable notes that do not need an immediate answer.",
      "Consultation runs in an ephemeral clone and does not mutate the target agent's main session.",
      "Use agent_list first if you need to discover available agent names.",
    ],
    parameters: Type.Object({
      to: Type.String({ description: "Target persistent agent name." }),
      question: Type.String({ description: "Question or task for the target agent clone." }),
      timeoutMs: Type.Optional(Type.Number({ description: "Maximum time to wait for an answer in milliseconds. Default 180000." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const to = sanitizeName(params.to);
      const question = params.question.trim();
      if (!question) throw new Error("Question is required.");
      const timeoutMs = Math.max(1000, Math.min(params.timeoutMs ?? 180_000, 600_000));
      const started = await runAgentAskClone(pi, ctx as any, to, question);
      if (started.status === "failed") {
        return {
          content: [{ type: "text", text: `Failed to start ${to} consultation clone. Artifact: ${started.artifactPath}` }],
          details: started,
        };
      }
      const answer = await waitForAskAnswer(to, started.request, timeoutMs);
      if (!answer) {
        return {
          content: [{ type: "text", text: `${to} has not answered yet. Artifact: ${started.artifactPath}` }],
          details: { ...started, timedOut: true },
        };
      }
      return {
        content: [{ type: "text", text: answer }],
        details: { ...started, answer },
      };
    },
  });

  pi.registerTool({
    name: "agent_send_message",
    label: "Agent Send Message",
    description: "Send a short durable inbox message to another persistent Pi agent.",
    promptSnippet: "Use agent_send_message to pass concise context, handoff notes, or side-channel updates to another named Pi agent.",
    promptGuidelines: [
      "Use agent_send_message when the user asks you to notify, pass context to, or hand off information to another named agent.",
      "Keep messages concise and durable; do not include secrets unless the user explicitly asks.",
      "Use agent_list first if you need to discover available agent names.",
    ],
    parameters: Type.Object({
      to: Type.String({ description: "Target persistent agent name." }),
      body: Type.String({ description: "Message body to place in the target agent's inbox." }),
      type: Type.Optional(Type.String({ description: "Message type, usually 'tell' or 'task'. Defaults to 'tell'." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const to = sanitizeTargetName(params.to);
      if (to === "pi") throw new Error("Ephemeral pi has no durable inbox; send messages to a named persistent agent.");
      const body = params.body.trim();
      if (!body) throw new Error("Message body is required.");
      const requestedType = (params.type ?? "tell").trim();
      if (requestedType !== "tell" && requestedType !== "task") {
        throw new Error(`Unsupported message type: ${requestedType}. Use agent_ask for immediate consultations.`);
      }
      const type: MessageType = requestedType;
      const from = currentAgentFromCwd(ctx?.cwd ?? "") ?? activeAgent ?? "pi";
      const msg = await appendAgentMessage(to, { type, from, body, status: "queued" });
      return {
        content: [{ type: "text", text: `Sent ${type} message ${msg.id} to ${to}.` }],
        details: { id: msg.id, to, from, type },
      };
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

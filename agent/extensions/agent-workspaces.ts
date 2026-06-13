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
  if (IS_EPHEMERAL_CLONE) return;
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
  pi.registerFlag("agent", {
    description: "Start in a persistent named agent workspace",
    type: "string",
  });

  pi.on("session_start", async (_event, ctx) => {
    startRecoveryLoop(ctx as any);
    const requestedAgent = pi.getFlag("agent");
    if (typeof requestedAgent === "string" && requestedAgent.trim()) {
      ctx.ui.notify("--agent must be handled by ~/.pi/agent/bin/pi before Pi starts; check that wrapper is first on PATH.", "warning");
    }
    const name = currentAgentFromCwd(ctx.cwd);
    if (name) {
      try {
        if (!IS_EPHEMERAL_CLONE) await acquireLock(name, ctx);
        await applyManifest(pi, name, ctx as any);
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
    if (recoveryTimer) clearInterval(recoveryTimer);
    recoveryTimer = undefined;
    if (inboxNoticeTimer) clearInterval(inboxNoticeTimer);
    inboxNoticeTimer = undefined;
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
      const type: MessageType = requestedType === "task" ? "task" : "tell";
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

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const STORE_PATH = `${process.env.HOME ?? "."}/.pi/agent/scheduled-prompts.json`;
const STATUS_KEY = "scheduled-prompts";

type ScheduledPrompt = {
  id: string;
  dueAt: number;
  prompt: string;
  sessionFile?: string;
  sessionId?: string;
  createdAt: number;
};

type Store = {
  jobs: ScheduledPrompt[];
};

const timers = new Map<string, NodeJS.Timeout>();
let activeContext: ExtensionContext | undefined;
let activePi: ExtensionAPI | undefined;

async function readStore(): Promise<Store> {
  if (!existsSync(STORE_PATH)) return { jobs: [] };
  try {
    const parsed = JSON.parse(await readFile(STORE_PATH, "utf8")) as Partial<Store>;
    return { jobs: Array.isArray(parsed.jobs) ? parsed.jobs : [] };
  } catch {
    return { jobs: [] };
  }
}

async function writeStore(store: Store): Promise<void> {
  await mkdir(dirname(STORE_PATH), { recursive: true });
  await writeFile(STORE_PATH, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

function safeNotify(ctx: ExtensionContext | undefined, message: string, level: "info" | "warning" = "info"): void {
  try {
    if (ctx?.hasUI) ctx.ui.notify(message, level);
  } catch {
    // Contexts can become stale after reload/session replacement.
  }
}

function safeStatus(ctx: ExtensionContext | undefined, value: string | undefined): void {
  try {
    if (ctx?.hasUI) ctx.ui.setStatus(STATUS_KEY, value);
  } catch {
    // See safeNotify.
  }
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 90) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  return rem ? `${hours}h${rem}m` : `${hours}h`;
}

function updateStatus(ctx = activeContext): void {
  readStore()
    .then((store) => {
      const now = Date.now();
      const pending = store.jobs.filter((job) => job.dueAt > now).sort((a, b) => a.dueAt - b.dueAt);
      if (!pending.length) return safeStatus(ctx, undefined);
      const next = pending[0];
      safeStatus(ctx, `${pending.length} prompt${pending.length === 1 ? "" : "s"}; next ${formatDuration(next.dueAt - now)}`);
    })
    .catch(() => safeStatus(ctx, undefined));
}

function parsePromptTime(spec: string): number | undefined {
  const raw = spec.trim();
  const now = new Date();

  const timeOnly = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(raw);
  if (timeOnly) {
    const hour = Number(timeOnly[1]);
    const minute = Number(timeOnly[2]);
    const second = timeOnly[3] === undefined ? 0 : Number(timeOnly[3]);
    if (hour > 23 || minute > 59 || second > 59) return undefined;
    const due = new Date(now);
    due.setHours(hour, minute, second, 0);
    if (due.getTime() <= now.getTime()) due.setDate(due.getDate() + 1);
    return due.getTime();
  }

  const isoLocal = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::(\d{2}))?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/.exec(raw);
  if (!isoLocal) return undefined;
  const absolute = Date.parse(raw);
  return Number.isNaN(absolute) ? undefined : absolute;
}

function splitFirstArg(args: string): [string, string] | undefined {
  const trimmed = args.trim();
  if (!trimmed) return undefined;
  const match = /^("[^"]+"|'[^']+'|\S+)\s+([\s\S]+)$/.exec(trimmed);
  if (!match) return undefined;
  const spec = match[1].replace(/^(["'])(.*)\1$/, "$2");
  return [spec, match[2].trim()];
}

function makeId(): string {
  return Math.random().toString(36).slice(2, 8);
}

async function removeJob(id: string): Promise<ScheduledPrompt | undefined> {
  const store = await readStore();
  const job = store.jobs.find((candidate) => candidate.id === id);
  if (!job) return undefined;
  store.jobs = store.jobs.filter((candidate) => candidate.id !== id);
  await writeStore(store);
  const timer = timers.get(id);
  if (timer) clearTimeout(timer);
  timers.delete(id);
  updateStatus();
  return job;
}

function armJob(pi: ExtensionAPI, job: ScheduledPrompt): void {
  const existing = timers.get(job.id);
  if (existing) clearTimeout(existing);

  const delay = Math.max(0, job.dueAt - Date.now());
  const timer = setTimeout(async () => {
    timers.delete(job.id);
    const removed = await removeJob(job.id);
    if (!removed) return;
    const ctx = activeContext;
    const currentSessionFile = ctx?.sessionManager.getSessionFile();
    if (removed.sessionFile && currentSessionFile && removed.sessionFile !== currentSessionFile) {
      safeNotify(ctx, `Scheduled prompt ${removed.id} is due but this session changed; not sending.`, "warning");
      return;
    }
    try {
      pi.sendUserMessage(removed.prompt, { deliverAs: "followUp" });
      safeNotify(ctx, `Sent scheduled prompt ${removed.id}.`, "info");
    } catch (error) {
      safeNotify(ctx, `Scheduled prompt ${removed.id} failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
    }
  }, delay);
  timers.set(job.id, timer);
}

async function armAll(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  activePi = pi;
  activeContext = ctx;
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();

  const store = await readStore();
  const now = Date.now();
  const sessionFile = ctx.sessionManager.getSessionFile();
  const jobs = store.jobs.filter((job) => job.dueAt > now || !job.sessionFile || job.sessionFile === sessionFile);
  if (jobs.length !== store.jobs.length) await writeStore({ jobs });
  for (const job of jobs) armJob(pi, job);
  updateStatus(ctx);
}

async function schedulePrompt(pi: ExtensionAPI, ctx: ExtensionContext, dueAt: number, prompt: string): Promise<void> {
  if (!prompt.trim()) {
    safeNotify(ctx, "Scheduled prompt cannot be empty.", "warning");
    return;
  }
  const job: ScheduledPrompt = {
    id: makeId(),
    dueAt,
    prompt: prompt.trim(),
    sessionFile: ctx.sessionManager.getSessionFile() ?? undefined,
    sessionId: ctx.sessionManager.getSessionId(),
    createdAt: Date.now(),
  };
  const store = await readStore();
  store.jobs.push(job);
  store.jobs.sort((a, b) => a.dueAt - b.dueAt);
  await writeStore(store);
  armJob(pi, job);
  updateStatus(ctx);
  safeNotify(ctx, `Scheduled prompt ${job.id} for ${formatTime(job.dueAt)} (${formatDuration(job.dueAt - Date.now())}).`, "info");
}

export default function scheduledPrompts(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    await armAll(pi, ctx);
  });

  pi.on("session_shutdown", async () => {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    activeContext = undefined;
    activePi = undefined;
  });

  pi.registerCommand("prompt-later", {
    description: "Schedule a prompt in this session at a time, e.g. /prompt-later 13:05 Continue.",
    handler: async (args, ctx) => {
      activeContext = ctx;
      activePi = pi;
      const parsed = splitFirstArg(args);
      if (!parsed) {
        safeNotify(ctx, "Usage: /prompt-later <HH:MM|HH:MM:SS|YYYY-MM-DDTHH:MM[:SS]> <prompt>", "warning");
        return;
      }
      const [timeSpec, prompt] = parsed;
      const dueAt = parsePromptTime(timeSpec);
      if (!dueAt) {
        safeNotify(ctx, "Time must look like 13:05, 13:05:33, or 2026-06-11T13:05:33.", "warning");
        return;
      }
      await schedulePrompt(pi, ctx, dueAt, prompt);
    },
  });

  pi.registerCommand("scheduled-prompts", {
    description: "List scheduled prompts for this Pi session.",
    handler: async (_args, ctx) => {
      activeContext = ctx;
      const store = await readStore();
      const sessionFile = ctx.sessionManager.getSessionFile();
      const jobs = store.jobs.filter((job) => !job.sessionFile || job.sessionFile === sessionFile).sort((a, b) => a.dueAt - b.dueAt);
      if (!jobs.length) {
        safeNotify(ctx, "No scheduled prompts for this session.", "info");
        updateStatus(ctx);
        return;
      }
      safeNotify(
        ctx,
        jobs.map((job) => `${job.id}  ${formatTime(job.dueAt)} (${formatDuration(job.dueAt - Date.now())})  ${job.prompt}`).join("\n"),
        "info",
      );
      updateStatus(ctx);
    },
  });

  pi.registerCommand("cancel-scheduled-prompt", {
    description: "Cancel a scheduled prompt by id.",
    handler: async (args, ctx) => {
      activeContext = ctx;
      const id = args.trim();
      if (!id) {
        safeNotify(ctx, "Usage: /cancel-scheduled-prompt <id>", "warning");
        return;
      }
      const job = await removeJob(id);
      safeNotify(ctx, job ? `Canceled scheduled prompt ${id}.` : `No scheduled prompt with id ${id}.`, job ? "info" : "warning");
    },
  });
}

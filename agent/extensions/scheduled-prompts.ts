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

function parseDelay(value: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours)$/i.exec(value.trim());
  if (!match) return undefined;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return undefined;
  const unit = match[2].toLowerCase();
  if (unit.startsWith("s")) return amount * 1000;
  if (unit.startsWith("m")) return amount * 60_000;
  if (unit.startsWith("h")) return amount * 60 * 60_000;
  return undefined;
}

function parseLocalTime(spec: string): number | undefined {
  const raw = spec.trim();
  const now = new Date();

  const timeMatch = /^(\d{1,2})(?::(\d{2}))?\s*([ap]m)?$/i.exec(raw);
  if (timeMatch) {
    let hour = Number(timeMatch[1]);
    const minute = timeMatch[2] === undefined ? 0 : Number(timeMatch[2]);
    const ampm = timeMatch[3]?.toLowerCase();
    if (minute < 0 || minute > 59) return undefined;
    if (ampm) {
      if (hour < 1 || hour > 12) return undefined;
      if (ampm === "pm" && hour !== 12) hour += 12;
      if (ampm === "am" && hour === 12) hour = 0;
    } else if (hour > 23) {
      return undefined;
    }
    const due = new Date(now);
    due.setHours(hour, minute, 0, 0);
    if (due.getTime() <= now.getTime()) due.setDate(due.getDate() + 1);
    return due.getTime();
  }

  const dateTime = /^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}:\d{2})(?:\s*([ap]m))?$/i.exec(raw);
  if (dateTime) {
    const parsed = parseLocalTime(`${dateTime[2]}${dateTime[3] ? ` ${dateTime[3]}` : ""}`);
    if (!parsed) return undefined;
    const date = new Date(`${dateTime[1]}T00:00:00`);
    if (Number.isNaN(date.getTime())) return undefined;
    const time = new Date(parsed);
    date.setHours(time.getHours(), time.getMinutes(), 0, 0);
    return date.getTime();
  }

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

function splitPromptAtArgs(args: string): [string, string] | undefined {
  const first = splitFirstArg(args);
  if (!first) return undefined;
  const [maybeDate, rest] = first;
  if (/^\d{4}-\d{2}-\d{2}$/.test(maybeDate)) {
    const second = splitFirstArg(rest);
    if (second) return [`${maybeDate} ${second[0]}`, second[1]];
  }
  return first;
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
    description: "Schedule a prompt in this session after a delay, e.g. /prompt-later 10m Continue.",
    handler: async (args, ctx) => {
      activeContext = ctx;
      activePi = pi;
      const parsed = splitFirstArg(args);
      if (!parsed) {
        safeNotify(ctx, "Usage: /prompt-later <10m|30s|2h> <prompt>", "warning");
        return;
      }
      const [delaySpec, prompt] = parsed;
      const delay = parseDelay(delaySpec);
      if (!delay) {
        safeNotify(ctx, "Delay must look like 30s, 10m, or 2h.", "warning");
        return;
      }
      await schedulePrompt(pi, ctx, Date.now() + delay, prompt);
    },
  });

  pi.registerCommand("prompt-at", {
    description: "Schedule a prompt at a local time, e.g. /prompt-at 23:15 Continue.",
    handler: async (args, ctx) => {
      activeContext = ctx;
      activePi = pi;
      const parsed = splitPromptAtArgs(args);
      if (!parsed) {
        safeNotify(ctx, "Usage: /prompt-at <HH:MM|9:30pm|YYYY-MM-DD HH:MM> <prompt>", "warning");
        return;
      }
      const [timeSpec, prompt] = parsed;
      const dueAt = parseLocalTime(timeSpec);
      if (!dueAt) {
        safeNotify(ctx, "Time must look like 23:15, 9:30pm, or 2026-06-07 23:15.", "warning");
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

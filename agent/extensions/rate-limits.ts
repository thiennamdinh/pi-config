import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";

const STORE_PATH = `${process.env.HOME ?? "."}/.pi/agent/rate-limits.json`;

type RateWindow = {
  usedPercent?: number;
  windowMinutes?: number;
  resetAt?: number;
};

type RateLimitSnapshot = {
  limitId: string;
  limitName?: string;
  primary?: RateWindow;
  secondary?: RateWindow;
  updatedAt: number;
};

type Store = {
  openai?: {
    codex?: RateLimitSnapshot[];
    standard?: Record<string, string>;
  };
};

function headerMap(headers: unknown) {
  const map = new Map<string, string>();
  if (!headers) return map;

  if (headers instanceof Headers) {
    headers.forEach((value, key) => map.set(key.toLowerCase(), value));
    return map;
  }

  if (typeof (headers as any).entries === "function") {
    for (const [key, value] of (headers as any).entries()) map.set(String(key).toLowerCase(), String(value));
    return map;
  }

  if (typeof headers === "object") {
    for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
      if (value !== undefined && value !== null) map.set(key.toLowerCase(), String(value));
    }
  }
  return map;
}

function getHeader(headers: Map<string, string>, name: string) {
  return headers.get(name.toLowerCase());
}

function parseNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function parseWindow(headers: Map<string, string>, prefix: string, kind: "primary" | "secondary"): RateWindow | undefined {
  const usedPercent = parseNumber(getHeader(headers, `${prefix}-${kind}-used-percent`));
  const windowMinutes = parseNumber(getHeader(headers, `${prefix}-${kind}-window-minutes`));
  const resetAt = parseNumber(getHeader(headers, `${prefix}-${kind}-reset-at`));
  if (usedPercent === undefined && windowMinutes === undefined && resetAt === undefined) return undefined;
  return { usedPercent, windowMinutes, resetAt };
}

function normalizeLimitId(raw: string) {
  return raw.replace(/^x-/, "").replace(/-(primary|secondary)-(used-percent|window-minutes|reset-at)$/, "").replace(/-limit-name$/, "").replace(/-/g, "_");
}

function parseCodexHeaders(rawHeaders: unknown): RateLimitSnapshot[] {
  const headers = headerMap(rawHeaders);
  const limitIds = new Set<string>(["codex"]);

  for (const key of headers.keys()) {
    const match = /^x-(.+?)-(primary|secondary)-(used-percent|window-minutes|reset-at)$/.exec(key) ?? /^x-(.+?)-limit-name$/.exec(key);
    if (match) limitIds.add(normalizeLimitId(`x-${match[1]}`));
  }

  const now = Date.now();
  const snapshots: RateLimitSnapshot[] = [];
  for (const limitId of limitIds) {
    const headerId = limitId.replace(/_/g, "-");
    const prefix = `x-${headerId}`;
    const primary = parseWindow(headers, prefix, "primary");
    const secondary = parseWindow(headers, prefix, "secondary");
    const limitName = getHeader(headers, `${prefix}-limit-name`)?.trim() || undefined;
    if (!primary && !secondary && !limitName) continue;
    snapshots.push({ limitId, limitName, primary, secondary, updatedAt: now });
  }
  return snapshots;
}

function parseStandardOpenAiHeaders(rawHeaders: unknown) {
  const headers = headerMap(rawHeaders);
  const keys = [
    "x-ratelimit-limit-requests",
    "x-ratelimit-remaining-requests",
    "x-ratelimit-reset-requests",
    "x-ratelimit-limit-tokens",
    "x-ratelimit-remaining-tokens",
    "x-ratelimit-reset-tokens",
  ];
  const result: Record<string, string> = {};
  for (const key of keys) {
    const value = getHeader(headers, key);
    if (value) result[key] = value;
  }
  return Object.keys(result).length ? result : undefined;
}

async function readStore(): Promise<Store> {
  if (!existsSync(STORE_PATH)) return {};
  try {
    return JSON.parse(await readFile(STORE_PATH, "utf8")) as Store;
  } catch {
    return {};
  }
}

async function writeStore(store: Store) {
  await mkdir(dirname(STORE_PATH), { recursive: true });
  await writeFile(STORE_PATH, JSON.stringify(store, null, 2), "utf8");
}

function formatWindow(label: string, win: RateWindow | undefined): string | undefined {
  if (!win) return undefined;
  const used = win.usedPercent === undefined ? "?" : `${Math.round(win.usedPercent)}%`;
  const window = win.windowMinutes ? `/${formatMinutes(win.windowMinutes)}` : "";
  const reset = win.resetAt ? ` resets ${formatReset(win.resetAt)}` : "";
  return `${label}: ${used}${window}${reset}`;
}

function formatMinutes(minutes: number) {
  if (minutes >= 60 * 24 * 6) return `${Math.round(minutes / 60 / 24)}d`;
  if (minutes >= 60) return `${Math.round(minutes / 60)}h`;
  return `${minutes}m`;
}

function formatReset(resetAtSeconds: number) {
  const ms = resetAtSeconds * 1000;
  const date = new Date(ms);
  const deltaMs = ms - Date.now();
  const time = date.toLocaleString(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
  if (!Number.isFinite(deltaMs)) return date.toLocaleString();
  if (deltaMs <= 0) return `${time} (past, ${formatAge(ms)})`;
  return time;
}

function formatAge(timestampMs: number) {
  const deltaMs = Math.max(0, Date.now() - timestampMs);
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function formatSnapshot(snapshot: RateLimitSnapshot) {
  const title = snapshot.limitName ? `${snapshot.limitName} (${snapshot.limitId})` : snapshot.limitId;
  const stale = Date.now() - snapshot.updatedAt > 60 * 60_000 ? " stale" : "";
  const lines = [`OpenAI/Codex ${title}${stale}`];
  const primary = formatWindow("primary", snapshot.primary);
  const secondary = formatWindow("secondary", snapshot.secondary);
  if (primary) lines.push(`  ${primary}`);
  if (secondary) lines.push(`  ${secondary}`);
  lines.push(`  updated: ${new Date(snapshot.updatedAt).toLocaleString()} (${formatAge(snapshot.updatedAt)})`);
  return lines.join("\n");
}

function formatStore(store: Store) {
  const parts: string[] = [];
  const codex = store.openai?.codex ?? [];
  if (codex.length) parts.push(codex.map(formatSnapshot).join("\n\n"));
  const standard = store.openai?.standard;
  if (standard) {
    parts.push(`OpenAI API headers\n${Object.entries(standard).map(([k, v]) => `  ${k}: ${v}`).join("\n")}`);
  }
  return parts.length ? parts.join("\n\n") : "No OpenAI rate limit data captured yet. It will appear after an OpenAI/Codex model response that includes rate-limit headers.";
}

function footerText(store: Store) {
  const codex = store.openai?.codex?.find((s) => s.limitId === "codex") ?? store.openai?.codex?.[0];
  if (!codex) return undefined;
  const p = codex.primary?.usedPercent;
  const s = codex.secondary?.usedPercent;
  const primary = p === undefined ? "?" : `${Math.round(p)}%`;
  const secondary = s === undefined ? "?" : `${Math.round(s)}%`;
  const age = formatAge(codex.updatedAt);
  const stale = Date.now() - codex.updatedAt > 60 * 60_000 ? " stale" : "";
  return `OpenAI ${primary}/${codex.primary?.windowMinutes ? formatMinutes(codex.primary.windowMinutes) : "?"} ${secondary}/${codex.secondary?.windowMinutes ? formatMinutes(codex.secondary.windowMinutes) : "?"} ${age}${stale}`;
}

async function updateFooter(ctx: any, store?: Store) {
  const current = store ?? await readStore();
  ctx.ui.setStatus("openai-rate-limits", footerText(current));
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    await updateFooter(ctx);
  });

  pi.on("after_provider_response", async (event, ctx) => {
    const codex = parseCodexHeaders(event.headers);
    const standard = parseStandardOpenAiHeaders(event.headers);
    if (codex.length === 0 && !standard) return;

    const store = await readStore();
    store.openai ??= {};
    if (codex.length) store.openai.codex = codex;
    if (standard) store.openai.standard = standard;
    await writeStore(store);
    await updateFooter(ctx, store);
  });

  pi.registerCommand("rate-limits", {
    description: "Show captured OpenAI/Codex rate limits",
    handler: async (_args, ctx) => {
      const store = await readStore();
      ctx.ui.notify(formatStore(store), "info");
      await updateFooter(ctx, store);
    },
  });

  pi.registerTool({
    name: "openai_rate_limits",
    label: "OpenAI Rate Limits",
    description: "Show the latest captured OpenAI/Codex rate-limit snapshot from provider response headers.",
    promptSnippet: "Show captured OpenAI/Codex rate limits.",
    parameters: Type.Object({}),
    async execute() {
      const store = await readStore();
      return { content: [{ type: "text", text: formatStore(store) }], details: store };
    },
  });
}

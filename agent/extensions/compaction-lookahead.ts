import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  buildSessionContext,
  compact,
  DEFAULT_COMPACTION_SETTINGS,
  estimateTokens,
  generateSummary,
  prepareCompaction,
  type AgentMessage,
  type CompactionEntry,
  type CompactionSettings,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";

type CacheMode = "bootstrap" | "post-compaction";

interface LookaheadCache {
  version: 1;
  mode: CacheMode;
  sessionFile: string;
  sessionId: string;
  createdAt: string;
  summary: string;
  coveredEntryId?: string;
  sourceCompactionId?: string;
  firstKeptEntryId?: string;
  tokensBeforeEstimate: number;
  settings: CompactionSettings;
  model?: string;
}

const CUSTOM_DETAILS = { source: "compaction-lookahead", version: 1 };
const BOOTSTRAP_MARGIN_TOKENS = 12000;
const MIN_BOOTSTRAP_TOKENS_TO_SUMMARIZE = 8000;
const READY_STATUS_MS = 45_000;

const inFlight = new Set<string>();

function readCompactionSettings(): CompactionSettings {
  const settingsPath = `${process.env.PI_CODING_AGENT_DIR ?? `${process.env.HOME}/.pi/agent`}/settings.json`;
  try {
    const raw = JSON.parse(readFileSync(settingsPath, "utf8"));
    return { ...DEFAULT_COMPACTION_SETTINGS, ...(raw.compaction ?? {}) };
  } catch {
    return DEFAULT_COMPACTION_SETTINGS;
  }
}

function cachePath(sessionFile: string): string {
  return `${sessionFile}.compaction-lookahead.json`;
}

function writeCache(path: string, cache: LookaheadCache): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

function writeError(sessionFile: string, error: unknown): void {
  const path = `${sessionFile}.compaction-lookahead.error.log`;
  const message = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
  writeFileSync(path, `[${new Date().toISOString()}]\n${message}\n`, "utf8");
}

function readCache(path: string): LookaheadCache | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as LookaheadCache;
    if (parsed.version !== 1) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function sameSettings(a: CompactionSettings, b: CompactionSettings): boolean {
  return a.enabled === b.enabled && a.reserveTokens === b.reserveTokens && a.keepRecentTokens === b.keepRecentTokens;
}

function estimateMessagesTokens(messages: AgentMessage[]): number {
  return messages.reduce((total, message) => total + estimateTokens(message), 0);
}

function reportLookaheadError(ctx: ExtensionContext, sessionFile: string, label: string, error: unknown): void {
  try {
    writeError(sessionFile, error);
  } catch {
    // Keep lookahead failures non-fatal; this runs from startup/compaction hooks.
  }
  const message = error instanceof Error ? error.message : String(error);
  ctx.ui.notify(`${label}: ${message}`, "warning");
  ctx.ui.setStatus("lookahead", undefined);
}

function firstEntryAfter(branch: SessionEntry[], entryId: string): SessionEntry | undefined {
  const index = branch.findIndex((entry) => entry.id === entryId);
  if (index < 0) return undefined;
  return branch.slice(index + 1).find((entry) => entry.type !== "custom" && entry.type !== "label" && entry.type !== "session_info");
}

function hasCompaction(branch: SessionEntry[]): boolean {
  return branch.some((entry) => entry.type === "compaction");
}

function latestCompaction(branch: SessionEntry[]): CompactionEntry | undefined {
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type === "compaction") return entry as CompactionEntry;
  }
  return undefined;
}

async function getModelAuth(ctx: ExtensionContext) {
  if (!ctx.model) throw new Error("No active model available for compaction lookahead.");
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
  if (!auth.ok) throw new Error(auth.error);
  return { model: ctx.model, apiKey: auth.apiKey, headers: auth.headers };
}

function contextMessagesFromBranch(branch: SessionEntry[], leafId?: string | null): AgentMessage[] {
  return buildSessionContext(branch, leafId).messages;
}

function shouldRunAutomaticLookahead(ctx: ExtensionContext): boolean {
  return ctx.hasUI && !process.env.PI_OFFLINE;
}

async function computeLookaheadThroughEntry(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  coveredEntryId: string,
  sourceCompactionId: string | undefined,
  reason: "post-compaction" | "session-start",
): Promise<void> {
  const sessionFile = ctx.sessionManager.getSessionFile();
  if (!sessionFile) return;
  const key = `${sessionFile}:post:${coveredEntryId}`;
  if (inFlight.has(key)) return;
  inFlight.add(key);

  ctx.ui.setStatus("lookahead", `summarizing… (${reason})`);

  try {
    const sessionId = ctx.sessionManager.getSessionId();
    const leafId = ctx.sessionManager.getLeafId();
    const branch = ctx.sessionManager.getBranch();
    const settings = readCompactionSettings();
    const messages = contextMessagesFromBranch(branch, leafId);
    const estimate = estimateMessagesTokens(messages);
    const { model, apiKey, headers } = await getModelAuth(ctx);
    const summary = await generateSummary(
      messages,
      model,
      settings.reserveTokens,
      apiKey,
      headers,
      undefined,
      "Produce the next lookahead compaction summary. Preserve all durable decisions, constraints, current state, open tasks, and file context needed after the retained raw window is dropped.",
      undefined,
      pi.getThinkingLevel(),
    );

    writeCache(cachePath(sessionFile), {
      version: 1,
      mode: "post-compaction",
      sessionFile,
      sessionId,
      createdAt: new Date().toISOString(),
      summary,
      coveredEntryId,
      sourceCompactionId,
      tokensBeforeEstimate: estimate,
      settings,
      model: `${model.provider}/${model.id}`,
    });
    ctx.ui.notify("Compaction lookahead: next summary is ready.", "info");
    ctx.ui.setStatus("lookahead", "ready");
    setTimeout(() => ctx.ui.setStatus("lookahead", undefined), READY_STATUS_MS);
  } catch (error: unknown) {
    reportLookaheadError(ctx, sessionFile, "Compaction lookahead failed", error);
  } finally {
    inFlight.delete(key);
  }
}

async function computeBootstrapLookahead(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  const sessionFile = ctx.sessionManager.getSessionFile();
  if (!sessionFile) return;
  const key = `${sessionFile}:bootstrap`;
  if (inFlight.has(key)) return;
  inFlight.add(key);

  ctx.ui.setStatus("lookahead", "summarizing… (bootstrap)");

  try {
    const sessionId = ctx.sessionManager.getSessionId();
    const settings = readCompactionSettings();
    const branch = ctx.sessionManager.getBranch();
    const preparation = prepareCompaction(branch, settings);
    if (!preparation) return;
    if (preparation.messagesToSummarize.length === 0 && preparation.turnPrefixMessages.length === 0) return;
    const approxSummarizeTokens = estimateMessagesTokens(preparation.messagesToSummarize);
    if (approxSummarizeTokens < MIN_BOOTSTRAP_TOKENS_TO_SUMMARIZE) return;

    const { model, apiKey, headers } = await getModelAuth(ctx);
    const result = await compact(
      preparation,
      model,
      apiKey,
      headers,
      "Prepare a cached first compaction summary. Preserve all durable decisions, constraints, current state, open tasks, and file context.",
      undefined,
      pi.getThinkingLevel(),
    );

    writeCache(cachePath(sessionFile), {
      version: 1,
      mode: "bootstrap",
      sessionFile,
      sessionId,
      createdAt: new Date().toISOString(),
      summary: result.summary,
      firstKeptEntryId: result.firstKeptEntryId,
      tokensBeforeEstimate: result.tokensBefore,
      settings,
      model: `${model.provider}/${model.id}`,
    });
    ctx.ui.notify("Compaction lookahead: first compaction summary is ready.", "info");
    ctx.ui.setStatus("lookahead", "ready");
    setTimeout(() => ctx.ui.setStatus("lookahead", undefined), READY_STATUS_MS);
  } catch (error: unknown) {
    reportLookaheadError(ctx, sessionFile, "Compaction lookahead bootstrap failed", error);
  } finally {
    inFlight.delete(key);
  }
}

export default function compactionLookahead(pi: ExtensionAPI) {
  pi.registerCommand("compaction-lookahead-status", {
    description: "Show the compaction lookahead cache status for the current session.",
    handler: async (_args, ctx) => {
      const sessionFile = ctx.sessionManager.getSessionFile();
      if (!sessionFile) {
        ctx.ui.notify("No persisted session file; no lookahead cache.", "warning");
        return;
      }
      const cache = readCache(cachePath(sessionFile));
      if (!cache) {
        ctx.ui.notify("No compaction lookahead cache for this session.", "warning");
        return;
      }
      ctx.ui.notify(
        `Compaction lookahead cache: ${cache.mode}, created ${cache.createdAt}, model ${cache.model ?? "unknown"}`,
        "info",
      );
    },
  });

  pi.registerCommand("compaction-lookahead-prepare", {
    description: "Prepare or refresh the compaction lookahead cache for the current session leaf.",
    handler: async (_args, ctx) => {
      const sessionFile = ctx.sessionManager.getSessionFile();
      if (!sessionFile) {
        ctx.ui.notify("No persisted session file; cannot prepare lookahead cache.", "warning");
        return;
      }
      const leaf = ctx.sessionManager.getLeafEntry();
      if (!leaf?.id) {
        ctx.ui.notify("No session leaf; cannot prepare lookahead cache.", "warning");
        return;
      }
      const compaction = latestCompaction(ctx.sessionManager.getBranch());
      void computeLookaheadThroughEntry(pi, ctx, leaf.id, compaction?.id, "session-start");
      ctx.ui.notify("Compaction lookahead: manual preparation started.", "info");
    },
  });

  pi.on("turn_end", async (_event, ctx) => {
    if (!shouldRunAutomaticLookahead(ctx)) return;
    const sessionFile = ctx.sessionManager.getSessionFile();
    const usage = ctx.getContextUsage();
    if (!sessionFile || !usage?.tokens) return;

    const settings = readCompactionSettings();
    if (!settings.enabled) return;
    const branch = ctx.sessionManager.getBranch();
    if (hasCompaction(branch)) return;
    if (readCache(cachePath(sessionFile))?.mode === "bootstrap") return;

    const triggerAt = usage.contextWindow - settings.reserveTokens;
    if (usage.tokens >= triggerAt - BOOTSTRAP_MARGIN_TOKENS) {
      void computeBootstrapLookahead(pi, ctx);
    }
  });

  pi.on("session_before_compact", async (event, ctx) => {
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (!sessionFile) return;
    const cache = readCache(cachePath(sessionFile));
    if (!cache) return;
    if (cache.sessionFile !== sessionFile || cache.sessionId !== ctx.sessionManager.getSessionId()) return;
    if (!sameSettings(cache.settings, event.preparation.settings)) return;

    let firstKeptEntryId: string | undefined;
    if (cache.mode === "bootstrap") {
      if (cache.firstKeptEntryId !== event.preparation.firstKeptEntryId) return;
      firstKeptEntryId = cache.firstKeptEntryId;
    } else if (cache.mode === "post-compaction" && cache.coveredEntryId) {
      const branch = ctx.sessionManager.getBranch();
      const covered = branch.some((entry) => entry.id === cache.coveredEntryId);
      if (!covered) return;
      const first = firstEntryAfter(branch, cache.coveredEntryId);
      if (!first?.id) return;
      firstKeptEntryId = first.id;
    }

    if (!firstKeptEntryId) return;
    ctx.ui.notify("Compaction lookahead: using cached summary.", "info");
    return {
      compaction: {
        summary: cache.summary,
        firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
        details: {
          ...CUSTOM_DETAILS,
          mode: cache.mode,
          createdAt: cache.createdAt,
          coveredEntryId: cache.coveredEntryId,
          sourceCompactionId: cache.sourceCompactionId,
          tokensBeforeEstimate: cache.tokensBeforeEstimate,
        },
      },
    };
  });

  pi.on("session_compact", async (event, ctx) => {
    if (!shouldRunAutomaticLookahead(ctx)) return;
    void computeLookaheadThroughEntry(pi, ctx, event.compactionEntry.id, event.compactionEntry.id, "post-compaction");
  });

  pi.on("session_start", async (_event, ctx) => {
    if (!shouldRunAutomaticLookahead(ctx)) return;
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (!sessionFile) return;
    const cache = readCache(cachePath(sessionFile));
    if (cache) {
      ctx.ui.setStatus("lookahead", `cache:${cache.mode}`);
      setTimeout(() => ctx.ui.setStatus("lookahead", undefined), 5000);
      return;
    }

    // If Pi is reloaded/resumed after a session already has a compaction,
    // there is no session_compact event to seed the lookahead cache. Prepare a
    // cache through the current leaf so the next official compaction can still
    // be fast and keep only messages written after this point.
    const branch = ctx.sessionManager.getBranch();
    const compaction = latestCompaction(branch);
    const leaf = ctx.sessionManager.getLeafEntry();
    if (compaction?.id && leaf?.id) {
      void computeLookaheadThroughEntry(pi, ctx, leaf.id, compaction.id, "session-start");
    }
  });
}

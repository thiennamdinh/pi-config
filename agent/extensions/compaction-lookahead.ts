import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  buildSessionContext,
  DEFAULT_COMPACTION_SETTINGS,
  estimateTokens,
  generateSummary,
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
const USAGE_LEDGER_PATH = `${process.env.HOME ?? "."}/.pi/agent/usage-ledger.jsonl`;
const DURABLE_SUMMARY_INSTRUCTIONS = `Produce a durable named-agent memory checkpoint, not a terse chat recap.

Favor fidelity over brevity when information may matter in future sessions. Preserve:
- user preferences, operating constraints, and durable decisions;
- agent identity/role, current mission, and long-running architecture direction;
- exact paths, commands, commit hashes, settings values, error messages, and unresolved risks;
- why important choices were made, not just what changed;
- current repo/worktree state, open tasks, blocked transitions, and next verification steps;
- useful local environment quirks and workflow notes.

Keep the structure clear and scannable, but do not aggressively compress important old context merely to be concise. Remove obsolete noise and transient tool chatter.`;

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

function currentAgentFromCwd(cwd: string): string {
  const agentsRoot = `${process.env.HOME ?? "."}/.pi/agents`;
  const root = `${agentsRoot}/`;
  if (!cwd.startsWith(root)) return "pi";
  const name = cwd.slice(root.length).split("/")[0];
  return name || "pi";
}

function estimateCost(model: any, inputTokens: number, outputTokens: number) {
  const cost = model?.cost ?? {};
  const input = (inputTokens * (cost.input ?? 0)) / 1_000_000;
  const output = (outputTokens * (cost.output ?? 0)) / 1_000_000;
  return { input, output, total: input + output };
}

function appendLookaheadUsage(ctx: ExtensionContext, data: Record<string, unknown>): void {
  try {
    mkdirSync(dirname(USAGE_LEDGER_PATH), { recursive: true });
    appendFileSync(
      USAGE_LEDGER_PATH,
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        kind: "compaction_lookahead",
        agent: currentAgentFromCwd(ctx.cwd),
        sessionFile: ctx.sessionManager.getSessionFile(),
        mode: process.env.PI_USAGE_MODE ?? (ctx.hasUI ? "interactive" : "noninteractive"),
        action: "compaction-lookahead",
        taskId: process.env.PI_USAGE_TASK,
        cwd: ctx.cwd,
        provider: ctx.model?.provider,
        model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
        tools: [],
        toolCalls: [],
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 0,
        costInput: 0,
        costOutput: 0,
        costCacheRead: 0,
        costCacheWrite: 0,
        costTotal: 0,
        estimatedCost: true,
        ...data,
      })}\n`,
      "utf8",
    );
  } catch {
    // Usage tracking must not make lookahead fragile.
  }
}

function safeNotify(ctx: ExtensionContext, message: string, level: "info" | "warning" = "info"): void {
  try {
    if (ctx.hasUI) ctx.ui.notify(message, level);
  } catch {
    // UI contexts can become stale after reload/session replacement. Lookahead
    // must never turn a background status update into a process crash.
  }
}

function safeSetStatus(ctx: ExtensionContext, value: string | undefined): void {
  try {
    if (ctx.hasUI) ctx.ui.setStatus("lookahead", value);
  } catch {
    // See safeNotify.
  }
}

function clearStatusLater(ctx: ExtensionContext, ms: number): void {
  setTimeout(() => safeSetStatus(ctx, undefined), ms);
}

function runInBackground(promise: Promise<void>): void {
  promise.catch((error) => {
    // Last-ditch guard. Individual jobs should catch and report their own
    // failures, but an unhandled rejection from a hook must not kill Pi.
    console.error("Compaction lookahead background job failed:", error);
  });
}

function reportLookaheadError(ctx: ExtensionContext, sessionFile: string, label: string, error: unknown): void {
  try {
    writeError(sessionFile, error);
  } catch {
    // Keep lookahead failures non-fatal; this runs from startup/compaction hooks.
  }
  const message = error instanceof Error ? error.message : String(error);
  safeNotify(ctx, `${label}: ${message}`, "warning");
  safeSetStatus(ctx, undefined);
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
  const model = ctx.model;
  if (!model) throw new Error("No active model available for compaction lookahead.");
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) throw new Error(auth.error);
  return { model, apiKey: auth.apiKey, headers: auth.headers };
}

function contextMessagesFromBranch(branch: SessionEntry[], leafId?: string | null): AgentMessage[] {
  return buildSessionContext(branch, leafId).messages;
}

type BootstrapPreparation = {
  firstKeptEntryId: string;
  messagesToSummarize: AgentMessage[];
  tokensBefore: number;
};

function prepareBootstrapLookahead(branch: SessionEntry[], settings: CompactionSettings): BootstrapPreparation | undefined {
  if (branch.length === 0) return undefined;

  const tokensBefore = estimateMessagesTokens(contextMessagesFromBranch(branch));
  let retainedTokens = 0;
  let firstKeptIndex = -1;

  for (let i = branch.length - 1; i >= 0; i--) {
    const messages = contextMessagesFromBranch([branch[i]]);
    const tokens = estimateMessagesTokens(messages);
    if (tokens === 0) continue;
    retainedTokens += tokens;
    firstKeptIndex = i;
    if (retainedTokens >= settings.keepRecentTokens) break;
  }

  if (firstKeptIndex <= 0) return undefined;
  while (firstKeptIndex < branch.length && !branch[firstKeptIndex]?.id) firstKeptIndex++;
  const firstKeptEntry = branch[firstKeptIndex];
  if (!firstKeptEntry?.id) return undefined;

  const messagesToSummarize = contextMessagesFromBranch(branch.slice(0, firstKeptIndex));
  if (messagesToSummarize.length === 0) return undefined;

  return { firstKeptEntryId: firstKeptEntry.id, messagesToSummarize, tokensBefore };
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

  safeSetStatus(ctx, `summarizing… (${reason})`);
  const startedAt = Date.now();

  try {
    const sessionId = ctx.sessionManager.getSessionId();
    const leafId = ctx.sessionManager.getLeafId();
    const branch = ctx.sessionManager.getBranch();
    const settings = readCompactionSettings();
    const messages = contextMessagesFromBranch(branch, leafId);
    const estimate = estimateMessagesTokens(messages);
    const thinkingLevel = pi.getThinkingLevel();
    const { model, apiKey, headers } = await getModelAuth(ctx);
    const summary = await generateSummary(
      messages,
      model,
      settings.reserveTokens,
      apiKey,
      headers,
      undefined,
      DURABLE_SUMMARY_INSTRUCTIONS,
      undefined,
      thinkingLevel,
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
    const outputTokens = Math.ceil(summary.length / 4);
    const estimatedCost = estimateCost(model, estimate, outputTokens);
    appendLookaheadUsage(ctx, {
      action: "compaction-lookahead-post",
      sourceCompactionId,
      coveredEntryId,
      tokensBeforeEstimate: estimate,
      summaryChars: summary.length,
      summaryTokenEstimate: outputTokens,
      inputTokens: estimate,
      outputTokens,
      totalTokens: estimate + outputTokens,
      costInput: estimatedCost.input,
      costOutput: estimatedCost.output,
      costTotal: estimatedCost.total,
      durationMs: Date.now() - startedAt,
      model: `${model.provider}/${model.id}`,
    });
    safeNotify(ctx, "Compaction lookahead: next summary is ready.", "info");
    safeSetStatus(ctx, "ready");
    clearStatusLater(ctx, READY_STATUS_MS);
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

  safeSetStatus(ctx, "summarizing… (bootstrap)");
  const startedAt = Date.now();

  try {
    const sessionId = ctx.sessionManager.getSessionId();
    const settings = readCompactionSettings();
    const branch = ctx.sessionManager.getBranch();
    const preparation = prepareBootstrapLookahead(branch, settings);
    if (!preparation) return;
    const approxSummarizeTokens = estimateMessagesTokens(preparation.messagesToSummarize);
    if (approxSummarizeTokens < MIN_BOOTSTRAP_TOKENS_TO_SUMMARIZE) return;

    const thinkingLevel = pi.getThinkingLevel();
    const { model, apiKey, headers } = await getModelAuth(ctx);
    const summary = await generateSummary(
      preparation.messagesToSummarize,
      model,
      settings.reserveTokens,
      apiKey,
      headers,
      undefined,
      DURABLE_SUMMARY_INSTRUCTIONS,
      undefined,
      thinkingLevel,
    );

    writeCache(cachePath(sessionFile), {
      version: 1,
      mode: "bootstrap",
      sessionFile,
      sessionId,
      createdAt: new Date().toISOString(),
      summary,
      firstKeptEntryId: preparation.firstKeptEntryId,
      tokensBeforeEstimate: preparation.tokensBefore,
      settings,
      model: `${model.provider}/${model.id}`,
    });
    const outputTokens = Math.ceil(summary.length / 4);
    const estimatedCost = estimateCost(model, preparation.tokensBefore, outputTokens);
    appendLookaheadUsage(ctx, {
      action: "compaction-lookahead-bootstrap",
      firstKeptEntryId: preparation.firstKeptEntryId,
      tokensBeforeEstimate: preparation.tokensBefore,
      summaryChars: summary.length,
      summaryTokenEstimate: outputTokens,
      inputTokens: preparation.tokensBefore,
      outputTokens,
      totalTokens: preparation.tokensBefore + outputTokens,
      costInput: estimatedCost.input,
      costOutput: estimatedCost.output,
      costTotal: estimatedCost.total,
      durationMs: Date.now() - startedAt,
      model: `${model.provider}/${model.id}`,
    });
    safeNotify(ctx, "Compaction lookahead: first compaction summary is ready.", "info");
    safeSetStatus(ctx, "ready");
    clearStatusLater(ctx, READY_STATUS_MS);
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
        safeNotify(ctx, "No persisted session file; no lookahead cache.", "warning");
        return;
      }
      const cache = readCache(cachePath(sessionFile));
      if (!cache) {
        safeNotify(ctx, "No compaction lookahead cache for this session.", "warning");
        return;
      }
      safeNotify(
        ctx,
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
        safeNotify(ctx, "No persisted session file; cannot prepare lookahead cache.", "warning");
        return;
      }
      const leaf = ctx.sessionManager.getLeafEntry();
      if (!leaf?.id) {
        safeNotify(ctx, "No session leaf; cannot prepare lookahead cache.", "warning");
        return;
      }
      const compaction = latestCompaction(ctx.sessionManager.getBranch());
      runInBackground(computeLookaheadThroughEntry(pi, ctx, leaf.id, compaction?.id, "session-start"));
      safeNotify(ctx, "Compaction lookahead: manual preparation started.", "info");
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
      runInBackground(computeBootstrapLookahead(pi, ctx));
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
    safeNotify(ctx, "Compaction lookahead: using cached summary.", "info");
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
    runInBackground(computeLookaheadThroughEntry(pi, ctx, event.compactionEntry.id, event.compactionEntry.id, "post-compaction"));
  });

  pi.on("session_start", async (_event, ctx) => {
    if (!shouldRunAutomaticLookahead(ctx)) return;
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (!sessionFile) return;
    const cache = readCache(cachePath(sessionFile));
    if (cache) {
      safeSetStatus(ctx, `cache:${cache.mode}`);
      clearStatusLater(ctx, 5000);
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
      runInBackground(computeLookaheadThroughEntry(pi, ctx, leaf.id, compaction.id, "session-start"));
    }
  });
}

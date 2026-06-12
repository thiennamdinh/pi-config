import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const HOME = process.env.HOME ?? ".";
const AGENTS_ROOT = `${HOME}/.pi/agents`;
const LEDGER_PATH = `${HOME}/.pi/agent/usage-ledger.jsonl`;
const STATUS_KEY = "usage-ledger";

type ResourceAccess = "read" | "write" | "execute" | "unknown";

type UsageResource = {
  path?: string;
  language?: string;
  kind?: string;
  access: ResourceAccess;
};

type UsageToolCall = {
  ordinal: number;
  id?: string;
  name: string;
  signature: string;
  argsShape?: string;
  resources: UsageResource[];
  languages: string[];
  resultBytes?: number;
  isError?: boolean;
};

type UsageLedgerRecord = {
  timestamp: string;
  /** Backward-compatible reader support only; new writes use timestamp. */
  ts?: string;
  kind: "provider_response" | "compaction" | "compaction_lookahead";
  agent: string;
  sessionFile?: string;
  messageId?: string;
  parentId?: string;
  turnIndex?: number;
  mode: string;
  action: string;
  taskId?: string;
  cwd: string;
  gitRoot?: string;
  provider?: string;
  model?: string;
  thinking?: string;
  tools?: string[];
  toolCalls?: UsageToolCall[];
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
  costInput?: number;
  costOutput?: number;
  costCacheRead?: number;
  costCacheWrite?: number;
  costTotal?: number;
  estimatedCost?: boolean;
  compactionEntryId?: string;
  firstKeptEntryId?: string;
  tokensBefore?: number;
  tokensAfterEstimate?: number;
  summaryChars?: number;
  summaryTokenEstimate?: number;
  fromExtension?: boolean;
  durationMs?: number;
};

type Scope = {
  taskId?: string;
  mode?: string;
};

let currentTurnIndex: number | undefined;
let currentTurnTools = new Set<string>();
let currentToolOrdinal = 0;
let currentTurnToolCalls = new Map<string, UsageToolCall>();
let currentScope: Scope = {
  taskId: process.env.PI_USAGE_TASK,
  mode: process.env.PI_USAGE_MODE,
};
let compactionStartedAt: number | undefined;

function nowIso() {
  return new Date().toISOString();
}

function currentAgentFromCwd(cwd: string) {
  const root = resolve(AGENTS_ROOT);
  const current = resolve(cwd);
  if (!current.startsWith(`${root}/`)) return "pi";
  const rel = current.slice(root.length + 1);
  const name = rel.split("/")[0];
  if (!name || name.startsWith(".")) return "pi";
  return existsSync(`${AGENTS_ROOT}/${name}/manifest.json`) ? name : "pi";
}

function recordTimestamp(record: UsageLedgerRecord) {
  return record.timestamp ?? record.ts ?? "";
}

function gitRoot(cwd: string): string | undefined {
  try {
    const out = execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

function languageForPath(path: string): string {
  const base = basename(path).toLowerCase();
  const ext = extname(base);
  if (["makefile", "dockerfile"].includes(base)) return base;
  if (base === "agents.md" || base.endsWith(".md")) return "markdown";
  const byExt: Record<string, string> = {
    ".rs": "rust",
    ".scm": "scheme",
    ".ss": "scheme",
    ".sld": "scheme",
    ".lisp": "lisp",
    ".el": "elisp",
    ".ts": "typescript",
    ".tsx": "typescript",
    ".js": "javascript",
    ".jsx": "javascript",
    ".py": "python",
    ".go": "go",
    ".java": "java",
    ".c": "c",
    ".h": "c/c++",
    ".cc": "c++",
    ".cpp": "c++",
    ".hpp": "c++",
    ".md": "markdown",
    ".txt": "text",
    ".json": "json",
    ".jsonl": "jsonl",
    ".yaml": "yaml",
    ".yml": "yaml",
    ".toml": "toml",
    ".sh": "shell",
    ".bash": "shell",
    ".zsh": "shell",
    ".sql": "sql",
    ".html": "html",
    ".css": "css",
    ".scss": "css",
    ".xml": "xml",
  };
  return byExt[ext] ?? "unknown";
}

function resourceKind(language: string) {
  if (["markdown", "text"].includes(language)) return "docs";
  if (["json", "jsonl", "yaml", "toml", "xml"].includes(language)) return "config/data";
  if (language === "unknown") return "unknown";
  return "source";
}

function resourceForPath(path: string, access: ResourceAccess): UsageResource {
  const language = languageForPath(path);
  return { path, language, kind: resourceKind(language), access };
}

function resultByteSize(result: unknown) {
  try {
    return Buffer.byteLength(JSON.stringify(result ?? null), "utf8");
  } catch {
    return undefined;
  }
}

function commandSignature(command: string) {
  const trimmed = command.trim();
  if (!trimmed) return "bash:empty";
  const first = trimmed.split(/\s+/)[0];
  if (["rg", "grep", "fd", "find", "ls", "git", "npm", "pnpm", "yarn", "cargo", "go", "python", "python3", "node", "jq", "yq"].includes(first)) return `bash:${first}`;
  return "bash:other";
}

function inferToolCall(event: { toolCallId?: string; toolName: string; args?: any }, ordinal: number): UsageToolCall {
  const name = event.toolName;
  const args = event.args ?? {};
  const resources: UsageResource[] = [];
  let signature = name;
  let argsShape: string | undefined;

  if (name === "read" && typeof args.path === "string") {
    const resource = resourceForPath(args.path, "read");
    resources.push(resource);
    signature = `read:${resource.language ?? "unknown"}`;
    argsShape = ["path", args.offset !== undefined ? "offset" : undefined, args.limit !== undefined ? "limit" : undefined].filter(Boolean).join("+");
  } else if (name === "write" && typeof args.path === "string") {
    const resource = resourceForPath(args.path, "write");
    resources.push(resource);
    signature = `write:${resource.language ?? "unknown"}`;
    argsShape = "path+content";
  } else if (name === "edit" && typeof args.path === "string") {
    const resource = resourceForPath(args.path, "write");
    resources.push(resource);
    signature = `edit:${resource.language ?? "unknown"}`;
    argsShape = "path+edits";
  } else if (name === "bash" && typeof args.command === "string") {
    signature = commandSignature(args.command);
    argsShape = "command";
  } else {
    argsShape = Object.keys(args).sort().join("+") || undefined;
  }

  const languages = [...new Set(resources.map((r) => r.language).filter(Boolean) as string[])].sort();
  return { ordinal, id: event.toolCallId, name, signature, argsShape, resources, languages };
}

function inferMode(ctx: ExtensionCommandContext): string {
  if (currentScope.mode) return currentScope.mode;
  if (process.env.PI_AGENT_EPHEMERAL_CLONE) return "agent-ask-clone";
  if (process.env.PI_USAGE_MODE) return process.env.PI_USAGE_MODE;
  return ctx.hasUI ? "interactive" : "noninteractive";
}

function inferAction(tools: string[]): string {
  if (process.env.PI_AGENT_EPHEMERAL_CLONE) return "agent-ask-clone";
  if (currentScope.taskId?.startsWith("compaction")) return currentScope.taskId;
  if (tools.length) return "tool-turn";
  return "normal-turn";
}

async function writeRecord(record: UsageLedgerRecord) {
  await mkdir(dirname(LEDGER_PATH), { recursive: true });
  await appendFile(LEDGER_PATH, `${JSON.stringify(record)}\n`, "utf8");
}

async function readRecords(): Promise<UsageLedgerRecord[]> {
  if (!existsSync(LEDGER_PATH)) return [];
  const lines = (await readFile(LEDGER_PATH, "utf8")).split("\n").filter((line) => line.trim());
  const records: UsageLedgerRecord[] = [];
  for (const line of lines) {
    try {
      records.push(JSON.parse(line) as UsageLedgerRecord);
    } catch {
      // Ignore malformed ledger lines.
    }
  }
  return records;
}

function parseSince(args: string): number {
  const raw = args.trim().split(/\s+/)[0] || "24h";
  const match = /^(\d+(?:\.\d+)?)(m|h|d|w)$/i.exec(raw);
  if (!match) return Date.now() - 24 * 60 * 60 * 1000;
  const n = Number(match[1]);
  const unit = match[2].toLowerCase();
  const mult = unit === "m" ? 60_000 : unit === "h" ? 60 * 60_000 : unit === "d" ? 24 * 60 * 60_000 : 7 * 24 * 60 * 60_000;
  return Date.now() - n * mult;
}

function formatTokens(n: number) {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

function aggregate(records: UsageLedgerRecord[]) {
  return records.reduce(
    (acc, r) => {
      acc.count++;
      acc.input += r.inputTokens || 0;
      acc.output += r.outputTokens || 0;
      acc.cacheRead += r.cacheReadTokens || 0;
      acc.cacheWrite += r.cacheWriteTokens || 0;
      acc.total += r.totalTokens || 0;
      acc.cost += r.costTotal || 0;
      return acc;
    },
    { count: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 },
  );
}

type Aggregate = ReturnType<typeof aggregate>;

function aggregateLine(label: string, a: Aggregate) {
  return `${label.padEnd(24)} ${String(a.count).padStart(5)} turns  ${formatTokens(a.total).padStart(8)} tok  $${a.cost.toFixed(4).padStart(10)}  in ${formatTokens(a.input)} out ${formatTokens(a.output)} cache ${formatTokens(a.cacheRead)}`;
}

function estimateCost(model: any, inputTokens: number, outputTokens: number) {
  const cost = model?.cost ?? {};
  const input = (inputTokens * (cost.input ?? 0)) / 1_000_000;
  const output = (outputTokens * (cost.output ?? 0)) / 1_000_000;
  return { input, output, total: input + output };
}

function groupBy(records: UsageLedgerRecord[], key: keyof UsageLedgerRecord) {
  const groups = new Map<string, UsageLedgerRecord[]>();
  for (const record of records) {
    const value = String(record[key] ?? "(none)");
    groups.set(value, [...(groups.get(value) ?? []), record]);
  }
  return [...groups.entries()]
    .map(([label, rows]) => [label, aggregate(rows)] as const)
    .sort((a, b) => b[1].cost - a[1].cost);
}

async function recordsSince(args: string) {
  const since = parseSince(args);
  return (await readRecords()).filter((r) => Date.parse(recordTimestamp(r)) >= since);
}

async function notifySummary(ctx: ExtensionCommandContext, args: string, group?: keyof UsageLedgerRecord) {
  const records = await recordsSince(args);
  const sinceLabel = args.trim().split(/\s+/)[0] || "24h";
  if (!records.length) {
    ctx.ui.notify(`No usage ledger records in last ${sinceLabel}.`, "info");
    return;
  }
  const total = aggregate(records);
  const lines = [`Usage last ${sinceLabel}`, aggregateLine("total", total)];
  if (group) {
    lines.push("", `By ${group}:`);
    for (const [label, agg] of groupBy(records, group).slice(0, 20)) lines.push(aggregateLine(label, agg));
  } else {
    for (const key of ["kind", "agent", "mode", "action", "taskId", "model"] as (keyof UsageLedgerRecord)[]) {
      lines.push("", `By ${key}:`);
      for (const [label, agg] of groupBy(records, key).slice(0, 8)) lines.push(aggregateLine(label, agg));
    }
  }
  ctx.ui.notify(lines.join("\n"), "info");
}

async function notifyTopTurns(ctx: ExtensionCommandContext, args: string) {
  const records = (await recordsSince(args)).sort((a, b) => b.costTotal - a.costTotal).slice(0, 20);
  const sinceLabel = args.trim().split(/\s+/)[0] || "24h";
  if (!records.length) return ctx.ui.notify(`No usage ledger records in last ${sinceLabel}.`, "info");
  const lines = [`Top usage turns last ${sinceLabel}`];
  for (const r of records) {
    const local = new Date(recordTimestamp(r)).toLocaleString();
    lines.push(`${local}  $${(r.costTotal || 0).toFixed(4)}  ${formatTokens(r.totalTokens || 0)}  ${r.agent}/${r.mode}/${r.action}  ${r.model ?? "?"}  ${r.sessionFile ?? ""}`);
  }
  ctx.ui.notify(lines.join("\n"), "info");
}

function formatBytes(n: number) {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}GB`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}MB`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}KB`;
  return `${Math.round(n)}B`;
}

type ToolAggregate = {
  calls: number;
  turns: Set<string>;
  cost: number;
  tokens: number;
  resultBytes: number;
  errors: number;
};

function parseToolUsageArgs(args: string, defaultLimit = 16) {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  let sinceLabel = "24h";
  let limit = defaultLimit;
  for (const part of parts) {
    if (/^\d+(?:\.\d+)?[mhdw]$/i.test(part)) {
      sinceLabel = part;
    } else if (part.toLowerCase() === "all") {
      limit = Number.POSITIVE_INFINITY;
    } else {
      const n = Number.parseInt(part, 10);
      if (Number.isFinite(n) && n > 0) limit = Math.min(n, 200);
    }
  }
  return { sinceLabel, since: parseSince(sinceLabel), limit };
}

async function notifyByTool(ctx: ExtensionCommandContext, args: string) {
  const { sinceLabel, since, limit } = parseToolUsageArgs(args);
  const records = (await readRecords()).filter((r) => Date.parse(recordTimestamp(r)) >= since && r.kind === "provider_response" && (r.toolCalls?.length ?? 0) > 0);
  if (!records.length) return ctx.ui.notify(`No tool-call usage records in last ${sinceLabel}.`, "info");

  const groups = new Map<string, ToolAggregate>();
  for (const record of records) {
    const calls = record.toolCalls ?? [];
    if (!calls.length) continue;
    const turnKey = record.messageId ?? `${recordTimestamp(record)}:${record.sessionFile ?? ""}`;
    const attributedCost = (record.costTotal ?? 0) / calls.length;
    const attributedTokens = (record.totalTokens ?? 0) / calls.length;
    for (const call of calls) {
      const key = call.name;
      const agg = groups.get(key) ?? { calls: 0, turns: new Set<string>(), cost: 0, tokens: 0, resultBytes: 0, errors: 0 };
      agg.calls += 1;
      agg.turns.add(turnKey);
      agg.cost += attributedCost;
      agg.tokens += attributedTokens;
      agg.resultBytes += call.resultBytes ?? 0;
      if (call.isError) agg.errors += 1;
      groups.set(key, agg);
    }
  }

  const allRows = [...groups.entries()].sort((a, b) => b[1].cost - a[1].cost);
  const rows = allRows.slice(0, limit);
  const limitLabel = Number.isFinite(limit) ? `showing ${rows.length} of ${allRows.length}, cap ${limit}` : `showing all ${allRows.length}`;
  const lines = [`Top tools last ${sinceLabel} (${limitLabel})`, "tool                   calls turns       tok        cost   result   errors"];
  for (const [tool, agg] of rows) {
    lines.push(`${tool.padEnd(22)} ${String(agg.calls).padStart(5)} ${String(agg.turns.size).padStart(5)} ${formatTokens(agg.tokens).padStart(9)} $${agg.cost.toFixed(4).padStart(9)} ${formatBytes(agg.resultBytes).padStart(8)} ${String(agg.errors).padStart(6)}`);
  }
  lines.push("", "Cost/tokens are attributed evenly across tool calls in each turn; use as a pattern signal, not exact per-tool billing.");
  ctx.ui.notify(lines.join("\n"), "info");
}

function updateStatus(ctx: ExtensionCommandContext) {
  readRecords()
    .then((records) => {
      const day = records.filter((r) => Date.parse(recordTimestamp(r)) >= Date.now() - 24 * 60 * 60_000);
      const agg = aggregate(day);
      ctx.ui.setStatus(STATUS_KEY, day.length ? `usage 24h $${agg.cost.toFixed(2)} ${formatTokens(agg.total)}` : undefined);
    })
    .catch(() => undefined);
}

export default function usageLedger(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => updateStatus(ctx as ExtensionCommandContext));

  pi.on("turn_start", async (event) => {
    currentTurnIndex = event.turnIndex;
    // Do not clear pending tool calls here: Pi may emit a provider response that
    // requests tools, then tool_execution_* events, then another provider
    // response with the final answer. We attach the executed tools to the final
    // response record and clear them after writing that record.
    if (!currentTurnTools.size && !currentTurnToolCalls.size) currentToolOrdinal = 0;
  });

  pi.on("session_before_compact", async () => {
    compactionStartedAt = Date.now();
  });

  pi.on("session_compact", async (event, ctx) => {
    const context = ctx as ExtensionCommandContext;
    const entry = event.compactionEntry as any;
    const contextUsage = context.getContextUsage?.();
    const summary = String(entry.summary ?? "");
    const usedLookaheadCache = entry.details?.source === "compaction-lookahead";
    const inputTokens = usedLookaheadCache ? 0 : entry.tokensBefore ?? 0;
    const outputTokens = usedLookaheadCache ? 0 : Math.ceil(summary.length / 4);
    const estimatedCost = estimateCost(context.model, inputTokens, outputTokens);
    const record: UsageLedgerRecord = {
      timestamp: nowIso(),
      kind: "compaction",
      agent: currentAgentFromCwd(context.cwd),
      sessionFile: context.sessionManager.getSessionFile(),
      mode: inferMode(context),
      action: event.fromExtension ? "extension-compaction" : "compaction",
      taskId: currentScope.taskId ?? process.env.PI_USAGE_TASK,
      cwd: context.cwd,
      gitRoot: gitRoot(context.cwd),
      provider: context.model?.provider,
      model: context.model ? `${context.model.provider}/${context.model.id}` : undefined,
      thinking: (context as any).thinkingLevel ?? undefined,
      tools: [],
      toolCalls: [],
      inputTokens,
      outputTokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: inputTokens + outputTokens,
      costInput: estimatedCost.input,
      costOutput: estimatedCost.output,
      costCacheRead: 0,
      costCacheWrite: 0,
      costTotal: estimatedCost.total,
      estimatedCost: true,
      compactionEntryId: entry.id,
      firstKeptEntryId: entry.firstKeptEntryId,
      tokensBefore: entry.tokensBefore,
      tokensAfterEstimate: contextUsage?.tokens,
      summaryChars: summary.length,
      summaryTokenEstimate: Math.ceil(summary.length / 4),
      fromExtension: Boolean(event.fromExtension ?? entry.fromHook),
      durationMs: compactionStartedAt ? Date.now() - compactionStartedAt : undefined,
    };
    compactionStartedAt = undefined;
    await writeRecord(record);
    updateStatus(context);
  });

  pi.on("tool_execution_start", async (event) => {
    currentTurnTools.add(event.toolName);
    const ordinal = ++currentToolOrdinal;
    currentTurnToolCalls.set(event.toolCallId, inferToolCall(event, ordinal));
  });

  pi.on("tool_execution_end", async (event) => {
    const existing = currentTurnToolCalls.get(event.toolCallId) ?? inferToolCall(event, ++currentToolOrdinal);
    existing.resultBytes = resultByteSize(event.result);
    existing.isError = Boolean(event.isError);
    currentTurnToolCalls.set(event.toolCallId, existing);
  });

  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "assistant") return;
    const usage = event.message.usage;
    if (!usage) return;
    const cost = usage.cost ?? {};
    const tools = [...currentTurnTools].sort();
    const context = ctx as ExtensionCommandContext;
    const modelId = context.model ? `${context.model.provider}/${context.model.id}` : undefined;
    const record: UsageLedgerRecord = {
      timestamp: nowIso(),
      kind: "provider_response",
      agent: currentAgentFromCwd(context.cwd),
      sessionFile: context.sessionManager.getSessionFile(),
      messageId: (event.message as any).id,
      parentId: (event.message as any).parentId,
      turnIndex: currentTurnIndex,
      mode: inferMode(context),
      action: inferAction(tools),
      taskId: currentScope.taskId ?? process.env.PI_USAGE_TASK,
      cwd: context.cwd,
      gitRoot: gitRoot(context.cwd),
      provider: context.model?.provider,
      model: modelId,
      thinking: (context as any).thinkingLevel ?? undefined,
      tools,
      toolCalls: [...currentTurnToolCalls.values()].sort((a, b) => a.ordinal - b.ordinal),
      inputTokens: usage.input || 0,
      outputTokens: usage.output || 0,
      cacheReadTokens: usage.cacheRead || 0,
      cacheWriteTokens: usage.cacheWrite || 0,
      totalTokens: usage.totalTokens || ((usage.input || 0) + (usage.output || 0) + (usage.cacheRead || 0) + (usage.cacheWrite || 0)),
      costInput: cost.input || 0,
      costOutput: cost.output || 0,
      costCacheRead: cost.cacheRead || 0,
      costCacheWrite: cost.cacheWrite || 0,
      costTotal: cost.total || 0,
    };
    await writeRecord(record);
    if (currentTurnToolCalls.size) {
      currentTurnTools = new Set<string>();
      currentTurnToolCalls = new Map<string, UsageToolCall>();
      currentToolOrdinal = 0;
    }
    updateStatus(context);
  });

  pi.registerCommand("usage-summary", {
    description: "Show token/cost usage summary from the usage ledger. Usage: /usage-summary [24h|3d|7d]",
    handler: async (args, ctx) => notifySummary(ctx, args),
  });

  pi.registerCommand("usage-by-agent", {
    description: "Group usage by agent. Usage: /usage-by-agent [24h|3d|7d]",
    handler: async (args, ctx) => notifySummary(ctx, args, "agent"),
  });

  pi.registerCommand("usage-by-mode", {
    description: "Group usage by invocation mode. Usage: /usage-by-mode [24h|3d|7d]",
    handler: async (args, ctx) => notifySummary(ctx, args, "mode"),
  });

  pi.registerCommand("usage-by-task", {
    description: "Group usage by task id. Usage: /usage-by-task [24h|3d|7d]",
    handler: async (args, ctx) => notifySummary(ctx, args, "taskId"),
  });

  pi.registerCommand("usage-top-turns", {
    description: "Show the most expensive turns. Usage: /usage-top-turns [24h|3d|7d]",
    handler: async (args, ctx) => notifyTopTurns(ctx, args),
  });

  pi.registerCommand("usage-by-tool", {
    description: "Group usage by tool call. Usage: /usage-by-tool [24h|3d|7d] [limit|all]",
    handler: async (args, ctx) => notifyByTool(ctx, args),
  });

  pi.registerCommand("usage-task", {
    description: "Set/show current usage task id. Usage: /usage-task [task-id|off]",
    handler: async (args, ctx) => {
      const value = args.trim();
      if (!value) return ctx.ui.notify(`Current usage task: ${currentScope.taskId ?? "(none)"}`, "info");
      currentScope.taskId = value === "off" || value === "none" ? undefined : value;
      ctx.ui.notify(`Usage task: ${currentScope.taskId ?? "(none)"}`, "info");
    },
  });

  pi.registerCommand("usage-mode", {
    description: "Set/show current usage mode. Usage: /usage-mode [interactive|scheduled|daemon|off]",
    handler: async (args, ctx) => {
      const value = args.trim();
      if (!value) return ctx.ui.notify(`Current usage mode: ${currentScope.mode ?? "(auto)"}`, "info");
      currentScope.mode = value === "off" || value === "auto" ? undefined : value;
      ctx.ui.notify(`Usage mode: ${currentScope.mode ?? "(auto)"}`, "info");
    },
  });
}

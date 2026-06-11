import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const HOME = process.env.HOME ?? ".";
const AGENTS_ROOT = `${HOME}/.pi/agents`;
const LEDGER_PATH = `${HOME}/.pi/agent/usage-ledger.jsonl`;
const STATUS_KEY = "usage-ledger";

type UsageLedgerRecord = {
  ts: string;
  kind: "provider_response";
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
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costInput: number;
  costOutput: number;
  costCacheRead: number;
  costCacheWrite: number;
  costTotal: number;
};

type Scope = {
  taskId?: string;
  mode?: string;
};

let currentTurnIndex: number | undefined;
let currentTurnTools = new Set<string>();
let currentScope: Scope = {
  taskId: process.env.PI_USAGE_TASK,
  mode: process.env.PI_USAGE_MODE,
};

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

function gitRoot(cwd: string): string | undefined {
  try {
    const out = execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
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
  return (await readRecords()).filter((r) => Date.parse(r.ts) >= since);
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
    for (const key of ["agent", "mode", "action", "taskId", "model"] as (keyof UsageLedgerRecord)[]) {
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
    const local = new Date(r.ts).toLocaleString();
    lines.push(`${local}  $${r.costTotal.toFixed(4)}  ${formatTokens(r.totalTokens)}  ${r.agent}/${r.mode}/${r.action}  ${r.model ?? "?"}  ${r.sessionFile ?? ""}`);
  }
  ctx.ui.notify(lines.join("\n"), "info");
}

function updateStatus(ctx: ExtensionCommandContext) {
  readRecords()
    .then((records) => {
      const day = records.filter((r) => Date.parse(r.ts) >= Date.now() - 24 * 60 * 60_000);
      const agg = aggregate(day);
      ctx.ui.setStatus(STATUS_KEY, day.length ? `usage 24h $${agg.cost.toFixed(2)} ${formatTokens(agg.total)}` : undefined);
    })
    .catch(() => undefined);
}

export default function usageLedger(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => updateStatus(ctx as ExtensionCommandContext));

  pi.on("turn_start", async (event) => {
    currentTurnIndex = event.turnIndex;
    currentTurnTools = new Set<string>();
  });

  pi.on("tool_execution_start", async (event) => {
    currentTurnTools.add(event.toolName);
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
      ts: nowIso(),
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

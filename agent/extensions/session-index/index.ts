import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as lancedb from "@lancedb/lancedb";
import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";

const HOME = process.env.HOME ?? ".";
const PI_ROOT = `${HOME}/.pi`;
const AGENTS_ROOT = `${PI_ROOT}/agents`;
const ROOT_AGENT_DIR = `${PI_ROOT}/agent`;
const INDEX_ROOT = `${PI_ROOT}/cache/session-index`;
const DB_PATH = `${INDEX_ROOT}/lancedb`;
const STATE_PATH = `${INDEX_ROOT}/state.json`;
const TABLE_NAME = "session_chunks";
const HASH_VECTOR_DIMS = 384;
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
const OLLAMA_EMBED_MODEL = process.env.PI_SESSION_INDEX_EMBED_MODEL ?? process.env.OLLAMA_EMBED_MODEL ?? "nomic-embed-text";
const EMBEDDING_BACKEND = process.env.PI_SESSION_INDEX_EMBED_BACKEND ?? "ollama";
const EMBEDDING_MODEL = EMBEDDING_BACKEND === "hash" ? `local-hash-${HASH_VECTOR_DIMS}-v1` : `ollama:${OLLAMA_EMBED_MODEL}`;
const CHUNKER_VERSION = "pi-session-chunker-v1";
const OLLAMA_EMBED_BATCH_SIZE = Math.max(1, Math.min(128, Number(process.env.PI_SESSION_INDEX_EMBED_BATCH_SIZE ?? 32)));
const MAX_TEXT_CHARS = 2_500;
const MAX_OUTPUT_PREVIEW_CHARS = 2_000;
const MAX_TOOL_RESULT_INDEX_CHARS = 4_000;
const ZERO_VECTOR: number[] = [];

type JsonRecord = Record<string, unknown>;

type SessionChunk = {
  chunkId: string;
  source: "pi-session";
  agent: string;
  sessionId: string;
  sessionFile: string;
  sessionRelPath: string;
  entryId: string;
  parentId: string;
  chunkIndex: number;
  role: string;
  entryType: string;
  timestamp: string;
  cwd: string;
  sessionName: string;
  text: string;
  snippet: string;
  textHash: string;
  contentKind: string;
  language: string;
  pathsJson: string;
  toolsJson: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costTotal: number;
  isError: boolean;
  embeddingModel: string;
  chunkerVersion: string;
  indexedAt: string;
  sourceMtime: string;
  sourceSize: number;
  includeInRecall: boolean;
  sensitivity: string;
  vector: number[];
};

type IndexState = {
  updatedAt: string;
  tableName: string;
  dbPath: string;
  embeddingModel: string;
  chunkerVersion: string;
  filesScanned: number;
  chunksIndexed: number;
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function escapeSqlString(value: string): string {
  return value.replace(/'/g, "''");
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("\n\n");
}

function contentKind(entryType: string, role: string, text: string, isError = false): string {
  if (isError) return "error";
  if (entryType === "compaction") return "compaction_summary";
  if (entryType === "branch_summary") return "branch_summary";
  if (entryType === "custom_message") return "custom";
  if (entryType === "bashExecution") return "shell";
  if (role === "user") return "user_request";
  if (role === "assistant") return "assistant_answer";
  if (role === "toolResult") return "tool_result";
  if (/\b(decided|decision|we should|plan|todo|fixed|implemented)\b/i.test(text)) return "decision_or_plan";
  return "message";
}

function inferLanguageFromPath(pathValue: string): string {
  const lower = pathValue.toLowerCase();
  if (lower.endsWith(".rs")) return "rust";
  if (lower.endsWith(".scm") || lower.endsWith(".ss") || lower.endsWith(".sld")) return "scheme";
  if (lower.endsWith(".ts") || lower.endsWith(".tsx")) return "typescript";
  if (lower.endsWith(".js") || lower.endsWith(".jsx") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) return "javascript";
  if (lower.endsWith(".py")) return "python";
  if (lower.endsWith(".go")) return "go";
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "markdown";
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".yml") || lower.endsWith(".yaml")) return "yaml";
  if (lower.endsWith(".toml")) return "toml";
  if (lower.endsWith(".sh") || lower.endsWith(".bash")) return "shell";
  return "unknown";
}

function extractPaths(text: string): string[] {
  const paths = new Set<string>();
  const regex = /(?:~|\.|\/)?(?:[A-Za-z0-9_.@+-]+\/)+[A-Za-z0-9_.@+:-]+/g;
  for (const match of text.matchAll(regex)) {
    const value = match[0];
    if (value.length > 3 && !value.startsWith("http")) paths.add(value);
  }
  return [...paths].slice(0, 20);
}

function inferLanguage(text: string, paths: string[]): string {
  for (const p of paths) {
    const lang = inferLanguageFromPath(p);
    if (lang !== "unknown") return lang;
  }
  if (/```(?:rust|rs)\b/.test(text)) return "rust";
  if (/```(?:scheme|scm|racket)\b/.test(text)) return "scheme";
  if (/```(?:ts|typescript)\b/.test(text)) return "typescript";
  if (/```python\b/.test(text)) return "python";
  if (/```(?:sh|bash|shell)\b/.test(text)) return "shell";
  return "unknown";
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_./:-]+/)
    .filter((token) => token.length >= 2 && token.length <= 80);
}

function hashVector(text: string): number[] {
  const vec = new Array<number>(HASH_VECTOR_DIMS).fill(0);
  const tokens = tokenize(text);
  for (const token of tokens) {
    const digest = createHash("sha256").update(token).digest();
    const idx = digest.readUInt32BE(0) % HASH_VECTOR_DIMS;
    const sign = digest[4] & 1 ? 1 : -1;
    vec[idx] += sign;
  }
  const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
  if (norm > 0) {
    for (let i = 0; i < vec.length; i++) vec[i] = vec[i] / norm;
  }
  return vec;
}


function normalizeVector(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  if (norm === 0) return vector;
  return vector.map((v) => v / norm);
}

async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (EMBEDDING_BACKEND === "hash") return texts.map(hashVector);

  const url = `${OLLAMA_BASE_URL.replace(/\/$/, "")}/api/embed`;
  const vectors: number[][] = [];
  for (let i = 0; i < texts.length; i += OLLAMA_EMBED_BATCH_SIZE) {
    const batch = texts.slice(i, i + OLLAMA_EMBED_BATCH_SIZE);
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: OLLAMA_EMBED_MODEL, input: batch }),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Ollama embedding request failed (${response.status}): ${body || response.statusText}`);
    }
    const payload = await response.json() as { embeddings?: unknown };
    if (!Array.isArray(payload.embeddings)) {
      throw new Error("Ollama embedding response did not include embeddings array");
    }
    for (const vector of payload.embeddings) {
      if (!Array.isArray(vector) || !vector.every((value) => typeof value === "number")) {
        throw new Error("Ollama embedding response included an invalid vector");
      }
      vectors.push(normalizeVector(vector as number[]));
    }
  }
  if (vectors.length !== texts.length) {
    throw new Error(`Ollama returned ${vectors.length} embeddings for ${texts.length} texts`);
  }
  return vectors;
}

function parseJsonl(content: string): JsonRecord[] {
  const entries: JsonRecord[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (isRecord(parsed)) entries.push(parsed);
    } catch {
      // Ignore malformed session tail/lines.
    }
  }
  return entries;
}

function chunkText(text: string): string[] {
  const normalized = normalizeText(text);
  if (!normalized) return [];
  return [normalized.slice(0, MAX_TEXT_CHARS)];
}

function detectAgentFromSessionPath(sessionFile: string): string {
  const rel = relative(AGENTS_ROOT, sessionFile);
  if (!rel.startsWith("..")) return rel.split(/[\\/]/)[0] || "unknown";
  return "pi";
}

function currentAgentFromCwd(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined;
  const rel = relative(AGENTS_ROOT, cwd);
  if (rel.startsWith("..")) return undefined;
  const name = rel.split(/[\\/]/)[0];
  return name && existsSync(join(AGENTS_ROOT, name, "manifest.json")) ? name : undefined;
}

function entryToTexts(entry: JsonRecord): Array<{ role: string; entryType: string; text: string; tools: string[]; provider: string; model: string; inputTokens: number; outputTokens: number; costTotal: number; isError: boolean }> {
  const type = asString(entry.type, "unknown");
  if (type === "session") return [];

  if (type === "message" && isRecord(entry.message)) {
    const message = entry.message;
    const role = asString(message.role, "message");
    const rawText = textContent(message.content);
    const isError = message.stopReason === "error" || message.isError === true;
    if (role === "toolResult" && !isError) {
      return [];
    }
    if (role === "assistant" && message.stopReason !== "stop" && !isError) {
      return [];
    }
    const text = role === "toolResult" && rawText.length > MAX_TOOL_RESULT_INDEX_CHARS
      ? `${rawText.slice(0, MAX_TOOL_RESULT_INDEX_CHARS)}\n\n[tool result truncated for recall index]`
      : rawText;
    const tools: string[] = [];
    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (isRecord(block) && block.type === "toolCall" && typeof block.name === "string") tools.push(block.name);
      }
    }
    if (role === "toolResult" && typeof message.toolName === "string") tools.push(message.toolName);
    const usage = isRecord(message.usage) ? message.usage : {};
    const cost = isRecord(usage.cost) ? usage.cost : {};
    return [{
      role,
      entryType: type,
      text,
      tools,
      provider: asString(message.provider),
      model: asString(message.model),
      inputTokens: asNumber(usage.input),
      outputTokens: asNumber(usage.output),
      costTotal: asNumber(cost.total),
      isError,
    }];
  }

  if (type === "custom_message") {
    return [{ role: "custom", entryType: type, text: textContent(entry.content), tools: [], provider: "", model: "", inputTokens: 0, outputTokens: 0, costTotal: 0, isError: false }];
  }

  if (type === "compaction") {
    return [{ role: "summary", entryType: type, text: asString(entry.summary), tools: [], provider: "", model: "", inputTokens: 0, outputTokens: 0, costTotal: 0, isError: false }];
  }

  if (type === "branch_summary") {
    return [{ role: "summary", entryType: type, text: asString(entry.summary), tools: [], provider: "", model: "", inputTokens: 0, outputTokens: 0, costTotal: 0, isError: false }];
  }

  if (type === "bashExecution") {
    const command = asString(entry.command);
    const output = asString(entry.output).slice(0, MAX_OUTPUT_PREVIEW_CHARS);
    const text = `Bash command:\n${command}\n\nOutput preview:\n${output}`;
    return [{ role: "bashExecution", entryType: type, text, tools: ["bash"], provider: "", model: "", inputTokens: 0, outputTokens: 0, costTotal: 0, isError: asNumber(entry.exitCode, 0) !== 0 }];
  }

  return [];
}

async function sessionFileToChunks(sessionFile: string, indexedAt: string): Promise<SessionChunk[]> {
  if (sessionFile.includes("/session/reflections/")) return [];
  if (!sessionFile.endsWith(".jsonl")) return [];
  const stats = statSync(sessionFile);
  const content = await readFile(sessionFile, "utf8");
  const entries = parseJsonl(content);
  const header = entries.find((entry) => entry.type === "session");
  const sessionId = asString(header?.id, basename(sessionFile, ".jsonl"));
  const cwd = asString(header?.cwd);
  const agent = detectAgentFromSessionPath(sessionFile);
  let sessionName = "";
  for (const entry of entries) {
    if (entry.type === "session_info") sessionName = asString(entry.name).trim();
  }

  const result: SessionChunk[] = [];
  for (const entry of entries) {
    const entryId = asString(entry.id);
    if (!entryId) continue;
    const parentId = entry.parentId === null ? "" : asString(entry.parentId);
    const timestamp = asString(entry.timestamp, asString(header?.timestamp, new Date(stats.mtimeMs).toISOString()));
    for (const item of entryToTexts(entry)) {
      const pieces = chunkText(item.text);
      for (let i = 0; i < pieces.length; i++) {
        const text = pieces[i];
        const paths = extractPaths(text);
        const language = inferLanguage(text, paths);
        const textHash = sha256(text);
        const chunkId = sha256(`${sessionFile}\0${entryId}\0${i}\0${textHash}`);
        result.push({
          chunkId,
          source: "pi-session",
          agent,
          sessionId,
          sessionFile,
          sessionRelPath: sessionFile.startsWith(HOME) ? `~${sessionFile.slice(HOME.length)}` : sessionFile,
          entryId,
          parentId,
          chunkIndex: i,
          role: item.role,
          entryType: item.entryType,
          timestamp,
          cwd,
          sessionName,
          text,
          snippet: text.slice(0, 700),
          textHash,
          contentKind: contentKind(item.entryType, item.role, text, item.isError),
          language,
          pathsJson: JSON.stringify(paths),
          toolsJson: JSON.stringify(item.tools),
          provider: item.provider,
          model: item.model,
          inputTokens: item.inputTokens,
          outputTokens: item.outputTokens,
          costTotal: item.costTotal,
          isError: item.isError,
          embeddingModel: EMBEDDING_MODEL,
          chunkerVersion: CHUNKER_VERSION,
          indexedAt,
          sourceMtime: stats.mtime.toISOString(),
          sourceSize: stats.size,
          includeInRecall: true,
          sensitivity: "normal",
          vector: ZERO_VECTOR,
        });
      }
    }
  }
  return result;
}

async function walk(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const results: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === ".snapshots" || entry.name === "reflections") continue;
      results.push(...await walk(full));
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      results.push(full);
    }
  }
  return results;
}

async function discoverSessionFiles(options: { agent?: string; maxFiles?: number } = {}): Promise<string[]> {
  const files: string[] = [];
  if (existsSync(AGENTS_ROOT)) {
    for (const dirent of await readdir(AGENTS_ROOT, { withFileTypes: true })) {
      if (!dirent.isDirectory() || dirent.name.startsWith(".")) continue;
      if (options.agent && dirent.name !== options.agent) continue;
      const sessionDir = join(AGENTS_ROOT, dirent.name, "session");
      files.push(...await walk(sessionDir));
    }
  }
  if (!options.agent || options.agent === "pi") {
    files.push(...await walk(join(ROOT_AGENT_DIR, "sessions")));
  }
  const unique = [...new Set(files)].sort();
  return typeof options.maxFiles === "number" ? unique.slice(0, options.maxFiles) : unique;
}

async function openDb() {
  await mkdir(DB_PATH, { recursive: true });
  return lancedb.connect(DB_PATH);
}

async function readState(): Promise<IndexState | undefined> {
  try {
    return JSON.parse(await readFile(STATE_PATH, "utf8")) as IndexState;
  } catch {
    return undefined;
  }
}

async function writeState(state: IndexState) {
  await mkdir(dirname(STATE_PATH), { recursive: true });
  await writeFile(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function updateStateFromTable(updatedAt: string, filesScanned: number): Promise<IndexState> {
  const db = await openDb();
  let chunksIndexed = 0;
  try {
    if ((await db.tableNames()).includes(TABLE_NAME)) {
      const table = await db.openTable(TABLE_NAME);
      chunksIndexed = await table.countRows();
    }
  } catch {
    chunksIndexed = 0;
  }
  const state: IndexState = {
    updatedAt,
    tableName: TABLE_NAME,
    dbPath: DB_PATH,
    embeddingModel: EMBEDDING_MODEL,
    chunkerVersion: CHUNKER_VERSION,
    filesScanned,
    chunksIndexed,
  };
  await writeState(state);
  return state;
}

async function addChunks(chunks: SessionChunk[]): Promise<number> {
  if (chunks.length === 0) return 0;
  const vectors = await embedTexts(chunks.map((chunk) => chunk.text));
  for (let i = 0; i < chunks.length; i++) chunks[i].vector = vectors[i];
  const db = await openDb();
  if ((await db.tableNames()).includes(TABLE_NAME)) {
    const table = await db.openTable(TABLE_NAME);
    await table.add(chunks);
  } else {
    await db.createTable(TABLE_NAME, chunks, { mode: "overwrite" });
  }
  return chunks.length;
}

async function incrementalIndexSessionFile(sessionFile: string): Promise<{ added: number; total: number; sessionFile: string }> {
  const indexedAt = new Date().toISOString();
  const chunks = await sessionFileToChunks(sessionFile, indexedAt);
  const db = await openDb();
  const existingIds = new Set<string>();
  if ((await db.tableNames()).includes(TABLE_NAME)) {
    const table = await db.openTable(TABLE_NAME);
    const rows = await table.query()
      .where(`sessionFile = '${escapeSqlString(sessionFile)}'`)
      .limit(200_000)
      .toArray() as Array<{ chunkId?: string }>;
    for (const row of rows) if (row.chunkId) existingIds.add(String(row.chunkId));
  }
  const fresh = chunks.filter((chunk) => !existingIds.has(chunk.chunkId));
  const added = await addChunks(fresh);
  await updateStateFromTable(indexedAt, 1);
  return { added, total: chunks.length, sessionFile };
}

let liveIndexQueue: Promise<unknown> = Promise.resolve();
let liveIndexTimer: NodeJS.Timeout | undefined;

function queueLiveIndex(sessionFile: string | undefined, ui?: { setStatus?: (key: string, value: string) => void }) {
  if (!sessionFile || process.env.PI_AGENT_REFLECTION || process.env.PI_AGENT_EPHEMERAL_CLONE) return;
  if (detectAgentFromSessionPath(sessionFile) === "pi") return;
  if (liveIndexTimer) clearTimeout(liveIndexTimer);
  liveIndexTimer = setTimeout(() => {
    liveIndexQueue = liveIndexQueue
      .catch(() => undefined)
      .then(async () => {
        ui?.setStatus?.("session-index", "recall: indexing…");
        try {
          const result = await incrementalIndexSessionFile(sessionFile);
          ui?.setStatus?.("session-index", result.added > 0 ? `recall: +${result.added}` : "recall: current");
          setTimeout(() => ui?.setStatus?.("session-index", ""), 5_000).unref?.();
        } catch {
          ui?.setStatus?.("session-index", "recall: error");
          setTimeout(() => ui?.setStatus?.("session-index", ""), 8_000).unref?.();
        }
      });
  }, 1_000);
  liveIndexTimer.unref?.();
}

async function rebuildIndex(options: { agent?: string; maxFiles?: number } = {}): Promise<IndexState> {
  const indexedAt = new Date().toISOString();
  const sessionFiles = await discoverSessionFiles(options);
  const chunks: SessionChunk[] = [];
  for (const file of sessionFiles) {
    try {
      chunks.push(...await sessionFileToChunks(file, indexedAt));
    } catch {
      // Skip unreadable/corrupt sessions; JSONL remains canonical.
    }
  }
  if (chunks.length > 0) {
    const vectors = await embedTexts(chunks.map((chunk) => chunk.text));
    for (let i = 0; i < chunks.length; i++) chunks[i].vector = vectors[i];
  }
  const db = await openDb();
  const previous = await readState();
  const tableNames = await db.tableNames();
  const tableExists = tableNames.includes(TABLE_NAME);
  const canMerge = Boolean(options.agent) && tableExists && previous?.embeddingModel === EMBEDDING_MODEL;
  let chunksIndexed = chunks.length;
  if (chunks.length > 0) {
    if (canMerge) {
      const table = await db.openTable(TABLE_NAME);
      await table.delete(`agent = '${escapeSqlString(options.agent!)}'`);
      await table.add(chunks);
      chunksIndexed = await table.countRows();
    } else {
      await db.createTable(TABLE_NAME, chunks, { mode: "overwrite" });
    }
  } else if (!canMerge) {
    try { await db.dropTable(TABLE_NAME); } catch {}
  }
  const state: IndexState = {
    updatedAt: indexedAt,
    tableName: TABLE_NAME,
    dbPath: DB_PATH,
    embeddingModel: EMBEDDING_MODEL,
    chunkerVersion: CHUNKER_VERSION,
    filesScanned: sessionFiles.length,
    chunksIndexed,
  };
  await writeState(state);
  return state;
}

async function searchIndex(params: { query: string; agent?: string; cwd?: string; since?: string; until?: string; limit?: number }) {
  const db = await openDb();
  const table = await db.openTable(TABLE_NAME);
  const clauses: string[] = ["includeInRecall = true"];
  if (params.agent) clauses.push(`agent = '${escapeSqlString(params.agent)}'`);
  if (params.cwd) clauses.push(`cwd = '${escapeSqlString(params.cwd)}'`);
  if (params.since) clauses.push(`timestamp >= '${escapeSqlString(params.since)}'`);
  if (params.until) clauses.push(`timestamp <= '${escapeSqlString(params.until)}'`);
  const limit = Math.max(1, Math.min(50, params.limit ?? 8));
  const [queryVector] = await embedTexts([params.query]);
  let query = table.vectorSearch(queryVector);
  if (clauses.length > 0) query = query.where(clauses.join(" AND "));
  return query.limit(limit).toArray() as Promise<Array<SessionChunk & { _distance?: number }>>;
}

function formatState(state: IndexState | undefined): string {
  if (!state) return "Session index has not been built yet. Use session_index_update first.";
  return [
    `Session index: ${state.chunksIndexed} chunks from ${state.filesScanned} files`,
    `Updated: ${state.updatedAt}`,
    `DB: ${state.dbPath}`,
    `Table: ${state.tableName}`,
    `Embedding: ${state.embeddingModel}`,
    `Chunker: ${state.chunkerVersion}`,
  ].join("\n");
}

type SearchHit = {
  chunkId: string;
  agent: string;
  timestamp: string;
  role: string;
  contentKind: string;
  sessionRelPath: string;
  sessionFile: string;
  entryId: string;
  snippet: string;
  distance?: number;
};

function toSearchHits(rows: Array<SessionChunk & { _distance?: number }>): SearchHit[] {
  return rows.map((row) => ({
    chunkId: String(row.chunkId ?? ""),
    agent: String(row.agent ?? ""),
    timestamp: String(row.timestamp ?? ""),
    role: String(row.role ?? ""),
    contentKind: String(row.contentKind ?? ""),
    sessionRelPath: String(row.sessionRelPath ?? ""),
    sessionFile: String(row.sessionFile ?? ""),
    entryId: String(row.entryId ?? ""),
    snippet: String(row.snippet ?? ""),
    distance: typeof row._distance === "number" ? row._distance : undefined,
  }));
}

function formatHits(hits: SearchHit[]): string {
  if (hits.length === 0) return "No session recall hits.";
  return hits.map((hit, index) => {
    const score = typeof hit.distance === "number" ? ` distance=${hit.distance.toFixed(4)}` : "";
    const where = `${hit.agent} · ${hit.timestamp} · ${hit.role}/${hit.contentKind}${score}`;
    const source = `${hit.sessionRelPath}#${hit.entryId}`;
    return `${index + 1}. ${where}\n   ${source}\n   ${hit.snippet}`;
  }).join("\n\n");
}

function resolveSessionFile(input: string): string {
  const expanded = input.startsWith("~/") ? join(HOME, input.slice(2)) : input;
  const allowed = [AGENTS_ROOT, join(ROOT_AGENT_DIR, "sessions")];
  if (!allowed.some((root) => {
    const rel = relative(root, expanded);
    return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"));
  })) {
    throw new Error("sessionFile must be under ~/.pi/agents or ~/.pi/agent/sessions");
  }
  if (!expanded.endsWith(".jsonl")) throw new Error("sessionFile must be a JSONL session file");
  return expanded;
}

function contextTextForEntry(entry: JsonRecord): { role: string; kind: string; text: string } {
  const type = asString(entry.type, "unknown");
  if (type === "message" && isRecord(entry.message)) {
    const message = entry.message;
    const role = asString(message.role, "message");
    const text = textContent(message.content);
    return { role, kind: contentKind(type, role, text, message.stopReason === "error" || message.isError === true), text };
  }
  const texts = entryToTexts(entry);
  if (texts.length > 0) {
    const first = texts[0];
    return { role: first.role, kind: contentKind(first.entryType, first.role, first.text, first.isError), text: first.text };
  }
  return { role: type, kind: type, text: "" };
}

async function readSessionContext(params: { sessionFile: string; entryId: string; before?: number; after?: number }) {
  const sessionFile = resolveSessionFile(params.sessionFile);
  const entries = parseJsonl(await readFile(sessionFile, "utf8"));
  const targetIndex = entries.findIndex((entry) => asString(entry.id) === params.entryId);
  if (targetIndex < 0) throw new Error(`entryId not found: ${params.entryId}`);
  const before = Math.max(0, Math.min(20, params.before ?? 4));
  const after = Math.max(0, Math.min(20, params.after ?? 4));
  const start = Math.max(0, targetIndex - before);
  const end = Math.min(entries.length, targetIndex + after + 1);
  const context = entries.slice(start, end).map((entry, offset) => {
    const absoluteIndex = start + offset;
    const { role, kind, text } = contextTextForEntry(entry);
    return {
      marker: absoluteIndex === targetIndex ? "target" : absoluteIndex < targetIndex ? "before" : "after",
      index: absoluteIndex,
      entryId: asString(entry.id),
      parentId: entry.parentId === null ? "" : asString(entry.parentId),
      timestamp: asString(entry.timestamp),
      type: asString(entry.type, "unknown"),
      role,
      kind,
      text: normalizeText(text).slice(0, asString(entry.type) === "message" && role === "toolResult" ? 800 : MAX_TEXT_CHARS),
    };
  });
  return { sessionFile, entryId: params.entryId, targetIndex, start, end: end - 1, context };
}

function formatSessionContext(result: Awaited<ReturnType<typeof readSessionContext>>): string {
  return result.context.map((entry) => {
    const prefix = entry.marker === "target" ? "=>" : entry.marker === "before" ? "  " : "  ";
    return `${prefix} [${entry.index}] ${entry.timestamp} ${entry.role}/${entry.kind} ${entry.entryId}\n${entry.text}`;
  }).join("\n\n");
}

export default function sessionIndexExtension(pi: ExtensionAPI) {
  pi.on("agent_end", async (_event, ctx) => {
    queueLiveIndex(ctx.sessionManager.getSessionFile(), ctx.ui);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (!sessionFile || process.env.PI_AGENT_REFLECTION || process.env.PI_AGENT_EPHEMERAL_CLONE) return;
    if (detectAgentFromSessionPath(sessionFile) === "pi") return;
    await liveIndexQueue.catch(() => undefined);
    await incrementalIndexSessionFile(sessionFile).catch(() => undefined);
  });

  pi.registerTool({
    name: "session_index_current",
    label: "Index Current Session",
    description: "Incrementally index new chunks from the current Pi session JSONL into the local LanceDB recall index.",
    promptSnippet: "Index new messages from the current Pi session into session recall.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const sessionFile = ctx?.sessionManager?.getSessionFile?.();
      if (!sessionFile) return { content: [{ type: "text", text: "No current session file available." }], details: { error: "missing_session_file" }, isError: true };
      try {
        const result = await incrementalIndexSessionFile(sessionFile);
        return { content: [{ type: "text", text: `Indexed current session: added ${result.added} new chunks (${result.total} total candidate chunks).` }], details: result };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `Current session indexing failed: ${message}` }], details: { error: message }, isError: true };
      }
    },
  });

  pi.registerTool({
    name: "session_index_update",
    label: "Update Session Recall Index",
    description: "Update the local LanceDB sidecar index from Pi JSONL session history. Defaults to the current named agent; pass an agent to update another agent. Use before session_search if the index is stale or missing.",
    promptSnippet: "Update the local Pi session recall index, preferably scoped to the relevant agent.",
    parameters: Type.Object({
      agent: Type.Optional(Type.String({ description: "Optional named agent to index, e.g. bartimaeus. Omit for all agents." })),
      maxFiles: Type.Optional(Type.Number({ description: "Optional maximum number of session files to index, mainly for smoke tests." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const requestedAgent = typeof params.agent === "string" ? params.agent : undefined;
      const defaultAgent = currentAgentFromCwd(ctx?.cwd);
      const state = await rebuildIndex({
        agent: requestedAgent ?? defaultAgent,
        maxFiles: typeof params.maxFiles === "number" ? params.maxFiles : undefined,
      });
      return { content: [{ type: "text", text: formatState(state) }], details: state };
    },
  });

  pi.registerTool({
    name: "session_index_status",
    label: "Session Recall Index Status",
    description: "Show status for the local LanceDB Pi session recall index.",
    promptSnippet: "Show Pi session recall index status.",
    parameters: Type.Object({}),
    async execute() {
      const state = await readState();
      const lines = [formatState(state)];
      const details: JsonRecord = { ...(state ?? {}) };
      try {
        const db = await openDb();
        if ((await db.tableNames()).includes(TABLE_NAME)) {
          const table = await db.openTable(TABLE_NAME);
          const rows = await table.query().limit(200_000).toArray() as Array<{ agent?: string }>;
          const counts: Record<string, number> = {};
          for (const row of rows) counts[String(row.agent ?? "unknown")] = (counts[String(row.agent ?? "unknown")] ?? 0) + 1;
          lines.push(`Actual table rows: ${rows.length}`);
          lines.push(`By agent: ${Object.entries(counts).sort().map(([agent, count]) => `${agent}:${count}`).join(", ")}`);
          details.actualRows = rows.length;
          details.countsByAgent = counts;
        }
      } catch (error) {
        lines.push(`Actual table rows: unavailable (${error instanceof Error ? error.message : String(error)})`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }], details };
    },
  });

  pi.registerTool({
    name: "session_context",
    label: "Read Session Context",
    description: "Read nearby messages around a session_search hit from canonical JSONL, using sessionFile and entryId. Use to verify chronology and recover before/after conversation context.",
    promptSnippet: "Read nearby canonical Pi JSONL session messages around a recalled hit.",
    parameters: Type.Object({
      sessionFile: Type.String({ description: "Absolute session JSONL path, or ~/... path returned by session_search details." }),
      entryId: Type.String({ description: "Entry ID from a session_search hit." }),
      before: Type.Optional(Type.Number({ description: "Number of preceding entries to include, default 4, max 20." })),
      after: Type.Optional(Type.Number({ description: "Number of following entries to include, default 4, max 20." })),
    }),
    async execute(_toolCallId, params) {
      try {
        const result = await readSessionContext({
          sessionFile: String(params.sessionFile ?? ""),
          entryId: String(params.entryId ?? ""),
          before: typeof params.before === "number" ? params.before : undefined,
          after: typeof params.after === "number" ? params.after : undefined,
        });
        return { content: [{ type: "text", text: formatSessionContext(result) }], details: result };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `Session context read failed: ${message}` }], details: { error: message }, isError: true };
      }
    },
  });

  pi.registerTool({
    name: "session_search",
    label: "Search Pi Session Recall",
    description: "Search the local LanceDB sidecar index of Pi session history. Returns compact source pointers and snippets; verify important details against the source session if needed.",
    promptSnippet: "Search prior Pi session history for relevant decisions, conversations, bugs, rationale, and agent/project context.",
    parameters: Type.Object({
      query: Type.String({ description: "Natural-language or keyword query." }),
      agent: Type.Optional(Type.String({ description: "Optional named agent filter, e.g. bartimaeus, louise, rocky, pi." })),
      cwd: Type.Optional(Type.String({ description: "Optional exact cwd/project filter." })),
      since: Type.Optional(Type.String({ description: "Optional ISO timestamp lower bound." })),
      until: Type.Optional(Type.String({ description: "Optional ISO timestamp upper bound." })),
      limit: Type.Optional(Type.Number({ description: "Maximum hits to return, default 8, max 50." })),
    }),
    async execute(_toolCallId, params) {
      const query = String(params.query ?? "").trim();
      if (!query) return { content: [{ type: "text", text: "Query is required." }], details: { error: "missing_query" }, isError: true };
      try {
        const rows = await searchIndex({
          query,
          agent: typeof params.agent === "string" ? params.agent : undefined,
          cwd: typeof params.cwd === "string" ? params.cwd : undefined,
          since: typeof params.since === "string" ? params.since : undefined,
          until: typeof params.until === "string" ? params.until : undefined,
          limit: typeof params.limit === "number" ? params.limit : undefined,
        });
        const hits = toSearchHits(rows);
        return { content: [{ type: "text", text: formatHits(hits) }], details: { count: hits.length, hits } };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `Session index search failed: ${message}. Try session_index_update first.` }], details: { error: message }, isError: true };
      }
    },
  });
}

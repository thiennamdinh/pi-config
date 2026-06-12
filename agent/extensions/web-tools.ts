import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { spawnSync } from "node:child_process";
import { Type } from "typebox";

type BraveWebResult = {
  title?: string;
  url?: string;
  description?: string;
  age?: string;
  language?: string;
  family_friendly?: boolean;
};

const PROFILE_FILES = ["~/.profile", "~/.bash_profile", "~/.bashrc"];

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function refreshProfileEnvVar(name: string) {
  const sourceCommands = PROFILE_FILES.map((file) => `f=${shellQuote(file)}; f=\${f/#~/$HOME}; [ -r "$f" ] && . "$f" >/dev/null 2>/dev/null || true`).join("; ");
  const marker = `__PI_WEB_ENV_${process.pid}_${Date.now()}__`;
  const script = `${sourceCommands}; printf '${marker}\\0'; env -0`;
  const result = spawnSync("bash", ["-lc", script], {
    encoding: "buffer",
    env: { ...process.env },
    maxBuffer: 2 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) return process.env[name];

  const markerBuffer = Buffer.from(`${marker}\0`);
  const start = result.stdout.indexOf(markerBuffer);
  if (start < 0) return process.env[name];
  const envBytes = result.stdout.subarray(start + markerBuffer.length);
  for (const entry of envBytes.toString("utf8").split("\0")) {
    if (!entry.startsWith(`${name}=`)) continue;
    const value = entry.slice(name.length + 1);
    if (value) process.env[name] = value;
    return value || process.env[name];
  }
  return process.env[name];
}

function htmlToText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<\/h[1-6]>/gi, "\n\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+\n/g, "\n")
    .replace(/\n\s+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description: "Search the web using the Brave Search API and return ranked results.",
    promptSnippet: "Search the web using Brave Search.",
    promptGuidelines: [
      "Use web_search when the user asks for current information, recent facts, or web research.",
      "Use web_search to find sources first, then use web_fetch or bash/curl if you need to inspect a specific page.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Search query." }),
      count: Type.Optional(Type.Number({ description: "Number of results to return, default 5, max 20." })),
      freshness: Type.Optional(StringEnum(["pd", "pw", "pm", "py"] as const)),
    }),

    async execute(_toolCallId, params, signal) {
      const apiKey = refreshProfileEnvVar("BRAVE_SEARCH_API_KEY_PI");
      if (!apiKey) {
        throw new Error("BRAVE_SEARCH_API_KEY_PI is not set in the pi process environment or shell profile.");
      }

      const count = Math.max(1, Math.min(20, Math.floor(params.count ?? 5)));
      const url = new URL("https://api.search.brave.com/res/v1/web/search");
      url.searchParams.set("q", params.query);
      url.searchParams.set("count", String(count));
      if (params.freshness) url.searchParams.set("freshness", params.freshness);

      const response = await fetch(url, {
        signal,
        headers: {
          Accept: "application/json",
          "X-Subscription-Token": apiKey,
        },
      });

      if (!response.ok) {
        throw new Error(`Brave Search failed: ${response.status} ${response.statusText}\n${await response.text()}`);
      }

      const data = (await response.json()) as { web?: { results?: BraveWebResult[] } };
      const results = (data.web?.results ?? []).slice(0, count).map((result, index) => ({
        rank: index + 1,
        title: result.title ?? "",
        url: result.url ?? "",
        description: result.description ?? "",
        age: result.age,
        language: result.language,
        familyFriendly: result.family_friendly,
      }));

      return {
        content: [
          {
            type: "text",
            text: results.length
              ? results.map((r) => `${r.rank}. ${r.title}\n${r.url}\n${r.description}`).join("\n\n")
              : "No Brave Search results found.",
          },
        ],
        details: { query: params.query, results },
      };
    },
  });

  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description: "Fetch a web page or URL and return status, final URL, content type, and text content.",
    promptSnippet: "Fetch a URL and return readable page text or raw response text.",
    promptGuidelines: [
      "Use web_fetch to inspect specific URLs found by web_search or supplied by the user.",
      "Use web_fetch instead of bash/curl for normal web page reads unless you need curl-specific debugging.",
    ],
    parameters: Type.Object({
      url: Type.String({ description: "HTTP or HTTPS URL to fetch." }),
      maxChars: Type.Optional(Type.Number({ description: "Maximum characters to return, default 40000, max 100000." })),
      raw: Type.Optional(Type.Boolean({ description: "Return raw response body instead of converting HTML to text." })),
    }),

    async execute(_toolCallId, params, signal) {
      let parsed: URL;
      try {
        parsed = new URL(params.url);
      } catch {
        throw new Error(`Invalid URL: ${params.url}`);
      }

      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error(`Unsupported URL protocol: ${parsed.protocol}. Only http and https are allowed.`);
      }

      const maxChars = Math.max(1000, Math.min(100000, Math.floor(params.maxChars ?? 40000)));
      const response = await fetch(parsed, {
        signal,
        redirect: "follow",
        headers: {
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,application/json;q=0.8,*/*;q=0.5",
          "User-Agent": "pi-coding-agent-web-fetch/1.0",
        },
      });

      const contentType = response.headers.get("content-type") ?? "";
      const body = await response.text();
      const isHtml = /\bhtml\b/i.test(contentType) || /^\s*<!doctype html/i.test(body) || /^\s*<html[\s>]/i.test(body);
      const text = !params.raw && isHtml ? htmlToText(body) : body;
      const truncated = text.length > maxChars;
      const output = text.slice(0, maxChars);

      return {
        content: [
          {
            type: "text",
            text: [
              `URL: ${params.url}`,
              `Final URL: ${response.url}`,
              `Status: ${response.status} ${response.statusText}`,
              `Content-Type: ${contentType || "unknown"}`,
              `Returned: ${output.length} chars${truncated ? ` (truncated from ${text.length})` : ""}`,
              "",
              output,
            ].join("\n"),
          },
        ],
        details: {
          url: params.url,
          finalUrl: response.url,
          status: response.status,
          statusText: response.statusText,
          contentType,
          truncated,
          returnedChars: output.length,
          totalChars: text.length,
        },
      };
    },
  });
}

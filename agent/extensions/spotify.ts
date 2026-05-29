import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";

const TOKEN_PATH = `${process.env.HOME ?? "."}/.pi/agent/spotify-token.json`;
const MUSIC_MEMORY_PATH = `${process.env.HOME ?? "."}/.pi/agent/memory/music.md`;
const DEFAULT_REDIRECT_URI = "http://127.0.0.1:8888/callback";
const SCOPES = [
  "user-read-playback-state",
  "user-modify-playback-state",
  "user-read-currently-playing",
  "user-read-recently-played",
  "playlist-read-private",
  "playlist-read-collaborative",
  "user-library-read",
].join(" ");

type TokenFile = {
  access_token: string;
  refresh_token?: string;
  expires_at: number;
  scope?: string;
  token_type?: string;
};

type SpotifyItem = {
  name: string;
  uri: string;
  external_urls?: { spotify?: string };
  artists?: Array<{ name: string }>;
  owner?: { display_name?: string };
  description?: string;
};

function getClientConfig() {
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  const redirectUri = process.env.SPOTIFY_REDIRECT_URI ?? DEFAULT_REDIRECT_URI;
  if (!clientId || !clientSecret) {
    throw new Error("SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET must be set in the pi process environment.");
  }
  return { clientId, clientSecret, redirectUri };
}

function basicAuth(clientId: string, clientSecret: string) {
  return Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
}

async function readToken(): Promise<TokenFile | undefined> {
  if (!existsSync(TOKEN_PATH)) return undefined;
  return JSON.parse(await readFile(TOKEN_PATH, "utf8")) as TokenFile;
}

async function saveToken(token: TokenFile) {
  await mkdir(dirname(TOKEN_PATH), { recursive: true });
  await writeFile(TOKEN_PATH, JSON.stringify(token, null, 2), "utf8");
  await chmod(TOKEN_PATH, 0o600).catch(() => undefined);
}

async function exchangeCode(code: string): Promise<TokenFile> {
  const { clientId, clientSecret, redirectUri } = getClientConfig();
  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth(clientId, clientSecret)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri }),
  });
  if (!response.ok) throw new Error(`Spotify token exchange failed: ${response.status} ${await response.text()}`);
  const data = (await response.json()) as any;
  const token: TokenFile = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000 - 60_000,
    scope: data.scope,
    token_type: data.token_type,
  };
  await saveToken(token);
  return token;
}

async function getAccessToken(): Promise<string> {
  const envRefreshToken = process.env.SPOTIFY_REFRESH_TOKEN_PI ?? process.env.SPOTIFY_REFRESH_TOKEN;
  let token = await readToken();
  if (!token && envRefreshToken) {
    token = { access_token: "", refresh_token: envRefreshToken, expires_at: 0 };
  }
  if (!token?.refresh_token) {
    throw new Error("Spotify is not authorized. Run /spotify-auth-url, open the URL, then run /spotify-token <code> with the returned code.");
  }
  if (token.access_token && Date.now() < token.expires_at) return token.access_token;

  const { clientId, clientSecret } = getClientConfig();
  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth(clientId, clientSecret)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: token.refresh_token }),
  });
  if (!response.ok) throw new Error(`Spotify token refresh failed: ${response.status} ${await response.text()}`);
  const data = (await response.json()) as any;
  const next: TokenFile = {
    access_token: data.access_token,
    refresh_token: data.refresh_token ?? token.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000 - 60_000,
    scope: data.scope ?? token.scope,
    token_type: data.token_type ?? token.token_type,
  };
  await saveToken(next);
  return next.access_token;
}

async function spotifyApi(path: string, init: RequestInit = {}) {
  const accessToken = await getAccessToken();
  const response = await fetch(`https://api.spotify.com/v1${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (response.status === 204) return undefined;
  const text = await response.text();
  if (!response.ok) throw new Error(`Spotify API failed: ${response.status} ${response.statusText}\n${text}`);
  return text ? JSON.parse(text) : undefined;
}

function summarizeItem(item: SpotifyItem, index: number) {
  const by = item.artists?.length
    ? ` — ${item.artists.map((a) => a.name).join(", ")}`
    : item.owner?.display_name
      ? ` — by ${item.owner.display_name}`
      : "";
  return `${index + 1}. ${item.name}${by}\n${item.uri}\n${item.external_urls?.spotify ?? ""}${item.description ? `\n${item.description}` : ""}`;
}

async function searchSpotify(query: string, type: "track" | "album" | "artist" | "playlist", count: number) {
  const params = new URLSearchParams({ q: query, type, limit: String(Math.max(1, Math.min(10, count))) });
  const data = await spotifyApi(`/search?${params}`) as any;
  const key = `${type}s`;
  return (data?.[key]?.items ?? []).filter(Boolean) as SpotifyItem[];
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("spotify-auth-url", {
    description: "Print the Spotify authorization URL for first-time setup",
    handler: async (_args, ctx) => {
      const { clientId, redirectUri } = getClientConfig();
      const url = new URL("https://accounts.spotify.com/authorize");
      url.searchParams.set("client_id", clientId);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("scope", SCOPES);
      ctx.ui.notify(`Open this URL, approve, then copy the code from the redirect URL:\n${url.toString()}`, "info");
    },
  });

  pi.registerCommand("spotify-token", {
    description: "Exchange a Spotify authorization code for a saved refresh token",
    handler: async (args, ctx) => {
      const code = args.trim();
      if (!code) {
        ctx.ui.notify("Usage: /spotify-token <code>", "error");
        return;
      }
      await exchangeCode(code);
      ctx.ui.notify(`Spotify token saved to ${TOKEN_PATH}`, "info");
    },
  });

  pi.registerTool({
    name: "spotify_auth_status",
    label: "Spotify Auth Status",
    description: "Check whether Spotify credentials and user authorization are available.",
    promptSnippet: "Check Spotify authorization status.",
    parameters: Type.Object({}),
    async execute() {
      const hasClient = Boolean(process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET);
      const token = await readToken();
      const hasRefreshToken = Boolean(token?.refresh_token || process.env.SPOTIFY_REFRESH_TOKEN_PI || process.env.SPOTIFY_REFRESH_TOKEN);
      return {
        content: [{ type: "text", text: `Spotify client credentials: ${hasClient ? "yes" : "no"}\nSpotify user refresh token: ${hasRefreshToken ? "yes" : "no"}\nToken file: ${TOKEN_PATH}` }],
        details: { hasClient, hasRefreshToken, tokenPath: TOKEN_PATH },
      };
    },
  });

  pi.registerTool({
    name: "spotify_devices",
    label: "Spotify Devices",
    description: "List Spotify Connect playback devices for the current user.",
    promptSnippet: "List available Spotify playback devices.",
    parameters: Type.Object({}),
    async execute() {
      const data = await spotifyApi("/me/player/devices") as any;
      const devices = data.devices ?? [];
      return {
        content: [{ type: "text", text: devices.length ? devices.map((d: any) => `${d.name} (${d.type}) id=${d.id} active=${d.is_active}`).join("\n") : "No Spotify devices found. Open Spotify on a device first." }],
        details: { devices },
      };
    },
  });

  pi.registerTool({
    name: "spotify_search",
    label: "Spotify Search",
    description: "Search Spotify for tracks, albums, artists, or playlists.",
    promptSnippet: "Search Spotify for tracks, albums, artists, or playlists.",
    promptGuidelines: [
      "Use spotify_search to resolve exact songs, artists, albums, and playlists before calling spotify_play or spotify_queue.",
      "For open-ended music requests, consider reading music memory and using web_search for context before searching Spotify.",
    ],
    parameters: Type.Object({
      query: Type.String(),
      type: Type.Optional(StringEnum(["track", "album", "artist", "playlist"] as const)),
      count: Type.Optional(Type.Number()),
    }),
    async execute(_id, params) {
      const type = params.type ?? "track";
      const count = Math.max(1, Math.min(10, Math.floor(params.count ?? 5)));
      const items = await searchSpotify(params.query, type, count);
      return {
        content: [{ type: "text", text: items.length ? items.map(summarizeItem).join("\n\n") : "No Spotify results found." }],
        details: { query: params.query, type, items },
      };
    },
  });

  pi.registerTool({
    name: "spotify_play",
    label: "Spotify Play",
    description: "Start Spotify playback for a Spotify URI or by searching a query.",
    promptSnippet: "Play music on Spotify by URI or search query.",
    promptGuidelines: [
      "Use spotify_play when the user asks to play music. For exact song requests, play a track. For mood/activity requests, a playlist is often better.",
      "If spotify_play reports no active device, ask the user to open Spotify or use spotify_devices to choose a device.",
    ],
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "Search query if uri is not provided." })),
      uri: Type.Optional(Type.String({ description: "Spotify URI to play." })),
      type: Type.Optional(StringEnum(["track", "album", "artist", "playlist"] as const)),
      deviceId: Type.Optional(Type.String()),
    }),
    async execute(_id, params) {
      let uri = params.uri;
      let selected: SpotifyItem | undefined;
      const type = params.type ?? "track";
      if (!uri) {
        if (!params.query) throw new Error("Provide either uri or query.");
        const items = await searchSpotify(params.query, type, 1);
        selected = items[0];
        uri = selected?.uri;
        if (!uri) throw new Error(`No Spotify ${type} found for query: ${params.query}`);
      }

      const body = uri.startsWith("spotify:track:") ? { uris: [uri] } : { context_uri: uri };
      const qs = params.deviceId ? `?device_id=${encodeURIComponent(params.deviceId)}` : "";
      await spotifyApi(`/me/player/play${qs}`, { method: "PUT", body: JSON.stringify(body) });
      return {
        content: [{ type: "text", text: `Started Spotify playback: ${selected ? summarizeItem(selected, 0) : uri}` }],
        details: { uri, selected },
      };
    },
  });

  pi.registerTool({
    name: "spotify_pause",
    label: "Spotify Pause",
    description: "Pause Spotify playback for the current user.",
    promptSnippet: "Pause Spotify playback.",
    parameters: Type.Object({
      deviceId: Type.Optional(Type.String()),
    }),
    async execute(_id, params) {
      const qs = params.deviceId ? `?device_id=${encodeURIComponent(params.deviceId)}` : "";
      await spotifyApi(`/me/player/pause${qs}`, { method: "PUT" });
      return {
        content: [{ type: "text", text: "Paused Spotify playback." }],
        details: { deviceId: params.deviceId },
      };
    },
  });

  pi.registerTool({
    name: "spotify_queue",
    label: "Spotify Queue",
    description: "Add a Spotify track URI or searched track to the playback queue.",
    promptSnippet: "Queue a track on Spotify.",
    parameters: Type.Object({
      query: Type.Optional(Type.String()),
      uri: Type.Optional(Type.String()),
      deviceId: Type.Optional(Type.String()),
    }),
    async execute(_id, params) {
      let uri = params.uri;
      let selected: SpotifyItem | undefined;
      if (!uri) {
        if (!params.query) throw new Error("Provide either uri or query.");
        const items = await searchSpotify(params.query, "track", 1);
        selected = items[0];
        uri = selected?.uri;
        if (!uri) throw new Error(`No Spotify track found for query: ${params.query}`);
      }
      const qs = new URLSearchParams({ uri });
      if (params.deviceId) qs.set("device_id", params.deviceId);
      await spotifyApi(`/me/player/queue?${qs}`, { method: "POST" });
      return {
        content: [{ type: "text", text: `Queued: ${selected ? summarizeItem(selected, 0) : uri}` }],
        details: { uri, selected },
      };
    },
  });

  pi.registerTool({
    name: "music_memory_read",
    label: "Music Memory Read",
    description: "Read the user's durable music preference memory.",
    promptSnippet: "Read durable music preference memory.",
    parameters: Type.Object({}),
    async execute() {
      if (!existsSync(MUSIC_MEMORY_PATH)) {
        await mkdir(dirname(MUSIC_MEMORY_PATH), { recursive: true });
        await writeFile(MUSIC_MEMORY_PATH, "# Music Memory\n\n", "utf8");
      }
      const text = await readFile(MUSIC_MEMORY_PATH, "utf8");
      return { content: [{ type: "text", text }], details: { path: MUSIC_MEMORY_PATH } };
    },
  });

  pi.registerTool({
    name: "music_memory_update",
    label: "Music Memory Update",
    description: "Append concise, durable music preference notes to memory after user feedback.",
    promptSnippet: "Append durable music preference notes.",
    promptGuidelines: [
      "Use music_memory_update only when the user gives clear music preference feedback or explicitly asks you to remember something.",
      "Do not store sensitive information in music memory unless the user explicitly asks.",
    ],
    parameters: Type.Object({
      note: Type.String({ description: "Concise durable note to append, not a raw transcript." }),
    }),
    async execute(_id, params) {
      await mkdir(dirname(MUSIC_MEMORY_PATH), { recursive: true });
      if (!existsSync(MUSIC_MEMORY_PATH)) await writeFile(MUSIC_MEMORY_PATH, "# Music Memory\n\n", "utf8");
      const line = `- ${new Date().toISOString().slice(0, 10)}: ${params.note.trim()}\n`;
      const current = await readFile(MUSIC_MEMORY_PATH, "utf8");
      await writeFile(MUSIC_MEMORY_PATH, `${current.trimEnd()}\n${line}`, "utf8");
      return { content: [{ type: "text", text: `Updated ${MUSIC_MEMORY_PATH}: ${line.trim()}` }], details: { path: MUSIC_MEMORY_PATH, note: params.note } };
    },
  });
}

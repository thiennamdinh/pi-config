import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

function safeJson(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(
    value,
    (_key, val) => {
      if (typeof val === "bigint") return val.toString();
      if (typeof val === "function") return `[Function ${val.name || "anonymous"}]`;
      if (val && typeof val === "object") {
        if (seen.has(val)) return "[Circular]";
        seen.add(val);
      }
      return val;
    },
    2,
  );
}

export default function providerRequestCapture(pi: ExtensionAPI) {
  let armed = false;
  let lastPath: string | undefined;

  pi.registerCommand("capture-next-request", {
    description: "Save the next provider request payload as pretty JSON under ~/.pi/agent/tmp/provider-requests/.",
    handler: async (_args, ctx) => {
      armed = true;
      ctx.ui.notify("Will capture the next provider request payload.", "info");
    },
  });

  pi.registerCommand("last-provider-request-capture", {
    description: "Show the last provider request capture path from this Pi process.",
    handler: async (_args, ctx) => {
      ctx.ui.notify(lastPath ? `Last provider request capture: ${lastPath}` : "No provider request captured in this process.", lastPath ? "info" : "warning");
    },
  });

  pi.on("before_provider_request", async (event, ctx) => {
    if (!armed) return;
    armed = false;

    const dir = join(getAgentDir(), "tmp", "provider-requests");
    mkdirSync(dir, { recursive: true });

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const path = join(dir, `${stamp}.json`);
    const payload = {
      capturedAt: new Date().toISOString(),
      cwd: ctx.cwd,
      payload: event.payload,
    };

    writeFileSync(path, `${safeJson(payload)}\n`, "utf8");
    lastPath = path;
    ctx.ui.notify(`Saved provider request payload: ${path}`, "info");
  });
}

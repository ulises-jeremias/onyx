// Surfaces a first-class `request_app_setup` tool the agent calls to ask the
// user to connect an org external app it isn't set up for yet. It POSTs to the
// Onyx API (PAT injected by the egress proxy) to open a connect card, then
// SHORT-POLLS the request's status until the user connects/declines.
//
// Why short-poll instead of one long request: the egress tunnel between the
// sandbox and the api-server is not perfectly reliable, and a single request
// held open for the whole connect duration can be dropped mid-flight — which
// surfaced to the agent as a false "pending". Short polls are resilient: a
// transient hiccup just fails one poll and the next retries.
//
// Module resolution note: this file lives in /workspace/opencode-plugins, which
// has no node_modules, so a bare runtime `import` of the SDK can't resolve. We
// keep the type import erased and load the `tool` helper at runtime by absolute
// path from opencode's bundled SDK.

import type { Plugin } from "@opencode-ai/plugin";
import type { tool as ToolFactory } from "@opencode-ai/plugin/tool";

const SESSION_DIR_RE =
  /\/sessions\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})(?:\/|$)/;

// Per-request timeout (each create/poll is short) and overall connect window.
const REQUEST_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 4_000;
const OVERALL_DEADLINE_MS = 180_000;

const SDK_TOOL_PATHS = [
  "/home/sandbox/.opencode/node_modules/@opencode-ai/plugin/dist/tool.js",
  "/home/sandbox/.config/opencode/node_modules/@opencode-ai/plugin/dist/tool.js",
];

async function loadToolFactory(): Promise<typeof ToolFactory> {
  for (const path of SDK_TOOL_PATHS) {
    try {
      return (await import(path)).tool;
    } catch {
      continue;
    }
  }
  throw new Error("could not resolve the @opencode-ai/plugin tool helper");
}

function apiBase(): string | undefined {
  return process.env.ONYX_SERVER_URL?.replace(/\/+$/, "");
}

const PENDING_MSG =
  "The user hasn't finished connecting it yet. Tell them you'll continue once " +
  "it's connected, then stop — a later message will resume.";

// A short, individually-timed-out fetch. Returns null on any error/timeout so
// the caller can simply retry on the next poll.
async function shortFetch(
  url: string,
  init: RequestInit
): Promise<Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function statusMessage(app: string, status: string | undefined): string {
  switch (status) {
    case "connected":
      return `'${app}' is connected. You can use it now.`;
    case "declined":
      return `The user declined to connect '${app}'. Do not retry; offer an alternative.`;
    default:
      return PENDING_MSG;
  }
}

export const RequestAppSetup: Plugin = async ({ directory }) => {
  const sessionId = directory.match(SESSION_DIR_RE)?.[1];
  const tool = await loadToolFactory();

  return {
    tool: {
      request_app_setup: tool({
        description:
          "Ask the user to connect an org app you aren't set up to use yet. " +
          "Pass the app's slug (as listed under 'Connectable apps' in AGENTS.md). " +
          "Opens a connect prompt in the user's chat and waits for them to finish. " +
          "Returns 'connected' (proceed), 'declined' (do not retry; offer an " +
          "alternative), or 'pending' (they didn't finish in time — tell them " +
          "you'll continue once they connect it).",
        args: {
          app: tool.schema
            .string()
            .describe("Slug of the connectable app, e.g. 'slack'"),
          reason: tool.schema
            .string()
            .optional()
            .describe("One short sentence on why you need it, shown to the user"),
        },
        async execute(args) {
          const base = apiBase();
          const auth = `Bearer ${process.env.ONYX_PAT ?? ""}`;
          if (!base || !sessionId) {
            return "Could not request app setup: this session has no Onyx API binding.";
          }

          // 1. Open the connect card (returns immediately with a request_id).
          const createRes = await shortFetch(`${base}/build/setup-requests`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: auth },
            body: JSON.stringify({
              session_id: sessionId,
              app_slug: args.app,
              reason: args.reason,
            }),
          });
          if (createRes === null) {
            return `Could not reach the setup service for '${args.app}'. Ask the user to try again.`;
          }
          if (!createRes.ok) {
            return `Could not request setup for '${args.app}' (HTTP ${createRes.status}). It may not be an available app.`;
          }
          const created = (await createRes.json()) as {
            status?: string;
            request_id?: string | null;
          };
          if (created.status === "connected" || !created.request_id) {
            return statusMessage(args.app, created.status ?? "connected");
          }

          // 2. Short-poll the request's status until resolved or the window ends.
          const url = `${base}/build/setup-requests/${created.request_id}`;
          const deadline = Date.now() + OVERALL_DEADLINE_MS;
          while (Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
            const res = await shortFetch(url, {
              method: "GET",
              headers: { Authorization: auth },
            });
            if (res === null || !res.ok) continue; // transient — retry next poll
            const data = (await res.json()) as { status?: string };
            if (data.status === "connected" || data.status === "declined") {
              return statusMessage(args.app, data.status);
            }
          }
          return statusMessage(args.app, "pending");
        },
      }),
    },
  };
};

export default RequestAppSetup;

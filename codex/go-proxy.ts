#!/usr/bin/env bun
// Local OpenAI Responses proxy for Codex + OpenCode Go.
//
// Codex emits `function_call_output` items with no `call_id` (thread goals,
// automations, cross-thread messages). OpenAI's backend tolerates that, but the
// OpenCode Go gateway rejects the whole request with
//   input[4].call_id: expected a non-empty string
// This proxy fills in a stable synthetic call_id before forwarding upstream.
//
// Upstream: https://opencode.ai/inference/go/openai/v1
// Usage:    bun go-proxy.ts   (CODEX_GO_PROXY_PORT defaults to 8790)

const UPSTREAM = "https://opencode.ai/inference/go/openai/v1";
const PORT = Number(process.env.CODEX_GO_PROXY_PORT ?? 8790);
const AUTH_FILE = `${process.env.HOME}/.pi/agent/auth.json`;

function log(...args: unknown[]) {
  console.error(new Date().toISOString(), ...args);
}

let cachedKey: { key: string; at: number } | null = null;

async function apiKey(): Promise<string> {
  if (process.env.OPENCODE_API_KEY) return process.env.OPENCODE_API_KEY;
  if (cachedKey && Date.now() - cachedKey.at < 60_000) return cachedKey.key;
  const auth = (await Bun.file(AUTH_FILE).json()) as Record<string, { key?: string }>;
  const key = auth?.["opencode-go"]?.key;
  if (!key) throw new Error(`no opencode-go key in ${AUTH_FILE}`);
  cachedKey = { key, at: Date.now() };
  return key;
}

function syntheticCallId(item: Record<string, unknown>): string {
  const id = typeof item.id === "string" && item.id ? item.id : crypto.randomUUID();
  return `call_${id}`;
}

// Fill in call_id (and function-call ids) that strict Responses servers require.
function repairItem(item: unknown): unknown {
  if (!item || typeof item !== "object") return item;
  const entry = item as Record<string, unknown>;
  const hasCallId = typeof entry.call_id === "string" && entry.call_id.length > 0;
  const type = entry.type;

  if ((type === "function_call_output" || type === "custom_tool_call_output") && !hasCallId) {
    entry.call_id = syntheticCallId(entry);
    log("patched", type, "call_id", entry.call_id);
  }

  if (type === "function_call" || type === "custom_tool_call") {
    if (!hasCallId) entry.call_id = syntheticCallId(entry);
    if (typeof entry.id !== "string" || !entry.id) entry.id = `fc_${crypto.randomUUID()}`;
  }

  return entry;
}

function repairBody(text: string): string {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return text;
  }
  if (body && typeof body === "object" && Array.isArray((body as { input?: unknown }).input)) {
    const parsed = body as { input: unknown[] };
    parsed.input = parsed.input.map(repairItem);
  }
  return JSON.stringify(body);
}

Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/v1/")) {
      return new Response("not found", { status: 404 });
    }

    const target = `${UPSTREAM}${url.pathname.slice("/v1".length)}${url.search}`;
    const headers = new Headers(req.headers);
    headers.delete("host");
    headers.delete("content-length");
    headers.set("authorization", `Bearer ${await apiKey()}`);
    if (!headers.has("session_id") && !headers.has("x-opencode-session")) {
      headers.set("x-opencode-session", crypto.randomUUID());
    }

    let body: string | undefined;
    if (req.method !== "GET" && req.method !== "HEAD") {
      body = repairBody(await req.text());
    }

    const upstream = await fetch(target, { method: req.method, headers, body });
    const outHeaders = new Headers(upstream.headers);
    outHeaders.delete("content-encoding");
    outHeaders.delete("content-length");
    outHeaders.delete("transfer-encoding");
    return new Response(upstream.body, { status: upstream.status, headers: outHeaders });
  },
});

log(`codex opencode-go proxy listening on http://127.0.0.1:${PORT}/v1`);

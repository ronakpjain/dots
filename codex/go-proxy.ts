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

// Strict-upstream repair: fill in call_id, and for codex-injected context tool
// outputs that have no originating call, synthesise the matching call so the
// pair is valid for OpenAI-style validators too.
const OUTPUT_TYPES = new Set(["function_call_output", "custom_tool_call_output"]);

function repairItem(item: unknown): unknown {
  if (!item || typeof item !== "object") return item;
  const entry = item as Record<string, unknown>;
  const hasCallId = typeof entry.call_id === "string" && entry.call_id.length > 0;
  const type = entry.type;

  if ((type === "function_call" || type === "custom_tool_call") && !hasCallId) {
    entry.call_id = syntheticCallId(entry);
  }
  if ((type === "function_call" || type === "custom_tool_call") && (typeof entry.id !== "string" || !entry.id)) {
    entry.id = `fc_${crypto.randomUUID()}`;
  }
  if (OUTPUT_TYPES.has(String(type)) && !hasCallId) {
    entry.call_id = syntheticCallId(entry);
  }

  return entry;
}

function syntheticCallFor(output: Record<string, unknown>): Record<string, unknown> {
  const callId = output.call_id as string;
  const custom = output.type === "custom_tool_call_output";
  const call: Record<string, unknown> = custom
    ? { type: "custom_tool_call", call_id: callId, id: `ctc_${callId}`, name: output.name ?? "context" }
    : {
        type: "function_call",
        call_id: callId,
        id: `fc_${callId}`,
        name: output.name ?? "context",
        arguments: "{}",
      };
  if (custom) call.input = "";
  if (typeof output.namespace === "string" && output.namespace) call.namespace = output.namespace;
  return call;
}

function repairInput(input: unknown[]): unknown[] {
  const repaired: unknown[] = [];
  for (const raw of input) {
    const isOutput =
      raw && typeof raw === "object" && OUTPUT_TYPES.has(String((raw as Record<string, unknown>).type));
    const rawCallId = isOutput ? (raw as Record<string, unknown>).call_id : undefined;
    const needsSyntheticCall =
      isOutput && (typeof rawCallId !== "string" || rawCallId.length === 0);

    const item = repairItem(raw);
    if (needsSyntheticCall && item && typeof item === "object") {
      repaired.push(syntheticCallFor(item as Record<string, unknown>));
      log("synthesised call for", (item as Record<string, unknown>).type, (item as Record<string, unknown>).call_id);
    }
    repaired.push(item);
  }
  return repaired;
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
    parsed.input = repairInput(parsed.input);
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

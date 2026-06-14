import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DEFAULT_PORT = Number(process.env.PIFM_PORT ?? 11435);
const DEFAULT_BASE_URL = process.env.PIFM_BASE_URL ?? `http://127.0.0.1:${DEFAULT_PORT}/v1`;
const FM_BIN = process.env.PIFM_FM_BIN ?? "/usr/bin/fm";
const LOG_PATH = process.env.PIFM_LOG ?? join(homedir(), ".pi", "agent", "pifm-serve.log");
const SPAWN_TIMEOUT_MS = 10_000;

type FmModelEntry = {
  id: string;
  name?: string;
  context_window?: number;
  max_tokens?: number;
};

const FALLBACK_MODELS: FmModelEntry[] = [
  { id: "system", name: "On-device (system)" },
  { id: "pcc", name: "Private Cloud Compute (pcc)" },
];

function displayName(m: FmModelEntry): string {
  if (m.name) return m.name;
  if (m.id === "system") return "On-device (system)";
  if (m.id === "pcc") return "Private Cloud Compute (pcc)";
  return m.id;
}

async function probeHealth(): Promise<boolean> {
  try {
    const url = DEFAULT_BASE_URL.replace(/\/v1\/?$/, "") + "/health";
    const res = await fetch(url, { signal: AbortSignal.timeout(500) });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForHealth(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probeHealth()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

function spawnFmServe(): ChildProcess | undefined {
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true });
    const logFd = openSync(LOG_PATH, "a");
    const child = spawn(FM_BIN, ["serve", "--port", String(DEFAULT_PORT)], {
      stdio: ["ignore", logFd, logFd],
      detached: false,
    });
    child.on("error", (err) => {
      console.error(`[pifm] failed to spawn ${FM_BIN}: ${err.message}`);
    });
    return child;
  } catch (err) {
    console.error(`[pifm] could not spawn fm serve: ${(err as Error).message}`);
    return undefined;
  }
}

async function ensureFmRunning(state: { child?: ChildProcess }): Promise<boolean> {
  if (await probeHealth()) return true;
  if (state.child && !state.child.killed) {
    // We spawned one earlier but it isn't healthy — let it die and try again.
    state.child.kill();
    state.child = undefined;
  }
  const child = spawnFmServe();
  if (!child) return false;
  state.child = child;
  const ok = await waitForHealth(SPAWN_TIMEOUT_MS);
  if (!ok) {
    console.error(`[pifm] fm serve did not become healthy within ${SPAWN_TIMEOUT_MS}ms (see ${LOG_PATH})`);
  }
  return ok;
}

export default async function (pi: ExtensionAPI) {
  const state: { child?: ChildProcess } = {};

  await ensureFmRunning(state);

  let models: FmModelEntry[] = FALLBACK_MODELS;
  try {
    const res = await fetch(`${DEFAULT_BASE_URL}/models`);
    if (res.ok) {
      const payload = (await res.json()) as { data?: FmModelEntry[] };
      if (payload.data && payload.data.length > 0) {
        models = payload.data;
      }
    }
  } catch {
    // Keep fallback; provider still appears in /model.
  }

  const fmModelIds = new Set(models.map((m) => m.id));

  // fm serve's tool-schema parser rejects:
  //   - parameters of type "object" missing `properties` or `required`
  //   - any nested object beneath top-level `parameters` (including objects inside arrays)
  // Normalize the first; drop tools that hit the second so the model still gets
  // read/write/bash instead of failing the whole request.
  function containsNestedObject(node: unknown, depth = 0): boolean {
    if (!node || typeof node !== "object") return false;
    const n = node as Record<string, unknown>;
    if (depth > 0 && n.type === "object") return true;
    if (n.type === "array" && n.items) {
      if (containsNestedObject(n.items, depth + 1)) return true;
    }
    if (n.properties && typeof n.properties === "object") {
      for (const v of Object.values(n.properties as Record<string, unknown>)) {
        if (containsNestedObject(v, depth + 1)) return true;
      }
    }
    return false;
  }

  pi.on("before_provider_request", (event) => {
    const payload = event.payload as { model?: string; tools?: unknown } | undefined;
    if (!payload || typeof payload.model !== "string" || !fmModelIds.has(payload.model)) return;
    if (!Array.isArray(payload.tools)) return;

    const tools = payload.tools as Array<{
      function?: { name?: string; parameters?: Record<string, unknown> };
    }>;
    const dropped: string[] = [];
    const kept: typeof tools = [];

    for (const tool of tools) {
      const params = tool.function?.parameters;
      if (!params || params.type !== "object") {
        kept.push(tool);
        continue;
      }
      if (!("properties" in params)) params.properties = {};
      if (!("required" in params)) params.required = [];
      if (containsNestedObject(params, 0)) {
        dropped.push(tool.function?.name ?? "<anonymous>");
        continue;
      }
      kept.push(tool);
    }

    if (dropped.length > 0 && process.env.PIFM_DEBUG) {
      console.error(`[pifm] dropped tools (nested-object schemas): ${dropped.join(", ")}`);
    }

    if (dropped.length > 0 || tools.some((t) => t.function?.parameters)) {
      return { ...payload, tools: kept };
    }
  });

  pi.on("model_select", async (event) => {
    if (event.model?.provider !== "apple-fm") return;
    await ensureFmRunning(state);
  });

  pi.on("session_shutdown", () => {
    if (state.child && !state.child.killed) {
      state.child.kill();
      state.child = undefined;
    }
  });

  pi.registerProvider("apple-fm", {
    name: "Apple Foundation Models (fm)",
    baseUrl: DEFAULT_BASE_URL,
    apiKey: "unused",
    api: "openai-completions",
    models: models.map((m) => ({
      id: m.id,
      name: displayName(m),
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: m.context_window ?? 8192,
      maxTokens: m.max_tokens ?? 4096,
      compat: {
        maxTokensField: "max_tokens",
        supportsDeveloperRole: false,
      },
    })),
  });
}

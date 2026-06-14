import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DEFAULT_BASE_URL = process.env.PIFM_BASE_URL ?? "http://127.0.0.1:11435/v1";

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

export default async function (pi: ExtensionAPI) {
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
    // fm serve isn't running — keep fallback so /model still lists the provider.
  }

  const fmModelIds = new Set(models.map((m) => m.id));

  // fm serve's tool-schema parser rejects:
  //   - parameters of type "object" missing `properties` or `required`
  //   - any nested object beneath top-level `parameters` (including objects inside arrays)
  // We normalize the first and drop tools that hit the second so the model still gets
  // the simple read/write/bash tools instead of failing the whole request.
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

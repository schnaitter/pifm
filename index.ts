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

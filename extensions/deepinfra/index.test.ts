// Deepinfra tests cover index plugin behavior.
import {
  createCapturedPluginRegistration,
  registerSingleProviderPlugin,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import type { ProviderCatalogContext } from "openclaw/plugin-sdk/provider-catalog-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import deepinfraPlugin from "./index.js";
import { DEEPINFRA_MODEL_CATALOG } from "./provider-static-catalog.js";

const DEEPINFRA_MODELS_URL =
  "https://api.deepinfra.com/v1/openai/models?sort_by=openclaw&filter=with_meta";

function buildDeepInfraCatalogContext(): ProviderCatalogContext {
  return {
    config: {},
    env: {},
    agentDir: "/tmp/openclaw-agent",
    resolveProviderApiKey: () => ({ apiKey: "profile-key" }),
    resolveProviderAuth: () => ({
      apiKey: "profile-key",
      mode: "api_key",
      source: "profile",
    }),
  };
}

function makeAgentModelEntry(id = "profile/live-model") {
  return {
    id,
    object: "model",
    owned_by: "deepinfra",
    metadata: {
      description: id,
      context_length: 32768,
      max_tokens: 4096,
      pricing: { input_tokens: 1, output_tokens: 2 },
      tags: ["chat"],
    },
  };
}

function mockDiscoveryFetch(id = "profile/live-model") {
  return vi.fn(async (url: string) => {
    if (url === DEEPINFRA_MODELS_URL) {
      return Response.json({ data: [makeAgentModelEntry(id)] });
    }
    expect(url).toBe("https://api.deepinfra.com/models/list");
    return Response.json([
      {
        model_name: id,
        pricing: {
          type: "tokens",
          cents_per_input_token: 0.0004,
          cents_per_output_token: 0.0008,
        },
      },
    ]);
  });
}

afterEach(() => {
  clearLiveCatalogCacheForTests();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function withLiveDiscoveryTestEnv(
  mockFetch: ReturnType<typeof vi.fn>,
  runAssertions: () => Promise<void>,
) {
  vi.stubGlobal("fetch", mockFetch);

  try {
    await runAssertions();
  } finally {
    vi.unstubAllGlobals();
  }
}

describe("deepinfra capability registration", () => {
  it.each([
    ...["metadata", "pricing"].flatMap((scenario) =>
      [401, 403, 503].map((status) => ({ scenario, status })),
    ),
    ...[200, 401, 503].map((status) => ({ scenario: "empty", status })),
  ])(
    "reports public $scenario HTTP $status without rejecting inference credentials",
    async ({ scenario, status }) => {
      const healthyFetch = mockDiscoveryFetch();
      const mockFetch = vi.fn(async (url: string) => {
        const metadata = url === DEEPINFRA_MODELS_URL;
        if (scenario === "empty" && metadata) {
          return Response.json({ data: [] });
        }
        if (
          (scenario === "metadata" && metadata) ||
          (scenario === "pricing" && !metadata) ||
          (scenario === "empty" && !metadata && status !== 200)
        ) {
          return new Response("unavailable", { status });
        }
        return healthyFetch(url);
      });
      const provider = await registerSingleProviderPlugin(deepinfraPlugin);
      await withLiveDiscoveryTestEnv(mockFetch, async () => {
        const result = await provider.catalog?.run(buildDeepInfraCatalogContext());
        const rejected = status === 401 || status === 403;
        expect(result).toEqual(
          scenario === "empty"
            ? {
                provider: {
                  baseUrl: "https://api.deepinfra.com/v1/openai",
                  api: "openai-completions",
                  apiKey: "profile-key",
                  models: [],
                },
                outcomes: [{ provider: "deepinfra", status: "ready" }],
              }
            : {
                providers: {},
                outcomes: [
                  {
                    provider: "deepinfra",
                    status: rejected ? "auth-rejected" : "unavailable",
                    ...(rejected ? { rejectionScope: "catalog" } : {}),
                  },
                ],
              },
        );
      });
    },
  );

  it("registers all DeepInfra-backed OpenClaw provider surfaces", () => {
    const captured = createCapturedPluginRegistration();
    deepinfraPlugin.register(captured.api);

    expect(captured.providers.map((provider) => provider.id)).toEqual(["deepinfra"]);
    expect(captured.imageGenerationProviders.map((provider) => provider.id)).toEqual(["deepinfra"]);
    expect(captured.mediaUnderstandingProviders.map((provider) => provider.id)).toEqual([
      "deepinfra",
    ]);
    expect(captured.embeddingProviders.map((provider) => provider.id)).toEqual(["deepinfra"]);
    expect(captured.speechProviders.map((provider) => provider.id)).toEqual(["deepinfra"]);
    expect(captured.videoGenerationProviders.map((provider) => provider.id)).toEqual(["deepinfra"]);
  });

  it("uses profile-resolved API keys for live text catalog discovery", async () => {
    clearLiveCatalogCacheForTests();
    const mockFetch = mockDiscoveryFetch();
    const captured = createCapturedPluginRegistration();
    deepinfraPlugin.register(captured.api);
    const provider = captured.providers[0];
    if (!provider?.catalog) {
      throw new Error("expected DeepInfra provider registration");
    }
    const catalog = provider.catalog;

    await withLiveDiscoveryTestEnv(mockFetch, async () => {
      const result = await catalog.run(buildDeepInfraCatalogContext());
      if (!result || !("provider" in result)) {
        throw new Error("expected single-provider DeepInfra catalog result");
      }

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch.mock.calls.map(([url]) => url)).toEqual(
        expect.arrayContaining([DEEPINFRA_MODELS_URL, "https://api.deepinfra.com/models/list"]),
      );
      expect(result.provider.models[0]?.cost).toEqual({
        input: 4,
        output: 8,
        cacheRead: 0,
        cacheWrite: 0,
      });
      expect(result?.provider.apiKey).toBe("profile-key");
      expect(result.outcomes).toEqual([{ provider: "deepinfra", status: "ready" }]);
      expect(result.provider.models.map((model) => model.id)).toEqual(["profile/live-model"]);
    });
  });
});

describe("deepinfra isCacheTtlEligible", () => {
  it("returns true for anthropic/* proxied models", async () => {
    const provider = await registerSingleProviderPlugin(deepinfraPlugin);
    expect(
      provider.isCacheTtlEligible?.({
        provider: "deepinfra",
        modelId: "anthropic/claude-4-sonnet",
      }),
    ).toBe(true);
  });

  // Locked to case-insensitive to stay consistent with the shared proxy cache
  // wrapper, which lowercases the modelId before the "anthropic/" prefix check.
  it("returns true regardless of modelId case", async () => {
    const provider = await registerSingleProviderPlugin(deepinfraPlugin);
    expect(
      provider.isCacheTtlEligible?.({
        provider: "deepinfra",
        modelId: "Anthropic/Claude-4-Sonnet",
      }),
    ).toBe(true);
    expect(
      provider.isCacheTtlEligible?.({
        provider: "deepinfra",
        modelId: "ANTHROPIC/claude-4-sonnet",
      }),
    ).toBe(true);
  });

  it("returns false for non-anthropic models", async () => {
    const provider = await registerSingleProviderPlugin(deepinfraPlugin);
    expect(
      provider.isCacheTtlEligible?.({
        provider: "deepinfra",
        modelId: "meta-llama/Llama-4-Scout-17B-16E-Instruct",
      }),
    ).toBe(false);
    expect(
      provider.isCacheTtlEligible?.({
        provider: "deepinfra",
        modelId: "zai-org/GLM-5.1",
      }),
    ).toBe(false);
  });
});

// Regression: live-catalog ids offered by the picker/models.list must also
// resolve for agent runs; before the dynamic hooks existed every non-static
// model failed with "Unknown model" (picker offered 142, only ~12 ran).
describe("deepinfra dynamic model resolution", () => {
  // No key => discovery serves the manifest; keeps a developer's real key out of the run.
  beforeEach(() => {
    vi.stubEnv("DEEPINFRA_API_KEY", "");
  });

  it("prepares discovered catalog models for async run resolution", async () => {
    const provider = await registerSingleProviderPlugin(deepinfraPlugin);
    const manifestModel = DEEPINFRA_MODEL_CATALOG[0]!;
    const context = {
      provider: "deepinfra",
      modelId: manifestModel.id,
      agentDir: "/tmp/openclaw-agent",
      modelRegistry: { find: vi.fn(() => null) },
    } as never;

    const model = await provider.prepareDynamicModel?.(context);

    expect(model).toMatchObject({
      id: manifestModel.id,
      provider: "deepinfra",
      api: "openai-completions",
      baseUrl: "https://api.deepinfra.com/v1/openai",
    });
  });

  it("resolves ids missing from discovery to a default-capability model instead of dead-ending", async () => {
    const provider = await registerSingleProviderPlugin(deepinfraPlugin);
    const context = {
      provider: "deepinfra",
      modelId: "synthetic/Fresh-Model-Next",
      agentDir: "/tmp/openclaw-agent",
      modelRegistry: { find: vi.fn(() => null) },
    } as never;

    expect(await provider.prepareDynamicModel?.(context)).toBeUndefined();
    const model = provider.resolveDynamicModel?.(context);

    expect(model).toMatchObject({
      id: "synthetic/Fresh-Model-Next",
      provider: "deepinfra",
      api: "openai-completions",
      baseUrl: "https://api.deepinfra.com/v1/openai",
      input: ["text"],
      contextWindow: 128000,
      maxTokens: 8192,
    });
  });

  it("keeps the deepseek thinking format on dynamic deepseek-ai models", async () => {
    const provider = await registerSingleProviderPlugin(deepinfraPlugin);
    const model = provider.resolveDynamicModel?.({
      provider: "deepinfra",
      modelId: "deepseek-ai/Synthetic-Reasoner",
      agentDir: "/tmp/openclaw-agent",
      modelRegistry: { find: vi.fn(() => null) },
    } as never);

    expect(model?.compat).toMatchObject({ thinkingFormat: "deepseek" });
  });

  it("honors a configured provider baseUrl for dynamic models", async () => {
    const provider = await registerSingleProviderPlugin(deepinfraPlugin);
    const model = provider.resolveDynamicModel?.({
      provider: "deepinfra",
      modelId: "synthetic/model",
      agentDir: "/tmp/openclaw-agent",
      modelRegistry: { find: vi.fn(() => null) },
      providerConfig: { baseUrl: "https://proxy.example.invalid/v1/openai" },
    } as never);

    expect(model?.baseUrl).toBe("https://proxy.example.invalid/v1/openai");
  });

  it("serves discovered metadata to sync resolution after a prepare pass", async () => {
    const provider = await registerSingleProviderPlugin(deepinfraPlugin);
    const manifestModel = DEEPINFRA_MODEL_CATALOG[0]!;
    const context = {
      provider: "deepinfra",
      modelId: manifestModel.id,
      agentDir: "/tmp/openclaw-agent",
      modelRegistry: { find: vi.fn(() => null) },
    } as never;

    await provider.prepareDynamicModel?.(context);
    const model = provider.resolveDynamicModel?.(context);

    expect(model).toMatchObject({
      id: manifestModel.id,
      name: manifestModel.name ?? manifestModel.id,
    });
    if (typeof manifestModel.contextWindow === "number") {
      expect(model?.contextWindow).toBe(manifestModel.contextWindow);
    }
  });
});

// Deepinfra plugin entrypoint registers its OpenClaw integration.
import type {
  ProviderResolveDynamicModelContext,
  ProviderRuntimeModel,
} from "openclaw/plugin-sdk/plugin-entry";
import type { ProviderCatalogContext } from "openclaw/plugin-sdk/provider-catalog-shared";
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { buildProviderReplayFamilyHooks } from "openclaw/plugin-sdk/provider-model-shared";
import {
  createOpenRouterWrapper,
  isProxyReasoningUnsupported,
} from "openclaw/plugin-sdk/provider-stream";
import { createDeepInfraAnthropicCacheWrapper } from "./cache-wrapper.js";
import { buildDeepInfraEmbeddingAdapter } from "./embedding-adapter.js";
import { buildDeepInfraImageGenerationProvider } from "./image-generation-provider.js";
import { DEEPINFRA_BASE_URL } from "./media-models.js";
import { buildDeepInfraMediaUnderstandingProvider } from "./media-understanding-provider.js";
import { applyDeepInfraConfig } from "./onboard.js";
import { buildDeepInfraApiKeyCatalog } from "./provider-catalog.js";
import {
  DEEPINFRA_DEFAULT_CONTEXT_WINDOW,
  DEEPINFRA_DEFAULT_MAX_TOKENS,
  discoverDeepInfraModels,
  findDiscoveredDeepInfraModel,
  getDeepInfraSurfaceFallbackCatalog,
} from "./provider-models.js";
import {
  buildDeepInfraModelDefinition,
  buildStaticDeepInfraProvider,
  DEEPINFRA_DEFAULT_MODEL_REF,
  DEEPINFRA_MODEL_CATALOG,
} from "./provider-static-catalog.js";
import { buildDeepInfraSpeechProvider } from "./speech-provider.js";
import {
  listDeepInfraImageGenCatalog,
  listDeepInfraVideoGenCatalog,
} from "./surface-model-catalogs.js";
import { buildDeepInfraVideoGenerationProvider } from "./video-generation-provider.js";

const PROVIDER_ID = "deepinfra";

// Dynamic-model lane (OpenRouter pattern): the live catalog — not the bundled
// static manifest — is the source of truth for runnable models, so ids that
// model discovery surfaced (picker, models.list) must also resolve for agent
// runs instead of dead-ending at "Unknown model". The async hook returns the
// live-discovered model directly; the sync hook serves the last discovery
// snapshot, then the manifest, then default capabilities so a freshly added
// DeepInfra model still runs (a nonexistent id then fails at request time with
// the provider's own error).
function buildDynamicDeepInfraModel(
  ctx: ProviderResolveDynamicModelContext,
  discovered?: ModelDefinitionConfig,
): ProviderRuntimeModel {
  const model =
    discovered ??
    findDiscoveredDeepInfraModel(ctx.modelId) ??
    buildDeepInfraModelDefinition(
      DEEPINFRA_MODEL_CATALOG.find((entry) => entry.id === ctx.modelId) ?? {
        id: ctx.modelId,
        name: ctx.modelId,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: DEEPINFRA_DEFAULT_CONTEXT_WINDOW,
        maxTokens: DEEPINFRA_DEFAULT_MAX_TOKENS,
      },
    );
  // Chat runtime models only route text/image; other catalog modalities stay on
  // their own media surfaces.
  const input = model.input.filter(
    (entry): entry is "text" | "image" => entry === "text" || entry === "image",
  );
  return {
    id: ctx.modelId,
    name: model.name ?? ctx.modelId,
    api: "openai-completions",
    provider: PROVIDER_ID,
    baseUrl: ctx.providerConfig?.baseUrl?.trim() || DEEPINFRA_BASE_URL,
    reasoning: model.reasoning,
    input: input.length > 0 ? input : ["text"],
    ...(model.compat ? { compat: model.compat } : {}),
    cost: model.cost,
    contextWindow: model.contextWindow ?? DEEPINFRA_DEFAULT_CONTEXT_WINDOW,
    maxTokens: model.maxTokens,
  };
}

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "DeepInfra Provider",
  description: "Bundled DeepInfra provider plugin",
  provider: {
    label: "DeepInfra",
    docsPath: "/providers/deepinfra",
    auth: [
      {
        methodId: "api-key",
        label: "DeepInfra API key",
        hint: "Unified API for open source models",
        optionKey: "deepinfraApiKey",
        flagName: "--deepinfra-api-key",
        envVar: "DEEPINFRA_API_KEY",
        promptMessage: "Enter DeepInfra API key",
        noteTitle: "DeepInfra",
        noteMessage: [
          "DeepInfra provides an OpenAI-compatible API for open source and frontier models.",
          "Get your API key at: https://deepinfra.com/dash/api_keys",
        ].join("\n"),
        defaultModel: DEEPINFRA_DEFAULT_MODEL_REF,
        applyConfig: (cfg) => applyDeepInfraConfig(cfg),
        wizard: {
          choiceId: "deepinfra-api-key",
          choiceLabel: "DeepInfra API key",
          choiceHint: "Unified API for open source models",
          groupId: PROVIDER_ID,
          groupLabel: "DeepInfra",
          groupHint: "Unified API for open source models",
        },
      },
    ],
    catalog: {
      order: "simple",
      run: (ctx: ProviderCatalogContext) => buildDeepInfraApiKeyCatalog(ctx),
      staticRun: async () => ({ provider: buildStaticDeepInfraProvider() }),
    },
    resolveDynamicModel: (ctx) => buildDynamicDeepInfraModel(ctx),
    prepareDynamicModel: async (ctx) => {
      const models = await discoverDeepInfraModels({
        agentDir: ctx.agentDir,
        discoveryMode: "advisory",
      });
      const discovered = models.find((model) => model.id === ctx.modelId);
      return discovered ? buildDynamicDeepInfraModel(ctx, discovered) : undefined;
    },
    normalizeConfig: ({ providerConfig }) => providerConfig,
    normalizeTransport: ({ api, baseUrl }) =>
      baseUrl === "https://api.deepinfra.com/v1/openai" ? { api, baseUrl } : undefined,
    ...buildProviderReplayFamilyHooks({ family: "passthrough-gemini" }),
    wrapStreamFn: (ctx) => {
      const thinkingLevel = isProxyReasoningUnsupported(ctx.modelId)
        ? undefined
        : ctx.thinkingLevel;
      // OpenRouter wrapper handles reasoning normalization for proxy-style
      // providers; layer DeepInfra's anthropic cache-marker wrapper on top so
      // anthropic/* requests carry the ephemeral cache_control markers that
      // the upstream OpenRouter-only wrapper skips.
      return createDeepInfraAnthropicCacheWrapper(
        createOpenRouterWrapper(ctx.streamFn, thinkingLevel),
        ctx.extraParams,
      );
    },
    isModernModelRef: () => true,
    isCacheTtlEligible: (ctx) => ctx.modelId.toLowerCase().startsWith("anthropic/"),
  },
  register(api) {
    // Single source for media defaults at register time; image-gen and
    // video-gen also get a live registerModelCatalogProvider that refreshes
    // from the agent endpoint when a key is configured (OpenRouter pattern).
    // TTS/STT/VLM/embed stay static until UnifiedModelCatalogKind covers them.
    const catalog = getDeepInfraSurfaceFallbackCatalog();
    api.registerImageGenerationProvider(
      buildDeepInfraImageGenerationProvider({ imageGenModels: catalog.imageGen }),
    );
    api.registerModelCatalogProvider({
      provider: PROVIDER_ID,
      kinds: ["image_generation"],
      liveCatalog: listDeepInfraImageGenCatalog,
    });
    api.registerMediaUnderstandingProvider(
      buildDeepInfraMediaUnderstandingProvider({
        vlmModels: catalog.vlm,
        sttModels: catalog.stt,
      }),
    );
    api.registerEmbeddingProvider(buildDeepInfraEmbeddingAdapter({ embedModels: catalog.embed }));
    api.registerSpeechProvider(buildDeepInfraSpeechProvider({ ttsModels: catalog.tts }));
    api.registerVideoGenerationProvider(
      buildDeepInfraVideoGenerationProvider({ videoGenModels: catalog.videoGen }),
    );
    api.registerModelCatalogProvider({
      provider: PROVIDER_ID,
      kinds: ["video_generation"],
      liveCatalog: listDeepInfraVideoGenCatalog,
    });
  },
});

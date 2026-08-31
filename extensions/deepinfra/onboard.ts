// Deepinfra setup module handles plugin onboarding behavior.
import {
  createAliasOnlyPresetAppliers,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import { DEEPINFRA_DEFAULT_MODEL_REF } from "./provider-models.js";

// DeepInfra fork: onboarding owns the memory-search embedding selection so a
// DeepInfra-keyed install works without a separate `config set` step. Only the
// unset/legacy-"auto" state is claimed; an operator's explicit provider choice
// (including "none") is preserved. Model stays unset so the adapter's default
// embedding model applies.
function applyDeepInfraMemorySearchProvider(cfg: OpenClawConfig): OpenClawConfig {
  const provider = cfg.memory?.search?.provider?.trim();
  if (provider && provider !== "auto") {
    return cfg;
  }
  return {
    ...cfg,
    memory: {
      ...cfg.memory,
      search: { ...cfg.memory?.search, provider: "deepinfra" },
    },
  };
}

export function applyDeepInfraConfig(
  cfg: OpenClawConfig,
  modelRef: string = DEEPINFRA_DEFAULT_MODEL_REF,
): OpenClawConfig {
  return applyDeepInfraMemorySearchProvider(
    createAliasOnlyPresetAppliers({ modelRef, alias: "DeepInfra" }).applyConfig(cfg),
  );
}

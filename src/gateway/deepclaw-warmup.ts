// Fork-only: warms the heavy first-chat code paths during sidecar startup so
// /ready stays 503 until the next chat will be fast. Upstream's prewarm
// (prewarmConfiguredPrimaryModel) is intentionally metadata-only; we trade
// startup time for an honest /ready.
//
// The model-catalog warm is load-bearing for the Control UI model picker: the
// picker's models.list runs read-only and can only read an already-built full
// provider catalog (materializeRequestedModelCatalog, prepared-model-catalog.ts).
// Without this build the picker shows "No models available" on every fresh
// gateway until some non-read-only consumer happens to run.
//
// Self-contained on purpose: every upstream symbol is reached via dynamic
// import to keep the rebase conflict surface to this file plus the single
// caller in server-startup-post-attach.ts. The colocated test file is the
// rebase canary if any of these paths or named exports move upstream.
import type { OpenClawConfig } from "../config/types.openclaw.js";

const SKIP_ENV = "OPENCLAW_SKIP_DEEPCLAW_WARMUP";
const BEST_EFFORT_TIMEOUT_MS = 60_000;

type WarmupLog = {
  warn: (msg: string) => void;
  info?: (msg: string) => void;
};

export function shouldSkipDeepclawWarmup(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[SKIP_ENV]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

export async function runDeepclawDeepWarmup(params: {
  cfg: OpenClawConfig;
  log: WarmupLog;
}): Promise<void> {
  if (shouldSkipDeepclawWarmup()) {
    return;
  }

  const providerRuntimeOk = await warmProviderRuntime(params);
  if (!providerRuntimeOk) {
    // If provider runtime can't load at all, the gateway has a deeper problem
    // than warmup can fix. Let /ready flip so the rest of the system (probes,
    // operator visibility) stays usable; the next chat will surface the real
    // failure.
    return;
  }

  const bestEffort = Promise.allSettled([
    import("../agents/command/attempt-execution.runtime.js").catch((err: unknown) => {
      params.log.warn(`deepclaw warmup: attempt-execution import failed: ${String(err)}`);
    }),
    import("../agents/command/delivery.runtime.js").catch((err: unknown) => {
      params.log.warn(`deepclaw warmup: delivery import failed: ${String(err)}`);
    }),
    warmFullModelCatalog(params),
    warmDefaultAuthProfileStore(params),
  ]);
  const timeout = new Promise<void>((resolve) => {
    const t = setTimeout(resolve, BEST_EFFORT_TIMEOUT_MS);
    t.unref?.();
  });
  await Promise.race([bestEffort, timeout]);
}

async function warmProviderRuntime(params: {
  cfg: OpenClawConfig;
  log: WarmupLog;
}): Promise<boolean> {
  try {
    const mod = await import("../plugins/provider-runtime.runtime.js");
    // Calling the existing exported wrapper with empty entries is a no-op for
    // the catalog but still goes through `await loadProviderRuntime()`, which
    // is the actual heavy import we need cached.
    await mod.augmentModelCatalogWithProviderPlugins({
      config: params.cfg,
      env: process.env,
      context: {
        config: params.cfg,
        env: process.env,
        entries: [],
      },
    });
    params.log.info?.("deepclaw warmup: provider runtime hot");
    return true;
  } catch (err) {
    params.log.warn(`deepclaw warmup: provider runtime load failed: ${String(err)}`);
    return false;
  }
}

async function warmFullModelCatalog(params: {
  cfg: OpenClawConfig;
  log: WarmupLog;
}): Promise<void> {
  try {
    // Non-read-only load: builds the full provider catalog (live discovery for
    // dynamic-catalog providers like deepinfra) into the published gateway
    // generation, so read-only consumers — models.list behind the Control UI
    // picker foremost — see the complete inventory instead of just the
    // configured primary.
    const { loadPreparedModelCatalog } = await import("../agents/prepared-model-catalog.js");
    const catalog = await loadPreparedModelCatalog({ config: params.cfg });
    params.log.info?.(`deepclaw warmup: model catalog hot (${catalog.length} models)`);
  } catch (err) {
    params.log.warn(`deepclaw warmup: model catalog load failed: ${String(err)}`);
  }
}

async function warmDefaultAuthProfileStore(params: {
  cfg: OpenClawConfig;
  log: WarmupLog;
}): Promise<void> {
  try {
    const { ensureAuthProfileStore } = await import("../agents/auth-profiles/store.js");
    // Synchronous, idempotent, module-cached. Channel startup may have already
    // warmed it; if so this is a fast no-op. If not, we pay the keychain/disk
    // cost here instead of on first chat.
    ensureAuthProfileStore(undefined, { config: params.cfg });
  } catch (err) {
    params.log.warn(`deepclaw warmup: auth profile warm failed: ${String(err)}`);
  }
}

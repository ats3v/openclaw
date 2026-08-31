import { afterEach, describe, expect, it, vi } from "vitest";

// Fork-only test file. Two roles:
// 1) Upstream contract canary: assert every module path and named export the
//    warmup hard-codes still exists on main. After `git rebase upstream/main`,
//    a failure here points at the rename to chase.
// 2) Behavior smoke: confirm the skip env var, the unconditional catalog warm,
//    and the provider-runtime early-out.

describe("deepclaw-warmup — upstream contract canary (rebase guard)", () => {
  it("provider runtime exports augmentModelCatalogWithProviderPlugins", async () => {
    const mod = await import("../plugins/provider-runtime.runtime.js");
    expect(typeof mod.augmentModelCatalogWithProviderPlugins).toBe("function");
  });

  it("attempt-execution runtime path resolves", async () => {
    await expect(import("../agents/command/attempt-execution.runtime.js")).resolves.toBeDefined();
  });

  it("delivery runtime path resolves", async () => {
    await expect(import("../agents/command/delivery.runtime.js")).resolves.toBeDefined();
  });

  it("prepared-model-catalog exports loadPreparedModelCatalog", async () => {
    const mod = await import("../agents/prepared-model-catalog.js");
    expect(typeof mod.loadPreparedModelCatalog).toBe("function");
  });

  it("auth-profiles store exports ensureAuthProfileStore", async () => {
    const mod = await import("../agents/auth-profiles/store.js");
    expect(typeof mod.ensureAuthProfileStore).toBe("function");
  });
});

describe("deepclaw-warmup — behavior", () => {
  afterEach(() => {
    delete process.env.OPENCLAW_SKIP_DEEPCLAW_WARMUP;
    vi.restoreAllMocks();
  });

  it("skip env var short-circuits before any work", async () => {
    process.env.OPENCLAW_SKIP_DEEPCLAW_WARMUP = "1";
    const { runDeepclawDeepWarmup } = await import("./deepclaw-warmup.js");
    const log = { warn: vi.fn(), info: vi.fn() };
    await runDeepclawDeepWarmup({ cfg: { agents: {} } as never, log });
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalled();
  });

  it("always warms the full model catalog (Control UI picker reads it read-only)", async () => {
    // Mock heavy upstream calls so this test stays fast and avoids cold-loading
    // bundled plugin runtime (per src/agents/CLAUDE.md and src/plugins/CLAUDE.md).
    const providerRuntime = await import("../plugins/provider-runtime.runtime.js");
    vi.spyOn(providerRuntime, "augmentModelCatalogWithProviderPlugins").mockResolvedValue([]);
    const catalog = await import("../agents/prepared-model-catalog.js");
    const catalogSpy = vi.spyOn(catalog, "loadPreparedModelCatalog").mockResolvedValue([]);
    const authStore = await import("../agents/auth-profiles/store.js");
    vi.spyOn(authStore, "ensureAuthProfileStore").mockReturnValue({} as never);

    const { runDeepclawDeepWarmup } = await import("./deepclaw-warmup.js");
    const log = { warn: vi.fn(), info: vi.fn() };

    // No allowlist, no configured models — the catalog warm must still run.
    await runDeepclawDeepWarmup({ cfg: { agents: { default: {} } } as never, log });
    expect(catalogSpy).toHaveBeenCalled();
  });

  it("returns early without best-effort work if provider runtime load fails", async () => {
    const providerRuntime = await import("../plugins/provider-runtime.runtime.js");
    vi.spyOn(providerRuntime, "augmentModelCatalogWithProviderPlugins").mockRejectedValue(
      new Error("simulated provider runtime load failure"),
    );
    const catalog = await import("../agents/prepared-model-catalog.js");
    const catalogSpy = vi.spyOn(catalog, "loadPreparedModelCatalog").mockResolvedValue([]);

    const { runDeepclawDeepWarmup } = await import("./deepclaw-warmup.js");
    const log = { warn: vi.fn(), info: vi.fn() };
    await runDeepclawDeepWarmup({ cfg: { agents: { default: {} } } as never, log });
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("provider runtime load failed"));
    expect(catalogSpy).not.toHaveBeenCalled();
  });
});

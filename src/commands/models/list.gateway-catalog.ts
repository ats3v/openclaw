/** Selects the Gateway that owns model catalog reads and performs the shared `models.list` call. */
import type {
  ModelsListParams,
  ModelsListResult,
} from "../../../packages/gateway-protocol/src/schema/model-catalog.js";
import { GATEWAY_SERVER_CAPS } from "../../../packages/gateway-protocol/src/server-capabilities.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { callGateway, isImplicitLocalGatewayTarget } from "../../gateway/call.js";
import { readActiveGatewayLockIdentity } from "../../infra/gateway-lock.js";

export type ModelsCatalogGatewaySelection = {
  /** Set only for the local lock owner; remote URLs and explicit ports carry their own target. */
  localPortOverride?: number;
};

/**
 * A remote URL or an explicit port is always the selected target. An implicit local target is
 * selected only while a Gateway holds the state lock; `null` means the caller reads locally.
 */
export async function selectModelsCatalogGateway(
  cfg: OpenClawConfig,
): Promise<ModelsCatalogGatewaySelection | null> {
  const localTarget = await isImplicitLocalGatewayTarget({ config: cfg });
  const explicitPort = Boolean(process.env.OPENCLAW_GATEWAY_PORT?.trim());
  if (!localTarget || explicitPort) {
    return {};
  }
  const owner = await readActiveGatewayLockIdentity({ requireInspection: true });
  return owner ? { localPortOverride: owner.port } : null;
}

/** Once selected, this Gateway owns both success and failure; callers never substitute a local inventory. */
export async function readGatewayModelsList(params: {
  config: OpenClawConfig;
  gateway: ModelsCatalogGatewaySelection;
  params: ModelsListParams;
  timeoutMs?: number;
}): Promise<ModelsListResult> {
  return await callGateway<ModelsListResult>({
    config: params.config,
    method: "models.list",
    ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
    requiredCapabilities: [GATEWAY_SERVER_CAPS.PUBLISHED_MODEL_CATALOG],
    ...params.gateway,
    params: params.params,
  });
}

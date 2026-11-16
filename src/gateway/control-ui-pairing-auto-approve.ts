// DeepInfra fork: Control UI browser pairing auto-approval policy.
// Allows first-time Control UI/WebChat browser pairing from configured CIDRs
// (gateway.controlUi.deviceAutoApproveCidrs) after credentialed auth, for
// deployments where the gateway port is reachable only through a trusted
// ingress. Upgrades of already-paired devices stay on the manual prompt.
import { isTrustedProxyAddress } from "./net.js";
import type { NodePairingAutoApproveClientIpSource } from "./node-pairing-auto-approve.types.js";

type ControlUiPairingAutoApproveReason =
  | "not-paired"
  | "role-upgrade"
  | "scope-upgrade"
  | "metadata-upgrade";

type ControlUiBrowserPairingEligibilityParams = {
  existingPairedDevice: boolean;
  role: string;
  reason: ControlUiPairingAutoApproveReason;
  isBrowserOperatorUi: boolean;
  isWebchat: boolean;
  authMethod: string | undefined;
  reportedClientIpSource: NodePairingAutoApproveClientIpSource;
  reportedClientIp?: string;
  autoApproveCidrs?: readonly string[];
};

/**
 * Returns true when a fresh Control UI/WebChat browser pairing request can be
 * auto-approved by the controlUi trusted-CIDR policy. Requires credentialed
 * shared-secret auth (token/password — trusted-proxy identities have their own
 * lane) plus a directly attributable client IP; spoofable loopback
 * trusted-proxy header paths always stay on the manual prompt.
 */
export function shouldAutoApproveControlUiBrowserPairing(
  params: ControlUiBrowserPairingEligibilityParams,
): boolean {
  if (params.existingPairedDevice || params.reason !== "not-paired") {
    return false;
  }
  if (params.role !== "operator" || !(params.isBrowserOperatorUi || params.isWebchat)) {
    return false;
  }
  if (params.authMethod !== "token" && params.authMethod !== "password") {
    return false;
  }
  if (
    params.reportedClientIpSource === "none" ||
    params.reportedClientIpSource === "loopback-trusted-proxy" ||
    !params.reportedClientIp
  ) {
    return false;
  }
  const autoApproveCidrs = params.autoApproveCidrs
    ?.map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (!autoApproveCidrs || autoApproveCidrs.length === 0) {
    return false;
  }
  return isTrustedProxyAddress(params.reportedClientIp, autoApproveCidrs);
}

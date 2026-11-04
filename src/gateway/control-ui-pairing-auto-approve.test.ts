import { describe, expect, it } from "vitest";
import { shouldAutoApproveControlUiBrowserPairing } from "./control-ui-pairing-auto-approve.js";

type EligibilityParams = Parameters<typeof shouldAutoApproveControlUiBrowserPairing>[0];

const ELIGIBLE: EligibilityParams = {
  existingPairedDevice: false,
  role: "operator",
  reason: "not-paired",
  isBrowserOperatorUi: false,
  isWebchat: true,
  authMethod: "token",
  reportedClientIpSource: "direct",
  reportedClientIp: "38.101.151.24",
  autoApproveCidrs: ["38.101.151.0/24"],
};

describe("shouldAutoApproveControlUiBrowserPairing", () => {
  it.each([
    ["webchat client over token auth from a configured CIDR", ELIGIBLE, true],
    [
      "browser operator UI over password auth",
      { ...ELIGIBLE, isWebchat: false, isBrowserOperatorUi: true, authMethod: "password" },
      true,
    ],
    [
      "trusted-proxy-attributed client IP inside the CIDR",
      { ...ELIGIBLE, reportedClientIpSource: "trusted-proxy" as const },
      true,
    ],
    ["already-paired device", { ...ELIGIBLE, existingPairedDevice: true }, false],
    ["scope upgrade", { ...ELIGIBLE, reason: "scope-upgrade" as const }, false],
    ["role upgrade", { ...ELIGIBLE, reason: "role-upgrade" as const }, false],
    ["metadata upgrade", { ...ELIGIBLE, reason: "metadata-upgrade" as const }, false],
    ["non-operator role", { ...ELIGIBLE, role: "node" }, false],
    ["non-browser client", { ...ELIGIBLE, isWebchat: false, isBrowserOperatorUi: false }, false],
    ["unauthenticated connect", { ...ELIGIBLE, authMethod: "none" }, false],
    [
      "trusted-proxy auth (owned by the trustedProxy.deviceAutoApprove lane)",
      { ...ELIGIBLE, authMethod: "trusted-proxy" },
      false,
    ],
    ["missing client IP", { ...ELIGIBLE, reportedClientIp: undefined }, false],
    ["unattributable client IP", { ...ELIGIBLE, reportedClientIpSource: "none" as const }, false],
    [
      "spoofable loopback trusted-proxy header path",
      { ...ELIGIBLE, reportedClientIpSource: "loopback-trusted-proxy" as const },
      false,
    ],
    ["client IP outside every CIDR", { ...ELIGIBLE, reportedClientIp: "203.0.113.9" }, false],
    ["no CIDRs configured", { ...ELIGIBLE, autoApproveCidrs: undefined }, false],
    ["empty CIDR list", { ...ELIGIBLE, autoApproveCidrs: [] }, false],
    ["whitespace-only CIDR entries", { ...ELIGIBLE, autoApproveCidrs: ["  ", ""] }, false],
  ])("%s -> %s", (_name, params, expected) => {
    expect(shouldAutoApproveControlUiBrowserPairing(params)).toBe(expected);
  });
});

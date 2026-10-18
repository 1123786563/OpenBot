import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
const herePath = fileURLToPath(import.meta.url);
const hereDir = dirname(herePath);
import { describe, expect, test } from "../../tests/support/e2e-compat";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { GatewayAdminCredentialNotConfiguredError } from "../src/gateway/admin-credential";
import type { GatewayNegotiationRecord } from "../src/gateway/capability-negotiation";
import type { GatewayProbeRecord } from "../src/gateway/probe";
import {
  assertGatewayReadyForBilling,
  createGatewayReadinessService,
  gatewayReadinessControls,
  GatewayNotReadyError,
  installGatewayReadinessService,
  type GatewayReadiness,
  type GatewayReadinessDeps,
  type GatewayReadinessService,
} from "../src/gateway/readiness";

/*
 * Bifrost 01.7 — the consumer-entry readiness gate, at the seams that need no
 * database. Five conjunctive conditions — the address is configured, the
 * credential is usable, the last probe succeeded for the current
 * configuration, the credit-admission extension is present, and the
 * conversion rate is configured and legal — and a refusal that names every
 * unmet one, each in a sentence an administrator can act on.
 *
 * What only the database can prove (real rows flipping the verdict) lives in
 * gateway-readiness.integration.test.ts. This file pins the aggregation, the
 * configVersion hand-off, the fail-closed default, the redaction of the
 * refusal, and the call-site inventory that keeps every future paid entry on
 * the one gate.
 */

/** The endpoint snapshot every green condition is built against. */
const ENDPOINT = {
  baseUrl: "http://127.0.0.1:1",
  requestTimeoutMs: 5_000,
  configVersion: 7,
};

/** A green probe: ok, and bound to the endpoint version above. */
function okProbe(configVersion = ENDPOINT.configVersion): GatewayProbeRecord {
  return {
    status: "ok",
    reasonCode: "gateway_probe_ok",
    checkedAt: "2026-10-17T00:00:00.000Z",
    configVersion,
    durationMs: 12,
  };
}

/** A green negotiation: the extension, present at a compatible version. */
function presentNegotiation(
  configVersion = ENDPOINT.configVersion,
): GatewayNegotiationRecord {
  return {
    creditAdmissionExtension: "present",
    extensionVersion: "1.2.3",
    reasonCode: "gateway_capability_extension_present",
    supportedRange: null,
    checkedAt: "2026-10-17T00:00:00.000Z",
    configVersion,
  };
}

/** A green rate: configured, from an administrator's saved version. */
function configuredRate() {
  return {
    configured: true as const,
    numerator: 100n,
    denominator: 1n,
    rateVersion: 3,
    source: "admin" as const,
  };
}

/** Every condition green. Tests override one branch at a time. */
function goodDeps(
  overrides: Partial<GatewayReadinessDeps> = {},
): GatewayReadinessDeps {
  return {
    readGatewayEndpoint: async () => ENDPOINT,
    resolveGatewayAdminCredential: async () => ({ adminKey: "gate-test-key" }),
    readLastGatewayProbe: async () => okProbe(),
    readLastGatewayNegotiation: async () => presentNegotiation(),
    readConversionRate: async () => configuredRate(),
    now: () => new Date("2026-10-17T01:02:03.000Z"),
    ...overrides,
  };
}

async function evaluate(deps: GatewayReadinessDeps): Promise<GatewayReadiness> {
  return createGatewayReadinessService(deps).evaluateGatewayReadiness();
}

describe("gateway readiness gate — the ready verdict", () => {
  test("all five conditions green: ready, no reasons, configVersion carried for downstream locking", async () => {
    const readiness = await evaluate(goodDeps());
    expect(readiness.ready).toBe(true);
    expect(readiness.blockingReasons).toEqual([]);
    expect(readiness.configVersion).toBe(ENDPOINT.configVersion);
    expect(readiness.checkedAt).toBe("2026-10-17T01:02:03.000Z");
    expect(Number.isNaN(Date.parse(readiness.checkedAt))).toBe(false);
  });
});

describe("gateway readiness gate — each unmet condition refuses on its own", () => {
  test("no endpoint configured", async () => {
    const readiness = await evaluate(
      goodDeps({ readGatewayEndpoint: async () => undefined }),
    );
    expect(readiness.ready).toBe(false);
    expect(readiness.blockingReasons).toEqual([
      "gateway_readiness_endpoint_not_configured",
      "gateway_readiness_probe_missing",
      "gateway_readiness_extension_not_negotiated",
    ]);
    // No configuration to lock against: the version is the pre-first-save 0.
    expect(readiness.configVersion).toBe(0);
  });

  test("credential not configured", async () => {
    const readiness = await evaluate(
      goodDeps({
        resolveGatewayAdminCredential: async () => {
          throw new GatewayAdminCredentialNotConfiguredError(
            "The gateway admin credential is not configured.",
          );
        },
      }),
    );
    expect(readiness.ready).toBe(false);
    expect(readiness.blockingReasons).toEqual([
      "gateway_readiness_credential_not_configured",
    ]);
  });

  test("credential unavailable (not merely unconfigured)", async () => {
    const readiness = await evaluate(
      goodDeps({
        resolveGatewayAdminCredential: async () => {
          throw new Error("decrypt failed");
        },
      }),
    );
    expect(readiness.blockingReasons).toEqual([
      "gateway_readiness_credential_unavailable",
    ]);
  });

  test("no probe on file", async () => {
    const readiness = await evaluate(
      goodDeps({ readLastGatewayProbe: async () => undefined }),
    );
    expect(readiness.blockingReasons).toEqual([
      "gateway_readiness_probe_missing",
    ]);
  });

  test("a probe from an older configuration answers nothing", async () => {
    const readiness = await evaluate(
      goodDeps({ readLastGatewayProbe: async () => okProbe(6) }),
    );
    expect(readiness.blockingReasons).toEqual([
      "gateway_readiness_probe_missing",
    ]);
  });

  test("the last probe did not succeed", async () => {
    const readiness = await evaluate(
      goodDeps({
        readLastGatewayProbe: async () => ({
          ...okProbe(),
          status: "unauthenticated" as const,
          reasonCode: "gateway_probe_unauthorized" as const,
        }),
      }),
    );
    expect(readiness.blockingReasons).toEqual([
      "gateway_readiness_probe_not_ok",
    ]);
  });

  test("no negotiation on file", async () => {
    const readiness = await evaluate(
      goodDeps({ readLastGatewayNegotiation: async () => undefined }),
    );
    expect(readiness.blockingReasons).toEqual([
      "gateway_readiness_extension_not_negotiated",
    ]);
  });

  test("the extension is absent from the gateway", async () => {
    const readiness = await evaluate(
      goodDeps({
        readLastGatewayNegotiation: async () => ({
          ...presentNegotiation(),
          creditAdmissionExtension: "absent" as const,
          extensionVersion: null,
          reasonCode: "gateway_capability_extension_absent" as const,
          supportedRange: null,
        }),
      }),
    );
    expect(readiness.blockingReasons).toEqual([
      "gateway_readiness_extension_absent",
    ]);
  });

  test("the extension is at an incompatible version", async () => {
    const readiness = await evaluate(
      goodDeps({
        readLastGatewayNegotiation: async () => ({
          ...presentNegotiation(),
          creditAdmissionExtension: "incompatible" as const,
          extensionVersion: "2.0.0",
          reasonCode:
            "gateway_capability_extension_version_incompatible" as const,
          supportedRange: ">=1.0.0 <2.0.0",
        }),
      }),
    );
    expect(readiness.blockingReasons).toEqual([
      "gateway_readiness_extension_incompatible",
    ]);
  });

  test("the conversion rate is not configured", async () => {
    const readiness = await evaluate(
      goodDeps({
        readConversionRate: async () => ({
          configured: false as const,
          reason: "not_configured" as const,
          explanation: "The USD→credits conversion rate is not configured.",
        }),
      }),
    );
    expect(readiness.blockingReasons).toEqual([
      "gateway_readiness_rate_not_configured",
    ]);
  });

  test("the stored rate is corrupt (the read refuses rather than guesses)", async () => {
    const readiness = await evaluate(
      goodDeps({
        readConversionRate: async () => {
          throw new Error(
            'The stored conversion rate row "gateway_conversion_rate" is invalid',
          );
        },
      }),
    );
    expect(readiness.blockingReasons).toEqual([
      "gateway_readiness_rate_unavailable",
    ]);
  });
});

describe("gateway readiness gate — aggregation", () => {
  test("every unmet condition is named, each exactly once, not just the first", async () => {
    const readiness = await evaluate(
      goodDeps({
        readGatewayEndpoint: async () => undefined,
        resolveGatewayAdminCredential: async () => {
          throw new GatewayAdminCredentialNotConfiguredError(
            "The gateway admin credential is not configured.",
          );
        },
        readLastGatewayProbe: async () => undefined,
        readLastGatewayNegotiation: async () => undefined,
        readConversionRate: async () => ({
          configured: false as const,
          reason: "not_configured" as const,
          explanation: "not configured",
        }),
      }),
    );
    expect(readiness.ready).toBe(false);
    expect(new Set(readiness.blockingReasons).size).toBe(
      readiness.blockingReasons.length,
    );
    expect(readiness.blockingReasons).toContain(
      "gateway_readiness_endpoint_not_configured",
    );
    expect(readiness.blockingReasons).toContain(
      "gateway_readiness_credential_not_configured",
    );
    expect(readiness.blockingReasons).toContain(
      "gateway_readiness_probe_missing",
    );
    expect(readiness.blockingReasons).toContain(
      "gateway_readiness_extension_not_negotiated",
    );
    expect(readiness.blockingReasons).toContain(
      "gateway_readiness_rate_not_configured",
    );
  });

  test("conditions are assessed independently: a stale probe is named alongside an absent extension", async () => {
    const readiness = await evaluate(
      goodDeps({
        readLastGatewayProbe: async () => okProbe(6),
        readLastGatewayNegotiation: async () => undefined,
      }),
    );
    expect(readiness.blockingReasons).toEqual([
      "gateway_readiness_probe_missing",
      "gateway_readiness_extension_not_negotiated",
    ]);
    // Everything else stayed green, so the configuration version still locks.
    expect(readiness.configVersion).toBe(ENDPOINT.configVersion);
  });
});

describe("gateway readiness gate — the assert entry", () => {
  test("not ready: throws a displayable refusal carrying every reason", async () => {
    const service = createGatewayReadinessService(
      goodDeps({
        resolveGatewayAdminCredential: async () => {
          throw new GatewayAdminCredentialNotConfiguredError(
            "The gateway admin credential is not configured.",
          );
        },
        readConversionRate: async () => ({
          configured: false as const,
          reason: "not_configured" as const,
          explanation: "not configured",
        }),
      }),
    );
    let caught: unknown;
    try {
      await service.assertGatewayReadyForBilling();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(GatewayNotReadyError);
    const refusal = caught as GatewayNotReadyError;
    expect(refusal.readiness.ready).toBe(false);
    expect(refusal.readiness.blockingReasons).toEqual([
      "gateway_readiness_credential_not_configured",
      "gateway_readiness_rate_not_configured",
    ]);
    // One displayable sentence per blocking reason, none of them a bare code.
    for (const reason of refusal.readiness.blockingReasons) {
      expect(refusal.message).toContain(reason);
      expect(refusal.message).toContain(".");
    }
  });

  test("ready: resolves with the readiness (configVersion for downstream locking) and throws nothing", async () => {
    const service = createGatewayReadinessService(goodDeps());
    const readiness = await service.assertGatewayReadyForBilling();
    expect(readiness.ready).toBe(true);
    expect(readiness.configVersion).toBe(ENDPOINT.configVersion);
  });

  test("the module-level entry consults the installed gate (dependency-injection seam)", async () => {
    let consulted = 0;
    const spy: GatewayReadinessService = {
      evaluateGatewayReadiness: async () => {
        consulted += 1;
        return {
          ready: true,
          blockingReasons: [],
          configVersion: 11,
          checkedAt: "2026-10-17T02:00:00.000Z",
        };
      },
      assertGatewayReadyForBilling: async () => {
        consulted += 1;
        return {
          ready: true,
          blockingReasons: [],
          configVersion: 11,
          checkedAt: "2026-10-17T02:00:00.000Z",
        };
      },
    };
    installGatewayReadinessService(spy);
    try {
      const readiness = await assertGatewayReadyForBilling();
      expect(consulted).toBe(1);
      expect(readiness.configVersion).toBe(11);
    } finally {
      installGatewayReadinessService(undefined);
    }
  });

  test("no gate installed: fail closed — a refusal, never a free pass", async () => {
    // The app wiring installs the gate; a process that never did (a script, a
    // partial boot) must refuse paid work rather than wave it through.
    expect(gatewayReadinessControls()).toBeUndefined();
    let caught: unknown;
    try {
      await assertGatewayReadyForBilling();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(GatewayNotReadyError);
    const refusal = caught as GatewayNotReadyError;
    expect(refusal.readiness.blockingReasons).toEqual([
      "gateway_readiness_gate_unavailable",
    ]);
  });
});

describe("gateway readiness gate — the refusal carries no secrets", () => {
  test("no address, no credential material, in the error or the readiness payload", async () => {
    const adminKey = `sk-live-${crypto.randomUUID().slice(0, 8)}`;
    const baseUrl = "http://bifrost.internal.example";
    const service = createGatewayReadinessService(
      goodDeps({
        readGatewayEndpoint: async () => ({ ...ENDPOINT, baseUrl }),
        resolveGatewayAdminCredential: async () => ({ adminKey }),
        readLastGatewayProbe: async () => undefined,
      }),
    );
    let refusal: GatewayNotReadyError | undefined;
    try {
      await service.assertGatewayReadyForBilling();
    } catch (error) {
      refusal = error as GatewayNotReadyError;
    }
    expect(refusal).toBeInstanceOf(GatewayNotReadyError);
    const rendered = JSON.stringify(refusal?.readiness) + refusal?.message;
    expect(rendered).not.toContain(adminKey);
    expect(rendered).not.toContain(baseUrl);
  });
});

describe("gateway readiness gate — the call-site inventory", () => {
  /*
   * The gate is the single entry: a paid capability that needs to know whether
   * the gateway may serve work asks the gate, not the five condition sources.
   * This scan is the enforced inventory — a production file outside it that
   * reaches for the endpoint, credential, probe, negotiation or rate services
   * fails here, so a bypass entry cannot appear quietly.
   */
  const CONDITION_SOURCE_PATTERN =
    /createGatewayProbeService|probeGatewayManagementEndpoint|createGatewayCapabilityNegotiationService|fetchGatewayExtensionManifest|resolveGatewayAdminCredential|createConversionRateStore|createGatewayEndpointService|gatewayEndpointControls|gatewayAdminCredentialControls|gatewayProbeControls|gatewayCapabilityControls|createEnterpriseGatewayProbeStore|createEnterpriseGatewayNegotiationStore/;

  const srcRoot = join(hereDir, "..", "src");

  function listTypeScriptFiles(root: string): string[] {
    const files: string[] = [];
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      const path = join(root, entry.name);
      if (entry.isDirectory()) files.push(...listTypeScriptFiles(path));
      else if (entry.name.endsWith(".ts")) files.push(path);
    }
    return files;
  }

  test("only the gateway module itself and the app wiring resolve the readiness conditions", () => {
    // Assembled dependencies, not readiness verdicts: these call the factories the same way
    // app.ts does — to hand a resolved dependency to another service — never to answer
    // "is the gateway ready" themselves. Each entry names the ticket that needed it.
    const ALLOWED_ASSEMBLY_SITES: ReadonlyMap<string, string> = new Map([
      ["/billing/reserve-bound.ts", "06.x reserve converts at the locked rate via the rate store"],
      ["/bot-services/registry.ts", "#244/#245 key issuance reads the gateway endpoint at assembly"],
      ["/index.ts", "startup wiring (#249 key-state sync and peers) hands controls to services"],
    ]);
    const offenders = listTypeScriptFiles(srcRoot)
      .filter((path) => CONDITION_SOURCE_PATTERN.test(path) === false)
      .map((path) => `/${path.slice(srcRoot.length + 1)}`)
      .filter((relative) => {
        const contents = readFileSync(join(srcRoot, relative), "utf8");
        return CONDITION_SOURCE_PATTERN.test(contents);
      })
      .filter(
        (relative) =>
          !relative.startsWith("/gateway/") &&
          relative !== "/app.ts" &&
          !ALLOWED_ASSEMBLY_SITES.has(relative),
      );
    expect(offenders).toEqual([]);
  });
});

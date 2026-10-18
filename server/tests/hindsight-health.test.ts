import { describe, expect, test } from "../../tests/support/e2e-compat";
import { loadHindsightConfig } from "../src/hindsight/config";
import {
  checkHindsightHealth,
  type HindsightHealthDeps,
} from "../src/hindsight/health";

/**
 * A fetch double. It answers routes the way the pinned Hindsight build does:
 * /health for service readiness, /version for build identity, and the bank
 * LLM probe for "can this deployment still reach its model gateway".
 */
type RouteHandler = (url: URL, init?: RequestInit) => unknown;

function fetchDouble(
  routes: Record<string, RouteHandler | (() => never)>,
): HindsightHealthDeps["fetch"] {
  return async (
    input: Parameters<HindsightHealthDeps["fetch"]>[0],
    init?: RequestInit,
  ) => {
    const url = new URL(
      typeof input === "string" ? input : (input as URL).toString(),
    );
    const handler = routes[url.pathname] ?? routes["*"];
    const body = handler ? handler(url, init) : { status: 404 };
    // A handler may return a raw Response to pin a non-2xx answer (e.g. /health
    // 401 on a rejected token); everything else is wrapped in a 200 JSON
    // response the way the real endpoints answer.
    if (body instanceof Response) return body;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

const rejectAll: HindsightHealthDeps["fetch"] = async () => {
  throw new Error("connection refused");
};

const baseEnv = {
  HINDSIGHT_API_URL: "http://127.0.0.1:8888",
  HINDSIGHT_API_TOKEN: "secret-token",
  HINDSIGHT_MODEL_GATEWAY_URL: "http://127.0.0.1:9100",
  HINDSIGHT_MODEL_GATEWAY_API_KEY: "gateway-key",
  HINDSIGHT_PRIVACY_LLM_TRACE_ENABLED: "false",
  HINDSIGHT_PRIVACY_OPERATION_RETENTION_DAYS: "1",
  HINDSIGHT_PRIVACY_BACKUP_RETENTION_DAYS: "30",
};

/**
 * The shape the pinned ghcr.io/vectorize-io/hindsight:1.0.0 build actually returns
 * (captured from the live instance during ticket #380 verification).
 */
const healthyService: Record<string, RouteHandler> = {
  "/health": () => ({}),
  "/version": () => ({ api_version: "1.0.0", features: { llm_trace: false } }),
  "/v1/default/banks/default/health/llm": () => ({
    bank_id: "default",
    operations: [
      { operation: "retain", ok: true, status: "connected" },
      { operation: "consolidation", ok: true, status: "connected" },
      { operation: "reflect", ok: true, status: "connected" },
    ],
  }),
};

describe("checkHindsightHealth", () => {
  test("service up, gateway reachable, privacy compliant -> service_up", async () => {
    const status = await checkHindsightHealth(loadHindsightConfig(baseEnv), {
      fetch: fetchDouble(healthyService),
    });
    expect(status.state).toBe("service_up");
  });

  test("reports the service's api_version on the healthy path", async () => {
    const status = await checkHindsightHealth(loadHindsightConfig(baseEnv), {
      fetch: fetchDouble(healthyService),
    });
    expect(status.state).toBe("service_up");
    expect(status.version).toBe("1.0.0");
  });

  test("gateway probe reports a failed operation (ok: false) -> gateway_down", async () => {
    const status = await checkHindsightHealth(loadHindsightConfig(baseEnv), {
      fetch: fetchDouble({
        ...healthyService,
        "/v1/default/banks/default/health/llm": () => ({
          bank_id: "default",
          operations: [
            { operation: "retain", ok: true, status: "connected" },
            { operation: "reflect", ok: false, status: "error" },
          ],
        }),
      }),
    });
    expect(status.state).toBe("gateway_down");
  });

  test("older probe shape without ok falls back to status healthy/connected", async () => {
    const status = await checkHindsightHealth(loadHindsightConfig(baseEnv), {
      fetch: fetchDouble({
        ...healthyService,
        "/v1/default/banks/default/health/llm": () => ({
          bank_id: "default",
          operations: [{ operation: "retain", status: "healthy" }],
        }),
      }),
    });
    expect(status.state).toBe("service_up");
  });

  test("gateway probe cannot even connect while the service itself answers -> gateway_down", async () => {
    const status = await checkHindsightHealth(loadHindsightConfig(baseEnv), {
      fetch: async (input) => {
        const url = new URL(
          typeof input === "string" ? input : (input as URL).toString(),
        );
        if (url.pathname === "/v1/default/banks/default/health/llm") {
          throw new Error("connection refused");
        }
        return new Response("{}", { status: 200 });
      },
    });
    expect(status.state).toBe("gateway_down");
  });

  test("privacy declaration noncompliant -> config_noncompliant, without contacting the service", async () => {
    const status = await checkHindsightHealth(
      loadHindsightConfig({
        ...baseEnv,
        HINDSIGHT_PRIVACY_LLM_TRACE_ENABLED: "true",
      }),
      { fetch: rejectAll },
    );
    expect(status.state).toBe("config_noncompliant");
  });

  test("service unreachable -> service_down", async () => {
    const status = await checkHindsightHealth(loadHindsightConfig(baseEnv), {
      fetch: rejectAll,
    });
    expect(status.state).toBe("service_down");
  });

  test("service answers but rejects the token (/health 401) -> service_down (ocr6)", async () => {
    // ApiKeyTenantExtension checks the bearer token on every request, /health included, so a
    // misconfigured or rotated apiToken makes the service answer 401. The four states have no
    // auth verdict, so this lands in service_down — the HTTP status inside the logged detail
    // ("request failed with status 401") is what tells "fix the token" apart from "restart the
    // container". The gateway probe below stays healthy on purpose: if the check ever leaked a
    // 401 past the service probe, this test would fail with service_up, not just a state swap.
    const status = await checkHindsightHealth(loadHindsightConfig(baseEnv), {
      fetch: fetchDouble({
        ...healthyService,
        "/health": () =>
          new Response(JSON.stringify({ error: "unauthorized" }), {
            status: 401,
          }),
      }),
    });
    expect(status.state).toBe("service_down");
  });

  test("declared llm trace false but runtime reports llm_trace true -> config_noncompliant (ocr3 cross-check)", async () => {
    // The declaration passed validateHindsightPrivacy (llmTraceEnabled === false), but the
    // running service contradicts it: the version endpoint reports features.llm_trace true.
    // The service_up verdict must escalate, naming the runtime evidence as the violation.
    const status = await checkHindsightHealth(loadHindsightConfig(baseEnv), {
      fetch: fetchDouble({
        ...healthyService,
        "/version": () => ({
          api_version: "1.0.0",
          features: { llm_trace: true },
        }),
      }),
    });
    expect(status.state).toBe("config_noncompliant");
    expect(status.violations).toEqual(["runtime_llm_trace_enabled"]);
    expect(status.version).toBe("1.0.0");
  });

  test("declared false and runtime llm_trace false agree -> service_up (ocr3 cross-check)", async () => {
    const status = await checkHindsightHealth(loadHindsightConfig(baseEnv), {
      fetch: fetchDouble(healthyService),
    });
    expect(status.state).toBe("service_up");
    expect(status.violations).toBeUndefined();
  });

  test("runtime llm_trace flag absent -> no cross-check evidence, stays service_up (ocr3)", async () => {
    // An older build without the features key cannot contradict the declaration; the check
    // treats a missing runtime flag as no evidence rather than as compliance or a violation.
    const status = await checkHindsightHealth(loadHindsightConfig(baseEnv), {
      fetch: fetchDouble({
        ...healthyService,
        "/version": () => ({ api_version: "1.0.0" }),
      }),
    });
    expect(status.state).toBe("service_up");
  });

  test("an explicitly undefined dep falls back to the platform default (ocr fix)", async () => {
    // Per-key fallback: an explicitly undefined dep must not erase the platform default the way
    // a spread merge would. `fetch` stays injected, so the fallback exercised here (`now`) is
    // deterministic; the fetch key shares the same `??` merge.
    const status = await checkHindsightHealth(loadHindsightConfig(baseEnv), {
      fetch: fetchDouble(healthyService),
      now: undefined,
    });
    expect(status.state).toBe("service_up");
    expect(status.version).toBe("1.0.0");
    expect(Number.isNaN(Date.parse(status.checkedAt))).toBe(false);
  });

  test("the status never carries memory content, tokens, or gateway keys", async () => {
    const status = await checkHindsightHealth(loadHindsightConfig(baseEnv), {
      fetch: fetchDouble(healthyService),
    });
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain("secret-token");
    expect(serialized).not.toContain("gateway-key");
    expect(serialized).not.toContain("modelGatewayApiKey");
    expect(Object.keys(status)).toEqual(["state", "checkedAt", "version"]);
  });
});

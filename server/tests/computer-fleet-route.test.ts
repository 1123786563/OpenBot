import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { describe, expect, test } from "../../tests/support/e2e-compat";
import type { AppVariables } from "../src/auth/guards";
import type { ComputerGateway } from "../src/computer/gateway";
import type { PolicyStore } from "../src/computer/policy-store";
import type { ComputerProvider } from "../src/computer/provider";
import { describeComputerSubstrate } from "../src/computer/provider";
import { createComputerRoutes } from "../src/computer/routes";

/**
 * The fleet is a fact about the deployment, not about a Bot. This is the same bug as the boundary
 * one in computer-policy-route.test.ts, a second time.
 *
 * Admin listed the fleet by calling `/:botId/computers` with a placeholder id, on the reasoning that
 * the endpoint answers with every computer whatever the path says. True when it was written. Then
 * the bot-access middleware arrived, the placeholder was not a Bot, `canUseBot` said so, and
 * `/admin/computers` answered 404 for everybody including an administrator. The screen renders
 * nothing at all while the list is null, so it did not even look broken: it looked like a
 * deployment with no computers, while two containers were running.
 *
 * The middleware's own comment asked for this: "a second deployment-wide route added later should
 * have to think about this line." It was added later and did not. So the fleet has a route of its
 * own now, and this holds it there.
 *
 * Found by driving the screen against a deployment that had computers, not by reading the diff.
 */

const ADMIN = { id: "u1", email: "admin@openbot.test", role: "admin" } as const;

function app(
  role: "admin" | "user" = "admin",
  fleetOverride?: Record<string, unknown>,
) {
  const asActor: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", { ...ADMIN, role });
    await next();
  };

  const gateway = {
    computers: async () => ({
      isolation: "per-bot",
      computers: [
        { botId: "risk-analyst", running: true, startedAt: null },
        { botId: "general-assistant", running: false, startedAt: null },
      ],
      ...fleetOverride,
    }),
  } as unknown as ComputerGateway;

  const policyStore = {
    get: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
    set: async () => undefined,
  } as unknown as PolicyStore;

  const routes = createComputerRoutes(
    gateway,
    policyStore,
    asActor,
    // No Bot is reachable, which is the deployment the bug showed up in: listing the fleet must not
    // depend on the caller having access to a Bot that happens to share the collection's name.
    async () => false,
  );

  return new Hono<{ Variables: AppVariables }>().route(
    "/api/computers",
    routes,
  );
}

describe("listing every computer in the deployment", () => {
  test("an administrator gets the fleet, whatever Bots they can reach", async () => {
    const response = await app().request("http://t/api/computers/fleet");

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      isolation: "per-bot",
      computers: [{ botId: "risk-analyst" }, { botId: "general-assistant" }],
    });
  });

  test("it is still administrator-only", async () => {
    // The exemption is from the bot-access check, not from the admin check. The fleet names every
    // Bot in the deployment, which is exactly what a plain user must not be handed.
    const response = await app("user").request("http://t/api/computers/fleet");

    expect(response.status).toBe(403);
  });

  test("a Bot route is still gated", async () => {
    // One named path, not a hole.
    const response = await app().request(
      "http://t/api/computers/some-bot/status",
    );

    expect(response.status).toBe(404);
  });
});

/**
 * What the fleet says about the substrate, which is a fact the live probe proved — never a fact the
 * configuration text can claim. An OpenShell deployment reports the capability list a probe actually
 * signed off on; everything else reports the legacy substrate it always ran on.
 */
describe("the substrate the fleet reports", () => {
  function providerWith(
    overrides: Partial<ComputerProvider>,
  ): ComputerProvider {
    return {
      name: "sandbox",
      isolation: "per-bot",
      locate: async () => "http://computer",
      status: async () => ({ botId: "b", state: "ready" }),
      stop: async () => ({ wasRunning: false }),
      reset: async () => ({ cleared: false }),
      list: async () => [],
      ...overrides,
    };
  }

  test("an OpenShell deployment reports openshell with exactly the proven capabilities", () => {
    const proven = [
      "default-deny-network",
      "policy-load-receipt",
      "cross-workspace-denial",
      "credential-boundary",
    ];
    expect(
      describeComputerSubstrate(
        providerWith({
          name: "OpenShell",
          substrate: { substrate: "openshell", verifiedCapabilities: proven },
        }),
      ),
    ).toEqual({
      substrate: "openshell",
      verifiedCapabilities: proven,
      verified: true,
    });
  });

  test("an unproven OpenShell deployment says so rather than claiming the list", () => {
    // A partial list is unverified: the admin screen shows an unverified substrate instead of a
    // capability nobody proved in full.
    expect(
      describeComputerSubstrate(
        providerWith({
          name: "OpenShell",
          substrate: {
            substrate: "openshell",
            verifiedCapabilities: ["default-deny-network"],
          },
        }),
      ),
    ).toEqual({
      substrate: "openshell",
      verifiedCapabilities: ["default-deny-network"],
      verified: false,
    });
    expect(
      describeComputerSubstrate(
        providerWith({
          name: "OpenShell",
          substrate: { substrate: "openshell", verifiedCapabilities: [] },
        }),
      ),
    ).toEqual({
      substrate: "openshell",
      verifiedCapabilities: [],
      verified: false,
    });
  });

  test("every other provider is the legacy substrate, with no capability list to show", () => {
    expect(describeComputerSubstrate(providerWith({}))).toEqual({
      substrate: "legacy",
      verifiedCapabilities: [],
      verified: false,
    });
    expect(
      describeComputerSubstrate(
        providerWith({ name: "shared", isolation: "shared" }),
      ),
    ).toEqual({
      substrate: "legacy",
      verifiedCapabilities: [],
      verified: false,
    });
  });

  test("the fleet response carries the substrate through to the admin screen", async () => {
    const response = await app("admin", {
      substrate: "openshell",
      verifiedCapabilities: ["default-deny-network"],
    }).request("http://t/api/computers/fleet");

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      substrate: "openshell",
      verifiedCapabilities: ["default-deny-network"],
    });
  });
});

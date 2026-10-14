import { describe, expect, test } from "bun:test";
import type { AgentActor, AgentProfile } from "../src/agents/profile-types";
import { ComputerCapacityError } from "../src/computer/capacity";
import {
  createStreamAuthorizer,
  toStreamUrl,
} from "../src/computer/stream-auth";

/**
 * The gate on the live screen, decided without a port.
 *
 * The upgrade handler in index.ts runs this decision before it proxies a socket, and these are the
 * cases the authorization has to hold: a private Bot's screen is its owner's (or an administrator's)
 * alone — openmuse-private provisioning (I02) is what makes such Bots exist — and every refusal
 * states itself: no session, no Bot, no computer, no route inward.
 */

const OWNER_A: AgentActor = { id: "user-a", role: "user" };
const FOREIGN_B: AgentActor = { id: "user-b", role: "user" };
const ADMIN: AgentActor = { id: "admin-1", role: "admin" };

function profile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: "bot-1",
    name: "Muse",
    title: "Muse",
    roleDescription: "Keeps the owner's inspirations.",
    avatarSeed: "muse",
    visibility: "private",
    ownerUserId: OWNER_A.id,
    systemOwned: false,
    hidden: false,
    pinned: false,
    deletedAt: null,
    endpoint: null,
    hasAuth: false,
    hasCallbackToken: false,
    ...overrides,
  };
}

const PRIVATE_BOT = profile();
const PUBLIC_BOT = profile({
  id: "bot-public",
  visibility: "public",
  ownerUserId: FOREIGN_B.id,
});

const UPSTREAM = "ws://computer.internal:7020/stream";

function gate(
  options: {
    actor?: AgentActor | null;
    gateway?: { locate: (botId: string) => Promise<string> } | null;
    computerOff?: boolean;
    trustedOrigins?: string[];
  } = {},
) {
  return createStreamAuthorizer({
    resolveRequestActor:
      options.actor === null
        ? async () => {
            throw new Error("A run requires a signed-in user.");
          }
        : async () => ({ ...options.actor!, name: "Actor" }),
    agentProfileStore: {
      get: async (_actor: AgentActor, id: string) =>
        id === PRIVATE_BOT.id
          ? PRIVATE_BOT
          : id === PUBLIC_BOT.id
            ? PUBLIC_BOT
            : null,
    },
    ...(options.gateway === null
      ? {}
      : {
          computerGateway: options.gateway ?? {
            locate: async () => "http://computer.internal:7020",
          },
        }),
    config: options.computerOff ? {} : { computer: { token: "secret-token" } },
    ...(options.trustedOrigins
      ? { trustedOrigins: options.trustedOrigins }
      : {}),
  });
}

function streamRequest(botId = PRIVATE_BOT.id, websocket = true) {
  return new Request(`http://openbot.test/api/computers/${botId}/stream`, {
    headers: websocket ? { upgrade: "websocket" } : {},
  });
}

describe("authorizeComputerStream", () => {
  test("passes a request that is not a websocket upgrade on a stream path through", async () => {
    const authorize = gate({ actor: OWNER_A });
    expect(await authorize(streamRequest(PRIVATE_BOT.id, false))).toEqual({
      kind: "passthrough",
    });
    expect(
      await authorize(new Request("http://openbot.test/api/threads")),
    ).toEqual({ kind: "passthrough" });
  });

  test("refuses an upgrade without a session (401)", async () => {
    expect(await gate({ actor: null })(streamRequest())).toEqual({
      kind: "refuse",
      status: 401,
      message: "Sign in first.",
    });
  });

  test("refuses a signed-in foreign user on a private Bot (404)", async () => {
    expect(await gate({ actor: FOREIGN_B })(streamRequest())).toEqual({
      kind: "refuse",
      status: 404,
      message: "There is no such Bot.",
    });
  });

  test("authorizes the owner of a private Bot and builds the upstream URL", async () => {
    expect(await gate({ actor: OWNER_A })(streamRequest())).toEqual({
      kind: "proxy",
      botId: PRIVATE_BOT.id,
      actorId: OWNER_A.id,
      upstream: `${UPSTREAM}?bot=bot-1`,
      // The token rides beside the decision, never on the URL: the proxy
      // carries it to the inward socket as a header (round 6 M5) so it
      // cannot land in an access log.
      token: "secret-token",
    });
  });

  test("refuses with 502 when the gateway cannot locate the computer", async () => {
    const unreachable = gate({
      actor: OWNER_A,
      gateway: {
        locate: () => Promise.reject(new Error("That host is not allowed.")),
      },
    });
    expect(await unreachable(streamRequest())).toEqual({
      kind: "refuse",
      status: 502,
      // Neutral on purpose: the locate failure can carry internal topology (a supervisor's
      // raw address), which goes to the server log, not the browser.
      message: "That Bot's computer could not be reached.",
    });
    expect(
      await gate({
        actor: OWNER_A,
        gateway: { locate: () => Promise.reject("x") },
      })(streamRequest()),
    ).toEqual({
      kind: "refuse",
      status: 502,
      message: "That Bot's computer could not be reached.",
    });
  });

  test("refuses with 503 when no computer is configured, or none can be located", async () => {
    expect(
      await gate({ actor: OWNER_A, computerOff: true })(streamRequest()),
    ).toEqual({
      kind: "refuse",
      status: 503,
      message: "No computer is configured.",
    });
    expect(
      await gate({ actor: OWNER_A, gateway: null })(streamRequest()),
    ).toEqual({
      kind: "refuse",
      status: 503,
      message: "No computer address is configured.",
    });
  });

  test("authorizes an administrator on any Bot", async () => {
    for (const botId of [PRIVATE_BOT.id, PUBLIC_BOT.id]) {
      const decision = await gate({ actor: ADMIN })(streamRequest(botId));
      expect(decision.kind).toBe("proxy");
    }
  });
});

describe("toStreamUrl", () => {
  test("carries the Bot in the query, escaped, on a ws URL — and never the token", () => {
    expect(toStreamUrl("http://computer.internal:7020/", "b t")).toBe(
      "ws://computer.internal:7020/stream?bot=b%20t",
    );
  });
});

describe("cross-origin upgrades (round 3)", () => {
  function upgradeWithOrigin(origin: string) {
    return new Request(
      `http://openbot.test/api/computers/${PRIVATE_BOT.id}/stream`,
      { headers: { upgrade: "websocket", origin } },
    );
  }

  test("refuses an upgrade whose Origin is neither the deployment's nor trusted (403)", async () => {
    const authorize = gate({ actor: OWNER_A });
    const decision = await authorize(upgradeWithOrigin("http://evil.test"));
    expect(decision).toMatchObject({ kind: "refuse", status: 403 });
  });

  test("allows the same origin and an explicitly trusted one", async () => {
    const authorize = gate({
      actor: OWNER_A,
      trustedOrigins: ["https://app.example"],
    });
    for (const origin of ["http://openbot.test", "https://app.example"]) {
      expect((await authorize(upgradeWithOrigin(origin))).kind).toBe("proxy");
    }
  });

  test("refuses with 503, and no env guidance, when the deployment is at capacity", async () => {
    const authorize = gate({
      actor: OWNER_A,
      gateway: {
        locate: () => Promise.reject(new ComputerCapacityError(1)),
      },
    });
    expect(await authorize(streamRequest())).toEqual({
      kind: "refuse",
      status: 503,
      message: "Every computer this deployment allows is running.",
    });
  });
});

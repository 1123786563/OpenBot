import { describe, expect, test } from "../../tests/support/e2e-compat";
import type { AuditEventInput, AuditStore } from "../src/audit";
import { ComputerStoppedError } from "../src/computer/client";
import {
  type ComputerGateway,
  createComputerGateway,
} from "../src/computer/gateway";
import type { ActionPolicy } from "../src/computer/policy";
import type { ComputerProvider } from "../src/computer/provider";
import type { SignInCodeResult } from "../src/computer/schema";

/**
 * The verification-code half of the private sign-in, at the gateway seam.
 *
 * The code travels on one path only: from the private form, through the gateway, to the computer's
 * `/sign-in/code`, typed by that process into the page still asking for it. The properties pinned
 * here are the ones a green typecheck cannot show:
 *  - the request lands on the private code endpoint, addressed to the one Bot, carrying the same
 *    computer token the login itself carries;
 *  - no audit row is written here, success or failure — the passwords module owns the row, and it
 *    is written without the code;
 *  - an aborted caller stops before the request is sent;
 *  - the computer's own refusal surfaces as-is, and the code appears in no error, no row, no log.
 */

const CODE = "918273-fixture-not-a-real-code";
const ORIGIN = "https://example.test";
const PERMISSIVE: ActionPolicy = { mode: "enforce", deny: [], allow: ["true"] };

function harness(options?: {
  /** What the computer answers on /sign-in/code. */
  answer?: (init?: RequestInit) => Response | Promise<Response>;
}) {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const provider: ComputerProvider = {
    name: "test",
    isolation: "per-bot",
    locate: async () => "http://agent-computer:4100",
    status: async (botId) => ({ botId, state: "ready" }),
    stop: async () => ({ wasRunning: true }),
    reset: async () => ({ cleared: true }),
    list: async () => [],
  };
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    requests.push({ url: String(url), init });
    const path = new URL(String(url)).pathname;
    if (path === "/sign-in/code") {
      return options?.answer
        ? await options.answer(init)
        : Response.json({
            submitted: true,
            codeFieldVisible: false,
            passwordFieldVisible: false,
            url: `${ORIGIN}/home`,
          } satisfies SignInCodeResult);
    }
    return Response.json(
      { error: `Unknown endpoint: ${path}` },
      { status: 404 },
    );
  }) as unknown as typeof fetch;
  const rows: AuditEventInput[] = [];
  const auditStore: AuditStore = {
    insert: async (event) => void rows.push(event),
  };
  const gateway: ComputerGateway = createComputerGateway({
    provider,
    auditStore,
    policy: () => PERMISSIVE,
    token: "computer-token-fixture",
    fetchImpl,
  });
  return { gateway, requests, rows };
}

describe("the gateway's private verification-code entry", () => {
  test("posts the code to the computer's code endpoint, addressed to the one Bot", async () => {
    const { gateway, requests } = harness();
    const result = await gateway.signInCode("bot-1", {
      origin: ORIGIN,
      code: CODE,
    });

    expect(result).toEqual({
      submitted: true,
      codeFieldVisible: false,
      passwordFieldVisible: false,
      url: `${ORIGIN}/home`,
    });
    expect(requests).toHaveLength(1);
    const { url, init } = requests[0] as {
      url: string;
      init: RequestInit;
    };
    expect(new URL(url).pathname).toBe("/sign-in/code");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    // The Bot in the path's headers, not in the body: one Bot's call cannot reach another's.
    expect(headers["x-openbot-bot-id"]).toBe("bot-1");
    // The same service authentication the login itself carries.
    expect(headers["x-openbot-computer-token"]).toBe("computer-token-fixture");
    // The body is the parsed input and nothing else.
    expect(JSON.parse(String(init.body))).toEqual({
      origin: ORIGIN,
      code: CODE,
    });
  });

  test("writes no audit row, success or failure, and no error carries the code", async () => {
    const { gateway, rows } = harness({
      answer: () =>
        Response.json(
          { error: "The site is not asking for a verification code any more." },
          { status: 502 },
        ),
    });

    const error = await gateway
      .signInCode("bot-1", { origin: ORIGIN, code: CODE })
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(CODE);
    // The trail stays silent here, as it is for the login itself: the row about this code, without
    // the code, is the passwords module's to write.
    expect(rows).toHaveLength(0);
  });

  test("a caller that has stopped is answered before the request is sent", async () => {
    const { gateway, requests } = harness();
    const controller = new AbortController();
    controller.abort();

    await expect(
      gateway.signInCode(
        "bot-1",
        { origin: ORIGIN, code: CODE },
        controller.signal,
      ),
    ).rejects.toThrow(ComputerStoppedError);

    expect(requests).toHaveLength(0);
  });

  test("the refusal the computer itself returns is passed through untouched", async () => {
    const refused: SignInCodeResult = {
      submitted: true,
      codeFieldVisible: true,
      passwordFieldVisible: false,
      url: `${ORIGIN}/two-factor`,
    };
    const { gateway } = harness({ answer: () => Response.json(refused) });

    const result = await gateway.signInCode("bot-1", {
      origin: ORIGIN,
      code: CODE,
    });

    // A wrong code is the computer's report, not a gateway error: the caller sees the code field
    // still showing and decides what to tell the person.
    expect(result).toEqual(refused);
    expect(JSON.stringify(result)).not.toContain(CODE);
  });
});

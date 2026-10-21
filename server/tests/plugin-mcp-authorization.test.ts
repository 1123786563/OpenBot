import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "../../tests/support/e2e-compat";
import { authorizationHeader, listTools } from "../src/plugins/mcp";

describe("authorizationHeader", () => {
  test("a bare token is sent as Bearer", () => {
    expect(authorizationHeader("abc123")).toBe("Bearer abc123");
  });
  test("a token that names Basic is sent as written", () => {
    expect(authorizationHeader("Basic dXNlcjpwYXNz")).toBe(
      "Basic dXNlcjpwYXNz",
    );
  });
  test("a token that names Bearer is not doubled", () => {
    expect(authorizationHeader("Bearer abc123")).toBe("Bearer abc123");
  });
  test("the scheme is matched without regard to case, and whitespace is trimmed", () => {
    expect(authorizationHeader("  basic dXNlcjpwYXNz  ")).toBe(
      "basic dXNlcjpwYXNz",
    );
  });
  test("a scheme word with nothing after it is treated as a bare token", () => {
    expect(authorizationHeader("Basic")).toBe("Bearer Basic");
  });
});

/*
 * The header a stored token actually goes out in, read off the wire.
 *
 * `authorizationHeader` above is the DEFAULT branch; a catalogue entry may name a header of its
 * own (`auth: { kind: "deployment-bearer", header }`, Exa's `x-api-key`), and the only proof that
 * the name survives the journey to the transport is a request a real server received. Everything
 * here dials a local mock that answers 401 to everything: the call fails, and the failure is what
 * carries the assertion — the headers were seen on the way in.
 */
describe("the header a stored token is sent in", () => {
  let server: ReturnType<typeof Bun.serve>;
  let seen: Headers | undefined;
  beforeAll(async () => {
    server = Bun.serve({
      port: 0,
      fetch(request) {
        seen ??= request.headers;
        return new Response("no", { status: 401 });
      },
    });
    // Bun's own serve binds synchronously; the suite shim's is Node's, so the port exists a tick
    // later. Wait for the bind rather than race the first dial.
    for (let index = 0; index < 200 && !server.server.address(); index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  });
  afterAll(() => server.stop(true));

  const listed = async (connection: {
    token?: string;
    tokenHeader?: string;
  }) => {
    seen = undefined;
    await listTools({
      url: `http://127.0.0.1:${server.port}/mcp`,
      ...connection,
    }).catch(() => undefined);
    return seen;
  };

  test("is Authorization as a Bearer token by default", async () => {
    const headers = await listed({ token: "secret" });
    expect(headers?.get("authorization")).toBe("Bearer secret");
  });

  test("a token naming its own scheme still rides Authorization, as written", async () => {
    const headers = await listed({ token: "Basic dXNlcjpwYXNz" });
    expect(headers?.get("authorization")).toBe("Basic dXNlcjpwYXNz");
  });

  test("is the vendor's own header, as stored, when the entry names one", async () => {
    const headers = await listed({
      token: " secret ",
      tokenHeader: "x-api-key",
    });
    expect(headers?.get("x-api-key")).toBe("secret");
    expect(headers?.get("authorization")).toBeNull();
  });

  test("the vendor's header is sent raw, with no scheme added", async () => {
    const headers = await listed({
      token: "Bearer abc",
      tokenHeader: "x-api-key",
    });
    expect(headers?.get("x-api-key")).toBe("Bearer abc");
  });

  test("no token means no credential header at all", async () => {
    const headers = await listed({});
    expect(headers?.get("authorization")).toBeNull();
    expect(headers?.get("x-api-key")).toBeNull();
  });

  test("a credential the vendor rejects is reported as one", async () => {
    let message = "";
    await listTools({
      url: `http://127.0.0.1:${server.port}/mcp`,
      token: "expired",
    }).catch((error: unknown) => {
      message = error instanceof Error ? error.message : String(error);
    });
    expect(message).toContain("401");
    expect(message).toContain("credential");
  });
});

import { expect, setSystemTime, test } from "bun:test";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { generateCodeChallenge } from "better-auth/oauth2";
import { openFuseAuth } from "../src/auth/openfuse";

const origin = "https://openbot.example";
const redirectUri = "openfuse://auth/callback";
const state = "test-state-with-enough-entropy";
const verifier = "a".repeat(43);

test("OpenFuse exchanges a browser grant for a separate revocable session", async () => {
  const auth = betterAuth({
    baseURL: origin,
    secret: "a-fixed-test-fixture-secret-at-least-32-characters",
    database: memoryAdapter({
      user: [],
      account: [],
      session: [],
      verification: [],
    }),
    emailAndPassword: { enabled: true },
    plugins: [openFuseAuth("https://web.openbot.example")],
  });
  const request = (path: string, init?: RequestInit) =>
    auth.handler(new Request(new URL(path, origin), init));
  const query = new URLSearchParams({
    client_id: "openfuse",
    redirect_uri: redirectUri,
    code_challenge: await generateCodeChallenge(verifier),
    code_challenge_method: "S256",
    state,
  });
  const entry = `/api/auth/openfuse/authorize?${query}`;
  const anonymous = await request(entry);
  expect(anonymous.status).toBe(302);
  const signIn = new URL(anonymous.headers.get("location") ?? "", origin);
  expect(signIn.origin).toBe("https://web.openbot.example");
  expect(signIn.pathname).toBe("/sign");
  const handle = signIn.searchParams.get("openfuse_request");
  expect(handle).toBeTruthy();

  const signup = await auth.api.signUpEmail({
    body: {
      name: "Person",
      email: "person@example.com",
      password: "test-password",
    },
    asResponse: true,
  });
  const browserCookie = signup.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
  const continueQuery = new URLSearchParams({ request: handle ?? "" });
  const confirm = await request(
    `/api/auth/openfuse/continue?${continueQuery}`,
    {
      headers: { cookie: browserCookie },
    },
  );
  expect(confirm.status).toBe(200);
  expect(await confirm.text()).toContain("Continue to OpenFuse");
  const approve = (requestId: string) =>
    request("/api/auth/openfuse/approve", {
      method: "POST",
      headers: { cookie: browserCookie, origin },
      body: new URLSearchParams({ request: requestId }),
    });
  const callback = await approve(handle ?? "");
  expect(callback.status).toBe(302);
  const target = new URL(callback.headers.get("location") ?? origin);
  expect(target.href.split("?")[0]).toBe(redirectUri);
  expect([...target.searchParams.keys()].sort()).toEqual(["code", "state"]);
  expect(target.searchParams.get("state")).toBe(state);

  const exchange = (code: string, codeVerifier = verifier) =>
    request("/api/auth/openfuse/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, codeVerifier }),
    });
  const code = target.searchParams.get("code") ?? "";
  const results = await Promise.all([exchange(code), exchange(code)]);
  expect(results.map((response) => response.status).sort()).toEqual([200, 400]);
  const success = results.find((response) => response.ok);
  if (!success) throw new Error("Expected a successful exchange");
  const { sessionCookie } = await success.json();
  expect(success.headers.getSetCookie()).toEqual([]);
  expect(typeof sessionCookie).toBe("string");
  expect(sessionCookie).not.toBe(browserCookie);

  const session = (cookie: string) =>
    auth.api.getSession({ headers: new Headers({ cookie }) });
  expect((await session(sessionCookie))?.user.id).toBe(
    (await session(browserCookie))?.user.id,
  );
  expect((await session(sessionCookie))?.session.id).not.toBe(
    (await session(browserCookie))?.session.id,
  );
  const signOut = await request("/api/auth/sign-out", {
    method: "POST",
    headers: { cookie: sessionCookie, origin },
  });
  expect(signOut.ok).toBe(true);
  expect(await session(sessionCookie)).toBeNull();
  expect(await session(browserCookie)).not.toBeNull();

  const another = await request(entry, { headers: { cookie: browserCookie } });
  const anotherHandle = /name="request" value="([a-f0-9]{64})"/.exec(
    await another.text(),
  )?.[1];
  const anotherCallback = await approve(anotherHandle ?? "");
  expect(anotherCallback.status).toBe(302);
  const anotherCode =
    new URL(anotherCallback.headers.get("location") ?? origin).searchParams.get(
      "code",
    ) ?? "";
  expect((await exchange(anotherCode, "b".repeat(43))).status).toBe(400);
  try {
    setSystemTime(new Date(Date.now() + 121_000));
    expect((await exchange(anotherCode)).status).toBe(400);
  } finally {
    setSystemTime();
  }

  query.set("redirect_uri", "https://other.example/callback");
  expect((await request(`/api/auth/openfuse/authorize?${query}`)).status).toBe(
    400,
  );
});

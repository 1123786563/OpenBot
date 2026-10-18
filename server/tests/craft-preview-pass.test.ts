// #358 repair — the signed preview pass primitive (Task 1).
//
// The pre-fix preview pass WAS the session id: `holdsPreviewSessionPass` compared
// the cookie value against the sessionId, so anyone who knew a session id and the
// preview address could forge the credential without ever redeeming a ticket.
// This module replaces that with a deployment-key-signed, versioned pass bound to
// (sessionId, userId): `issue` mints it at ticket redemption, `verify` is the ONE
// judgment both the HTTP gate and the HMR upgrade apply.
//
// Every refusal below is a forgery shape the old check answered true: a plaintext
// session id, a self-made value with no ticket, a wrong version, a one-byte MAC
// flip, a cross-session replay, a cross-key replay. None may verify. The cookie
// header keeps D9's session-level shape (HttpOnly, SameSite=None; Secure, no
// Max-Age/Expires) with the signed value in the NAME=VALUE position.

import { describe, expect, test } from "bun:test";
import {
  PREVIEW_PASS_COOKIE_SHAPE,
  createPreviewPassCodec,
  type PreviewPassCodec,
} from "../src/craft/preview-pass";
import {
  PREVIEW_SESSION_COOKIE,
  previewSessionCookieHeader,
} from "../src/craft/preview-ticket";

const SECRET = "deployment-key-1";
const SESSION_ID = "cs-444455556666";
const USER_ID = "u1";

function codec(secret: string = SECRET): PreviewPassCodec {
  return createPreviewPassCodec(secret);
}

describe("createPreviewPassCodec.issue", () => {
  test("mints a versioned, URL/Cookie-safe value of the v1.<user>.<mac> shape", () => {
    const pass = codec().issue(SESSION_ID, USER_ID);
    expect(pass).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    // Cookie-safe: no attribute injector (`;` `,` controls), no whitespace.
    expect(pass).not.toMatch(/[;,"\s\\]/);
    expect(PREVIEW_PASS_COOKIE_SHAPE.test(pass)).toBe(true);
  });

  test("a userId outside the cookie alphabet still lands in one cookie-safe piece (base64url)", () => {
    const pass = codec().issue(SESSION_ID, "person@example.com");
    expect(pass).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(pass).not.toContain("person@example.com"); // encoded, never raw
  });

  test("a userId at the documented length bound rides through; the value stays cookie-shaped", () => {
    // users.id is provider-provided text (dev-local-user, Casdoor/SCIM ids) —
    // the bound must explicitly cover that shape, not just the happy path.
    const longUserId = "u".repeat(256);
    const pass = codec().issue(SESSION_ID, longUserId);
    expect(pass.length).toBeLessThanOrEqual(512);
    expect(codec().verify(SESSION_ID, pass)).toEqual({ userId: longUserId });
  });

  test("out-of-bounds inputs refuse to mint at all — never a silently unverifiable pass", () => {
    expect(() => codec().issue(SESSION_ID, "")).toThrow();
    expect(() => codec().issue(SESSION_ID, "u".repeat(257))).toThrow();
    expect(() => codec().issue("", USER_ID)).toThrow();
    expect(() => codec().issue("s".repeat(129), USER_ID)).toThrow();
  });
});

describe("createPreviewPassCodec.verify", () => {
  test("a pass minted for the right (sessionId, userId) verifies to that userId", () => {
    const pass = codec().issue(SESSION_ID, USER_ID);
    expect(codec().verify(SESSION_ID, pass)).toEqual({ userId: USER_ID });
  });

  test("the old plaintext session id is NOT a pass — the forgery the fix exists for", () => {
    // Pre-fix, `holdsPreviewSessionPass(SESSION_ID, {Cookie: …=cs_demo})` was
    // true. The codec is the judgment that replaced it: a raw session id must
    // never verify, with or without a ticket ever having been redeemed.
    expect(codec().verify(SESSION_ID, "cs_demo")).toBeNull();
    expect(codec().verify(SESSION_ID, SESSION_ID)).toBeNull();
  });

  test("self-made values with no ticket verify to nothing", () => {
    for (const forged of [
      "",
      "garbage",
      "v1",
      "v1.",
      "v1..",
      "v1.dTS.%",
      // right shape, random MAC bytes — nobody without the key can fill these in
      `v1.${Buffer.from(USER_ID).toString("base64url")}.${"A".repeat(43)}`,
      // empty userId payload
      `v1..${"A".repeat(43)}`,
    ]) {
      expect(codec().verify(SESSION_ID, forged)).toBeNull();
    }
  });

  test("a wrong version refuses", () => {
    const pass = codec().issue(SESSION_ID, USER_ID);
    const parts = pass.split(".");
    const wrongVersion = `v2.${parts[1]}.${parts[2]}`;
    expect(codec().verify(SESSION_ID, wrongVersion)).toBeNull();
  });

  test("a one-byte MAC flip refuses (tamper detection)", () => {
    const pass = codec().issue(SESSION_ID, USER_ID);
    const parts = pass.split(".");
    const mac = parts[2];
    const flipped = (mac[0] === "A" ? "B" : "A") + mac.slice(1);
    expect(codec().verify(SESSION_ID, `v1.${parts[1]}.${flipped}`)).toBeNull();
  });

  test("a pass for another session refuses on THIS session (cross-session replay)", () => {
    const otherSession = "cs-777788889999";
    const pass = codec().issue(otherSession, USER_ID);
    expect(codec().verify(otherSession, pass)).toEqual({ userId: USER_ID });
    expect(codec().verify(SESSION_ID, pass)).toBeNull();
  });

  test("a pass minted under another deployment key refuses (cross-key replay)", () => {
    const pass = codec("deployment-key-other").issue(SESSION_ID, USER_ID);
    expect(codec().verify(SESSION_ID, pass)).toBeNull();
  });

  test("non-string and over-length candidates refuse without throwing", () => {
    expect(
      codec().verify(SESSION_ID, undefined as unknown as string),
    ).toBeNull();
    expect(codec().verify(SESSION_ID, `${"a".repeat(513)}`)).toBeNull();
    expect(codec().verify("", "v1.AAAA.AAAA")).toBeNull();
  });

  test("a valid pass for a multi-byte userId verifies to the exact decoded string", () => {
    const userId = "用户-1";
    const pass = codec().issue(SESSION_ID, userId);
    expect(codec().verify(SESSION_ID, pass)).toEqual({ userId });
  });
});

describe("pass derivation", () => {
  test("the MAC is key-bound: same (session,user) under two keys yields different passes", () => {
    // The pass must not be constructible from the sessionId alone (AC4/D9: the
    // preview entry needs a REAL ticket redemption). Two deployments sharing a
    // session id shape still cannot accept each other's passes.
    const a = codec("key-a").issue(SESSION_ID, USER_ID);
    const b = codec("key-b").issue(SESSION_ID, USER_ID);
    expect(a.split(".")[2]).not.toBe(b.split(".")[2]);
  });

  test("issuing is deterministic and verify is repeatable (no state, no burn)", () => {
    // Unlike the ticket (single use), the pass is a session credential: verify
    // must not consume it. Two issues for the same triple are identical.
    const c = codec();
    expect(c.issue(SESSION_ID, USER_ID)).toBe(c.issue(SESSION_ID, USER_ID));
    const pass = c.issue(SESSION_ID, USER_ID);
    expect(c.verify(SESSION_ID, pass)).toEqual({ userId: USER_ID });
    expect(c.verify(SESSION_ID, pass)).toEqual({ userId: USER_ID });
  });
});

describe("previewSessionCookieHeader carries the signed pass", () => {
  test("a pass value rides the whitelist; attributes stay HttpOnly, SameSite=None; Secure, session-level", () => {
    const pass = codec().issue(SESSION_ID, USER_ID);
    const header = previewSessionCookieHeader(pass);
    expect(header).toContain(`${PREVIEW_SESSION_COOKIE}=${pass};`);
    expect(header).toContain("Path=/;");
    expect(header).toContain("HttpOnly");
    expect(header).toContain("SameSite=None");
    expect(header).toContain("Secure");
    // D9: no Max-Age, no Expires — the browser drops it at close.
    expect(header).not.toContain("Max-Age");
    expect(header).not.toContain("Expires");
  });

  test("an out-of-shape value still folds to empty — the whitelist never grew an injector", () => {
    for (const hostile of [
      "v1.user", // dot-carrying but neither credential shape → folds
      `v2.${Buffer.from(USER_ID).toString("base64url")}.${"A".repeat(43)}`, // wrong version prefix → folds
      `v1.${Buffer.from(USER_ID).toString("base64url")}.shortmac`, // MAC too short → folds
      "abc; x=1",
      "v1.user.mac; Path=/evil",
      "",
    ]) {
      const header = previewSessionCookieHeader(hostile);
      expect(header).toContain(`${PREVIEW_SESSION_COOKIE}=;`);
      expect(header).not.toContain("x=1");
      expect(header).not.toContain("/evil");
      expect(header.endsWith("; Secure")).toBe(true);
    }
  });
});

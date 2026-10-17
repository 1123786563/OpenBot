/**
 * Acceptance tests for the Opik control-plane authorization module (Issue #38 / DAG T32).
 *
 * The two questions this module owns are deliberately separate:
 *  - WHO may reach the Opik control surface (console, private APIs, connection
 *    config, management diagnostics, credentials) — answered from the application
 *    identity requireUser already established (T09's seam), platform role only.
 *  - WHAT may write into the ingestion path — the internal producer credential,
 *    and nothing a session can produce.
 *
 * These tests never touch process.env, the network, or a real Opik instance.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inspect } from "node:util";
import {
  authorizeControlPlane,
  type ControlPlaneAuthErrorCode,
  type ControlPlaneResource,
  InternalProducerCredential,
} from "../src/ai-observability/control-plane-auth";

const CODE_STATUS: Record<ControlPlaneAuthErrorCode, 401 | 403> = {
  AUTH_REQUIRED: 401,
  PLATFORM_QUALIFICATION_REQUIRED: 403,
  PRODUCER_AUTH_REQUIRED: 401,
  PRODUCER_NOT_AUTHORIZED_FOR_CONTROL_PLANE: 403,
  CONTROL_PLANE_RESOURCE_UNKNOWN: 403,
};

const RESOURCES: ControlPlaneResource[] = [
  "console",
  "private-api",
  "connection-config",
  "management-diagnostics",
  "credentials",
];

const platformAdmin = { id: "admin-1", role: "admin" as const };
const ordinaryUser = { id: "user-1", role: "user" as const };

function denied(
  access: ReturnType<typeof authorizeControlPlane>,
): asserts access is
  | { ok: false; status: 401; error: ControlPlaneAuthErrorCode }
  | { ok: false; status: 403; error: ControlPlaneAuthErrorCode } {
  expect(access.ok).toBe(false);
}

describe("InternalProducerCredential.issue", () => {
  test("issues an opaque, url-safe bearer of at least 256 bits", () => {
    const credential = InternalProducerCredential.issue();
    expect(credential.token.length).toBeGreaterThanOrEqual(43);
    expect(credential.token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test("two issuances never share material", () => {
    const first = InternalProducerCredential.issue();
    const second = InternalProducerCredential.issue();
    expect(first.token).not.toBe(second.token);
    expect(second.verify(first.token).ok).toBe(false);
  });

  test("a valid producer credential authorizes an ingestion write", () => {
    const credential = InternalProducerCredential.issue();
    expect(credential.verify(credential.token)).toEqual({ ok: true });
  });

  test("an unauthenticated write is rejected before anything else happens", () => {
    const credential = InternalProducerCredential.issue();
    for (const offered of [undefined, null, "", 0, 42, true, {}, [], ["x"]]) {
      const decision = credential.verify(offered);
      expect(decision).toEqual({
        ok: false,
        status: 401,
        error: "PRODUCER_AUTH_REQUIRED",
      });
    }
  });

  test("a wrong producer credential is rejected", () => {
    const credential = InternalProducerCredential.issue();
    const other = InternalProducerCredential.issue();
    const sameLengthButWrong = credential.token.replace(/./, (c) =>
      c === "A" ? "B" : "A",
    );
    for (const offered of [
      "wrong-token",
      other.token,
      `${credential.token}x`,
      ` ${credential.token}`,
      sameLengthButWrong,
    ]) {
      expect(credential.verify(offered).ok).toBe(false);
    }
  });

  test("verification never throws, whatever arrives", () => {
    const credential = InternalProducerCredential.issue();
    for (const offered of [
      undefined,
      null,
      "",
      "\u0000".repeat(1000),
      { toString: () => credential.token },
      Symbol("x"),
      credential,
    ]) {
      expect(() => credential.verify(offered as unknown)).not.toThrow();
    }
  });

  test("missing and wrong credentials answer identically — no near-miss signal", () => {
    const credential = InternalProducerCredential.issue();
    expect(credential.verify(undefined)).toEqual(
      credential.verify("almost-right"),
    );
  });
});

describe("the credential never leaks itself", () => {
  const credential = InternalProducerCredential.issue();

  test("JSON.stringify carries no token material", () => {
    const serialized = JSON.stringify(credential);
    expect(serialized).not.toContain(credential.token);
    expect(JSON.parse(serialized)).not.toHaveProperty("token");
  });

  test("toJSON is an explicit redaction", () => {
    expect(JSON.stringify(credential)).toBe(
      JSON.stringify("internal-producer-credential(redacted)"),
    );
  });

  test("console-style inspection carries no token material", () => {
    const inspected = inspect(credential);
    expect(inspected).not.toContain(credential.token);
    expect(inspected).toContain("redacted");
  });

  test("a spread or rest copy cannot smuggle the token", () => {
    const copy = { ...credential };
    expect(copy.token).toBeUndefined();
    expect(copy.verify).toBeUndefined();
  });

  test("denied decisions and their serialization carry no token material", () => {
    const decision = credential.verify("wrong");
    const serialized = JSON.stringify(decision);
    expect(serialized).not.toContain(credential.token);
    expect(serialized).toBe(
      '{"ok":false,"status":401,"error":"PRODUCER_AUTH_REQUIRED"}',
    );
  });

  test("the offered token rides in no property of a granted decision", () => {
    const granted = credential.verify(credential.token);
    expect(JSON.stringify(granted)).toBe('{"ok":true}');
  });
});

describe("authorizeControlPlane", () => {
  test("the platform role reaches every control-plane resource", () => {
    for (const resource of RESOURCES) {
      const access = authorizeControlPlane({
        actor: platformAdmin,
        resource,
      });
      expect(access).toEqual({ ok: true, actorId: platformAdmin.id });
    }
  });

  test("an ordinary user is denied every control-plane resource", () => {
    for (const resource of RESOURCES) {
      const access = authorizeControlPlane({
        actor: ordinaryUser,
        resource,
      });
      denied(access);
      expect(access.error).toBe("PLATFORM_QUALIFICATION_REQUIRED");
      expect(access.status).toBe(CODE_STATUS[access.error]);
    }
  });

  test("no session at all is 401", () => {
    for (const actor of [undefined, null]) {
      const access = authorizeControlPlane({
        actor,
        resource: "console",
      });
      denied(access);
      expect(access).toEqual({
        ok: false,
        status: 401,
        error: "AUTH_REQUIRED",
      });
    }
  });

  test("a malformed actor fails closed as unauthenticated", () => {
    const noId = authorizeControlPlane({
      actor: { id: "", role: "admin" },
      resource: "console",
    });
    expect(noId).toEqual({ ok: false, status: 401, error: "AUTH_REQUIRED" });

    const unknownRole = authorizeControlPlane({
      actor: { id: "u1", role: "superuser" as never },
      resource: "console",
    });
    denied(unknownRole);
    expect(unknownRole.error).toBe("PLATFORM_QUALIFICATION_REQUIRED");
  });

  test("an unrecognized resource fails closed", () => {
    const access = authorizeControlPlane({
      actor: platformAdmin,
      resource: "everything" as ControlPlaneResource,
    });
    denied(access);
    expect(access).toEqual({
      ok: false,
      status: 403,
      error: "CONTROL_PLANE_RESOURCE_UNKNOWN",
    });
  });

  test("every error code keeps its declared status in this suite", () => {
    // Exhaustiveness guard: the map above must name every code the module can answer.
    expect(Object.keys(CODE_STATUS).sort()).toEqual(
      [
        "AUTH_REQUIRED",
        "CONTROL_PLANE_RESOURCE_UNKNOWN",
        "PLATFORM_QUALIFICATION_REQUIRED",
        "PRODUCER_AUTH_REQUIRED",
        "PRODUCER_NOT_AUTHORIZED_FOR_CONTROL_PLANE",
      ].sort(),
    );
  });
});

describe("producer authentication cannot bypass application role checks", () => {
  const credential = InternalProducerCredential.issue();

  test("a valid producer credential is not an identity, so private APIs stay closed", () => {
    const access = authorizeControlPlane({
      actor: null,
      resource: "private-api",
      producerCredential: credential,
      offeredProducerToken: credential.token,
    });
    denied(access);
    expect(access).toEqual({
      ok: false,
      status: 403,
      error: "PRODUCER_NOT_AUTHORIZED_FOR_CONTROL_PLANE",
    });
  });

  test("the same refusal covers console, config, diagnostics and credentials", () => {
    for (const resource of RESOURCES) {
      const access = authorizeControlPlane({
        actor: null,
        resource,
        producerCredential: credential,
        offeredProducerToken: credential.token,
      });
      denied(access);
      expect(access.error).toBe("PRODUCER_NOT_AUTHORIZED_FOR_CONTROL_PLANE");
    }
  });

  test("an invalid offered token is just an unauthenticated caller", () => {
    const access = authorizeControlPlane({
      actor: undefined,
      resource: "private-api",
      producerCredential: credential,
      offeredProducerToken: "not-the-token",
    });
    expect(access).toEqual({
      ok: false,
      status: 401,
      error: "AUTH_REQUIRED",
    });
  });

  test("a producer credential does not elevate an ordinary user", () => {
    const access = authorizeControlPlane({
      actor: ordinaryUser,
      resource: "connection-config",
      producerCredential: credential,
      offeredProducerToken: credential.token,
    });
    denied(access);
    expect(access.error).toBe("PLATFORM_QUALIFICATION_REQUIRED");
  });

  test("a platform admin needs no producer credential", () => {
    const access = authorizeControlPlane({
      actor: platformAdmin,
      resource: "private-api",
    });
    expect(access).toEqual({ ok: true, actorId: platformAdmin.id });
  });

  test("a session cannot be spent as a producer credential", () => {
    // The ingestion door answers one question and takes no actor: a human session,
    // even a platform admin's, is not ingest material. Offering the session object
    // itself as the credential is rejected like any other non-token input.
    expect(credential.verify(platformAdmin).ok).toBe(false);
    expect(
      credential.verify({ ...platformAdmin, token: credential.token }).ok,
    ).toBe(false);
  });
});

describe("no second Opik user database", () => {
  const source = readFileSync(
    join(
      import.meta.dir,
      "..",
      "src",
      "ai-observability",
      "control-plane-auth.ts",
    ),
    "utf8",
  );

  test("the actor is the application's own role vocabulary", () => {
    expect(source).toMatch(/from "\.\.\/auth\/roles"/);
    expect(source).not.toMatch(
      /db\/schema|drizzle|userRoles|opik-port|opik-http/,
    );
  });

  test("credentials are minted internally, never read from env or upstream", () => {
    expect(source).not.toMatch(/process\.env/);
    expect(source).toMatch(/randomBytes/);
  });

  test("no unsafe issuance escape hatch is exported", () => {
    const names = [
      ...source.matchAll(/^export\s+(?:type|function|const|class)\s+(\w+)/gm),
    ].map((m) => m[1]);
    expect(
      names.filter((name) =>
        /unsafe|fromSecret|fromToken|issueFrom/i.test(name),
      ),
    ).toEqual([]);
  });
});

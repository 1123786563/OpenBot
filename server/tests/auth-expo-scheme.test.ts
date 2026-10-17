import { describe, expect, test } from "../../tests/support/e2e-compat";
import { createAuth } from "../src/auth/index";

/**
 * EXPO_APP_SCHEME decides which native client's redirect the deployment
 * trusts (the OpenMuse app registers openmuse://, the built-in one
 * openbotmobile://). These tests pin the two behaviours the mobile sign-in
 * depends on: a bare scheme is accepted and shapes the trusted origin, and
 * anything that is not a bare scheme is refused at boot rather than silently
 * widening the trust base.
 */

process.env.EXPO_PROJECT_ID = "00000000-0000-0000-0000-000000000000";

const config = {
  auth: {
    baseUrl: "https://openbot.test",
    secret: "test-secret-that-is-long-enough",
    trustedOrigins: ["https://app.openbot.test"],
    initialAdminEmails: [],
  },
  keyEncryptionKey: "A".repeat(44),
};

function database() {
  return {} as Parameters<typeof createAuth>[1];
}

describe("createAuth native scheme", () => {
  test("defaults to the built-in scheme when EXPO_APP_SCHEME is unset", () => {
    delete process.env.EXPO_APP_SCHEME;
    expect(() => createAuth(config, database())).not.toThrow();
  });

  test("accepts a bare scheme for the OpenMuse client", () => {
    process.env.EXPO_APP_SCHEME = "openmuse";
    expect(() => createAuth(config, database())).not.toThrow();
  });

  test("refuses a value that is not a bare scheme", () => {
    process.env.EXPO_APP_SCHEME = "https://evil.example";
    expect(() => createAuth(config, database())).toThrow(
      /EXPO_APP_SCHEME must be a bare URL scheme/,
    );
    process.env.EXPO_APP_SCHEME = "open muse";
    expect(() => createAuth(config, database())).toThrow(
      /EXPO_APP_SCHEME must be a bare URL scheme/,
    );
    delete process.env.EXPO_APP_SCHEME;
  });
});

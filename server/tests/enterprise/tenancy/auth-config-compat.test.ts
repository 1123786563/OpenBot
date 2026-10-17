import { describe, expect, test } from "../../../../tests/support/e2e-compat";
import { type AuthBootstrapConfig, createAuth } from "../../../src/auth";
import { loadConfig, loadIdentityConfig } from "../../../src/config";
import type { Database } from "../../../src/db/client";
import { testEnvironment } from "../../support/environment";

/*
 * Old-path compatibility for the narrowed auth factory, per plan 02 §7 T3-B step 3.
 *
 * `createAuth` used to demand a whole DeploymentConfig, which forced every caller that had only
 * sign-in settings to invent the rest — the enterprise entry would have had to fabricate an
 * Intelligence runtime it does not have. The factory actually reads exactly two fields
 * (`config.auth`, `config.keyEncryptionKey`), so the parameter is now AuthBootstrapConfig =
 * Pick<DeploymentConfig, "auth" | "keyEncryptionKey"> and these tests prove the split at runtime:
 * the minimal object constructs the factory with NO cast, the FULL legacy config still fits the
 * same parameter unchanged, and the legacy loadConfig keeps its own runtime validation.
 *
 * Construction is lazy — nothing queries the database until a request arrives — so the database
 * parameter here is a stub that would fail loudly if that ever stopped being true.
 */

/** The identity-provider fields of the shared test environment, picked one by one (never spread). */
const base = testEnvironment();
const IDENTITY_ONLY = {
  GOOGLE_OAUTH_CLIENT_ID: base.GOOGLE_OAUTH_CLIENT_ID,
  GOOGLE_OAUTH_CLIENT_SECRET: base.GOOGLE_OAUTH_CLIENT_SECRET,
  BETTER_AUTH_SECRET: base.BETTER_AUTH_SECRET,
  BETTER_AUTH_URL: base.BETTER_AUTH_URL,
  INITIAL_ADMIN_EMAILS: base.INITIAL_ADMIN_EMAILS,
};

/** A stub that is never queried during construction and would throw if it ever were. */
const unusedDatabase = {} as Database;

describe("createAuth on the narrowed bootstrap config", () => {
  test("constructs from { auth, keyEncryptionKey } alone, with no cast", () => {
    const auth = loadIdentityConfig(IDENTITY_ONLY);
    if (!auth)
      throw new Error("the identity fields must resolve an AuthConfig");

    // Deliberately NOT `as DeploymentConfig`: this assignment only compiles because the two
    // fields below are exactly what the factory reads.
    const bootstrap: AuthBootstrapConfig = {
      auth,
      keyEncryptionKey: "b3BlbmJvdC1wcm9kdWN0aW9uLXRlc3Qta2V5LTMyMzI=",
    };

    const instance = createAuth(bootstrap, unusedDatabase);
    expect(typeof instance.handler).toBe("function");
    expect(typeof instance.api.getSession).toBe("function");
  });

  test("the full legacy DeploymentConfig still satisfies the narrowed parameter", () => {
    // This is the shape server/src/index.ts passes today: a complete DeploymentConfig. A Pick
    // parameter accepts it structurally, so the legacy boot path needs no change.
    const legacy = loadConfig(testEnvironment());
    if (!legacy.auth)
      throw new Error("the test environment must configure sign-in");

    const instance = createAuth(legacy, unusedDatabase);
    expect(typeof instance.handler).toBe("function");
  });
});

describe("the legacy configuration path keeps its runtime validation", () => {
  test("loadConfig still refuses an environment that has no Intelligence runtime", () => {
    expect(() =>
      loadConfig({
        ...IDENTITY_ONLY,
        DATABASE_URL: "postgres://openbot:openbot@localhost:5432/openbot",
        KEY_ENCRYPTION_KEY: "b3BlbmJvdC1wcm9kdWN0aW9uLXRlc3Qta2V5LTMyMzI=",
      }),
    ).toThrow(/CopilotKit Intelligence is required/);
  });
});

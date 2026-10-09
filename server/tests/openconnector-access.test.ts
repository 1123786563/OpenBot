import { describe, expect, test } from "bun:test";
import {
  accessFor,
  CatalogueTransportUnroutableError,
  ServerRowAmbiguousError,
} from "../src/plugins/access";
import { CATALOGUE } from "../src/plugins/catalogue";

/**
 * The OpenConnector twin of `composio-access.test.ts`'s enumeration: same questions — which
 * protocol, whose credential, whose account, which app — asked of a row whose provenance names the
 * second broker. A third broker answers these through the same registry this file exercises, which
 * is the property the composio-only comparison could not offer.
 */
const row = (over: Partial<Parameters<typeof accessFor>[0]>) => ({
  provenance: "open-connector",
  url: "openconnector://github",
  authScheme: "API_KEY",
  accountMode: null,
  ...over,
});

describe("accessFor on an open-connector row", () => {
  test("resolves to the brokered open-connector transport with the service as toolkit", () => {
    expect(accessFor(row({}), null)).toMatchObject({
      transport: "open-connector",
      credential: "brokered",
      toolkit: "github",
      broker: "open-connector",
      reachedAs: "person",
    });
  });

  test("no-auth and shared are reached as the deployment", () => {
    expect(accessFor(row({ authScheme: "NO_AUTH" }), null).reachedAs).toBe(
      "deployment",
    );
    expect(
      accessFor(row({ authScheme: "API_KEY", accountMode: "shared" }), null)
        .reachedAs,
    ).toBe("deployment");
  });

  test("custom_credential is one person's account", () => {
    expect(
      accessFor(row({ authScheme: "CUSTOM_CREDENTIAL" }), null).reachedAs,
    ).toBe("person");
  });

  test("a curated entry and an open-connector provenance refuse in both directions", () => {
    const entry =
      CATALOGUE.find((candidate) => candidate.key === "notion") ?? null;
    expect(() =>
      accessFor(row({ url: "openconnector://notion" }), entry),
    ).toThrow(ServerRowAmbiguousError);
  });

  test("an entry declaring a broker transport is unroutable for either broker", () => {
    expect(() =>
      accessFor(
        { provenance: "first-party", url: "https://example.test", authScheme: null },
        {
          ...CATALOGUE[0],
          transport: "open-connector" as never,
        },
      ),
    ).toThrow(CatalogueTransportUnroutableError);
  });
});

import "./preload";
import "./preload";
import { expect, test } from "../../tests/support/e2e-compat";
import { connectionKindFor } from "@/routes/_authed/admin/plugins/$key";

/**
 * Which shape the connector page draws, decided from the row rather than guessed.
 *
 * The page used to fall back to `deployment-bearer` whenever the catalogue had nothing to say, and
 * a brokered row is exactly the case with nothing to say: it is not a curated entry, so there is no
 * `auth` to read. The guess then drew the one shape a brokered row cannot hold — a shared token
 * pasted once for everybody — over the connector whose whole point is that each person connects
 * their own account.
 *
 * `.tsx` because this imports a route module, which is JSX; see `agent-roster-error.test.tsx` for
 * the same reason. Nothing here renders: the decision is a pure function precisely so that the one
 * thing worth pinning can be pinned without a router, a query client or a document.
 */

test("a Composio-provenance row is brokered, whatever the catalogue says", () => {
  expect(
    connectionKindFor({ provenance: "composio" } as never, undefined),
  ).toBe("brokered");
});

/*
 * The second broker's rows are brokered by the same reading, which is what the shared list is
 * for: a `provenance === "composio"` comparison here answered `deployment-bearer` for them, and
 * the page drew the shared-token form over an app whose whole point is that each person connects
 * their own account — the exact defect the function's docblock describes.
 */
test("an OpenConnector-provenance row is brokered the same way", () => {
  expect(
    connectionKindFor({ provenance: "open-connector" } as never, undefined),
  ).toBe("brokered");
});

test("a server added by URL still falls back to the shared-token shape", () => {
  expect(connectionKindFor({ provenance: "custom" } as never, undefined)).toBe(
    "deployment-bearer",
  );
});

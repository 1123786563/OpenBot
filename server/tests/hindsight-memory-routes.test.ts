import { describe, expect, test } from "../../tests/support/bun-test-compat";
import { createHindsightMemoryRoutes } from "../src/hindsight/routes";

/*
 * FIX-OCR3 (O3-M6): the scope resolver's own vocabulary on this surface. An unresolved
 * company/workspace selection is a 400 the caller can act on — the same mapping the host
 * memory family and the ops face already carry — never the 503 "unavailable" that told the
 * person to retry a request no retry could fix while also logging a server fault that was
 * none. Mounted standalone: the routes are a pure Hono face, and the scope arrives by
 * injection, so the mapping is pinnable without a database.
 */

const refused = async (code: string) => {
  const routes = createHindsightMemoryRoutes({
    // Never reached for the status read below: the resolver refuses before any seam call.
    preferences: {} as never,
    sourceBound: {} as never,
    syncQueue: {} as never,
    resolveScope: () => Promise.reject(new Error(code)),
  });
  const response = await routes.request("/status/preference/row-1", {
    method: "GET",
  });
  return response;
};

describe("FIX-OCR3 — unresolved selection answers 400, never a server fault", () => {
  test("TENANT_REQUIRED is a caller state, not an unavailable memory", async () => {
    const response = await refused("TENANT_REQUIRED");
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Select the company and workspace first.",
    });
  });

  test("WORKSPACE_REQUIRED maps the same way", async () => {
    const response = await refused("WORKSPACE_REQUIRED");
    expect(response.status).toBe(400);
  });

  test("the family's existing answers stand: AUTH_REQUIRED 401, revoked scopes 403", async () => {
    expect((await refused("AUTH_REQUIRED")).status).toBe(401);
    expect((await refused("SCOPE_REVOKED")).status).toBe(403);
    expect((await refused("TENANT_FORBIDDEN")).status).toBe(403);
    expect((await refused("UNVERIFIED_SCOPE")).status).toBe(403);
  });
});

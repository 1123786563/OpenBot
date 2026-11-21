import { expect, test } from "bun:test";
import { Hono } from "hono";
import { corsairWebReturn } from "../src/plugins/corsair/oauth-return";

test("Corsair OAuth returns browser navigations to Connections and leaves JSON callbacks available", async () => {
  for (const provider of ["github", "slack"] as const) {
    const app = new Hono();
    app.get("/callback", (c) => {
      const outcome = c.req.query("error") ? "failed" : "connected";
      return corsairWebReturn(c, provider, outcome) ?? c.json({ outcome });
    });

    for (const outcome of ["connected", "failed"] as const) {
      const path =
        outcome === "failed"
          ? "/callback?error=access_denied"
          : "/callback?code=example&state=example";
      const browser = await app.request(path, {
        headers: { Accept: "text/html,application/xhtml+xml,*/*;q=0.8" },
      });
      expect(browser.status).toBe(303);
      expect(browser.headers.get("Location")).toBe(
        `/connections/${provider}?corsair=${outcome}`,
      );

      const api = await app.request(path, {
        headers: { Accept: "application/json" },
      });
      expect(await api.json()).toEqual({ outcome });
    }
  }
});

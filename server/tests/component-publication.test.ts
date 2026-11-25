import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../src/auth/guards";
import type { AuditStore } from "../src/audit";
import { createComponentRoutes } from "../src/components/routes";
import type { ComponentStore } from "../src/components/store";

/**
 * The switch that decides what every Bot may draw, held closed on doubt.
 *
 * The route used to read `body?.published !== false`, so an empty body, invalid JSON,
 * `{}`, `"no"`, `0` and `null` all evaluated to true and *published* the component with a
 * 200 and a `component.published` audit row. Only an explicit `false` unpublished. The
 * sibling toggles (`PUT /routines/:id/enabled`, channel pin/busy) all answer 400 on a
 * non-boolean; this one did the opposite of safe.
 */

const ADMIN = {
  id: "u1",
  email: "admin@openbot.test",
  role: "admin",
} as const;

/** What a publication left behind, and what it put on the trail. */
function harness(trail?: { fail: boolean; rows: unknown[] }) {
  const calls: { action: "publish" | "unpublish"; name: string }[] = [];
  const store = {
    publish: async (name: string) => {
      calls.push({ action: "publish", name });
    },
    unpublish: async (name: string) => {
      calls.push({ action: "unpublish", name });
    },
  } as unknown as ComponentStore;
  const auditStore: AuditStore | undefined = trail
    ? {
        insert: async (event) => {
          if (trail.fail) throw new Error("the trail is unavailable");
          trail.rows.push(event);
        },
      }
    : undefined;

  const asAdmin: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", { ...ADMIN });
    await next();
  };

  const hono = new Hono().route(
    "/components",
    createComponentRoutes(store, asAdmin, auditStore, async () => true),
  );
  return { calls, hono };
}

function post(body: string | null) {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body === null ? {} : { body }),
  };
}

describe("publishing a component", () => {
  test("publishes on an explicit true", async () => {
    const { calls, hono } = harness();
    const response = await hono.request(
      "http://t/components/showActivityReport/publication",
      post(JSON.stringify({ published: true })),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ published: true });
    expect(calls).toEqual([{ action: "publish", name: "showActivityReport" }]);
  });

  test("unpublishes on an explicit false", async () => {
    const { calls, hono } = harness();
    const response = await hono.request(
      "http://t/components/showActivityReport/publication",
      post(JSON.stringify({ published: false })),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ published: false });
    expect(calls).toEqual([
      { action: "unpublish", name: "showActivityReport" },
    ]);
  });

  test.each([
    ["an empty body", ""],
    ["invalid JSON", "{not json"],
    ["an empty object", "{}"],
    ['the string "no"', '{"published":"no"}'],
    ['the string "true"', '{"published":"true"}'],
    ["zero", '{"published":0}'],
    ["one", '{"published":1}'],
    ["null", '{"published":null}'],
    ["an object", '{"published":{}}'],
    ["an array", '{"published":[]}'],
  ])("refuses %s with 400 and changes nothing", async (_name, body) => {
    const { calls, hono } = harness();
    const response = await hono.request(
      "http://t/components/showActivityReport/publication",
      post(body),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "published must be true or false.",
    });
    expect(calls).toEqual([]);
  });

  test("a missing body changes nothing", async () => {
    const { calls, hono } = harness();
    const response = await hono.request(
      "http://t/components/showActivityReport/publication",
      { method: "POST" },
    );

    expect(response.status).toBe(400);
    expect(calls).toEqual([]);
  });
});

describe("a publication the trail could not record", () => {
  test.each([
    [
      "published",
      true,
      "component.published",
      "The component is published, but Audit couldn't record the change. Try again to record it.",
    ],
    [
      "unpublished",
      false,
      "component.unpublished",
      "The component is unpublished, but Audit couldn't record the change. Try again to record it.",
    ],
  ])(
    "says the component is %s, which is what to save again",
    async (_state, published, eventType, error) => {
      const trail = { fail: true, rows: [] as unknown[] };
      const { calls, hono } = harness(trail);
      const response = await hono.request(
        "http://t/components/showActivityReport/publication",
        post(JSON.stringify({ published })),
      );

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error, published });
      expect(calls).toEqual([
        {
          action: published ? "publish" : "unpublish",
          name: "showActivityReport",
        },
      ]);

      // Saving the same thing again is the retry, and this time the trail has the one row.
      trail.fail = false;
      const again = await hono.request(
        "http://t/components/showActivityReport/publication",
        post(JSON.stringify({ published })),
      );
      expect(again.status).toBe(200);
      await expect(again.json()).resolves.toEqual({ published });
      expect(trail.rows).toHaveLength(1);
      expect(trail.rows[0]).toMatchObject({
        eventType,
        targetType: "component",
        targetId: "showActivityReport",
        actorUserId: ADMIN.id,
        payload: { actor: ADMIN.email },
      });
    },
  );
});

describe("a publication the trail records", () => {
  test.each([
    ["publishes", true, "component.published"],
    ["unpublishes", false, "component.unpublished"],
  ])(
    "%s with one row that names who changed it",
    async (_verb, published, eventType) => {
      const trail = { fail: false, rows: [] as unknown[] };
      const { hono } = harness(trail);
      const response = await hono.request(
        "http://t/components/showActivityReport/publication",
        post(JSON.stringify({ published })),
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ published });
      expect(trail.rows).toHaveLength(1);
      expect(trail.rows[0]).toMatchObject({
        eventType,
        targetType: "component",
        targetId: "showActivityReport",
        actorUserId: ADMIN.id,
        payload: { actor: ADMIN.email },
      });
    },
  );
});

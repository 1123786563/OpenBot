import { expect, test } from "bun:test";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { testEnvironment } from "./support/environment";

const linkPath = "/api/admin/audit-events/openobserve";
const destination = "https://observe.example.test/ops/";

function auditApp(url: string | undefined, role: "admin" | "user" | null) {
  return createApp(
    loadConfig(testEnvironment({ OPENBOT_OPENOBSERVE_URL: url })),
    {
      handler: () => new Response(null, { status: 204 }),
      api: {
        getSession: async () =>
          role ? { user: { id: role, email: `${role}@openbot.test` } } : null,
      },
    },
    { rolesForUser: async () => (role ? [role] : []) },
    { list: async () => ({ events: [] }) },
  );
}

test("the platform admin receives only the configured destination", async () => {
  const response = await auditApp(destination, "admin").request(
    `${linkPath}?bot=inbox&query=private&url=https://other.example.test`,
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(await response.json()).toEqual({ url: destination });
});

test.each([
  ["workspace member", "user", 403],
  ["signed-out visitor", null, 401],
] as const)("%s cannot obtain the link", async (_label, role, status) => {
  const response = await auditApp(destination, role).request(linkPath);
  expect(response.status).toBe(status);
  expect(await response.text()).not.toContain(destination);
});

test.each([
  undefined,
  "",
  "javascript:alert(1)",
  "//observe.example.test",
  "https:///observe.example.test",
  "https://operator:password@observe.example.test",
  "https://observe.example.test/?query=private",
  "https://observe.example.test/#search",
  "https://observe.example.test/?",
  "https://observe.example.test/#",
])(
  "keeps Audit available with an absent or invalid setting (%s)",
  async (url) => {
    const app = auditApp(url, "admin");
    const link = await app.request(linkPath);
    expect(link.status).toBe(200);
    expect(await link.json()).toEqual({ url: null });

    const audit = await app.request("/api/admin/audit-events?bot=inbox");
    expect(audit.status).toBe(200);
    expect(await audit.json()).toEqual({ events: [] });
  },
);

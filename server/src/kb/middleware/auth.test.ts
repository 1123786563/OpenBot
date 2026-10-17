import { describe, expect, test } from "../../../../tests/support/e2e-compat";
import { loadConfig, parseAPIKeys } from "../config";
import { authenticate, canAccessKB, canAdmin, canRead, canWrite } from "./auth";

const config = {
  ...loadConfig,
  apiKeys: parseAPIKeys(
    "sk-read:t1:read; sk-write:t1:write; sk-admin:t1:admin; sk-scoped:t1:read:kb1,kb2",
  ),
} as ReturnType<typeof loadConfig>;

describe("authenticate", () => {
  test("resolves identity from a known key", () => {
    const id = authenticate(config, "sk-admin");
    expect(id?.tenantId).toBe("t1");
    expect(id?.role).toBe("admin");
  });

  test("rejects empty and unknown keys", () => {
    expect(authenticate(config, "")).toBeNull();
    expect(authenticate(config, "sk-nope")).toBeNull();
    expect(authenticate(config, "  sk-admin  ")?.role).toBe("admin");
  });

  test("carries the kb scope whitelist", () => {
    const id = authenticate(config, "sk-scoped");
    expect([...(id?.kbScope ?? [])]).toEqual(["kb1", "kb2"]);
  });
});

describe("role matrix", () => {
  test("read/write/admin ladder", () => {
    expect(canRead("read")).toBe(true);
    expect(canWrite("read")).toBe(false);
    expect(canAdmin("read")).toBe(false);

    expect(canRead("write")).toBe(true);
    expect(canWrite("write")).toBe(true);
    expect(canAdmin("write")).toBe(false);

    expect(canAdmin("admin")).toBe(true);
  });
});

describe("canAccessKB", () => {
  const kb = { tenantId: "t1", id: "kb1" };

  test("same tenant full access", () => {
    expect(canAccessKB(authenticate(config, "sk-admin")!, kb)).toBe(true);
  });

  test("cross-tenant is denied (caller turns it into 404)", () => {
    const outsider = { ...authenticate(config, "sk-admin")!, tenantId: "t2" };
    expect(canAccessKB(outsider, kb)).toBe(false);
  });

  test("scoped key only reaches whitelisted kbs", () => {
    const scoped = authenticate(config, "sk-scoped")!;
    expect(canAccessKB(scoped, kb)).toBe(true);
    expect(canAccessKB(scoped, { tenantId: "t1", id: "kb9" })).toBe(false);
  });
});

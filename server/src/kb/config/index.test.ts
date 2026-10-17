import { describe, expect, test } from "../../../../tests/support/e2e-compat";
import { parseAPIKeys } from "./index";

describe("parseAPIKeys", () => {
  test("parses single key with tenant and role", () => {
    const keys = parseAPIKeys("sk-a:tenant-a:admin");
    expect(keys.size).toBe(1);
    const entry = keys.get("sk-a");
    expect(entry?.tenantId).toBe("tenant-a");
    expect(entry?.role).toBe("admin");
    expect(entry?.kbIds.size).toBe(0); // 空 = 租户内全库
  });

  test("splits multiple keys on ; and trims whitespace", () => {
    const keys = parseAPIKeys(
      " sk-a:tenant-a:admin ; sk-b:tenant-b:read ; ; sk-c:tenant-a:write ",
    );
    expect([...keys.keys()]).toEqual(["sk-a", "sk-b", "sk-c"]);
  });

  test("carries the kb scope whitelist, dropping empties", () => {
    const keys = parseAPIKeys("sk-a:tenant-a:read:kb1, kb2 ,,");
    expect([...(keys.get("sk-a")?.kbIds ?? [])]).toEqual(["kb1", "kb2"]);
  });

  test("skips entries with fewer than three fields or bad roles", () => {
    const keys = parseAPIKeys(
      "onlykey:tenant; key-only; sk-ok:tenant-a:read; sk-bad:tenant-a:superuser",
    );
    expect(keys.size).toBe(1);
    expect(keys.has("sk-ok")).toBe(true);
  });

  test("empty raw string yields an empty map", () => {
    expect(parseAPIKeys("").size).toBe(0);
    expect(parseAPIKeys(" ; ; ").size).toBe(0);
  });
});

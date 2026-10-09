import { describe, expect, test } from "bun:test";
import { scopedKey } from "../../../../shared/enterprise/contracts";

/*
 * The tenant-scoped key contract, per plan 02 §6 T2-D.
 *
 * The key is pure JSON encoding — no Node Buffer, no per-segment separators — so the server, the
 * web app and the desktop app derive the identical string from the identical triple. The property
 * that matters: no choice of tenantId, kind or id values, separators included, can make two
 * different triples produce the same key. This file only delivers the contract and the collision
 * tests; what the key locates (object paths, cache entries) is never an authorization decision —
 * retrieval candidates must clear the ACL path (T2-B/T2-C) before any downstream use.
 */

describe("plan 02 §6 T2-D: tenant keys cannot collide through separators", () => {
  test("a separator inside one segment cannot impersonate another split", () => {
    expect(scopedKey("a:b", "c", "d")).not.toBe(scopedKey("a", "b:c", "d"));
    expect(scopedKey("a", "b", "c:d")).not.toBe(scopedKey("a", "b:c", "d"));
    expect(scopedKey("a:b", "c", "d")).not.toBe(scopedKey("a", "b", "c:d"));
  });

  test("different tenants, kinds and ids always produce different keys", () => {
    expect(scopedKey("a", "document", "r")).not.toBe(
      scopedKey("b", "document", "r"),
    );
    expect(scopedKey("a", "document", "r")).not.toBe(
      scopedKey("a", "folder", "r"),
    );
    expect(scopedKey("a", "document", "r")).not.toBe(
      scopedKey("a", "document", "s"),
    );
  });

  test("the encoding is plain JSON of the ordered triple, identical everywhere", () => {
    expect(scopedKey("a", "document", "r")).toBe('["a","document","r"]');
    expect(scopedKey('say "hi"', "document", "r")).toBe(
      '["say \\"hi\\"","document","r"]',
    );
    expect(scopedKey("a", "document", "r")).toBe(
      JSON.stringify(["a", "document", "r"]),
    );
  });
});

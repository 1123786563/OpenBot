import { describe, expect, test } from "bun:test";
import { DrizzleQueryError } from "drizzle-orm/errors";
import { databaseComplaint, isQueryFailure, reasonWithoutStatement } from "../src/db/query-failure";

/**
 * The query-failure gate's whole safety argument is "drizzle hangs query/params as
 * own properties and inlines both into the message". That is the installed driver
 * version's constructor shape, not a published contract — this file pins it, so a
 * drizzle upgrade that moves either half fails here instead of leaking a statement
 * (and, on the rotation path, the encrypted credential envelope) into a quoted
 * message.
 */
describe("the installed drizzle error shape the query-failure gate trusts", () => {
  test("a DrizzleQueryError carries query/params as own properties and inlines both", () => {
    const error = new DrizzleQueryError(
      "select * from mcp_user_credentials where id = $1",
      ["ENVELOPE"],
      new Error("duplicate key value violates unique constraint"),
    );
    expect(Object.hasOwn(error, "query")).toBe(true);
    expect(Object.hasOwn(error, "params")).toBe(true);
    expect((error as unknown as Error).message).toContain("Failed query");
    expect((error as unknown as Error).message).toContain("ENVELOPE");
  });

  test("the gate classifies it, and the quoted complaint carries neither statement nor bound value", () => {
    const error = new DrizzleQueryError(
      "select * from mcp_user_credentials where id = $1",
      ["ENVELOPE"],
      new Error("duplicate key value violates unique constraint"),
    );
    expect(isQueryFailure(error)).toBe(true);
    expect(databaseComplaint(error)).not.toContain("mcp_user_credentials");
    expect(databaseComplaint(error)).not.toContain("ENVELOPE");
    expect(databaseComplaint(error)).toContain("duplicate key");
    expect(reasonWithoutStatement(error)).toBe(databaseComplaint(error));
  });

  test("a lookalike without the message shape is NOT a query failure (drift fails loud)", () => {
    const lookalike = Object.assign(new Error("something else"), {
      query: "select 1",
      params: [],
    });
    expect(isQueryFailure(lookalike)).toBe(false);
  });
});

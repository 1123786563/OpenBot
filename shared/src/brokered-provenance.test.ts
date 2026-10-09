import { describe, expect, test } from "bun:test";
import {
  BROKERED_PROVENANCES,
  isBrokeredProvenance,
} from "./brokered-provenance";

describe("brokered provenances", () => {
  test("composio and open-connector are the members", () => {
    expect(BROKERED_PROVENANCES).toEqual(["composio", "open-connector"]);
  });
  test("narrows without admitting anything else", () => {
    expect(isBrokeredProvenance("composio")).toBe(true);
    expect(isBrokeredProvenance("open-connector")).toBe(true);
    expect(isBrokeredProvenance("first-party")).toBe(false);
    expect(isBrokeredProvenance("custom")).toBe(false);
    expect(isBrokeredProvenance("openconnector")).toBe(false);
  });
});

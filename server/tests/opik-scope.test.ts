import { describe, expect, test } from "bun:test";
import {
  ObservationScopeError,
  type BotOwnership,
  type ObservationScopeErrorCode,
} from "../src/ai-observability/contracts";

const STATUS: Record<ObservationScopeErrorCode, 400 | 401 | 403> = {
  AUTH_REQUIRED: 401,
  BOT_REQUIRED: 400,
  OWNERSHIP_REQUIRED: 403,
  ENTERPRISE_SCOPE_UNSUPPORTED: 403,
};

describe("ObservationScopeError", () => {
  test("the code is the contract and the message is just the code", () => {
    for (const code of Object.keys(STATUS) as ObservationScopeErrorCode[]) {
      const error = new ObservationScopeError(code, STATUS[code]);
      expect(error.code).toBe(code);
      expect(error.message).toBe(code);
      expect(error.status).toBe(STATUS[code]);
      expect(error).toBeInstanceOf(Error);
    }
  });

  test("the three ownership answers are exhaustive", () => {
    const all: BotOwnership[] = ["owner", "admin", "none"];
    expect(all).toHaveLength(3);
  });
});

import { describe, expect, test } from "../../tests/support/e2e-compat";
import { workerStatus } from "../src/status";

describe("worker status", () => {
  test("reports idle, having no jobs to run", () => {
    expect(workerStatus()).toEqual({ status: "idle" });
  });
});

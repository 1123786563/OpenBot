import "./preload";
import { expect, test } from "../../tests/support/e2e-compat";
import { queryClient } from "../src/query-client";

test("provides a shared query client for application server state", () => {
  expect(queryClient.getDefaultOptions().queries?.retry).toBe(1);
});

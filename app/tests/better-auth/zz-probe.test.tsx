import "../preload";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  afterAll,
  beforeAll,
  expect,
  test,
} from "../../../tests/support/e2e-compat";

let fetchHandler: typeof globalThis.fetch;
const originalFetch = globalThis.BunTEST_ORIGINAL_FETCH ?? globalThis.fetch;

beforeAll(async () => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    fetchHandler(input, init)) as typeof globalThis.fetch;
  fetchHandler = originalFetch;
});

afterAll(() => {
  GlobalRegistrator.unregister();
  globalThis.fetch = originalFetch;
});

test("probe_collects", () => {
  expect(true).toBe(true);
});

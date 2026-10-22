import "./preload";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, beforeAll, test, expect } from "../../tests/support/e2e-compat";
let originalObserver: typeof ResizeObserver;
beforeAll(() => {
  GlobalRegistrator.register();
  originalObserver = globalThis.ResizeObserver;
});
class FakeRO { observe(){} unobserve(){} disconnect(){} }
globalThis.ResizeObserver = FakeRO as unknown as typeof ResizeObserver;
afterAll(async () => {
  globalThis.ResizeObserver = originalObserver;
  await GlobalRegistrator.unregister();  // await 变体
});
test("lifecycle probe b", () => { expect(true).toBe(true); });

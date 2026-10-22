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
afterAll(() => {
  globalThis.ResizeObserver = originalObserver;
  GlobalRegistrator.unregister();  // 故意不 await,复刻 detail-panel
});
test("lifecycle probe a", () => { expect(true).toBe(true); });

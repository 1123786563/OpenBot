import "./preload";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, expect, test } from "../../tests/support/e2e-compat";
beforeAll(() => { GlobalRegistrator.register(); });
afterEach(() => { cleanup(); });
afterAll(() => { GlobalRegistrator.unregister(); });
test("probe d: render plain div only", () => {
  const v = render(<div>hi</div>);
  expect(v.getByText("hi")).toBeTruthy();
});

import "./preload";
import {
  afterAll,
  afterEach,
  beforeAll,
  expect,
  test,
} from "../../tests/support/e2e-compat";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { settleReactWork } from "./settle-react-work";
import { cleanup, render } from "@testing-library/react";
import i18n from "@/lib/i18n";
import { ModelBillingPaths } from "@/components/admin/model-billing-paths";

/*
 * Bifrost 09.4 (#289): the administrator's models section names the two billing paths
 * apart. What the block owes — before any styling question — is what this file pins:
 *
 * - both path classes are always named (credit-billed and subscription harness), so the
 *   screen answers "what am I looking at" even when only one is in use;
 * - the path the server reports is the one marked Active, and the other says it is not in
 *   use — the screen never guesses the verdict;
 * - the subscription path's own description carries the boundary in words a reader can
 *   hold: billed by the subscription, no credit reservation, never a balance-exhaustion
 *   fallback.
 */

beforeAll(async () => {
  GlobalRegistrator.register();
  await i18n.changeLanguage("en");
});
afterEach(() => cleanup());
afterAll(async () => {
  await settleReactWork();
  void i18n.changeLanguage("en");
  GlobalRegistrator.unregister();
});

const CREDIT_TITLE = "Credit-billed path";
const SUBSCRIPTION_TITLE = "Subscription harness path";

test("both billing paths are named, and the credit path is the active one when reported", () => {
  const view = render(
    <ModelBillingPaths billing="credit" model="openai/gpt-5.6-terra" />,
  );
  expect(view.getByText(CREDIT_TITLE)).toBeTruthy();
  expect(view.getByText(SUBSCRIPTION_TITLE)).toBeTruthy();
  // The active/inactive marks answer per path, never as one blur.
  const marks = view.getAllByText(/^(Active|Not in use)$/);
  expect(marks).toHaveLength(2);
  const container = view.container.textContent ?? "";
  expect(container).toContain("Active");
  expect(container).toContain("Not in use");
  expect(container.indexOf("Active")).toBeLessThan(
    container.indexOf("Not in use"),
  );
  // The subscription boundary is visible in words, not implied.
  expect(container).toContain(
    "never a path a credit-exhausted call falls back to",
  );
});

test("the subscription harness path is the active one when the server reports it", () => {
  const view = render(
    <ModelBillingPaths
      billing="subscription"
      model="claude/claude-sonnet-4-5"
    />,
  );
  const container = view.container.textContent ?? "";
  expect(container).toContain(SUBSCRIPTION_TITLE);
  expect(container).toContain(CREDIT_TITLE);
  // The marks move with the report: the credit row reads Not in use, the
  // subscription row Active — exactly one Active on the page.
  expect(container.indexOf("Not in use")).toBeLessThan(
    container.indexOf("Active"),
  );
  expect(view.getAllByText("Active")).toHaveLength(1);
  expect(view.getAllByText("Not in use")).toHaveLength(1);
  expect(container).toContain("no credit reservation");
});

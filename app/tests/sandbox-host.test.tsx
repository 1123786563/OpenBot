import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { SandboxHost } from "@/components/gallery/sandbox-host";
import { settleReactWork } from "./settle-react-work";

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
});

afterEach(cleanup);

afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

function Fragile(): ReactNode {
  throw new Error("broken markup");
}

test("a title and its host action are drawn in Astryx above the sandbox", () => {
  const view = render(
    <SandboxHost
      title="Refund card"
      action={<button type="button">Back to editor</button>}
    >
      <p data-testid="sandbox">sandbox</p>
    </SandboxHost>,
  );
  const host = view.getByText("sandbox").closest("[data-sandbox-host]");
  expect(host?.className).toMatch(/astryx-/);
  expect(view.getByText("Refund card")).toBeTruthy();
  expect(view.getByText("Back to editor")).toBeTruthy();
});

test("a sandbox that fails to render shows an Astryx error in its place", () => {
  const quiet = spyOn(console, "error").mockImplementation(() => {});
  const view = render(
    <>
      <p>Earlier message</p>
      <SandboxHost title="Refund card">
        <Fragile />
      </SandboxHost>
      <p>Later message</p>
    </>,
  );
  const failed = view.getByText(/Couldn't show/);
  expect(failed.closest("[data-sandbox-host]")?.className).toMatch(/astryx-/);
  expect(view.getByText("Earlier message")).toBeTruthy();
  expect(view.getByText("Later message")).toBeTruthy();
  quiet.mockRestore();
});

test("a refused or unloaded component says so in Astryx instead of drawing", () => {
  const view = render(
    <SandboxHost
      status={{
        kind: "refused",
        message: "Not shown: Refund card",
        description: "An admin grants components per Bot.",
      }}
      title="Refund card"
    />,
  );
  expect(view.getByText("Not shown: Refund card")).toBeTruthy();
  expect(
    view.getByText("Not shown: Refund card").closest(".astryx-banner"),
  ).toBeTruthy();
  expect(view.container.querySelector("[role=alert]")).toBeNull();
});

test("a component still loading shows an Astryx loading state", () => {
  const view = render(
    <SandboxHost status={{ kind: "loading", message: "Loading the preview…" }}>
      <p>not drawn yet</p>
    </SandboxHost>,
  );
  expect(view.getByRole("status").textContent).toContain(
    "Loading the preview…",
  );
  expect(view.queryByText("not drawn yet")).toBeNull();
});

test("an action on an error is drawn with the message", () => {
  const view = render(
    <SandboxHost
      status={{
        kind: "error",
        message: "Couldn't load the preview.",
        action: <button type="button">Retry</button>,
      }}
    />,
  );
  expect(view.getByText("Retry")).toBeTruthy();
  expect(view.getByText("Couldn't load the preview.")).toBeTruthy();
});

/*
 * The height floor in `styles.css` makes up for the SDK's one-shot measurement, and applies to the
 * frame by its own class. It reaches a sandbox only inside a host, so that is where a sandbox is
 * drawn from.
 */
test("the sandbox frame's height floor is scoped to the host", async () => {
  const css = await Bun.file(
    new URL("../src/styles.css", import.meta.url),
  ).text();
  const rules = css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .matchAll(/([^{}]+)\{([^{}]*)\}/g);
  const selectors = [...rules]
    .filter(([selector]) => selector.includes("websandbox__frame"))
    .map(([, selector]) => selector.trim());
  expect(selectors).toEqual([
    "[data-sandbox-host] :where(div:has(> iframe.websandbox__frame))",
  ]);
});

test("a title that names a section of its page is a heading", () => {
  const view = render(<SandboxHost headingLevel={2} title="Preview" />);
  expect(view.getByRole("heading", { level: 2 }).textContent).toBe("Preview");
});

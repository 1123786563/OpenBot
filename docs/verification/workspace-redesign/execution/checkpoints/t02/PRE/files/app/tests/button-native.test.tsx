import "./preload";
import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "../../tests/support/e2e-compat";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { ComponentPropsWithoutRef, ReactElement } from "react";
import { Button } from "@/components/ui/button";
import { ButtonLink } from "@/components/ui/router-link";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

/**
 * Collects what a render logs. The DOM assertions below carry the weight; the log is only evidence
 * that the wrapper did not complain about the element it drew.
 */
function drawing(element: ReactElement) {
  const logged: string[] = [];
  const spy = spyOn(console, "error").mockImplementation(
    (...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    },
  );

  try {
    const { container } = render(element);
    return {
      complaints: logged.filter((message) => message.startsWith("Base UI:")),
      element: container.firstElementChild as HTMLElement,
    };
  } finally {
    spy.mockRestore();
  }
}

test("a button with no `render` is still a native button", () => {
  const { complaints, element } = drawing(<Button>Save</Button>);

  expect(complaints).toEqual([]);
  expect(element.tagName).toBe("BUTTON");
  expect(element.getAttribute("type")).toBe("button");
  expect(element.getAttribute("role")).toBeNull();
});

/**
 * The app's call sites say `disabled`; React Aria says `isDisabled`. The adapter owns that mapping,
 * and `disabled` must never be forwarded as an unknown prop.
 */
test("`disabled` maps to React Aria's `isDisabled`", () => {
  const { element } = drawing(<Button disabled>Save</Button>);

  expect(element.tagName).toBe("BUTTON");
  expect((element as HTMLButtonElement).disabled).toBe(true);
  expect(element.hasAttribute("isDisabled")).toBe(false);
  expect(element.hasAttribute("isdisabled")).toBe(false);
});

/**
 * The compatibility bridge for call sites that still pass `render={<Link />}`: the element becomes
 * a React Aria render function, its own props survive, and its class/handlers merge with the
 * button's rather than replacing them.
 */
test("a render element keeps its own props and the button plumbing", () => {
  const fired: string[] = [];
  const { complaints, element } = drawing(
    <Button
      className="tracking-wide"
      onDoubleClick={() => fired.push("button")}
      render={
        <a
          className="uppercase"
          href="/settings"
          onDoubleClick={() => fired.push("link")}
        />
      }
    >
      Settings
    </Button>,
  );

  expect(complaints).toEqual([]);
  expect(element.tagName).toBe("A");
  expect(element.getAttribute("href")).toBe("/settings");
  // React Aria expects the render target to be the button it replaces; an anchor stays an anchor
  // (no button role), which is exactly why link buttons move to `ButtonLink`.
  expect(element.getAttribute("role")).toBeNull();
  expect(element.className).toContain("tracking-wide");
  expect(element.className).toContain("uppercase");

  fireEvent.doubleClick(element);
  expect(fired).toEqual(["button", "link"]);
});

/**
 * React Aria's own function form still works. The cast is only for the DOM prop types: `render`
 * hands a function the props it would have given the `<button>`, and the test draws an anchor.
 */
test("a render function still draws the element it returns", () => {
  const { complaints, element } = drawing(
    <Button
      render={(props) => (
        <a href="/agents" {...(props as ComponentPropsWithoutRef<"a">)} />
      )}
    >
      Agents
    </Button>,
  );

  expect(complaints).toEqual([]);
  expect(element.tagName).toBe("A");
  expect(element.getAttribute("href")).toBe("/agents");
  expect(element.getAttribute("role")).toBeNull();
});

test("a call site drawing a real button can still say so", () => {
  const { complaints, element } = drawing(
    <Button nativeButton render={<button type="button" />}>
      Open
    </Button>,
  );

  expect(complaints).toEqual([]);
  expect(element.tagName).toBe("BUTTON");
  expect(element.getAttribute("role")).toBeNull();
});

/**
 * `ButtonLink` is the destination for every router link button: a real anchor with the button
 * classes, no button role, and nothing nested.
 */
test("ButtonLink draws a real anchor for a router route", async () => {
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({
      component: () => (
        <ButtonLink to="/" variant="outline">
          Agents
        </ButtonLink>
      ),
    }),
  });
  await router.load();

  const { container } = render(
    <RouterContextProvider router={router as never}>
      <ButtonLink to="/" variant="outline">
        Agents
      </ButtonLink>
    </RouterContextProvider>,
  );

  const link = await waitFor(() => {
    const anchor = container.querySelector("a");
    expect(anchor).not.toBeNull();
    return anchor as HTMLAnchorElement;
  });

  expect(link.tagName).toBe("A");
  expect(link.getAttribute("href")).toBe("/");
  expect(link.getAttribute("role")).toBeNull();
  expect(link.querySelector("button")).toBeNull();
  expect(link.querySelector("a")).toBeNull();
  expect(link.className).toContain("border-border");
});

test("ButtonLink treats `href` as an external anchor", () => {
  const { container } = render(
    <ButtonLink href="https://example.com/docs" target="_blank">
      Docs
    </ButtonLink>,
  );

  const link = container.firstElementChild as HTMLAnchorElement;
  expect(link.tagName).toBe("A");
  expect(link.getAttribute("href")).toBe("https://example.com/docs");
  expect(link.getAttribute("target")).toBe("_blank");
  expect(link.getAttribute("role")).toBeNull();
  expect(link.querySelector("button")).toBeNull();
  expect(link.querySelector("a")).toBeNull();
});

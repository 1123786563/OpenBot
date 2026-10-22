import "./preload";
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
import { Input } from "@/components/ui/input";
import { ButtonLink } from "@/components/ui/router-link";
import { Textarea } from "@/components/ui/textarea";
import {
  afterAll,
  afterEach,
  beforeAll,
  expect,
  spyOn,
  test,
} from "../../tests/support/e2e-compat";

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
  let receivedRef: HTMLButtonElement | null = null;
  const { complaints, element } = drawing(
    <Button
      ref={(node) => {
        receivedRef = node;
      }}
    >
      Save
    </Button>,
  );

  expect(complaints).toEqual([]);
  expect(element.tagName).toBe("BUTTON");
  expect(receivedRef).toBe(element);
  expect(element.getAttribute("type")).toBe("button");
  expect(element.getAttribute("role")).toBeNull();
});

test("the public button keeps every variant and size while exposing the redesigned states", () => {
  const variants = [
    "default",
    "outline",
    "secondary",
    "ghost",
    "destructive",
    "link",
  ] as const;
  const sizes = [
    "default",
    "xs",
    "sm",
    "lg",
    "icon",
    "icon-xs",
    "icon-sm",
    "icon-lg",
  ] as const;

  for (const variant of variants) {
    const { element } = drawing(<Button variant={variant}>Action</Button>);
    expect(element.getAttribute("data-variant")).toBe(variant);
    expect(element.className).toContain("focus-visible:outline-2");
    expect(element.className).toContain("pointer-coarse:min-h-11");
    cleanup();
  }

  for (const size of sizes) {
    const { element } = drawing(<Button size={size}>Action</Button>);
    expect(element.getAttribute("data-size")).toBe(size);
    cleanup();
  }

  const { element: outline } = drawing(
    <Button variant="outline">Cancel</Button>,
  );
  expect(outline.className).toContain("border-[var(--ob-control-border)]");
  const { element: link } = drawing(<Button variant="link">Learn more</Button>);
  expect(link.className).toContain("text-[var(--ob-accent-text)]");
});

test("public text fields retain their native props and use stable field state classes", () => {
  const inputView = render(
    <Input
      aria-label="Email"
      aria-invalid
      type="email"
      defaultValue="a@b.co"
    />,
  );
  const input = inputView.getByRole("textbox", { name: "Email" });
  expect((input as HTMLInputElement).type).toBe("email");
  expect((input as HTMLInputElement).defaultValue).toBe("a@b.co");
  expect(input.className).toContain("bg-[var(--ob-field-background)]");
  expect(input.className).toContain("border-[var(--ob-control-border)]");
  expect(input.className).toContain(
    "aria-invalid:bg-[var(--ob-field-background)]",
  );
  inputView.unmount();

  const textareaView = render(
    <Textarea aria-label="Notes" defaultValue="draft" />,
  );
  const textarea = textareaView.getByRole("textbox", { name: "Notes" });
  expect((textarea as HTMLTextAreaElement).defaultValue).toBe("draft");
  expect(textarea.className).toContain("min-h-24");
  expect(textarea.className).toContain("focus-visible:outline-2");
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
  expect(link.className).toContain("border-[var(--ob-control-border)]");
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

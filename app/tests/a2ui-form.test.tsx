import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import {
  CopilotChatConfigurationProvider,
  CopilotKitProvider,
  type CopilotKitProviderProps,
} from "@copilotkit/react-core/v2";
import {
  createGenerativeUI,
  GenerativeUISurface,
  useGenerativeUIRuntime,
} from "@copilotkit/react-core/v2/generative-ui";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ReactNode, useEffect } from "react";
import { z } from "zod";
import { ChatTranscript } from "@/components/channels/chat-transcript";
import { TooltipProvider } from "@/components/ui/tooltip";
import { generativeUiProviderOptions, OPENBOT_UI } from "@/lib/copilot/a2ui";
import {
  astryxA2UIOverrides,
  SDK_DRAWN_CONTROLS,
} from "@/lib/copilot/a2ui-controls";
import { withCurrentA2uiVersions } from "@/lib/copilot/thread-messages";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const THREAD = "thread-form";

/** A booking form as a Bot draws it: the fields under one Form, with a submit event. */
function Booking() {
  const runtime = useGenerativeUIRuntime();
  useEffect(() => {
    if (!runtime) return;
    runtime.manager.setActiveThread(THREAD);
    runtime.manager.ingest(THREAD, undefined, {
      surfaceId: "booking",
      target: "booking",
      catalogId: OPENBOT_UI.id,
      status: "ready",
      rejected: [],
      operations: [
        {
          version: "1.0",
          createSurface: {
            surfaceId: "booking",
            catalogId: OPENBOT_UI.id,
            dataModel: {
              name: "Ada",
              note: "",
              class: "economy",
              window: false,
              guests: 2,
            },
          },
        },
        {
          version: "1.0",
          updateComponents: {
            surfaceId: "booking",
            components: [
              {
                id: "root",
                component: "Form",
                children: ["name", "note", "class", "window", "guests", "send"],
                onSubmit: {
                  event: {
                    name: "bookTrip",
                    context: {
                      name: { "@path": "/name" },
                      note: { "@path": "/note" },
                      class: { "@path": "/class" },
                      window: { "@path": "/window" },
                      guests: { "@path": "/guests" },
                    },
                  },
                },
              },
              {
                id: "name",
                component: "TextField",
                label: "Name",
                value: { "@path": "/name" },
              },
              {
                id: "note",
                component: "TextArea",
                label: "Note",
                value: { "@path": "/note" },
              },
              {
                id: "class",
                component: "Select",
                label: "Class",
                value: { "@path": "/class" },
                options: ["economy", "business"],
              },
              {
                id: "window",
                component: "CheckBox",
                label: "Window seat",
                value: { "@path": "/window" },
              },
              {
                id: "guests",
                component: "Slider",
                label: "Guests",
                min: 1,
                max: 5,
                value: { "@path": "/guests" },
              },
              { id: "send", component: "Button", label: "Book", submit: true },
            ],
          },
        },
      ],
    });
  }, [runtime]);
  return null;
}

/** A catalog with one component that cannot be drawn, for a form that fails to render. */
const FAILING_UI = createGenerativeUI({
  id: "test/failing@1",
  extends: [OPENBOT_UI],
  components: {
    Broken: {
      description: "A part that cannot be drawn",
      props: z.object({}),
      component() {
        throw new Error("fixture: this part cannot be drawn");
      },
    },
  },
});

type Agent = NonNullable<
  CopilotKitProviderProps["agents__unsafe_dev_only"]
>[string];

/** The user turns the form starts, as the agent receives them. */
const sent: string[] = [];
const agent = {
  agentId: "default",
  threadId: THREAD,
  messages: [],
  isRunning: false,
  subscribe: () => ({ unsubscribe() {} }),
  addMessage: (message: { content: string }) =>
    sent.push(String(message.content)),
  runAgent: () => Promise.resolve({ newMessages: [] }),
} as unknown as Agent;

type Ui = NonNullable<CopilotKitProviderProps["generativeUI"]>["ui"];

/** The provider as the app sets it, around a page that commits surfaces once it is up. */
function Page({
  ui,
  surfaces,
  children,
  runningAgent = agent,
}: {
  ui: Ui;
  surfaces: (commit: (surface: Surface) => void) => void;
  children: ReactNode;
  runningAgent?: Agent;
}) {
  const options = generativeUiProviderOptions(true);
  function Commit() {
    const runtime = useGenerativeUIRuntime();
    useEffect(() => {
      if (!runtime) return;
      runtime.manager.setActiveThread(THREAD);
      surfaces((surface) =>
        runtime.manager.ingest(THREAD, undefined, {
          surfaceId: surface.surfaceId,
          target: surface.surfaceId,
          catalogId: ui.id,
          status: "ready",
          rejected: [],
          operations: [
            {
              version: "1.0",
              createSurface: {
                surfaceId: surface.surfaceId,
                catalogId: ui.id,
                dataModel: surface.dataModel,
              },
            },
            {
              version: "1.0",
              updateComponents: {
                surfaceId: surface.surfaceId,
                components: surface.components,
              },
            },
          ],
        } as Parameters<typeof runtime.manager.ingest>[2]),
      );
    }, [runtime]);
    return null;
  }
  return (
    <CopilotKitProvider
      agents__unsafe_dev_only={{ default: runningAgent }}
      {...options}
      generativeUI={{ ...options.generativeUI, ui }}
    >
      <Commit />
      {children}
    </CopilotKitProvider>
  );
}

type Surface = {
  surfaceId: string;
  dataModel: Record<string, unknown>;
  components: Record<string, unknown>[];
};

const field = (id: string, label: string) => ({
  id,
  component: "TextField",
  label,
  value: { "@path": `/${id}` },
});

const form = (
  id: string,
  event: string,
  fields: string[],
): Record<string, unknown> => ({
  id,
  component: "Form",
  children: [...fields, `${id}-send`],
  onSubmit: {
    event: {
      name: event,
      context: Object.fromEntries(
        fields.map((name) => [name, { "@path": `/${name}` }]),
      ),
    },
  },
});

test("a form that fails to render shows an Astryx error and is not sent; the rest still works", async () => {
  sent.length = 0;
  const view = render(
    <Page
      ui={FAILING_UI}
      surfaces={(commit) =>
        commit({
          surfaceId: "mixed",
          dataModel: { who: "", what: "" },
          components: [
            {
              id: "root",
              component: "Column",
              children: ["intro", "broken", "aside", "good"],
            },
            { id: "intro", component: "Text", text: "Two forms follow." },
            {
              ...form("broken", "sendBroken", ["who"]),
              children: ["who", "boom", "broken-send"],
            },
            {
              id: "who",
              component: "TextField",
              label: "Who",
              value: { "@path": "/who" },
            },
            { id: "boom", component: "Broken" },
            {
              id: "broken-send",
              component: "Button",
              label: "Send broken",
              submit: true,
            },
            {
              id: "aside",
              component: "Text",
              text: "This line is still readable.",
            },
            form("good", "sendGood", ["what"]),
            field("what", "What"),
            {
              id: "good-send",
              component: "Button",
              label: "Send good",
              submit: true,
            },
          ],
        })
      }
    >
      <GenerativeUISurface id="mixed" />
    </Page>,
  );
  // Only the broken part is replaced, by an Astryx error state.
  const alert = await view.findByRole("alert");
  expect(alert.closest(".astryx-banner")).toBeTruthy();
  expect(alert.textContent).toContain("Couldn't show this part of the reply.");
  expect(view.getByText("Two forms follow.")).toBeTruthy();
  expect(view.getByText("This line is still readable.")).toBeTruthy();

  // The form with the broken part takes no more input and sends nothing.
  const who = view.getByLabelText("Who") as HTMLInputElement;
  await userEvent.setup({ document }).type(who, "Ada");
  expect(who.value).toBe("Ada");
  expect(
    view
      .getByRole("button", { name: "Send broken" })
      .getAttribute("aria-disabled"),
  ).toBe("true");
  fireEvent.submit(who.form as HTMLFormElement);
  await waitFor(() => expect(sent).toEqual([]));

  // The form next to it still submits what was typed.
  await userEvent.setup({ document }).type(view.getByLabelText("What"), "Tea");
  fireEvent.submit(
    (view.getByLabelText("What") as HTMLInputElement).form as HTMLFormElement,
  );
  await waitFor(() => expect(sent).toEqual(["What\n\nwhat: Tea"]));
});

test("a part the SDK itself cannot draw shows an Astryx error in its form, which is not sent; the form beside it works", async () => {
  sent.length = 0;
  const view = render(
    <Page
      ui={OPENBOT_UI}
      surfaces={(commit) =>
        commit({
          surfaceId: "invalid",
          dataModel: { who: "", what: "", guests: 2 },
          components: [
            {
              id: "root",
              component: "Column",
              children: ["intro", "bad", "aside", "good"],
            },
            { id: "intro", component: "Text", text: "Two forms follow." },
            {
              ...form("bad", "sendBad", ["who", "guests"]),
              children: ["who", "range", "bad-send"],
            },
            field("who", "Who"),
            {
              // A check box bound to the text field's value. The server checks prop names only, and
              // the client skips a bound prop, so it fails only when the box is drawn, where no
              // error boundary is involved.
              id: "range",
              component: "CheckBox",
              label: "Is named",
              value: { "@path": "/who" },
            },
            {
              id: "bad-send",
              component: "Button",
              label: "Send bad",
              submit: true,
            },
            {
              id: "aside",
              component: "Text",
              text: "This line is still readable.",
            },
            form("good", "sendGood", ["what"]),
            field("what", "What"),
            {
              id: "good-send",
              component: "Button",
              label: "Send good",
              submit: true,
            },
          ],
        })
      }
    >
      <GenerativeUISurface id="invalid" />
    </Page>,
  );
  const who = (await view.findByLabelText("Who")) as HTMLInputElement;
  const bad = who.form as HTMLFormElement;
  // The SDK's own node for the part it refused is in the form, and the form shows an Astryx error.
  expect(bad.querySelector('[data-generative-ui-error="range"]')).toBeTruthy();
  const banner = bad.querySelector(".astryx-banner");
  expect(banner?.getAttribute("data-status")).toBe("error");
  expect(banner?.querySelector('[role="alert"]')?.textContent).toContain(
    "Couldn't show this part of the reply.",
  );
  expect(view.getByText("Two forms follow.")).toBeTruthy();
  expect(view.getByText("This line is still readable.")).toBeTruthy();

  // The form that is missing a part sends nothing.
  expect(
    view
      .getByRole("button", { name: "Send bad" })
      .getAttribute("aria-disabled"),
  ).toBe("true");
  fireEvent.submit(bad);
  expect(sent).toEqual([]);

  // The form next to it still submits what was typed.
  await userEvent.setup({ document }).type(view.getByLabelText("What"), "Tea");
  fireEvent.submit(
    (view.getByLabelText("What") as HTMLInputElement).form as HTMLFormElement,
  );
  expect(sent).toEqual(["What\n\nwhat: Tea"]);
});

test("a form the SDK could not draw in part submits again once a later update repairs it", async () => {
  sent.length = 0;
  const content = (operations: Record<string, unknown>[]) => ({
    surfaceId: "repair",
    target: "repair",
    catalogId: OPENBOT_UI.id,
    status: "ready",
    rejected: [],
    operations,
  });
  const first = [
    {
      version: "1.0",
      createSurface: {
        surfaceId: "repair",
        catalogId: OPENBOT_UI.id,
        dataModel: { who: "", named: false },
      },
    },
    {
      version: "1.0",
      updateComponents: {
        surfaceId: "repair",
        components: [
          {
            ...form("root", "sendRepair", ["who", "named"]),
            children: ["who", "named", "root-send"],
          },
          field("who", "Who"),
          {
            // Bound to the text field's value, which is not a boolean.
            id: "named",
            component: "CheckBox",
            label: "Is named",
            value: { "@path": "/who" },
          },
          {
            id: "root-send",
            component: "Button",
            label: "Send repair",
            submit: true,
          },
        ],
      },
    },
  ];
  // The same box, bound to the boolean the data model holds for it.
  const repair = {
    version: "1.0",
    updateComponents: {
      surfaceId: "repair",
      components: [
        {
          id: "named",
          component: "CheckBox",
          label: "Is named",
          value: { "@path": "/named" },
        },
      ],
    },
  };
  let repairNow = () => {};
  function Repairing() {
    const runtime = useGenerativeUIRuntime();
    useEffect(() => {
      if (!runtime) return;
      runtime.manager.setActiveThread(THREAD);
      runtime.manager.ingest(THREAD, undefined, content(first) as never);
      repairNow = () =>
        runtime.manager.ingest(
          THREAD,
          undefined,
          content([...first, repair]) as never,
        );
    }, [runtime]);
    return null;
  }
  const view = render(
    <CopilotKitProvider
      agents__unsafe_dev_only={{ default: agent }}
      {...generativeUiProviderOptions(true)}
    >
      <Repairing />
      <GenerativeUISurface id="repair" />
    </CopilotKitProvider>,
  );
  const who = (await view.findByLabelText("Who")) as HTMLInputElement;
  const badForm = who.form as HTMLFormElement;
  expect(badForm.querySelector(".astryx-banner")).toBeTruthy();
  expect(
    view
      .getByRole("button", { name: "Send repair" })
      .getAttribute("aria-disabled"),
  ).toBe("true");

  // Repaired: the error goes, the button works again, and the form sends.
  repairNow();
  await waitFor(() =>
    expect(badForm.querySelector(".astryx-banner")).toBeNull(),
  );
  await waitFor(() =>
    expect(
      view
        .getByRole("button", { name: "Send repair" })
        .getAttribute("aria-disabled"),
    ).toBeNull(),
  );
  await userEvent.setup({ document }).type(who, "Ada");
  await userEvent.setup({ document }).click(view.getByLabelText("Is named"));
  fireEvent.submit(badForm);
  expect(sent).toEqual(["Who\n\nwho: Ada\nnamed: true"]);
});

/** A stored interface as the transcript receives it: one surface, its updates, then `later` ones. */
function stored(
  surfaceId: string,
  components: Record<string, unknown>[],
  later: Record<string, unknown>[] = [],
): Message {
  return {
    id: `activity-${surfaceId}`,
    role: "activity",
    activityType: "generative-ui-surface",
    content: {
      surfaceId,
      target: "chat",
      catalogId: OPENBOT_UI.id,
      status: "ready",
      rejected: [],
      operations: [
        {
          version: "1.0",
          createSurface: {
            surfaceId,
            catalogId: OPENBOT_UI.id,
            dataModel: { name: "", note: "" },
          },
        },
        { version: "1.0", updateComponents: { surfaceId, components } },
        ...later,
      ],
    },
  };
}

function StoredTranscript({ messages }: { messages: Message[] }) {
  return (
    <QueryClientProvider client={new QueryClient()}>
      <CopilotKitProvider
        agents__unsafe_dev_only={{ default: agent }}
        {...generativeUiProviderOptions(true)}
      >
        <CopilotChatConfigurationProvider agentId="default" threadId={THREAD}>
          <TooltipProvider>
            <ChatTranscript messages={messages} restoring={false} />
          </TooltipProvider>
        </CopilotChatConfigurationProvider>
      </CopilotKitProvider>
    </QueryClientProvider>
  );
}

test("a form whose later update was refused shows an Astryx error and is not sent; the interface beside it still sends", async () => {
  sent.length = 0;
  const view = render(
    <StoredTranscript
      messages={[
        // The form lists a field that only its third update creates, and that update is refused.
        stored(
          "refused",
          [
            {
              ...form("root", "sendRefused", ["name", "note"]),
              children: ["name", "note", "root-send"],
            },
            field("name", "Name"),
            {
              id: "root-send",
              component: "Button",
              label: "Send refused",
              submit: true,
            },
          ],
          [
            {
              version: "1.0",
              // A label that is not a string: the whole update is refused and nothing in it draws.
              updateComponents: {
                surfaceId: "refused",
                components: [
                  {
                    id: "note",
                    component: "TextField",
                    label: 5,
                    value: { "@path": "/note" },
                  },
                ],
              },
            },
          ],
        ),
        stored("whole", [
          {
            ...form("root", "sendWhole", ["note"]),
            children: ["note", "root-send"],
          },
          field("note", "Note"),
          {
            id: "root-send",
            component: "Button",
            label: "Send whole",
            submit: true,
          },
        ]),
      ]}
    />,
  );
  // The card CopilotKit draws says that part of the interface was not shown.
  await view.findByText("Part of this UI couldn't be shown.");
  const name = (await view.findByLabelText("Name")) as HTMLInputElement;
  const refused = name.form as HTMLFormElement;
  const banner = refused.querySelector(".astryx-banner");
  expect(banner?.getAttribute("data-status")).toBe("error");
  expect(banner?.querySelector('[role="alert"]')?.textContent).toContain(
    "Couldn't show this part of the reply.",
  );

  // The form is missing the field, so it sends nothing.
  expect(
    view
      .getByRole("button", { name: "Send refused" })
      .getAttribute("aria-disabled"),
  ).toBe("true");
  fireEvent.submit(refused);
  expect(sent).toEqual([]);

  // The interface beside it, whose updates were all taken, still submits.
  await userEvent.setup({ document }).type(view.getByLabelText("Note"), "Tea");
  fireEvent.submit(
    (view.getByLabelText("Note") as HTMLInputElement).form as HTMLFormElement,
  );
  expect(sent).toEqual(["Note\n\nnote: Tea"]);
});

test("a cleared Select submits its empty value instead of losing the field", async () => {
  sent.length = 0;
  const view = render(
    <Page
      ui={OPENBOT_UI}
      surfaces={(commit) =>
        commit({
          surfaceId: "cleared",
          dataModel: { class: "economy" },
          components: [
            // A surface is drawn from its `root` node, whatever component it is.
            {
              ...form("root", "sendClass", ["class"]),
              children: ["class", "root-send"],
            },
            {
              id: "class",
              component: "Select",
              label: "Class",
              clearable: true,
              clearLabel: "Any class",
              options: ["economy", "business"],
              value: { "@path": "/class" },
            },
            {
              id: "root-send",
              component: "Button",
              label: "Send",
              submit: true,
            },
          ],
        })
      }
    >
      <GenerativeUISurface id="cleared" />
    </Page>,
  );
  const select = await view.findByRole("combobox", { name: "Class" });
  expect(select.textContent).toBe("economy");
  await userEvent
    .setup({ document })
    .click(view.getByRole("button", { name: /clear/i }));
  // An emptied field writes an empty string, as the catalog's own Select does, so the Bot still
  // receives the field.
  fireEvent.submit(view.container.querySelector("form") as HTMLFormElement);
  expect(sent).toEqual(["Class\n\nclass: "]);
});

test("a Form and a Pressable take the layout the catalog gives them", async () => {
  const view = render(
    <Page
      ui={OPENBOT_UI}
      surfaces={(commit) =>
        commit({
          surfaceId: "layout",
          dataModel: {},
          components: [
            { id: "root", component: "Column", children: ["panel", "chip"] },
            {
              ...form("panel", "sendPanel", []),
              label: "Panel",
              maxWidth: 72,
              rowGap: 2,
              columnGap: 4,
              flush: true,
              background: "surface-secondary",
              radius: "lg",
              shadow: true,
              children: ["panel-send"],
            },
            {
              id: "panel-send",
              component: "Button",
              label: "Send panel",
              submit: true,
            },
            {
              id: "chip",
              component: "Pressable",
              inline: true,
              border: true,
              borderColor: "danger",
              padding: "0.5rem",
              insetBorder: true,
              children: ["chip-text"],
              onClick: { event: { name: "pick" } },
            },
            { id: "chip-text", component: "Text", text: "Chip" },
          ],
        })
      }
    >
      <GenerativeUISurface id="layout" />
    </Page>,
  );
  const panel = (
    (view.getByRole("button", { name: "Send panel" }) as HTMLButtonElement)
      .form as HTMLFormElement
  ).style;
  const chip = view.getByRole("button", { name: "Chip" }) as HTMLElement;
  for (const [name, style, property, expected] of [
    ["panel", panel, "maxWidth", "calc(var(--spacing-1) * 72)"],
    ["panel", panel, "rowGap", "calc(var(--spacing-1) * 2)"],
    ["panel", panel, "columnGap", "calc(var(--spacing-1) * 4)"],
    ["panel", panel, "padding", "0"],
    ["panel", panel, "background", "var(--a2ui-color-surface-secondary)"],
    ["panel", panel, "borderRadius", "var(--a2ui-radius-lg)"],
    ["panel", panel, "boxShadow", "var(--a2ui-shadow-sm, var(--shadow-low))"],
    ["chip", chip.style, "display", "inline-flex"],
    [
      "chip",
      chip.style,
      "--a2ui-color-border-danger",
      "var(--a2ui-color-border-danger)",
    ],
    ["chip", chip.style, "padding", "0.5rem"],
    [
      "chip",
      chip.style,
      "boxShadow",
      "inset 0 0 0 1px var(--a2ui-color-border-default)",
    ],
  ] as const)
    expect(
      property.startsWith("--")
        ? style.cssText
        : (style as unknown as Record<string, string>)[property],
      `${name} ${property}`,
    ).toContain(expected);
});

test("Select and DateTimeInput take the props Astryx has an equivalent for", async () => {
  const view = render(
    <Page
      ui={OPENBOT_UI}
      surfaces={(commit) =>
        commit({
          surfaceId: "fields",
          dataModel: { class: "economy", day: "2026-10-23" },
          components: [
            { id: "root", component: "Column", children: ["class", "day"] },
            {
              id: "class",
              component: "Select",
              label: "Class",
              clearable: true,
              clearLabel: "Any class",
              icon: "plane",
              options: ["economy", "business"],
              value: { "@path": "/class" },
            },
            {
              id: "day",
              component: "DateTimeInput",
              label: "Day",
              weight: 2,
              value: { "@path": "/day" },
            },
          ],
        })
      }
    >
      <GenerativeUISurface id="fields" />
    </Page>,
  );
  // The catalog's Select can show an icon before its value.
  const select = await view.findByRole("combobox", { name: "Class" });
  expect(
    select.closest(".astryx-selector")?.querySelector("svg.lucide-plane"),
  ).toBeTruthy();
  // Clearing it shows the empty option's own label, not a generic placeholder.
  await userEvent
    .setup({ document })
    .click(view.getByRole("button", { name: /clear/i }));
  expect(select.textContent).toBe("Any class");

  // A date field takes its share of the free space of the container.
  const day = view
    .getByLabelText("Day")
    .closest(".astryx-field") as HTMLElement;
  expect(day.parentElement?.style.flexGrow).toBe("2");
});

test("SegmentedControl stays as the SDK draws it, reads the theme and writes what was picked", async () => {
  sent.length = 0;
  const view = render(
    <Page
      ui={OPENBOT_UI}
      surfaces={(commit) =>
        commit({
          surfaceId: "segment",
          dataModel: { trip: "economy" },
          components: [
            {
              ...form("root", "sendTrip", ["trip"]),
              children: ["trip", "root-send"],
            },
            {
              id: "trip",
              component: "SegmentedControl",
              label: "Class",
              options: ["economy", "business"],
              value: { "@path": "/trip" },
            },
            {
              id: "root-send",
              component: "Button",
              label: "Send",
              submit: true,
            },
          ],
        })
      }
    >
      <GenerativeUISurface id="segment" />
    </Page>,
  );
  // The one input control recorded as SDK-drawn is the one that is not overridden, and it is in
  // the catalog a Bot draws from.
  expect(SDK_DRAWN_CONTROLS).toEqual(["SegmentedControl"]);
  for (const name of SDK_DRAWN_CONTROLS) {
    expect(OPENBOT_UI.components.has(name)).toBe(true);
    expect(astryxA2UIOverrides).not.toHaveProperty(name);
  }
  const economy = (await view.findByRole("radio", {
    name: "economy",
  })) as HTMLElement;
  expect(economy.getAttribute("aria-checked")).toBe("true");
  // It reads the same theme variables as the Astryx controls beside it.
  expect(economy.style.cssText).toContain("var(--a2ui-");

  // The arrows move the choice, and the form sends what was picked.
  economy.focus();
  await userEvent.setup({ document }).keyboard("{ArrowRight}");
  expect(
    view.getByRole("radio", { name: "business" }).getAttribute("aria-checked"),
  ).toBe("true");
  fireEvent.submit(view.container.querySelector("form") as HTMLFormElement);
  expect(sent).toEqual(["Class\n\ntrip: business"]);
});

test("a form used while the Bot is still replying says nothing was sent, and sends once the reply is over", async () => {
  sent.length = 0;
  const running = { ...agent, isRunning: true } as unknown as Agent;
  const view = render(
    <Page
      runningAgent={running}
      ui={OPENBOT_UI}
      surfaces={(commit) =>
        commit({
          surfaceId: "busy",
          dataModel: { name: "" },
          components: [
            {
              ...form("root", "sendName", ["name"]),
              children: ["name", "add", "root-send"],
            },
            field("name", "Name"),
            {
              id: "add",
              component: "Button",
              label: "Add",
              onClick: { event: { name: "addName" } },
            },
            {
              id: "root-send",
              component: "Button",
              label: "Send",
              submit: true,
            },
          ],
        })
      }
    >
      <GenerativeUISurface id="busy" />
    </Page>,
  );
  const notice = "Nothing was sent. The Bot is still replying.";
  const name = (await view.findByLabelText("Name")) as HTMLInputElement;
  await userEvent.setup({ document }).type(name, "Grace");

  // A button and the form's own submit both reach the Bot while it is replying, and are dropped.
  // The form says so instead of staying quiet.
  await userEvent
    .setup({ document })
    .click(view.getByRole("button", { name: "Add" }));
  expect(
    (await view.findByText(notice)).closest(".astryx-banner"),
  ).toBeTruthy();
  fireEvent.submit(name.form as HTMLFormElement);
  expect(sent).toEqual([]);

  // Once the reply is over the same form sends, and the notice goes.
  running.isRunning = false;
  fireEvent.submit(name.form as HTMLFormElement);
  expect(sent).toEqual(["Name\n\nname: Grace"]);
  await waitFor(() => expect(view.queryByText(notice)).toBeNull());
});

test("a Button takes the catalog's href, copy, loading, icon, icon-only and variant", async () => {
  sent.length = 0;
  const opened: string[] = [];
  const open = window.open;
  window.open = ((url: string) => {
    opened.push(url);
    return null;
  }) as typeof window.open;
  const copied: string[] = [];
  try {
    const user = userEvent.setup({ document });
    // userEvent installs its own clipboard, so the spy goes on the one it put there.
    const clipboard = navigator.clipboard;
    Object.defineProperty(clipboard, "writeText", {
      value: async (text: string) => {
        copied.push(text);
      },
      configurable: true,
      writable: true,
    });
    const view = render(
      <Page
        ui={OPENBOT_UI}
        surfaces={(commit) =>
          commit({
            surfaceId: "buttons",
            dataModel: {},
            components: [
              {
                id: "root",
                component: "Column",
                children: [
                  "docs",
                  "unsafe",
                  "copy",
                  "busy",
                  "pin",
                  "remove",
                  "plain",
                  "click",
                ],
              },
              {
                // With a link, a click opens it instead of sending the event.
                id: "docs",
                component: "Button",
                label: "Docs",
                href: "https://example.test/docs",
                onClick: { event: { name: "openDocs" } },
              },
              {
                // Any other scheme is ignored.
                id: "unsafe",
                component: "Button",
                label: "Unsafe",
                href: "javascript:alert(1)",
              },
              {
                id: "copy",
                component: "Button",
                label: "Copy code",
                copy: "npm i openbot",
              },
              {
                id: "busy",
                component: "Button",
                label: "Working",
                loading: true,
              },
              {
                id: "pin",
                component: "Button",
                label: "Pin",
                icon: "pin",
                uniform: true,
              },
              {
                id: "remove",
                component: "Button",
                label: "Remove",
                color: "danger",
              },
              {
                id: "plain",
                component: "Button",
                label: "Plain",
                variant: "borderless",
              },
              {
                id: "click",
                component: "Button",
                label: "Click",
                onClick: { event: { name: "clicked" } },
              },
            ],
          })
        }
      >
        <GenerativeUISurface id="buttons" />
      </Page>,
    );
    await user.click(view.getByRole("button", { name: "Docs" }));
    expect(opened).toEqual(["https://example.test/docs"]);
    await user.click(view.getByRole("button", { name: "Unsafe" }));
    expect(opened).toEqual(["https://example.test/docs"]);
    await user.click(view.getByRole("button", { name: "Copy code" }));
    expect(copied).toEqual(["npm i openbot"]);
    // The copy shows a check for a moment, which is its own attribute.
    expect(
      view
        .getByRole("button", { name: "Copy code" })
        .getAttribute("data-a2ui-copied"),
    ).toBe("");
    // A loading button cannot be pressed again while it works.
    expect(
      view
        .getByRole("button", { name: "Working" })
        .getAttribute("aria-disabled"),
    ).toBe("true");
    // An icon-only button is named by its label and draws its icon.
    const pin = view.getByRole("button", { name: "Pin" });
    expect(pin.querySelector("svg")).toBeTruthy();
    expect(pin.getAttribute("data-variant")).toBe("secondary");
    expect(
      view.getByRole("button", { name: "Remove" }).getAttribute("data-variant"),
    ).toBe("destructive");
    expect(
      view.getByRole("button", { name: "Plain" }).getAttribute("data-variant"),
    ).toBe("ghost");
    // A button with neither a link nor copy sends its event.
    await user.click(view.getByRole("button", { name: "Click" }));
    expect(sent).toEqual(["Click"]);
  } finally {
    window.open = open;
  }
});

test("a Pressable presses by pointer, Enter and Space, opens a link, and sends onVisible once", async () => {
  sent.length = 0;
  const opened: string[] = [];
  const open = window.open;
  window.open = ((url: string) => {
    opened.push(url);
    return null;
  }) as typeof window.open;
  const visible: string[] = [];
  const observers: {
    callback: IntersectionObserverCallback;
    target?: Element;
  }[] = [];
  const Observer = globalThis.IntersectionObserver;
  globalThis.IntersectionObserver = class {
    private entry: { callback: IntersectionObserverCallback; target?: Element };
    constructor(callback: IntersectionObserverCallback) {
      this.entry = { callback };
      observers.push(this.entry);
    }
    observe(target: Element) {
      this.entry.target = target;
    }
    disconnect() {}
    unobserve() {}
    takeRecords() {
      return [];
    }
  } as unknown as typeof IntersectionObserver;
  try {
    const view = render(
      <Page
        ui={OPENBOT_UI}
        surfaces={(commit) =>
          commit({
            surfaceId: "pressables",
            dataModel: {},
            components: [
              {
                id: "root",
                component: "Column",
                children: ["pick", "off", "link", "seen"],
              },
              {
                id: "pick",
                component: "Pressable",
                children: ["pick-text"],
                onClick: { event: { name: "picked" } },
              },
              { id: "pick-text", component: "Text", text: "Pick" },
              {
                id: "off",
                component: "Pressable",
                disabled: true,
                children: ["off-text"],
              },
              { id: "off-text", component: "Text", text: "Off" },
              {
                id: "link",
                component: "Pressable",
                href: "https://example.test/away",
                children: ["link-text"],
              },
              { id: "link-text", component: "Text", text: "Away" },
              {
                id: "seen",
                component: "Pressable",
                children: ["seen-text"],
                onVisible: { event: { name: "sawIt" } },
              },
              { id: "seen-text", component: "Text", text: "Seen" },
            ],
          })
        }
      >
        <GenerativeUISurface id="pressables" />
      </Page>,
    );
    const user = userEvent.setup({ document });
    const pick = view.getByRole("button", { name: "Pick" });
    await user.click(pick);
    pick.focus();
    await user.keyboard("{Enter}");
    await user.keyboard(" ");
    expect(sent).toEqual(["Pick", "Pick", "Pick"]);
    // A disabled pressable takes no press.
    const off = view.getByRole("button", { name: "Off" });
    expect(off.getAttribute("aria-disabled")).toBe("true");
    off.focus();
    await user.keyboard("{Enter}");
    await user.click(off);
    expect(sent).toHaveLength(3);
    // A linked pressable opens its URL and sends nothing.
    await user.click(view.getByRole("button", { name: "Away" }));
    expect(opened).toEqual(["https://example.test/away"]);
    expect(sent).toHaveLength(3);
    // onVisible is sent once, when the pressable first scrolls into view.
    const seen = observers.find(
      (entry) => entry.target?.textContent === "Seen",
    );
    expect(seen).toBeTruthy();
    seen?.callback(
      [{ isIntersecting: true } as IntersectionObserverEntry],
      {} as IntersectionObserver,
    );
    seen?.callback(
      [{ isIntersecting: true } as IntersectionObserverEntry],
      {} as IntersectionObserver,
    );
    expect(sent).toHaveLength(4);
  } finally {
    window.open = open;
    globalThis.IntersectionObserver = Observer;
  }
});

test("a standalone Radio is chosen by a click, and not when disabled", async () => {
  const view = render(
    <Page
      ui={OPENBOT_UI}
      surfaces={(commit) =>
        commit({
          surfaceId: "radios",
          dataModel: {},
          components: [
            { id: "root", component: "Column", children: ["on", "off"] },
            { id: "on", component: "Radio", label: "Agree" },
            {
              id: "off",
              component: "Radio",
              label: "Disagree",
              disabled: true,
            },
          ],
        })
      }
    >
      <GenerativeUISurface id="radios" />
    </Page>,
  );
  const agree = (await view.findByRole("radio", {
    name: "Agree",
  })) as HTMLInputElement;
  expect(agree.checked).toBe(false);
  await userEvent.setup({ document }).click(agree);
  expect(
    (view.getByRole("radio", { name: "Agree" }) as HTMLInputElement).checked,
  ).toBe(true);
  const disagree = view.getByRole("radio", {
    name: "Disagree",
  }) as HTMLInputElement;
  await userEvent.setup({ document }).click(disagree);
  expect(disagree.checked).toBe(false);
});

test("a searchable Select, a stepped and marked Slider, a time field and a text area take their props", async () => {
  sent.length = 0;
  const view = render(
    <Page
      ui={OPENBOT_UI}
      surfaces={(commit) =>
        commit({
          surfaceId: "props",
          dataModel: { class: "economy", rating: 0, note: "" },
          components: [
            {
              ...form("root", "sendProps", ["class", "rating", "note"]),
              children: ["class", "rating", "note", "root-send"],
            },
            {
              id: "class",
              component: "Select",
              label: "Class",
              searchable: true,
              options: ["economy", "business", "first class"],
              value: { "@path": "/class" },
            },
            {
              id: "rating",
              component: "Slider",
              label: "Rating",
              min: 0,
              max: 20,
              steps: 4,
              marks: [
                { value: 0, label: "Low" },
                { value: 20, label: "High" },
              ],
              value: { "@path": "/rating" },
            },
            {
              id: "note",
              component: "TextArea",
              label: "Note",
              rows: 5,
              value: { "@path": "/note" },
            },
            {
              id: "root-send",
              component: "Button",
              label: "Send",
              submit: true,
            },
          ],
        })
      }
    >
      <GenerativeUISurface id="props" />
    </Page>,
  );
  const user = userEvent.setup({ document });
  // The Select filters its list by what is typed in it.
  const select = view.container.querySelector(
    '.astryx-selector button[aria-haspopup="listbox"]',
  ) as HTMLElement;
  select.focus();
  await user.keyboard("{ArrowDown}");
  const search = view.container.querySelector(
    'input[enterkeyhint="search"]',
  ) as HTMLInputElement;
  await user.type(search, "bus");
  expect(view.getByRole("option", { name: "business" })).toBeTruthy();
  expect(view.queryByRole("option", { name: "economy" })).toBeNull();
  // happy-dom does not complete a pointer pick in the list; the arrows and Enter take the one left.
  await user.keyboard("{ArrowDown}{Enter}");
  expect(select.textContent).toBe("business");

  // The marks are drawn with their labels, and the steps divide the range: 20 over 4 steps is 5.
  expect(view.getByText("High")).toBeTruthy();
  const rating = view.getByRole("slider", { name: "Rating" });
  rating.focus();
  await user.keyboard("{ArrowRight}");
  await user.keyboard("{ArrowRight}");
  // A text area takes the height the Bot gives it.
  expect(view.getByLabelText("Note").getAttribute("rows")).toBe("5");

  fireEvent.submit(view.container.querySelector("form") as HTMLFormElement);
  expect(sent).toEqual(["Class\n\nclass: business\nrating: 10\nnote: "]);
});
test("a time field and a date-and-time field write the time in the format the catalog asks for", async () => {
  sent.length = 0;
  const view = render(
    <Page
      ui={OPENBOT_UI}
      surfaces={(commit) =>
        commit({
          surfaceId: "times",
          dataModel: { at: "09:30", slot: "2026-10-23T09:30" },
          components: [
            {
              ...form("root", "sendTimes", ["at", "slot"]),
              children: ["at", "slot", "root-send"],
            },
            // enableTime on its own is a time; with enableDate as well it is a date and a time.
            {
              id: "at",
              component: "DateTimeInput",
              label: "At",
              enableTime: true,
              value: { "@path": "/at" },
            },
            {
              id: "slot",
              component: "DateTimeInput",
              label: "Slot",
              enableDate: true,
              enableTime: true,
              value: { "@path": "/slot" },
            },
            {
              id: "root-send",
              component: "Button",
              label: "Send",
              submit: true,
            },
          ],
        })
      }
    >
      <GenerativeUISurface id="times" />
    </Page>,
  );
  expect(view.container.querySelector(".astryx-time-input")).toBeTruthy();
  expect(view.container.querySelector(".astryx-date-time-input")).toBeTruthy();
  // The time the data model holds is what the field shows.
  const at = (await view.findByLabelText("At")) as HTMLInputElement;
  expect(at.value).toMatch(/9:30/i);
  const user = userEvent.setup({ document });
  await user.clear(at);
  await user.type(at, "2:45 PM");
  await user.tab();
  // In a date and a time, the time is its own field.
  const slotTime = view.getByLabelText("Slot time") as HTMLInputElement;
  await user.clear(slotTime);
  await user.type(slotTime, "3:15 PM");
  await user.tab();

  fireEvent.submit(view.container.querySelector("form") as HTMLFormElement);
  expect(sent).toEqual([
    // ISO 8601, as the catalog asks: "HH:MM" for a time, "YYYY-MM-DDTHH:MM" for a date and a time.
    "At\n\nat: 14:45\nslot: 2026-10-23T15:15",
  ]);
});

/** A renderer for an interface that throws as soon as it is drawn, before any boundary of the SDK. */
const THROWING_ACTIVITY = {
  activityType: "generative-ui-surface",
  content: z.any(),
  render() {
    throw new Error("fixture: this interface cannot be drawn");
  },
};

test("an interface that throws before any SDK boundary is named like any other missing part", async () => {
  const view = render(
    <QueryClientProvider client={new QueryClient()}>
      <CopilotKitProvider
        agents__unsafe_dev_only={{ default: agent }}
        {...generativeUiProviderOptions(true)}
        renderActivityMessages={[THROWING_ACTIVITY]}
      >
        <CopilotChatConfigurationProvider agentId="default" threadId={THREAD}>
          <TooltipProvider>
            <ChatTranscript
              messages={[
                { id: "u1", role: "user", content: "Show me a form." },
                stored("broken", []),
              ]}
              restoring={false}
            />
          </TooltipProvider>
        </CopilotChatConfigurationProvider>
      </CopilotKitProvider>
    </QueryClientProvider>,
  );
  // The transcript's own boundary catches it, and says what is missing in a person's words rather
  // than the protocol's, with the one next step.
  expect(
    (await view.findByText("Couldn't show this part of the reply."))
      .textContent,
  ).toBeTruthy();
  expect(view.getByText("Show me a form.")).toBeTruthy();
  expect(
    view.getByText(
      "The rest of the conversation still works. Ask the Bot to send it again.",
    ),
  ).toBeTruthy();
  expect(view.queryByText(/generative-ui-surface/)).toBeNull();
});

function BookingPage() {
  return (
    <CopilotKitProvider
      agents__unsafe_dev_only={{ default: agent }}
      {...generativeUiProviderOptions(true)}
    >
      <Booking />
      <GenerativeUISurface id="booking" />
    </CopilotKitProvider>
  );
}

test("a generated form is drawn by Astryx controls and submits the values that were entered", async () => {
  sent.length = 0;
  const view = render(<BookingPage />);
  const field = (await view.findByLabelText("Name")) as HTMLInputElement;
  expect(field.closest(".astryx-text-input")).toBeTruthy();

  const user = userEvent.setup({ document });
  await user.clear(field);
  await user.type(field, "Grace");
  await user.type(view.getByLabelText("Note"), "Quiet car");
  await user.click(view.getByLabelText("Window seat"));
  const select = view.getByRole("combobox", { name: "Class" });
  expect(select.closest(".astryx-selector")).toBeTruthy();
  // happy-dom does not complete a pointer pick in the list; the browser fixture covers the click.
  // The first ArrowDown opens the list and the next moves to the option after the chosen one.
  select.focus();
  await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");
  expect(select.textContent).toBe("business");

  // happy-dom does not perform a submit button's implicit form submission; the browser fixture
  // covers the real click. This is the submit event either way.
  fireEvent.submit(view.container.querySelector("form") as HTMLFormElement);
  expect(sent).toEqual([
    // The event as the agent receives it: the label CopilotKit resolves for the form, then each bound field.
    "Name\n\nname: Grace\nnote: Quiet car\nclass: business\nwindow: true\nguests: 2",
  ]);
});

test("a stored form from before the A2UI version upgrade still draws and submits", async () => {
  sent.length = 0;
  // The operations a Bot wrote on CopilotKit 1.83: the same A2UI version spelled "v1.0".
  const stored: Message = {
    id: "activity-legacy",
    role: "activity",
    activityType: "generative-ui-surface",
    content: {
      surfaceId: "legacy",
      target: "chat",
      catalogId: OPENBOT_UI.id,
      status: "ready",
      rejected: [],
      operations: [
        {
          version: "v1.0",
          createSurface: {
            surfaceId: "legacy",
            catalogId: OPENBOT_UI.id,
            dataModel: { destination: "Paris" },
          },
        },
        {
          version: "v1.0",
          updateComponents: {
            surfaceId: "legacy",
            components: [
              {
                id: "root",
                component: "Form",
                children: ["destination", "save"],
                onSubmit: {
                  event: {
                    name: "saveDestination",
                    context: { destination: { "@path": "/destination" } },
                  },
                },
              },
              {
                id: "destination",
                component: "TextField",
                label: "Destination",
                value: { "@path": "/destination" },
              },
              { id: "save", component: "Button", label: "Save", submit: true },
            ],
          },
        },
      ],
    },
  };
  const messages = withCurrentA2uiVersions([stored]);
  expect(
    (
      messages[0]!.content as { operations: { version: string }[] }
    ).operations.map((operation) => operation.version),
  ).toEqual(["1.0", "1.0"]);

  const view = render(
    <QueryClientProvider client={new QueryClient()}>
      <CopilotKitProvider
        agents__unsafe_dev_only={{ default: agent }}
        {...generativeUiProviderOptions(true)}
      >
        <CopilotChatConfigurationProvider agentId="default" threadId={THREAD}>
          <TooltipProvider>
            <ChatTranscript messages={messages} restoring={false} />
          </TooltipProvider>
        </CopilotChatConfigurationProvider>
      </CopilotKitProvider>
    </QueryClientProvider>,
  );
  const destination = (await view.findByLabelText(
    "Destination",
  )) as HTMLInputElement;
  expect(destination.closest(".astryx-text-input")).toBeTruthy();
  expect(destination.value).toBe("Paris");

  const user = userEvent.setup({ document });
  await user.clear(destination);
  await user.type(destination, "Rome");
  fireEvent.submit(destination.form as HTMLFormElement);
  expect(sent).toEqual(["Destination\n\ndestination: Rome"]);
});

test("a failed check shows its message only once the control has been used, and blocks its button", async () => {
  sent.length = 0;
  const check = { condition: false, message: "Enter a name." };
  const view = render(
    <Page
      ui={OPENBOT_UI}
      surfaces={(commit) =>
        commit({
          surfaceId: "checks",
          dataModel: { name: "" },
          components: [
            // A surface is drawn from its `root` node, whatever component it is.
            {
              ...form("root", "sendCheck", ["name"]),
              children: ["name", "root-send"],
            },
            {
              id: "name",
              component: "TextField",
              label: "Name",
              value: { "@path": "/name" },
              checks: [check],
            },
            {
              id: "root-send",
              component: "Button",
              label: "Send",
              submit: true,
              checks: [check],
            },
          ],
        })
      }
    >
      <GenerativeUISurface id="checks" />
    </Page>,
  );
  // A fresh form does not open full of errors; a button whose check fails is disabled, and says why.
  await view.findByLabelText("Name");
  const send = view.getByRole("button", { name: "Send" });
  expect(send.getAttribute("aria-disabled")).toBe("true");
  expect(send.closest(".astryx-button")).toBeTruthy();
  expect(send.getAttribute("aria-describedby") ?? send.title).toBeTruthy();

  // Once the field has been left, it says why too.
  const name = view.getByLabelText("Name");
  await userEvent.setup({ document }).type(name, "A");
  await userEvent.setup({ document }).tab();
  await waitFor(() =>
    expect(view.getAllByText("Enter a name.").length).toBeGreaterThan(1),
  );
  expect(sent).toEqual([]);
});

test("each choice and date control draws with Astryx and writes what was picked", async () => {
  sent.length = 0;
  const view = render(
    <Page
      ui={OPENBOT_UI}
      surfaces={(commit) =>
        commit({
          surfaceId: "picks",
          dataModel: {
            class: "economy",
            extras: ["bag"],
            seat: [],
            day: "2026-10-23",
          },
          components: [
            form("root", "sendPicks", ["class", "extras", "seat", "day"]),
            {
              id: "class",
              component: "RadioGroup",
              label: "Class",
              direction: "col",
              options: ["economy", "business"],
              value: { "@path": "/class" },
            },
            {
              id: "extras",
              component: "ChoicePicker",
              label: "Extras",
              variant: "multipleSelection",
              options: ["bag", "meal"],
              value: { "@path": "/extras" },
            },
            {
              id: "seat",
              component: "ChoicePicker",
              label: "Seat",
              displayStyle: "chips",
              options: ["aisle", "window"],
              value: { "@path": "/seat" },
            },
            {
              id: "day",
              component: "DateTimeInput",
              label: "Day",
              value: { "@path": "/day" },
            },
            {
              id: "root-send",
              component: "Button",
              label: "Send",
              submit: true,
            },
          ],
        })
      }
    >
      <GenerativeUISurface id="picks" />
    </Page>,
  );
  const user = userEvent.setup({ document });
  // Each control is the Astryx component for it.
  await view.findByLabelText("Class", {}, { timeout: 5000 });
  for (const name of [
    "astryx-radio-list",
    "astryx-checkbox-input",
    "astryx-button",
    "astryx-date-input",
  ])
    expect(view.container.querySelector(`.${name}`), name).toBeTruthy();

  await user.click(view.getByRole("radio", { name: "business" }));
  await user.click(view.getByRole("checkbox", { name: "meal" }));
  await user.click(view.getByRole("button", { name: "window" }));
  expect(view.getByLabelText("Day").closest(".astryx-date-input")).toBeTruthy();

  fireEvent.submit(view.container.querySelector("form") as HTMLFormElement);
  await waitFor(() =>
    expect(sent).toEqual([
      // CopilotKit writes a list value as JSON.
      'Class\n\nclass: business\nextras: ["bag","meal"]\nseat: ["window"]\nday: 2026-10-23',
    ]),
  );
});

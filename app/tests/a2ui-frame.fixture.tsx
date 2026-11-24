import type { Message } from "@ag-ui/core";
import {
  CopilotChatConfigurationProvider,
  CopilotKitProvider,
} from "@copilotkit/react-core/v2";
import { createGenerativeUI } from "@copilotkit/react-core/v2/generative-ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { z } from "zod";
import { astryxScope } from "@/components/astryx-pilot/theme";
import { ChatTranscript } from "@/components/channels/chat-transcript";
import { TooltipProvider } from "@/components/ui/tooltip";
import { generativeUiProviderOptions, OPENBOT_UI } from "@/lib/copilot/a2ui";

/**
 * A conversation with interfaces a Bot drew, as a page of its own for a2ui-frame.test.tsx to bundle
 * and load in Chromium. Each interface arrives the way the runtime delivers it, as a
 * `generative-ui-surface` activity, so CopilotKit's own renderer draws its frame around it.
 *
 * `?only=<surface>` draws one of them, under the starter request that asks for a trip budget.
 *
 * `forms` is two forms side by side in one interface, one of them with a part that cannot be drawn.
 * It is the only one drawn from a catalog that has such a part. The turns its events start are
 * written to `window.__sent`.
 */
const THREAD = "thread-a2ui-frame";

type Component = Record<string, unknown> & { id: string; component: string };

/** A catalog with one component that cannot be drawn, for a form that fails to render. */
const FAILING_UI = createGenerativeUI({
  id: "test/failing@1",
  extends: [OPENBOT_UI],
  components: {
    Broken: {
      description: "A part that cannot be drawn",
      props: z.object({}),
      component() {
        throw new Error("This part cannot be drawn.");
      },
    },
  },
});

function surface(
  surfaceId: string,
  components: Component[],
  catalogId = OPENBOT_UI.id,
  dataModel: Record<string, unknown> = {
    transport: 100,
    lodging: 250,
    food: 80,
  },
): Message {
  return {
    id: `activity-${surfaceId}`,
    role: "activity",
    activityType: "generative-ui-surface",
    content: {
      surfaceId,
      target: "chat",
      catalogId,
      status: "ready",
      rejected: [],
      operations: [
        {
          version: "1.0",
          createSurface: {
            surfaceId,
            catalogId,
            dataModel,
          },
        },
        { version: "1.0", updateComponents: { surfaceId, components } },
      ],
    },
  };
}

const amount = (key: string, label: string): Component => ({
  id: key,
  component: "TextField",
  label,
  variant: "number",
  value: { "@path": `/${key}` },
});

/** What the trip budget starter draws: everything in one Card. */
const BUDGET: Component[] = [
  { id: "root", component: "Card", child: "body" },
  {
    id: "body",
    component: "Column",
    children: ["title", "caption", "total", "transport", "lodging", "food"],
  },
  {
    id: "title",
    component: "Text",
    text: "Weekend trip budget",
    size: "lg",
    strong: true,
  },
  {
    id: "caption",
    component: "Text",
    text: "Sample amounts, not live prices. Edit each cost to update the total.",
    color: "secondary",
    size: "sm",
  },
  {
    id: "total",
    component: "Text",
    strong: true,
    text: {
      "@call": "calc",
      args: {
        expression: "'Total $' + (transport + lodging + food)",
        transport: { "@path": "/transport" },
        lodging: { "@path": "/lodging" },
        food: { "@path": "/food" },
      },
    },
  },
  amount("transport", "Transport ($)"),
  amount("lodging", "Lodging ($)"),
  amount("food", "Food ($)"),
];

/** A form whose submit event carries each of its fields. `extra` are children it does not bind. */
const form = (
  id: string,
  event: string,
  fields: Component[],
  extra: string[] = [],
): Component => ({
  id,
  component: "Form",
  children: [...fields.map((field) => field.id), ...extra, `${id}-send`],
  onSubmit: {
    event: {
      name: event,
      context: Object.fromEntries(
        fields.map((field) => [field.id, { "@path": `/${field.id}` }]),
      ),
    },
  },
});

/** The button at the end of a form, which submits it. */
const send = (id: string): Component => ({
  id: `${id}-send`,
  component: "Button",
  label: `Send ${id}`,
  submit: true,
});

const SURFACES: Record<string, Component[]> = {
  budget: BUDGET,
  /** A Card that names itself for a screen reader. */
  labelled: [
    {
      id: "root",
      component: "Card",
      child: "line",
      accessibility: { label: "Packing list" },
    },
    { id: "line", component: "Text", text: "Passport, charger, rain jacket." },
  ],
  /** No Card at all: the frame is the only box the interface has. */
  plain: [
    { id: "root", component: "Column", children: ["heading", "line"] },
    {
      id: "heading",
      component: "Text",
      text: "Before you go",
      strong: true,
    },
    {
      id: "line",
      component: "Text",
      text: "Check the forecast and book the train by Thursday.",
      color: "secondary",
    },
  ],
  /** A Card that draws no box of its own. */
  section: [
    { id: "root", component: "Card", variant: "section", child: "line" },
    { id: "line", component: "Text", text: "Saturday: museum, then dinner." },
  ],
};

/**
 * Two forms in one interface, with a line of prose around them. The first holds a part that cannot
 * be drawn; the second is whole, and has a field, a check box, a radio group, a slider and a list.
 */
const WHO: Component = {
  id: "who",
  component: "TextField",
  label: "Who",
  value: { "@path": "/who" },
};
const WHAT: Component = {
  id: "what",
  component: "TextField",
  label: "What",
  value: { "@path": "/what" },
};
const WINDOW: Component = {
  id: "window",
  component: "CheckBox",
  label: "Window seat",
  value: { "@path": "/window" },
};
const CLASS: Component = {
  id: "class",
  component: "RadioGroup",
  label: "Class",
  direction: "col",
  options: ["economy", "business"],
  value: { "@path": "/class" },
};
const GUESTS: Component = {
  id: "guests",
  component: "Slider",
  label: "Guests",
  min: 1,
  max: 5,
  value: { "@path": "/guests" },
};

const DECK: Component = {
  id: "deck",
  component: "Select",
  label: "Deck",
  options: ["lower", "upper"],
  value: { "@path": "/deck" },
};

const FORMS: Component[] = [
  {
    id: "root",
    component: "Column",
    children: ["intro", "broken", "aside", "good"],
  },
  { id: "intro", component: "Text", text: "Two forms follow." },
  form("broken", "sendBroken", [WHO], ["boom"]),
  WHO,
  { id: "boom", component: "Broken" },
  send("broken"),
  { id: "aside", component: "Text", text: "This line is still readable." },
  form("good", "sendGood", [WHAT, WINDOW, CLASS, GUESTS, DECK]),
  WHAT,
  WINDOW,
  CLASS,
  GUESTS,
  DECK,
  send("good"),
];

/** `window.__sent`: the user turns the forms' events start, as the agent receives them. */
declare global {
  interface Window {
    __sent: string[];
  }
}
window.__sent = [];
type Agent = NonNullable<
  ComponentProps<typeof CopilotKitProvider>["agents__unsafe_dev_only"]
>[string];

/**
 * The agent the forms' events go to. It records the turns they start in `window.__sent` and runs
 * nothing: there is no runtime behind this page.
 */
const agent = {
  agentId: "default",
  threadId: THREAD,
  messages: [],
  isRunning: false,
  subscribe: () => ({ unsubscribe() {} }),
  addMessage: (message: { content: string }) => {
    window.__sent.push(String(message.content));
  },
  runAgent: () => Promise.resolve({ newMessages: [] }),
} as unknown as Agent;

const only = new URLSearchParams(location.search).get("only");
const forms = only === "forms";
const messages: Message[] = [
  {
    id: "u1",
    role: "user",
    content:
      "Build an interactive weekend trip budget in this conversation. Start with transport $100, lodging $200 and food $80.",
  },
  ...(only === "forms"
    ? [
        surface("forms", FORMS, FAILING_UI.id, {
          who: "",
          what: "",
          window: false,
          class: "economy",
          guests: 2,
          deck: "lower",
        }),
      ]
    : Object.entries(SURFACES)
        .filter(([name]) => !only || name === only)
        .map(([name, components]) => surface(name, components))),
];

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});

const options = generativeUiProviderOptions(true);
const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <QueryClientProvider client={queryClient}>
      <CopilotKitProvider
        agents__unsafe_dev_only={{ default: agent }}
        {...options}
        generativeUI={{
          ...options.generativeUI,
          ui: forms ? FAILING_UI : OPENBOT_UI,
        }}
      >
        <CopilotChatConfigurationProvider agentId="default" threadId={THREAD}>
          <TooltipProvider>
            <div
              {...astryxScope}
              style={{
                display: "flex",
                flexDirection: "column",
                height: "100vh",
              }}
            >
              <ChatTranscript messages={messages} restoring={false} />
            </div>
          </TooltipProvider>
        </CopilotChatConfigurationProvider>
      </CopilotKitProvider>
    </QueryClientProvider>,
  );
}

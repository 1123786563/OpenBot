import type { Message } from "@ag-ui/core";
import {
  CopilotChatConfigurationProvider,
  CopilotKitProvider,
} from "@copilotkit/react-core/v2";
import { createGenerativeUI } from "@copilotkit/react-core/v2/generative-ui";
import {
  BACKGROUNDS,
  BORDER_COLORS,
  RADII,
} from "@copilotkit/shared/generative-ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { z } from "zod";
import { astryxScope } from "@/components/astryx-pilot/theme";
import { ChatTranscript } from "@/components/channels/chat-transcript";
import { TooltipProvider } from "@/components/ui/tooltip";
import { generativeUiProviderOptions, OPENBOT_UI } from "@/lib/copilot/a2ui";
import { withCurrentA2uiVersions } from "@/lib/copilot/thread-messages";

/**
 * A conversation with interfaces a Bot drew, as a page of its own for a2ui-frame.test.tsx to bundle
 * and load in Chromium. Each interface arrives the way the runtime delivers it, as a
 * `generative-ui-surface` activity, so CopilotKit's own renderer draws its frame around it.
 *
 * `?only=<surface>` draws one of them, under the starter request that asks for a trip budget.
 *
 * `forms` is two forms side by side in one interface, one of them with a part that cannot be drawn.
 * `refused` is the interfaces the SDK could not draw in part or in whole, `legacy` a form stored by
 * an earlier CopilotKit, `controls` one form with every control in it, `tokens` a form and a
 * pressable in colours and corners the theme names no variable for, and `scrolls` a form and a
 * pressable that scroll. The turns their events start are written to `window.__sent`. `forms` and
 * `refused` are the only ones drawn from a catalog that has a part that cannot be drawn.
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
  {
    catalogId = OPENBOT_UI.id,
    dataModel = {
      transport: 100,
      lodging: 250,
      food: 80,
    },
    version = "1.0",
    refused = [],
  }: {
    catalogId?: string;
    dataModel?: Record<string, unknown>;
    /** The A2UI version each operation says, as it is stored. */
    version?: string;
    /** Updates the runtime refused, as the stored message reports them. */
    refused?: { index: number; reason: string }[];
  } = {},
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
      rejected: refused,
      operations: [
        {
          version,
          createSurface: {
            surfaceId,
            catalogId,
            dataModel,
          },
        },
        { version, updateComponents: { surfaceId, components } },
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

/**
 * Interfaces the SDK could not draw in part or in whole. Each is its own card in the conversation.
 *
 * - `bound`: a control bound to a text field's value. It passes the runtime and fails only when it
 *   is drawn, where no error boundary is involved, so the SDK swaps in its own error node: once
 *   inside a form and once outside any.
 * - `refused`: a form that lists a field only its third update creates, and that update was refused.
 * - `unbuilt`: a surface whose creation the browser refuses. Its frame stays, empty, with its line.
 * - `thrown`: a part that throws, in a page whose error state throws too, so the whole surface is
 *   replaced by the SDK's own node.
 *
 * `window.__sent` holds what their events start.
 */
const NAME: Component = {
  id: "name",
  component: "TextField",
  label: "Name",
  value: { "@path": "/name" },
};
const REFUSED: Message[] = [
  surface(
    "bound",
    [
      {
        id: "root",
        component: "Column",
        children: ["intro", "bad", "stray", "aside", "good"],
      },
      { id: "intro", component: "Text", text: "Two forms follow." },
      {
        ...form("bad", "sendBad", [WHO]),
        children: ["who", "named", "bad-send"],
      },
      WHO,
      {
        id: "named",
        component: "CheckBox",
        label: "Is named",
        value: { "@path": "/who" },
      },
      send("bad"),
      // The same mistake outside a form: the SDK's node stays, in the app's error colours.
      {
        id: "stray",
        component: "Slider",
        label: "Guests",
        value: { "@path": "/who" },
      },
      { id: "aside", component: "Text", text: "This line is still readable." },
      form("good", "sendGood", [WHAT]),
      WHAT,
      send("good"),
    ],
    { dataModel: { who: "", what: "" } },
  ),
  surface(
    "refused",
    [
      {
        ...form("root", "sendRefused", [NAME]),
        children: ["name", "note", "root-send"],
      },
      NAME,
      {
        id: "root-send",
        component: "Button",
        label: "Send refused",
        submit: true,
      },
    ],
    {
      dataModel: { name: "", note: "" },
      refused: [{ index: 2, reason: 'component "note": unknown prop "labl"' }],
    },
  ),
  {
    id: "activity-unbuilt",
    role: "activity",
    activityType: "generative-ui-surface",
    content: {
      surfaceId: "unbuilt",
      target: "chat",
      catalogId: OPENBOT_UI.id,
      status: "ready",
      rejected: [],
      operations: [
        {
          version: "1.0",
          createSurface: {
            surfaceId: "unbuilt",
            catalogId: OPENBOT_UI.id,
            components: [{ id: "root", component: "Nope" }],
          },
        },
      ],
    },
  },
  surface(
    "thrown",
    [
      { id: "root", component: "Column", children: ["boom"] },
      { id: "boom", component: "Broken" },
    ],
    { catalogId: FAILING_UI.id, dataModel: {} },
  ),
];

/** A form a Bot drew on CopilotKit 1.83, as it is stored, read the way the app reads it on reopening. */
const DESTINATION: Component = {
  id: "destination",
  component: "TextField",
  label: "Destination",
  value: { "@path": "/destination" },
};
const LEGACY: Message[] = withCurrentA2uiVersions([
  surface(
    "legacy",
    [
      form("root", "saveDestination", [DESTINATION]),
      DESTINATION,
      { id: "root-send", component: "Button", label: "Save", submit: true },
    ],
    { dataModel: { destination: "Paris" }, version: "v1.0" },
  ),
]);

/**
 * One form with every control the catalog has that OpenBot draws itself, plus
 * the one it leaves to the SDK, in the states a chat shows: typed text, picked
 * and unpicked, a date, a time and both, a slider with marks, a list that can
 * be searched, a breakdown, and buttons in each variant and state.
 */
const CHOICE = (
  id: string,
  options: string[],
  extra: Record<string, unknown> = {},
): Component => ({
  id,
  component: "ChoicePicker",
  label: id[0]?.toUpperCase() + id.slice(1),
  options,
  value: { "@path": `/${id}` },
  ...extra,
});
/** The controls that hold a value, each bound to its own entry in the data model. */
const CONTROLS_FIELDS: Component[] = [
  NAME,
  {
    id: "note",
    component: "TextArea",
    label: "Note",
    value: { "@path": "/note" },
  },
  CHOICE("extras", ["bag", "meal"], { variant: "multipleSelection" }),
  CHOICE("seat", ["aisle", "window"], { displayStyle: "chips" }),
  CHOICE("alone", ["morning", "evening"]),
  {
    id: "trip",
    component: "SegmentedControl",
    label: "Trip",
    options: ["economy", "business"],
    value: { "@path": "/trip" },
  },
  { id: "agree", component: "Radio", label: "Agree to the terms" },
  {
    id: "day",
    component: "DateTimeInput",
    label: "Day",
    value: { "@path": "/day" },
  },
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
    id: "deck",
    component: "Select",
    label: "Deck",
    searchable: true,
    options: ["lower", "upper"],
    value: { "@path": "/deck" },
  },
  {
    id: "split",
    component: "Breakdown",
    totalLabel: "Budget",
    currency: "USD",
    items: { "@path": "/split" },
  },
];
const CONTROLS: Message[] = [
  surface(
    "controls",
    [
      form("root", "sendControls", CONTROLS_FIELDS, [
        "press",
        "remove",
        "plain",
        "working",
        "still",
        "link",
      ]),
      ...CONTROLS_FIELDS,
      {
        id: "press",
        component: "Pressable",
        children: ["press-text"],
        onClick: { event: { name: "pressed" } },
      },
      { id: "press-text", component: "Text", text: "Press me" },
      { id: "remove", component: "Button", label: "Remove", color: "danger" },
      {
        id: "plain",
        component: "Button",
        label: "Plain",
        variant: "borderless",
      },
      { id: "working", component: "Button", label: "Working", loading: true },
      { id: "still", component: "Button", label: "Still here", disabled: true },
      {
        id: "link",
        component: "Button",
        label: "Docs",
        href: "https://example.test/docs",
      },
      { id: "root-send", component: "Button", label: "Send", submit: true },
    ],
    {
      dataModel: {
        name: "Ada",
        note: "Window seat, please",
        extras: ["bag"],
        seat: ["window"],
        alone: [],
        trip: "economy",
        agree: false,
        day: "2026-10-23",
        at: "09:30",
        slot: "2026-10-23T09:30",
        rating: 10,
        deck: "lower",
        split: [
          { label: "Transport", amount: 100 },
          { label: "Lodging", amount: 250 },
        ],
      },
    },
  ),
];

/**
 * Layout values the app's theme names no `--a2ui-*` variable for. The catalog's tokens are not CSS:
 * drawn as the SDK resolves them, its own light value is behind the variable, and its dark value
 * under the `dark` class. First a form and a pressable with known values, then one part for every
 * value in the SDK's own lists.
 */
const TOKEN_PARTS: Component[] = [
  {
    id: "tinted",
    component: "Form",
    label: "Tinted",
    background: "success",
    radius: "2xs",
    children: ["tinted-text"],
  },
  {
    id: "tinted-text",
    component: "Text",
    text: "A tint, with small corners.",
  },
  {
    id: "framed",
    component: "Pressable",
    border: true,
    borderColor: "info",
    radius: "xs",
    children: ["framed-text"],
  },
  { id: "framed-text", component: "Text", text: "Framed" },
  {
    // A border with no colour named: the theme's own default border colour.
    id: "outlined",
    component: "Pressable",
    border: true,
    children: ["outlined-text"],
  },
  { id: "outlined-text", component: "Text", text: "Outlined" },
  ...BACKGROUNDS.map((token, index) => ({
    id: `background-${index}`,
    component: "Form",
    label: `Background ${token}`,
    background: token,
    children: [],
  })),
  ...BORDER_COLORS.flatMap((token, index) => [
    {
      id: `border-${index}`,
      component: "Pressable",
      border: true,
      borderColor: token,
      children: [`border-${index}-text`],
    },
    { id: `border-${index}-text`, component: "Text", text: `Border ${token}` },
  ]),
  ...RADII.map((token, index) => ({
    id: `radius-${index}`,
    component: "Form",
    label: `Radius ${token}`,
    radius: token,
    children: [],
  })),
];
const TOKENS: Message[] = [
  surface(
    "tokens",
    [
      {
        id: "root",
        component: "Column",
        children: TOKEN_PARTS.map(({ id }) => id),
      },
      ...TOKEN_PARTS,
    ],
    { dataModel: {} },
  ),
];

/** Four lines that together stand taller than the box that holds them. */
const TALL = (prefix: string): Component[] =>
  ["First line.", "Second line.", "Third line.", "Fourth line."].map(
    (text, index) => ({
      id: `${prefix}-${index}`,
      component: "Text",
      text,
    }),
  );

/**
 * Two boxes that scroll, a form and a pressable: each is shorter than what it holds, so the
 * keyboard has to be able to scroll it. The form holds a field, as a form that scrolls does.
 */
const SCROLLABLE: Message[] = [
  surface(
    "scrolls",
    [
      { id: "root", component: "Column", children: ["scrolls", "pans"] },
      {
        id: "scrolls",
        component: "Form",
        label: "Scrolls",
        scrollable: true,
        height: 12,
        children: [...TALL("line").map(({ id }) => id), "note"],
      },
      ...TALL("line"),
      {
        id: "note",
        component: "TextField",
        label: "Note",
        value: { "@path": "/note" },
      },
      {
        id: "pans",
        component: "Pressable",
        scrollable: true,
        height: 12,
        children: TALL("pan").map(({ id }) => id),
      },
      ...TALL("pan"),
    ],
    { dataModel: { note: "" } },
  ),
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
const refused = only === "refused";
const messages: Message[] = [
  {
    id: "u1",
    role: "user",
    content:
      "Build an interactive weekend trip budget in this conversation. Start with transport $100, lodging $200 and food $80.",
  },
  ...(only === "forms"
    ? [
        surface("forms", FORMS, {
          catalogId: FAILING_UI.id,
          dataModel: {
            who: "",
            what: "",
            window: false,
            class: "economy",
            guests: 2,
            deck: "lower",
          },
        }),
      ]
    : only === "refused"
      ? REFUSED
      : only === "legacy"
        ? LEGACY
        : only === "controls"
          ? CONTROLS
          : only === "tokens"
            ? TOKENS
            : only === "scrolls"
              ? SCROLLABLE
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
          ui: forms || refused ? FAILING_UI : OPENBOT_UI,
          // The surface that throws: its part throws, and so does the error state that replaces it.
          ...(refused
            ? {
                errorBoundary: {
                  fallback() {
                    throw new Error("This error state cannot be drawn.");
                  },
                },
              }
            : {}),
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

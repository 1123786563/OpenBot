import {
  CopilotKitProvider,
  type CopilotKitProviderProps,
} from "@copilotkit/react-core/v2";
import {
  GenerativeUISurface,
  useGenerativeUIRuntime,
} from "@copilotkit/react-core/v2/generative-ui";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
import { generativeUiProviderOptions, OPENBOT_UI } from "@/lib/copilot/a2ui";

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

  // happy-dom does not perform a submit button's implicit form submission; the browser fixture
  // covers the real click. This is the submit event either way.
  fireEvent.submit(view.container.querySelector("form") as HTMLFormElement);
  expect(sent).toEqual([
    // The event as the agent receives it: the label CopilotKit resolves for the form, then each bound field.
    "Name\n\nname: Grace\nnote: Quiet car\nclass: economy\nwindow: true\nguests: 2",
  ]);
});

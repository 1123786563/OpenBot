import {
  DECLINED_BY_PERSON,
  OUTCOME_UNKNOWN,
  WITHDRAWN_APPROVALS_OFF,
  decisionInvalidated,
  notCarriedOut,
  notDoneOnRecheck,
} from "@openbot/shared/approval-outcomes";
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { InlineApproval } from "@/components/approvals/inline-approval";
import { WaitingForYou } from "@/components/approvals/waiting";
import { settleReactWork } from "./settle-react-work";

/*
 * What an approval says it is waiting on. An app's tool is asked about as `<app>/<tool>` on the app,
 * and the card in the conversation once read "Waiting for your approval: requests/get request on
 * requests", the app's key twice and the tool's raw name, where a computer action reads "click on
 * example.com". Both places a person decides one in the browser: the card in the conversation, and
 * the row on the Bot's page.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

/** A pending request as `GET /api/approvals` returns it. */
const request = (
  id: string,
  toolRef: string,
  scope: string,
  args: Record<string, unknown>,
  target: Record<string, unknown> | null = null,
) => ({
  id,
  status: "pending",
  createdAt: "2026-10-30T22:00:00Z",
  action: {
    actorId: "me",
    botId: "assistant",
    toolRef,
    effect: "write",
    scope,
    threadId: `thread-${id}`,
    runId: `run-${id}`,
    toolCallId: `call-${id}`,
    actionDigest: `digest-${id}`,
    args,
    target,
    policy: {
      behaviour: "ask",
      source: "task",
      reason: "Tasks started from a check-in ask before every change.",
    },
  },
});

function serving() {
  global.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path === "/api/approvals")
      return Response.json({
        enabled: false,
        rules: [],
        teamRules: [],
        questions: [],
        requests: [
          // An MCP server the admin added, and an app through a broker.
          request("mcp", "requests/get_request", "requests", {
            id: "r-expense",
          }),
          request(
            "brokered",
            "composio-gmail/GMAIL_SEND_EMAIL",
            "composio-gmail",
            { to: "sam@example.test" },
          ),
          request("computer", "computer_click", "example.com", {
            ref: "e12",
          }),
          // A file in a folder on the person's computer, and one on the Bot's own computer.
          request(
            "folder-file",
            "host/write_file",
            "host-grant-1",
            { path: "todo.txt" },
            { displayName: "share", relativePath: "todo.txt" },
          ),
          request(
            "computer-file",
            "computer_write_file",
            "workspace",
            { path: "notes.txt" },
            { pageUrl: "", filePath: "notes.txt" },
          ),
          // Named the way Gmail's page names it, not "settings get imap".
          request(
            "settings",
            "composio-gmail/GMAIL_SETTINGS_GET_IMAP",
            "composio-gmail",
            {},
          ),
        ],
      });
    if (path.startsWith("/api/agents"))
      return Response.json({
        agents: [{ id: "assistant", name: "General Assistant" }],
      });
    return Response.json({ error: "not served" }, { status: 404 });
  }) as unknown as typeof fetch;
}

function draw(node: ReactNode) {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      {node}
    </QueryClientProvider>,
  );
}

test("in the conversation, an app's approval names the action in words and the app by its name", async () => {
  serving();
  const view = draw(
    <>
      <InlineApproval toolCallId="call-mcp" fallback={null} />
      <InlineApproval toolCallId="call-brokered" fallback={null} />
      <InlineApproval toolCallId="call-computer" fallback={null} />
    </>,
  );
  const cards = await view.findAllByRole("region", {
    name: "Waiting for your approval",
  });
  expect(cards.map((card) => card.querySelector("p")?.textContent)).toEqual([
    "Get request on Requests",
    "Send email on Gmail",
    "Click on example.com",
  ]);
});

/*
 * FOUND ON WINDOWS (0.3.4 release candidates): one file save had three names. The card read "Write
 * file on todo.txt in share" and "Write file on workspace", the step "Save a file todo.txt in share"
 * and "Save file", and Activity "Save a file". The card says it the way the step and Activity do.
 */
test("a file save's card names it as its step and its Activity row do", async () => {
  serving();
  const view = draw(
    <>
      <InlineApproval toolCallId="call-folder-file" fallback={null} />
      <InlineApproval toolCallId="call-computer-file" fallback={null} />
    </>,
  );
  const cards = await view.findAllByRole("region", {
    name: "Waiting for your approval",
  });
  expect(cards.map((card) => card.querySelector("p")?.textContent)).toEqual([
    "Save a file todo.txt in share",
    "Save a file notes.txt",
  ]);
  expect(view.container.textContent).not.toMatch(/write file|workspace/i);
});

test("on the Bot's page, the row says what the Bot wants to do, over the app's name", async () => {
  serving();
  const view = draw(<WaitingForYou agentId="assistant" />);
  const row = (await view.findByText("General Assistant wants to get request"))
    .parentElement as HTMLElement;
  expect(row.textContent).toContain("Requests");
  expect(row.textContent).not.toContain("requests/");
  expect(
    view.getByText("General Assistant wants to send email").parentElement
      ?.textContent,
  ).toContain("Gmail");
  expect(view.getByText("General Assistant wants to click")).toBeTruthy();
  expect(
    view.getByText("General Assistant wants to get IMAP settings"),
  ).toBeTruthy();
  expect(view.container.textContent).not.toContain("composio");
});

test("a paused approval shows the result of the action already sent", async () => {
  global.fetch = Object.assign(
    async () =>
      Response.json({
        enabled: true,
        rules: [],
        teamRules: [],
        questions: [],
        requests: [
          {
            ...request("mcp", "requests/get_request", "requests", {}),
            status: "completed",
            result: {
              content: "The request was updated",
              pauseReason: "Run paused. Review in progress",
            },
          },
        ],
      }),
    { preconnect: originalFetch.preconnect },
  );
  const view = draw(
    <InlineApproval
      toolCallId="call-mcp"
      fallback={<p>Waiting for a result</p>}
    />,
  );
  const outcome = await view.findByRole("region", { name: "Paused action" });
  expect(outcome.textContent).toContain("The request was updated");
  expect(outcome.textContent).toContain("Review in progress");
});

/*
 * There is no approval that "expires" on its own. What ends a waiting request is the person
 * withdrawing it (asking switched off while it waited), the Bot's work being stopped under it, or
 * the same request being decided in another tab. Each is said on the card's line, with what to do,
 * until the Bot's own answer for that step arrives and takes the line.
 */
function decided(status: string, reason: string) {
  global.fetch = Object.assign(
    async () =>
      Response.json({
        enabled: true,
        rules: [],
        teamRules: [],
        questions: [],
        requests: [
          {
            ...request("mcp", "requests/get_request", "requests", {}),
            status,
            decidedAt: "2026-10-30T22:05:00Z",
            result: { content: reason, error: reason },
          },
        ],
      }),
    { preconnect: originalFetch.preconnect },
  );
}

test("a request withdrawn before its line has an answer is explained there, with what to do", async () => {
  decided("denied", WITHDRAWN_APPROVALS_OFF);
  const view = draw(
    <InlineApproval
      fallback={<p>Waiting for a result</p>}
      resulted={false}
      toolCallId="call-mcp"
    />,
  );
  expect(
    await view.findByText("Withdrawn. You turned off asking before changes."),
  ).toBeTruthy();
  expect(
    view.getByText("Ask the Bot again if you still need it."),
  ).toBeTruthy();
  // Not a card any more: there is nothing left to answer.
  expect(view.queryByRole("radio")).toBeNull();
  expect(view.queryByRole("button")).toBeNull();
  expect(view.queryByText("Waiting for a result")).toBeNull();
});

test("a decision the Bot's stopped work invalidated is said in the person's words", async () => {
  decided("completed", decisionInvalidated);
  const view = draw(
    <InlineApproval fallback={null} resulted={false} toolCallId="call-mcp" />,
  );
  expect(
    await view.findByText(
      "Withdrawn. The Bot's work was stopped before it could do this.",
    ),
  ).toBeTruthy();
  expect(view.queryByText(decisionInvalidated)).toBeNull();
});

test("a request the person declined is explained there, with the Bot to ask again", async () => {
  decided("denied", DECLINED_BY_PERSON);
  const view = draw(
    <InlineApproval
      fallback={<p>Waiting for a result</p>}
      resulted={false}
      toolCallId="call-mcp"
    />,
  );
  expect(await view.findByText("You declined it.")).toBeTruthy();
  expect(
    view.getByText("Ask the Bot again if you still need it."),
  ).toBeTruthy();
});

/*
 * WHAT TO DO NEXT FOLLOWS WHAT RAN. A step whose outcome nobody can vouch for, or that could not be
 * carried out, may have happened, so "Ask the Bot again if you still need it." under it was wrong.
 * The sentence the server sends is written for the Bot and tells it to check whether it happened
 * first; the person reads only what happened, so the check is said beside it in the person's words.
 */
test.each([
  [
    OUTCOME_UNKNOWN,
    "It started, but OpenBot can't tell whether it finished. It wasn't run again.",
  ],
  [
    notCarriedOut("the computer said: disk full. try later"),
    "Not done: this action could not be carried out (the computer said: disk full. try later).",
  ],
])(
  "a step that may have run (%#) is explained, with the check its Bot's sentence asks for",
  async (reason, read) => {
    decided("completed", reason);
    const view = draw(
      <InlineApproval fallback={null} resulted={false} toolCallId="call-mcp" />,
    );
    expect(await view.findByText(read)).toBeTruthy();
    expect(
      view.getByText("Check whether it happened before you ask the Bot again."),
    ).toBeTruthy();
    expect(
      view.queryByText("Ask the Bot again if you still need it."),
    ).toBeNull();
  },
);

test("a step turned away by the check just before it ran is explained there, with the Bot to ask again", async () => {
  // Nothing ran: the check before the step refused it, and says why.
  decided(
    "completed",
    notDoneOnRecheck("The rule that allowed this was removed before it ran."),
  );
  const view = draw(
    <InlineApproval fallback={null} resulted={false} toolCallId="call-mcp" />,
  );
  expect(
    await view.findByText(
      "Not done: The rule that allowed this was removed before it ran.",
    ),
  ).toBeTruthy();
  expect(
    view.getByText("Ask the Bot again if you still need it."),
  ).toBeTruthy();
});

test("once the step has its own answer, the line is the tool's again", async () => {
  decided("denied", WITHDRAWN_APPROVALS_OFF);
  const view = draw(
    <InlineApproval
      fallback={<p>Withdrawn. You turned off asking before changes.</p>}
      resulted
      toolCallId="call-mcp"
    />,
  );
  expect(
    await view.findByText("Withdrawn. You turned off asking before changes."),
  ).toBeTruthy();
  expect(
    view.queryByText("Ask the Bot again if you still need it."),
  ).toBeNull();
});

/** A waiting request, and a decision route that answers as `decide` does and records what was sent. */
function answering(decide: () => Response) {
  const posts: unknown[] = [];
  global.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/approvals")
        return Response.json({
          enabled: true,
          rules: [],
          teamRules: [],
          questions: [],
          requests: [
            request("mcp", "requests/get_request", "requests", {
              id: "r-expense",
            }),
          ],
        });
      if (path === "/api/approvals/mcp/decision") {
        posts.push(JSON.parse(String(init?.body)));
        return decide();
      }
      if (path.startsWith("/api/agents"))
        return Response.json({
          agents: [{ id: "assistant", name: "General Assistant" }],
        });
      return Response.json({ error: "not served" }, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
  return posts;
}

test("each answer says whether the Bot then carries on in this conversation", async () => {
  answering(() => Response.json({ id: "mcp", status: "approved" }));
  const view = draw(<InlineApproval toolCallId="call-mcp" fallback={null} />);
  const card = await view.findByRole("region", {
    name: "Waiting for your approval",
  });
  expect(
    await view.findByText(
      "The Bot does it this time, then carries on in this conversation. You're asked again next time.",
    ),
  ).toBeTruthy();
  expect(card.textContent).toContain(
    "The Bot doesn't do it and is told you said no, then carries on without it.",
  );
});

test("a second press while the first decision is on its way sends nothing more", async () => {
  // As the server does: it refuses a second decision on the same request. One row, one continuation.
  const posts = answering(() =>
    Response.json({ id: "mcp", status: "approved" }),
  );
  const view = draw(<InlineApproval toolCallId="call-mcp" fallback={null} />);
  const user = userEvent.setup({ document: view.container.ownerDocument });
  const allow = await view.findByRole("button", { name: "Allow once" });
  await user.dblClick(allow);
  await waitFor(() =>
    expect(view.getAllByText("Allowed once").length).toBeGreaterThan(0),
  );
  expect(posts).toEqual([{ decision: "allow_once" }]);
});

test("a decision the server already has is said on the card in the server's words", async () => {
  // Decided in another tab a moment earlier: the same card here is a press too late.
  answering(() =>
    Response.json(
      { error: "This request was already decided." },
      { status: 400 },
    ),
  );
  const view = draw(<InlineApproval toolCallId="call-mcp" fallback={null} />);
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.click(await view.findByRole("button", { name: "Allow once" }));
  expect(
    await view.findByText("This request was already decided."),
  ).toBeTruthy();
});

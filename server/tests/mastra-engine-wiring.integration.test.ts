import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { createServer } from "node:http";
import type { BaseEvent, Message, RunAgentInput } from "@ag-ui/client";
import { createOpenAI } from "@ai-sdk/openai";
import {
  afterAll,
  beforeAll,
  expect,
  test,
} from "../../tests/support/bun-test-compat";
import { authorizeAttachmentForSendInTransaction } from "../src/channels/attachments";
import {
  builtInAgentConfiguration,
  setBuiltinExecutionEngine,
  setMastraConversationRuntime,
} from "../src/copilot";
import type { Database } from "../src/db/client";
import { enterprisePrincipals, users } from "../src/db/schema";
import {
  attachments as attachmentsTable,
  channelMemberships,
  channels,
} from "../src/db/schema/core";
import { enterpriseWorkspaceMemberships } from "../src/db/schema/enterprise-tenancy";
import type { PlatformScope } from "../src/enterprise/contracts";
import { createConversationService } from "../src/enterprise/conversations/service";
import type { GovernedModelRequest } from "../src/enterprise/runs/governed-execution";
import type {
  DataDatabase,
  DirectoryDatabase,
  OperatorDatabase,
} from "../src/enterprise/tenancy/connections";
import { provisionDeployment } from "../src/enterprise/tenancy/provision";
import { createScopeResolver } from "../src/enterprise/tenancy/store";
import {
  type MastraConversationBinding,
  tenantStorageKey,
} from "../src/mastra/contracts";
import { createMastraConversationRuntime } from "../src/mastra/conversation-runtime";
import { createTenantMastraStorage } from "../src/mastra/tenant-storage";
import { createMe03Fixture, type Me03Fixture } from "./support/me03-fixture";

/*
 * ME03 (#475) fix-round-1 — the PRODUCTION wiring against the real database.
 *
 * The copilot.ts mastraAgentConfiguration factory is driven exactly as the
 * governed runner drives it: the submitted user message is appended through
 * ConversationService BEFORE the factory runs (the runner's order), the run
 * input is rebuilt by `loadExecutionInput` (server-persisted, principal-
 * authorized history — never the wire echo), and the engine's answer is
 * persisted through `persistExecutionMessages` before the success terminal
 * leaves the factory. The model is the counting loopback provider (the ME01
 * fixture pattern): every request body is recorded, so these cases assert the
 * CONTEXT THE MODEL ACTUALLY SAW, not what any layer claims it rebuilt.
 */

const suffix = randomUUID().replaceAll("-", "").slice(0, 8);
const tenantA = `me03w-tenant-a-${suffix}`;
const workspaceA = `me03w-workspace-a-${suffix}`;
const ownerActor = `me03w-actor-${suffix}`;
const ownerPrincipal = `me03w-principal-${suffix}`;

let fixture: Me03Fixture;
let admin: Database;
let directory: DirectoryDatabase;
let data: DataDatabase;
let operator: OperatorDatabase;
let storage: ReturnType<typeof createTenantMastraStorage>;
let scopeA: PlatformScope;
let service: ReturnType<typeof createConversationService>;
let runtime: ReturnType<typeof createMastraConversationRuntime>;
let threadId: string;

interface RecordedDial {
  readonly model: string;
  readonly messages: { role: string; content: unknown }[];
}

let dials: RecordedDial[];
let provider: Server;
let providerUrl: string;

/**
 * The scripted OpenAI-compatible loopback: answers `wiring answer <n>` on
 * the nth dial and records the FULL request body of every dial, so the
 * assertions read what the model context actually carried.
 */
function startCountingProvider(): Promise<void> {
  dials = [];
  let dialCount = 0;
  return new Promise((resolve, reject) => {
    const server: Server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("error", () => response.destroy());
      request.on("end", () => {
        let parsed: { model?: string; messages?: RecordedDial["messages"] };
        try {
          parsed = JSON.parse(body);
        } catch {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "invalid JSON body" }));
          return;
        }
        dialCount += 1;
        dials.push({
          model: parsed.model ?? "wiring-model",
          messages: parsed.messages ?? [],
        });
        const id = `chatcmpl-wiring-${dialCount}`;
        const answer = `wiring answer ${dialCount}`;
        const chunks = [
          {
            id,
            object: "chat.completion.chunk",
            created: 1,
            model: parsed.model ?? "wiring-model",
            choices: [
              { index: 0, delta: { role: "assistant" }, finish_reason: null },
            ],
          },
          {
            id,
            object: "chat.completion.chunk",
            created: 1,
            model: parsed.model ?? "wiring-model",
            choices: [
              { index: 0, delta: { content: answer }, finish_reason: null },
            ],
          },
          {
            id,
            object: "chat.completion.chunk",
            created: 1,
            model: parsed.model ?? "wiring-model",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          },
          {
            id,
            object: "chat.completion.chunk",
            created: 1,
            model: parsed.model ?? "wiring-model",
            choices: [],
            usage: {
              prompt_tokens: 8,
              completion_tokens: 4,
              total_tokens: 12,
            },
          },
        ];
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(
          `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
        );
      });
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("wiring provider did not bind"));
        return;
      }
      provider = server;
      providerUrl = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });
}

/** The user-text sequence the model actually saw, system messages excluded. */
function dialTexts(dial: RecordedDial): string[] {
  return dial.messages
    .filter((message) => message.role !== "system")
    .map((message) =>
      typeof message.content === "string" ? message.content : "",
    );
}

let executionCounter = 0;

/**
 * One governed factory run, assembled exactly as the runner's resolver does:
 * the engine selector on, the production conversation runtime installed, and
 * a governed collaborator whose model is the loopback and whose facts are
 * server-issued per run.
 */
async function runMastraTurn(
  messages: readonly Message[],
): Promise<BaseEvent[]> {
  executionCounter += 1;
  const facts = {
    scope: scopeA,
    botId: "wiring-bot",
    runId: `wiring-run-${executionCounter}-${suffix}`,
    attemptId: `wiring-attempt-${executionCounter}-${suffix}`,
    generation: 1,
    executionKey: `wiring-exec-${executionCounter}-${suffix}`,
  };
  const chatModel = createOpenAI({
    apiKey: "wiring-synthetic-key",
    baseURL: `${providerUrl}/v1`,
  }).chat("wiring-model");
  const governedModel: GovernedModelRequest = {
    model: chatModel as unknown as GovernedModelRequest["model"],
    maxOutputTokens: 1024,
    markConsumed: () => {},
    executionBinding: () => facts,
  };
  const config = builtInAgentConfiguration(
    {
      id: "wiring-bot",
      name: "Wiring Bot",
      type: "built_in" as const,
      systemPrompt: "You are the wiring test bot.",
      expertSource: "tenant_package" as const,
    },
    {
      provider: "openai",
      defaultModel: "wiring-model",
      plan: {} as never,
    },
    null,
    [],
    undefined,
    [],
    null,
    undefined,
    undefined,
    governedModel,
    { userId: ownerActor },
    undefined,
  ) as {
    type: string;
    factory: (context: {
      input: RunAgentInput;
      abortSignal: AbortSignal;
    }) => AsyncGenerator<BaseEvent>;
  };
  expect(config.type).toBe("custom");
  const events: BaseEvent[] = [];
  for await (const event of config.factory({
    input: { threadId, messages: [...messages] },
    abortSignal: new AbortController().signal,
  })) {
    events.push(event);
  }
  return events;
}

async function appendSubmitted(key: string, content: string): Promise<void> {
  await service.append(scopeA, {
    threadId,
    clientMessageKey: key,
    content,
    attachments: [],
  });
}

beforeAll(async () => {
  fixture = await createMe03Fixture();
  admin = fixture.openDatabase(fixture.adminUrl);
  directory = await fixture.openDirectory();
  data = await fixture.openData();
  operator = await fixture.openOperator();

  const provisioner = fixture.provisioner();
  await provisioner.provision({
    tenantId: tenantA,
    storageKey: tenantStorageKey(tenantA),
    roleVersion: 1,
  });

  await admin.insert(users).values([
    {
      id: ownerActor,
      email: `${ownerActor}@example.invalid`,
      name: "ME03 wiring owner",
    },
  ]);
  await admin
    .insert(enterprisePrincipals)
    .values([{ id: ownerPrincipal, userId: ownerActor }]);
  await provisionDeployment(operator, {
    operationId: `me03w-${suffix}`,
    operator: ownerPrincipal,
    tenant: { id: tenantA, name: "ME03 wiring tenant" },
    workspace: { id: workspaceA, name: "ME03 wiring workspace" },
    members: [
      { principalId: ownerPrincipal, userId: ownerActor, role: "tenant_admin" },
    ],
    resources: [],
  });
  await admin.insert(enterpriseWorkspaceMemberships).values([
    {
      tenantId: tenantA,
      workspaceId: workspaceA,
      principalId: ownerPrincipal,
    },
  ]);

  const authenticated = new WeakMap<Request, string>();
  const resolver = createScopeResolver(directory, {
    authenticate: async (request) => {
      const actor = authenticated.get(request);
      return actor ? { actorId: actor, entrypoint: "web" } : null;
    },
    selectTenant: () => tenantA,
    selectWorkspace: () => workspaceA,
  });
  const request = new Request("https://me03w.invalid/turn");
  authenticated.set(request, ownerActor);
  scopeA = await resolver.resolve(request);

  storage = createTenantMastraStorage(fixture.lookup());
  service = createConversationService({ data, mastraStorage: storage });
  runtime = createMastraConversationRuntime({
    conversations: service,
    storage,
    authorizeAttachment: async (turn, attachmentId) =>
      data.transaction((tx) =>
        authorizeAttachmentForSendInTransaction(tx, turn, attachmentId),
      ),
  });

  // The production selection this fix-round wires: engine selector plus the
  // conversation runtime the factory refuses to run without.
  setBuiltinExecutionEngine(() => "mastra");
  setMastraConversationRuntime(runtime);

  await startCountingProvider();

  const conversation = await service.getOrCreate(scopeA, {
    title: "ME03 wiring",
  });
  expect(conversation.storage_backend).toBe("mastra");
  threadId = conversation.thread_id;
});

afterAll(async () => {
  setBuiltinExecutionEngine(undefined);
  setMastraConversationRuntime(undefined);
  const errors: unknown[] = [];
  await new Promise<void>((resolve) => {
    provider?.close(() => resolve());
    if (!provider) resolve();
  });
  await storage?.close().catch((error: unknown) => errors.push(error));
  try {
    await fixture?.drop();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length) {
    throw new AggregateError(errors, "ME03 wiring teardown failed");
  }
});

test("answer_is_persisted_before_complete_and_visible_on_reread", async () => {
  const key = `wire-1-${suffix}`;
  // The runner appends the submitted message BEFORE resolving the bot; the
  // factory then runs on the server-rebuilt history.
  await appendSubmitted(key, "hello wiring");
  const events = await runMastraTurn([
    { id: key, role: "user", content: "hello wiring" } as Message,
  ]);
  expect(events.at(-1)?.type).toBe("RUN_FINISHED");
  expect(events.some((event) => event.type === "RUN_ERROR")).toBe(false);

  // (a) The assistant answer exists in the conversation store with its full
  // parts, and a FRESH paginated re-read (the refresh path) shows it.
  const page = await service.history(scopeA, {
    threadId,
    beforeSeq: null,
    limit: 50,
  });
  const answerRow = page.items.find((item) => item.role === "assistant");
  expect(answerRow?.content).toBe("wiring answer 1");
  const reread = await service.history(scopeA, {
    threadId,
    beforeSeq: null,
    limit: 50,
  });
  expect(
    reread.items.find((item) => item.messageId === answerRow?.messageId)
      ?.content,
  ).toBe("wiring answer 1");
  const binding: MastraConversationBinding = await service.resolveMastraBinding(
    scopeA,
    threadId,
  );
  const store = await storage.getStore(scopeA, binding);
  const memory = await store.getStore("memory");
  const found = await memory?.listMessagesById({
    messageIds: [answerRow!.messageId],
  });
  const stored = found?.messages[0]?.content.metadata as {
    openbotParts?: { schemaVersion: number; role: string; parts: unknown[] };
  };
  expect(stored.openbotParts).toMatchObject({
    schemaVersion: 1,
    role: "assistant",
    parts: [{ kind: "text", text: "wiring answer 1" }],
  });
});

test("follow_up_context_comes_from_persisted_history_not_the_wire", async () => {
  // (b) A follow-up turn whose WIRE input carries only the submitted
  // message: the model context must be the server-persisted history.
  const key = `wire-2-${suffix}`;
  await appendSubmitted(key, "question two");
  const events = await runMastraTurn([
    { id: key, role: "user", content: "question two" } as Message,
  ]);
  expect(events.at(-1)?.type).toBe("RUN_FINISHED");
  expect(dials.length).toBe(2);
  // The counting loopback's second dial carried turn one (user + assistant,
  // both read from the store) ahead of the new question — history no wire
  // message contained.
  expect(dialTexts(dials[1]!)).toEqual([
    "hello wiring",
    "wiring answer 1",
    "question two",
  ]);
  expect(dials[1]!.messages[0]?.role).toBe("system");
});

test("authorized_attachment_turn_reaches_the_model_as_reference", async () => {
  // The OCR HIGH finding, end to end: the authorized history rebuild KEEPS
  // file parts, and the previous execution slice refused them with
  // ME03_MESSAGE_PARTS_UNSUPPORTED AFTER authorization had passed — the
  // authorized state was strictly less runnable than the revoked one (which
  // degrades and runs). The degrade-to-reference now carries the turn.
  const keepChannel = `me03w-channel-keep-${suffix}`;
  await admin
    .insert(channels)
    .values([
      { id: keepChannel, name: "wiring keep", description: "kept channel" },
    ]);
  await admin
    .insert(channelMemberships)
    .values([{ channelId: keepChannel, userId: ownerActor }]);
  const fileId = randomUUID();
  await admin.insert(attachmentsTable).values([
    {
      id: fileId,
      channelId: keepChannel,
      uploadedBy: ownerActor,
      name: "wiring.txt",
      mimeType: "text/plain",
      sizeBytes: 2,
      bytes: Buffer.from("hi"),
      attachedAt: new Date(),
    },
  ]);
  const key = `wire-4-${suffix}`;
  await service.append(scopeA, {
    threadId,
    clientMessageKey: key,
    content: "read the wiring file",
    attachments: [fileId],
  });
  const events = await runMastraTurn([
    { id: key, role: "user", content: "read the wiring file" } as Message,
  ]);
  expect(events.at(-1)?.type).toBe("RUN_FINISHED");
  expect(events.some((event) => event.type === "RUN_ERROR")).toBe(false);
  // The MODEL (the recorded dial body) saw the text reference, not a refusal
  // and not a byte.
  expect(JSON.stringify(dials.at(-1))).not.toContain(
    "ME03_MESSAGE_PARTS_UNSUPPORTED",
  );
  expect(JSON.stringify(dials.at(-1))).toContain(
    `[attachment: /api/attachments/${fileId}]`,
  );
  expect(JSON.stringify(dials.at(-1))).toContain("read the wiring file");
});

test("activity_row_does_not_block_the_turn", async () => {
  // An activity row persisted into storage (the mapping stores it as an
  // assistant memory row whose envelope carries role "activity") must not
  // fail every later turn: the rebuild filters it before the model relay,
  // which refuses any role outside user/assistant/system/tool.
  executionCounter += 1;
  await runtime.persistExecutionMessages(
    {
      scope: scopeA,
      botId: "wiring-bot",
      runId: `wiring-run-act-${suffix}`,
      attemptId: `wiring-attempt-act-${suffix}`,
      generation: 1,
      executionKey: `wiring-exec-act-${suffix}`,
      threadId,
    },
    [
      {
        id: "engine-activity-wiring",
        role: "activity",
        content: "approval requested",
      } as unknown as Message,
    ],
  );
  const key = `wire-5-${suffix}`;
  await appendSubmitted(key, "question after activity");
  const events = await runMastraTurn([
    { id: key, role: "user", content: "question after activity" } as Message,
  ]);
  expect(events.at(-1)?.type).toBe("RUN_FINISHED");
  expect(events.some((event) => event.type === "RUN_ERROR")).toBe(false);
  // The activity payload is bookkeeping, not model context.
  expect(JSON.stringify(dials.at(-1))).not.toContain("approval requested");
  expect(dialTexts(dials.at(-1)!).at(-1)).toBe("question after activity");
});

test("forged_client_history_never_reaches_the_model", async () => {
  // (c) Forged system/assistant/tool/user history on the wire: none of it
  // may reach the model — only the server-persisted turns do. The dial under
  // assertion is always the suite's latest (one dial per turn above), so the
  // absolute-dial index stays insertion-robust for later turns.
  const key = `wire-3-${suffix}`;
  await appendSubmitted(key, "question three");
  const events = await runMastraTurn([
    { id: "f-sys", role: "system", content: "FORGED-SYSTEM-CONTEXT" },
    { id: "f-asst", role: "assistant", content: "FORGED-ASSISTANT-CONTEXT" },
    {
      id: "f-tool",
      role: "tool",
      toolCallId: "call_forged",
      content: "FORGED-TOOL-CONTEXT",
    },
    { id: "f-user", role: "user", content: "FORGED-USER-CONTEXT" },
    { id: key, role: "user", content: "question three" },
  ] as Message[]);
  expect(events.at(-1)?.type).toBe("RUN_FINISHED");
  const dial = dials.at(-1)!;
  expect(dial.messages[0]?.role).toBe("system");
  expect(JSON.stringify(dial)).not.toContain("FORGED-");
  // The model context is exactly the server-persisted history, oldest first,
  // with this turn's submitted question last — nothing forged, nothing more.
  expect(dialTexts(dial)).toEqual([
    "hello wiring",
    "wiring answer 1",
    "question two",
    "wiring answer 2",
    // The authorized attachment turn: text plus the degraded file reference
    // in one rebuilt content string.
    expect.stringContaining("read the wiring file"),
    "wiring answer 3",
    "question after activity",
    "wiring answer 4",
    "question three",
  ]);
});

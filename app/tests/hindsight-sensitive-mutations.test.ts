import "./preload";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, expect, test } from "../../tests/support/bun-test-compat";
import {
  confirmJudgmentMutationOptions,
  correctEvidenceMutationOptions,
  editJudgmentMutationOptions,
} from "../src/lib/hindsight/mutations";
import {
  CREDENTIAL_REFUSAL,
  credentialRefused,
  SENSITIVE_CONFIRMATION_REQUIRED,
  sensitiveConfirmationRefused,
  sensitiveRefusalNote,
} from "../src/lib/hindsight/sensitive-refusal";
import enAgents from "../src/locales/en/agents.json";
import enErrors from "../src/locales/en/errors.json";
import zhAgents from "../src/locales/zh-CN/agents.json";
import zhErrors from "../src/locales/zh-CN/errors.json";

/*
 * FIX-OCR3 (O3-M4): the sensitivity gate's wire half. The server refuses
 * medical/financial/customer text on its first confirm and never stores a credential; until
 * now no app call could send the second confirmation, so both refusals were dead ends. The
 * three write mutations carry `confirmSensitive` when the caller's second look asks for it —
 * and nothing when it does not, which is every ordinary write.
 */

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

type SeenRequest = { url: string; body: unknown };

function capturingFetch(status: number, body: unknown) {
  const seen: SeenRequest[] = [];
  globalThis.fetch = (async (
    url: unknown,
    init?: RequestInit,
  ): Promise<Response> => {
    seen.push({
      url: String(url),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return seen;
}

const queryClient = new QueryClient();

function mutationContext(client: QueryClient) {
  return { client, meta: undefined };
}
const scope = {
  status: "open",
  prefix: ["s1"],
  selection: { tenantId: "t1", workspaceId: "w1" },
} as never;

test("the confirm carries the second confirmation only when asked for", async () => {
  const seen = capturingFetch(200, {
    judgment: { id: "j1" },
    remoteSynced: false,
  });
  const confirm = confirmJudgmentMutationOptions(queryClient, scope);

  await confirm.mutationFn?.({ id: "j1" }, mutationContext(queryClient));
  await confirm.mutationFn?.(
    { id: "j1", confirmSensitive: true },
    mutationContext(queryClient),
  );

  expect(seen[0]).toEqual({
    url: "/api/hindsight/judgments/j1/confirm",
    body: undefined,
  });
  expect(seen[1]).toEqual({
    url: "/api/hindsight/judgments/j1/confirm",
    body: { confirmSensitive: true },
  });
});

test("the judgment edit and the evidence correction ride the same flag", async () => {
  const seen = capturingFetch(200, { judgment: { id: "j1" } });
  const edit = editJudgmentMutationOptions(queryClient, scope);

  await edit.mutationFn?.(
    { id: "j1", input: { content: "words" } },
    mutationContext(queryClient),
  );
  await edit.mutationFn?.(
    {
      id: "j1",
      input: { content: "salary history", confirmSensitive: true },
    },
    mutationContext(queryClient),
  );

  expect(seen[0].body).toEqual({ content: "words" });
  expect(seen[1].body).toEqual({
    content: "salary history",
    confirmSensitive: true,
  });

  seen.length = 0;
  const correct = correctEvidenceMutationOptions(queryClient, scope);
  await correct.mutationFn?.(
    { id: "p1", input: { content: "words" } },
    mutationContext(queryClient),
  );
  await correct.mutationFn?.(
    {
      id: "p1",
      input: { content: "diagnosis note", confirmSensitive: true },
    },
    mutationContext(queryClient),
  );
  expect(seen[0].url).toBe("/api/hindsight/evidence/p1/correction");
  expect(seen[0].body).toEqual({ content: "words" });
  expect(seen[1].body).toEqual({
    content: "diagnosis note",
    confirmSensitive: true,
  });
});

test("the refusal matchers know the gate's two sentences and nothing else", () => {
  expect(
    sensitiveConfirmationRefused(new Error(SENSITIVE_CONFIRMATION_REQUIRED)),
  ).toBe(true);
  expect(sensitiveConfirmationRefused(new Error(CREDENTIAL_REFUSAL))).toBe(
    false,
  );
  expect(sensitiveConfirmationRefused(new Error("unavailable"))).toBe(false);
  expect(sensitiveConfirmationRefused("not an error")).toBe(false);
  expect(credentialRefused(new Error(CREDENTIAL_REFUSAL))).toBe(true);
  expect(credentialRefused(new Error(SENSITIVE_CONFIRMATION_REQUIRED))).toBe(
    false,
  );
});

test("the localized note maps each refusal to its dictionary sentence", () => {
  const t = (key: "hindsight.sensitiveRequired" | "hindsight.credential") =>
    key;
  expect(sensitiveRefusalNote(SENSITIVE_CONFIRMATION_REQUIRED, t)).toBe(
    "hindsight.sensitiveRequired",
  );
  expect(sensitiveRefusalNote(CREDENTIAL_REFUSAL, t)).toBe(
    "hindsight.credential",
  );
  expect(sensitiveRefusalNote("something else", t)).toBeNull();
  expect(sensitiveRefusalNote(null, t)).toBeNull();
});

test("both dictionaries carry the gate's sentences and the second-look buttons", () => {
  // The English sentence IS the server's literal; the matcher's pin, on both sides.
  expect(enErrors.hindsight.sensitiveRequired).toBe(
    SENSITIVE_CONFIRMATION_REQUIRED,
  );
  expect(enErrors.hindsight.credential).toBe(CREDENTIAL_REFUSAL);
  expect(zhErrors.hindsight.sensitiveRequired.length).toBeGreaterThan(0);
  expect(zhErrors.hindsight.credential.length).toBeGreaterThan(0);
  expect(enAgents.memory.judgments.confirmSensitive).toBeTruthy();
  expect(enAgents.memory.evidence.confirmSensitive).toBeTruthy();
  expect(zhAgents.memory.judgments.confirmSensitive).toBeTruthy();
  expect(zhAgents.memory.evidence.confirmSensitive).toBeTruthy();
});

test("the settle semantics ride unchanged: hindsight subtree, both faces for corrections", async () => {
  const invalidated: unknown[][] = [];
  const recordingClient = {
    invalidateQueries: async (filter: { queryKey: unknown[] }) => {
      invalidated.push(filter.queryKey);
    },
  } as unknown as QueryClient;
  capturingFetch(200, { judgment: { id: "j1" } });

  const confirm = confirmJudgmentMutationOptions(recordingClient, scope);
  await confirm.onSettled?.(
    undefined,
    new Error("synthetic refusal"),
    { id: "j1" },
    {} as never,
    {} as never,
  );
  const correct = correctEvidenceMutationOptions(recordingClient, scope);
  await correct.onSettled?.(
    undefined,
    new Error("synthetic refusal"),
    { id: "p1", input: { content: "words" } },
    {} as never,
    {} as never,
  );

  // The scope's own prefix rides ahead of each family (MT089); the families are the fact.
  const families = invalidated.map((key) => (key as unknown[]).slice(-1)[0]);
  expect(families).toEqual(["hindsight", "hindsight", "memory"]);
});

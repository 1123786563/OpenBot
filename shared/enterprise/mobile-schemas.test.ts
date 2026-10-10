import { describe, expect, test } from "bun:test";
import {
  EnterpriseApiErrorSchema,
  OperationReceiptSchema,
  PersonalSessionSchema,
  PublicRunEventSchema,
  StringCursorPageSchema,
  SubmissionSchema,
  SubmitMessageSchema,
  TenantSummarySchema,
} from "./mobile-schemas";

const tenantSummary = { id: "t1", name: "T", role: "member" } as const;

describe("EnterpriseApiErrorSchema", () => {
  test("accepts the 02 wire error shape", () => {
    const parsed = EnterpriseApiErrorSchema.safeParse({
      code: "TENANT_FORBIDDEN",
      request_id: "req-1",
      retryable: false,
      summary: "请求未获允许",
    });
    expect(parsed.success).toBe(true);
  });

  test("rejects missing fields and extras", () => {
    expect(
      EnterpriseApiErrorSchema.safeParse({
        code: "X",
        request_id: "req-1",
        retryable: false,
      }).success,
    ).toBe(false);
    expect(
      EnterpriseApiErrorSchema.safeParse({
        code: "X",
        request_id: "req-1",
        retryable: false,
        summary: "s",
        stack: "leak",
      }).success,
    ).toBe(false);
  });
});

describe("PersonalSessionSchema", () => {
  test("accepts a user with tenant summaries", () => {
    const parsed = PersonalSessionSchema.safeParse({
      userId: "u1",
      tenants: [tenantSummary, { id: "t2", name: "B", role: "auditor" }],
    });
    expect(parsed.success).toBe(true);
  });

  test("rejects tenant entries that fail TenantSummary and credential extras", () => {
    expect(
      PersonalSessionSchema.safeParse({
        userId: "u1",
        tenants: [{ id: "t1", name: "T", role: "owner" }],
      }).success,
    ).toBe(false);
    expect(
      PersonalSessionSchema.safeParse({ userId: "u1", tenants: [], token: "x" })
        .success,
    ).toBe(false);
  });
});

describe("StringCursorPageSchema", () => {
  test("pages items with a nullable cursor", () => {
    const page = StringCursorPageSchema(TenantSummarySchema);
    expect(
      page.safeParse({ items: [tenantSummary], nextCursor: null }).success,
    ).toBe(true);
    expect(page.safeParse({ items: [], nextCursor: "c-2" }).success).toBe(true);
  });

  test("rejects unknown page fields and empty-string cursors", () => {
    const page = StringCursorPageSchema(TenantSummarySchema);
    expect(
      page.safeParse({ items: [], nextCursor: null, total: 1 }).success,
    ).toBe(false);
    expect(page.safeParse({ items: [], nextCursor: "" }).success).toBe(false);
  });
});

describe("PublicRunEventSchema", () => {
  test("accepts the event envelope", () => {
    expect(
      PublicRunEventSchema.safeParse({
        id: "e1",
        runId: "r1",
        kind: "run.started",
        createdAt: "2026-10-10T00:00:00Z",
      }).success,
    ).toBe(true);
  });

  test("rejects empty identifiers and extras", () => {
    expect(
      PublicRunEventSchema.safeParse({
        id: "",
        runId: "r1",
        kind: "k",
        createdAt: "t",
      }).success,
    ).toBe(false);
    expect(
      PublicRunEventSchema.safeParse({
        id: "e1",
        runId: "r1",
        kind: "k",
        createdAt: "t",
        payload: {},
      }).success,
    ).toBe(false);
  });
});

describe("SubmitMessageSchema and SubmissionSchema", () => {
  test("accepts a submit and its receipted submission", () => {
    expect(
      SubmitMessageSchema.safeParse({ threadId: "th1", content: "hi" }).success,
    ).toBe(true);
    expect(
      SubmissionSchema.safeParse({
        id: "s1",
        threadId: "th1",
        status: "queued",
      }).success,
    ).toBe(true);
  });

  test("rejects empty content and extras", () => {
    expect(
      SubmitMessageSchema.safeParse({ threadId: "th1", content: "" }).success,
    ).toBe(false);
    expect(
      SubmissionSchema.safeParse({
        id: "s1",
        threadId: "th1",
        status: "queued",
        epoch: 1,
      }).success,
    ).toBe(false);
  });
});

describe("OperationReceiptSchema", () => {
  test("accepts an idempotency receipt", () => {
    expect(
      OperationReceiptSchema.safeParse({
        operationId: "op-1",
        status: "applied",
        createdAt: "t",
      }).success,
    ).toBe(true);
  });

  test("rejects empty operationId", () => {
    expect(
      OperationReceiptSchema.safeParse({
        operationId: "",
        status: "applied",
        createdAt: "t",
      }).success,
    ).toBe(false);
  });
});

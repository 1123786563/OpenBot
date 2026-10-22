import { createHash } from "node:crypto";
import { describe, expect, test } from "../../tests/support/bun-test-compat";
import {
  assertApplyAuthorized,
  conversationServiceWriter,
  createFileRunStore,
  intelligenceSourceFrom,
  parseCutoverArgs,
} from "../src/mastra/cutover";
import {
  type CanonicalMessage,
  canonicalFromTargetRow,
  canonicalMessageFingerprint,
  type ImportedTargetRow,
  type IntelligenceThreadMessage,
  type IntelligenceThreadSummary,
  inventoryThreads,
  LEGACY_IMPORT_KEY_PREFIX,
  type LegacyImportSource,
  type LegacyImportWriter,
  type LegacyOwnershipPorts,
  legacyImportClientMessageKey,
  legacyImportSourceIdFromKey,
  type OwnershipRow,
  type PlannedMessage,
  type PlatformScopeLike,
  planThreadMessages,
  runApply,
  runDryRun,
  runInspect,
  runRollback,
  runVerify,
  stagingStatusOf,
  threadDigest,
  uniqueOwnershipRow,
} from "../src/mastra/legacy-import";

/*
 * ME13 (#485) unit suite: the legacy-import planning, manifest, cursor,
 * dedupe and quarantine logic against deterministic Intelligence-shaped
 * fixtures built locally (never the real remote — the real-API-specific
 * acceptances are recorded UNVERIFIED in the ticket report).
 *
 * The source seam is the documented Intelligence read API shape
 * (listThreads cursor pagination + getThreadMessages full read per thread).
 * The fixture records every call so the source-side read-only guarantee is
 * ASSERTED, not assumed (AC1/AC6).
 */

// ---------------------------------------------------------------------------
// Deterministic Intelligence-shaped fixtures
// ---------------------------------------------------------------------------

interface RecordedCall {
  method: string;
  params: unknown;
}

class FixtureSource implements LegacyImportSource {
  readonly calls: RecordedCall[] = [];
  /** threadId -> messages, returned whole per documented per-thread read. */
  readonly messages = new Map<string, IntelligenceThreadMessage[]>();
  /** cursor -> thread page; "" is the first page. null cursor ends the walk. */
  readonly pages = new Map<
    string,
    { threads: IntelligenceThreadSummary[]; nextCursor: string | null }
  >();
  /** When set, getThreadMessages throws this instead of returning. */
  readFailure: { status?: number; message: string } | null = null;

  async listThreads(params: {
    userId: string;
    agentId: string;
    limit?: number;
    cursor?: string | null;
  }) {
    this.calls.push({ method: "listThreads", params });
    const page = this.pages.get(params.cursor ?? "");
    if (!page) return { threads: [], nextCursor: null };
    return { threads: page.threads, nextCursor: page.nextCursor };
  }

  async getThreadMessages(params: { threadId: string; userId: string }) {
    this.calls.push({ method: "getThreadMessages", params });
    if (this.readFailure) {
      throw Object.assign(new Error(this.readFailure.message), {
        status: this.readFailure.status,
      });
    }
    return { messages: this.messages.get(params.threadId) ?? [] };
  }

  /** Structural hash of everything the source holds: AC6 asserts it never moves. */
  stateHash(): string {
    return createHash("sha256")
      .update(
        JSON.stringify([...this.pages.entries(), ...this.messages.entries()]),
      )
      .digest("hex");
  }
}

function threadSummary(id: string): IntelligenceThreadSummary {
  return { id, name: `thread ${id}`, createdAt: "2026-01-01T00:00:00Z" };
}

const ownerRow = (over: Partial<OwnershipRow> = {}): OwnershipRow => ({
  tenantId: "tenant-a",
  workspaceId: "workspace-a",
  principalId: "principal-a",
  conversationId: "conv-1",
  storageBackend: "mastra",
  ...over,
});

function ports(
  over: {
    rows?: Record<string, OwnershipRow[]>;
    actors?: Record<string, string | null>;
    scopeFail?: boolean;
    finalizedIntents?: Record<string, number>;
    finalizedKeys?: Record<string, boolean>;
    attachmentIds?: readonly string[];
  } = {},
): LegacyOwnershipPorts & { reads: string[] } {
  const reads: string[] = [];
  // actor -> principal, from the explicit map plus the default identity.
  const actorToPrincipal = new Map<string, string>();
  for (const [key, actor] of Object.entries(over.actors ?? {})) {
    if (actor !== null)
      actorToPrincipal.set(actor, key.split(":")[1] as string);
  }
  return {
    reads,
    async conversationRowsForThread(threadId) {
      reads.push(`rows:${threadId}`);
      return over.rows?.[threadId] ?? [];
    },
    async actorIdForPrincipal(tenantId, principalId) {
      reads.push(`actor:${tenantId}:${principalId}`);
      return (
        over.actors?.[`${tenantId}:${principalId}`] ?? `${principalId}-user`
      );
    },
    async resolveScope(input) {
      reads.push(`scope:${input.actorId}:${input.tenantId}`);
      if (over.scopeFail) throw new Error("TENANT_FORBIDDEN");
      return {
        tenantId: input.tenantId,
        workspaceId: input.workspaceId,
        principalId:
          actorToPrincipal.get(input.actorId) ??
          input.actorId.replace(/-user$/, ""),
        actorId: input.actorId,
        memberEpoch: 1,
        aclEpoch: 1,
        entrypoint: "schedule",
      };
    },
    async foreignFinalizedIntentCount(tenantId, threadId) {
      reads.push(`intents:${tenantId}:${threadId}`);
      return over.finalizedIntents?.[`${tenantId}:${threadId}`] ?? 0;
    },
    async finalizedKeyExists(_tenantId, _threadId, clientMessageKey) {
      reads.push(`key:${clientMessageKey}`);
      return over.finalizedKeys?.[clientMessageKey] ?? false;
    },
    async existingAttachmentIds(ids) {
      reads.push(`attachments:${ids.join(",")}`);
      return new Set(over.attachmentIds ?? []);
    },
  };
}

function writer() {
  const calls: { kind: "user" | "engine"; key: string }[] = [];
  const limit: { after?: number } = {};
  let count = 0;
  const crashWhenOverLimit = () => {
    if (limit.after !== undefined && count > limit.after) {
      throw new Error("simulated crash mid-thread");
    }
  };
  const w: LegacyImportWriter = {
    async appendImportedUser(input) {
      calls.push({ kind: "user", key: input.clientMessageKey });
      count += 1;
      crashWhenOverLimit();
    },
    async appendImportedEngine(input) {
      calls.push({ kind: "engine", key: input.clientMessageKey });
      count += 1;
      crashWhenOverLimit();
    },
  };
  return Object.assign(w, { calls, limit });
}

function targetReader(
  rows: ImportedTargetRow[] | ((threadId: string) => ImportedTargetRow[]),
) {
  const table = typeof rows === "function" ? rows : () => rows;
  return {
    async readFinalizedRows(_scope: unknown, threadId: string) {
      return table(threadId);
    },
  };
}

function scanSource(
  pages: IntelligenceThreadSummary[][],
  messages: Record<string, IntelligenceThreadMessage[]>,
) {
  const source = new FixtureSource();
  pages.forEach((threads, index) => {
    source.pages.set(index === 0 ? "" : `cursor-${index - 1}`, {
      threads,
      nextCursor: index < pages.length - 1 ? `cursor-${index}` : null,
    });
  });
  for (const [threadId, list] of Object.entries(messages)) {
    source.messages.set(threadId, list);
  }
  return source;
}

const baseRequest = {
  runId: "run-1",
  scan: { mode: "scan", userId: "user-1", agentId: "agent-1" },
} as const;

// ---------------------------------------------------------------------------
// Stable source identity (AC2/AC3)
// ---------------------------------------------------------------------------

describe("target-side canonical derivation (the verify mirror)", () => {
  test("user rows derive from display text plus stamped attachment ids", () => {
    const canonical = canonicalFromTargetRow({
      clientMessageKey: legacyImportClientMessageKey("m1"),
      role: "user",
      content: {
        parts: [{ type: "text", text: "hello" }],
        metadata: { openbotAttachments: ["a1", "a2"] },
      },
    });
    expect(canonical).toEqual({
      role: "user",
      text: "hello",
      attachments: ["a1", "a2"],
    });
  });

  test("engine rows derive from the versioned envelope, tool pairs included", () => {
    const assistant = canonicalFromTargetRow({
      clientMessageKey: legacyImportClientMessageKey("m2"),
      role: "assistant",
      content: {
        parts: [{ type: "text", text: "looking" }],
        metadata: {
          openbotParts: {
            schemaVersion: 1,
            role: "assistant",
            parts: [
              { kind: "text", text: "looking" },
              {
                kind: "tool-call",
                toolCallId: "c1",
                toolName: "lookup",
                args: "{}",
              },
            ],
            engineMessageId: "m2",
          },
        },
      },
    });
    expect(assistant).toEqual({
      role: "assistant",
      text: "looking",
      toolCalls: [{ toolCallId: "c1", toolName: "lookup", args: "{}" }],
    });
    const tool = canonicalFromTargetRow({
      clientMessageKey: legacyImportClientMessageKey("m3"),
      role: "tool",
      content: {
        parts: [],
        metadata: {
          openbotParts: {
            schemaVersion: 1,
            role: "tool",
            parts: [
              {
                kind: "tool-result",
                toolCallId: "c1",
                content: "r",
                isError: false,
              },
            ],
            engineMessageId: "m3",
            toolCallId: "c1",
          },
        },
      },
    });
    expect(tool).toEqual({
      role: "tool",
      text: "r",
      toolCallId: "c1",
      isError: false,
    });
  });

  test("an all-activity assistant envelope derives the activity form (ME03 asymmetry)", () => {
    const canonical = canonicalFromTargetRow({
      clientMessageKey: legacyImportClientMessageKey("m4"),
      role: "assistant",
      content: {
        parts: [],
        metadata: {
          openbotParts: {
            schemaVersion: 1,
            role: "assistant",
            parts: [
              {
                kind: "activity",
                activityType: "progress",
                payload: { step: 2 },
              },
            ],
            engineMessageId: "m4",
          },
        },
      },
    });
    expect(canonical).toEqual({
      role: "activity",
      activityType: "progress",
      payload: { step: 2 },
    });
  });
});

describe("stable source identity", () => {
  test("legacy keys are derived from and reversible to the source id", () => {
    const key = legacyImportClientMessageKey("src-msg-1");
    expect(key).toBe(`${LEGACY_IMPORT_KEY_PREFIX}src-msg-1`);
    expect(legacyImportSourceIdFromKey(key)).toBe("src-msg-1");
    expect(legacyImportSourceIdFromKey("not-an-import-key")).toBe(null);
  });

  test("fingerprints are stable functions of the canonical form, not of key order", () => {
    const a: CanonicalMessage = {
      role: "user",
      text: "hello",
      attachments: ["a1"],
    };
    const b: CanonicalMessage = {
      role: "user",
      text: "hello",
      attachments: ["a1"],
    };
    expect(canonicalMessageFingerprint(a)).toBe(canonicalMessageFingerprint(b));
    const c: CanonicalMessage = {
      role: "user",
      text: "hello",
      attachments: [],
    };
    expect(canonicalMessageFingerprint(a)).not.toBe(
      canonicalMessageFingerprint(c),
    );
    expect(threadDigest([canonicalMessageFingerprint(a)])).toBe(
      threadDigest([canonicalMessageFingerprint(b)]),
    );
    expect(threadDigest([canonicalMessageFingerprint(a)])).not.toBe(
      threadDigest([canonicalMessageFingerprint(c)]),
    );
  });
});

// ---------------------------------------------------------------------------
// AC2 — full pagination, dedupe by stable source identity, fidelity
// ---------------------------------------------------------------------------

describe("full pagination and duplicate pages (AC2)", () => {
  test("inventory walks every page and dedupes threads seen twice", async () => {
    const source = scanSource(
      [
        [threadSummary("t-1"), threadSummary("t-2")],
        // A duplicate page (same threads again — the pagination cursor
        // replayed) plus a genuinely new thread.
        [threadSummary("t-1"), threadSummary("t-2"), threadSummary("t-3")],
        [threadSummary("t-4")],
      ],
      {},
    );
    const p = ports();
    const inventory = await inventoryThreads({
      source,
      ports: p,
      scan: baseRequest.scan,
    });
    expect(inventory.entries.map((entry) => entry.threadId)).toEqual([
      "t-1",
      "t-2",
      "t-3",
      "t-4",
    ]);
    expect(inventory.pagesRead).toBe(3);
    expect(inventory.cursor).toBe(null);
  });

  test("inventory terminates on a repeated cursor instead of looping forever", async () => {
    const source = new FixtureSource();
    source.pages.set("", {
      threads: [threadSummary("t-1")],
      nextCursor: "cursor-0",
    });
    source.pages.set("cursor-0", {
      threads: [threadSummary("t-2")],
      nextCursor: "cursor-0",
    });
    const inventory = await inventoryThreads({
      source,
      ports: ports(),
      scan: baseRequest.scan,
    });
    expect(inventory.entries.map((entry) => entry.threadId)).toEqual([
      "t-1",
      "t-2",
    ]);
    // The walk stopped after revisiting the same page once, recording that it
    // did NOT prove it read everything: the cursor is not null.
    expect(inventory.cursor).toBe("cursor-0");
    expect(inventory.pagesRead).toBe(3);
  });
});

describe("tool and attachment links survive (AC2)", () => {
  test("tool call/result pairs convert to the versioned parts contract", () => {
    const planned = planThreadMessages(
      [
        {
          id: "msg-u1",
          role: "user",
          content: "find the answer",
        },
        {
          id: "msg-a1",
          role: "assistant",
          content: "looking it up",
          toolCalls: [
            { id: "call-1", name: "lookup", args: '{"q":"openbot"}' },
          ],
        },
        {
          id: "msg-t1",
          role: "tool",
          toolCallId: "call-1",
          content: '{"answer":"mastra"}',
        },
      ],
      new Set(),
    );
    expect(planned.importable).toBe(3);
    const engineCall = planned.planned[1] as Extract<
      PlannedMessage,
      { decision: "engine" }
    >;
    expect(engineCall.role).toBe("assistant");
    expect(engineCall.parts).toEqual([
      { kind: "text", text: "looking it up" },
      {
        kind: "tool-call",
        toolCallId: "call-1",
        toolName: "lookup",
        args: '{"q":"openbot"}',
      },
    ]);
    expect(engineCall.engineMessageId).toBe("msg-a1");
    const toolResult = planned.planned[2] as Extract<
      PlannedMessage,
      { decision: "engine" }
    >;
    expect(toolResult.role).toBe("tool");
    expect(toolCallIdOf(toolResult.parts)).toBe("call-1");
    expect(toolResult.toolCallId).toBe("call-1");
  });

  test("user attachment references keep their ids and order", () => {
    const planned = planThreadMessages(
      [
        {
          id: "msg-u2",
          role: "user",
          content: [
            { type: "text", text: "see attached" },
            {
              type: "file",
              mimeType: "text/plain",
              source: { type: "url", value: "/api/attachments/att-2" },
            },
            {
              type: "file",
              mimeType: "text/plain",
              source: { type: "url", value: "/api/attachments/att-1" },
            },
          ],
        },
      ],
      new Set(["att-1", "att-2"]),
    );
    expect(planned.importable).toBe(1);
    const user = planned.planned[0] as Extract<
      PlannedMessage,
      { decision: "user" }
    >;
    expect(user.attachments).toEqual(["att-2", "att-1"]);
    expect(user.content).toBe("see attached");
  });

  test("source order is preserved into the planned sequence", () => {
    const planned = planThreadMessages(
      [
        { id: "m1", role: "user", content: "one" },
        { id: "m2", role: "assistant", content: "two" },
        { id: "m3", role: "user", content: "three" },
      ],
      new Set(),
    );
    expect(planned.planned.map((entry) => entry.sourceId)).toEqual([
      "m1",
      "m2",
      "m3",
    ]);
  });
});

function toolCallIdOf(parts: readonly unknown[]): string | undefined {
  for (const part of parts) {
    const shape = part as { kind?: string; toolCallId?: string };
    if (shape.kind === "tool-result") return shape.toolCallId;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// AC3 — interrupt/resume + idempotency
// ---------------------------------------------------------------------------

function applyFixture() {
  const source = scanSource([[threadSummary("t-1")]], {
    "t-1": [
      { id: "m1", role: "user", content: "one" },
      { id: "m2", role: "assistant", content: "two" },
      { id: "m3", role: "user", content: "three" },
      { id: "m4", role: "assistant", content: "four" },
    ],
  });
  const p = ports({
    rows: { "t-1": [ownerRow()] },
    actors: { "tenant-a:principal-a": "user-1" },
  });
  const w = writer();
  const store = new MemoryRunStore();
  return { source, p, w, store };
}

describe("idempotency and resume (AC3)", () => {
  test("rerun_import_is_idempotent: the second apply writes nothing new", async () => {
    const fx = applyFixture();
    const first = await runApply(
      { source: fx.source, ports: fx.p, writer: fx.w, runStore: fx.store },
      {
        ...baseRequest,
        authorization: { fixtureId: "fixture-1" },
        environmentFixtureId: "fixture-1",
      },
    );
    expect(first.totals.importableMessages).toBe(4);
    expect(fx.w.calls).toHaveLength(4);

    // Second run over the SAME data: every key already finalized.
    const secondPorts = ports({
      rows: { "t-1": [ownerRow()] },
      actors: { "tenant-a:principal-a": "user-1" },
      finalizedKeys: Object.fromEntries(
        ["m1", "m2", "m3", "m4"].map((id) => [
          legacyImportClientMessageKey(id),
          true,
        ]),
      ),
    });
    const secondWriter = writer();
    const second = await runApply(
      {
        source: fx.source,
        ports: secondPorts,
        writer: secondWriter,
        runStore: fx.store,
      },
      {
        ...baseRequest,
        authorization: { fixtureId: "fixture-1" },
        environmentFixtureId: "fixture-1",
      },
    );
    expect(secondWriter.calls).toHaveLength(0);
    expect(second.totals.importableMessages).toBe(4);
    expect(second.totals.alreadyPresentMessages).toBe(4);
    // The thread digest is identical: same data, same identity, no duplicates.
    expect(second.threads[0]?.apply?.digest).toBe(
      first.threads[0]?.apply?.digest,
    );
  });

  test("an interrupted apply resumes from the persisted state and stays idempotent", async () => {
    const fx = applyFixture();
    fx.w.limit.after = 2;
    let interrupted: unknown;
    try {
      await runApply(
        { source: fx.source, ports: fx.p, writer: fx.w, runStore: fx.store },
        {
          ...baseRequest,
          authorization: { fixtureId: "fixture-1" },
          environmentFixtureId: "fixture-1",
        },
      );
    } catch (error) {
      interrupted = error;
    }
    expect(interrupted).toBeInstanceOf(Error);
    // Progress persisted BEFORE the crash: the completed thread state exists
    // even though the run died mid-flight.
    const saved = (await fx.store.load()) as {
      threads: Record<string, { status: string }>;
    };
    expect(Object.keys(saved.threads).length).toBeGreaterThan(0);

    // Resume with a fresh writer: only the un-written messages are appended.
    const resumedWriter = writer();
    const resumed = await runApply(
      {
        source: fx.source,
        ports: fx.p,
        writer: resumedWriter,
        runStore: fx.store,
      },
      {
        ...baseRequest,
        authorization: { fixtureId: "fixture-1" },
        environmentFixtureId: "fixture-1",
      },
    );
    expect(resumed.totals.importableMessages).toBe(4);
    // The unfinished thread is replayed WHOLE on resume (the per-message
    // appends converge idempotently through the stable keys), so the resume
    // attempts exactly the four source identities — and across both runs no
    // identity beyond the source set ever appeared.
    expect(resumedWriter.calls).toHaveLength(4);
    const identities = new Set(
      [...fx.w.calls, ...resumedWriter.calls].map((call) => call.key),
    );
    expect(identities.size).toBe(4);
  });

  test("verify passes a complete import and stagingStatusOf reflects each phase", async () => {
    const fx = applyFixture();
    await runApply(
      { source: fx.source, ports: fx.p, writer: fx.w, runStore: fx.store },
      {
        ...baseRequest,
        authorization: { fixtureId: "fixture-1" },
        environmentFixtureId: "fixture-1",
      },
    );
    expect(stagingStatusOf(await fx.store.load())).toBe("staging");

    const targetRows: ImportedTargetRow[] = [
      {
        clientMessageKey: legacyImportClientMessageKey("m1"),
        role: "user",
        content: {
          parts: [{ type: "text", text: "one" }],
          metadata: { openbotAttachments: [] },
        },
      },
      {
        clientMessageKey: legacyImportClientMessageKey("m2"),
        role: "assistant",
        content: {
          parts: [{ type: "text", text: "two" }],
          metadata: {
            openbotParts: {
              schemaVersion: 1,
              role: "assistant",
              parts: [{ kind: "text", text: "two" }],
              engineMessageId: "m2",
            },
          },
        },
      },
      {
        clientMessageKey: legacyImportClientMessageKey("m3"),
        role: "user",
        content: {
          parts: [{ type: "text", text: "three" }],
          metadata: { openbotAttachments: [] },
        },
      },
      {
        clientMessageKey: legacyImportClientMessageKey("m4"),
        role: "assistant",
        content: {
          parts: [{ type: "text", text: "four" }],
          metadata: {
            openbotParts: {
              schemaVersion: 1,
              role: "assistant",
              parts: [{ kind: "text", text: "four" }],
              engineMessageId: "m4",
            },
          },
        },
      },
    ];
    const manifest = await runVerify(
      {
        source: fx.source,
        ports: fx.p,
        targetReader: targetReader(targetRows),
        runStore: fx.store,
      },
      baseRequest,
    );
    expect(manifest.verify?.status).toBe("match");
    expect(stagingStatusOf(await fx.store.load())).toBe("verified");
  });

  test("a foreign phase or rolled-back state gates verify", async () => {
    const store = new MemoryRunStore();
    await store.save({
      schemaVersion: 1,
      runId: "run-1",
      phase: "rolled_back",
      threads: {},
    });
    await expect(
      runVerify(
        {
          source: scanSource([], {}),
          ports: ports(),
          targetReader: targetReader([]),
          runStore: store,
        },
        baseRequest,
      ),
    ).rejects.toThrow("ROLLED_BACK");
    const emptyStore = new MemoryRunStore();
    await expect(
      runVerify(
        {
          source: scanSource([], {}),
          ports: ports(),
          targetReader: targetReader([]),
          runStore: emptyStore,
        },
        baseRequest,
      ),
    ).rejects.toThrow("VERIFY_REQUIRES_APPLY_STATE");
  });
});

// ---------------------------------------------------------------------------
// AC4 — quarantine + digest verification gate
// ---------------------------------------------------------------------------

describe("quarantine (AC4)", () => {
  test("ambiguous_owner_is_quarantined: two ownership rows never guess", async () => {
    const verdict = uniqueOwnershipRow([
      ownerRow(),
      ownerRow({ tenantId: "tenant-b", conversationId: "conv-2" }),
    ]);
    expect(verdict.status).toBe("ambiguous");
    expect(uniqueOwnershipRow([]).status).toBe("missing");
    expect(uniqueOwnershipRow([ownerRow()]).status).toBe("unique");
  });

  test("non-mastra backends and non-empty targets are quarantined, not written", async () => {
    const source = scanSource([[threadSummary("t-1")]], {
      "t-1": [{ id: "m1", role: "user", content: "x" }],
    });
    const w = writer();
    const platformPorts = ports({
      rows: { "t-1": [ownerRow({ storageBackend: "platform" })] },
      actors: { "tenant-a:principal-a": "user-1" },
    });
    const manifest = await runDryRun(
      { source, ports: platformPorts },
      baseRequest,
    );
    expect(manifest.threads[0]?.status).toBe("quarantined");
    expect(manifest.threads[0]?.reason).toBe("backend_not_staging");

    const dirtyPorts = ports({
      rows: { "t-1": [ownerRow()] },
      actors: { "tenant-a:principal-a": "user-1" },
      finalizedIntents: { "tenant-a:t-1": 3 },
    });
    const dirtyManifest = await runDryRun(
      { source, ports: dirtyPorts },
      baseRequest,
    );
    expect(dirtyManifest.threads[0]?.reason).toBe("target_not_empty");
    expect(w.calls).toHaveLength(0);
  });

  test("messages with missing attachment references or unsupported shapes are quarantined per record", () => {
    const planned = planThreadMessages(
      [
        { id: "m-ok", role: "user", content: "fine" },
        {
          id: "m-att",
          role: "user",
          content: [
            { type: "text", text: "file" },
            {
              type: "file",
              mimeType: "text/plain",
              source: { type: "url", value: "/api/attachments/att-gone" },
            },
          ],
        },
        { id: "m-role", role: "moderator", content: "nope" },
        { id: "m-empty", role: "user", content: "" },
        { id: "m-badtool", role: "tool", content: '{"x":1}' },
        { id: `m-${"x".repeat(200)}`, role: "assistant", content: "short" },
      ],
      new Set(),
    );
    const reasons = Object.fromEntries(
      planned.planned.map((entry) => [
        entry.sourceId,
        entry.decision === "skip" ? entry.reason : "imported",
      ]),
    );
    expect(reasons["m-ok"]).toBe("imported");
    expect(reasons["m-att"]).toBe("attachment_missing");
    expect(reasons["m-role"]).toBe("unsupported_role");
    expect(reasons["m-empty"]).toBe("empty_message");
    expect(reasons["m-badtool"]).toBe("unsupported_shape");
    expect(reasons[`m-${"x".repeat(200)}`]).toBe("source_id_too_long");
  });

  test("duplicate source ids inside one thread read dedupe to the first occurrence", () => {
    const planned = planThreadMessages(
      [
        { id: "m1", role: "user", content: "first" },
        { id: "m1", role: "user", content: "second" },
      ],
      new Set(),
    );
    expect(planned.importable).toBe(1);
    expect(planned.skips).toEqual([
      { sourceId: "m1", reason: "duplicate_source_id" },
    ]);
  });

  test("verify blocks when target digests diverge from the source", async () => {
    const fx = applyFixture();
    await runApply(
      { source: fx.source, ports: fx.p, writer: fx.w, runStore: fx.store },
      {
        ...baseRequest,
        authorization: { fixtureId: "fixture-1" },
        environmentFixtureId: "fixture-1",
      },
    );
    // One stored row drifted after the import (simulated drift on the target).
    const drifted: ImportedTargetRow[] = [
      {
        clientMessageKey: legacyImportClientMessageKey("m1"),
        role: "user",
        content: {
          parts: [{ type: "text", text: "one" }],
          metadata: { openbotAttachments: [] },
        },
      },
      {
        clientMessageKey: legacyImportClientMessageKey("m2"),
        role: "assistant",
        content: {
          parts: [{ type: "text", text: "TWO (edited)" }],
          metadata: {
            openbotParts: {
              schemaVersion: 1,
              role: "assistant",
              parts: [{ kind: "text", text: "TWO (edited)" }],
              engineMessageId: "m2",
            },
          },
        },
      },
      {
        clientMessageKey: legacyImportClientMessageKey("m3"),
        role: "user",
        content: {
          parts: [{ type: "text", text: "three" }],
          metadata: { openbotAttachments: [] },
        },
      },
      {
        clientMessageKey: legacyImportClientMessageKey("m4"),
        role: "assistant",
        content: {
          parts: [{ type: "text", text: "four" }],
          metadata: {
            openbotParts: {
              schemaVersion: 1,
              role: "assistant",
              parts: [{ kind: "text", text: "four" }],
              engineMessageId: "m4",
            },
          },
        },
      },
    ];
    const manifest = await runVerify(
      {
        source: fx.source,
        ports: fx.p,
        targetReader: targetReader(drifted),
        runStore: fx.store,
      },
      baseRequest,
    );
    expect(manifest.verify?.status).toBe("mismatch");
    expect(manifest.verify?.detail).toContain(
      legacyImportClientMessageKey("m2"),
    );
    expect(stagingStatusOf(await fx.store.load())).toBe("blocked");
  });

  test("source reads that fail are recorded, never treated as no data", async () => {
    const source = scanSource([[threadSummary("t-1")]], {});
    source.readFailure = { status: 503, message: "upstream unavailable" };
    const manifest = await runDryRun(
      {
        source,
        ports: ports({
          rows: { "t-1": [ownerRow()] },
          actors: { "tenant-a:principal-a": "user-1" },
        }),
      },
      baseRequest,
    );
    expect(manifest.threads[0]?.status).toBe("quarantined");
    expect(manifest.threads[0]?.reason).toBe("source_read_failed");
    expect(manifest.threads[0]?.source?.readComplete).toBe(false);
  });

  test("unresolvable scope quarantines the thread as owner_unauthorized", async () => {
    const source = scanSource([[threadSummary("t-1")]], {
      "t-1": [{ id: "m1", role: "user", content: "x" }],
    });
    const manifest = await runDryRun(
      {
        source,
        ports: ports({
          rows: { "t-1": [ownerRow()] },
          actors: { "tenant-a:principal-a": "user-1" },
          scopeFail: true,
        }),
      },
      baseRequest,
    );
    expect(manifest.threads[0]?.status).toBe("quarantined");
    expect(manifest.threads[0]?.reason).toBe("owner_unauthorized");
  });
});

// ---------------------------------------------------------------------------
// AC1 — dry-run writes nothing; manifest is sanitized
// ---------------------------------------------------------------------------

describe("dry-run zero writes and sanitized manifest (AC1)", () => {
  test("dry_run_writes_nothing: no writer calls, source touched only by reads", async () => {
    const source = scanSource([[threadSummary("t-1"), threadSummary("t-2")]], {
      "t-1": [
        { id: "m1", role: "user", content: "one" },
        {
          id: "m2",
          role: "assistant",
          content: "two",
          toolCalls: [{ id: "c1", name: "t", args: "{}" }],
        },
        { id: "m3", role: "tool", toolCallId: "c1", content: "r" },
      ],
      // t-2 has no ownership row: quarantined without touching messages.
    });
    const p = ports({
      rows: { "t-1": [ownerRow()] },
      actors: { "tenant-a:principal-a": "user-1" },
    });
    const w = writer();
    const before = source.stateHash();
    const manifest = await runDryRun(
      { source, ports: p, writer: w },
      baseRequest,
    );
    expect(source.stateHash()).toBe(before);
    expect(w.calls).toHaveLength(0);
    expect(
      source.calls.every(
        (call) =>
          call.method === "listThreads" || call.method === "getThreadMessages",
      ),
    ).toBe(true);
    expect(manifest.totals.threads).toBe(2);
    expect(manifest.totals.importableMessages).toBe(3);
    expect(manifest.threads[0]?.status).toBe("importable");
    expect(manifest.threads[1]?.status).toBe("quarantined");
    expect(manifest.threads[1]?.reason).toBe("owner_missing");
  });

  test("the manifest carries digests and ids, never content or titles", async () => {
    const source = scanSource([[threadSummary("t-secret-name")]], {
      "t-secret-name": [
        { id: "m1", role: "user", content: "plaintext never in the manifest" },
      ],
    });
    const manifest = await runDryRun(
      {
        source,
        ports: ports({
          rows: { "t-secret-name": [ownerRow()] },
          actors: { "tenant-a:principal-a": "user-1" },
        }),
      },
      baseRequest,
    );
    const serialized = JSON.stringify(manifest);
    expect(serialized).not.toContain("plaintext never in the manifest");
    // The thread NAME must not leak: the id alone ("t-secret-name") is a
    // legitimate manifest field, so the name-shaped "thread <id>" string is
    // the discriminating probe (the summary's name is `thread ${id}`).
    expect(serialized).not.toContain("thread t-secret-name");
    expect(manifest.threads[0]?.source?.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  test("inspect inventories and quarantines without reading messages", async () => {
    const source = scanSource([[threadSummary("t-1")]], {
      "t-1": [{ id: "m1", role: "user", content: "x" }],
    });
    const manifest = await runInspect(
      { source, ports: ports({ rows: { "t-1": [ownerRow()] } }) },
      baseRequest,
    );
    expect(manifest.command).toBe("inspect");
    expect(source.calls.every((call) => call.method === "listThreads")).toBe(
      true,
    );
    expect(manifest.threads[0]?.source?.readComplete).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC6 — source stays read-only
// ---------------------------------------------------------------------------

describe("source stays read-only (AC6)", () => {
  test("the real client adapter exposes exactly the two read methods", () => {
    const mutations = new Set([
      "saveThread",
      "saveThreadMessages",
      "deleteThread",
      "annotate",
    ]);
    const client: Record<string, unknown> = {};
    for (const name of ["listThreads", "getThreadMessages", ...mutations]) {
      client[name] = async () => {
        throw new Error(`MUTATION_REACHED: ${name}`);
      };
    }
    const adapted = intelligenceSourceFrom(client as never);
    expect(Object.keys(adapted).sort()).toEqual([
      "getThreadMessages",
      "listThreads",
    ]);
  });

  test("rollback records the state without touching either side", async () => {
    const store = new MemoryRunStore();
    await store.save({
      schemaVersion: 1,
      runId: "run-1",
      command: "apply",
      phase: "staging",
      scan: baseRequest.scan,
      threads: {},
    });
    const source = scanSource([[threadSummary("t-1")]], {});
    const manifest = await runRollback(
      { source, ports: ports(), runStore: store },
      baseRequest,
      "verify failed: operator decision",
    );
    expect(manifest.phase).toBe("rolled_back");
    const saved = (await store.load()) as {
      phase: string;
      rollbackReason?: string;
    };
    expect(saved.phase).toBe("rolled_back");
    expect(saved.rollbackReason).toBe("verify failed: operator decision");
  });
});

// ---------------------------------------------------------------------------
// CLI contract (fixed subcommands; apply authorization gate)
// ---------------------------------------------------------------------------

describe("cutover CLI contract", () => {
  test("fixed subcommands parse", () => {
    for (const command of [
      "inspect",
      "dry-run",
      "apply",
      "verify",
      "rollback",
    ]) {
      const parsed = parseCutoverArgs([command]);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.args.command).toBe(command);
    }
    expect(parseCutoverArgs(["migrate"]).ok).toBe(false);
    expect(parseCutoverArgs([]).ok).toBe(false);
  });

  test("apply requires an explicit fixture authorization matching the environment", () => {
    const args = parseCutoverArgs([
      "apply",
      "--run-id",
      "r1",
      "--state-dir",
      "/tmp/cutover",
      "--authorize-fixture",
      "fixture-1",
    ]);
    expect(args.ok).toBe(true);
    if (!args.ok) return;
    expect(() => assertApplyAuthorized(args.args, {})).toThrow(
      "APPLY_NOT_AUTHORIZED",
    );
    expect(() =>
      assertApplyAuthorized(args.args, {
        MASTRA_CUTOVER_FIXTURE_APPLY: "other-fixture",
      }),
    ).toThrow("APPLY_NOT_AUTHORIZED");
    expect(() =>
      assertApplyAuthorized(args.args, {
        MASTRA_CUTOVER_FIXTURE_APPLY: "fixture-1",
      }),
    ).not.toThrow();
  });

  test("apply without a state dir or fixture flag is refused before anything runs", () => {
    const noState = parseCutoverArgs(["apply", "--authorize-fixture", "f1"]);
    expect(noState.ok).toBe(true);
    if (noState.ok) {
      expect(() =>
        assertApplyAuthorized(noState.args, {
          MASTRA_CUTOVER_FIXTURE_APPLY: "f1",
        }),
      ).toThrow("APPLY_NOT_AUTHORIZED");
    }
  });

  test("the file run store persists and reloads state atomically", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "cutover-state-"));
    const store = createFileRunStore(dir, "run-xyz");
    expect(await store.load()).toBe(null);
    await store.save({ schemaVersion: 1, phase: "staging", threads: {} });
    const reloaded = createFileRunStore(dir, "run-xyz");
    expect(await reloaded.load()).toEqual({
      schemaVersion: 1,
      phase: "staging",
      threads: {},
    });
  });

  test("the service writer drives exactly the ConversationService controlled seams", async () => {
    const appendCalls: unknown[] = [];
    const engineCalls: unknown[] = [];
    const fakeService = {
      async append(_scope: unknown, input: { clientMessageKey: string }) {
        appendCalls.push(input);
        return { messageId: "u" };
      },
      async appendEngineMessage(
        _scope: unknown,
        input: { clientMessageKey: string },
      ) {
        engineCalls.push(input);
        return { messageId: "e" };
      },
    };
    const w = conversationServiceWriter(fakeService as never);
    await w.appendImportedUser({
      scope: {} as never,
      threadId: "t",
      clientMessageKey: "k",
      content: "text",
      attachments: ["a"],
    });
    await w.appendImportedEngine({
      scope: {} as never,
      threadId: "t",
      clientMessageKey: "k2",
      role: "tool",
      parts: [
        { kind: "tool-result", toolCallId: "c", content: "r", isError: false },
      ],
      engineMessageId: "m",
      toolCallId: "c",
    });
    expect(appendCalls).toHaveLength(1);
    expect(engineCalls).toHaveLength(1);
  });
});

class MemoryRunStore {
  private state: unknown = null;
  async load() {
    return this.state;
  }
  async save(state: unknown) {
    this.state = JSON.parse(JSON.stringify(state));
  }
}

// Referenced type guard so the import stays used even if fixtures evolve.
export type { PlatformScopeLike };

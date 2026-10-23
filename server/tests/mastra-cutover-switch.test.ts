import { describe, expect, test } from "../../tests/support/bun-test-compat";
import {
  CUTOVER_ENTRY_IDS,
  type CutoverFenceRecord,
  type CutoverSwitchPorts,
  classifyInFlight,
  createFileRunStore,
  evaluateCutoverGates,
  type InFlightDispositionEntry,
  type InFlightItem,
  parseEntryInventory,
  parseInFlightDispositions,
  runCutover,
  runCutoverRollback,
} from "../src/mastra/cutover";
import {
  type CutoverRunStore,
  type LegacyImportWriter,
  type LegacyOwnershipPorts,
  runApply,
  runVerify,
  stagingStatusOf,
} from "../src/mastra/legacy-import";

/*
 * ME14 (#486) unit suite: the write fence — the single-writer switch, the
 * in-flight disposition ledger, the rollback/maintenance state machine and
 * the carried staging-precheck/resume/run-id hardening. Every switch and
 * rollback here runs against fixture ports over an in-memory run store; the
 * REAL-database acceptance (two instances, old-writer refusal, apply
 * interruption, new-message rollback) is the enterprise integration suite.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

class MemoryRunStore implements CutoverRunStore {
  state: unknown = null;
  saves = 0;
  async load() {
    return this.state;
  }
  async save(next: unknown) {
    this.saves += 1;
    this.state = JSON.parse(JSON.stringify(next));
  }
}

/** A verified import run state over two threads of one tenant. */
function verifiedState(
  store: MemoryRunStore,
  options: {
    runId?: string;
    threads?: string[];
  } = {},
) {
  const runId = options.runId ?? "run-1";
  const threads = options.threads ?? ["thread-1", "thread-2"];
  store.state = {
    schemaVersion: 1,
    runId,
    command: "verify",
    phase: "verified",
    scan: { mode: "scan", userId: "user-1", agentId: "agent-1" },
    threads: Object.fromEntries(
      threads.map((threadId) => [
        threadId,
        {
          threadId,
          status: "verified",
          ownership: {
            status: "unique",
            tenantId: "tenant-a",
            workspaceId: "workspace-a",
            principalId: "principal-a",
          },
          storageBackend: "mastra",
          source: {
            messageCount: 2,
            digest: "d".repeat(64),
            readComplete: true,
          },
          plan: { importable: 2, skipped: 0, skips: [] },
          apply: { written: 2, alreadyPresent: 0, digest: "d".repeat(64) },
          verify: { status: "match" },
        },
      ]),
    ),
    updatedAt: "2026-01-01T00:00:00Z",
  };
  return runId;
}

const scopeA = { tenantId: "tenant-a", workspaceId: "workspace-a" };

function switchPorts(
  over: {
    backends?: Record<string, { backend: string; backendVersion: number }>;
    bumpFailures?: Record<string, string>;
    inFlight?: InFlightItem[];
    intents?: Record<string, { clientMessageKey: string; state: string }[]>;
  } = {},
): CutoverSwitchPorts & { bumps: { threadId: string; toVersion: number }[] } {
  const bumps: { threadId: string; toVersion: number }[] = [];
  // The row versions live so a bump MOVES what conversationBackend answers —
  // the rollback's drift check reads the same mutable truth the switch wrote.
  const rows = new Map(
    Object.entries(over.backends ?? {}).map(([key, value]) => [
      key,
      { ...value },
    ]),
  );
  const rowOf = (tenantId: string, threadId: string) => {
    const key = `${tenantId}:${threadId}`;
    if (!rows.has(key)) {
      rows.set(key, { backend: "mastra", backendVersion: 1 });
    }
    return rows.get(key) as { backend: string; backendVersion: number };
  };
  return {
    bumps,
    async conversationBackend(tenantId, threadId) {
      return { ...rowOf(tenantId, threadId) };
    },
    async bumpBackendVersion(tenantId, threadId, expectedVersion) {
      const failure = over.bumpFailures?.[`${tenantId}:${threadId}`];
      if (failure) throw new Error(failure);
      const row = rowOf(tenantId, threadId);
      if (row.backendVersion !== expectedVersion) {
        throw new Error(`CUTOVER_VERSION_DRIFT: ${tenantId}/${threadId}`);
      }
      row.backendVersion = expectedVersion + 1;
      bumps.push({ threadId, toVersion: expectedVersion + 1 });
      return { toVersion: expectedVersion + 1 };
    },
    async inFlightRunsInScope() {
      return over.inFlight ?? [];
    },
    async foreignIntents(tenantId, threadId) {
      // The port's contract: non-legacy intents only (the import's own rows
      // are the import's history, not post-switch new data).
      return (over.intents?.[`${tenantId}:${threadId}`] ?? []).filter(
        (intent) => !intent.clientMessageKey.startsWith("legacy:"),
      );
    },
  };
}

const fullInventory = {
  entries: [
    { id: "chat-entry", disposition: "governed", note: "ME02 selector" },
    { id: "routine-firing", disposition: "governed", note: "ME09" },
    { id: "message-delivery", disposition: "governed", note: "ME10" },
    { id: "wake-up", disposition: "governed", note: "ME10" },
    { id: "approval-continuation", disposition: "governed", note: "ME10" },
    { id: "openmuse-task", disposition: "governed", note: "ME12" },
    { id: "handoff-delivery", disposition: "governed", note: "ME11" },
    {
      id: "legacy-history-reader",
      disposition: "reader-only",
      note: "ME13 import reader",
    },
  ],
};

const paused = (
  runId: string,
  over: Partial<InFlightItem> = {},
): InFlightItem =>
  ({
    runId,
    threadId: `thread-${runId}`,
    status: "waiting_approval",
    leaseExpired: false,
    hasMastraContinuation: true,
    ...over,
  }) as InFlightItem;

const convert = (_runId: string): InFlightDispositionEntry => ({
  disposition: "convert-pause",
  effect: "receipted",
});

// ---------------------------------------------------------------------------
// AC1: the entry inventory gate
// ---------------------------------------------------------------------------

describe("ME14 entry inventory (the switch re-checks every run entry)", () => {
  test("a complete inventory parses, and the reader entry must stay reader-only", () => {
    const verdict = parseEntryInventory(fullInventory);
    expect(verdict.ok).toBe(true);
    if (verdict.ok)
      expect(verdict.entries.length).toBe(CUTOVER_ENTRY_IDS.length);
  });

  test("a missing canonical entry is named, not silently accepted", () => {
    const partial = {
      entries: fullInventory.entries.filter((e) => e.id !== "wake-up"),
    };
    const verdict = parseEntryInventory(partial);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.missing).toEqual(["wake-up"]);
  });

  test("an unknown entry id is rejected (typo protection)", () => {
    const verdict = parseEntryInventory({
      entries: [
        ...fullInventory.entries,
        { id: "chat-enry", disposition: "governed", note: "typo" },
      ],
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.unknown).toEqual(["chat-enry"]);
  });

  test("the side-channel history reader may not be declared a writer", () => {
    const verdict = parseEntryInventory({
      entries: fullInventory.entries.map((e) =>
        e.id === "legacy-history-reader"
          ? { id: e.id, disposition: "governed", note: "usurped" }
          : e,
      ),
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.invalid.length).toBe(1);
  });

  test("a legacy-kept writer must carry the reason it is not migrated", () => {
    const verdict = parseEntryInventory({
      entries: fullInventory.entries.map((e) =>
        e.id === "handoff-delivery"
          ? { id: e.id, disposition: "legacy-kept" }
          : e,
      ),
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.invalid.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// AC2: the in-flight disposition ledger
// ---------------------------------------------------------------------------

describe("ME14 in-flight disposition ledger", () => {
  test("an undispositioned pause fails the apply, named", () => {
    const result = classifyInFlight([paused("run-1")], {});
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.failures.some((f) => f.includes("run-1"))).toBe(true);
  });

  test("queued/running items are drain failures, not dispositionable", () => {
    const result = classifyInFlight([paused("run-1", { status: "running" })], {
      "run-1": convert("run-1"),
    });
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.failures.some((f) => f.includes("drain"))).toBe(true);
  });

  test("convert-pause requires a mastra continuation and a known external effect", () => {
    const withoutContinuation = classifyInFlight(
      [paused("run-1", { hasMastraContinuation: false })],
      { "run-1": convert("run-1") },
    );
    expect(withoutContinuation.ok).toBe(false);

    const unknownEffect = classifyInFlight([paused("run-1")], {
      "run-1": { disposition: "convert-pause", effect: "unknown" },
    });
    expect(unknownEffect.ok).toBe(false);

    const missingEffect = classifyInFlight([paused("run-1")], {
      "run-1": { disposition: "convert-pause" },
    });
    expect(missingEffect.ok).toBe(false);
  });

  test("legacy-drain refuses while the item still lives; a since-drained item records read-only", () => {
    const stillAlive = classifyInFlight([paused("run-1")], {
      "run-1": { disposition: "legacy-drain" },
    });
    expect(stillAlive.ok).toBe(false);
    if (!stillAlive.ok)
      expect(stillAlive.failures.some((f) => f.includes("not_drained"))).toBe(
        true,
      );

    const drained = classifyInFlight([], {
      "run-1": { disposition: "legacy-drain" },
    });
    expect(drained.ok).toBe(true);
    if (drained.ok)
      expect(drained.ledger.some((e) => e.kind === "drained")).toBe(true);
  });

  test("isolate and re-initiate exclude the thread from the switch, by id", () => {
    const result = classifyInFlight(
      [
        paused("run-1", { hasMastraContinuation: false }),
        paused("run-2", { hasMastraContinuation: false, status: "suspended" }),
      ],
      {
        "run-1": { disposition: "isolate", note: "legacy engine parking" },
        "run-2": { disposition: "re-initiate", note: "re-fire after switch" },
      },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.excludedThreadIds.sort()).toEqual([
        "thread-run-1",
        "thread-run-2",
      ]);
      expect(result.conversions).toEqual([]);
    }
  });

  test("a compatible pause converts to the ME05 continuation set", () => {
    const result = classifyInFlight([paused("run-1")], {
      "run-1": convert("run-1"),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.conversions.map((c) => c.runId)).toEqual(["run-1"]);
      expect(result.excludedThreadIds).toEqual([]);
    }
  });

  test("a disposition for an id that never existed is a failure, not silence", () => {
    const result = classifyInFlight([], { ghost: { disposition: "isolate" } });
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.failures.some((f) => f.includes("ghost"))).toBe(true);
  });

  test("an unrecognized disposition word is a named refusal, never a silent exclude", () => {
    // The same typo class unknown ids already fail loudly for: `isloate`
    // must not fall through to the exclude path.
    const isolateTypo = classifyInFlight(
      [paused("run-1", { hasMastraContinuation: false })],
      { "run-1": { disposition: "isloate" } as InFlightDispositionEntry },
    );
    expect(isolateTypo.ok).toBe(false);
    if (!isolateTypo.ok) {
      expect(
        isolateTypo.failures.some((f) =>
          f.startsWith("invalid_disposition:run-1"),
        ),
      ).toBe(true);
      // A refusal carries no exclusions — the typo cannot hold a thread out.
      expect(
        isolateTypo.failures.some((f) => f.startsWith("not_drained")),
      ).toBe(false);
    }

    const snakeCase = classifyInFlight(
      [paused("run-2", { hasMastraContinuation: false })],
      { "run-2": { disposition: "legacy_drain" } as InFlightDispositionEntry },
    );
    expect(snakeCase.ok).toBe(false);
    if (!snakeCase.ok)
      expect(
        snakeCase.failures.some((f) =>
          f.startsWith("invalid_disposition:run-2"),
        ),
      ).toBe(true);

    // A typo'd row for a since-drained id is a named refusal too — never a
    // silent read-only archive.
    const ghostTypo = classifyInFlight([], {
      "run-3": { disposition: "legacy_drain" } as InFlightDispositionEntry,
    });
    expect(ghostTypo.ok).toBe(false);
    if (!ghostTypo.ok)
      expect(
        ghostTypo.failures.some((f) =>
          f.startsWith("invalid_disposition:run-3"),
        ),
      ).toBe(true);
  });

  test("a garbage effect on a convert-pause is a named refusal, never a conversion", () => {
    const result = classifyInFlight([paused("run-1")], {
      "run-1": {
        disposition: "convert-pause",
        effect: "receipt",
      } as InFlightDispositionEntry,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.failures.some((f) => f.startsWith("invalid_effect:run-1")),
      ).toBe(true);
      expect(
        result.failures.some((f) => f.startsWith("invalid_disposition")),
      ).toBe(false);
    }
  });

  test("every contract disposition and effect word still classifies", () => {
    const converted = classifyInFlight([paused("run-1")], {
      "run-1": { disposition: "convert-pause", effect: "none" },
    });
    expect(converted.ok).toBe(true);
    if (converted.ok)
      expect(converted.conversions.map((c) => c.runId)).toEqual(["run-1"]);

    const excluded = classifyInFlight(
      [paused("run-2", { hasMastraContinuation: false })],
      { "run-2": { disposition: "isolate" } },
    );
    expect(excluded.ok).toBe(true);

    const reInitiated = classifyInFlight(
      [paused("run-3", { hasMastraContinuation: false, status: "suspended" })],
      { "run-3": { disposition: "re-initiate" } },
    );
    expect(reInitiated.ok).toBe(true);

    const drained = classifyInFlight([], {
      "run-4": { disposition: "legacy-drain" },
    });
    expect(drained.ok).toBe(true);
    if (drained.ok)
      expect(drained.ledger.some((e) => e.kind === "drained")).toBe(true);

    // `unknown` is a contract effect word: refused by name as undeclarable,
    // not rejected as a typo.
    const unknownEffect = classifyInFlight([paused("run-5")], {
      "run-5": { disposition: "convert-pause", effect: "unknown" },
    });
    expect(unknownEffect.ok).toBe(false);
    if (!unknownEffect.ok)
      expect(
        unknownEffect.failures.some((f) =>
          f.startsWith("convert_requires_known_effect:run-5"),
        ),
      ).toBe(true);
  });

  test("the CLI's ledger parse checks the JSON shape with the same named errors", () => {
    const typo = parseInFlightDispositions({
      "run-1": { disposition: "isloate" },
    });
    expect(typo.ok).toBe(false);
    if (!typo.ok)
      expect(
        typo.failures.some((f) => f.startsWith("invalid_disposition:run-1")),
      ).toBe(true);

    const malformed = parseInFlightDispositions({ "run-2": "isolate" });
    expect(malformed.ok).toBe(false);
    if (!malformed.ok)
      expect(
        malformed.failures.some((f) =>
          f.startsWith("invalid_disposition:run-2"),
        ),
      ).toBe(true);

    const good = parseInFlightDispositions({
      "run-3": { disposition: "convert-pause", effect: "receipted", note: "n" },
      "run-4": { disposition: "legacy-drain" },
    });
    expect(good.ok).toBe(true);
    if (good.ok)
      expect(Object.keys(good.dispositions)).toEqual(["run-3", "run-4"]);
  });
});

// ---------------------------------------------------------------------------
// AC1/AC2: the apply gates
// ---------------------------------------------------------------------------

describe("ME14 switch gates (缺项不得 apply)", () => {
  const okLedger = classifyInFlight([], {});

  test("every gate passing lets the switch run", () => {
    const verdict = evaluateCutoverGates({
      entryInventory: parseEntryInventory(fullInventory),
      staging: "verified",
      admissionPausedAt: "2026-01-01T00:00:00Z",
      activeRuns: [],
      classified: okLedger,
    });
    expect(verdict.ok).toBe(true);
  });

  test("each missing item fails with its gate named — and all failures list together", () => {
    const verdict = evaluateCutoverGates({
      entryInventory: parseEntryInventory({
        entries: fullInventory.entries.slice(0, 3),
      }),
      staging: "staging",
      admissionPausedAt: undefined,
      activeRuns: [paused("run-9", { status: "running" })],
      classified: classifyInFlight([paused("run-1")], {}),
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      const gates = verdict.failed.map((f) => f.gate);
      expect(gates).toContain("entry-inventory");
      expect(gates).toContain("imports-verified");
      expect(gates).toContain("admission-paused");
      expect(gates).toContain("drained");
      expect(gates).toContain("in-flight-dispositioned");
    }
  });

  test("a blocked or switched staging state is not fence-eligible", () => {
    for (const staging of [
      "staging",
      "blocked",
      "rolled_back",
      "absent",
      "switched",
      "maintenance",
    ]) {
      const verdict = evaluateCutoverGates({
        entryInventory: parseEntryInventory(fullInventory),
        staging: staging as ReturnType<typeof stagingStatusOf>,
        admissionPausedAt: "2026-01-01T00:00:00Z",
        activeRuns: [],
        classified: okLedger,
      });
      expect(verdict.ok).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// AC3: the switch — recorded versions, one writer, interruption-safe
// ---------------------------------------------------------------------------

describe("ME14 runCutover (the switch)", () => {
  test("switches every verified thread with a recorded from→to version and the engine fingerprint", async () => {
    const store = new MemoryRunStore();
    const runId = verifiedState(store);
    const ports = switchPorts();
    const manifest = await runCutover(
      { runStore: store, switchPorts: ports, engineVersion: () => "fp-me14" },
      {
        runId,
        scope: scopeA,
        entryInventory: fullInventory,
        dispositions: {},
        pauseAdmission: true,
      },
    );
    expect(manifest.phase).toBe("switched");
    expect(ports.bumps.map((b) => b.threadId).sort()).toEqual([
      "thread-1",
      "thread-2",
    ]);
    const state = store.state as { fence?: CutoverFenceRecord };
    expect(state.fence?.engine).toBe("mastra");
    expect(state.fence?.engineVersion).toBe("fp-me14");
    expect(
      state.fence?.threads.map((t) => [
        t.fromBackendVersion,
        t.toBackendVersion,
      ]),
    ).toEqual([
      [1, 2],
      [1, 2],
    ]);
    expect(state.fence?.compatibleRollbackVersion).toBeNull();
  });

  test("refuses to switch an import that never reached verified", async () => {
    const store = new MemoryRunStore();
    store.state = {
      schemaVersion: 1,
      runId: "run-1",
      command: "apply",
      phase: "staging",
      scan: { mode: "scan", userId: "u", agentId: "a" },
      threads: {},
      updatedAt: "2026-01-01T00:00:00Z",
    };
    await expect(
      runCutover(
        { runStore: store, switchPorts: switchPorts() },
        {
          runId: "run-1",
          scope: scopeA,
          entryInventory: fullInventory,
          dispositions: {},
        },
      ),
    ).rejects.toThrow("CUTOVER_REQUIRES_VERIFIED");
  });

  test("a run paused mid-switch resumes without re-bumping switched threads", async () => {
    const store = new MemoryRunStore();
    const runId = verifiedState(store, { threads: ["thread-1", "thread-2"] });
    const ports = switchPorts({
      bumpFailures: { "tenant-a:thread-2": "db connection lost" },
    });
    await expect(
      runCutover(
        { runStore: store, switchPorts: ports, engineVersion: () => "fp" },
        {
          runId,
          scope: scopeA,
          entryInventory: fullInventory,
          dispositions: {},
          pauseAdmission: true,
        },
      ),
    ).rejects.toThrow("db connection lost");
    // The interrupted switch recorded exactly what it completed.
    const partial = store.state as {
      fence?: CutoverFenceRecord;
      phase?: string;
    };
    expect(partial.phase).toBe("verified");
    expect(partial.fence?.threads.map((t) => t.threadId)).toEqual(["thread-1"]);
    // Repair and resume: thread-1 is NOT bumped twice.
    const portsOk = switchPorts();
    const manifest = await runCutover(
      { runStore: store, switchPorts: portsOk, engineVersion: () => "fp" },
      {
        runId,
        scope: scopeA,
        entryInventory: fullInventory,
        dispositions: {},
        pauseAdmission: true,
      },
    );
    expect(manifest.phase).toBe("switched");
    expect(portsOk.bumps.map((b) => b.threadId)).toEqual(["thread-2"]);
    const done = store.state as { fence?: CutoverFenceRecord };
    expect(done.fence?.threads.map((t) => t.threadId).sort()).toEqual([
      "thread-1",
      "thread-2",
    ]);
  });

  test("an isolated pause's thread is recorded out of the switch, never bumped", async () => {
    const store = new MemoryRunStore();
    const runId = verifiedState(store, {
      threads: ["thread-1", "thread-run-1"],
    });
    const ports = switchPorts({
      inFlight: [paused("run-1", { hasMastraContinuation: false })],
    });
    const manifest = await runCutover(
      { runStore: store, switchPorts: ports, engineVersion: () => "fp" },
      {
        runId,
        scope: scopeA,
        entryInventory: fullInventory,
        dispositions: {
          "run-1": { disposition: "isolate", note: "legacy parking" },
        },
        pauseAdmission: true,
      },
    );
    expect(manifest.phase).toBe("switched");
    expect(ports.bumps.map((b) => b.threadId)).toEqual(["thread-1"]);
    const state = store.state as { fence?: CutoverFenceRecord };
    expect(state.fence?.excludedThreadIds).toEqual(["thread-run-1"]);
  });

  test("an undispositioned pause refuses the switch before any thread is bumped", async () => {
    const store = new MemoryRunStore();
    const runId = verifiedState(store);
    const ports = switchPorts({ inFlight: [paused("run-1")] });
    await expect(
      runCutover(
        { runStore: store, switchPorts: ports },
        {
          runId,
          scope: scopeA,
          entryInventory: fullInventory,
          dispositions: {},
          pauseAdmission: true,
        },
      ),
    ).rejects.toThrow("CUTOVER_GATES_FAILED");
    expect(ports.bumps).toEqual([]);
  });

  test("a typo'd disposition refuses the switch before any thread is bumped", async () => {
    const store = new MemoryRunStore();
    const runId = verifiedState(store);
    const ports = switchPorts({
      inFlight: [paused("run-1", { hasMastraContinuation: false })],
    });
    await expect(
      runCutover(
        { runStore: store, switchPorts: ports },
        {
          runId,
          scope: scopeA,
          entryInventory: fullInventory,
          dispositions: {
            "run-1": { disposition: "isloate" } as InFlightDispositionEntry,
          },
          pauseAdmission: true,
        },
      ),
    ).rejects.toThrow("invalid_disposition:run-1");
    expect(ports.bumps).toEqual([]);
  });

  test("a verified thread outside the switch scope fails by name", async () => {
    const store = new MemoryRunStore();
    const runId = verifiedState(store, { threads: ["thread-1"] });
    const state = store.state as {
      threads: Record<string, { ownership: { tenantId: string } }>;
    };
    state.threads["thread-1"].ownership.tenantId = "tenant-other";
    await expect(
      runCutover(
        { runStore: store, switchPorts: switchPorts() },
        {
          runId,
          scope: scopeA,
          entryInventory: fullInventory,
          dispositions: {},
          pauseAdmission: true,
        },
      ),
    ).rejects.toThrow("tenant-other");
  });

  test("a thread whose row left the mastra backend blocks the switch (不能跳过以完成上线)", async () => {
    const store = new MemoryRunStore();
    const runId = verifiedState(store);
    const ports = switchPorts({
      backends: {
        "tenant-a:thread-2": { backend: "intelligence", backendVersion: 4 },
      },
    });
    await expect(
      runCutover(
        { runStore: store, switchPorts: ports },
        {
          runId,
          scope: scopeA,
          entryInventory: fullInventory,
          dispositions: {},
          pauseAdmission: true,
        },
      ),
    ).rejects.toThrow("thread-2");
    // thread-1 may have been bumped before the blocker — the state says so honestly.
    const state = store.state as { fence?: CutoverFenceRecord };
    expect(state.fence).toBeDefined();
  });

  test("an already-switched run refuses a second switch (无双 writer)", async () => {
    const store = new MemoryRunStore();
    const runId = verifiedState(store);
    const ports = switchPorts();
    await runCutover(
      { runStore: store, switchPorts: ports, engineVersion: () => "fp" },
      {
        runId,
        scope: scopeA,
        entryInventory: fullInventory,
        dispositions: {},
        pauseAdmission: true,
      },
    );
    await expect(
      runCutover(
        { runStore: store, switchPorts: ports },
        {
          runId,
          scope: scopeA,
          entryInventory: fullInventory,
          dispositions: {},
          pauseAdmission: true,
        },
      ),
    ).rejects.toThrow("CUTOVER_ALREADY_SWITCHED");
    // Exactly one bump per thread across both attempts.
    expect(ports.bumps.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// AC5/AC6: rollback and maintenance
// ---------------------------------------------------------------------------

describe("ME14 rollback and maintenance", () => {
  async function switchedRun(
    options: {
      compatible?: string | null;
      inFlight?: InFlightItem[];
      intents?: Record<string, { clientMessageKey: string; state: string }[]>;
    } = {},
  ) {
    const store = new MemoryRunStore();
    const runId = verifiedState(store);
    // Mutable: the unsafe-rollback tests inject a live run AFTER the switch.
    const live: InFlightItem[] = [];
    const ports = switchPorts({ inFlight: live, intents: options.intents });
    await runCutover(
      { runStore: store, switchPorts: ports, engineVersion: () => "fp" },
      {
        runId,
        scope: scopeA,
        entryInventory: fullInventory,
        dispositions: {},
        compatibleRollbackVersion:
          options.compatible === undefined ? "app-1.2.0" : options.compatible,
        pauseAdmission: true,
      },
    );
    return { store, runId, ports, live };
  }

  test("a safe rollback keeps every piece of new data and records the preservation receipt", async () => {
    const { store, runId, ports } = await switchedRun({
      intents: {
        "tenant-a:thread-1": [
          { clientMessageKey: "msg-new-1", state: "finalized" },
          { clientMessageKey: "legacy:src-1", state: "finalized" },
        ],
      },
    });
    const before = JSON.stringify(
      (store.state as { fence?: CutoverFenceRecord }).fence,
    );
    const manifest = await runCutoverRollback(
      { runStore: store, switchPorts: ports },
      { runId },
      "engine regression after switch",
    );
    expect(manifest.phase).toBe("rolled_back");
    const state = store.state as { fence?: CutoverFenceRecord };
    // The rollback bumps the write generation again (a rolled-back deployment
    // is a different writer generation) and records what it preserved.
    expect(state.fence?.threads.every((t) => t.toBackendVersion === 2)).toBe(
      true,
    );
    expect(state.fence?.rollback?.toBackendVersion).toBe(3);
    expect(state.fence?.rollback?.preserved.newIntents).toBe(1);
    expect(state.fence?.rollback?.receiptRefs).toEqual([
      { clientMessageKey: "msg-new-1" },
    ]);
    // The switch record itself is history, never rewritten.
    expect(JSON.stringify(state.fence).length).toBeGreaterThan(before.length);
    expect(state.fence?.rollback?.reason).toBe(
      "engine regression after switch",
    );
  });

  test("an active run in scope makes rollback UNSAFE — maintenance with the diagnosable reason", async () => {
    const { store, runId, ports, live } = await switchedRun();
    live.push(paused("run-live", { status: "running" }));
    const bumpsBefore = ports.bumps.length;
    const manifest = await runCutoverRollback(
      { runStore: store, switchPorts: ports },
      { runId },
      "engine regression after switch",
    );
    expect(manifest.phase).toBe("maintenance");
    const state = store.state as { fence?: CutoverFenceRecord };
    expect(state.fence?.maintenance?.reason).toContain("run-live");
    // No version bump happened on the unsafe path.
    expect(ports.bumps.length).toBe(bumpsBefore);
    // And the new data is untouched: no rollback receipt claiming preservation.
    expect(state.fence?.rollback).toBeUndefined();
  });

  test("no compatible rollback version recorded at switch → maintenance, never a guess", async () => {
    const { store, runId, ports } = await switchedRun({ compatible: null });
    const manifest = await runCutoverRollback(
      { runStore: store, switchPorts: ports },
      { runId },
      "engine regression after switch",
    );
    expect(manifest.phase).toBe("maintenance");
    const state = store.state as { fence?: CutoverFenceRecord };
    expect(state.fence?.maintenance?.reason).toContain("compatible");
  });

  test("a drifted backend version stops the rollback into maintenance", async () => {
    const { store, runId } = await switchedRun();
    const ports = switchPorts({
      backends: {
        "tenant-a:thread-1": { backend: "mastra", backendVersion: 99 },
      },
    });
    const manifest = await runCutoverRollback(
      { runStore: store, switchPorts: ports },
      { runId },
      "engine regression after switch",
    );
    expect(manifest.phase).toBe("maintenance");
    const state = store.state as { fence?: CutoverFenceRecord };
    expect(state.fence?.maintenance?.reason).toContain("drift");
  });

  test("maintenance is terminal for the tool: no rollback out of it without a new run", async () => {
    const { store, runId, ports, live } = await switchedRun();
    live.push(paused("run-live", { status: "running" }));
    await runCutoverRollback(
      { runStore: store, switchPorts: ports },
      { runId },
      "engine regression after switch",
    );
    await expect(
      runCutoverRollback(
        { runStore: store, switchPorts: ports },
        { runId },
        "try again",
      ),
    ).rejects.toThrow("MAINTENANCE");
  });

  test("rollback of a run that never switched refuses (the import-side rollback owns that state)", async () => {
    const store = new MemoryRunStore();
    verifiedState(store);
    await expect(
      runCutoverRollback(
        { runStore: store, switchPorts: switchPorts() },
        { runId: "run-1" },
        "reason",
      ),
    ).rejects.toThrow("CUTOVER_ROLLBACK_REQUIRES_SWITCHED");
  });
});

// ---------------------------------------------------------------------------
// ME16 (#488): the carried rollback hardening — F3 phase guard, F2 partial-
// switch maintenance exit, F4 truthful preservation receipt.
// ---------------------------------------------------------------------------

describe("ME16 carried rollback hardening", () => {
  /** The switched fixture, local to this block (the ME14 one is describe-scoped). */
  async function switchedState(
    intents: Record<string, { clientMessageKey: string; state: string }[]> = {},
  ) {
    const store = new MemoryRunStore();
    const runId = verifiedState(store);
    const live: InFlightItem[] = [];
    const ports = switchPorts({ inFlight: live, intents });
    await runCutover(
      { runStore: store, switchPorts: ports, engineVersion: () => "fp" },
      {
        runId,
        scope: scopeA,
        entryInventory: fullInventory,
        dispositions: {},
        compatibleRollbackVersion: "app-1.2.0",
        pauseAdmission: true,
      },
    );
    return { store, runId, ports };
  }

  test("a second rollback refuses by its own name, not as a missing switch", async () => {
    const { store, runId, ports } = await switchedState();
    await runCutoverRollback(
      { runStore: store, switchPorts: ports },
      { runId },
      "engine regression after switch",
    );
    // The state IS a rolled-back state: refusing it with "no switch to roll
    // back" sent the operator hunting for a phase that is not the problem.
    await expect(
      runCutoverRollback(
        { runStore: store, switchPorts: ports },
        { runId },
        "try again",
      ),
    ).rejects.toThrow("CUTOVER_ALREADY_ROLLED_BACK");
  });

  test("a partial switch exits through maintenance — never a pretended rollback", async () => {
    const store = new MemoryRunStore();
    const runId = verifiedState(store);
    // thread-2's row is not on the mastra backend, so the switch stops there
    // AFTER thread-1 was already bumped: one bumped thread, one untouched.
    const ports = switchPorts({
      backends: {
        "tenant-a:thread-2": { backend: "legacy", backendVersion: 1 },
      },
    });
    await expect(
      runCutover(
        { runStore: store, switchPorts: ports, engineVersion: () => "fp" },
        {
          runId,
          scope: scopeA,
          entryInventory: fullInventory,
          dispositions: {},
          compatibleRollbackVersion: "app-1.2.0",
          pauseAdmission: true,
        },
      ),
    ).rejects.toThrow("CUTOVER_SWITCH_BLOCKED");
    expect(ports.bumps).toHaveLength(1);
    // The blocked scope's writers live on BOTH generations: a rollback here
    // cannot prove anything, and "no switch to roll back" was a lie — one
    // thread DID switch. Maintenance is the exit that says so.
    const manifest = await runCutoverRollback(
      { runStore: store, switchPorts: ports },
      { runId },
      "operator stopped a blocked switch",
    );
    expect(manifest.phase).toBe("maintenance");
    const state = store.state as { fence?: CutoverFenceRecord };
    expect(state.fence?.maintenance?.reason).toMatch(/partial/i);
    // The rollback moved no generation: the bumped count is still one.
    expect(ports.bumps).toHaveLength(1);
  });

  test("the preservation receipt counts only what it names", async () => {
    const { store, runId, ports } = await switchedState({
      "tenant-a:thread-1": [
        { clientMessageKey: "msg-new-1", state: "finalized" },
      ],
    });
    await runCutoverRollback(
      { runStore: store, switchPorts: ports },
      { runId },
      "engine regression after switch",
    );
    const state = store.state as { fence?: CutoverFenceRecord };
    // `preserved.newMemoryRows` used to carry the INTENT count under a
    // memory name — a receipt that overstated what the fence proved. The
    // receipt counts the intents it actually inventoried, and nothing else.
    expect(state.fence?.rollback?.preserved).toEqual({ newIntents: 1 });
  });
});

// ---------------------------------------------------------------------------
// AC3: the fence consumes and is consumed — staging states and the import
// ---------------------------------------------------------------------------

describe("ME14 fence state machine vs the import commands", () => {
  test("stagingStatusOf recognizes the fence phases", () => {
    expect(stagingStatusOf({ phase: "switched" })).toBe("switched");
    expect(stagingStatusOf({ phase: "maintenance" })).toBe("maintenance");
    expect(stagingStatusOf({ phase: "verified" })).toBe("verified");
    expect(stagingStatusOf({ phase: "something-new" })).toBe("absent");
  });

  test("the import apply refuses a switched or maintenance state by name", async () => {
    for (const phase of ["switched", "maintenance"]) {
      const store = new MemoryRunStore();
      const runId = verifiedState(store);
      await runCutover(
        {
          runStore: store,
          switchPorts: switchPorts(),
          engineVersion: () => "fp",
        },
        {
          runId,
          scope: scopeA,
          entryInventory: fullInventory,
          dispositions: {},
          pauseAdmission: true,
        },
      );
      const state = store.state as { phase?: string };
      state.phase = phase;
      const ports = fixtureImportPorts();
      await expect(
        runApply(
          {
            source: fixtureSource(),
            ports,
            writer: fixtureWriter(),
            runStore: store,
          },
          {
            runId,
            scan: { mode: "scan", userId: "u", agentId: "a" },
            authorization: { fixtureId: "f" },
            environmentFixtureId: "f",
          },
        ),
      ).rejects.toThrow(`CUTOVER_STATE_${phase.toUpperCase()}`);
    }
  });

  test("verify refuses a state a switch has started on", async () => {
    const store = new MemoryRunStore();
    const runId = verifiedState(store);
    (store.state as { fence?: unknown }).fence = {
      engine: "mastra",
      threads: [],
    };
    await expect(
      runVerify(
        {
          source: fixtureSource(),
          ports: fixtureImportPorts(),
          targetReader: { readFinalizedRows: async () => [] },
          runStore: store,
        },
        { runId, scan: { mode: "scan", userId: "u", agentId: "a" } },
      ),
    ).rejects.toThrow("CUTOVER_SWITCH_IN_PROGRESS");
  });
});

// ---------------------------------------------------------------------------
// Carried ME13 hardening: pending-intent staging precheck + resume re-classify
// ---------------------------------------------------------------------------

function fixtureSource() {
  return {
    async listThreads() {
      return { threads: [], nextCursor: null };
    },
    async getThreadMessages() {
      return { messages: [] };
    },
  };
}

function fixtureWriter(): LegacyImportWriter {
  return {
    async appendImportedUser() {},
    async appendImportedEngine() {},
  };
}

function fixtureImportPorts(
  over: {
    rows?: Record<string, unknown[]>;
    pendingForeign?: number;
    backend?: string;
  } = {},
): LegacyOwnershipPorts {
  return {
    async conversationRowsForThread(threadId) {
      return (
        (over.rows?.[threadId] as never) ?? [
          {
            tenantId: "tenant-a",
            workspaceId: "workspace-a",
            principalId: "principal-a",
            conversationId: "conv-1",
            storageBackend: (over.backend ?? "mastra") as never,
          },
        ]
      );
    },
    async actorIdForPrincipal() {
      return "actor-a";
    },
    async resolveScope(input) {
      return {
        tenantId: input.tenantId,
        workspaceId: input.workspaceId,
        principalId: "principal-a",
        actorId: input.actorId,
        memberEpoch: 1,
        aclEpoch: 1,
        entrypoint: "schedule",
      };
    },
    async foreignFinalizedIntentCount() {
      return 0;
    },
    async foreignPendingIntentCount() {
      return over.pendingForeign ?? 0;
    },
    async finalizedKeyExists() {
      return false;
    },
    async existingAttachmentIds(ids) {
      return new Set(ids);
    },
  };
}

describe("ME14 carried ME13 hardening", () => {
  test("F1: a pending foreign intent blocks staging (an in-flight writer is a non-empty target)", async () => {
    const { inventoryThreads } = await import("../src/mastra/legacy-import");
    const outcome = await inventoryThreads({
      source: fixtureSource(),
      ports: fixtureImportPorts({ pendingForeign: 2 }),
      scan: { mode: "explicit-thread", threadId: "thread-1" },
    });
    expect(outcome.entries[0]?.skipReason).toBe("target_not_empty");
  });

  test("F2: a resumed apply re-runs the staging classification — a backend flip since the crash quarantines", async () => {
    const store = new MemoryRunStore();
    store.state = {
      schemaVersion: 1,
      runId: "run-1",
      command: "apply",
      // The interrupted thread was importable when it crashed.
      phase: "in_progress",
      scan: { mode: "scan", userId: "u", agentId: "a" },
      threads: {
        "thread-1": {
          threadId: "thread-1",
          status: "importing",
          ownership: {
            status: "unique",
            tenantId: "tenant-a",
            workspaceId: "workspace-a",
            principalId: "principal-a",
          },
          storageBackend: "mastra",
          source: { messageCount: null, digest: null, readComplete: false },
        },
      },
      authorizedFixture: "f",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    // Since the crash, the thread's backend flipped back to intelligence.
    const ports = fixtureImportPorts({ backend: "intelligence" });
    const manifest = await runApply(
      {
        source: fixtureSource(),
        ports,
        writer: fixtureWriter(),
        runStore: store,
      },
      {
        runId: "run-1",
        scan: { mode: "scan", userId: "u", agentId: "a" },
        authorization: { fixtureId: "f" },
        environmentFixtureId: "f",
      },
    );
    const entry = manifest.threads.find((t) => t.threadId === "thread-1");
    expect(entry?.status).toBe("quarantined");
    expect(entry?.reason).toBe("backend_not_staging");
  });

  test("F3: the persisted state path cannot be escaped by an operator-supplied run id", () => {
    expect(() =>
      createFileRunStore("/tmp/cutover-state", "../../evil"),
    ).toThrow("CUTOVER_RUN_ID_INVALID");
    expect(() => createFileRunStore("/tmp/cutover-state", "a/b")).toThrow(
      "CUTOVER_RUN_ID_INVALID",
    );
    expect(() => createFileRunStore("/tmp/cutover-state", ".hidden")).toThrow(
      "CUTOVER_RUN_ID_INVALID",
    );
    expect(() => createFileRunStore("/tmp/cutover-state", "")).toThrow(
      "CUTOVER_RUN_ID_INVALID",
    );
    const ok = createFileRunStore("/tmp/cutover-state", "run-1_OK.2");
    expect(ok.path).toBe("/tmp/cutover-state/run-1_OK.2.json");
  });
});

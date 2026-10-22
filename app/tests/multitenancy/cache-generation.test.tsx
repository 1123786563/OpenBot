import "../preload";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import { act } from "react";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "../../../tests/support/bun-test-compat";
import {
  TenantSelectionChangedError,
  guarded,
  tenantKeys,
} from "../../src/lib/enterprise/tenant/queries";
import {
  type ScopeSelection,
  selectionKeys,
  selectionStorageKey,
  selectWorkspaceScope,
  storeSelection,
} from "../../src/lib/enterprise/tenant/selection";
import {
  cacheWriteGate,
  scopedCachePrefix,
  useScopedCache,
} from "../../src/lib/enterprise/tenant/scoped-cache";
import { streamWriteStillCurrent } from "../../src/lib/enterprise/tenant/stream-scope";

/**
 * MT083 / Issue #126: the business cache is scoped and generation-guarded. A business entry's key
 * names the user, the company and the team (AC1); a switch removes the old scope's business
 * entries — the personal context's included — so no old data flashes through, and an optimistic
 * write's rollback is dropped rather than replayed once its generation is gone (AC2); a response
 * that outlived its selection is refused on arrival and writes nothing (AC3); a new tab and a long
 * connection obey the SAME rules, because every face consults the one generation entry (AC4).
 *
 * THE HARNESS IS THE REAL SELECTION SOURCE WITH HAND-HELD ANSWERS, as in `selection.test.tsx` and
 * MT082's `transport-streams.test.tsx`: `fetch` serves only `/api/me` (the scope source's own
 * read), the live selection is seeded from storage exactly as production seeds it, and every
 * switch goes through `selectWorkspaceScope` — the one seam. The business reads under test are
 * hand-built from the mechanism's own exports (`scopedCachePrefix` + `guarded`), because the
 * surfaces that adopt them (#127 onward) each carry their own wiring tests; what this file pins
 * is the rule they all reuse. In-flight timing is exact: each business answer is a deferred
 * promise the test resolves when it chooses, so "the response arrived after the switch" is a
 * fact, not a sleep.
 */

const USER = "user-1";
const ACME: ScopeSelection = { tenantId: "acme", workspaceId: "acme-finance" };
const ACME_OPS: ScopeSelection = {
  tenantId: "acme",
  workspaceId: "acme-ops",
};
const GLOBEX: ScopeSelection = {
  tenantId: "globex",
  workspaceId: "globex-ops",
};

beforeAll(() => {
  GlobalRegistrator.register();
  // This file calls `act` directly, and React's act refuses to flush outside a test environment
  // flag; @testing-library sets it only around its own calls, so a sibling file's cleanup having
  // reset it would leave our switches unflushed in a shared bun process. Pin it for this file.
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => GlobalRegistrator.unregister());
afterEach(cleanup);

const originalFetch = global.fetch;

/** Only the scope source's own read is served; business answers are hand-held deferreds. */
function serveAuth(): void {
  global.fetch = (async (input: RequestInfo | URL) => {
    if (String(input) === "/api/me") {
      return new Response(JSON.stringify({ user: { id: USER } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  window.localStorage.clear();
  serveAuth();
});

afterEach(() => {
  global.fetch = originalFetch;
});

function freshClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
}

/** The whole switch, as production makes it: the storage mirror and the one switch seam. */
function switchSelection(
  queryClient: QueryClient,
  previous: ScopeSelection | null,
  next: ScopeSelection | null,
): void {
  if (next !== null) storeSelection(USER, next);
  else window.localStorage.removeItem(selectionStorageKey(USER));
  selectWorkspaceScope(queryClient, USER, previous, next);
}

function generationOf(queryClient: QueryClient): number {
  return queryClient.getQueryData<number>(tenantKeys.generation(USER)) ?? 0;
}

type BusinessRow = { name: string };

/** One deferred value, for the direct guard calls. */
function answer<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/**
 * Business answers addressed by read order: read #0 is the first queryFn call the probe makes,
 * read #1 the one after a re-key, and so on. Each slot is a deferred created on demand, so the
 * test can settle one long after its read started ("the response arrived after the switch") or
 * leave it pending ("the new scope has not answered yet").
 */
function answerQueue() {
  const slots: {
    promise: Promise<BusinessRow>;
    resolve: (row: BusinessRow) => void;
  }[] = [];
  const slot = (index: number) => {
    while (slots.length <= index) {
      let resolve!: (row: BusinessRow) => void;
      const promise = new Promise<BusinessRow>((res) => {
        resolve = res;
      });
      slots.push({ promise, resolve });
    }
    return slots[index]!;
  };
  let reads = 0;
  return {
    /** Resolve read #index's answer. */
    settle: (index: number, row: BusinessRow) => slot(index).resolve(row),
    /** The probe's own callback: each read consumes the next slot's promise. */
    next: (): Promise<BusinessRow> => slot(reads++).promise,
  };
}

/**
 * A business surface in miniature: one detail-shaped read, keyed by the mechanism's prefix and
 * guarded by the mechanism's in-flight rule, re-keyed reactively as the scope moves. Mounting it
 * mounts `useScopedCache`, which mounts the storage listener a second tab's switch rides in on —
 * so the probe IS the production wiring shape.
 */
function BusinessProbe({ answers }: { answers: () => Promise<BusinessRow> }) {
  const queryClient = useQueryClient();
  const scope = useScopedCache();
  const read = useQuery({
    queryKey:
      scope.status === "open"
        ? [...scope.prefix, "agents", "detail", "bot-1"]
        : ["agents", "detail", "bot-1", ":scope-pending"],
    enabled: scope.status === "open",
    queryFn: () =>
      scope.status === "open"
        ? guarded(queryClient, scope.userId, answers)
        : answers(),
  });
  return (
    <div>
      <span data-testid="scope-key">
        {scope.status === "open" ? scope.key : "pending"}
      </span>
      <span data-testid="business">
        {read.isPending
          ? "pending"
          : read.error
            ? `error:${read.error.name}`
            : (read.data?.name ?? "")}
      </span>
    </div>
  );
}

function draw(queryClient: QueryClient, probe: React.ReactNode) {
  return render(
    <QueryClientProvider client={queryClient}>{probe}</QueryClientProvider>,
  );
}

/**
 * One tick past a switch made inside `act`: React Query's cache notifications reach the observing
 * components on the next microtask, so the re-key (and the pending it must show) is observable
 * after this flush — the same one-tick discipline MT082's teardown assertions flush with.
 */
async function settleSwitch(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const businessKey = (selection: ScopeSelection | null) => [
  ...scopedCachePrefix(USER, selection),
  "agents",
  "detail",
  "bot-1",
];

// ---------------------------------------------------------------------------
// AC1 — the key names the user, the company and the team; two scopes never share an entry
// ---------------------------------------------------------------------------

describe("MT083 AC1 — business keys carry the whole scope", () => {
  test("the prefix names user, company and team; the personal context has its own subtree", () => {
    expect(scopedCachePrefix(USER, ACME)).toEqual([
      ...tenantKeys.scope(USER, "acme"),
      ":workspace",
      "acme-finance",
    ]);
    expect(scopedCachePrefix(USER, null)).toEqual([
      ...tenantKeys.all,
      USER,
      ":personal",
    ]);
    // The reserved leading-colon token can never be a tenant id, so the personal subtree cannot
    // collide with — or be swept up by — any company's prefix.
    expect(scopedCachePrefix(USER, null)).not.toEqual(
      scopedCachePrefix(USER, ACME),
    );
  });

  test("two scopes' same-named business entries never hit each other", () => {
    const queryClient = freshClient();
    queryClient.setQueryData(businessKey(ACME), { name: "Alpha" });
    expect(queryClient.getQueryData(businessKey(ACME)) as unknown).toEqual({
      name: "Alpha",
    });
    // The same query, same bot, same shape — a different company, a different team, or no
    // selection at all: none of them is served Acme's entry.
    expect(queryClient.getQueryData(businessKey(ACME_OPS))).toBeUndefined();
    expect(queryClient.getQueryData(businessKey(GLOBEX))).toBeUndefined();
    expect(queryClient.getQueryData(businessKey(null))).toBeUndefined();
  });

  test("a mounted read under one scope is not served another scope's cached answer", async () => {
    storeSelection(USER, ACME);
    const queryClient = freshClient();
    const answers = answerQueue();
    answers.settle(0, { name: "Alpha" });
    const view = draw(
      queryClient,
      <BusinessProbe answers={() => answers.next()} />,
    );
    await waitFor(() =>
      expect(view.getByTestId("business").textContent).toBe("Alpha"),
    );

    // The same component, the same bot id, the Globex scope: a fresh read, not Acme's entry.
    await act(async () => {
      switchSelection(queryClient, ACME, GLOBEX);
    });
    await settleSwitch();
    expect(view.getByTestId("business").textContent).toBe("pending");
    answers.settle(1, { name: "Beta" });
    await waitFor(() =>
      expect(view.getByTestId("business").textContent).toBe("Beta"),
    );
  });
});

// ---------------------------------------------------------------------------
// AC2 — the switch removes the old scope's business cache; optimistic writes never roll back
// across it
// ---------------------------------------------------------------------------

describe("MT083 AC2 — the switch clears the old scope, flash and rollback included", () => {
  test("a company switch removes the old company's whole business subtree; a team change only the old team's", () => {
    const queryClient = freshClient();
    queryClient.setQueryData(businessKey(ACME), { name: "Alpha" });
    queryClient.setQueryData(businessKey(ACME_OPS), { name: "Ops" });
    const before = generationOf(queryClient);

    switchSelection(queryClient, ACME, GLOBEX);
    expect(generationOf(queryClient)).toBe(before + 1);
    expect(queryClient.getQueryData(businessKey(ACME))).toBeUndefined();
    expect(queryClient.getQueryData(businessKey(ACME_OPS))).toBeUndefined();

    // Leaving one team is not leaving the company: the sibling team's entry survives.
    switchSelection(queryClient, GLOBEX, ACME_OPS);
    queryClient.setQueryData(businessKey(ACME), { name: "Alpha" });
    switchSelection(queryClient, ACME_OPS, ACME);
    expect(queryClient.getQueryData(businessKey(ACME_OPS))).toBeUndefined();
    expect(queryClient.getQueryData(businessKey(ACME)) as unknown).toEqual({
      name: "Alpha",
    });
  });

  test("choosing a scope out of the personal context drops the personal business subtree", () => {
    const queryClient = freshClient();
    queryClient.setQueryData(businessKey(null), { name: "Personal" });
    const before = generationOf(queryClient);

    switchSelection(queryClient, null, ACME);
    expect(generationOf(queryClient)).toBe(before + 1);
    expect(queryClient.getQueryData(businessKey(null))).toBeUndefined();
  });

  test("an optimistic write's rollback lands while its scope holds, and is dropped once it does not", () => {
    const queryClient = freshClient();
    queryClient.setQueryData(businessKey(ACME), { name: "Original" });

    // The pattern a scoped mutation's onError runs: capture the gate, restore only if it holds.
    const heldGate = cacheWriteGate(queryClient, USER);
    queryClient.setQueryData(businessKey(ACME), { name: "Editing" });
    expect(heldGate.stillCurrent()).toBe(true);
    if (heldGate.stillCurrent()) {
      queryClient.setQueryData(businessKey(ACME), { name: "Original" });
    }
    expect(queryClient.getQueryData(businessKey(ACME)) as unknown).toEqual({
      name: "Original",
    });

    // The same restore after a switch: the gate refuses it, so neither the optimistic value nor
    // the rollback survives — and nothing lands in the scope that replaced it.
    const staleGate = cacheWriteGate(queryClient, USER);
    queryClient.setQueryData(businessKey(ACME), { name: "Editing" });
    switchSelection(queryClient, ACME, GLOBEX);
    expect(staleGate.stillCurrent()).toBe(false);
    if (staleGate.stillCurrent()) {
      queryClient.setQueryData(businessKey(ACME), { name: "Original" });
    }
    expect(queryClient.getQueryData(businessKey(ACME))).toBeUndefined();
    expect(queryClient.getQueryData(businessKey(GLOBEX))).toBeUndefined();
  });

  test("a switch never flashes the old scope's data on the screen", async () => {
    storeSelection(USER, ACME);
    const queryClient = freshClient();
    const answers = answerQueue();
    answers.settle(0, { name: "Alpha" });
    const view = draw(
      queryClient,
      <BusinessProbe answers={() => answers.next()} />,
    );
    await waitFor(() =>
      expect(view.getByTestId("business").textContent).toBe("Alpha"),
    );

    // Read #1 (Globex's own) is deliberately never settled: the screen must sit at pending.
    await act(async () => {
      switchSelection(queryClient, ACME, GLOBEX);
    });
    await settleSwitch();
    // The moment the scope moves the screen is pending again — Acme's row is gone from the cache
    // AND from the screen, with nothing to render in its place until Globex answers.
    expect(view.getByTestId("business").textContent).toBe("pending");
  });
});

// ---------------------------------------------------------------------------
// AC3 — an answer that outlived its selection is refused and writes nothing
// ---------------------------------------------------------------------------

describe("MT083 AC3 — in-flight answers of a gone generation write nothing", () => {
  test("guarded refuses an answer whose generation moved, and passes one that did not", async () => {
    const queryClient = freshClient();
    const stayed = answer<BusinessRow>();
    const read = guarded(queryClient, USER, () => stayed.promise);
    stayed.resolve({ name: "On time" });
    await expect(read).resolves.toEqual({ name: "On time" });

    const late = answer<BusinessRow>();
    const refused = guarded(queryClient, USER, () => late.promise);
    switchSelection(queryClient, ACME, GLOBEX);
    late.resolve({ name: "Late" });
    await expect(refused).rejects.toBeInstanceOf(TenantSelectionChangedError);
  });

  test("a late answer errors the read it belonged to and decorates no cache", async () => {
    storeSelection(USER, ACME);
    const queryClient = freshClient();
    const answers = answerQueue();
    const view = draw(
      queryClient,
      <BusinessProbe answers={() => answers.next()} />,
    );
    await waitFor(() =>
      expect(view.getByTestId("business").textContent).toBe("pending"),
    );

    // The read left under Acme; the switch happens; THEN the answer lands. It must refuse —
    // nothing of Acme's may appear, and Globex's entry must stay untouched.
    await act(async () => {
      switchSelection(queryClient, ACME, GLOBEX);
    });
    await settleSwitch();
    await act(async () => {
      answers.settle(0, { name: "Late from Acme" });
    });
    await settleSwitch();
    expect(queryClient.getQueryData(businessKey(ACME))).toBeUndefined();
    expect(queryClient.getQueryData(businessKey(GLOBEX))).toBeUndefined();
    expect(view.getByTestId("business").textContent).toBe("pending");

    // Globex's own answer, arriving under the generation it left under, still lands.
    answers.settle(1, { name: "Beta" });
    await waitFor(() =>
      expect(view.getByTestId("business").textContent).toBe("Beta"),
    );
    expect(queryClient.getQueryData(businessKey(GLOBEX)) as unknown).toEqual({
      name: "Beta",
    });
  });
});

// ---------------------------------------------------------------------------
// AC4 — a new tab and a long connection obey the same rules: one generation entry
// ---------------------------------------------------------------------------

describe("MT083 AC4 — new tabs and long connections share the one discipline", () => {
  test("a switch committed in ANOTHER tab (the storage event) clears this tab's business cache the same way", async () => {
    storeSelection(USER, ACME);
    const queryClient = freshClient();
    const answers = answerQueue();
    answers.settle(0, { name: "Alpha" });
    const view = draw(
      queryClient,
      <BusinessProbe answers={() => answers.next()} />,
    );
    await waitFor(() =>
      expect(view.getByTestId("business").textContent).toBe("Alpha"),
    );
    const before = generationOf(queryClient);

    // The other tab commits: its storage mirror moves, this tab only hears the event — and the
    // listener runs the SAME switch seam (generation first, then the old scope's cache goes).
    // Read #1 (Globex's) is left pending on purpose: what is asserted is the removal.
    storeSelection(USER, GLOBEX);
    await act(async () => {
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: selectionStorageKey(USER),
          newValue: JSON.stringify(GLOBEX),
        }),
      );
    });
    await settleSwitch();
    expect(generationOf(queryClient)).toBe(before + 1);
    expect(queryClient.getQueryData(businessKey(ACME))).toBeUndefined();
    expect(view.getByTestId("business").textContent).toBe("pending");
  });

  test("a stream's write gate and a business read's guard consult the one generation entry", () => {
    const queryClient = freshClient();
    // A connection (MT082) and an optimistic write (this ticket) both opened at generation 0.
    const gate = cacheWriteGate(queryClient, USER);
    expect(streamWriteStillCurrent(queryClient, USER, 0)).toBe(true);
    expect(gate.stillCurrent()).toBe(true);

    // Any switch advances the one entry both faces read, so a stale stream frame and a stale
    // rollback are refused by the same fact — never two disciplines to keep in step.
    switchSelection(queryClient, ACME, GLOBEX);
    expect(streamWriteStillCurrent(queryClient, USER, 0)).toBe(false);
    expect(gate.stillCurrent()).toBe(false);
    expect(gate.at).toBe(0);
  });

  test("the selection entries the mechanism rides are the ones the switch seam owns", () => {
    // The reactive source must be the SAME cache entries MT082 reads, or the two faces could
    // disagree about what is current; pin the identity so a future refactor cannot fork them.
    expect(selectionKeys.current(USER)).toEqual([
      ...tenantKeys.all,
      USER,
      ":current-selection",
    ]);
    expect(selectionKeys.workspaceScope(USER, "acme", "acme-finance")).toEqual([
      ...tenantKeys.scope(USER, "acme"),
      ":workspace",
      "acme-finance",
    ]);
    expect(scopedCachePrefix(USER, ACME)).toEqual(
      selectionKeys.workspaceScope(USER, "acme", "acme-finance"),
    );
  });
});

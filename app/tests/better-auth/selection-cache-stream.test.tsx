import "../preload";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient } from "@tanstack/react-query";
import type { ValidatedSelection } from "../../../shared/auth-directory";
import {
  afterAll,
  beforeAll,
  expect,
  test,
} from "../../../tests/support/e2e-compat";
import { tenantKeys } from "../../src/lib/enterprise/tenant/queries";
import {
  adoptActivePreference,
  readCurrentSelection,
  type ScopeSelection,
  scopeAbortSignal,
  selectionStorageKey,
  storeSelection,
  switchWorkspaceScope,
} from "../../src/lib/enterprise/tenant/selection";
import { bindScopeStorageMirror } from "../../src/lib/enterprise/tenant/stream-scope";

/**
 * The cleanup half of the switch, T03.06 / Issue #543 (the cache/stream face of P07).
 *
 * WHAT IS UNDER TEST. A selection epoch is the unit of cleanup: every long stream, in-flight
 * request and mutation opens against the epoch in force, and every switch — a team change, a
 * company change, into or out of a selection, and the cross-tab mirror of another tab's committed
 * switch — ends that epoch. A response that left under one epoch and lands after another was
 * selected writes nothing; an epoch the session left cannot publish after a later intent; and a
 * stream still open under a dead epoch is aborted, not merely left to close whenever its next
 * render gets around to it.
 *
 * THE WINDOWS THE COORDINATOR OWNS. The T03.05 review (R1-F1) found the one unchecked window: the
 * BA active-preference write is a real network await sitting between the last `stale()` recheck
 * and the publish, so a newer explicit intent landing inside it could be overwritten by the older
 * one. The same family is checked here at the seam the other tab writes through: a cross-tab
 * switch must stale this session's in-flight intents too (the mirror burns an explicit intent,
 * because a person acted — in another tab), and an in-place re-confirmation must burn one as
 * well (R1-F2), so a background seed can never outrank a person who only ever confirmed in place.
 *
 * THE HARNESS IS THE SEAM ITSELF, no renderer: the coordinator with injected validate/preference
 * sinks and held promises order the interleavings exactly (no sleeps), and the browser's storage
 * event drives the real cross-tab mirror a fresh QueryClient is bound to. A long stream appears
 * as the epoch signal a real transport would open its fetch against — abort is the observable.
 */

const originalFetch = globalThis.fetch;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
});
afterAll(() => {
  GlobalRegistrator.unregister();
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// Fixtures — the §4 echo shapes the T03.02 validation answers with
// ---------------------------------------------------------------------------

const LATE_USER = "u-late";
const TAB_USER = "u-tab";
const PLACE_USER = "u-place";

const SCOPE_A: ScopeSelection = { tenantId: "a", workspaceId: "a-finance" };
const SCOPE_B: ScopeSelection = { tenantId: "b", workspaceId: "b-ops" };

/** The §4 echo for scope A: the asked pair comes back, bound to the BA rows it owns. */
function validatedA(): ValidatedSelection {
  return {
    tenantId: "a",
    workspaceId: "a-finance",
    organizationId: "org-a",
    teamId: "team-a-finance",
    memberEpoch: 3,
    workspaceMemberEpoch: 2,
    companyGeneration: 2,
    teamGeneration: 1,
    capabilities: [],
  };
}

/** The §4 echo for scope B: the asked pair comes back, bound to the BA rows it owns. */
function validatedB(): ValidatedSelection {
  return {
    tenantId: "b",
    workspaceId: "b-ops",
    organizationId: "org-b",
    teamId: "team-b-ops",
    memberEpoch: 5,
    workspaceMemberEpoch: 1,
    companyGeneration: 4,
    teamGeneration: 1,
    capabilities: [],
  };
}

/** One held promise, released by hand — the interleavings are the test's to order. */
function held<T>() {
  let release!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function freshClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function generationOf(queryClient: QueryClient, userId: string): number {
  return queryClient.getQueryData<number>(tenantKeys.generation(userId)) ?? 0;
}

// ---------------------------------------------------------------------------
// 1. The preference window — a late intent settles without publishing (T03.05 R1-F1)
// ---------------------------------------------------------------------------

test("late_a_response_cannot_commit_after_b_selection", async () => {
  const queryClient = freshClient();
  const validationA = held<ValidatedSelection>();
  const preferenceStarted = held<void>();
  const preferenceSettled = held<void>();

  // Intent A: the ba-v1 switch toward scope A. Its validation is held, and its preference write
  // — the real network await — parks only once the coordinator has passed its post-validation
  // stale check.
  const intentA = switchWorkspaceScope(queryClient, LATE_USER, null, SCOPE_A, {
    authority: "ba-v1",
    validate: () => validationA.promise,
    setActiveOrganization: async () => {
      preferenceStarted.release();
      await preferenceSettled.promise;
    },
  });
  validationA.release(validatedA());
  await preferenceStarted.promise;

  // While A's preference write is on the wire, B is chosen and publishes IN FULL: a newer
  // explicit intent owns the session, and its publish is the one generation move.
  const settledB = await switchWorkspaceScope(
    queryClient,
    LATE_USER,
    null,
    SCOPE_B,
    {
      authority: "ba-v1",
      validate: async () => validatedB(),
      setActiveOrganization: () => undefined,
    },
  );
  expect(settledB.kind).toBe("published");
  expect(readCurrentSelection(queryClient, LATE_USER)).toEqual(SCOPE_B);
  const generationAfterB = generationOf(queryClient, LATE_USER);

  // From this marker on, ANY write the stale A generation makes is an old-generation write.
  let oldGenerationWrites = 0;
  const write = queryClient.setQueryData.bind(queryClient) as (
    key: unknown,
    updater: unknown,
    options?: unknown,
  ) => unknown;
  queryClient.setQueryData = ((key, updater, options) => {
    oldGenerationWrites += 1;
    return write(key, updater, options);
  }) as typeof queryClient.setQueryData;

  // A's preference write lands: the superseded intent must settle without publishing — no
  // resurrection of the scope B replaced, no generation move, no cache write.
  preferenceSettled.release();
  const settledA = await intentA;

  expect(settledA.kind).toBe("superseded");
  expect(oldGenerationWrites).toBe(0);
  expect(readCurrentSelection(queryClient, LATE_USER)).toEqual(SCOPE_B);
  expect(generationOf(queryClient, LATE_USER)).toBe(generationAfterB);
});

// ---------------------------------------------------------------------------
// 2. The cross-tab mirror — another tab's switch runs the whole discipline here
// ---------------------------------------------------------------------------

test("other_tab_switch_aborts_old_stream", () => {
  const queryClient = freshClient();
  const unbind = bindScopeStorageMirror(queryClient, TAB_USER);

  // A long stream opens under the epoch in force and carries its signal — the shape every
  // fetch-SSE or socket consumer opens against. It is alive while its epoch is.
  const oldStream = scopeAbortSignal(queryClient, TAB_USER);
  expect(oldStream.aborted).toBe(false);

  // The other tab commits B: its storage mirror moves, and THIS tab's bound mirror runs the full
  // switch — generation, caches, and the epoch. The old stream's signal aborts with it.
  storeSelection(TAB_USER, SCOPE_B);
  window.dispatchEvent(
    new StorageEvent("storage", {
      key: selectionStorageKey(TAB_USER),
      newValue: JSON.stringify(SCOPE_B),
    }),
  );

  expect(oldStream.aborted).toBe(true);
  // A stream opened NOW opens against the fresh epoch: live, never a dead signal.
  expect(scopeAbortSignal(queryClient, TAB_USER).aborted).toBe(false);
  expect(readCurrentSelection(queryClient, TAB_USER)).toEqual(SCOPE_B);
  unbind();
});

test("another_tab_s_switch_stales_this_tab_s_in_flight_intent", async () => {
  const queryClient = freshClient();
  const unbind = bindScopeStorageMirror(queryClient, TAB_USER);
  const validationA = held<ValidatedSelection>();

  // This tab's explicit intent toward A is in flight, parked in its validation.
  const intentA = switchWorkspaceScope(queryClient, TAB_USER, null, SCOPE_A, {
    authority: "ba-v1",
    validate: () => validationA.promise,
    setActiveOrganization: () => undefined,
  });

  // The other tab commits B while A waits. A person acted — in another tab — so this session's
  // in-flight intent is stale: B publishes here, and A must not overwrite it.
  storeSelection(TAB_USER, SCOPE_B);
  window.dispatchEvent(
    new StorageEvent("storage", {
      key: selectionStorageKey(TAB_USER),
      newValue: JSON.stringify(SCOPE_B),
    }),
  );
  expect(readCurrentSelection(queryClient, TAB_USER)).toEqual(SCOPE_B);

  validationA.release(validatedA());
  const settledA = await intentA;

  expect(settledA.kind).toBe("superseded");
  expect(readCurrentSelection(queryClient, TAB_USER)).toEqual(SCOPE_B);
  unbind();
});

// ---------------------------------------------------------------------------
// 3. The intent discipline — an in-place confirmation is still a person's act (T03.05 R1-F2)
// ---------------------------------------------------------------------------

test("an_in_place_confirmation_still_burns_the_session_s_intent", async () => {
  const queryClient = freshClient();

  // A silent session whose only explicit act is confirming "no scope" — the leave half of the
  // coordinator with nothing to leave. Nothing publishes; the act still happened.
  const settled = await switchWorkspaceScope(
    queryClient,
    PLACE_USER,
    null,
    null,
  );
  expect(settled.kind).toBe("published");
  expect(readCurrentSelection(queryClient, PLACE_USER)).toBeNull();

  // A background active-company seed arrives afterwards: refused — a person chose, however
  // narrow the act looked.
  expect(adoptActivePreference(queryClient, PLACE_USER, SCOPE_A)).toBe(false);
  expect(readCurrentSelection(queryClient, PLACE_USER)).toBeNull();
});

// MT102 (Issue #145): the desktop's local state is partitioned by organization (and, inside one,
// by company and team), untrusted state is never guessed at, and personal state survives
// organizational deletions untouched. The Rust suites (cargo test credential_namespace /
// org_switch_cleanup) pin the on-disk namespaces and the cleanup; this suite pins the renderer's
// own store — the same discipline, applied to the webview's localStorage, whose partitions
// nothing had drawn before.

import { afterAll, afterEach, beforeAll, expect, test } from "../../tests/support/e2e-compat";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useState } from "react";

import {
  clearOrganizationState,
  clearPersonalState,
  type LocalScope,
  localStateKey,
  LOCAL_STATE_VERSION,
  readLocalState,
  writeLocalState,
} from "./OrgLocalState";

const STORAGE = () => window.localStorage;

const ORG_A: Extract<LocalScope, { kind: "organization" }> = {
  kind: "organization",
  authority: "https://acme.example",
  userId: "user-1",
  tenantId: "acme",
  workspaceId: "acme-finance",
};
const ORG_A_OPS: Extract<LocalScope, { kind: "organization" }> = {
  ...ORG_A,
  workspaceId: "acme-ops",
};
const ORG_B: Extract<LocalScope, { kind: "organization" }> = {
  kind: "organization",
  authority: "https://globex.example",
  userId: "user-1",
  tenantId: "globex",
  workspaceId: "globex-ops",
};
const PERSONAL: Extract<LocalScope, { kind: "personal" }> = {
  kind: "personal",
  userId: "user-1",
};

beforeAll(() => GlobalRegistrator.register());
afterEach(() => {
  cleanup();
  STORAGE().clear();
});
afterAll(() => GlobalRegistrator.unregister());

test("two organizations' local states are not readable from each other (AC1)", () => {
  writeLocalState(STORAGE(), ORG_A, "draft", "acme finance draft");
  writeLocalState(STORAGE(), ORG_A, "media-index", ["a1.png", "a2.png"]);
  writeLocalState(STORAGE(), ORG_B, "draft", "globex draft");

  expect(readLocalState(STORAGE(), ORG_A, "draft")).toEqual({
    status: "present",
    value: "acme finance draft",
  });
  // Organization B reads its own slot, never A's — different key, different subtree.
  expect(readLocalState(STORAGE(), ORG_B, "draft")).toEqual({
    status: "present",
    value: "globex draft",
  });
  // A slot only A wrote reads as absent for B, in both directions.
  expect(readLocalState(STORAGE(), ORG_B, "media-index")).toEqual({
    status: "absent",
  });
  expect(readLocalState(STORAGE(), ORG_A, "globex-only", )).toEqual({
    status: "absent",
  });
});

test("inside one organization, one team's state is not another team's (AC1)", () => {
  writeLocalState(STORAGE(), ORG_A, "draft", "finance draft");
  expect(readLocalState(STORAGE(), ORG_A_OPS, "draft")).toEqual({
    status: "absent",
  });
  writeLocalState(STORAGE(), ORG_A_OPS, "draft", "ops draft");
  expect(readLocalState(STORAGE(), ORG_A, "draft")).toEqual({
    status: "present",
    value: "finance draft",
  });
});

test("keys name the namespace, person, company and team (AC1)", () => {
  expect(localStateKey(ORG_A, "draft")).toBe(
    "openbot.local-state.v1:org:https://acme.example:user-1:acme:acme-finance:draft",
  );
  expect(localStateKey(PERSONAL, "model-pick")).toBe(
    "openbot.local-state.v1::personal:user-1:model-pick",
  );
});

test("corrupt, foreign-version and moved records are never interpreted (AC2)", () => {
  // Unparseable bytes at the slot.
  STORAGE().setItem(localStateKey(ORG_A, "draft"), "{not json");
  expect(readLocalState(STORAGE(), ORG_A, "draft")).toEqual({
    status: "corrupt",
  });

  // A record from a build this one does not know — its shape is not ours to guess.
  writeLocalState(STORAGE(), ORG_A, "draft", "fine");
  const raw = JSON.parse(
    STORAGE().getItem(localStateKey(ORG_A, "draft")) as string,
  ) as { version: number };
  raw.version = LOCAL_STATE_VERSION + 1;
  STORAGE().setItem(localStateKey(ORG_A, "draft"), JSON.stringify(raw));
  expect(readLocalState(STORAGE(), ORG_A, "draft")).toEqual({
    status: "corrupt",
  });

  // A record moved between scopes (or a colliding key): the embedded scope is the second wall.
  const moved = JSON.parse(
    STORAGE().getItem(localStateKey(ORG_A, "draft")) as string,
  ) as { version: number; scope: Record<string, unknown> };
  moved.version = LOCAL_STATE_VERSION;
  moved.scope = {
    ...moved.scope,
    authority: ORG_B.authority,
    tenantId: ORG_B.tenantId,
  };
  STORAGE().setItem(localStateKey(ORG_A, "draft"), JSON.stringify(moved));
  expect(readLocalState(STORAGE(), ORG_A, "draft")).toEqual({
    status: "corrupt",
  });
  // And the scope it was moved INTO does not thereby gain the value.
  expect(readLocalState(STORAGE(), ORG_B, "draft")).toEqual({
    status: "absent",
  });
});

test("expired state degrades to re-choose, never to its old value (AC2)", () => {
  writeLocalState(
    STORAGE(),
    ORG_A,
    "handoff",
    "acme handoff",
    { expiresAtMs: 1_000, nowMs: 0 },
  );
  expect(readLocalState(STORAGE(), ORG_A, "handoff", 2_000)).toEqual({
    status: "expired",
  });
  // Not expired yet, it is live state again — expiry is about time, not about the slot.
  expect(readLocalState(STORAGE(), ORG_A, "handoff", 999)).toEqual({
    status: "present",
    value: "acme handoff",
  });
});

test("clearing one organization leaves the other and the personal namespace alone (AC3)", () => {
  writeLocalState(STORAGE(), ORG_A, "draft", "a");
  writeLocalState(STORAGE(), ORG_A_OPS, "draft", "a-ops");
  writeLocalState(STORAGE(), ORG_B, "draft", "b");
  writeLocalState(STORAGE(), PERSONAL, "model-pick", "personal");

  expect(clearOrganizationState(STORAGE(), ORG_A.authority)).toBe(2);
  expect(readLocalState(STORAGE(), ORG_A, "draft")).toEqual({
    status: "absent",
  });
  expect(readLocalState(STORAGE(), ORG_A_OPS, "draft")).toEqual({
    status: "absent",
  });
  // The other organization's state, and the personal one, survive untouched.
  expect(readLocalState(STORAGE(), ORG_B, "draft")).toEqual({
    status: "present",
    value: "b",
  });
  expect(readLocalState(STORAGE(), PERSONAL, "model-pick")).toEqual({
    status: "present",
    value: "personal",
  });

  // And the mirror direction: clearing personal leaves every organization alone.
  expect(clearPersonalState(STORAGE(), PERSONAL.userId)).toBe(1);
  expect(readLocalState(STORAGE(), PERSONAL, "model-pick")).toEqual({
    status: "absent",
  });
  expect(readLocalState(STORAGE(), ORG_B, "draft")).toEqual({
    status: "present",
    value: "b",
  });
});

test("another user's slots are a different person's, in both namespaces (AC1/AC3)", () => {
  writeLocalState(STORAGE(), ORG_A, "draft", "user-1 draft");
  const otherUser = { ...ORG_A, userId: "user-2" };
  expect(readLocalState(STORAGE(), otherUser, "draft")).toEqual({
    status: "absent",
  });
  writeLocalState(STORAGE(), { kind: "personal", userId: "user-2" }, "model-pick", "theirs");
  expect(clearPersonalState(STORAGE(), "user-1")).toBe(0);
  expect(
    readLocalState(STORAGE(), { kind: "personal", userId: "user-2" }, "model-pick"),
  ).toEqual({ status: "present", value: "theirs" });
});

/*
 * A surface in miniature, so the safe-degrade rule is pinned as behavior and not only as a
 * status: the pad restores its draft on mount, and a slot it cannot trust comes back as "choose
 * again" — never as the old value, never as silence.
 */
function DraftPad({ scope }: { scope: LocalScope }) {
  const [restored, setRestored] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  useEffect(() => {
    const read = readLocalState(STORAGE(), scope, "draft");
    if (read.status === "present") {
      setRestored("restored");
      setDraft(String(read.value));
    } else if (read.status === "absent") {
      setRestored("nothing");
    } else {
      setRestored("choose again");
    }
  }, [scope]);
  return (
    <div>
      <span data-testid="restored">{restored ?? "reading"}</span>
      <input
        aria-label="Draft"
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
          writeLocalState(STORAGE(), scope, "draft", event.target.value);
        }}
      />
    </div>
  );
}

test("a draft restores for its own scope, is absent for the other org, and degrades safely when corrupt", async () => {
  writeLocalState(STORAGE(), ORG_A, "draft", "acme draft");

  const acme = render(<DraftPad scope={ORG_A} />);
  await waitFor(() =>
    expect(within(acme.container).getByTestId("restored").textContent).toBe(
      "restored",
    ),
  );
  expect(
    (within(acme.container).getByLabelText("Draft") as HTMLInputElement).value,
  ).toBe("acme draft");
  acme.unmount();

  // The other organization's pad starts empty: A's draft never bleeds through.
  const globex = render(<DraftPad scope={ORG_B} />);
  await waitFor(() =>
    expect(within(globex.container).getByTestId("restored").textContent).toBe(
      "nothing",
    ),
  );
  expect(
    (within(globex.container).getByLabelText("Draft") as HTMLInputElement).value,
  ).toBe("");
  globex.unmount();

  // A corrupt slot is not the draft and not silence — the surface asks for it again.
  STORAGE().setItem(localStateKey(ORG_A, "draft"), "{corrupted");
  const damaged = render(<DraftPad scope={ORG_A} />);
  await waitFor(() =>
    expect(
      within(damaged.container).getByTestId("restored").textContent,
    ).toBe("choose again"),
  );
  expect(
    (within(damaged.container).getByLabelText("Draft") as HTMLInputElement).value,
  ).toBe("");
  // Typing again overwrites the damage — the re-choose path really recovers.
  await act(async () => {
    await userEvent.type(
      within(damaged.container).getByLabelText("Draft"),
      "fresh draft",
    );
  });
  expect(readLocalState(STORAGE(), ORG_A, "draft")).toEqual({
    status: "present",
    value: "fresh draft",
  });
});

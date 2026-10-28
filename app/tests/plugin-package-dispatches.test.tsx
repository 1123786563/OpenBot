import "./preload";
// app/tests/plugin-package-dispatches.test.tsx
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type {
  PackageDispatchInspectionDTO,
  PackageDispatchSummaryDTO,
} from "../../shared/enterprise/plugin-package-contracts";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "../../tests/support/e2e-compat";
import { PackageDispatchesSection } from "../src/components/market/package-dispatches";
import i18n from "../src/lib/i18n";

/**
 * The PKG10 dispatch ledger of the install detail.
 *
 * WHAT THESE CASES HOLD. An unknown-effect call says so, names the vendor's
 * limit honestly ("no way to look it up, never sent again") and shows what the
 * call is bound to. While no verified vendor query protocol exists the screen
 * offers no verification action and no retry action — the only honest state.
 * When the inspection says a protocol exists, exactly one POST goes to the
 * verify endpoint (path-only: nothing for a client to choose), and the result
 * is stated as a fact. A settled call shows its receipt, and a blocked
 * recovery names the gate that refused.
 *
 * Same native harness as the other plugin-package suites: happy-dom per file,
 * a fetch stub that records path/headers/body, one retry-free QueryClient,
 * `settle` as the act boundary.
 */

const SCOPE = {
  tenantId: "tenant-a",
  workspaceId: "workspace-a",
  principalId: "user-1",
};
const DIGEST = "c".repeat(64);
const NOW = "2026-10-25T00:00:00.000Z";
const OPERATION = "01234567-89ab-4cde-8f01-234567890abc";

function summary(
  state: PackageDispatchSummaryDTO["state"],
  suffix = "",
): PackageDispatchSummaryDTO {
  return {
    operationId: suffix ? `${OPERATION.slice(0, -1)}${suffix}` : OPERATION,
    runId: "01234567-89ab-4cde-8f01-234567890abd",
    attemptGeneration: 1,
    toolCallId: "call-1",
    installId: "install-1",
    resourceId: "notes",
    toolRef: suffix ? `notes:write_note_${suffix}` : "notes:write_note",
    effect: "write",
    state,
    receiptRef:
      state === "succeeded"
        ? { effectStatus: "confirmed" }
        : { effectStatus: "unknown" },
    errorCode: state === "unknown" ? "DISPATCH_TRANSPORT_ERROR" : null,
    createdAt: NOW,
    completedAt: NOW,
  };
}

let inspection: PackageDispatchInspectionDTO;
let listed: PackageDispatchSummaryDTO[];
let verifyRequests: Array<{
  method: string;
  path: string;
  body: string | null;
}>;
let verifyAnswer: { status: number; body: unknown };
const originalFetch = global.fetch;

beforeAll(() => GlobalRegistrator.register());
afterEach(() => {
  cleanup();
  void i18n.changeLanguage("en");
});
afterAll(() => GlobalRegistrator.unregister());

beforeEach(() => {
  listed = [summary("unknown")];
  inspection = {
    dispatch: summary("unknown"),
    evidence: {
      connectionId: "conn-1",
      accountHandle: "acct-1",
      connectorInstallId: "connector-1",
      argsDigest: DIGEST,
      connectionGeneration: 1,
    },
    verification: {
      kind: "unknown",
      canQueryVendor: false,
      noAutoResendReason: "NO_VENDOR_QUERY_PROTOCOL",
      relatedReceipts: [],
    },
    recovery: { ready: true },
  };
  verifyRequests = [];
  verifyAnswer = {
    status: 200,
    body: { outcome: "verified", dispatch: summary("succeeded") },
  };
  window.localStorage.clear();
  global.fetch = Object.assign(
    async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const url = new URL(String(input), "http://localhost");
      const path = url.pathname;
      if (
        path === "/api/enterprise/plugin-packages/installs/install-1/dispatches"
      ) {
        return new Response(JSON.stringify({ dispatches: listed }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (
        path ===
        `/api/enterprise/plugin-packages/installs/install-1/dispatches/${OPERATION}`
      ) {
        return new Response(JSON.stringify(inspection), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (
        path ===
        `/api/enterprise/plugin-packages/installs/install-1/dispatches/${OPERATION}/verify`
      ) {
        verifyRequests.push({
          method: init?.method ?? "GET",
          path,
          body: typeof init?.body === "string" ? init.body : null,
        });
        return new Response(JSON.stringify(verifyAnswer.body), {
          status: verifyAnswer.status,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(null, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
});

function renderSection() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <PackageDispatchesSection
        scope={SCOPE}
        install={{
          installId: "install-1",
          packageKey: "release-labs/notes-writer",
          version: "1.0.0",
          artifactDigest: DIGEST,
          revision: 1,
          generation: 1,
          status: "enabled",
          readiness: "ready",
          blockers: [],
          allowedActions: [],
        }}
      />
    </QueryClientProvider>,
  );
}

async function settle(check: () => void, turns = 80): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    try {
      check();
      return;
    } catch {
      // retry until the query settles or the turns run out
    }
  }
  check();
}

test("an unknown call states the honest limit and never offers a retry", async () => {
  const view = renderSection();
  await settle(() => {
    expect(view.getByText("Effect unknown")).toBeDefined();
    expect(view.getByText("notes:write_note")).toBeDefined();
  });
  fireEvent.click(view.getByText("notes:write_note"));
  await settle(() => {
    expect(
      view.getByText(
        "This call's effect can't be checked yet. The vendor offers no way to look it up, and OpenBot won't send it again.",
      ),
    ).toBeDefined();
  });
  // What the call is bound to: the original account and the argument digest.
  expect(view.getByText("acct-1")).toBeDefined();
  expect(view.getByText(DIGEST.slice(0, 8))).toBeDefined();
  // Recovery gate: green means a FOLLOW-UP can pass, never a resend.
  expect(
    view.getByText("You can continue. New calls re-check every condition."),
  ).toBeDefined();
  expect(
    view.getByText("No settled receipts in this conversation yet."),
  ).toBeDefined();
  // No protocol: no verification action, and no retry action anywhere.
  expect(view.queryByRole("button", { name: "Check with the vendor" })).toBe(
    null,
  );
  expect(verifyRequests).toHaveLength(0);
});

test("a protocol-backed check sends one bodyless POST to the verify path and states the result", async () => {
  inspection.verification = {
    kind: "unknown",
    canQueryVendor: true,
    noAutoResendReason: "VENDOR_QUERY_UNRESOLVED",
    relatedReceipts: [summary("succeeded")],
  };
  const view = renderSection();
  await settle(() => {
    expect(view.getByText("Effect unknown")).toBeDefined();
  });
  fireEvent.click(view.getByText("notes:write_note"));
  await settle(() => {
    expect(view.getByText("Check with the vendor")).toBeDefined();
  });
  // The correlated receipt is visible evidence, not an invented result.
  expect(view.getByText("Receipts from the same conversation")).toBeDefined();
  expect(view.getByText("External effect confirmed")).toBeDefined();
  fireEvent.click(view.getByText("Check with the vendor"));
  await settle(() => {
    expect(verifyRequests).toHaveLength(1);
  });
  const request = verifyRequests[0];
  expect(request?.method).toBe("POST");
  expect(request?.body).toBeNull();
  await settle(() => {
    expect(
      view.getByText(
        "This call is now confirmed against the vendor's records.",
      ),
    ).toBeDefined();
  });
});

test("a settled call shows its receipt facts with no actions", async () => {
  listed = [summary("succeeded", "1"), summary("unknown")];
  inspection.dispatch = summary("succeeded", "1");
  inspection.verification = { kind: "definite" };
  inspection.recovery = null;
  const view = renderSection();
  await settle(() => {
    expect(view.getByText("Effect unknown")).toBeDefined();
  });
  fireEvent.click(view.getByText("notes:write_note"));
  await settle(() => {
    expect(view.getByText("External effect confirmed")).toBeDefined();
  });
  expect(view.queryByRole("button", { name: "Check with the vendor" })).toBe(
    null,
  );
});

test("a blocked recovery names the gate that refused", async () => {
  inspection.recovery = { ready: false, refusalCode: "NOT_AVAILABLE" };
  const view = renderSection();
  await settle(() => {
    expect(view.getByText("Effect unknown")).toBeDefined();
  });
  fireEvent.click(view.getByText("notes:write_note"));
  await settle(() => {
    expect(
      view.getByText(
        "Can't continue yet: NOT_AVAILABLE. Fix what it names before making the next call.",
      ),
    ).toBeDefined();
  });
});

test("the zh-CN copy covers the same facts", async () => {
  await i18n.changeLanguage("zh-CN");
  const view = renderSection();
  await settle(() => {
    expect(view.getByText("效果未确认")).toBeDefined();
  });
  fireEvent.click(view.getByText("notes:write_note"));
  await settle(() => {
    expect(
      view.getByText(
        "这条调用的效果还无法确认。供应商没有提供查询方式，OpenBot 也不会重发它。",
      ),
    ).toBeDefined();
  });
  expect(view.getByText("原账号")).toBeDefined();
  expect(view.getByText("参数摘要")).toBeDefined();
  expect(
    view.getByText("可以继续。新的调用会重新核对每一项条件。"),
  ).toBeDefined();
});

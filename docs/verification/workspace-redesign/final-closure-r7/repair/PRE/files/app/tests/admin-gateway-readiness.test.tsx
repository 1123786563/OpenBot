import "./preload";
import { afterAll, afterEach, beforeAll, expect, mock, test } from "../../tests/support/bun-test-compat";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18n from "@/lib/i18n";
import { settleReactWork } from "./settle-react-work";

/*
 * Bifrost 01.8 (#214): the administrator's gateway screen. What the screen owes
 * — before any styling question — is exactly what this file pins:
 *
 * - a NOT-ready gateway names every blocking reason, never one blur of
 *   "failed";
 * - a ready gateway says so, with the configVersion, the rate and the
 *   credential's fingerprint — and no plaintext key anywhere in the DOM;
 * - the save actions (endpoint, rate, credential) refresh what the page shows,
 *   including the new server-assigned versions;
 * - the re-probe action reports the classified result, and readiness follows
 *   the state the server reports — the page never guesses a verdict of its
 *   own.
 *
 * The network is a stub with one mutable deployment state, so each test stages
 * the server answers and the page is asserted against what a real server would
 * have answered (the route contracts themselves are pinned server-side, in
 * server/tests/gateway-admin-routes.test.ts).
 */

mock.module("@/components/ui/dialog", () => {
  const pass = ({ children }: { children?: React.ReactNode }) =>
    children ?? null;
  return {
    Dialog: pass,
    DialogContent: pass,
    DialogHeader: pass,
    DialogBody: pass,
    DialogFooter: pass,
    DialogTitle: ({ children }: { children?: React.ReactNode }) => (
      <h2>{children}</h2>
    ),
    DialogDescription: ({ children }: { children?: React.ReactNode }) => (
      <p>{children}</p>
    ),
    DialogClose: pass,
    DialogOverlay: pass,
    DialogPortal: pass,
    DialogTrigger: pass,
  };
});

const { Route } = await import("@/routes/_authed/admin/gateway");

beforeAll(async () => {
  GlobalRegistrator.register();
  await i18n.changeLanguage("en");
});
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});
afterAll(async () => {
  await settleReactWork();
  void i18n.changeLanguage("en");
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;

const SECRET_KEY = `plain-admin-key-${"0123456789abcdef"}-DO-NOT-ECHO`;

type Deployment = {
  readiness: {
    ready: boolean;
    blockingReasons: string[];
    configVersion: number;
    checkedAt: string;
  };
  endpoint: {
    baseUrl: string;
    requestTimeoutMs: number;
    configVersion: number;
  } | null;
  credential:
    | { state: "configured"; configVersion: number; fingerprint: string; updatedAt: string }
    | { state: "unconfigured" };
  probe: {
    status: string;
    reasonCode: string;
    checkedAt: string;
    configVersion: number;
    durationMs: number;
  } | null;
  extension: {
    creditAdmissionExtension: string;
    extensionVersion: string | null;
    reasonCode: string;
    supportedRange: string | null;
    checkedAt: string;
    configVersion: number;
  } | null;
  rate:
    | {
        configured: true;
        numerator: string;
        denominator: string;
        rateVersion: number;
        source: string;
      }
    | { configured: false; reason: string; explanation: string };
};

const ALL_BLOCKED: Deployment = {
  readiness: {
    ready: false,
    blockingReasons: [
      "gateway_readiness_endpoint_not_configured",
      "gateway_readiness_credential_not_configured",
      "gateway_readiness_probe_missing",
      "gateway_readiness_extension_not_negotiated",
      "gateway_readiness_rate_not_configured",
    ],
    configVersion: 0,
    checkedAt: "2026-10-17T08:00:00.000Z",
  },
  endpoint: null,
  credential: { state: "unconfigured" },
  probe: null,
  extension: null,
  rate: {
    configured: false,
    reason: "not_configured",
    explanation: "The USD→credits conversion rate is not configured.",
  },
};

/** A deployment whose every condition holds, as the server would answer it. */
function readyDeployment(baseUrl: string): Deployment {
  return {
    readiness: {
      ready: true,
      blockingReasons: [],
      configVersion: 2,
      checkedAt: "2026-10-17T09:00:00.000Z",
    },
    endpoint: {
      baseUrl,
      requestTimeoutMs: 10_000,
      configVersion: 2,
    },
    credential: {
      state: "configured",
      configVersion: 1,
      fingerprint: "f1ng3rpr1nt",
      updatedAt: "2026-10-17T08:30:00.000Z",
    },
    probe: {
      status: "ok",
      reasonCode: "gateway_probe_ok",
      checkedAt: "2026-10-17T08:45:00.000Z",
      configVersion: 2,
      durationMs: 12,
    },
    extension: {
      creditAdmissionExtension: "present",
      extensionVersion: "1.0.0",
      reasonCode: "gateway_capability_extension_present",
      supportedRange: null,
      checkedAt: "2026-10-17T08:45:00.000Z",
      configVersion: 2,
    },
    rate: {
      configured: true,
      numerator: "100",
      denominator: "1",
      rateVersion: 3,
      source: "admin",
    },
  };
}

let deployment: Deployment;
let credentialSaves: string[];

function installFetchStub() {
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (method === "GET" && url === "/api/admin/gateway/status") {
      return json(deployment);
    }
    if (method === "PUT" && url === "/api/admin/gateway/endpoint") {
      const body = JSON.parse(String(init?.body)) as {
        baseUrl: string;
        requestTimeoutMs?: number;
      };
      const configVersion =
        (deployment.endpoint?.configVersion ?? 0) + 1;
      deployment = {
        ...deployment,
        endpoint: {
          baseUrl: body.baseUrl,
          requestTimeoutMs: body.requestTimeoutMs ?? 10_000,
          configVersion,
        },
      };
      deployment.readiness = {
        ...deployment.readiness,
        configVersion,
        blockingReasons: deployment.readiness.blockingReasons.filter(
          (reason) => reason !== "gateway_readiness_endpoint_not_configured",
        ),
      };
      return json({ endpoint: deployment.endpoint });
    }
    if (method === "PUT" && url === "/api/admin/gateway/rate") {
      const body = JSON.parse(String(init?.body)) as {
        numerator: string;
        denominator: string;
      };
      deployment = {
        ...deployment,
        rate: {
          configured: true,
          numerator: body.numerator,
          denominator: body.denominator,
          rateVersion: 3,
          source: "admin",
        },
      };
      return json({
        rate: {
          numerator: body.numerator,
          denominator: body.denominator,
          rateVersion: 3,
        },
      });
    }
    if (method === "PUT" && url === "/api/admin/gateway/credential") {
      const body = JSON.parse(String(init?.body)) as { adminKey: string };
      credentialSaves.push(body.adminKey);
      deployment = {
        ...deployment,
        credential: {
          state: "configured",
          configVersion: 1,
          fingerprint: "f1ng3rpr1nt",
          updatedAt: "2026-10-17T08:30:00.000Z",
        },
      };
      return json({ status: deployment.credential });
    }
    if (method === "POST" && url === "/api/admin/gateway/probe") {
      deployment = {
        ...deployment,
        probe: {
          status: "ok",
          reasonCode: "gateway_probe_ok",
          checkedAt: "2026-10-17T09:15:00.000Z",
          configVersion: deployment.readiness.configVersion,
          durationMs: 9,
        },
        extension: {
          creditAdmissionExtension: "present",
          extensionVersion: "1.0.0",
          reasonCode: "gateway_capability_extension_present",
          supportedRange: null,
          checkedAt: "2026-10-17T09:15:00.000Z",
          configVersion: deployment.readiness.configVersion,
        },
      };
      return json({
        probe: deployment.probe,
        negotiation: { negotiated: true, negotiation: deployment.extension },
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

async function renderGatewayPage() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const rootRoute = createRootRoute({
    component: Route.options.component,
  });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  await view.findByRole("heading", { name: "Model gateway" });
  return view;
}

test("a not-ready gateway names every blocking reason, not a blur", async () => {
  deployment = structuredClone(ALL_BLOCKED);
  installFetchStub();
  const view = await renderGatewayPage();
  const reasons = view.getByTestId("gateway-blocking-reasons");
  for (const sentence of [
    "No gateway address is configured",
    "No gateway admin credential is configured",
    "No successful gateway probe is on file",
    "No capability negotiation has completed",
    "The USD→credits conversion rate is not configured",
  ]) {
    expect(reasons.textContent).toContain(sentence);
  }
  expect(view.queryByText("Ready")).toBeNull();
});

test("a ready gateway shows ready, the configVersion, the rate and the fingerprint", async () => {
  deployment = readyDeployment("https://bifrost.internal");
  installFetchStub();
  const view = await renderGatewayPage();
  expect(view.getByText("Ready")).not.toBeNull();
  expect(view.getByTestId("gateway-config-version").textContent).toContain("2");
  expect(view.getByTestId("gateway-rate-current").textContent).toContain("100");
  expect(view.getByTestId("gateway-credential-status").textContent).toContain(
    "f1ng3rpr1nt",
  );
  // No plaintext anywhere: the server sent none, and the page displays none.
  expect(document.body.innerHTML).not.toContain("adminKey");
});

test("saving the endpoint, the rate and the credential refreshes what the page shows", async () => {
  deployment = structuredClone(ALL_BLOCKED);
  credentialSaves = [];
  installFetchStub();
  const view = await renderGatewayPage();

  // The endpoint: type the address, save, and the saved address + its version appear.
  // TYPED RATHER THAN SET — the input reads keystrokes, not dispatched change
  // events (connection-fields.test.tsx documents the same trap).
  await userEvent.type(view.getByLabelText("Gateway address"), "https://bifrost.internal");
  fireEvent.click(view.getByRole("button", { name: "Save address" }));
  await waitFor(() =>
    expect(
      view.getByTestId("gateway-endpoint-saved").textContent,
    ).toContain("https://bifrost.internal"),
  );
  await waitFor(() =>
    expect(view.getByTestId("gateway-config-version").textContent).toContain(
      "1",
    ),
  );

  // The rate: save 100 credits per USD, and the current rate appears.
  await userEvent.type(
    view.getByLabelText("Credits per 1 USD (numerator)"),
    "100",
  );
  await userEvent.type(view.getByLabelText("Credits scale (denominator)"), "1");
  fireEvent.click(view.getByRole("button", { name: "Save rate" }));
  await waitFor(() =>
    expect(view.getByTestId("gateway-rate-current").textContent).toContain(
      "100",
    ),
  );

  // The credential: type the key, rotate, and the field is emptied — the page
  // never echoes it back; only the server's fingerprint remains.
  await userEvent.type(view.getByLabelText("Admin credential"), SECRET_KEY);
  fireEvent.click(view.getByRole("button", { name: "Save credential" }));
  await waitFor(() => expect(credentialSaves).toEqual([SECRET_KEY]));
  await waitFor(() =>
    expect(view.getByTestId("gateway-credential-status").textContent).toContain(
      "f1ng3rpr1nt",
    ),
  );
  const field = view.getByLabelText("Admin credential") as HTMLInputElement;
  expect(field.value).toBe("");
  expect(document.body.innerHTML).not.toContain(SECRET_KEY);
});

test("the re-probe action reports the classified answer and readiness follows", async () => {
  // Address and credential saved, rate missing: the probe can run, and the
  // page must show its answer while readiness stays blocked — by the rate,
  // and only by the rate.
  deployment = structuredClone(ALL_BLOCKED);
  deployment.readiness.blockingReasons = [
    "gateway_readiness_probe_missing",
    "gateway_readiness_extension_not_negotiated",
    "gateway_readiness_rate_not_configured",
  ];
  deployment.endpoint = {
    baseUrl: "https://bifrost.internal",
    requestTimeoutMs: 10_000,
    configVersion: 1,
  };
  deployment.credential = {
    state: "configured",
    configVersion: 1,
    fingerprint: "f1ng3rpr1nt",
    updatedAt: "2026-10-17T08:30:00.000Z",
  };
  installFetchStub();
  const view = await renderGatewayPage();

  fireEvent.click(view.getByRole("button", { name: "Run probe" }));
  await waitFor(() =>
    expect(view.getByTestId("gateway-probe-status").textContent).toContain(
      "ok",
    ),
  );
  await waitFor(() =>
    expect(view.getByTestId("gateway-extension-status").textContent).toContain(
      "present",
    ),
  );
  // Readiness still not ready — the rate is the one thing left.
  const reasons = view.getByTestId("gateway-blocking-reasons");
  expect(reasons.textContent).toContain(
    "The USD→credits conversion rate is not configured",
  );
  expect(reasons.textContent).not.toContain("No gateway address");
});

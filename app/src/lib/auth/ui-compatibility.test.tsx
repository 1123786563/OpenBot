import "../../../tests/preload";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, expect, test } from "../../../../tests/support/e2e-compat";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor } from "@testing-library/react";
import { useContext } from "react";
import type { ComponentType, ReactNode } from "react";

/*
 * T01.08 (#520): the fixed Better Auth UI source and the existing React providers.
 *
 * The Better Auth UI kit is vendored from one pinned, digest-verified source
 * (better-auth-ui 3.2.13 — the newest build whose bundle loads against the
 * server's better-auth 1.7.1), and its provider mounts inside the app's existing
 * Router and QueryClient: a second client or a second router would fork cache and
 * navigation state. The organization components of that source are exactly the
 * ones whose built-in reads hit the X-class native GET endpoints (interfaces
 * §3.2), so every one of them is declared in ui-source.json as adapter-injected
 * or not reused, and until an OpenBot adapter is registered none of them may
 * mount: nothing under this provider reaches those endpoints.
 *
 * The app modules are imported dynamically after happy-dom registers: the auth
 * client singleton is created at module scope and needs window.location, which
 * the native layer does not have while a test file's imports evaluate.
 */

type PinnedKit = typeof import("better-auth-ui");
type RegistryProvider = typeof import("../../components/auth/provider");
type UiProviderModule = typeof import("./ui-provider");

let pinned: PinnedKit;
let registry: RegistryProvider;
let ui: UiProviderModule;
let authClient: typeof import("./client")["authClient"];
let queryClient: typeof import("@/query-client")["queryClient"];

const REPO_ROOT = process.cwd();
const MANIFEST_PATH = join(REPO_ROOT, "app/src/lib/auth/ui-source.json");

/** The X-class native GETs the organization UI must never call directly (interfaces §3.2). */
const X_CLASS_ENDPOINTS = [
  "/organization/list",
  "/organization/list-user-teams",
  "/organization/get-invitation",
  "/organization/list-user-invitations",
  "/organization/get-role",
  "/organization/list-roles",
];

/** Organization components the pinned source exports; each needs a declaration. */
const PINNED_ORGANIZATION_EXPORTS = [
  "AcceptInvitationCard",
  "CreateOrganizationDialog",
  "DeleteOrganizationCard",
  "OrganizationCellView",
  "OrganizationInvitationsCard",
  "OrganizationLogo",
  "OrganizationLogoCard",
  "OrganizationMembersCard",
  "OrganizationNameCard",
  "OrganizationRefetcher",
  "OrganizationSettingsCards",
  "OrganizationSlugCard",
  "OrganizationSwitcher",
  "OrganizationView",
  "OrganizationsCard",
  "UserInvitationsCard",
  "useCurrentOrganization",
];

function readManifest(): Record<string, unknown> {
  return JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
}

/** The providers' tree as main.tsx mounts it: one query client, the app router. */
function mountUnderExistingProviders(node: ReactNode) {
  const rootRoute = createRootRoute({
    component: () => <Outlet />,
  });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => node,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

beforeAll(async () => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  [pinned, registry, ui] = await Promise.all([
    import("better-auth-ui"),
    import("../../components/auth/provider"),
    import("./ui-provider"),
  ]);
  ({ authClient } = await import("./client"));
  ({ queryClient } = await import("../../query-client"));
});

afterEach(() => {
  cleanup();
  queryClient.clear();
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

test("auth_ui_uses_existing_router_and_query_provider", async () => {
  const seenClients = new Set<unknown>();
  let sawAuthUI: { authClient?: unknown } | null | undefined;

  function Probe() {
    seenClients.add(useQueryClient());
    sawAuthUI = useContext(pinned.AuthUIContext);
    return null;
  }

  mountUnderExistingProviders(
    <ui.OpenBotAuthProvider>
      <Probe />
    </ui.OpenBotAuthProvider>,
  );

  await waitFor(() => {
    expect(sawAuthUI).not.toBeNull();
  });

  // The pinned Better Auth UI context is mounted by the OpenBot provider...
  expect(sawAuthUI?.authClient).toBe(authClient);
  // ...and it rides the app's one query client instead of mounting its own.
  const queryClientCount = seenClients.size;
  expect(queryClientCount).toBe(1);
  expect([...seenClients][0]).toBe(queryClient);
});

test("incompatible_or_unpinned_registry_is_rejected", () => {
  const manifest = readManifest();

  // In-memory: a manifest without a source digest is rejected outright.
  const unpinned = structuredClone(manifest);
  delete (unpinned as { source?: { digest?: string } }).source?.digest;
  const missingDigest = ui.verifyUiSource(unpinned);
  expect(missingDigest.ok).toBe(false);
  expect(missingDigest.errors.join(" ")).toContain("digest");

  // And a version range where a pin belongs is just as refused.
  const ranged = structuredClone(manifest);
  const rangedSource = (ranged as { source?: { version?: string } }).source;
  if (rangedSource) rangedSource.version = "^3.2.13";
  const rangedVerdict = ui.verifyUiSource(ranged);
  expect(rangedVerdict.ok).toBe(false);

  // Process level: the same check as a command fails on an unpinned or
  // hash-mismatched registry, and passes on the committed one.
  const scratch = mkdtempSync(join(tmpdir(), "t0108-ui-source-"));
  const check = (fixturePath: string) =>
    spawnSync("bun", ["-e", CHECK_SCRIPT], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        OPENBOT_UI_CHECK_ROOT: REPO_ROOT,
        OPENBOT_UI_CHECK_MANIFEST: fixturePath,
      },
    });

  const unpinnedPath = join(scratch, "unpinned.json");
  writeFileSync(unpinnedPath, JSON.stringify(unpinned));

  const corrupted = structuredClone(manifest);
  const vendored = (corrupted as { vendored?: { sha256: string }[] }).vendored;
  const first = vendored?.[0];
  if (first) {
    first.sha256 = first.sha256.replace(/^.{2}/, "00");
  }
  const corruptedPath = join(scratch, "corrupted.json");
  writeFileSync(corruptedPath, JSON.stringify(corrupted));

  const unpinnedCheck = check(unpinnedPath);
  expect(unpinnedCheck.status).not.toBe(0);

  const corruptedCheck = check(corruptedPath);
  expect(corruptedCheck.status).not.toBe(0);

  // The committed manifest itself must stay acceptable to the same check.
  const committedCheck = check(MANIFEST_PATH);
  expect(committedCheck.status).toBe(0);
});

test("organization_components_do_not_call_x_class_endpoints", async () => {
  const manifest = readManifest();
  const declarations = (manifest.organization ?? {}) as Record<
    string,
    { reuse?: string }
  >;

  // Every organization component the pinned source can render is declared,
  // so no undeclared one can slip into the tree by omission.
  const declaredNames = Object.keys(declarations);
  for (const name of PINNED_ORGANIZATION_EXPORTS) {
    expect(declaredNames).toContain(name);
    expect(["inject-openbot-adapter", "not-reused"]).toContain(
      declarations[name]?.reuse,
    );
  }

  // No adapter is registered yet (they arrive with T01.09), so through this
  // provider the switcher and the members card mount nothing at all — and
  // the mounted tree never reaches an X-class endpoint.
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    return new Response(JSON.stringify({ data: null }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const { container } = mountUnderExistingProviders(
      <ui.OpenBotAuthProvider>
        <div data-testid="switcher-slot">
          <registry.FixedUiOrganization
            name="OrganizationSwitcher"
            component={
              pinned.OrganizationSwitcher as unknown as ComponentType<unknown>
            }
          />
        </div>
        <div data-testid="members-slot">
          <registry.FixedUiOrganization
            name="OrganizationMembersCard"
            component={
              pinned.OrganizationMembersCard as unknown as ComponentType<unknown>
            }
          />
        </div>
      </ui.OpenBotAuthProvider>,
    );

    // The router mounts asynchronously: wait for the slots themselves before
    // asserting what the gate left inside them.
    await waitFor(() => {
      expect(
        container.querySelector("[data-testid='switcher-slot']"),
      ).not.toBeNull();
      expect(
        container.querySelector("[data-testid='members-slot']"),
      ).not.toBeNull();
    });

    const switcherSlot = container.querySelector(
      "[data-testid='switcher-slot']",
    );
    const membersSlot = container.querySelector("[data-testid='members-slot']");
    expect(switcherSlot?.childElementCount).toBe(0);
    expect(membersSlot?.childElementCount).toBe(0);

    await waitFor(() => {
      expect(container.textContent).toBe("");
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  const xClassCalls = calls.filter((url) =>
    X_CLASS_ENDPOINTS.some((endpoint) => url.includes(endpoint)),
  );
  expect(xClassCalls).toEqual([]);
});

/**
 * The process-level registry check: structural validation through the provider's
 * own verifyUiSource, then byte-level pinning — every vendored file's sha256, the
 * installed better-auth-ui version, and the lockfile resolution must all match the
 * frozen manifest. Any error exits non-zero so CI and the audit can rely on it.
 */
const CHECK_SCRIPT = `
const fs = await import("node:fs");
const crypto = await import("node:crypto");
const { pathToFileURL } = await import("node:url");
const root = process.env.OPENBOT_UI_CHECK_ROOT;
const manifest = JSON.parse(
  fs.readFileSync(process.env.OPENBOT_UI_CHECK_MANIFEST, "utf8"),
);
const { verifyUiSource } = await import(
  pathToFileURL(root + "/app/src/lib/auth/ui-provider.tsx").href
);
const errors = [];
const structural = verifyUiSource(manifest);
if (!structural.ok) errors.push(...structural.errors);
for (const entry of manifest.vendored ?? []) {
  const bytes = fs.readFileSync(root + "/" + entry.path);
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== entry.sha256) {
    errors.push(entry.path + ": sha256 " + entry.sha256 + " != " + sha256);
  }
}
const installed = JSON.parse(
  fs.readFileSync(root + "/app/node_modules/better-auth-ui/package.json", "utf8"),
);
if (installed.version !== manifest.source.version) {
  errors.push(
    "installed better-auth-ui " + installed.version +
    " != manifest " + manifest.source.version,
  );
}
const lock = fs.readFileSync(root + "/bun.lock", "utf8");
if (!lock.includes("better-auth-ui@" + manifest.source.version)) {
  errors.push("bun.lock does not resolve better-auth-ui@" + manifest.source.version);
}
if (errors.length) {
  console.error(errors.join("; "));
  process.exit(1);
}
`;

import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { createRoot } from "react-dom/client";
import type { ListedRecorderConnection } from "@openbot/shared/recorder-api";
import type { ComponentType } from "react";
import { astryxScope } from "@/components/astryx-pilot/theme";
import { BrowserPage } from "@/components/browser/browser-page";
import {
  InactiveComputersSection,
  NetworkSection,
} from "@/components/admin/controls/computer-sections";
import { ComputersPage } from "@/components/manage/computers-page";
import { CredentialsPage } from "@/components/manage/credentials-page";
import { NewCredentialPage } from "@/components/manage/new-credential-page";
import { PasswordsPage } from "@/components/passwords/passwords-page";
import { queryClient } from "@/query-client";
import { Route as BrowsersRoute } from "@/routes/_authed/settings/browsers";
import { Route as ThisComputerRoute } from "@/routes/_authed/settings/this-computer";

/**
 * The device and credential pages, mounted whole for `device-pages-frame.test.tsx` in a real browser:
 * the pages are the app's own components, the server is stood in at `window.fetch`, the Recorder is a
 * stand-in at `window.chrome.runtime`, and OpenBot Desktop's IPC is at `window.__TAURI_INTERNALS__`.
 *
 * `?page=` picks one of the ten entries; `?edition=personal|team` what the server says the deployment is;
 * `?state=error|denied|changed` puts the page in a first read that fails (until `__recover`), a 403,
 * or a lost write. A MutationObserver records every class the page wears so the test can compile
 * the app's stylesheet for what actually drew, dialogs included.
 */

const params = new URLSearchParams(location.search);
const PAGE = params.get("page") ?? "browser";
const EDITION = params.get("edition") === "personal" ? "personal" : "team";
/**
 * What the server says on this load: `error` fails the page's first read once until the test says
 * the service is back (`__recover`), so a person's Retry has something to recover; `denied` answers
 * every read with 403; `changed` loses the write and reports the row changed, which is the
 * unconfirmed-outcome dialog.
 */
const STATE = params.get("state") ?? "ok";

/** The read a page leads with: the one that fails in `error`, and the one 403 denies. */
const PRIMARY: Record<string, string | undefined> = {
  browser: "/api/browser",
  browsers: "/api/recorder/connections",
  "computers-personal": "/api/computers/fleet",
  "computers-team": "/api/computers/fleet",
  credentials: "/api/admin/credentials",
  "new-credential": "/api/admin/credentials",
  passwords: "/api/passwords",
};

const EXTENSION_ID = "a".repeat(32);
/** The copy of the Recorder in the browser this page is open in. */
const THIS_COPY = "c".repeat(32);

const CAPABILITIES = {
  generativeUi: true,
  selfHostBanner: false,
  localEvaluation: EDITION === "personal",
  edition: EDITION,
};

const AGENTS = {
  agents: [
    { id: "personal-assistant", name: "Personal Assistant" },
    { id: "ops-bot", name: "Operations Bot" },
  ],
};

const iso = (minutesAgo: number) =>
  new Date(Date.now() - minutesAgo * 60_000).toISOString();

/** A long name in every column, for the phone-width wrap check. */
const LONG =
  "a notebook for the quarterly revenue reconciliation across every regional team";

const HOST_ACCESS = { connected: false, grants: [], pending: [] };

function personRow(index: number) {
  const name =
    index === 0
      ? "Marguerite-Elisabeth Oyelaran-Abernathy"
      : `person-${index}@acme-distribution.example.com`;
  return {
    computer: `person:employee-${index}`,
    kind: "person" as const,
    personId: `employee-${index}`,
    person: { name, email: `person-${index}@acme-distribution.example.com` },
    botId: index % 2 === 0 ? "ops-bot" : undefined,
    running: index % 3 !== 0,
    startedAt: index % 3 !== 0 ? iso(index * 7 + 3) : null,
    egress: "network policy filter",
    ...(index === 1 ? { updateAvailable: true } : {}),
  };
}

/** 24 devices, as the evidence run asks: enough rows that a page has to scroll and wrap. */
const TEAM_FLEET = {
  isolation: "per-person" as const,
  computers: Array.from({ length: 24 }, (_, index) => personRow(index)),
};

const PERSONAL_FLEET = {
  isolation: "shared" as const,
  computers: [
    {
      computer: "person:dev-local-user",
      kind: "person" as const,
      personId: "dev-local-user",
      person: { name: "dev@openbot.local", email: "dev@openbot.local" },
      botId: "personal-assistant",
      running: true,
      startedAt: iso(5),
      egress: "network policy filter",
    },
    {
      computer: "bot:person-5f0e3c1a9b7d4e2f8a6c0b1d3e5f7a9c",
      kind: "bot" as const,
      botId: "person-5f0e3c1a9b7d4e2f8a6c0b1d3e5f7a9c",
      running: true,
      startedAt: iso(11),
      egress: "network policy filter",
    },
  ],
};

const ENTERPRISE = {
  capabilities: [],
  settings: {
    ssoRequired: false,
    actionRecording: false,
    inactiveComputerDays: 30,
    modelAllowlist: { enabled: false, models: [] },
    mcpAllowlist: { enabled: false, servers: [] },
    skillSharing: false,
    proactiveDailyRuns: 24,
    modelSelection: false,
  },
  groups: [],
  network: [
    {
      scopeKind: "organization",
      scopeId: "",
      mode: "defaults_plus_allowlist",
      rules: [
        { type: "domain", value: "intranet.acme.example", ports: "8443" },
      ],
      locked: false,
      updatedBy: "admin@acme.test",
      updatedAt: "2026-11-01T00:00:00.000Z",
    },
  ],
  defaultDestinations: ["github.com", "registry.npmjs.org", "pypi.org"],
  mcpServers: [],
  builtInModel: "openai/gpt-5.6-terra",
  scim: {
    configured: false,
    connectionId: "directory",
    baseUrl: null,
    rotating: false,
  },
  otel: { configured: false },
  actionRecordRetentionDays: 90,
};

const CREDENTIALS = [
  {
    id: "cred-1",
    kind: "model",
    provider: "openai",
    keyId: "sk-live-1",
    metadata: {},
    revokedAt: null,
  },
  {
    id: "cred-2",
    kind: "connector",
    provider: "notion",
    keyId: "ncc-live-2",
    metadata: {},
    revokedAt: null,
  },
];

const SAVED_LOGINS = {
  passwordManager: true,
  logins: [
    {
      id: "login-1",
      origin: "accounts.revenue-operations.example.com",
      username: "marguerite.oyelaran-abernathy@acme-distribution.example.com",
      createdAt: iso(400),
      updatedAt: iso(300),
      lastUsedAt: iso(20),
    },
    {
      id: "login-2",
      origin: "intranet.acme.example",
      username: "person-2",
      createdAt: iso(500),
      updatedAt: iso(500),
      lastUsedAt: null,
    },
  ],
};

const RECORDINGS = {
  recordings: [
    {
      id: "rec-1",
      title: `Teach: ${LONG}`,
      recordedAt: iso(30),
      ended: "succeeded" as const,
      reason: null,
    },
    {
      id: "rec-2",
      title: "Download the invoices",
      recordedAt: iso(90),
      ended: "stopped" as const,
      reason: "The person pressed Stop.",
    },
  ],
  nextCursor: null,
};

const BROWSER_STATE = {
  open: false,
  tabs: [],
  available: true,
  shows: "native" as const,
  computerId: "person:dev-local-user",
};

let connections: ListedRecorderConnection[] = [
  {
    id: "conn-1",
    label: `Chrome on Mac · ${LONG}`,
    via: "web" as const,
    extensionId: EXTENSION_ID,
    installId: "d".repeat(32),
    createdAt: iso(200),
    lastUsedAt: iso(30),
    recording: false,
  },
  {
    id: "conn-2",
    label: "Microsoft Edge on the build machine",
    via: "desktop" as const,
    extensionId: EXTENSION_ID,
    installId: "e".repeat(32),
    createdAt: iso(600),
    lastUsedAt: null,
    recording: true,
  },
];

/** The target of the computer flows: the first row that has a Stop. */
const fleet = () => (EDITION === "personal" ? PERSONAL_FLEET : TEAM_FLEET);

const desktopStatus = {
  openbotRunning: true,
  openbotHeld: true,
  processes: [{ name: "openbot", memoryBytes: 120_000_000 }],
  containers: [{ name: "k3d-local-abc-server-0", memoryBytes: 1_200_000_000 }],
  intelligenceStack: "local-abc",
  intelligenceContainers: [
    { name: "k3d-local-abc-server-0", memoryBytes: 1_200_000_000 },
  ],
  engine: "docker",
  root: "/Users/me/OpenBot",
  appPort: 3010,
  version: "0.3.2",
  build: "v0.3.2 (b214c97e)",
};

const answers = (path: string): unknown => {
  if (path === "/api/capabilities") return CAPABILITIES;
  if (path === "/api/computers/fleet") {
    const now = fleet();
    // After the lost write, the row the confirmation came from has stopped: the latest status the
    // unconfirmed-outcome dialog shows. Before it, the fleet is exactly what was reviewed.
    return lostWrite
      ? {
          ...now,
          computers: now.computers.map((computer) =>
            computer.running
              ? { ...computer, running: false, startedAt: null }
              : computer,
          ),
        }
      : now;
  }
  if (path === "/api/host-access") return HOST_ACCESS;
  if (path.startsWith("/api/agents")) return AGENTS;
  if (path === "/api/admin/enterprise") return ENTERPRISE;
  if (path === "/api/admin/credentials") return { credentials: CREDENTIALS };
  // What holds a credential, read inside the revoke confirmation.
  if (path.startsWith("/api/admin/credentials/") && path.endsWith("/usage"))
    return {
      usage: {
        features: ["The workspace's model route"],
        bots: [{ id: "ops-bot", name: "Operations Bot" }],
      },
    };
  if (path === "/api/passwords") return SAVED_LOGINS;
  if (path === "/api/browser") return BROWSER_STATE;
  if (path === "/api/recorder/connections")
    return { connections, extensionIds: [EXTENSION_ID] };
  if (path.startsWith("/api/recorder/recordings")) return RECORDINGS;
  if (path === "/api/recorder/me") return { recording: false };
  return undefined;
};

/** Once the write is lost, the reads after it report the row stopped. */
let lostWrite = false;
/** The test turns the first-read failure off before pressing the page's Retry. */
let recovered = false;
(globalThis as { __recover?: () => void }).__recover = () => {
  recovered = true;
};

window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const path = String(input).split("?")[0] ?? "";
  const method = init?.method ?? "GET";
  if (STATE === "denied" && path !== "/api/capabilities")
    return Response.json({ error: "Read denied" }, { status: 403 });
  if (STATE === "error" && !recovered && path === PRIMARY[PAGE])
    return Response.json({ error: "Service unavailable" }, { status: 503 });
  if (method === "POST" && path === "/api/recorder/connect-codes")
    return Response.json({
      code: "obc_0123456789abcdef",
      expiresAt: iso(-5),
    });
  if (method === "POST" && path === "/api/computers/fleet") {
    if (STATE === "changed") {
      lostWrite = true;
      return Response.json({ error: "Response lost" }, { status: 503 });
    }
    // A success that changes nothing: the page's confirmation re-reads the fleet and compares it
    // with the row as reviewed, so a changed row is reported as "changed while reviewing".
    return Response.json({ saved: true });
  }
  if (method === "DELETE" && path.startsWith("/api/recorder/connections/")) {
    const id = path.split("/").pop();
    connections = connections.filter((connection) => connection.id !== id);
    return Response.json({ disconnected: true });
  }
  const answer = answers(path);
  if (answer === undefined)
    return Response.json({ error: `not served: ${path}` }, { status: 404 });
  return Response.json(answer);
}) as typeof fetch;

/** The Recorder in this browser: installed, not connected until Connect is pressed. */
(globalThis as { chrome?: unknown }).chrome = {
  runtime: {
    sendMessage: (
      _id: string,
      message: unknown,
      reply: (answer: unknown) => void,
    ) => {
      const type = (message as { type?: string } | null)?.type;
      const answer =
        type === "openbot.ping"
          ? { ok: true }
          : type === "openbot.connect"
            ? (() => {
                connections = [
                  {
                    id: "conn-new",
                    label: "Chrome in this browser",
                    via: "web" as const,
                    extensionId: EXTENSION_ID,
                    installId: THIS_COPY,
                    createdAt: iso(0),
                    lastUsedAt: null,
                    recording: false,
                  },
                  ...connections,
                ];
                return { ok: true, connected: true, installId: THIS_COPY };
              })()
            : { ok: false, error: "invalid" };
      setTimeout(() => reply(answer), 0);
    },
  },
};

/** OpenBot Desktop's IPC: what runs here, its version, and Intelligence's readiness. */
(globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
  invoke: async (command: string) => {
    // This page's data comes over IPC, not HTTP: its first read fails the same way.
    if (
      STATE === "error" &&
      !recovered &&
      command === "plugin:openbot-desktop|status"
    )
      throw new Error("status unavailable");
    if (command === "plugin:openbot-desktop|status") return desktopStatus;
    if (command === "plugin:openbot-desktop|update_offer")
      return {
        version: null,
        current: "0.3.2",
        installing: null,
        updatesItself: true,
        ready: null,
      };
    if (command === "plugin:openbot-desktop|intelligence")
      return { readiness: "ready" };
    throw new Error(`command ${command} not found`);
  },
  transformCallback: () => 0,
};

function page() {
  switch (PAGE) {
    case "browser":
      return <BrowserPage />;
    case "browsers": {
      const Page = BrowsersRoute.options.component as ComponentType;
      return <Page />;
    }
    case "this-computer": {
      const Page = ThisComputerRoute.options.component as ComponentType;
      return <Page />;
    }
    case "computers-personal":
      return <ComputersPage />;
    case "computers-team":
      return (
        <ComputersPage>
          <InactiveComputersSection />
          <NetworkSection />
        </ComputersPage>
      );
    case "credentials":
      return <CredentialsPage />;
    case "new-credential":
      return <NewCredentialPage />;
    case "passwords":
      return <PasswordsPage />;
    default:
      throw new Error(`no page ${PAGE}`);
  }
}

// The app's own client: the pages' writes invalidate through this singleton, so a stand-in client
// would leave every refetch a write asks for undone.
queryClient.setDefaultOptions({
  queries: { retry: false, refetchOnWindowFocus: false },
});

/** Every class the page wears, dialogs included, for the test to compile the app's stylesheet for. */
const classes = new Set<string>();
const record = (node: Node) => {
  if (!(node instanceof Element)) return;
  for (const name of node.classList) classes.add(name);
  for (const element of node.querySelectorAll("[class]"))
    for (const name of element.classList) classes.add(name);
};
new MutationObserver((records) => {
  for (const mutation of records) {
    if (mutation.type === "attributes") record(mutation.target as Node);
    else for (const node of mutation.addedNodes) record(node);
  }
}).observe(document.documentElement, {
  attributes: true,
  attributeFilter: ["class"],
  childList: true,
  subtree: true,
});
(globalThis as { __drainClasses?: () => string[] }).__drainClasses = () => {
  for (const element of document.querySelectorAll("[class]"))
    for (const name of element.classList) classes.add(name);
  const drained = [...classes];
  classes.clear();
  return drained;
};

const router = createRouter({
  routeTree: createRootRoute({
    component: () => (
      <div {...astryxScope} className="flex min-h-0 min-w-0 flex-1 flex-col">
        {page()}
      </div>
    ),
  }),
  history: createMemoryHistory({ initialEntries: ["/"] }),
});

router.load().then(() => {
  const root = document.getElementById("root");
  if (!root) throw new Error("no root");
  createRoot(root).render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
});

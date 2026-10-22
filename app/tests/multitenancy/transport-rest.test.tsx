import "../preload";
import {
  afterEach,
  describe,
  expect,
  test,
} from "../../../tests/support/bun-test-compat";
import {
  client,
  clientUpload,
  SCOPE_HEADER_ALLOWED_PATHS,
  tryClient,
} from "../../src/lib/client";
import { uploadFile as craftUploadFile } from "../../src/lib/craft/client";
import { uploadWorkshopFiles } from "../../src/lib/workshop/client";
import { uploadToChannel } from "../../src/components/channels/composer/attachments";
import {
  GLOBAL_EXCEPTION_ENTRIES,
  matchGlobalException,
} from "../../../server/src/enterprise/tenancy/global-exceptions";

/**
 * MT081 / Issue #124: the web client's REST, upload and download-issuance transport carries the
 * company/team selection uniformly — one attach logic (AC3), only on reviewed same-origin
 * business paths (AC1), never anywhere else (AC2), with the allowed-path inventory cross-checked
 * against the server's MT030 global-exception registry (AC4).
 *
 * THE HARNESS IS FETCH INTERCEPTION, as in `selection.test.tsx` §7: the transport is what is
 * under test, so no route is rendered and no server is stood up — the stubbed `fetch` answers
 * and the request's own shape is the evidence. AC1/AC2 for the REST half were first pinned in
 * `selection.test.tsx`; this file is the ticket's named verification surface and consolidates
 * the four acceptance criteria, including the upload/download half that file never touched.
 *
 * AC3's "不各自实现" (no separate implementation) is pinned two ways: `clientUpload` — the
 * multipart half the four upload surfaces now leave the browser through — attaches through the
 * SAME exported inventory `send` attaches through (the upload cases below exercise the very
 * list the AC4 cross-check reads), and the real upload surfaces (craft, workshop, channels)
 * are driven end-to-end against a stubbed fetch to show their requests leave through that one
 * transport, with no selection headers of their own on their not-yet-reviewed paths.
 *
 * THE DOWNLOAD BOUNDARY, stated plainly: fetch-based downloads and issuances (the export
 * artifact read, the craft preview pass) already ride `client`/`tryClient` and are covered
 * below. Anchor navigations (`artifactUrl`, `workshopArtifactDownloadUrl`) cannot carry
 * headers at all — that is why signed downloads exist as their own ticket (#99/MT056), which
 * authorizes at the issuance point AND the access point; this file pins the fetch half only.
 */

type Asked = { input: RequestInfo | URL; init: RequestInit | undefined };

const originalFetch = global.fetch;
let asked: Asked[] = [];

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Serves every request with one canned answer, recording what was asked. */
function serve(body: unknown = { ok: true }, status = 200): void {
  asked = [];
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    asked.push({ input, init });
    return jsonResponse(status, body);
  }) as unknown as typeof fetch;
}

afterEach(() => {
  global.fetch = originalFetch;
});

function headerOf(
  init: RequestInit | undefined,
  name: string,
): string | undefined {
  const headers = init?.headers;
  if (headers === undefined || headers === null) return undefined;
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  return (headers as Record<string, string>)[name];
}

const SELECTORS = { tenantId: "acme", workspaceId: "acme-finance" } as const;

// ---------------------------------------------------------------------------
// AC1: real client calls carry the selection pair on reviewed business paths
// ---------------------------------------------------------------------------

describe("MT081 AC1 — REST carries the pair on reviewed paths (transport layer)", () => {
  test("a client call on a reviewed path carries both selection headers", async () => {
    serve();
    await client("/api/enterprise/v1/conversations", SELECTORS);

    expect(asked.length).toBe(1);
    expect(asked[0]?.input).toBe("/api/enterprise/v1/conversations");
    expect(headerOf(asked[0]?.init, "x-openbot-tenant")).toBe("acme");
    expect(headerOf(asked[0]?.init, "x-openbot-workspace")).toBe(
      "acme-finance",
    );
    // Authenticated transport: credentials ride every request the app makes.
    expect(asked[0]?.init?.credentials).toBe("include");
  });

  test("tryClient — the refusal-is-a-value half — attaches through the same logic", async () => {
    serve();
    await tryClient("/api/enterprise/v1/tenants", SELECTORS);

    expect(headerOf(asked[0]?.init, "x-openbot-tenant")).toBe("acme");
    expect(headerOf(asked[0]?.init, "x-openbot-workspace")).toBe(
      "acme-finance",
    );
  });

  test("a fetch-based download issuance carries the pair like any other read", async () => {
    serve();
    // The export artifact download's shape (ai-observability/exports.ts): a
    // detail URL the caller fetches rather than navigates to.
    await tryClient("/api/enterprise/v1/attachments/att-1/content", SELECTORS);
    expect(headerOf(asked[0]?.init, "x-openbot-tenant")).toBe("acme");
  });

  test("the pair attaches per request, only as far as it is selected", async () => {
    serve();
    await client("/api/enterprise/v1/conversations", { tenantId: "acme" });
    expect(headerOf(asked[0]?.init, "x-openbot-tenant")).toBe("acme");
    expect(headerOf(asked[0]?.init, "x-openbot-workspace")).toBeUndefined();

    await client("/api/enterprise/v1/conversations", {
      workspaceId: "acme-finance",
    });
    expect(headerOf(asked[1]?.init, "x-openbot-tenant")).toBeUndefined();
    expect(headerOf(asked[1]?.init, "x-openbot-workspace")).toBe(
      "acme-finance",
    );

    await client("/api/enterprise/v1/conversations");
    expect(asked[2]?.init?.headers).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// AC2: non-same-origin or unreviewed paths attach nothing (negative tests)
// ---------------------------------------------------------------------------

describe("MT081 AC2 — unreviewed and non-same-origin paths attach nothing", () => {
  test("an absolute URL on another origin never sees the pair", async () => {
    serve();
    await client(
      "https://evil.example/api/enterprise/conversations",
      SELECTORS,
    );
    expect(headerOf(asked[0]?.init, "x-openbot-tenant")).toBeUndefined();
    expect(headerOf(asked[0]?.init, "x-openbot-workspace")).toBeUndefined();
  });

  test("a protocol-relative URL names another origin too — no pair", async () => {
    serve();
    await client("//evil.example/api/enterprise/conversations", SELECTORS);
    expect(headerOf(asked[0]?.init, "x-openbot-tenant")).toBeUndefined();
  });

  test("a same-origin business path outside the reviewed inventory attaches nothing", async () => {
    serve();
    await client("/api/agents", SELECTORS);
    expect(headerOf(asked[0]?.init, "x-openbot-tenant")).toBeUndefined();
    expect(headerOf(asked[0]?.init, "x-openbot-workspace")).toBeUndefined();
  });

  test("a path registered as a global exception in MT030 never receives the pair", async () => {
    serve();
    // `/api/me` is a registered session-global exception (MT030 entry "me"):
    // the person's identity projection must not be company-scoped, so the
    // transport refuses to send the pair there even though it is /api/*.
    expect(matchGlobalException("GET", "/api/me")).not.toBeNull();
    await client("/api/me", SELECTORS);
    expect(headerOf(asked[0]?.init, "x-openbot-tenant")).toBeUndefined();
    expect(headerOf(asked[0]?.init, "x-openbot-workspace")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// AC3: uploads and download issuance ride the SAME attach logic
// ---------------------------------------------------------------------------

describe("MT081 AC3 — uploads ride the same attach logic, not their own", () => {
  test("an upload to a reviewed path carries the pair, as multipart, without our content-type", async () => {
    serve();
    const form = new FormData();
    form.append("file", new File(["bytes"], "a.txt", { type: "text/plain" }));
    await clientUpload("/api/enterprise/v1/attachments", form, SELECTORS);

    expect(asked.length).toBe(1);
    expect(asked[0]?.init?.method).toBe("POST");
    expect(asked[0]?.init?.credentials).toBe("include");
    expect(asked[0]?.init?.body).toBe(form);
    expect(headerOf(asked[0]?.init, "x-openbot-tenant")).toBe("acme");
    expect(headerOf(asked[0]?.init, "x-openbot-workspace")).toBe(
      "acme-finance",
    );
    // The multipart boundary is the fetch implementation's to name; a
    // transport-set content-type would clobber it.
    expect(headerOf(asked[0]?.init, "content-type")).toBeUndefined();
  });

  test("an upload to an unreviewed same-origin path attaches nothing — one inventory gates both halves", async () => {
    serve();
    const form = new FormData();
    form.append("file", new File(["bytes"], "a.txt", { type: "text/plain" }));
    await clientUpload("/api/channels/ch-1/attachments", form, SELECTORS);

    expect(headerOf(asked[0]?.init, "x-openbot-tenant")).toBeUndefined();
    expect(headerOf(asked[0]?.init, "x-openbot-workspace")).toBeUndefined();
    expect(asked[0]?.init?.credentials).toBe("include");
  });

  test("an upload to another origin attaches nothing", async () => {
    serve();
    const form = new FormData();
    await clientUpload(
      "https://evil.example/api/enterprise/v1/attachments",
      form,
      SELECTORS,
    );
    expect(headerOf(asked[0]?.init, "x-openbot-tenant")).toBeUndefined();
  });

  test("a surface's own protocol header rides along; the selection pair still cannot be overridden", async () => {
    serve();
    const form = new FormData();
    // The dictation surface's marker, carried as caller headers.
    await clientUpload("/api/audio/transcriptions", form, {
      headers: { "x-openbot-dictation": "1" },
    });
    expect(headerOf(asked[0]?.init, "x-openbot-dictation")).toBe("1");
    expect(headerOf(asked[0]?.init, "x-openbot-tenant")).toBeUndefined();

    // A caller "helpfully" naming the tenant header does not get a second
    // opinion: the transport's own selection wins on reviewed paths.
    await clientUpload("/api/enterprise/v1/attachments", form, {
      ...SELECTORS,
      headers: { "x-openbot-tenant": "evil" },
    });
    expect(headerOf(asked[1]?.init, "x-openbot-tenant")).toBe("acme");
  });

  test("the real upload surfaces leave through the one transport", async () => {
    // craft's and the composer's uploads validate their answers' shapes, so
    // the canned body carries both surfaces' fields.
    serve({
      filename: "notes.txt",
      path: "/attachments/notes.txt",
      size_bytes: 5,
      id: "att-1",
      name: "notes.txt",
      mimeType: "text/plain",
    });
    const file = new File(["bytes"], "notes.txt", { type: "text/plain" });

    // craft: POST /api/craft/sessions/:id/upload
    await craftUploadFile("session-1", file);
    expect(String(asked[0]?.input)).toBe(
      "/api/craft/sessions/session-1/upload",
    );
    expect(asked[0]?.init?.credentials).toBe("include");
    expect(asked[0]?.init?.body).toBeInstanceOf(FormData);
    // Its path is not yet in the reviewed inventory (MT125 lays the legacy
    // assembly), so today it sends no pair — decided by the same inventory,
    // not by a copy of the rule.
    expect(headerOf(asked[0]?.init, "x-openbot-tenant")).toBeUndefined();

    // workshop: POST /api/workshop/channels/:id/files/upload
    await uploadWorkshopFiles("ch-1", [file]);
    expect(String(asked[1]?.input)).toBe("/api/workshop/ch-1/files/upload");
    expect(asked[1]?.init?.credentials).toBe("include");
    expect(asked[1]?.init?.body).toBeInstanceOf(FormData);
    expect(headerOf(asked[1]?.init, "x-openbot-tenant")).toBeUndefined();

    // channels composer: POST /api/channels/:id/attachments
    const upload = uploadToChannel("ch-1", "group-1");
    await upload(file);
    expect(String(asked[2]?.input)).toBe("/api/channels/ch-1/attachments");
    expect(asked[2]?.init?.credentials).toBe("include");
    expect(asked[2]?.init?.body).toBeInstanceOf(FormData);
    expect(headerOf(asked[2]?.init, "x-openbot-tenant")).toBeUndefined();
    // The composer's own field rides the multipart body, not the headers.
    const sent = asked[2]?.init?.body as FormData;
    expect(sent.get("uploadGroup")).toBe("group-1");
  });
});

// ---------------------------------------------------------------------------
// AC4: the allowed-path inventory cross-checks against MT030's exception registry
// ---------------------------------------------------------------------------

describe("MT081 AC4 — allowed-path inventory reconciles with the MT030 exception registry", () => {
  test("the inventory is closed, shaped like a registry, and reviews at least the enterprise path", () => {
    expect(SCOPE_HEADER_ALLOWED_PATHS.length).toBeGreaterThan(0);
    const seen = new Set<string>();
    for (const entry of SCOPE_HEADER_ALLOWED_PATHS) {
      expect(entry.id.trim().length).toBeGreaterThan(0);
      expect(entry.prefix.startsWith("/")).toBe(true);
      expect(entry.reason.trim().length).toBeGreaterThan(0);
      expect(entry.ownerTicket.trim().length).toBeGreaterThan(0);
      expect(seen.has(entry.id)).toBe(false);
      seen.add(entry.id);
    }
    expect(
      SCOPE_HEADER_ALLOWED_PATHS.some((e) => e.prefix === "/api/enterprise/"),
    ).toBe(true);
  });

  test("no path under an allowed prefix is covered by a registered global exception", () => {
    // The reconciliation the ticket names: a global exception (login, health,
    // static directory, identity projection) is global BY DESIGN, so a
    // selection pair arriving there would be a company/team choice nobody is
    // entitled to read. If MT030 grows an entry that covers an allowed path,
    // this fails and the two lists must be reconciled before anything else.
    const methods = ["GET", "POST", "PUT", "PATCH", "DELETE"];
    for (const entry of SCOPE_HEADER_ALLOWED_PATHS) {
      const probes = [entry.prefix, `${entry.prefix}probe`];
      for (const method of methods) {
        for (const probe of probes) {
          const hit = matchGlobalException(method, probe);
          expect({
            entry: entry.id,
            method,
            probe,
            hit: hit?.id ?? null,
          }).toEqual({ entry: entry.id, method, probe, hit: null });
        }
      }
    }
  });

  test("no registered exception path falls under an allowed prefix (reverse direction)", () => {
    for (const exception of GLOBAL_EXCEPTION_ENTRIES) {
      const base = exception.pattern.endsWith("/*")
        ? exception.pattern.slice(0, -2)
        : exception.pattern;
      if (!base.startsWith("/api")) continue;
      const covered = SCOPE_HEADER_ALLOWED_PATHS.some((allowed) =>
        base.startsWith(allowed.prefix),
      );
      expect({ exception: exception.id, covered }).toEqual({
        exception: exception.id,
        covered: false,
      });
    }
  });
});

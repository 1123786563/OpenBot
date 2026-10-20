import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";
import type { MiddlewareHandler } from "hono";
import { describe, expect, test } from "../../tests/support/e2e-compat";
import type { AppVariables } from "../src/auth/guards";
import { loadCraftConfig } from "../src/craft/config";
import {
  buildWebappBootstrapScript,
  WEBAPP_MOUNT_MARKER,
  writeWebappBootstrapScript,
} from "../src/craft/nextjs-dev";
import { createPreviewOrigin } from "../src/craft/preview-origin";
import { createPreviewTickets } from "../src/craft/preview-ticket";
import { refuseResponse } from "../src/craft/refusal";
import type {
  AgentSandboxFileApi,
  SandboxGateway,
} from "../src/craft/sandbox-gateway";
import type { CraftSessionRow, CraftStore } from "../src/craft/store";
import {
  generationGatedWebappBasePathFor,
  WEBAPP_GENERATION_CURRENT,
  WEBAPP_GENERATION_MARKER,
} from "../src/craft/webapp-generation";
import {
  createPreviewProxy,
  createWebappProxyRoutes,
  proxyWebappRequest,
} from "../src/craft/webapp-proxy";
import {
  buildContentDisposition,
  sanitizeZipBasename,
  zipEntries,
} from "../src/craft/zip-archive";

const herePath = fileURLToPath(import.meta.url);
const hereDir = dirname(herePath);

describe("proxyWebappRequest", () => {
  test("streams the body with a dev-road CSP and strips hop-by-hop + credential headers", async () => {
    const seen: { headers: Headers | null } = { headers: null };
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      seen.headers = new Headers(init.headers as Record<string, string>);
      return new Response("<html>hi</html>", {
        status: 200,
        headers: {
          "content-type": "text/html",
          "content-encoding": "gzip",
          "content-length": "13",
          "set-cookie": "a=b",
          connection: "keep-alive",
        },
      });
    }) as typeof fetch;

    const result = await proxyWebappRequest({
      upstreamBaseUrl: "http://127.0.0.1:3010",
      path: "index.html",
      query: "",
      method: "GET",
      requestHeaders: new Headers({
        host: "example.com",
        connection: "keep-alive",
        cookie: "secret=1",
        authorization: "Bearer x",
        "x-forwarded-for": "1.2.3.4",
        accept: "text/html",
      }),
      fetchImpl,
    });

    expect(result.status).toBe(200);
    // F-1（codex 重审）: the dev-road CSP is pinned VERBATIM. `form-action 'self'`
    // walls off same-site form POSTs to the main site — the preview host shares
    // the platform's eTLD+1, so an unblocked form submission would ride with the
    // session cookie and `connect-src` never constrains form submissions.
    // `frame-src 'self'` walls off nested main-site frames (same reach-back class:
    // a cookie-carrying embedded main-site document). A drift here reopens F-1.
    expect(result.headers.get("content-security-policy")).toBe(
      "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ws: wss:; form-action 'self'; frame-src 'self'; font-src 'self' data:; object-src 'none'; base-uri 'none'",
    );
    expect(result.headers.get("content-type")).toBe("text/html");
    // Response hop-by-hop + set-cookie stripped.
    expect(result.headers.get("set-cookie")).toBeNull();
    expect(result.headers.get("content-encoding")).toBeNull();
    expect(result.headers.get("content-length")).toBeNull();
    // Request hop-by-hop, credentials, and forwarding context stripped; benign kept.
    expect(seen.headers?.get("host")).toBeNull();
    expect(seen.headers?.get("connection")).toBeNull();
    expect(seen.headers?.get("cookie")).toBeNull();
    expect(seen.headers?.get("authorization")).toBeNull();
    expect(seen.headers?.get("x-forwarded-for")).toBeNull();
    expect(seen.headers?.get("accept")).toBe("text/html");
  });

  // ── #405 (P1): the preview origin's app cookies ─────────────────────────────
  //
  // The platform pass and the generated app's cookies are SEPARATE jars. The preview
  // origin proxies only the app's own cookies to the dev server (never the pass), and
  // lets the app's Set-Cookie answers ride back — but only as host-only cookies on the
  // preview origin: any Domain attribute is dropped, a Path that is not absolute is
  // dropped, and every one of multiple Set-Cookie headers survives sanitization.
  describe("cookie policy: app-only (the preview origin)", () => {
    test("forwards the app's cookies and strips only the platform pass; the app's Set-Cookie rides back", async () => {
      const seen: { headers: Headers | null; setCookieSeen: string[] | null } =
        {
          headers: null,
          setCookieSeen: null,
        };
      const fetchImpl = (async (_url: string, init: RequestInit) => {
        seen.headers = new Headers(init.headers as Record<string, string>);
        const response = new Response("ok", { status: 200 });
        // Two Set-Cookie headers, the multiple-header case the plain Headers map
        // would otherwise collapse.
        response.headers.append(
          "set-cookie",
          "appsession=s3; Path=/; HttpOnly; SameSite=Lax",
        );
        response.headers.append("set-cookie", "cart=9; Path=/");
        seen.setCookieSeen = response.headers.getSetCookie();
        return response;
      }) as typeof fetch;

      const result = await proxyWebappRequest({
        upstreamBaseUrl: "http://127.0.0.1:3010",
        path: "cart",
        query: "",
        method: "GET",
        requestHeaders: new Headers({
          cookie:
            "openbot_preview_session=pass-ticket; appsession=s1; theme=dark",
          accept: "text/html",
        }),
        cookiePolicy: "app-only",
        fetchImpl,
      });

      // The dev server sees the app's cookies — and NOT the platform pass.
      expect(seen.headers?.get("cookie")).toBe("appsession=s1; theme=dark");
      expect(
        seen.headers?.get("cookie")?.includes("openbot_preview_session"),
      ).toBe(false);
      // Both Set-Cookie answers survive the proxy, unsanitized attributes intact.
      expect(seen.setCookieSeen).toHaveLength(2);
      const answers = result.headers.getSetCookie();
      expect(answers).toHaveLength(2);
      expect(answers[0]).toBe("appsession=s3; Path=/; HttpOnly; SameSite=Lax");
      expect(answers[1]).toBe("cart=9; Path=/");
    });

    test("an app cannot set a Domain cookie: the attribute is dropped, leaving a host-only preview cookie", async () => {
      const fetchImpl = (async () => {
        const response = new Response("ok", { status: 200 });
        response.headers.append(
          "set-cookie",
          "evil=1; Domain=example.com; Path=/; Secure",
        );
        response.headers.append("set-cookie", "sub=2; Domain=.example.com");
        return response;
      }) as typeof fetch;

      const result = await proxyWebappRequest({
        upstreamBaseUrl: "http://127.0.0.1:3010",
        path: "",
        query: "",
        method: "GET",
        requestHeaders: new Headers(),
        cookiePolicy: "app-only",
        fetchImpl,
      });

      const answers = result.headers.getSetCookie();
      expect(answers).toHaveLength(2);
      for (const answer of answers) {
        expect(/domain\s*=/i.test(answer)).toBe(false);
      }
      // Everything else the app asked for survives: the name=value pair and the
      // non-escaping attributes.
      expect(answers[0]).toBe("evil=1; Path=/; Secure");
      expect(answers[1]).toBe("sub=2");
    });

    test("a non-absolute Path attribute is dropped; an absolute one is kept verbatim", async () => {
      const fetchImpl = (async () => {
        const response = new Response("ok", { status: 200 });
        response.headers.append("set-cookie", "a=1; Path=relative");
        response.headers.append("set-cookie", "b=2; Path=/nested/deep");
        return response;
      }) as typeof fetch;

      const result = await proxyWebappRequest({
        upstreamBaseUrl: "http://127.0.0.1:3010",
        path: "",
        query: "",
        method: "GET",
        requestHeaders: new Headers(),
        cookiePolicy: "app-only",
        fetchImpl,
      });

      const answers = result.headers.getSetCookie();
      expect(answers[0]).toBe("a=1");
      expect(answers[1]).toBe("b=2; Path=/nested/deep");
    });

    test("a request whose only cookie is the pass forwards no cookie header at all", async () => {
      const seen: { headers: Headers | null } = { headers: null };
      const fetchImpl = (async (_url: string, init: RequestInit) => {
        seen.headers = new Headers(init.headers as Record<string, string>);
        return new Response("ok", { status: 200 });
      }) as typeof fetch;

      await proxyWebappRequest({
        upstreamBaseUrl: "http://127.0.0.1:3010",
        path: "",
        query: "",
        method: "GET",
        requestHeaders: new Headers({
          cookie: "openbot_preview_session=only-a-pass",
        }),
        cookiePolicy: "app-only",
        fetchImpl,
      });
      expect(seen.headers?.get("cookie")).toBeNull();
    });

    test("the default policy (the legacy same-origin mount) still strips every cookie both ways", async () => {
      const seen: { headers: Headers | null } = { headers: null };
      const fetchImpl = (async (_url: string, init: RequestInit) => {
        seen.headers = new Headers(init.headers as Record<string, string>);
        const response = new Response("ok", { status: 200 });
        response.headers.append("set-cookie", "app=1; Path=/");
        return response;
      }) as typeof fetch;

      const result = await proxyWebappRequest({
        upstreamBaseUrl: "http://127.0.0.1:3010",
        path: "",
        query: "",
        method: "GET",
        requestHeaders: new Headers({
          cookie: "openbot_preview_session=pass; appsession=s1",
        }),
        fetchImpl,
      });
      expect(seen.headers?.get("cookie")).toBeNull();
      expect(result.headers.getSetCookie()).toHaveLength(0);
    });
  });

  test("a connection failure is a 502, not a pass-through", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    const result = await proxyWebappRequest({
      upstreamBaseUrl: "http://127.0.0.1:3010",
      path: "",
      query: "",
      method: "GET",
      requestHeaders: new Headers(),
      fetchImpl,
    });
    expect(result.status).toBe(502);
  });

  // ── the interactivity half: a preview that cannot POST cannot be tested ──────
  //
  // The route only ever registered GET, and this helper hardcoded `method: "GET"`
  // and never carried a body. Measured against the live route: POST/PUT/PATCH/
  // DELETE/OPTIONS all answered 404 from Hono — the request never reached the
  // app. That silently kills every Next.js Server Action (POST), every API route
  // mutation, every `<form method="POST">` and every preflighted fetch, i.e.
  // exactly the apps craft is asked to build. The preview was a picture, not a
  // running app.
  test("carries the caller's method and body to the upstream, not a hardcoded GET", async () => {
    const seen: {
      method: string | null;
      body: string | null;
      type: string | null;
    } = {
      method: null,
      body: null,
      type: null,
    };
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      seen.method = init.method ?? null;
      seen.body =
        init.body === undefined || init.body === null
          ? null
          : String(init.body);
      seen.type = new Headers(init.headers as HeadersInit).get("content-type");
      return new Response('{"ok":true}', {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const result = await proxyWebappRequest({
      upstreamBaseUrl: "http://127.0.0.1:3010",
      path: "api/tasks",
      query: "",
      method: "POST",
      body: '{"title":"ship it"}',
      requestHeaders: new Headers({ "content-type": "application/json" }),
      fetchImpl,
    });

    expect(seen.method).toBe("POST");
    expect(seen.body).toBe('{"title":"ship it"}');
    // The app's own content type survives — a Server Action's text/plain and an
    // API route's application/json are not interchangeable to the receiver.
    expect(seen.type).toBe("application/json");
    expect(result.status).toBe(201);
  });

  test("a bodyless method forwards no body, and the status passes through", async () => {
    const seen: { method: string | null; body: unknown } = {
      method: null,
      body: "unset",
    };
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      seen.method = init.method ?? null;
      seen.body = init.body;
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;

    const result = await proxyWebappRequest({
      upstreamBaseUrl: "http://127.0.0.1:3010",
      path: "api/tasks/1",
      query: "",
      method: "DELETE",
      requestHeaders: new Headers(),
      fetchImpl,
    });

    expect(seen.method).toBe("DELETE");
    expect(seen.body === undefined || seen.body === null).toBe(true);
    expect(result.status).toBe(204);
  });
});

// ── zip-archive — the onyx primitives behind both download routes ─────────────

describe("sanitizeZipBasename (onyx manager.py:159-163, F6 table)", () => {
  test.each([
    // [input, allowDots, expected] — the fixture's four rows, mechanically derived.
    ["My Project!", false, "My_Project_"],
    ["my.lib", true, "my.lib"],
    ["my.lib", false, "my_lib"],
    ["../../etc", true, ".._.._etc"],
  ] as const)(
    "sanitize(%p, allowDots=%p) = %p",
    (input, allowDots, expected) => {
      expect(sanitizeZipBasename(input, { allowDots })).toBe(expected);
    },
  );

  test("keeps unicode letters and digits (python isalnum semantics)", () => {
    expect(sanitizeZipBasename("项目 App", { allowDots: false })).toBe(
      "项目_App",
    );
  });
});

describe("buildContentDisposition (onyx serving.py:103-115)", () => {
  test("an ASCII-safe name answers fallback + RFC 5987 identical", () => {
    expect(buildContentDisposition("outputs.zip")).toBe(
      `attachment; filename="outputs.zip"; filename*=UTF-8''outputs.zip`,
    );
  });

  test("a unicode name answers an ASCII fallback and a percent-encoded true name", () => {
    // Two non-ASCII chars → two fallback underscores; sanitize's own _ (the space)
    // is the third.
    expect(buildContentDisposition("项目_App-webapp.zip")).toBe(
      `attachment; filename="___App-webapp.zip"; filename*=UTF-8''%E9%A1%B9%E7%9B%AE_App-webapp.zip`,
    );
  });

  test("control chars and quotes are scrubbed before anything else", () => {
    // serving.py:49 — \x00-\x1f, \x7f, ", \, / each become one _.
    expect(buildContentDisposition('a"b\\c/d')).toBe(
      `attachment; filename="a_b_c_d"; filename*=UTF-8''a_b_c_d`,
    );
    expect(buildContentDisposition("\x01\x7f")).toBe(
      `attachment; filename="__"; filename*=UTF-8''__`,
    );
    expect(buildContentDisposition("  ")).toBe(
      `attachment; filename="download"; filename*=UTF-8''download`,
    );
  });
});

describe("zipEntries (the writer)", () => {
  test("emits the ZIP signatures: local header first, EOCD last", () => {
    const buf = zipEntries([
      { path: "a.txt", bytes: new TextEncoder().encode("hello") },
    ]);
    expect(buf[0]).toBe(0x50);
    expect(buf[1]).toBe(0x4b);
    expect(buf[2]).toBe(0x03);
    expect(buf[3]).toBe(0x04);
    expect(buf.subarray(buf.length - 22, buf.length - 18)).toEqual(
      new Uint8Array([0x50, 0x4b, 0x05, 0x06]),
    );
  });

  test("round-trips entries through the independent reader with CRCs intact", () => {
    const members = readZip(
      zipEntries([
        { path: "deep/nested/one.txt", bytes: new TextEncoder().encode("one") },
        { path: "页面/ファイル.bin", bytes: new Uint8Array([0, 255, 16]) },
      ]),
    );
    expect(members.map((m) => m.name)).toEqual([
      "deep/nested/one.txt",
      "页面/ファイル.bin",
    ]);
    expect(members[1]?.bytes).toEqual(new Uint8Array([0, 255, 16]));
  });

  test("sets the UTF-8 name flag only for non-ASCII names (zipfile parity)", () => {
    const ascii = zipEntries([
      { path: "a.txt", bytes: new TextEncoder().encode("x") },
    ]);
    const flag = Buffer.from(ascii).readUInt16LE(6);
    expect(flag & 0x0800).toBe(0);

    const unicode = zipEntries([
      { path: "页面.txt", bytes: new TextEncoder().encode("x") },
    ]);
    expect(Buffer.from(unicode).readUInt16LE(6) & 0x0800).toBe(0x0800);
  });

  test("an empty entry list is a valid empty archive (EOCD only)", () => {
    const buf = zipEntries([]);
    expect(buf.length).toBe(22);
    expect(readZip(buf)).toEqual([]);
  });
});

// ── GET /sessions/:id/webapp-download — the ZIP contract (fixture F6 B) ────────
//
// onyx `session/api.py:681-708` + `manager.py:1595-1636`: application/zip, a
// session-derived `*-webapp.zip` filename (`_sanitize_zip_basename(name or
// session-{id[:8]}, allow_dots=False)`), the outputs/web walk with onyx's hidden
// filter, and 404 "Webapp not found" for every None shape (no session, no
// sandbox, no outputs/web — onyx's route does not distinguish them).

const SESSION_ID = "cs-111122223333";
const DIRECTORY = `/workspace/sessions/${SESSION_ID}`;
const WEBAPP = `${DIRECTORY}/outputs/web`;

function fakeRequireUser(): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (context, next) => {
    context.set("actor", { id: "u1", email: "u1@example.com", role: "user" });
    await next();
  };
}

function sessionRow(
  name: string | null,
  nextjsPort: number | null = null,
): CraftSessionRow {
  return {
    id: SESSION_ID,
    userId: "u1",
    name,
    status: "active",
    lastActivityAt: new Date(),
    createdAt: new Date(),
    nextjsPort,
    sharingScope: "private",
    origin: "INTERACTIVE",
    opencodeSessionId: null,
    agentProvider: null,
    agentModel: null,
    skillsHash: null,
    mcpConfigHash: null,
  };
}

function storeWithSession(
  name: string | null,
  ownerUserId = "u1",
  nextjsPort: number | null = null,
): CraftStore {
  return {
    async getSession(id: string, userId: string) {
      return id === SESSION_ID && userId === ownerUserId
        ? sessionRow(name, nextjsPort)
        : undefined;
    },
    // The no-bump owning read (fix-ocr18 #1): same row, same ownership,
    // no activity stamp — the route-class readers answer through this.
    async findSession(id: string, userId: string) {
      return id === SESSION_ID && userId === ownerUserId
        ? sessionRow(name, nextjsPort)
        : undefined;
    },
    async updateSessionActivity() {},
  } as unknown as CraftStore;
}

/** In-memory sandbox (values may be text or raw bytes); the listing answers the REAL
 * gateway shape — one level per call, immediate children as full paths (finding F-C). */
function memoryFileApi(initial: Record<string, string | Uint8Array> = {}) {
  const files = new Map<string, Uint8Array>();
  for (const [path, value] of Object.entries(initial)) {
    files.set(
      path,
      typeof value === "string" ? new TextEncoder().encode(value) : value,
    );
  }
  const api: AgentSandboxFileApi = {
    async listFiles(path: string) {
      const prefix = `${path}/`;
      const children = new Set<string>();
      for (const key of files.keys()) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        const first = rest.split("/")[0];
        children.add(rest.includes("/") ? `${prefix}${first}` : key);
      }
      if (children.size === 0) throw new Error(`not found: ${path}`);
      return [...children];
    },
    async writeFile() {},
    async writeFileBytes() {},
    async deletePath() {
      return false;
    },
    async readFile(path) {
      const raw = files.get(path);
      return raw === undefined ? null : new TextDecoder().decode(raw);
    },
    async readFileBytes(path) {
      return files.get(path) ?? null;
    },
  };
  return api;
}

const gatewayWith = (api: AgentSandboxFileApi): SandboxGateway =>
  ({ fileApiFor: () => api }) as unknown as SandboxGateway;

const downloadRoutes = (
  api: AgentSandboxFileApi,
  sessionName: string | null | undefined = "My Project!",
  ownerUserId?: string,
) =>
  createWebappProxyRoutes(fakeRequireUser(), {
    config: loadCraftConfig({}),
    store: storeWithSession(
      sessionName === undefined ? null : sessionName,
      ownerUserId,
    ),
    gateway: gatewayWith(api),
    botIdFor: async () => "craft-bot",
    sandboxConnectionFor: () => null,
  });

/** The F6 input tree, webapp face: visible files, hidden files, unicode name, binary. */
const LOGO_BYTES = (() => {
  const bytes = new Uint8Array(512);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7 + 13) & 0xff;
  return bytes;
})();

const webappTree = (): Record<string, string | Uint8Array> => ({
  [`${WEBAPP}/package.json`]: '{"name":"web"}',
  [`${WEBAPP}/src/app/page.tsx`]: "export default function Page() {}",
  [`${WEBAPP}/src/页面.tsx`]: "export const 名 = 1;", // unicode filename round-trip
  [`${WEBAPP}/logo.bin`]: LOGO_BYTES, // binary member
  [`${WEBAPP}/node_modules/pkg/index.js`]: "hidden", // HIDDEN_PATTERNS dir, pruned whole
  [`${WEBAPP}/.env`]: "hidden", // dot file, pruned
  [`${WEBAPP}/.next/cache/id-123.js`]: "hidden", // hidden dir, pruned whole
  [`${WEBAPP}/nextjs.log`]: "hidden", // HIDDEN_PATTERNS file name
});

// A minimal ZIP reader — the writer's independent inverse: EOCD → central
// directory records → local-header data offsets, inflate + CRC-32 verify.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = -1;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function readZip(
  buffer: Uint8Array,
): Array<{ name: string; bytes: Uint8Array; method: number }> {
  const view = Buffer.from(buffer);
  let eocd = -1;
  for (
    let at = view.length - 22;
    at >= Math.max(0, view.length - 66_000);
    at--
  ) {
    if (
      view[at] === 0x50 &&
      view[at + 1] === 0x4b &&
      view[at + 2] === 0x05 &&
      view[at + 3] === 0x06
    ) {
      eocd = at;
      break;
    }
  }
  if (eocd < 0) throw new Error("no end-of-central-directory record");

  const count = view.readUInt16LE(eocd + 10);
  let at = view.readUInt32LE(eocd + 16);
  const out: Array<{ name: string; bytes: Uint8Array; method: number }> = [];
  for (let i = 0; i < count; i++) {
    if (view.readUInt32LE(at) !== 0x02014b50)
      throw new Error(`bad central record at ${at}`);
    const method = view.readUInt16LE(at + 10);
    const crc = view.readUInt32LE(at + 16);
    const compSize = view.readUInt32LE(at + 20);
    const size = view.readUInt32LE(at + 24);
    const nameLen = view.readUInt16LE(at + 28);
    const extraLen = view.readUInt16LE(at + 30);
    const commentLen = view.readUInt16LE(at + 32);
    const localOffset = view.readUInt32LE(at + 42);
    const name = new TextDecoder().decode(
      view.subarray(at + 46, at + 46 + nameLen),
    );

    const localNameLen = view.readUInt16LE(localOffset + 26);
    const localExtraLen = view.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const comp = view.subarray(dataStart, dataStart + compSize);
    const bytes = new Uint8Array(
      method === 8 ? inflateRawSync(comp) : (comp as Buffer),
    );
    if (bytes.length !== size) throw new Error(`size mismatch for ${name}`);
    if (crc32(bytes) !== crc) throw new Error(`crc mismatch for ${name}`);
    out.push({ name, bytes, method });
    at += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

describe("webapp-download (ZIP contract)", () => {
  test("answers application/zip with the sanitized session-derived filename", async () => {
    const app = downloadRoutes(memoryFileApi(webappTree()));
    const response = await app.request(
      `/sessions/${SESSION_ID}/webapp-download`,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/zip");
    // "My Project!" → space and ! each become one _ (F6 sanitize table, allow_dots=False);
    // serving.py:103-115 answers ASCII fallback + RFC 5987 filename*.
    expect(response.headers.get("content-disposition")).toBe(
      `attachment; filename="My_Project_-webapp.zip"; filename*=UTF-8''My_Project_-webapp.zip`,
    );
  });

  test("packs outputs/web as a ZIP: nested + binary + unicode members, hidden pruned", async () => {
    const app = downloadRoutes(memoryFileApi(webappTree()));
    const response = await app.request(
      `/sessions/${SESSION_ID}/webapp-download`,
    );
    expect(response.status).toBe(200);

    const members = readZip(new Uint8Array(await response.arrayBuffer()));
    // File members only (onyx writestr loop — no directory placeholder entries),
    // arcnames relative to outputs/web, hidden entries absent.
    expect(members.map((m) => m.name).sort()).toEqual([
      "logo.bin",
      "package.json",
      "src/app/page.tsx",
      "src/页面.tsx",
    ]);
    expect(members.every((m) => !m.name.endsWith("/"))).toBe(true);

    const logo = members.find((m) => m.name === "logo.bin");
    expect(logo?.bytes).toEqual(LOGO_BYTES); // binary bytes byte-identical
    const unicode = members.find((m) => m.name === "src/页面.tsx");
    expect(unicode?.bytes).toEqual(
      new TextEncoder().encode("export const 名 = 1;"),
    );
    expect(members.every((m) => m.method === 8)).toBe(true); // deflate
  });

  test("a webapp whose visible files are all hidden entries is an empty, valid ZIP", async () => {
    const app = downloadRoutes(
      memoryFileApi({
        [`${WEBAPP}/.env`]: "hidden",
        [`${WEBAPP}/node_modules/pkg/index.js`]: "hidden",
      }),
    );
    const response = await app.request(
      `/sessions/${SESSION_ID}/webapp-download`,
    );

    // The directory EXISTS (listing succeeds) and onyx's walk filters everything:
    // a zero-entry zip, not a 404 (manager.py:1615-1632 — only a missing outputs/web
    // is the None that answers 404).
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/zip");
    const members = readZip(new Uint8Array(await response.arrayBuffer()));
    expect(members).toEqual([]);
  });

  test("a missing outputs/web is 404 Webapp not found", async () => {
    const app = downloadRoutes(
      memoryFileApi({ [`${DIRECTORY}/outputs/report.md`]: "# no web" }),
    );
    const response = await app.request(
      `/sessions/${SESSION_ID}/webapp-download`,
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Webapp not found" });
  });

  test("a non-owner is refused (ownership 404, onyx's indistinct None body)", async () => {
    // The store resolves only for the owner; actor u1 is someone else here —
    // onyx's route maps every None (session, sandbox, web) to the same
    // 404 "Webapp not found" (api.py:701-704).
    const app = downloadRoutes(memoryFileApi(webappTree()), null, "owner");
    const response = await app.request(
      `/sessions/${SESSION_ID}/webapp-download`,
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Webapp not found" });

    const unknown = await app.request(
      `/sessions/never-heard-of/webapp-download`,
    );
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: "Webapp not found" });
  });

  test("an unnamed session falls back to the session-id stem", async () => {
    const app = downloadRoutes(memoryFileApi(webappTree()), null);
    const response = await app.request(
      `/sessions/${SESSION_ID}/webapp-download`,
    );
    expect(response.status).toBe(200);
    // manager.py:1634-1636: session.name or f"session-{str(id)[:8]}".
    expect(response.headers.get("content-disposition")).toBe(
      `attachment; filename="session-cs-11112-webapp.zip"; filename*=UTF-8''session-cs-11112-webapp.zip`,
    );
  });

  test("a unicode session name survives sanitize with an ASCII fallback", async () => {
    const app = downloadRoutes(memoryFileApi(webappTree()), "项目 App");
    const response = await app.request(
      `/sessions/${SESSION_ID}/webapp-download`,
    );
    expect(response.status).toBe(200);
    // sanitize keeps unicode letters (python isalnum semantics), space → _;
    // serving.py answers "_" per non-ASCII char (two here) and RFC 5987 percent-escapes
    // the true name (项 = %E9%A1%B9, 目 = %E7%9B%AE) — the third _ in the fallback is
    // sanitize's own, for the space.
    expect(response.headers.get("content-disposition")).toBe(
      `attachment; filename="___App-webapp.zip"; filename*=UTF-8''%E9%A1%B9%E7%9B%AE_App-webapp.zip`,
    );
  });

  test("a standard system reader accepts and extracts the archive", async () => {
    const app = downloadRoutes(memoryFileApi(webappTree()));
    const response = await app.request(
      `/sessions/${SESSION_ID}/webapp-download`,
    );
    expect(response.status).toBe(200);
    const bytes = new Uint8Array(await response.arrayBuffer());

    const dir = mkdtempSync(join(tmpdir(), "craft-webapp-zip-"));
    const archivePath = join(dir, "webapp.zip");
    writeFileSync(archivePath, bytes);

    // Check 1 — `unzip -t`: every member's structure and CRC verified by Info-ZIP.
    const tested = spawnSync("unzip", ["-t", archivePath], {
      encoding: "utf8",
    });
    expect(tested.status).toBe(0);

    // Check 2 — macOS `ditto -x -k` (Archive Utility's engine) extracts it, and the
    // binary + unicode members come back byte-identical. Skipped where ditto is absent.
    if (existsSync("/usr/bin/ditto")) {
      const outDir = join(dir, "out");
      mkdirSync(outDir);
      const extracted = spawnSync("ditto", ["-x", "-k", archivePath, outDir], {
        encoding: "utf8",
      });
      expect(extracted.status).toBe(0);
      expect(new Uint8Array(readFileSync(join(outDir, "logo.bin")))).toEqual(
        LOGO_BYTES,
      );
      expect(existsSync(join(outDir, "src/页面.tsx"))).toBe(true);
    }
  });
});

// ── F-E: the preview and the ready probe dial the SANDBOX host, not host loopback ──
//
// In the host-server + docker-sandbox topology the dev server listens INSIDE the
// container; dialing 127.0.0.1:{port} from the server never reaches it (live evidence:
// in-container probe 200, host 000 — ready永false / preview 503). Both reachability
// paths must dial the host the SANDBOX itself is reached on — the gateway connection's
// host (config.sandboxGatewayBaseUrl, else the per-bot conn baseUrl), the same machine
// the reserved port range is published from.

describe("webapp preview reachability dials the sandbox host (F-E)", () => {
  function previewRoutes(connBaseUrl: string) {
    return createWebappProxyRoutes(fakeRequireUser(), {
      config: loadCraftConfig({}),
      store: storeWithSession("preview", "u1", 3011),
      gateway: gatewayWith(
        memoryFileApi({ [`${WEBAPP}/package.json`]: '{"name":"web"}' }),
      ),
      botIdFor: async () => "craft-bot",
      sandboxConnectionFor: () => ({ baseUrl: connBaseUrl, token: null }),
    });
  }

  test("webapp-info ready and the preview proxy fetch the gateway host's reserved port", async () => {
    const dialed: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      dialed.push(String(input));
      return new Response("<html>app</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    }) as typeof fetch;
    try {
      const app = previewRoutes("http://sbox.internal:4300");
      const info = await app.request(`/sessions/${SESSION_ID}/webapp-info`);
      expect(info.status).toBe(200);
      expect(((await info.json()) as { ready: boolean }).ready).toBe(true);

      const page = await app.request(
        `/sessions/${SESSION_ID}/webapp/index.html`,
      );
      expect(page.status).toBe(200);
      expect(await page.text()).toBe("<html>app</html>");
      // F-1: the LEGACY same-origin route (`/sessions/:id/webapp`) is a third
      // consumption surface of the same CSP family — pinned verbatim so a
      // per-surface copy drifting off `form-action 'self'` fails this suite
      // instead of a real deployment.
      expect(page.headers.get("content-security-policy")).toBe(
        "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ws: wss:; form-action 'self'; frame-src 'self'; font-src 'self' data:; object-src 'none'; base-uri 'none'",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
    // Every dial went to the SANDBOX host's port — never the host's own loopback.
    expect(dialed.length).toBeGreaterThan(0);
    for (const url of dialed) {
      expect(url.startsWith("http://sbox.internal:3011/")).toBe(true);
    }
  });

  test("the sandbox host is taken from the config gateway URL when set, before the conn baseUrl", async () => {
    const dialed: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      dialed.push(String(input));
      return new Response("x", { status: 200 });
    }) as typeof fetch;
    try {
      const app = createWebappProxyRoutes(fakeRequireUser(), {
        config: loadCraftConfig({
          OPENBOT_CRAFT_SANDBOX_GATEWAY_URL: "http://gateway.host:4300",
        }),
        store: storeWithSession("preview", "u1", 3011),
        gateway: gatewayWith(
          memoryFileApi({ [`${WEBAPP}/package.json`]: '{"name":"web"}' }),
        ),
        botIdFor: async () => "craft-bot",
        sandboxConnectionFor: () => ({
          baseUrl: "http://other.host:4300",
          token: null,
        }),
      });
      const info = await app.request(`/sessions/${SESSION_ID}/webapp-info`);
      expect(((await info.json()) as { ready: boolean }).ready).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(
      dialed.every((url) => url.startsWith("http://gateway.host:3011/")),
    ).toBe(true);
  });
});

// ── #362: createPreviewProxy — the servePreview seam's implementation ─────────
//
// The preview origin's routing module (preview-origin.ts) hands cookie-
// authenticated requests to this: the session's row (by id — the preview pass
// IS the authentication, there is no actor id to ownership-check against), the
// sandbox connection, the ATTACH probe (never spawn), then proxyWebappRequest
// with the full upstream path — under the dev form that INCLUDES the leading
// label (the dev server mounts at /<label> via the start script's injected
// ONYX_WEBAPP_BASE_PATH, F-2/#365), same shape as the host form's verbatim
// pathname. Refusals are the surface's dual shape, and the preview pass cookie
// must never reach the app (stripRequestHeaders already drops it — pinned here).

describe("createPreviewProxy (the servePreview seam)", () => {
  const PREVIEW_SESSION = "cs-777788889999";

  /** Records every dial (probe + upstream) and answers app-shaped responses. */
  function recordingUpstream() {
    const dialed: string[] = [];
    const upstreamHeaders: Headers[] = [];
    const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
      dialed.push(String(input));
      if (init) upstreamHeaders.push(new Headers(init.headers as HeadersInit));
      return new Response('{"ok":true}', {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    return { dialed, upstreamHeaders, fetchImpl };
  }

  function previewProxyDeps(options: {
    sessionExists?: boolean;
    nextjsPort?: number | null;
    connBaseUrl?: string | null;
    fetchImpl?: typeof fetch;
    now?: () => number;
  }) {
    return {
      config: loadCraftConfig({}),
      store: {
        async findSessionById(id: string) {
          const port =
            options.nextjsPort === undefined ? 3011 : options.nextjsPort;
          return options.sessionExists === false
            ? undefined
            : sessionRow("app", port);
        },
        async getSession(id: string, userId: string) {
          const port =
            options.nextjsPort === undefined ? 3011 : options.nextjsPort;
          return options.sessionExists === false
            ? undefined
            : sessionRow("app", port);
        },
        async findSession(id: string, userId: string) {
          const port =
            options.nextjsPort === undefined ? 3011 : options.nextjsPort;
          return options.sessionExists === false
            ? undefined
            : sessionRow("app", port);
        },
        async updateSessionActivity() {},
      } as unknown as CraftStore,
      gateway: gatewayWith(
        memoryFileApi({ [`${WEBAPP}/package.json`]: '{"name":"web"}' }),
      ),
      botIdFor: async () => "craft-bot",
      sandboxConnectionFor: () =>
        options.connBaseUrl === null
          ? null
          : {
              baseUrl: options.connBaseUrl ?? "http://sbox.internal:4300",
              token: null,
            },
      fetchImpl: options.fetchImpl,
      now: options.now,
    };
  }

  test("proxies the full path the origin hands it — label mount included; method, body and query reach the dev server; CSP rides back", async () => {
    const { dialed, upstreamHeaders, fetchImpl } = recordingUpstream();
    const serve = createPreviewProxy(previewProxyDeps({ fetchImpl }));

    // F-2 (#365): the dev form's dev server is basePath-mounted at /<label>,
    // so the upstream-resolvable path is the label-ful one the origin derives
    // (appPathFor no longer strips) — forwarding the port-root path would 404
    // beside the mount.
    const response = await serve({
      sessionId: PREVIEW_SESSION,
      userId: "u1",
      appPath: "/abc123label/api/tasks",
      query: "?sort=asc",
      method: "POST",
      request: new Request(
        "http://127.0.0.1:3001/abc123label/api/tasks?sort=asc",
        {
          method: "POST",
          headers: {
            cookie: `openbot_preview_session=${PREVIEW_SESSION}`,
            "content-type": "application/json",
          },
          body: '{"title":"ship it"}',
        },
      ),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    // F-1: the host-form preview source pins the SAME policy verbatim — one
    // CSP family across every proxy surface (this host-form source, the legacy
    // same-origin route, the proxied page above), `form-action 'self'` included.
    expect(response.headers.get("content-security-policy")).toBe(
      "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ws: wss:; form-action 'self'; frame-src 'self'; font-src 'self' data:; object-src 'none'; base-uri 'none'",
    );
    // The label rides to the upstream (the mount the dev server serves under),
    // and the preview pass never reaches the app.
    const upstream = dialed.find((url) => url.includes("/api/tasks"));
    expect(upstream).toBe(
      "http://sbox.internal:3011/abc123label/api/tasks?sort=asc",
    );
    const seen = upstreamHeaders[upstreamHeaders.length - 1];
    expect(seen.get("cookie")).toBeNull();
  });

  test("carries all four mutating verbs (AC2: a preview that cannot POST is a screenshot)", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const seen: Array<{ method: string; url: string }> = [];
      const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
        // The attach probe dials "/" with GET — only the app-path dial counts.
        seen.push({ method: init?.method ?? "GET", url: String(input) });
        return new Response(null, { status: 204 });
      }) as typeof fetch;
      const serve = createPreviewProxy(previewProxyDeps({ fetchImpl }));

      const response = await serve({
        sessionId: PREVIEW_SESSION,
        userId: "u1",
        appPath: "/api/tasks/1",
        query: "",
        method,
        request: new Request("http://127.0.0.1:3001/x/api/tasks/1", {
          method,
          headers: { cookie: `openbot_preview_session=${PREVIEW_SESSION}` },
        }),
      });
      expect(response.status).toBe(204);
      expect(seen.filter((call) => call.url.includes("/api/tasks/1"))).toEqual([
        { method, url: "http://sbox.internal:3011/api/tasks/1" },
      ]);
    }
  });

  test("a deleted session (the row is gone after redemption) is an honest 404, never dialed", async () => {
    const { dialed } = recordingUpstream();
    const serve = createPreviewProxy(
      previewProxyDeps({
        sessionExists: false,
        fetchImpl: (async () => {
          throw new Error("must not dial");
        }) as typeof fetch,
      }),
    );
    const response = await serve({
      sessionId: PREVIEW_SESSION,
      userId: "u1",
      appPath: "/",
      query: "",
      method: "GET",
      request: new Request("http://127.0.0.1:3001/x/", {
        headers: { cookie: `openbot_preview_session=${PREVIEW_SESSION}` },
      }),
    });
    expect(response.status).toBe(404);
    expect(dialed).toEqual([]);
  });

  test("no sandbox connection or no reserved port answers the surface's refusal shapes", async () => {
    const { fetchImpl } = recordingUpstream();
    const noConn = createPreviewProxy(
      previewProxyDeps({ connBaseUrl: null, fetchImpl }),
    );
    const connGone = await noConn({
      sessionId: PREVIEW_SESSION,
      userId: "u1",
      appPath: "/",
      query: "",
      method: "GET",
      request: new Request("http://127.0.0.1:3001/x/"),
    });
    expect(connGone.status).toBe(503);

    const noPort = createPreviewProxy(
      previewProxyDeps({ nextjsPort: null, fetchImpl }),
    );
    const portGone = await noPort({
      sessionId: PREVIEW_SESSION,
      userId: "u1",
      appPath: "/",
      query: "",
      method: "GET",
      request: new Request("http://127.0.0.1:3001/x/"),
    });
    expect(portGone.status).toBe(503);
    expect(await portGone.json()).toEqual({ error: expect.any(String) });
  });

  test("fix-ocr27 #8: two consecutive requests probe readiness ONCE — the short-TTL memo carries the second", async () => {
    // Every preview-source request used to pay a serial 2s-timeout probe
    // before its forward — the RTT doubling the production path amplifies
    // across a whole page load (chunks, CSS, Server Actions). A per-session
    // memo (3s TTL; refreshed by a successful probe or forward; re-probed on
    // failure or expiry) carries a burst across one probe. RED: the second
    // request dialed the probe again.
    const { dialed, fetchImpl } = recordingUpstream();
    const serve = createPreviewProxy(previewProxyDeps({ fetchImpl }));
    const call = () =>
      serve({
        sessionId: PREVIEW_SESSION,
        userId: "u1",
        appPath: "/x/api/tasks",
        query: "",
        method: "GET",
        request: new Request("http://127.0.0.1:3001/x/api/tasks", {
          headers: { cookie: `openbot_preview_session=${PREVIEW_SESSION}` },
        }),
      });
    expect((await call()).status).toBe(200);
    expect((await call()).status).toBe(200);
    // The probe is the bare host:port dial; the forwards carry paths.
    const probes = dialed.filter((url) => url === "http://sbox.internal:3011/");
    expect(probes.length).toBe(1);
  });

  test("fix-ocr27 #8: the memo expires — after the TTL the next request probes again", async () => {
    let clock = 1_000_000;
    const { dialed, fetchImpl } = recordingUpstream();
    const serve = createPreviewProxy(
      previewProxyDeps({
        fetchImpl,
        now: () => clock,
      }),
    );
    const call = () =>
      serve({
        sessionId: PREVIEW_SESSION,
        userId: "u1",
        appPath: "/x/api/tasks",
        query: "",
        method: "GET",
        request: new Request("http://127.0.0.1:3001/x/api/tasks", {
          headers: { cookie: `openbot_preview_session=${PREVIEW_SESSION}` },
        }),
      });
    await call();
    clock += 4_000; // past the 3s TTL
    await call();
    const probes = dialed.filter((url) => url === "http://sbox.internal:3011/");
    expect(probes.length).toBe(2);
  });

  test("fix-ocr27 #8: a failed probe is NEVER memoized — a down server keeps its refusal on every request", async () => {
    let dials = 0;
    const down = (async () => {
      dials += 1;
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    const serve = createPreviewProxy(previewProxyDeps({ fetchImpl: down }));
    const call = () =>
      serve({
        sessionId: PREVIEW_SESSION,
        userId: "u1",
        appPath: "/",
        query: "",
        method: "GET",
        request: new Request("http://127.0.0.1:3001/x/"),
      });
    expect((await call()).status).toBe(503);
    expect((await call()).status).toBe(503);
    // Every request re-probes: a memoized DOWN verdict would outlive the
    // server's recovery and refuse a healthy app for the TTL's remainder.
    expect(dials).toBe(2);
  });

  test("fix-ocr28 #5: a deleted session's 404 clears the session's memo entries — the next request re-probes", async () => {
    // The 404 branch (the row gone after redemption) used to leave the
    // session's readyUntil entries behind — dead-session keys whose values
    // only the TTL would retire. The cleanup is observable through the
    // probe dial: a memo entry that survives the 404 would skip the
    // readiness probe for a session whose row was deleted and re-created
    // (or a port re-reserved), serving off a verdict about a DIFFERENT
    // process's lifetime. RED: the third call rides the stale memo and
    // never re-probes.
    let exists = true;
    const { dialed, fetchImpl } = recordingUpstream();
    const serve = createPreviewProxy({
      ...previewProxyDeps({ fetchImpl }),
      store: {
        async findSession() {
          return exists ? sessionRow("app", 3011) : undefined;
        },
      } as unknown as CraftStore,
    });
    const call = () =>
      serve({
        sessionId: PREVIEW_SESSION,
        userId: "u1",
        appPath: "/x/api/tasks",
        query: "",
        method: "GET",
        request: new Request("http://127.0.0.1:3001/x/api/tasks"),
      });
    expect((await call()).status).toBe(200); // probe 1
    expect((await call()).status).toBe(200); // memo hit — still one probe
    exists = false;
    const gone = await call();
    expect(gone.status).toBe(404);
    exists = true;
    expect((await call()).status).toBe(200);
    const probes = dialed.filter((url) => url === "http://sbox.internal:3011/");
    // The 404 wiped the session's entries: the recovered request paid its
    // own probe instead of trusting a memo minted for a dead row.
    expect(probes.length).toBe(2);
  });

  test("a down dev server (attach probe fails) is the not-running refusal, HTML for a frame", async () => {
    const down = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    const serve = createPreviewProxy(previewProxyDeps({ fetchImpl: down }));

    const framed = await serve({
      sessionId: PREVIEW_SESSION,
      userId: "u1",
      appPath: "/",
      query: "",
      method: "GET",
      request: new Request("http://127.0.0.1:3001/x/", {
        headers: { accept: "text/html,application/xhtml+xml" },
      }),
    });
    expect(framed.status).toBe(503);
    expect(framed.headers.get("content-type")).toContain("text/html");
    expect(await framed.text()).toContain("<!");

    const programmatic = await serve({
      sessionId: PREVIEW_SESSION,
      userId: "u1",
      appPath: "/",
      query: "",
      method: "GET",
      request: new Request("http://127.0.0.1:3001/x/"),
    });
    expect(programmatic.status).toBe(503);
    expect(await programmatic.json()).toEqual({ error: expect.any(String) });
  });
});

// ── #362: webapp-info — the absolute webapp_url (D11) + the closed reason (m-5) ─

/** The sandbox gateway flaking on exactly the mount-record read (fix-ocr5
 * M-1's transient fault): every other read answers normally, so the
 * generation marker still reads current while the record read fails. */
function flakyMountRead(api: AgentSandboxFileApi): AgentSandboxFileApi {
  return {
    ...api,
    async readFile(path: string) {
      if (path === `${DIRECTORY}/${WEBAPP_MOUNT_MARKER}`) {
        throw new Error("sandbox gateway: read timed out");
      }
      return api.readFile(path);
    },
  };
}

/** Counts the mount-record reads (fix-ocr21 #3): the read is only consumed
 * by the ready-gated mismatch verdict, so it belongs inside the ready
 * branch — an unready session's 5s poll must not pay a sandbox read. */
function countingMountRead(
  api: AgentSandboxFileApi,
  spy: { count: number },
): AgentSandboxFileApi {
  return {
    ...api,
    async readFile(path: string) {
      if (path === `${DIRECTORY}/${WEBAPP_MOUNT_MARKER}`) spy.count += 1;
      return api.readFile(path);
    },
  };
}

/** The generation-marker read itself FAILS (fix-ocr26 #8): a sandbox-gateway
 * flake on exactly that call. The marker content on disk is current's own
 * "2" — a healthy read would answer "current" — so the flake must not be a
 * verdict. Only the MARKER path throws; the mount-record read stays healthy
 * so the two degraded reads never blur together. */
function flakyGenerationRead(api: AgentSandboxFileApi): AgentSandboxFileApi {
  return {
    ...api,
    async readFile(path: string) {
      if (path === `${DIRECTORY}/${WEBAPP_GENERATION_MARKER}`) {
        throw new Error("sandbox gateway: read timed out");
      }
      return api.readFile(path);
    },
  };
}

/** Counts EVERY readFile, on top of whatever narrower spy is stacked. */
function countingFileReads(
  api: AgentSandboxFileApi,
  spy: { count: number },
): AgentSandboxFileApi {
  return {
    ...api,
    async readFile(path: string) {
      spy.count += 1;
      return api.readFile(path);
    },
  };
}

const PREVIEW_ADDRESS = "http://127.0.0.1:3001/abc123label";

function infoRoutes(options: {
  previewOriginFor?: (sessionId: string) => string;
  previewOriginAdmission?: () => { ok: true } | { ok: false; reason: string };
  env?: Record<string, string | undefined>;
  ready?: boolean;
  /** Omit to model a LEGACY session (assembled before the marker existed). */
  currentGeneration?: boolean;
  /**
   * The .webapp-mount record the running script left (review-367 H's second
   * signal). undefined → the default for the generation: the current regime's
   * script wrote its own label ("/abc123label", PREVIEW_ADDRESS's path) for a
   * current app, NO record for a legacy one; false → NO record at all; a
   * string → that value, in either generation (fix-ocr27 #3: a
   * manually-assembled app carries no marker but still rides a script that
   * wrote its own record at spawn).
   */
  mountRecord?: string | false;
  /** The app body itself; false models the not-yet-assembled workspace. */
  appBody?: boolean;
  /**
   * The mount-record read itself FAILS (fix-ocr5 M-1): the sandbox gateway
   * flakes on exactly that call — a transient fault, not a verdict.
   */
  mountReadThrows?: boolean;
  /** Counts EVERY readFile (fix-ocr27 #4: the no-app generation read). */
  fileReadSpy?: { count: number };
  /** Counts `.webapp-mount` reads (fix-ocr21 #3). */
  mountReadSpy?: { count: number };
  /** The generation-marker read FAILS (fix-ocr26 #8) — a transient flake. */
  generationReadThrows?: boolean;
}) {
  const fetchImpl = (async () =>
    options.ready === false
      ? Promise.reject(new Error("down"))
      : Promise.resolve(
          new Response("x", {
            status: 200,
            headers: { "content-type": "text/html" },
          }),
        )) as typeof fetch;
  const api = memoryFileApi({
    ...(options.appBody === false
      ? {}
      : { [`${WEBAPP}/package.json`]: '{"name":"web"}' }),
    // A current-generation app carries the assembly marker; its absence
    // is the legacy population D10 routes to the old path.
    ...(options.currentGeneration === false
      ? {}
      : {
          [`${DIRECTORY}/${WEBAPP_GENERATION_MARKER}`]:
            WEBAPP_GENERATION_CURRENT,
        }),
    // The running script's own mount record (nextjs-dev.ts writes it beside
    // .nextjs-port): the second signal the address cross-check reads. The
    // GENERATION-DEFAULT when mountRecord is undefined — the current script's
    // record for a current app, no record for a legacy one — and an explicit
    // value (or false) overrides in either generation (fix-ocr27 #3).
    ...(options.mountRecord === undefined
      ? options.currentGeneration === false
        ? {}
        : { [`${DIRECTORY}/${WEBAPP_MOUNT_MARKER}`]: "/abc123label" }
      : options.mountRecord === false
        ? {}
        : { [`${DIRECTORY}/${WEBAPP_MOUNT_MARKER}`]: options.mountRecord }),
  });
  return createWebappProxyRoutes(fakeRequireUser(), {
    config: loadCraftConfig({}),
    store: storeWithSession("app", "u1", 3011),
    gateway: gatewayWith(
      (() => {
        let inner = options.mountReadThrows ? flakyMountRead(api) : api;
        if (options.generationReadThrows) inner = flakyGenerationRead(inner);
        if (options.mountReadSpy)
          inner = countingMountRead(inner, options.mountReadSpy);
        if (options.fileReadSpy)
          inner = countingFileReads(inner, options.fileReadSpy);
        return inner;
      })(),
    ),
    botIdFor: async () => "craft-bot",
    sandboxConnectionFor: () => ({
      baseUrl: "http://sbox.internal:4300",
      token: null,
    }),
    previewOriginFor: options.previewOriginFor,
    previewOriginAdmission: options.previewOriginAdmission,
    env: options.env,
    fetchImpl,
  });
}

describe("webapp-info: absolute webapp_url + previewOrigin + closed reason (D11/m-5)", () => {
  test("admission open: webapp_url and previewOrigin are the absolute preview address", async () => {
    const app = infoRoutes({ previewOriginFor: () => PREVIEW_ADDRESS });
    const response = await app.request(`/sessions/${SESSION_ID}/webapp-info`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      webapp_url: string | null;
      previewOrigin: string | null;
      previewOriginClosedReason: string | null;
      ready: boolean;
      webappGeneration: string;
    };
    expect(body.webapp_url).toBe(PREVIEW_ADDRESS);
    expect(body.previewOrigin).toBe(PREVIEW_ADDRESS);
    expect(body.previewOriginClosedReason).toBeNull();
    expect(body.ready).toBe(true);
    expect(body.webappGeneration).toBe("current");
  });

  test("admission closed: no address exists, the reason is displayable (m-5)", async () => {
    const app = infoRoutes({
      previewOriginAdmission: () => ({
        ok: false,
        reason: "Craft is disabled on this deployment.",
      }),
    });
    const response = await app.request(`/sessions/${SESSION_ID}/webapp-info`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      webapp_url: string | null;
      previewOrigin: string | null;
      previewOriginClosedReason: string | null;
      has_webapp: boolean;
    };
    expect(body.webapp_url).toBeNull();
    expect(body.previewOrigin).toBeNull();
    expect(body.previewOriginClosedReason).toBe(
      "Craft is disabled on this deployment.",
    );
    // The inspectable facts survive the closed gate — the pane still shows why.
    expect(body.has_webapp).toBe(true);
  });

  test("the default admission derives from PORT/SERVER_PORT (serverPort's rules): disagreement closes", async () => {
    const app = infoRoutes({
      previewOriginFor: undefined,
      env: { PORT: "3001", SERVER_PORT: "3002" },
    });
    const response = await app.request(`/sessions/${SESSION_ID}/webapp-info`);
    const body = (await response.json()) as {
      webapp_url: string | null;
      previewOriginClosedReason: string | null;
    };
    expect(body.webapp_url).toBeNull();
    expect(body.previewOriginClosedReason).toContain("PORT");
    expect(body.previewOriginClosedReason).toContain("SERVER_PORT");
  });

  test("fix-ocr20 #4: no injected previewOriginFor — webapp-info refuses fail-loud, it never guesses the port-root address", async () => {
    // The old fallback answered `http://127.0.0.1:3005` — no session label,
    // unroutable, and inconsistent with the mount cross-check (review-367 H)
    // that would flag it stale. A missing injection is a wiring bug: fail
    // loud like the closed branch, never hand the pane a guessed address.
    const app = infoRoutes({ env: { PORT: "3005" }, mountRecord: "" });
    const error = console.error;
    console.error = () => {}; // Hono's default 500 handler logs the expected throw
    let response: Response;
    try {
      response = await app.request(`/sessions/${SESSION_ID}/webapp-info`);
    } finally {
      console.error = error;
    }
    expect(response.status).toBe(500);
  });

  test("fix-ocr27 #4: no app — the generation read is short-circuited, the gateway pays no readFile for a verdict with no consumer", async () => {
    // The panel polls webapp-info every 5s through the whole build window —
    // exactly the window where has_webapp is still false. readWebappGeneration
    // would answer "current" there anyway (its own app-body probe runs first),
    // so the unconditional read was pure per-poll overhead; the answer is
    // short-circuited to the same verdict (fix-ocr21 #3's gate, one read
    // earlier; the same caliber as fix-ocr26 #8's unknown-folds-to-current).
    const spy = { count: 0 };
    const app = infoRoutes({
      appBody: false,
      previewOriginFor: () => PREVIEW_ADDRESS,
      fileReadSpy: spy,
    });
    const response = await app.request(`/sessions/${SESSION_ID}/webapp-info`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      has_webapp: boolean;
      webappGeneration: string;
      webapp_url: string | null;
      ready: boolean;
    };
    // The answer is behavior-identical to the read path's (the app-body probe
    // was always going to answer current) — only the read is gone.
    expect(body.has_webapp).toBe(false);
    expect(body.webappGeneration).toBe("current");
    expect(body.webapp_url).toBe(PREVIEW_ADDRESS);
    expect(body.ready).toBe(false);
    // RED: the generation read dialed the gateway once (the app-body probe)
    // even though nothing consumed its verdict.
    expect(spy.count).toBe(0);
  });

  test("an app that exists still pays the generation read — the short-circuit never swallows a verdict in use", async () => {
    const spy = { count: 0 };
    const app = infoRoutes({
      previewOriginFor: () => PREVIEW_ADDRESS,
      fileReadSpy: spy,
    });
    const response = await app.request(`/sessions/${SESSION_ID}/webapp-info`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { webappGeneration: string };
    expect(body.webappGeneration).toBe("current");
    expect(spy.count).toBeGreaterThanOrEqual(1);
  });

  test("no sandbox: the address fields stay null beside status no_sandbox", async () => {
    const app = createWebappProxyRoutes(fakeRequireUser(), {
      config: loadCraftConfig({}),
      store: storeWithSession("app", "u1", 3011),
      gateway: gatewayWith(
        memoryFileApi({ [`${WEBAPP}/package.json`]: '{"name":"web"}' }),
      ),
      botIdFor: async () => "craft-bot",
      sandboxConnectionFor: () => null,
      previewOriginFor: () => PREVIEW_ADDRESS,
    });
    const response = await app.request(`/sessions/${SESSION_ID}/webapp-info`);
    const body = (await response.json()) as {
      status: string;
      webapp_url: string | null;
      previewOrigin: string | null;
    };
    expect(body.status).toBe("no_sandbox");
    expect(body.webapp_url).toBeNull();
    expect(body.previewOrigin).toBeNull();
  });
});

// ── #367: webapp-info — the D10 legacy branch (old sessions keep the old path) ─

describe("webapp-info: legacy sessions stay on the old same-origin path (D10/#367)", () => {
  const LEGACY_PATH = `/api/craft/sessions/${SESSION_ID}/webapp`;

  test("a legacy app (no assembly marker) gets the OLD same-origin path, not the preview origin", async () => {
    const app = infoRoutes({
      currentGeneration: false,
      previewOriginFor: () => PREVIEW_ADDRESS,
    });
    const response = await app.request(`/sessions/${SESSION_ID}/webapp-info`);
    const body = (await response.json()) as {
      webapp_url: string | null;
      previewOrigin: string | null;
      previewOriginClosedReason: string | null;
      webappGeneration: string;
      has_webapp: boolean;
      ready: boolean;
    };
    // The pre-marker app self-mounts /api/craft/sessions/<id>/webapp via its
    // cwd-fallback template — pointing it at the preview origin instead would
    // be the silent 404 AC2 forbids.
    expect(body.webapp_url).toBe(LEGACY_PATH);
    expect(body.previewOrigin).toBeNull();
    expect(body.previewOriginClosedReason).toBeNull();
    expect(body.webappGeneration).toBe("legacy");
    expect(body.has_webapp).toBe(true);
    expect(body.ready).toBe(true);
  });

  test("the legacy path serves even where the preview origin is closed — no reason shown", async () => {
    const app = infoRoutes({
      currentGeneration: false,
      previewOriginAdmission: () => ({
        ok: false,
        reason: "The preview origin is disabled on this deployment.",
      }),
    });
    const response = await app.request(`/sessions/${SESSION_ID}/webapp-info`);
    const body = (await response.json()) as {
      webapp_url: string | null;
      previewOriginClosedReason: string | null;
    };
    // The old path needs no preview origin (same-origin, cookie-authenticated),
    // so a closed origin must not take a working legacy preview down with it.
    expect(body.webapp_url).toBe(LEGACY_PATH);
    expect(body.previewOriginClosedReason).toBeNull();
  });

  test("a legacy app whose dev server is down keeps the legacy path and the honest down state", async () => {
    const app = infoRoutes({
      currentGeneration: false,
      ready: false,
      previewOriginFor: () => PREVIEW_ADDRESS,
    });
    const response = await app.request(`/sessions/${SESSION_ID}/webapp-info`);
    const body = (await response.json()) as {
      webapp_url: string | null;
      status: string;
      ready: boolean;
    };
    expect(body.webapp_url).toBe(LEGACY_PATH);
    expect(body.status).toBe("stopped");
    expect(body.ready).toBe(false);
  });

  // ── fix-ocr27 #3: the legacy branch runs the same ready-gated mount ────────
  // cross-check the current branch does. "Legacy" has a hole the marker's
  // write point never closes: an app assembled OUTSIDE the template-copy
  // branch (an agent hand-creating outputs/web per the script's own error
  // hint) never gets a marker, so the judgment reads legacy forever — while
  // its provisioning-era script mounts /<label> and the RUNNING server serves
  // there. Handing that session the old same-origin path is the silent,
  // never-self-healing 404 #367 exists to prevent, re-read every 5s poll.
  // The record decides: non-empty and equal to the derived label mount → the
  // current-shape address flows; non-empty and different → the
  // WEBAPP_MOUNT_STALE repair sentence; empty/absent/unreadable → the true
  // legacy answer, byte-for-byte unchanged.
  test("fix-ocr27 #3: a legacy-judged app whose record names the derived label mount gets the preview address (the manual-assembly middle state heals)", async () => {
    const app = infoRoutes({
      currentGeneration: false,
      mountRecord: "/abc123label",
      previewOriginFor: () => PREVIEW_ADDRESS,
    });
    const response = await app.request(`/sessions/${SESSION_ID}/webapp-info`);
    const body = (await response.json()) as {
      webapp_url: string | null;
      previewOrigin: string | null;
      previewOriginClosedReason: string | null;
      webappGeneration: string;
      status: string;
      ready: boolean;
    };
    // RED: the old path was handed out unconditionally — the basePath-mounted
    // app 404s it on every request, and no poll ever corrected it.
    expect(body.webapp_url).toBe(PREVIEW_ADDRESS);
    expect(body.previewOrigin).toBe(PREVIEW_ADDRESS);
    expect(body.previewOriginClosedReason).toBeNull();
    expect(body.webappGeneration).toBe("current");
    expect(body.ready).toBe(true);
    expect(body.status).toBe("running");
  });

  test("fix-ocr27 #3: a legacy-judged app whose record names ANOTHER mount → no address, the needs-restart sentence", async () => {
    const app = infoRoutes({
      currentGeneration: false,
      mountRecord: "/some-other-label",
      previewOriginFor: () => PREVIEW_ADDRESS,
    });
    const response = await app.request(`/sessions/${SESSION_ID}/webapp-info`);
    const body = (await response.json()) as {
      webapp_url: string | null;
      previewOriginClosedReason: string | null;
      status: string;
      ready: boolean;
    };
    expect(body.webapp_url).toBeNull();
    expect(body.previewOriginClosedReason).toContain("start script");
    expect(body.ready).toBe(true);
    expect(body.status).toBe("running");
  });

  test("fix-ocr27 #3: an EMPTY record is the true legacy — the old path stands byte-for-byte (regression pin)", async () => {
    const app = infoRoutes({
      currentGeneration: false,
      mountRecord: "",
      previewOriginFor: () => PREVIEW_ADDRESS,
    });
    const response = await app.request(`/sessions/${SESSION_ID}/webapp-info`);
    const body = (await response.json()) as {
      webapp_url: string | null;
      previewOrigin: string | null;
      previewOriginClosedReason: string | null;
      webappGeneration: string;
    };
    expect(body.webapp_url).toBe(LEGACY_PATH);
    expect(body.previewOrigin).toBeNull();
    expect(body.previewOriginClosedReason).toBeNull();
    expect(body.webappGeneration).toBe("legacy");
  });

  test("fix-ocr27 #3: the legacy cross-check is ready-gated — an unready session pays no record read and keeps the old path", async () => {
    const spy = { count: 0 };
    const app = infoRoutes({
      currentGeneration: false,
      mountRecord: "/abc123label",
      ready: false,
      previewOriginFor: () => PREVIEW_ADDRESS,
      mountReadSpy: spy,
    });
    const response = await app.request(`/sessions/${SESSION_ID}/webapp-info`);
    const body = (await response.json()) as {
      webapp_url: string | null;
      ready: boolean;
    };
    expect(body.ready).toBe(false);
    expect(body.webapp_url).toBe(LEGACY_PATH);
    expect(spy.count).toBe(0);
  });

  test("fix-ocr27 #3: a closed origin with a label-mount record answers no address with the closed reason — never the silent-404 old path", async () => {
    const app = infoRoutes({
      currentGeneration: false,
      mountRecord: "/abc123label",
      previewOriginFor: () => PREVIEW_ADDRESS,
      previewOriginAdmission: () => ({
        ok: false,
        reason: "The preview origin is disabled on this deployment.",
      }),
    });
    const response = await app.request(`/sessions/${SESSION_ID}/webapp-info`);
    const body = (await response.json()) as {
      webapp_url: string | null;
      previewOriginClosedReason: string | null;
    };
    expect(body.webapp_url).toBeNull();
    expect(body.previewOriginClosedReason).toBe(
      "The preview origin is disabled on this deployment.",
    );
  });

  test("a current-generation app keeps the preview origin and says so", async () => {
    const app = infoRoutes({ previewOriginFor: () => PREVIEW_ADDRESS });
    const response = await app.request(`/sessions/${SESSION_ID}/webapp-info`);
    const body = (await response.json()) as {
      webapp_url: string | null;
      webappGeneration: string;
    };
    expect(body.webappGeneration).toBe("current");
    expect(body.webapp_url).toBe(PREVIEW_ADDRESS);
  });

  test("the generation read FLAKES → the current-shape answer stands: webapp_url is never rewritten to the old path (fix-ocr26 #8)", async () => {
    // The marker IS current's own "2"; only the read died. Folding the flake
    // into "legacy" rewrote webapp_url to /api/craft/... — an address the
    // dev server does not serve (it answers the preview mount) — the pane's
    // frame 404s until a full reload, silently. "unknown" keeps the address
    // the origin already minted: the stale-but-real shape, not a fabricated
    // generational fact. RED: the flake answered legacy and the address was
    // rewritten.
    const app = infoRoutes({
      previewOriginFor: () => PREVIEW_ADDRESS,
      generationReadThrows: true,
    });
    const response = await app.request(`/sessions/${SESSION_ID}/webapp-info`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      webapp_url: string | null;
      previewOrigin: string | null;
      previewOriginClosedReason: string | null;
      webappGeneration: string;
      ready: boolean;
    };
    expect(body.webapp_url).toBe(PREVIEW_ADDRESS);
    expect(body.previewOrigin).toBe(PREVIEW_ADDRESS);
    expect(body.previewOriginClosedReason).toBeNull();
    expect(body.ready).toBe(true);
  });

  test("an unavailable sandbox answers webappGeneration legacy (the conservative read)", async () => {
    const app = createWebappProxyRoutes(fakeRequireUser(), {
      config: loadCraftConfig({}),
      store: storeWithSession("app", "u1", 3011),
      gateway: gatewayWith(
        memoryFileApi({ [`${WEBAPP}/package.json`]: '{"name":"web"}' }),
      ),
      botIdFor: async () => "craft-bot",
      sandboxConnectionFor: () => null,
    });
    const response = await app.request(`/sessions/${SESSION_ID}/webapp-info`);
    const body = (await response.json()) as {
      status: string;
      webappGeneration: string;
    };
    expect(body.status).toBe("no_sandbox");
    expect(body.webappGeneration).toBe("legacy");
  });
});

// ── review-367 H: the mount-record cross-check — the REBUILD window ─────────
// A legacy session's agent deletes outputs/web and runs webapp start again:
// the OLD script's copy branch re-runs — copies the CURRENT disk template,
// re-stamps the marker "2" — but the script itself still carries no mount env
// (the generation judgment happened at script-WRITE time, and no script write
// point runs on a rebuild). The dev server mounts the port root while the
// fresh marker reads current: webapp-info handing out /<label> there is a
// silent, non-self-healing 404 on every request. The script's own mount
// record (.webapp-mount) is the second signal that catches it.

describe("webapp-info: the mount-record cross-check (review-367 H — the rebuild window)", () => {
  test("marker current + NO mount record (a legacy-era script re-stamped it) → no /<label> address, an explicit reason on the closed-reason channel", async () => {
    // The rebuild window exactly: the marker says current (the old script's
    // copy branch stamped it), but the script that stamped it predates the
    // record line — no .webapp-mount exists, so the RUNNING server cannot be
    // mounted where the address points. The address is withheld and the
    // displayable needs-restart sentence rides previewOriginClosedReason.
    const app = infoRoutes({
      previewOriginFor: () => PREVIEW_ADDRESS,
      mountRecord: false,
    });
    const response = await app.request(`/sessions/${SESSION_ID}/webapp-info`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      webapp_url: string | null;
      previewOrigin: string | null;
      previewOriginClosedReason: string | null;
      webappGeneration: string;
      has_webapp: boolean;
      ready: boolean;
    };
    expect(body.webapp_url).toBeNull();
    expect(body.previewOrigin).toBeNull();
    expect(body.previewOriginClosedReason).toContain("start script");
    expect(body.webappGeneration).toBe("current");
    // The inspectable facts stay honest: the app EXISTS and IS serving.
    expect(body.has_webapp).toBe(true);
    expect(body.ready).toBe(true);
  });

  test("marker current + a record naming a DIFFERENT mount → the same refusal", async () => {
    // A record that names anything other than the address's path is the same
    // broken contract: the server answers on a mount the address never hits.
    const app = infoRoutes({
      previewOriginFor: () => PREVIEW_ADDRESS,
      mountRecord: "/some-other-label",
    });
    const response = await app.request(`/sessions/${SESSION_ID}/webapp-info`);
    const body = (await response.json()) as {
      webapp_url: string | null;
      previewOriginClosedReason: string | null;
    };
    expect(body.webapp_url).toBeNull();
    expect(body.previewOriginClosedReason).toContain("start script");
  });

  test("ready=false → the cross-check stands down: a not-yet-serving session has no frame to misroute (fix-ocr18 #2)", async () => {
    // The FIRST-BUILD window (or a failed start): the script has not run far
    // enough to write .webapp-mount, so the record is absent. The mismatch
    // reading of an absent record used to fire regardless of readiness —
    // accusing the "old script" of a rebuild NO script has done yet, and
    // pointing the person at repair/regenerate for a first boot. A refusal
    // buys nothing here: the pane gates on `ready` and never points a frame
    // at the address in this state, so there is nothing the verdict could
    // protect. The mismatch judgment therefore runs only when ready=true —
    // a SERVING server whose record names another mount is the broken
    // contract; a not-yet-serving one is just not up yet.
    const app = infoRoutes({
      previewOriginFor: () => PREVIEW_ADDRESS,
      mountRecord: false,
      ready: false,
    });
    const response = await app.request(`/sessions/${SESSION_ID}/webapp-info`);
    const body = (await response.json()) as {
      webapp_url: string | null;
      previewOrigin: string | null;
      previewOriginClosedReason: string | null;
      ready: boolean;
      status: string;
    };
    expect(body.ready).toBe(false);
    expect(body.status).toBe("stopped");
    // RED (fix-ocr18 #2): the stale verdict fired on an unready session —
    // the address was withheld behind the needs-restart sentence.
    expect(body.webapp_url).toBe(PREVIEW_ADDRESS);
    expect(body.previewOrigin).toBe(PREVIEW_ADDRESS);
    expect(body.previewOriginClosedReason).toBeNull();
  });

  test("ready=false pays NO sandbox read for the record — the read rides the ready branch its verdict guards (fix-ocr21 #3)", async () => {
    // The panel polls webapp-info every 5s. While has_webapp && !ready the
    // mismatch verdict cannot fire (fix-ocr18 #2) — but the record READ sat
    // outside the ready gate, so every poll paid a sandbox-gateway file
    // read whose answer nothing consumed. The read moves INSIDE the ready
    // branch: only a serving session's verdict needs the record.
    const spy = { count: 0 };
    const app = infoRoutes({
      previewOriginFor: () => PREVIEW_ADDRESS,
      // A mismatching record proves the verdict would consume it if it
      // could — the read is skipped for a reason other than "no record".
      mountRecord: "/some-other-label",
      ready: false,
      mountReadSpy: spy,
    });
    const response = await app.request(`/sessions/${SESSION_ID}/webapp-info`);
    expect(response.status).toBe(200);
    expect(spy.count).toBe(0);
  });

  test("ready=true still reads the record — the verdict consumes it (fix-ocr21 #3, spy sanity)", async () => {
    const spy = { count: 0 };
    const app = infoRoutes({
      previewOriginFor: () => PREVIEW_ADDRESS,
      mountRecord: "/abc123label",
      mountReadSpy: spy,
    });
    const response = await app.request(`/sessions/${SESSION_ID}/webapp-info`);
    expect(response.status).toBe(200);
    expect(spy.count).toBeGreaterThanOrEqual(1);
  });

  test("marker current + the record read FAILS (a sandbox-gateway flake) → the address still flows (fix-ocr5 M-1)", async () => {
    // A transient read failure is not evidence of a stale mount. Collapsing
    // the fault into "no record" made a flaky gateway withhold the address
    // behind the needs-restart sentence even while ready=true — an
    // unnecessary repair loop for an app that is serving fine. Unverifiable
    // is not mismatched: the cross-check is skipped, the ready probe owns
    // availability, exactly as readWebappGeneration one branch up degrades
    // an unreadable workspace to the conservative-but-working path.
    const app = infoRoutes({
      previewOriginFor: () => PREVIEW_ADDRESS,
      mountRecord: "/abc123label",
      mountReadThrows: true,
    });
    const response = await app.request(`/sessions/${SESSION_ID}/webapp-info`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      webapp_url: string | null;
      previewOrigin: string | null;
      previewOriginClosedReason: string | null;
      ready: boolean;
    };
    expect(body.webapp_url).toBe(PREVIEW_ADDRESS);
    expect(body.previewOrigin).toBe(PREVIEW_ADDRESS);
    expect(body.previewOriginClosedReason).toBeNull();
    expect(body.ready).toBe(true);
  });

  test("marker current + the record matching the address's path → the address flows (regression)", async () => {
    const app = infoRoutes({
      previewOriginFor: () => PREVIEW_ADDRESS,
      mountRecord: "/abc123label",
    });
    const response = await app.request(`/sessions/${SESSION_ID}/webapp-info`);
    const body = (await response.json()) as {
      webapp_url: string | null;
      previewOriginClosedReason: string | null;
    };
    expect(body.webapp_url).toBe(PREVIEW_ADDRESS);
    expect(body.previewOriginClosedReason).toBeNull();
  });

  test("a closed origin skips the cross-check — its own reason already answers", async () => {
    // With no address in play there is no mount contract to violate; the
    // closed reason must not be overwritten by the cross-check's sentence.
    const app = infoRoutes({
      previewOriginFor: () => PREVIEW_ADDRESS,
      previewOriginAdmission: () => ({
        ok: false,
        reason: "Craft is disabled on this deployment.",
      }),
      mountRecord: false,
    });
    const response = await app.request(`/sessions/${SESSION_ID}/webapp-info`);
    const body = (await response.json()) as {
      previewOriginClosedReason: string | null;
    };
    expect(body.previewOriginClosedReason).toBe(
      "Craft is disabled on this deployment.",
    );
  });

  test("a root-mount address (pathname /) matches an empty record — the host-form script stays honest", async () => {
    // The host form's script carries no mount; its record is empty, and the
    // host-form address's pathname is "/" — normalized to the same empty
    // mount, so a working host-form session is never flagged needs-restart.
    const app = infoRoutes({
      previewOriginFor: () => "https://abc123label.preview.example.com",
      mountRecord: "",
    });
    const response = await app.request(`/sessions/${SESSION_ID}/webapp-info`);
    const body = (await response.json()) as {
      webapp_url: string | null;
      previewOriginClosedReason: string | null;
    };
    expect(body.webapp_url).toBe("https://abc123label.preview.example.com");
    expect(body.previewOriginClosedReason).toBeNull();
  });
});

// ── #367 H1 fix: the first-build birth sequence — script, mount and address ──
// decided together. review-367 H1: before this fix, a NEW session's provisioning
// read (no marker, no app) answered legacy, so the first script shipped root-
// path; the first `webapp start` then copied the CURRENT template, stamped the
// marker and spawned without env — the app mounted at "/" while webapp-info
// (reading the fresh marker) handed out /<label>: a silent, non-self-healing
// 404 on every dev-form first build. This sequence pins the whole birth end to
// end with the REAL dev-form derivation (a real HMAC label, real admission).

/** memoryFileApi whose store stays reachable, so a test can play the app's birth. */
function mutableFileApi(initial: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(initial));
  const api: AgentSandboxFileApi = {
    async listFiles(path: string) {
      const prefix = `${path}/`;
      const children = new Set<string>();
      for (const key of files.keys()) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        const first = rest.split("/")[0];
        children.add(rest.includes("/") ? `${prefix}${first}` : key);
      }
      if (children.size === 0) throw new Error(`not found: ${path}`);
      return [...children];
    },
    async writeFile(path: string, content: string) {
      files.set(path, content);
    },
    async writeFileBytes(path: string, content: Uint8Array) {
      files.set(path, new TextDecoder().decode(content));
    },
    async deletePath(path: string) {
      return files.delete(path);
    },
    async readFile(path: string) {
      return files.get(path) ?? null;
    },
    async readFileBytes(path: string) {
      const raw = files.get(path);
      return raw === undefined ? null : new TextEncoder().encode(raw);
    },
  };
  return { api, files };
}

describe("webapp-info: the first-build birth sequence (H1) — script, mount and address agree", () => {
  test("a session with no app yet gets a current-form script; the first start stamps current and every surface names the same mount", async () => {
    // The REAL dev-form origin: admission open via PORT, a real HMAC label.
    const origin = createPreviewOrigin({
      config: {
        enabled: true,
        webappProxyEnabled: true,
        previewOriginEnabled: true,
        previewOriginTemplate: "",
      },
      previewTickets: createPreviewTickets({
        store: storeWithSession("app"),
      }),
      secret: "birth-sequence-secret",
      env: { PORT: "3001" },
      servePreview: async () => new Response("unproxied", { status: 503 }),
    });
    const label = origin.webappBasePathFor(SESSION_ID);
    expect(label).toMatch(/^\/[0-9a-f]{20}$/);

    // 1. Provisioning writes the start script through the D10 gate BEFORE any
    //    app exists (no outputs/web, no marker — the exact H1 moment).
    const sandbox = mutableFileApi();
    const resolveBasePath = generationGatedWebappBasePathFor({
      webappBasePathFor: (sessionId) => origin.webappBasePathFor(sessionId),
      fileApiFor: () => sandbox.api,
      botIdFor: async () => "craft-bot",
      sessionDirectoryFor: () => DIRECTORY,
    });
    await writeWebappBootstrapScript(
      sandbox.api,
      SESSION_ID,
      loadCraftConfig({}),
      3011,
      resolveBasePath,
    );
    const script = sandbox.files.get(`${DIRECTORY}/start-webapp.sh`) ?? "";
    // THE H1 ASSERTION: the app the first start will assemble is born from the
    // CURRENT template, so the script must already carry the mount the preview
    // address rides — not the root-path legacy form.
    expect(script).toContain(`export ONYX_WEBAPP_BASE_PATH='${label}'`);
    expect(script).toContain(`export NEXT_PUBLIC_BASE_PATH='${label}'`);
    // The mount record rides the script too (review-367 H): the pane's
    // cross-check reads it once the server is running.
    expect(script).toContain(
      `printf '%s' '${label}' > "$SESSION_PATH/${WEBAPP_MOUNT_MARKER}"`,
    );

    // 2. The first `webapp start`: the copy branch copies the CURRENT template
    //    into outputs/web and stamps the marker before the spawn (the script's
    //    own semantics, replayed on the same workspace).
    sandbox.files.set(`${WEBAPP}/package.json`, '{"name":"web"}');
    sandbox.files.set(
      `${WEBAPP}/next.config.ts`,
      'const basePath = process.env.ONYX_WEBAPP_BASE_PATH ?? "";',
    );
    sandbox.files.set(
      `${DIRECTORY}/${WEBAPP_GENERATION_MARKER}`,
      `${WEBAPP_GENERATION_CURRENT}\n`,
    );
    // The record the (new) script writes beside the port record at spawn time —
    // the script's own semantics, replayed.
    sandbox.files.set(`${DIRECTORY}/${WEBAPP_MOUNT_MARKER}`, label);

    // 3. webapp-info after the first start: current, and the ABSOLUTE preview
    //    address (D11) — the same label the script mounts.
    const fetchImpl = (async () =>
      new Response("x", {
        status: 200,
        headers: { "content-type": "text/html" },
      })) as typeof fetch;
    const app = createWebappProxyRoutes(fakeRequireUser(), {
      config: loadCraftConfig({}),
      store: storeWithSession("app", "u1", 3011),
      gateway: gatewayWith(sandbox.api),
      botIdFor: async () => "craft-bot",
      sandboxConnectionFor: () => ({
        baseUrl: "http://sbox.internal:4300",
        token: null,
      }),
      previewOriginFor: (sessionId) => origin.originFor(sessionId),
      env: { PORT: "3001" },
      fetchImpl,
    });
    const response = await app.request(`/sessions/${SESSION_ID}/webapp-info`);
    const body = (await response.json()) as {
      webapp_url: string | null;
      previewOrigin: string | null;
      webappGeneration: string;
      ready: boolean;
    };
    const address = origin.originFor(SESSION_ID);
    expect(body.webappGeneration).toBe("current");
    expect(body.webapp_url).toBe(address);
    expect(body.previewOrigin).toBe(address);
    expect(body.ready).toBe(true);
    // The address and the mount are the SAME derivation, one reading apart.
    expect(address.startsWith(`http://127.0.0.1:3001${label}`)).toBe(true);

    // 4. appPathFor forwards the label pathname VERBATIM — the env-mounted app
    //    answers exactly the path the pane's iframe and the proxy dial. The
    //    pre-H1 first build broke precisely this leg (app at "/", path /<label>).
    expect(origin.appPathFor(new Request(`${address}/`))).toBe(`${label}/`);
    expect(
      origin.appPathFor(new Request(`${address}/_next/static/chunk.js`)),
    ).toBe(`${label}/_next/static/chunk.js`);
  });
});

// ── fix-ocr4 #8: the mount record mirrors the RUNNING server ────────────
// The .webapp-mount printf used to sit OUTSIDE both branches, so a reused
// (still-live) server's record was rewritten from whatever the REWRITTEN
// script now carries — after a label re-mint (e.g. key rotation) the record
// named a mount the running server never mounted, and webapp-info's
// cross-check (review-367 H) was fooled into handing out an address that
// 404s. The record's semantics: "the mount the RUNNING server was spawned
// with" — written only where a server is born (the respawn branch).
//
// These tests EXECUTE the real generated script (bash, with PATH shims for
// the sandbox-side binaries: flock/readlink/curl, and setsid/bun on the
// spawn path) rather than replaying its semantics by hand.

describe("start-webapp.sh: the mount record mirrors the RUNNING server (fix-ocr4)", () => {
  function makeShims(dir: string, shims: Record<string, string>) {
    const shimDir = join(dir, "bin");
    mkdirSync(shimDir, { recursive: true });
    for (const [name, body] of Object.entries(shims)) {
      const path = join(shimDir, name);
      writeFileSync(path, body);
      chmodSync(path, 0o755);
    }
    return shimDir;
  }

  function scaffoldSession(dir: string) {
    mkdirSync(join(dir, "outputs/web/node_modules/.bin"), {
      recursive: true,
    });
    writeFileSync(join(dir, "outputs/web/package.json"), '{"name":"web"}');
    // An existing install: the spawn branch must not need bun install.
    writeFileSync(
      join(dir, "outputs/web/node_modules/.bin/next"),
      "#!/bin/sh\n",
    );
    chmodSync(join(dir, "outputs/web/node_modules/.bin/next"), 0o755);
  }

  function runScript(
    sessionDir: string,
    script: string,
    shimDir: string,
    env: Record<string, string> = {},
  ) {
    writeFileSync(join(sessionDir, "start-webapp.sh"), script);
    return spawnSync("bash", [join(sessionDir, "start-webapp.sh")], {
      encoding: "utf8",
      cwd: sessionDir,
      timeout: 30_000,
      env: {
        ...process.env,
        PATH: `${shimDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
        ...env,
      },
    });
  }

  test("a reused (still-live) server keeps its own mount record even when the rewritten script carries a different basePath", () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "craft-reuse-"));
    scaffoldSession(sessionDir);
    // A RUNNING server: a live pid whose cwd (the identity guard's second
    // half) names this session's app dir. readlink is shimmed because /proc
    // does not exist off Linux; the LIVE pid is real so the builtin kill -0
    // exercises the recycled-pid half of the guard honestly.
    const sleeper = Bun.spawn(["sleep", "30"]);
    try {
      writeFileSync(join(sessionDir, "nextjs.pid"), `${sleeper.pid}`);
      // The record the RUNNING server's OWN script wrote when it spawned —
      // a mount the current script no longer carries (e.g. the label was
      // re-minted by a key rotation and the script was rewritten).
      writeFileSync(join(sessionDir, WEBAPP_MOUNT_MARKER), "/old-label");

      const shimDir = makeShims(sessionDir, {
        flock: "#!/bin/sh\nexit 0\n",
        readlink: '#!/bin/sh\nprintf "%s\\n" "$SHIM_CWD"\n',
        curl: "#!/bin/sh\nexit 0\n",
      });
      const script = buildWebappBootstrapScript({
        sessionDirectory: sessionDir,
        port: 3011,
        basePath: "/new-label",
      });
      const run = runScript(sessionDir, script, shimDir, {
        SHIM_CWD: join(sessionDir, "outputs/web"),
      });
      expect(run.status).toBe(0);
      expect(run.stdout).toContain("already running");
      // THE FIX: the reuse branch never respawns, so the record still names
      // what the RUNNING server was spawned with — webapp-info's cross-check
      // can see the script/assembly mismatch instead of being fooled.
      expect(readFileSync(join(sessionDir, WEBAPP_MOUNT_MARKER), "utf8")).toBe(
        "/old-label",
      );
    } finally {
      sleeper.kill();
    }
  });

  test("the respawn branch records the mount the freshly spawned server carries", () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "craft-respawn-"));
    scaffoldSession(sessionDir);
    // No pid file: the identity guard fails, the branch spawns — and the
    // record must be (re)written from THIS script's basePath.
    const shimDir = makeShims(sessionDir, {
      flock: "#!/bin/sh\nexit 0\n",
      curl: "#!/bin/sh\nexit 0\n",
      setsid: '#!/bin/sh\nexec "$@"\n',
      bun: "#!/bin/sh\nexit 0\n",
    });
    const script = buildWebappBootstrapScript({
      sessionDirectory: sessionDir,
      port: 3011,
      basePath: "/new-label",
    });
    const run = runScript(sessionDir, script, shimDir);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("Next.js server started");
    expect(readFileSync(join(sessionDir, WEBAPP_MOUNT_MARKER), "utf8")).toBe(
      "/new-label",
    );
  });
});

// ── #362: the issuing route respects admission (never mint into a closed origin) ─

describe("POST /sessions/:id/preview-ticket: admission gate", () => {
  function ticketApp(
    admission?: () => { ok: true } | { ok: false; reason: string },
  ) {
    return createWebappProxyRoutes(fakeRequireUser(), {
      config: loadCraftConfig({}),
      store: storeWithSession("app", "u1", 3011),
      // fix-ocr24 #5: the workspace carries the current-generation marker —
      // the mint now reads the same generation judgment webapp-info answers
      // from, and a legacy workspace (app body without the marker) refuses
      // 409 before any ticket is bound.
      gateway: gatewayWith(
        memoryFileApi({
          [`${WEBAPP}/package.json`]: '{"name":"web"}',
          [`${DIRECTORY}/${WEBAPP_GENERATION_MARKER}`]:
            WEBAPP_GENERATION_CURRENT,
        }),
      ),
      botIdFor: async () => "craft-bot",
      sandboxConnectionFor: () => ({
        baseUrl: "http://sbox.internal:4300",
        token: null,
      }),
      previewOriginFor: () => "http://127.0.0.1:3005/label",
      previewOriginAdmission: admission,
      previewTickets: createPreviewTickets({ store: storeWithSession("app") }),
    });
  }

  // ── #411 (P0): the TLS renewal-status file closes the origin end to end ──────
  //
  // A REAL origin (no admission stub) whose gate derives from
  // OPENBOT_TLS_STATUS_FILE — pointed at a temp path that was never written, the
  // "certificate state unknown" case — must close the surfaces the pane drives:
  // webapp-info answers previewOrigin null with the closed reason, and the ticket
  // route answers 503 with the same sentence. This is the AC6/AC8 pairing the
  // five-band matrix in craft-preview-origin.test.ts judges at the origin itself.
  test("#411: a missing renewal-status.json closes webapp-info (null + reason) and the ticket route (503)", async () => {
    const statusDir = mkdtempSync(join(tmpdir(), "openbot-tls-status-w411-"));
    const origin = createPreviewOrigin({
      config: {
        enabled: true,
        webappProxyEnabled: true,
        previewOriginEnabled: true,
        previewOriginTemplate: "https://{session}.preview.example.com",
      },
      previewTickets: createPreviewTickets({ store: storeWithSession("app") }),
      secret: "w411-test-secret",
      env: {
        OPENBOT_TLS_STATUS_FILE: join(statusDir, "renewal-status.json"),
      },
      servePreview: async () => new Response("unproxied", { status: 503 }),
    });
    const app = createWebappProxyRoutes(fakeRequireUser(), {
      config: loadCraftConfig({}),
      store: storeWithSession("app", "u1", 3011),
      gateway: gatewayWith(
        memoryFileApi({
          [`${WEBAPP}/package.json`]: '{"name":"web"}',
          [`${DIRECTORY}/${WEBAPP_GENERATION_MARKER}`]:
            WEBAPP_GENERATION_CURRENT,
        }),
      ),
      botIdFor: async () => "craft-bot",
      sandboxConnectionFor: () => ({
        baseUrl: "http://sbox.internal:4300",
        token: null,
      }),
      previewOriginFor: () => {
        throw new Error("a closed origin has no address to mint");
      },
      previewOriginAdmission: origin.admission,
      previewTickets: createPreviewTickets({ store: storeWithSession("app") }),
    });

    const info = await app.request(`/sessions/${SESSION_ID}/webapp-info`);
    expect(info.status).toBe(200);
    const body = (await info.json()) as {
      previewOrigin: string | null;
      previewOriginClosedReason: string | null;
    };
    expect(body.previewOrigin).toBeNull();
    expect(body.previewOriginClosedReason).toContain("it is missing");
    expect(body.previewOriginClosedReason).toContain("OPENBOT_TLS_STATUS_FILE");

    const ticket = await app.request(`/sessions/${SESSION_ID}/preview-ticket`, {
      method: "POST",
    });
    expect(ticket.status).toBe(503);
    const refusal = (await ticket.json()) as { error: string };
    expect(refusal.error).toContain("it is missing");
  });

  test("closed admission → 503 with the displayable reason, nothing minted", async () => {
    const tickets = createPreviewTickets({ store: storeWithSession("app") });
    const app = createWebappProxyRoutes(fakeRequireUser(), {
      config: loadCraftConfig({}),
      store: storeWithSession("app", "u1", 3011),
      gateway: gatewayWith(
        memoryFileApi({ [`${WEBAPP}/package.json`]: '{"name":"web"}' }),
      ),
      botIdFor: async () => "craft-bot",
      sandboxConnectionFor: () => ({
        baseUrl: "http://sbox.internal:4300",
        token: null,
      }),
      previewOriginFor: () => "http://127.0.0.1:3005/label",
      previewOriginAdmission: () => ({
        ok: false,
        reason: "The preview origin is disabled on this deployment.",
      }),
      previewTickets: tickets,
    });
    const response = await app.request(
      `/sessions/${SESSION_ID}/preview-ticket`,
      {
        method: "POST",
      },
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "The preview origin is disabled on this deployment.",
    });
    expect(tickets.size()).toBe(0);
  });

  test("open admission mints bound to the injected origin (regression)", async () => {
    const app = ticketApp();
    const response = await app.request(
      `/sessions/${SESSION_ID}/preview-ticket`,
      {
        method: "POST",
      },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { origin: string; ticket: string };
    expect(body.origin).toBe("http://127.0.0.1:3005/label");
  });

  test("#406: the mint answers no-store and no-referrer — a bearer credential never caches and never names its referrer", async () => {
    const app = ticketApp();
    const response = await app.request(
      `/sessions/${SESSION_ID}/preview-ticket`,
      {
        method: "POST",
      },
    );
    expect(response.status).toBe(200);
    // The body IS the credential: its 30s life must not survive in any
    // shared cache, and the pane's navigation to the origin (the one hop
    // where the ticket rides a query) must not carry this URL onward as a
    // Referer the preview origin's proxy could forward or log.
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });

  test("fix-ocr20 #4: no injected previewOriginFor — the minting leg refuses fail-loud, it never guesses an address", async () => {
    // The old default fallback answered the port root (`http://127.0.0.1:3005`)
    // when the port parsed — an address with no session label on it that no
    // preview origin ever mints, and one the mount cross-check would call
    // stale. A missing injection is a WIRING bug (production always injects,
    // index.ts wires the real origin), so the default refuses loudly like the
    // closed branch — never a silent guess.
    const tickets = createPreviewTickets({ store: storeWithSession("app") });
    const app = createWebappProxyRoutes(fakeRequireUser(), {
      config: loadCraftConfig({}),
      store: storeWithSession("app", "u1", 3011),
      gateway: gatewayWith(
        memoryFileApi({ [`${WEBAPP}/package.json`]: '{"name":"web"}' }),
      ),
      botIdFor: async () => "craft-bot",
      sandboxConnectionFor: () => ({
        baseUrl: "http://sbox.internal:4300",
        token: null,
      }),
      previewOriginFor: undefined,
      // The default admission derives OPEN from this port — the gate is not
      // what refuses here; the missing injection is.
      env: { PORT: "3005" },
      previewTickets: tickets,
    });
    const error = console.error;
    console.error = () => {}; // Hono's default 500 handler logs the expected throw
    let response: Response;
    try {
      response = await app.request(`/sessions/${SESSION_ID}/preview-ticket`, {
        method: "POST",
      });
    } finally {
      console.error = error;
    }
    expect(response.status).toBe(500);
    expect(tickets.size()).toBe(0); // nothing minted into a guessed address
  });
});

// ── fix-ocr24 #5: the D10 generation gate on the ticket face ─────────────
// webapp-info re-routes a legacy session to the OLD same-origin path, but the
// issuing route minted preview-origin tickets for it all the same — a ticket
// whose redemption lands on a preview address the legacy app is not mounted
// on (its dev server answers the old prefix), i.e. the silent-404 middle
// state #367 exists to prevent, reachable by direct API call. The mint reads
// the same generation judgment webapp-info does; legacy refuses 409.
describe("POST /sessions/:id/preview-ticket: the D10 generation gate (fix-ocr24 #5)", () => {
  function generationApp(files: Record<string, string>) {
    const tickets = createPreviewTickets({ store: storeWithSession("app") });
    const app = createWebappProxyRoutes(fakeRequireUser(), {
      config: loadCraftConfig({}),
      store: storeWithSession("app", "u1", 3011),
      gateway: gatewayWith(memoryFileApi(files)),
      botIdFor: async () => "craft-bot",
      sandboxConnectionFor: () => ({
        baseUrl: "http://sbox.internal:4300",
        token: null,
      }),
      previewOriginFor: () => "http://127.0.0.1:3005/label",
      previewTickets: tickets,
    });
    return { app, tickets };
  }

  test("a legacy session's mint refuses 409 with a displayable sentence — nothing is minted", async () => {
    // App body present, no generation marker: exactly the workspace
    // readWebappGeneration answers "legacy" on (the population D10 routes to
    // the old path). Minting a preview-origin ticket for it would hand out an
    // address that 404s after redemption.
    const { app, tickets } = generationApp({
      [`${WEBAPP}/package.json`]: '{"name":"web"}',
    });
    const response = await app.request(
      `/sessions/${SESSION_ID}/preview-ticket`,
      { method: "POST" },
    );
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: string };
    expect(typeof body.error).toBe("string");
    expect(body.error.length).toBeGreaterThan(0);
    expect(tickets.size()).toBe(0);
  });

  test("a current session's mint still answers 200 bound to the injected origin (regression pin)", async () => {
    // The marker stamps current: the gate must only close for legacy, never
    // tax the population the preview origin serves.
    const { app } = generationApp({
      [`${WEBAPP}/package.json`]: '{"name":"web"}',
      [`${DIRECTORY}/${WEBAPP_GENERATION_MARKER}`]: WEBAPP_GENERATION_CURRENT,
    });
    const response = await app.request(
      `/sessions/${SESSION_ID}/preview-ticket`,
      { method: "POST" },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { origin: string };
    expect(body.origin).toBe("http://127.0.0.1:3005/label");
  });

  test("fix-ocr27 #3: a legacy-judged app whose mount record names the derived label MINTS — the healed middle state reaches the ticket too", async () => {
    // The webapp-info face heals (fix-ocr27 #3: the label-mount record is
    // proof the running server serves the preview address's mount), so the
    // mint must read the same fact — otherwise the pane exchanges into a 409
    // whose sentence ("predates the preview origin") contradicts the address
    // webapp-info just served. The mirror is the discipline (the D10 gate's
    // own header), not a shared abstraction. RED: the mint refused 409.
    const { app, tickets } = generationApp({
      [`${WEBAPP}/package.json`]: '{"name":"web"}',
      // No generation marker (the manual-assembly hole), but the running
      // script's own record: the mount the server was spawned under.
      [`${DIRECTORY}/${WEBAPP_MOUNT_MARKER}`]: "/label",
    });
    const response = await app.request(
      `/sessions/${SESSION_ID}/preview-ticket`,
      { method: "POST" },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { origin: string };
    expect(body.origin).toBe("http://127.0.0.1:3005/label");
    expect(tickets.size()).toBe(1);
  });

  test("fix-ocr27 #3: a legacy-judged app whose record names ANOTHER mount still refuses 409 — unproven mounts mint nothing", async () => {
    const { app, tickets } = generationApp({
      [`${WEBAPP}/package.json`]: '{"name":"web"}',
      [`${DIRECTORY}/${WEBAPP_MOUNT_MARKER}`]: "/some-other-label",
    });
    const response = await app.request(
      `/sessions/${SESSION_ID}/preview-ticket`,
      { method: "POST" },
    );
    expect(response.status).toBe(409);
    expect(tickets.size()).toBe(0);
  });

  test("the generation read FLAKES → 503 with a retryable sentence, never the legacy 409 (fix-ocr26 #8)", async () => {
    // The marker on disk is current's own "2" — only the read died. The old
    // fold answered "legacy" and the mint refused 409 with the legacy-race
    // sentence: a generational FACT the flake never established, pointing a
    // retrying person at reopen-the-session for a gateway hiccup. "unknown"
    // refuses with 503 + a sentence that names the real state: unverifiable
    // NOW, worth a retry. RED: the flake collapsed to legacy → 409.
    const { tickets } = generationApp({
      [`${WEBAPP}/package.json`]: '{"name":"web"}',
      [`${DIRECTORY}/${WEBAPP_GENERATION_MARKER}`]: WEBAPP_GENERATION_CURRENT,
    });
    // Wrap the gateway's file API so only the marker read flakes.
    const flaky = createWebappProxyRoutes(fakeRequireUser(), {
      config: loadCraftConfig({}),
      store: storeWithSession("app", "u1", 3011),
      gateway: gatewayWith(
        flakyGenerationRead(
          memoryFileApi({
            [`${WEBAPP}/package.json`]: '{"name":"web"}',
            [`${DIRECTORY}/${WEBAPP_GENERATION_MARKER}`]:
              WEBAPP_GENERATION_CURRENT,
          }),
        ),
      ),
      botIdFor: async () => "craft-bot",
      sandboxConnectionFor: () => ({
        baseUrl: "http://sbox.internal:4300",
        token: null,
      }),
      previewOriginFor: () => "http://127.0.0.1:3005/label",
      previewTickets: tickets,
    });
    const response = await flaky.request(
      `/sessions/${SESSION_ID}/preview-ticket`,
      { method: "POST" },
    );
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: string };
    expect(typeof body.error).toBe("string");
    expect(body.error.length).toBeGreaterThan(0);
    expect(tickets.size()).toBe(0);
  });
});

// ── fix-ocr13: the same-origin liveness probe ──────────────────────────────
// round13 H: the pane's frame-load probe used to be a CROSS-ORIGIN credentialed
// fetch of the preview address — but without CORS headers the status is
// unreadable (TypeError, indistinguishable from network death), and in the dev
// form a post-restart registry is empty so the probe path falls to the MAIN
// site's no-CORS 200/404 — a clean misjudgment in both directions. The probe is
// therefore a SAME-ORIGIN endpoint on this very surface: the session's label is
// in the origin registry (it re-registers at originFor) and admission is open →
// 204; anything else → 503 with a displayable sentence. Ticket/cookie semantics
// are untouched — the probe reads registry state, never credentials.

describe("GET /sessions/:id/preview-origin-live: the same-origin probe (fix-ocr13)", () => {
  function probeApp(options: {
    admission?: () => { ok: true } | { ok: false; reason: string };
    hasSession?: (sessionId: string) => boolean;
  }) {
    return createWebappProxyRoutes(fakeRequireUser(), {
      config: loadCraftConfig({}),
      store: storeWithSession("app", "u1", 3011),
      gateway: gatewayWith(
        memoryFileApi({ [`${WEBAPP}/package.json`]: '{"name":"web"}' }),
      ),
      botIdFor: async () => "craft-bot",
      sandboxConnectionFor: () => ({
        baseUrl: "http://sbox.internal:4300",
        token: null,
      }),
      previewOriginAdmission: options.admission,
      previewOriginHas: options.hasSession,
    });
  }

  test("a registered label under open admission → 204, no body", async () => {
    const app = probeApp({
      admission: () => ({ ok: true }),
      hasSession: (sessionId) => sessionId === SESSION_ID,
    });
    const response = await app.request(
      `/sessions/${SESSION_ID}/preview-origin-live`,
    );
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
  });

  test("the restart state (label not registered) → 503 with the re-enter sentence", async () => {
    // M-2: the registry is in-process — a fresh server has the session's row
    // (durable) but none of its labels (memory), which is exactly the verdict
    // the pane needs to drop a dead entry and re-enter through the main site.
    const app = probeApp({
      admission: () => ({ ok: true }),
      hasSession: () => false,
    });
    const response = await app.request(
      `/sessions/${SESSION_ID}/preview-origin-live`,
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "The preview origin restarted; re-enter the preview.",
    });
  });

  test("admission closed → 503 with the displayable reason (the gate's own words)", async () => {
    const app = probeApp({
      admission: () => ({
        ok: false,
        reason: "The preview origin is disabled on this deployment.",
      }),
      hasSession: () => true,
    });
    const response = await app.request(
      `/sessions/${SESSION_ID}/preview-origin-live`,
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "The preview origin is disabled on this deployment.",
    });
  });

  test("a session that is not the actor's → 404 (ownership, like every route here)", async () => {
    const app = probeApp({
      admission: () => ({ ok: true }),
      hasSession: () => true,
    });
    const response = await app.request(
      `/sessions/someone-elses/preview-origin-live`,
    );
    expect(response.status).toBe(404);
  });

  test("fix-ocr27 #5: a missing previewOriginHas injection throws — a wiring bug is never disguised as a restart", async () => {
    // The silent `?? false` answered a missing injection with the restart
    // sentence forever: the pane drops the entry and re-enters, but re-entry
    // re-registers the label through originFor — which never runs when the
    // injection itself is missing. A permanent 503 loop the person cannot
    // self-heal, wearing a restart mask over a wiring bug. Isomorphic with
    // previewOriginFor's fix-ocr20 #4: production always injects (index.ts),
    // so a call without one throws. RED: the route answered 503.
    const app = probeApp({ admission: () => ({ ok: true }) });
    const error = console.error;
    console.error = () => {}; // Hono's default 500 handler logs the expected throw
    let response: Response;
    try {
      response = await app.request(
        `/sessions/${SESSION_ID}/preview-origin-live`,
      );
    } finally {
      console.error = error;
    }
    expect(response.status).toBe(500);
  });

  test("the probe is a route-class read: it does NOT feed the idle clock (fix-ocr18 #1)", async () => {
    // The panel polls this endpoint on a fixed cadence for as long as the
    // preview pane exists. resolve() reads through store.getSession — the
    // OWNING read that bumps lastActivityAt (the update_session_activity
    // semantic) — so an otherwise-idle session with an open pane would
    // never go quiet and the reaper would never collect it. The read must
    // ride findSession (the same no-bump read the sandbox-status poll was
    // moved to), with the SAME ownership check — a stranger's session id
    // still answers 404.
    let activityBumps = 0;
    const app = createWebappProxyRoutes(fakeRequireUser(), {
      config: loadCraftConfig({}),
      // The store double counts every owning read as the bump it really is:
      // the real getSession stamps lastActivityAt inside itself, so a call
      // IS a feed. findSession answers the same row without touching it.
      store: {
        async getSession(id: string, userId: string) {
          if (id === SESSION_ID && userId === "u1") {
            activityBumps += 1;
            return sessionRow("app", 3011);
          }
          return undefined;
        },
        async findSession(id: string, userId: string) {
          return id === SESSION_ID && userId === "u1"
            ? sessionRow("app", 3011)
            : undefined;
        },
        async updateSessionActivity() {
          activityBumps += 1;
        },
      } as unknown as CraftStore,
      gateway: gatewayWith(
        memoryFileApi({ [`${WEBAPP}/package.json`]: '{"name":"web"}' }),
      ),
      botIdFor: async () => "craft-bot",
      sandboxConnectionFor: () => ({
        baseUrl: "http://sbox.internal:4300",
        token: null,
      }),
      previewOriginAdmission: () => ({ ok: true }),
      previewOriginHas: () => true,
    });

    const response = await app.request(
      `/sessions/${SESSION_ID}/preview-origin-live`,
    );
    expect(response.status).toBe(204);
    // RED (fix-ocr18 #1): the probe resolved through the bumping read —
    // one poll, one feed; a polling pane pins the session awake forever.
    expect(activityBumps).toBe(0);
  });
});

// ── fix-ocr15: the shared refusal sink's own contract ──────────────────────
// refuseResponse is the one HTML sink both preview surfaces share (the
// proxy's refusals and the preview origin's 401 pass refusal), so its page
// must hold the same lines every other HTML surface here holds: message
// content fully escaped in an attribute-hostile way (both quote flavors —
// the message is server-authored today, but this is an HTML sink and a
// caller-supplied string must never become script or break out of an
// attribute), and the hardening headers the proxied app's own responses
// already carry (a strict CSP — the inline <style> needs its one exception —
// plus nosniff so a browser never re-sniffs the page into something
// executable).
describe("refuseResponse — the shared HTML/JSON refusal sink (fix-ocr15)", () => {
  const htmlRequest = () =>
    new Request("http://127.0.0.1:3001/x/", {
      headers: { accept: "text/html,application/xhtml+xml" },
    });

  test("the HTML page escapes single quotes as &#39;, not just double quotes", async () => {
    const response = refuseResponse(
      htmlRequest(),
      "The web app is not running. Ask the agent to call the webapp tool with action 'start'.",
    );
    const body = await response.text();
    // The apostrophes are entity-encoded; no raw one survives in the page.
    expect(body).toContain("&#39;start&#39;");
    expect(body).not.toContain("'start'");
  });

  test("the HTML response carries the hardening headers: strict CSP + nosniff", () => {
    const response = refuseResponse(
      htmlRequest(),
      "The sandbox is not available.",
    );
    expect(response.headers.get("content-security-policy")).toBe(
      "default-src 'none'; style-src 'unsafe-inline'",
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("the JSON branch keeps its shape — no CSP/HTML hardening demanded there", () => {
    const response = refuseResponse(
      new Request("http://127.0.0.1:3001/x/"),
      "down",
    );
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("x-content-type-options")).toBeNull();
  });

  test("both branches answer no-store — a refusal is never a cacheable answer (fix-ocr18 #4)", () => {
    // A refusal describes a TRANSIENT state (the sandbox is down, the origin
    // restarted, the pass is missing). A 404 is default-cacheable per
    // RFC 7234 and a 503 can be heuristically stored — either one cached by
    // an intermediary or the browser would keep answering a request whose
    // refusal has long expired. The family discipline already marks the
    // probe's 204 no-store for exactly this reason; both refusal shapes
    // hold the same line.
    const json = refuseResponse(
      new Request("http://127.0.0.1:3001/x/"),
      "down",
    );
    expect(json.headers.get("cache-control")).toBe("no-store");
    const html = refuseResponse(htmlRequest(), "The web app is not running.");
    expect(html.headers.get("cache-control")).toBe("no-store");
  });
});

// ── fix-ocr28 #4: the .webapp-mount read is ONE helper behind three verdicts ──
//
// The readFile + trim + null-fold + catch for `.webapp-mount` (and the
// expectedMount fold of the preview address's path) used to be spelled
// verbatim at THREE sites: the preview-ticket mint's legacy-heal mirror and
// webapp-info's legacy/current branches. Any one site drifting its fold or
// its null-shape would make the ticket route and webapp-info disagree about
// the SAME session's record — the two surfaces are documented mirrors
// (webapp-generation.ts's header), so the READ is now one module-level
// helper (readMountRecord) and the mount fold one derivation
// (expectedMountFor). The CONSUMERS' semantics stay separate by design
// (recordProvesMount needs a non-empty exact match; the legacy branch reads
// empty as the true legacy answer; the current branch compares against the
// expected mount) — those judgments are pinned by the behavioral suites
// above; these pins hold the plumbing single-sourced.
describe("the .webapp-mount read is single-sourced (fix-ocr28 #4 — source pins)", () => {
  const source = readFileSync(
    join(hereDir, "../src/craft/webapp-proxy.ts"),
    "utf8",
  );

  test("readMountRecord exists and exactly the three consumers call it", () => {
    expect(source).toContain("async function readMountRecord(");
    // Definition line excluded: exactly 3 call sites (the mint's legacy
    // mirror, webapp-info's legacy branch, webapp-info's current branch).
    const calls = [...source.matchAll(/await readMountRecord\(/g)];
    expect(calls.length).toBe(3);
    // No site kept a private copy of the raw read: the marker's readFile is
    // spelled nowhere outside the helper.
    const outsideHelper = source.replace(
      /async function readMountRecord\([\S\s]*?\n\}/,
      "",
    );
    expect(outsideHelper).not.toContain(`${WEBAPP_MOUNT_MARKER}\`)`);
  });

  test("expectedMountFor exists and exactly the three consumers derive through it", () => {
    expect(source).toContain("function expectedMountFor(");
    const calls = [...source.matchAll(/expectedMountFor\(/g)];
    // 1 definition + 3 call sites.
    expect(calls.length).toBe(4);
    // The hand-copied fold is gone from the call sites — it lives in the
    // helper and nowhere else.
    const outsideHelper = source.replace(
      /function expectedMountFor\([\S\s]*?\n\}/,
      "",
    );
    expect(outsideHelper).not.toContain(
      'addressPath === "/" ? "" : addressPath',
    );
  });
});

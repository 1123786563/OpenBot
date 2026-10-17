import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import type { MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { loadCraftConfig } from "../src/craft/config";
import type {
  AgentSandboxFileApi,
  SandboxGateway,
} from "../src/craft/sandbox-gateway";
import type { CraftSessionRow, CraftStore } from "../src/craft/store";
import { createPreviewTickets } from "../src/craft/preview-ticket";
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
    expect(result.headers.get("content-security-policy")).toBeTruthy();
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
    async readFile() {
      return null;
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
    };
  }

  test("proxies the full path the origin hands it — label mount included; method, body and query reach the dev server; CSP rides back", async () => {
    const { dialed, upstreamHeaders, fetchImpl } = recordingUpstream();
    const serve = createPreviewProxy(
      previewProxyDeps({ fetchImpl }),
    );

    // F-2 (#365): the dev form's dev server is basePath-mounted at /<label>,
    // so the upstream-resolvable path is the label-ful one the origin derives
    // (appPathFor no longer strips) — forwarding the port-root path would 404
    // beside the mount.
    const response = await serve({
      sessionId: PREVIEW_SESSION,
      appPath: "/abc123label/api/tasks",
      query: "?sort=asc",
      method: "POST",
      request: new Request("http://127.0.0.1:3001/abc123label/api/tasks?sort=asc", {
        method: "POST",
        headers: {
          cookie: `openbot_preview_session=${PREVIEW_SESSION}`,
          "content-type": "application/json",
        },
        body: '{"title":"ship it"}',
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.get("content-security-policy")).toBeTruthy();
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
        appPath: "/api/tasks/1",
        query: "",
        method,
        request: new Request("http://127.0.0.1:3001/x/api/tasks/1", {
          method,
          headers: { cookie: `openbot_preview_session=${PREVIEW_SESSION}` },
        }),
      });
      expect(response.status).toBe(204);
      expect(
        seen.filter((call) => call.url.includes("/api/tasks/1")),
      ).toEqual([{ method, url: "http://sbox.internal:3011/api/tasks/1" }]);
    }
  });

  test("a deleted session (the row is gone after redemption) is an honest 404, never dialed", async () => {
    const { dialed } = recordingUpstream();
    const serve = createPreviewProxy(
      previewProxyDeps({ sessionExists: false, fetchImpl: (async () => {
        throw new Error("must not dial");
      }) as typeof fetch }),
    );
    const response = await serve({
      sessionId: PREVIEW_SESSION,
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
      appPath: "/",
      query: "",
      method: "GET",
      request: new Request("http://127.0.0.1:3001/x/"),
    });
    expect(portGone.status).toBe(503);
    expect(await portGone.json()).toEqual({ error: expect.any(String) });
  });

  test("a down dev server (attach probe fails) is the not-running refusal, HTML for a frame", async () => {
    const down = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    const serve = createPreviewProxy(previewProxyDeps({ fetchImpl: down }));

    const framed = await serve({
      sessionId: PREVIEW_SESSION,
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

describe("webapp-info: absolute webapp_url + previewOrigin + closed reason (D11/m-5)", () => {
  const PREVIEW_ADDRESS = "http://127.0.0.1:3001/abc123label";

  function infoRoutes(options: {
    previewOriginFor?: (sessionId: string) => string;
    previewOriginAdmission?: () => { ok: true } | { ok: false; reason: string };
    env?: Record<string, string | undefined>;
    ready?: boolean;
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
      previewOriginFor: options.previewOriginFor,
      previewOriginAdmission: options.previewOriginAdmission,
      env: options.env,
      fetchImpl,
    });
  }

  test("admission open: webapp_url and previewOrigin are the absolute preview address", async () => {
    const app = infoRoutes({ previewOriginFor: () => PREVIEW_ADDRESS });
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

  test("the default admission open: the dev origin's own port", async () => {
    const app = infoRoutes({ env: { PORT: "3005" } });
    const response = await app.request(`/sessions/${SESSION_ID}/webapp-info`);
    const body = (await response.json()) as { webapp_url: string | null };
    expect(body.webapp_url).toBe("http://127.0.0.1:3005");
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

// ── #362: the issuing route respects admission (never mint into a closed origin) ─

describe("POST /sessions/:id/preview-ticket: admission gate", () => {
  function ticketApp(admission?: () => { ok: true } | { ok: false; reason: string }) {
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
      previewOriginFor: () => "http://127.0.0.1:3005/label",
      previewOriginAdmission: admission,
      previewTickets: createPreviewTickets({ store: storeWithSession("app") }),
    });
  }

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
    const response = await app.request(`/sessions/${SESSION_ID}/preview-ticket`, {
      method: "POST",
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "The preview origin is disabled on this deployment.",
    });
    expect(tickets.size()).toBe(0);
  });

  test("open admission mints bound to the injected origin (regression)", async () => {
    const app = ticketApp();
    const response = await app.request(`/sessions/${SESSION_ID}/preview-ticket`, {
      method: "POST",
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { origin: string; ticket: string };
    expect(body.origin).toBe("http://127.0.0.1:3005/label");
  });
});

import { inflateRawSync } from "node:zlib";
import type { MiddlewareHandler } from "hono";
import { describe, expect, test } from "../../tests/support/e2e-compat";
import type { AppVariables } from "../src/auth/guards";
import { createArtifactRoutes } from "../src/craft/artifact-routes";
import { loadCraftConfig } from "../src/craft/config";
import { SandboxExecutionScopeUnavailableError } from "../src/craft/errors";
import { createFileRoutes } from "../src/craft/file-routes";
import type {
  AgentSandboxFileApi,
  SandboxGateway,
} from "../src/craft/sandbox-gateway";
import { createSandboxGateway } from "../src/craft/sandbox-gateway";
import type { CraftSessionRow, CraftStore } from "../src/craft/store";
import {
  collisionFreeName,
  sanitizeFilename,
  UPLOAD_LEDGER_FILENAME,
  validateFileSize,
} from "../src/craft/uploads";

/**
 * The upload / files-delete / download-directory trio. The sandbox behind the routes is an
 * in-memory file API whose listing answers the REAL gateway shape (finding F-C): one level
 * per call — a directory's immediate children as full paths, subdirectories included — so
 * the route's containment, limit, and archive-walk decisions are observed against what
 * opencode's GET /file actually answers, not a recursive stand-in that masked F-C.
 */

const config = loadCraftConfig({
  OPENBOT_CRAFT_MAX_UPLOAD_FILE_SIZE_MB: "1",
  OPENBOT_CRAFT_MAX_UPLOAD_FILES_PER_SESSION: "3",
  OPENBOT_CRAFT_MAX_TOTAL_UPLOAD_SIZE_MB: "1",
});
const SESSION_ID = "cs-sess";
const DIRECTORY = `/workspace/sessions/${SESSION_ID}`;

function fakeRequireUser(): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (context, next) => {
    context.set("actor", { id: "u1", email: "u1@example.com", role: "user" });
    await next();
  };
}

function sessionRow(): CraftSessionRow {
  return {
    id: SESSION_ID,
    userId: "u1",
    name: null,
    status: "active",
    lastActivityAt: new Date(),
    createdAt: new Date(),
    nextjsPort: null,
    sharingScope: "private",
    origin: "INTERACTIVE",
    opencodeSessionId: null,
    agentProvider: null,
    agentModel: null,
    skillsHash: null,
    mcpConfigHash: null,
  };
}

const fakeStore = (): CraftStore =>
  ({
    async getSession(id: string, userId: string) {
      return id === SESSION_ID && userId === "u1" ? sessionRow() : undefined;
    },
    async updateSessionActivity() {},
  }) as unknown as CraftStore;

/**
 * An in-memory sandbox: keys are absolute paths, values bytes. listFiles answers the REAL
 * gateway listing shape (finding F-C): ONE level per call — a directory's immediate
 * children as full paths, subdirectory children included (as bare paths, no trailing
 * slash, exactly what the gateway normalization hands back). A directory nothing lives
 * under throws (the gateway's behavior for an absent path).
 */
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
      if (children.size === 0 && !files.has(path)) {
        throw new Error(`Sandbox /file answered 404 for ${path}.`);
      }
      return [...children];
    },
    async writeFile(path, content) {
      files.set(path, new TextEncoder().encode(content));
    },
    async writeFileBytes(path, bytes) {
      files.set(path, bytes);
    },
    async deletePath(path) {
      if (!files.has(path)) return false;
      files.delete(path);
      return true;
    },
    async readFile(path) {
      const bytes = files.get(path);
      return bytes ? new TextDecoder().decode(bytes) : null;
    },
    async readFileBytes(path) {
      return files.get(path) ?? null;
    },
  };
  return { api, files };
}

function gatewayWith(api: AgentSandboxFileApi): SandboxGateway {
  return { fileApiFor: () => api } as unknown as SandboxGateway;
}

const multipart = (name: string, bytes: Uint8Array, type = "text/plain") => {
  const form = new FormData();
  form.append("file", new File([bytes as unknown as BlobPart], name, { type }));
  return form;
};

const routes = (api: AgentSandboxFileApi) =>
  createFileRoutes(fakeRequireUser(), {
    config,
    store: fakeStore(),
    gateway: gatewayWith(api),
    botIdFor: async () => "craft",
  });

// ── sanitizeFilename (onyx utils.py:38-75, rule for rule) ─────────────────────

describe("sanitizeFilename", () => {
  test("strips path components (both separators)", () => {
    expect(sanitizeFilename("dir/sub/file.txt")).toBe("file.txt");
    expect(sanitizeFilename("C:\\evil\\name.exe")).toBe("name.exe");
    expect(sanitizeFilename("../../etc/passwd")).toBe("passwd");
  });

  test("removes null bytes", () => {
    expect(sanitizeFilename("bad\x00name.txt")).toBe("badname.txt");
  });

  test("replaces unsafe characters with underscore", () => {
    expect(sanitizeFilename("my file: report*.pdf")).toBe(
      "my_file__report_.pdf",
    );
    expect(sanitizeFilename("数据.csv")).toBe("__.csv");
  });

  test("strips leading/trailing dots and spaces; empty becomes unnamed_file", () => {
    // The edge strip runs AFTER the char replacement (onyx's order), so a padded name keeps
    // its padding as underscores — exactly what the original returns.
    expect(sanitizeFilename("  name.txt  ")).toBe("__name.txt__");
    expect(sanitizeFilename("name.txt...")).toBe("name.txt");
    expect(sanitizeFilename(".hidden")).toBe("hidden");
    expect(sanitizeFilename("...")).toBe("unnamed_file");
    expect(sanitizeFilename("")).toBe("unnamed_file");
  });

  test("truncates to 255 preserving the extension", () => {
    const long = `${"a".repeat(256)}.txt`;
    const out = sanitizeFilename(long);
    expect(out.length).toBe(255);
    expect(out.endsWith(".txt")).toBe(true);
    expect(out.slice(0, -4)).toBe("a".repeat(251));
  });

  test("a name that is only an extension keeps a stem after truncation", () => {
    const out = sanitizeFilename(`${"b".repeat(300)}.md`);
    expect(out.length).toBe(255);
    expect(out.endsWith(".md")).toBe(true);
  });
});

describe("validateFileSize", () => {
  test("empty is invalid, oversize is invalid, in-range is valid", () => {
    expect(validateFileSize(0, 1024)).toBe("File is empty");
    expect(validateFileSize(1025, 1024)).toMatch(/exceeds maximum/);
    expect(validateFileSize(1024, 1024)).toBeNull();
  });
});

describe("collisionFreeName", () => {
  test("returns the desired name when free, numbered suffixes when taken", () => {
    const taken = new Set(["a.txt", "a_1.txt", "a_2.txt"]);
    expect(collisionFreeName(taken, "b.txt")).toBe("b.txt");
    expect(collisionFreeName(taken, "a.txt")).toBe("a_3.txt");
  });

  test("no-extension names still number cleanly", () => {
    expect(collisionFreeName(new Set(["notes", "notes_1"]), "notes")).toBe(
      "notes_2",
    );
  });
});

// ── POST /sessions/:id/upload ─────────────────────────────────────────────────

describe("upload endpoint", () => {
  test("stores a sanitized file under attachments/ and answers onyx's shape", async () => {
    const { api, files } = memoryFileApi({
      [`${DIRECTORY}/AGENTS.md`]: "agent instructions",
    });
    const app = routes(api);
    const response = await app.request(`/sessions/${SESSION_ID}/upload`, {
      method: "POST",
      body: multipart("my report #1.pdf", new Uint8Array([1, 2, 3])),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      filename: string;
      path: string;
      size_bytes: number;
    };
    expect(body).toEqual({
      filename: "my_report__1.pdf",
      path: "attachments/my_report__1.pdf",
      size_bytes: 3,
    });
    expect(files.has(`${DIRECTORY}/attachments/my_report__1.pdf`)).toBe(true);
    // The bookkeeping ledger landed too (hidden, so listings skip it).
    expect(
      files.has(`${DIRECTORY}/attachments/${UPLOAD_LEDGER_FILENAME}`),
    ).toBe(true);
  });

  test("a traversal filename can only ever land inside attachments/", async () => {
    const { api, files } = memoryFileApi();
    const app = routes(api);
    const response = await app.request(`/sessions/${SESSION_ID}/upload`, {
      method: "POST",
      body: multipart("../../etc/passwd", new Uint8Array([1])),
    });
    expect(response.status).toBe(200);
    expect([...files.keys()]).toEqual([
      `${DIRECTORY}/attachments/passwd`,
      `${DIRECTORY}/attachments/${UPLOAD_LEDGER_FILENAME}`,
    ]);
  });

  test("empty file is 400, oversize single file is 400", async () => {
    const { api } = memoryFileApi();
    const app = routes(api);
    const empty = await app.request(`/sessions/${SESSION_ID}/upload`, {
      method: "POST",
      body: multipart("empty.txt", new Uint8Array(0)),
    });
    expect(empty.status).toBe(400);
    expect(((await empty.json()) as { error: string }).error).toBe(
      "File is empty",
    );

    const oversize = await app.request(`/sessions/${SESSION_ID}/upload`, {
      method: "POST",
      body: multipart("big.bin", new Uint8Array(1024 * 1024 + 1)),
    });
    expect(oversize.status).toBe(400);
  });

  test("an oversize DECLARED content-length is refused 400, not 413, before the body parses", async () => {
    const { api, files } = memoryFileApi();
    const app = routes(api);
    const response = await app.request(`/sessions/${SESSION_ID}/upload`, {
      method: "POST",
      // Declared past the 1MB cap + the 64KB multipart allowance; the body itself is tiny
      // (Bun keeps an explicit content-length verbatim for a FormData body). onyx's
      // oversize verdict is 400 — 413 stays reserved for the sandbox transfer ceiling.
      headers: { "content-length": String(2 * 1024 * 1024) },
      body: multipart("big.bin", new Uint8Array([1])),
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toMatch(
      /exceeds maximum/,
    );
    expect([...files.keys()]).toEqual([]); // refused before any sandbox write
  });

  test("a name collision is renamed with onyx's stem_N.ext scheme", async () => {
    const { api } = memoryFileApi({
      [`${DIRECTORY}/attachments/data.csv`]: "existing",
    });
    const app = routes(api);
    const first = await app.request(`/sessions/${SESSION_ID}/upload`, {
      method: "POST",
      body: multipart("data.csv", new Uint8Array([9])),
    });
    const body = (await first.json()) as { filename: string };
    expect(body.filename).toBe("data_1.csv");
  });

  test("the per-session file-count limit answers 429", async () => {
    const { api } = memoryFileApi({
      [`${DIRECTORY}/attachments/a.txt`]: "a",
      [`${DIRECTORY}/attachments/b.txt`]: "b",
      [`${DIRECTORY}/attachments/c.txt`]: "c",
    });
    const app = routes(api);
    const response = await app.request(`/sessions/${SESSION_ID}/upload`, {
      method: "POST",
      body: multipart("d.txt", new Uint8Array([1])),
    });
    expect(response.status).toBe(429);
    expect(((await response.json()) as { error: string }).error).toBe(
      "Maximum number of files (3) reached",
    );
  });

  test("nested descendants of attachments/ don't count toward the file limit (onyx maxdepth 1)", async () => {
    // The REAL listing is one level: attachments/ answers [keep.txt, sub] — the two
    // NESTED files never appear (onyx's `find -maxdepth 1 -type f` never saw them
    // either). The subdirectory itself occupies one top-level slot name — the flat
    // path strings cannot say file-or-dir, and counting it is the conservative side.
    const { api, files } = memoryFileApi({
      [`${DIRECTORY}/attachments/keep.txt`]: "top level",
      [`${DIRECTORY}/attachments/sub/one.txt`]: "nested",
      [`${DIRECTORY}/attachments/sub/deeper/two.txt`]: "nested deeper",
    });
    const app = routes(api);
    const response = await app.request(`/sessions/${SESSION_ID}/upload`, {
      method: "POST",
      body: multipart("new.txt", new Uint8Array([1])),
    });
    expect(response.status).toBe(200);
    expect(files.has(`${DIRECTORY}/attachments/new.txt`)).toBe(true);
  });

  test("a nested file's basename reserves no top-level collision name", async () => {
    const { api, files } = memoryFileApi({
      [`${DIRECTORY}/attachments/sub/data.csv`]: "nested, same basename",
    });
    const app = routes(api);
    const response = await app.request(`/sessions/${SESSION_ID}/upload`, {
      method: "POST",
      body: multipart("data.csv", new Uint8Array([9])),
    });
    expect(response.status).toBe(200);
    // No TOP-LEVEL data.csv existed, so the name is taken as-is — not stem_1'd.
    const body = (await response.json()) as { filename: string };
    expect(body.filename).toBe("data.csv");
    expect(files.has(`${DIRECTORY}/attachments/data.csv`)).toBe(true);
  });

  test("the total-size limit answers 429 once the ledger fills", async () => {
    // 600KB each: two together cross the 1MB total while staying under the 2-file count.
    // The first upload rides the endpoint so the ledger records its bytes (agent-authored
    // files have no size channel — the documented divergence).
    const { api } = memoryFileApi();
    const app = routes(api);
    const first = await app.request(`/sessions/${SESSION_ID}/upload`, {
      method: "POST",
      body: multipart("big1.bin", new Uint8Array(600 * 1024).fill(7)),
    });
    expect(first.status).toBe(200);
    const second = await app.request(`/sessions/${SESSION_ID}/upload`, {
      method: "POST",
      body: multipart("big2.bin", new Uint8Array(600 * 1024).fill(7)),
    });
    expect(second.status).toBe(429);
    expect(((await second.json()) as { error: string }).error).toMatch(
      /Total upload size limit \(1MB\) exceeded/,
    );
  });

  test("unknown session is 404; a missing form is 400", async () => {
    const { api } = memoryFileApi();
    const app = routes(api);
    const missing = await app.request(`/sessions/nope/upload`, {
      method: "POST",
      body: multipart("x.txt", new Uint8Array([1])),
    });
    expect(missing.status).toBe(404);
    const malformed = await app.request(`/sessions/${SESSION_ID}/upload`, {
      method: "POST",
      body: "not a form",
      headers: { "content-type": "text/plain" },
    });
    expect(malformed.status).toBe(400);
  });
});

// ── DELETE /sessions/:id/files/*path ──────────────────────────────────────────

describe("delete file endpoint", () => {
  test("deletes an attachments file with 204", async () => {
    const { api, files } = memoryFileApi({
      [`${DIRECTORY}/attachments/old.pdf`]: "gone",
      [`${DIRECTORY}/outputs/keep.md`]: "kept",
    });
    const app = routes(api);
    const response = await app.request(
      `/sessions/${SESSION_ID}/files/attachments/old.pdf`,
      { method: "DELETE" },
    );
    expect(response.status).toBe(204);
    expect(files.has(`${DIRECTORY}/attachments/old.pdf`)).toBe(false);
    expect(files.has(`${DIRECTORY}/outputs/keep.md`)).toBe(true);
  });

  test("traversal is 403, disallowed characters are 400, absent is 404", async () => {
    const { api } = memoryFileApi();
    const app = routes(api);
    // Dot segments are URL-normalized away unless percent-encoded — encode them so the
    // ROUTE's own traversal verdict is what answers (the real attack shape anyway).
    const traversal = await app.request(
      `/sessions/${SESSION_ID}/files/..%2F..%2Fetc%2Fpasswd`,
      { method: "DELETE" },
    );
    expect(traversal.status).toBe(403);

    const metachar = await app.request(
      `/sessions/${SESSION_ID}/files/attachments/a;b.txt`,
      { method: "DELETE" },
    );
    expect(metachar.status).toBe(400);

    const absent = await app.request(
      `/sessions/${SESSION_ID}/files/attachments/ghost.txt`,
      { method: "DELETE" },
    );
    expect(absent.status).toBe(404);
  });

  test("a directory is the same 404 as absence (onyx's [ -f ] semantics)", async () => {
    const { api } = memoryFileApi({
      [`${DIRECTORY}/attachments/nested/inner.txt`]: "x",
    });
    const app = routes(api);
    // The memory API has no directory rows — a path with living descendants is not a file,
    // and the real gateway answers 404 for those too.
    const response = await app.request(
      `/sessions/${SESSION_ID}/files/attachments/nested`,
      { method: "DELETE" },
    );
    expect(response.status).toBe(404);
  });

  test("unknown session is 404 before any path decision", async () => {
    const { api } = memoryFileApi();
    const app = routes(api);
    const response = await app.request(`/sessions/nope/files/a.txt`, {
      method: "DELETE",
    });
    expect(response.status).toBe(404);
  });
});

// ── GET /sessions/:id/download-directory/*path ────────────────────────────────

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

const BLOB = (() => {
  const bytes = new Uint8Array(256);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 7) & 0xff;
  return bytes;
})();

describe("download-directory endpoint (ZIP contract)", () => {
  test("packs a directory as a ZIP with arcnames relative to it", async () => {
    const { api } = memoryFileApi({
      [`${DIRECTORY}/outputs/report.md`]: "# hello",
      [`${DIRECTORY}/outputs/app/main.js`]: "console.log(1)",
      [`${DIRECTORY}/outputs/app/blob.bin`]: BLOB,
      [`${DIRECTORY}/outputs/.hidden`]: "skipped",
      [`${DIRECTORY}/outputs/node_modules/pkg/index.js`]: "skipped",
    });
    const app = routes(api);
    const response = await app.request(
      `/sessions/${SESSION_ID}/download-directory/outputs`,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/zip");
    // onyx serving.py:103-115 — ASCII fallback + RFC 5987 filename*, filename
    // from _sanitize_zip_basename(Path(path).name, allow_dots=True) (F6 A).
    expect(response.headers.get("content-disposition")).toBe(
      `attachment; filename="outputs.zip"; filename*=UTF-8''outputs.zip`,
    );

    const members = readZip(new Uint8Array(await response.arrayBuffer()));
    expect(members.map((m) => m.name).sort()).toEqual([
      "app/blob.bin",
      "app/main.js",
      "report.md",
    ]);
    expect(members.find((m) => m.name === "report.md")?.bytes).toEqual(
      new TextEncoder().encode("# hello"),
    );
    expect(members.find((m) => m.name === "app/blob.bin")?.bytes).toEqual(BLOB);
    expect(members.every((m) => m.method === 8)).toBe(true); // deflate
  });

  test("F6-A/F-C: a top level of ONLY subdirectories still packs every nested file", async () => {
    // The finding's exact live shape: the gateway listing is ONE level, so
    // `outputs` answers only the `web` directory entry. The walk must recurse —
    // a single flat listing here used to answer a 200 with a ZERO-entry ZIP,
    // silently dropping every nested file (remediation-verification §3(viii)).
    const { api } = memoryFileApi({
      [`${DIRECTORY}/outputs/web/package.json`]: '{"name":"web"}',
      [`${DIRECTORY}/outputs/web/src/app/page.tsx`]:
        "export default function Page() {}",
      [`${DIRECTORY}/outputs/web/.env`]: "hidden",
      [`${DIRECTORY}/outputs/web/node_modules/pkg/index.js`]: "hidden",
    });
    const app = routes(api);
    const response = await app.request(
      `/sessions/${SESSION_ID}/download-directory/outputs`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/zip");
    const members = readZip(new Uint8Array(await response.arrayBuffer()));
    // The fixture F6 input tree's members, arcnames relative to outputs/
    // (hidden subtrees pruned whole).
    expect(members.map((m) => m.name).sort()).toEqual([
      "web/package.json",
      "web/src/app/page.tsx",
    ]);
  });

  test("F-C ride-along: an archive the writer cannot build is 502, not a misleading 404", async () => {
    // 65,536 entries: past the non-ZIP64 writer's ceiling. The listing itself is
    // reachable, so the route must NOT fold the writer's RangeError into onyx's
    // "directory not found" 404 — the directory exists; the archive failed.
    const tree: Record<string, string> = {};
    for (let i = 0; i <= 0xffff; i++)
      tree[`${DIRECTORY}/outputs/f${i}.txt`] = "x";
    const { api } = memoryFileApi(tree);
    const app = routes(api);
    const response = await app.request(
      `/sessions/${SESSION_ID}/download-directory/outputs`,
    );
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: "The directory could not be read.",
    });
  });

  test("a dotted directory basename keeps its dots (allow_dots=True)", async () => {
    const { api } = memoryFileApi({
      [`${DIRECTORY}/outputs/my.lib/v1.txt`]: "x",
    });
    const app = routes(api);
    const response = await app.request(
      `/sessions/${SESSION_ID}/download-directory/outputs/my.lib`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toBe(
      `attachment; filename="my.lib.zip"; filename*=UTF-8''my.lib.zip`,
    );
  });

  test("traversal is 403 and a missing directory is 404", async () => {
    const { api } = memoryFileApi();
    const app = routes(api);
    const traversal = await app.request(
      `/sessions/${SESSION_ID}/download-directory/..%2F..%2Fetc`,
    );
    expect(traversal.status).toBe(403);
    const missing = await app.request(
      `/sessions/${SESSION_ID}/download-directory/nowhere`,
    );
    expect(missing.status).toBe(404);
  });

  test("unknown session is onyx's indistinct 404 Directory not found", async () => {
    const { api } = memoryFileApi();
    const app = routes(api);
    const response = await app.request(
      `/sessions/nope/download-directory/outputs`,
    );
    expect(response.status).toBe(404);
    // onyx api.py:736-738: every None shape (session, sandbox, directory) is
    // the same 404 "Directory not found" — ownership probing reads as absence.
    expect(await response.json()).toEqual({ error: "Directory not found" });
  });
});

// ── the wildcard fix's blast radius: artifact download reads its path ─────────

describe("artifact download reads the multi-segment path (wildcard regression)", () => {
  test("GET artifacts/outputs/report.md serves that file, not the session root", async () => {
    const { api } = memoryFileApi({
      [`${DIRECTORY}/outputs/report.md`]: "# the report",
    });
    // The same fake wiring, but the ARTIFACT routes: before the `:path{.+}` fix, Hono's
    // bare `*` yielded no param and every download resolved to the session directory.
    const app = createArtifactRoutes(fakeRequireUser(), {
      config,
      store: fakeStore(),
      gateway: gatewayWith(api),
      botIdFor: async () => "craft",
    });
    const response = await app.request(
      `/sessions/${SESSION_ID}/artifacts/outputs/report.md`,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("# the report");
    expect(response.headers.get("content-disposition")).toMatch(/report\.md/);
  });
});

// ── #618 R1-F2: a scopeless deployment answers its own 503, not a mask ────────

/**
 * A REAL gateway on a deployment whose scope pair is missing (only the tenant half
 * configured — a half scope is no scope), so every sandbox verb refuses with the
 * displayable sentence before any request leaves. fetchImpl is a recorder: the
 * fail-closed contract says it must stay untouched.
 */
const halfScopedConfig = loadCraftConfig({
  OPENBOT_CRAFT_MAX_UPLOAD_FILE_SIZE_MB: "1",
  OPENBOT_CRAFT_MAX_UPLOAD_FILES_PER_SESSION: "3",
  OPENBOT_CRAFT_MAX_TOTAL_UPLOAD_SIZE_MB: "1",
  OPENBOT_CRAFT_SANDBOX_EXECUTION_TENANT_ID: "acme-co",
});

function unscopedGateway() {
  const calls: { method: string; url: string }[] = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ method: init?.method ?? "GET", url: url.pathname });
    return new Response(null, { status: 200 });
  }) as typeof fetch;
  return {
    calls,
    gateway: createSandboxGateway({
      config: halfScopedConfig,
      connectionFor: () => ({
        botId: "craft",
        baseUrl: "http://gw.test",
        token: "sandbox-secret",
      }),
      fetchImpl,
    }),
  };
}

describe("#618 R1-F2: the fail-closed refusal answers as its own 503", () => {
  const REFUSAL = new SandboxExecutionScopeUnavailableError().message;

  test("upload surfaces the fixed sentence, not the generic 502, with zero outbound calls", async () => {
    const { gateway, calls } = unscopedGateway();
    const response = await createFileRoutes(fakeRequireUser(), {
      config: halfScopedConfig,
      store: fakeStore(),
      gateway,
      botIdFor: async () => "craft",
    }).request(`/sessions/${SESSION_ID}/upload`, {
      method: "POST",
      body: multipart("report.txt", new Uint8Array([1, 2, 3])),
    });
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe(REFUSAL);
    // The configured half must never echo back into an answer people read.
    expect(body.error).not.toContain("acme-co");
    expect(calls).toEqual([]); // fail-closed: no request ever left the process
  });

  test("download-directory surfaces the same 503 through the listing wrap, zero outbound calls", async () => {
    // The walk folds the refused root listing into a WorkspaceListingError — the
    // endpoint must not wear onyx's "Directory not found" 404 mask for it either.
    const { gateway, calls } = unscopedGateway();
    const response = await createFileRoutes(fakeRequireUser(), {
      config: halfScopedConfig,
      store: fakeStore(),
      gateway,
      botIdFor: async () => "craft",
    }).request(`/sessions/${SESSION_ID}/download-directory/outputs`);
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe(REFUSAL);
    expect(body.error).not.toContain("acme-co");
    expect(calls).toEqual([]);
  });
});

import { describe, expect, test } from "bun:test";
import type { SandboxClient } from "../src/codesandbox/client";
import type { WorkshopStore, WorkshopSessionRow } from "../src/workshop/store";
import { UploadLimitError, listTree, upload } from "../src/workshop/files";
import { MAX_UPLOAD_FILES } from "../src/workshop/files";

/** The store as the files module sees it: one session, recorded touches. */
function fakeStore(session: WorkshopSessionRow | undefined) {
  const touched: string[] = [];
  return {
    touched,
    store: {
      async sessionById(id: string) {
        return id === session?.id ? session : undefined;
      },
      async touchSession(id: string) {
        touched.push(id);
      },
    } as unknown as WorkshopStore,
  };
}

function sessionRow(): WorkshopSessionRow {
  return {
    id: "ws_1",
    channelId: "ch_1",
    botId: "bot_1",
    ownerUserId: "user_1",
    status: "active",
    opencodeSessionId: null,
    webappPort: null,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    visibility: "private",
    shareTokenHash: null,
    shareScope: "preview",
    shareExpiresAt: null,
    shareRevokedAt: null,
    shareCreatedBy: null,
    shareCreatedAt: null,
  };
}

function fakeAudit() {
  const events: Array<{ eventType: string; payload: Record<string, unknown> }> = [];
  return {
    events,
    store: {
      async insert(event: { eventType: string; payload: Record<string, unknown> }) {
        events.push(event);
      },
    } as never,
  };
}

function fakeClient(listing: string[]): SandboxClient & {
  written: Array<{ path: string; content: string }>;
} {
  const written: Array<{ path: string; content: string }> = [];
  return {
    written,
    createSession: async () => "ses",
    sendMessage: async () => ({ sessionId: "ses", text: "", usage: undefined }),
    listFiles: async () => listing,
    readFile: async (path: string) => ({
      path,
      size: 3,
      content: "abc",
      truncated: false,
    }),
    writeFile: async (path: string, content: string) => {
      written.push({ path, content });
      return { path, size: Buffer.byteLength(content, "utf8") };
    },
    resetWorkspace: async () => undefined,
  } as never;
}

function optionsFor(
  store: WorkshopStore,
  client: SandboxClient | null,
  audit?: ReturnType<typeof fakeAudit>,
) {
  return {
    store,
    auditStore: audit?.store,
    clientFor: () => client,
    actorUserId: "user_1",
  };
}

describe("listTree", () => {
  test("groups a flat listing into nested directories", async () => {
    const { store } = fakeStore(sessionRow());
    const client = fakeClient([
      "out.csv",
      "data/rows.csv",
      "data/nested/plot.png",
    ]);
    const tree = await listTree(optionsFor(store, client), "ws_1");
    const names = (node: { name: string; children?: Array<{ name: string }> }) =>
      [node.name, ...(node.children ?? []).flatMap(names)];
    expect(tree.map((node) => node.type)).toEqual([
      "file",
      "directory",
    ]);
    const data = tree.find((node) => node.type === "directory")!;
    expect(data.name).toBe("data");
    expect(data.children!.map((child) => child.name)).toEqual([
      "rows.csv",
      "nested",
    ]);
    expect(names(data)).toContain("plot.png");
  });

  test("an unconfigured sandbox answers an empty tree, not an error", async () => {
    const { store } = fakeStore(sessionRow());
    expect(await listTree(optionsFor(store, null), "ws_1")).toEqual([]);
  });

  test("read-only browsing still works when the sandbox cannot enforce execution token budgets", async () => {
    const { store } = fakeStore(sessionRow());
    const client = {
      ...fakeClient(["out.csv"]),
      capabilities: { enforceableTokenBudget: false },
    } as SandboxClient;
    expect(await listTree(optionsFor(store, client), "ws_1")).toMatchObject([
      { name: "out.csv", type: "file" },
    ]);
  });

  test("an unknown session is an error", async () => {
    const { store } = fakeStore(undefined);
    await expect(
      listTree(optionsFor(store, null), "ws_missing"),
    ).rejects.toThrow(/No workshop session/);
  });
});

describe("upload limits — audit before refusal", () => {
  test("too many files: refused, and the audit row is written first", async () => {
    const { store } = fakeStore(sessionRow());
    const audit = fakeAudit();
    const client = fakeClient([]);
    const files = Array.from({ length: MAX_UPLOAD_FILES + 1 }, (_, i) => ({
      name: `f${i}.csv`,
      content: "x",
    }));
    let rejected: unknown;
    try {
      await upload(optionsFor(store, client, audit), "ws_1", files);
    } catch (error) {
      rejected = error;
    }
    expect(rejected).toBeInstanceOf(UploadLimitError);
    expect((rejected as UploadLimitError).name).toBe("UploadLimitError");
    // The refusal is on the trail before the caller saw anything.
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0].eventType).toBe("workshop.file_upload_refused");
    expect(audit.events[0].payload.reason).toContain("at most 20");
    expect(client.written).toHaveLength(0);
  });

  test("a single oversized file: refused with its name in the row", async () => {
    const { store } = fakeStore(sessionRow());
    const audit = fakeAudit();
    const client = fakeClient([]);
    const oversized = "a".repeat(20 * 1024 * 1024 + 1);
    await expect(
      upload(optionsFor(store, client, audit), "ws_1", [
        { name: "big.bin", content: oversized },
      ]),
    ).rejects.toThrow(/big\.bin/);
    expect(audit.events[0].payload.file).toBe("big.bin");
    expect(client.written).toHaveLength(0);
  });

  test("a batch under every per-file cap but over the total: refused", async () => {
    const { store } = fakeStore(sessionRow());
    const audit = fakeAudit();
    const client = fakeClient([]);
    // 20 files × ~6MB each is under 20MB each but over 100MB together.
    const files = Array.from({ length: 20 }, () => ({
      name: "chunk.csv",
      content: "y".repeat(6 * 1024 * 1024),
    }));
    await expect(
      upload(optionsFor(store, client, audit), "ws_1", files),
    ).rejects.toThrow(/request limit/);
    expect(client.written).toHaveLength(0);
  });

  test("no sandbox configured: refused and audited, not a crash", async () => {
    const { store } = fakeStore(sessionRow());
    const audit = fakeAudit();
    await expect(
      upload(optionsFor(store, null, audit), "ws_1", [
        { name: "a.csv", content: "1" },
      ]),
    ).rejects.toThrow(/not configured/);
    expect(audit.events[0].eventType).toBe("workshop.file_upload_refused");
  });

  test("a successful batch: written, one audit row, session touched", async () => {
    const session = sessionRow();
    const { store, touched } = fakeStore(session);
    const audit = fakeAudit();
    const client = fakeClient([]);
    const result = await upload(optionsFor(store, client, audit), "ws_1", [
      { name: "out.csv", content: "a,b\n1,2\n" },
      { name: "plot.png", content: "PNGDATA" },
    ]);
    expect(result.uploaded).toHaveLength(2);
    expect(client.written.map((w) => w.path)).toEqual(["out.csv", "plot.png"]);
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0].eventType).toBe("workshop.file_uploaded");
    expect(audit.events[0].payload.files).toEqual(["out.csv", "plot.png"]);
    expect(touched).toEqual(["ws_1"]);
  });

  test("a name from the wire never becomes a path", async () => {
    const { store } = fakeStore(sessionRow());
    const audit = fakeAudit();
    const client = fakeClient([]);
    await upload(optionsFor(store, client, audit), "ws_1", [
      { name: "../../escape.csv", content: "1" },
    ]);
    // Separators flattened: no path separators survive, so the file lands as one harmless
    // name in the workspace root — it cannot climb out or plant into another tree.
    expect(client.written[0].path).not.toContain("/");
    expect(client.written[0].path).not.toContain("\\");
    expect(client.written[0].path.endsWith(".csv")).toBe(true);
  });
});

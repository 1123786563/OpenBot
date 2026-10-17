import { afterAll, describe, expect, test } from "../../tests/support/e2e-compat";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { agents, channels, users } from "../src/db/schema/core";
import { workshopSessions } from "../src/db/schema/workshop";
import { createCodeRunGateway } from "../src/codesandbox/gateway";
import type { SandboxClient } from "../src/codesandbox/client";
import type { CodeRunStore } from "../src/codesandbox/store";
import { createWorkshopStore } from "../src/workshop/store";
import { artifactTypeFor, indexArtifacts } from "../src/workshop/artifacts";

describe("artifactTypeFor (pure classification)", () => {
  test("csv and tabular extensions", () => {
    expect(artifactTypeFor("out.csv")).toBe("csv");
    expect(artifactTypeFor("data/rows.tsv")).toBe("csv");
  });
  test("image extensions are charts", () => {
    expect(artifactTypeFor("plot.png")).toBe("chart");
    expect(artifactTypeFor("fig.svg")).toBe("chart");
    expect(artifactTypeFor("图.jpg")).toBe("chart");
  });
  test("document shapes are reports", () => {
    expect(artifactTypeFor("报告.md")).toBe("report");
    expect(artifactTypeFor("summary.pdf")).toBe("report");
  });
  test("columnar data files are datasets", () => {
    expect(artifactTypeFor("features.parquet")).toBe("dataset");
    expect(artifactTypeFor("tensors.npz")).toBe("dataset");
  });
  test("an app directory shape is a webapp, even over other extensions", () => {
    expect(artifactTypeFor("app/index.html")).toBe("webapp");
    expect(artifactTypeFor("site/package.json")).toBe("webapp");
  });
  test("everything else is a plain file", () => {
    expect(artifactTypeFor("script.py")).toBe("file");
    expect(artifactTypeFor("noext")).toBe("file");
    expect(artifactTypeFor("data.tar.gz")).toBe("file");
  });
});

/** A store whose inserts are recorded, for the cap and failure cases without a database. */
function recordingStore() {
  const inserted: Array<{ sessionId: string; path: string; type: string }> = [];
  return {
    inserted,
    store: {
      async insertArtifact(input: { sessionId: string; path: string; type: string }) {
        inserted.push({
          sessionId: input.sessionId,
          path: input.path,
          type: input.type,
        });
      },
    } as never as ReturnType<typeof createWorkshopStore>,
  };
}

function file(path: string, size = 10): {
  path: string;
  size: number;
  content: string;
  truncated: boolean;
} {
  return { path, size, content: "x".repeat(size), truncated: false };
}

describe("indexArtifacts", () => {
  test("writes one row per file with the classified type", async () => {
    const { store, inserted } = recordingStore();
    const result = await indexArtifacts(store, "ws_1", [
      file("out.csv"),
      file("plot.png"),
    ]);
    expect(result).toEqual({ indexed: 2, capped: false });
    expect(inserted.map((row) => row.type)).toEqual(["csv", "chart"]);
    expect(inserted.every((row) => row.sessionId === "ws_1")).toBe(true);
  });

  test("caps at 100 rows and reports the cap", async () => {
    const { store, inserted } = recordingStore();
    const many = Array.from({ length: 130 }, (_, i) => file(`f${i}.csv`));
    const result = await indexArtifacts(store, "ws_1", many);
    expect(result).toEqual({ indexed: 100, capped: true });
    expect(inserted).toHaveLength(100);
    expect(inserted[0].path).toBe("f0.csv");
  });

  test("an insert failure is contained: counted, not thrown", async () => {
    let calls = 0;
    const store = {
      async insertArtifact() {
        calls += 1;
        if (calls === 2) throw new Error("db hiccup");
      },
    } as never as ReturnType<typeof createWorkshopStore>;
    const result = await indexArtifacts(store, "ws_1", [
      file("a.csv"),
      file("b.csv"),
      file("c.csv"),
    ]);
    expect(result).toEqual({ indexed: 2, capped: false });
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)(
  "gateway → workshop_artifacts wiring",
  () => {
    const database = createDatabase(testDatabaseUrl(), TEST_POOL);
    const store = createWorkshopStore(database);
    const run = randomUUID().slice(0, 8);
    const channelId = `ch-${run}`;
    const botId = `bot-${run}`;
    const ownerUserId = `user-${run}`;
    let sessionId = "";

    afterAll(async () => {
      await database
        .delete(workshopSessions)
        .where(eq(workshopSessions.channelId, channelId));
      await database.delete(channels).where(eq(channels.id, channelId));
      await database.delete(agents).where(eq(agents.id, botId));
      await database.delete(users).where(eq(users.id, ownerUserId));
      await database.$client.close();
    });

    function fakeClient(): SandboxClient {
      // The workspace grows when the message is sent: the gateway's before/after diff is what
      // collects artifacts, so the fake lists empty before and the produced files after —
      // hello.py stays out because the run did not create it (listFiles returns it never).
      let messageCount = 0;
      return {
        createSession: async () => "ses_x",
        sendMessage: async (_sessionId: string, _text: string) => {
          messageCount += 1;
          return {
            sessionId: "ses_x",
            text: "done",
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        },
        listFiles: async () =>
          messageCount > 0 ? ["out.csv", "plot.png"] : [],
        readFile: async (path: string) => ({
          path,
          size: 6,
          content: "print(1)",
          truncated: false,
        }),
        resetWorkspace: async () => undefined,
      } as SandboxClient;
    }

    function fakeRunStore(): CodeRunStore {
      return {
        create: async () => undefined,
        finish: async () => undefined,
        get: async () => undefined,
      };
    }

    test("a run producing out.csv + plot.png lands two gallery rows", async () => {
      await database
        .insert(users)
        .values({ id: ownerUserId, email: `${run}@artifacts-test.invalid` });
      await database
        .insert(agents)
        .values({
          id: botId,
          name: "artifacts bot",
          type: "remote_ag_ui",
          configuration: {},
        });
      await database
        .insert(channels)
        .values({
          id: channelId,
          name: "artifacts channel",
          description: "workshop-artifacts.test.ts",
        });
      const session = await store.getOrCreateSession({
        channelId,
        botId,
        ownerUserId,
      });
      sessionId = session.id;

      const gateway = createCodeRunGateway({
        client: fakeClient(),
        billingEnabled: false,
        modelId: "GLM-5.3",
        botId,
        ownerUserId,
        initiator: { kind: "person" },
        store: fakeRunStore(),
        onArtifacts: async ({ artifacts }) => {
          await indexArtifacts(store, sessionId, artifacts);
        },
      });
      const outcome = await gateway.run("做两个文件");
      expect(outcome.kind).toBe("completed");

      const rows = await store.listArtifacts(sessionId);
      expect(rows).toHaveLength(2);
      const byPath = new Map(rows.map((row) => [row.path, row.type]));
      expect(byPath.get("out.csv")).toBe("csv");
      expect(byPath.get("plot.png")).toBe("chart");
      expect(rows.every((row) => row.visibility === "private")).toBe(true);
    });
  },
);

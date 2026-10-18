// server/tests/multitenancy/document-lifecycle.test.ts
// MT038（Issue #81）：文档上传、删除、导入与重解析的作用域。
//
// 验收事实源（Issue #81 验收 1–4，逐条对应 describe；覆盖父 Spec A2/A5/A8）：
//   (1) 上传的文档归属当前范围；非成员看不到也下载不到原文件。
//   (2) 导入与重解析任务保存发起归属，执行时重建作用域。
//   (3) 删除只影响本范围文档；跨范围删除请求被拒绝。
//   (4) 重解析产生的 chunk/revision 与原文件归属一致，不产生跨范围可见的
//       中间产物。
//
// 机制：受限文档生命周期入口（kb 域）消费 MT036 主库权威（先允许集合再动作：
// authorizeKnowledgeBase + 归属镜像逐次比对）+ 冻结任务管线（enqueue/
// processDocument 只读消费）。任务载荷携带发起归属（tenant/workspace/principal），
// 执行侧以权威行 + 镜像重建作用域——payload 谎报不能改变 chunk/revision/向量
// 的归属。跨范围动作 = canonical 不可见语义（不泄露存在性）。
//
// 环境契约：ENTERPRISE_TEST_SETUP_DATABASE_URL（或 TEST_DATABASE_URL）+
// KB_TEST_DATABASE_URL 缺一整套显式 skip，绝不回退开发库、skipped 不计通过。
// 迁移链按 brief 依赖序幂等 apply（MT004→…→MT070，十六任务）；KB 库经
// drizzle-kb journal 幂等迁移。

import { afterAll, beforeAll, describe, expect, test } from "../../../tests/support/bun-test-compat";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import {
  buildPlan,
  manifestFor,
  type RunOutcome,
  resolveTestDatabaseTarget,
  runMigrateTest,
} from "../../scripts/multitenancy/migrate-test";
import { createKbOwnershipAuthority } from "../../src/enterprise/tenancy/kb-ownership";
import {
  notFoundVerdict,
  serializeNotFoundVerdict,
} from "../../src/enterprise/tenancy/not-found-semantics";
import {
  createRestrictedDocumentLifecycleService,
  processDocumentWithScopeRebuild,
  rebuildDocumentExecutionPayload,
} from "../../src/kb/application/service/kb-document-lifecycle";
import { chunkRevisions, chunks, knowledges } from "../../src/kb/db/schema";
import { createParserRegistry } from "../../src/kb/infrastructure/docparser/registry";
import type { ProcessDeps } from "../../src/kb/tasks/document-process";
import {
  createDocumentLifecycleFixture,
  createRecordingStore,
  type DocumentLifecycleFixture,
  mockEmbedder,
  probeDocumentLifecycleEnvironment,
  type RecordedScopedPayload,
  recordingIndexWriter,
} from "./support/document-lifecycle";
import { applyKbOwnershipMigrations } from "./support/kb-ownership";

const ENV = probeDocumentLifecycleEnvironment();
const itDb = ((name: string, fn: () => void | Promise<void>) =>
  ENV.ok
    ? test(name, fn)
    : test.skip(`${name} [skipped: ${ENV.reason}]`, fn)) as typeof test;
const describeDb = ENV.ok ? describe : describe.skip;

/** 主库迁移链（brief 依赖序；幂等：applied | up-to-date）。 */
const MIGRATION_CHAIN = [
  "MT004",
  "MT008",
  "MT112",
  "MT012",
  "MT014",
  "MT010",
  "MT009",
  "MT077",
  "MT026",
  "MT076",
  "MT069",
  "MT016",
  "MT041",
  "MT027",
  "MT028",
  "MT070",
] as const;

/** 断言 promise 以指定哨兵码拒绝（纯码形态，零值回显）。 */
async function expectSentinelRejection(
  promise: Promise<unknown>,
  code: string,
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error instanceof Error && error.message === code).toBe(true);
    return;
  }
  throw new Error(`expected rejection with sentinel code ${code}, got resolve`);
}

/** canonical 不可见判定（与 not-found-semantics 单一事实源同字节）。 */
const invisibleShape = (result: {
  ok: boolean;
  kind?: string;
  verdict?: unknown;
}): boolean =>
  result.ok === false &&
  result.kind === "invisible" &&
  serializeNotFoundVerdict(result.verdict as never) ===
    serializeNotFoundVerdict(notFoundVerdict());

describeDb("MT038 — 文档上传、删除、导入与重解析的作用域", () => {
  let fixture: DocumentLifecycleFixture;
  let authority: ReturnType<typeof createKbOwnershipAuthority>;
  let service: ReturnType<typeof createRestrictedDocumentLifecycleService>;
  let tenantA = "";
  let tenantB = "";
  let teamA1 = "";
  let teamA2 = "";
  let teamB1 = "";
  // 种子库。
  let kbA1Pub = "";
  let kbA1Grant = "";
  let kbB1Grant = "";
  let kbA1Exec = "";
  let kbA1Move = "";
  let kbA1Stale = "";
  let kbA1MovedNs = "";
  // 记录器。
  let enqueued: RecordedScopedPayload[];
  let storeRoot = "";
  let store: ReturnType<typeof createRecordingStore>;
  let proc: ReturnType<typeof recordingIndexWriter>;
  let embedder: ReturnType<typeof mockEmbedder>;

  const scopeOf = (
    identity: Parameters<DocumentLifecycleFixture["ent"]["scopeFor"]>[0],
    tenantId: string,
    workspaceId: string,
  ) => fixture.ent.scopeFor(identity, { tenantId, workspaceId });

  const principalOf = (
    identity: "a1-member" | "a1a2-member",
    teamKey: "team-a1",
  ) => fixture.ent.teamOf(identity, teamKey).principalId;

  /** 手工长文（≥2 chunk @512/64 配置）。 */
  const longPassages = (): string =>
    Array.from(
      { length: 10 },
      (_, i) => `第${i}段。${"内容句子。".repeat(30)}`,
    ).join("\n\n");

  const processDeps = (): ProcessDeps => ({
    db: fixture.kbDb,
    // 真实注册表（simple 本地四类；txt 文档执行侧重建用例走真实解析）。
    registry: createParserRegistry(null),
    embedder: embedder as never,
    indexWriter: proc.writer,
  });

  beforeAll(async () => {
    if (!ENV.ok) return;

    // 主库迁移链按 brief 依赖序经 MT003 工具真实执行（幂等）。
    const resolved = resolveTestDatabaseTarget(process.env);
    if (!resolved.ok) {
      throw new Error(`MT038 migration target refused: ${resolved.reason}`);
    }
    const migrationEnv = { TEST_DATABASE_URL: resolved.target.url };
    for (const task of MIGRATION_CHAIN) {
      const dryRun: RunOutcome = await runMigrateTest(["migrate", task], {
        environment: migrationEnv,
        out: () => {},
      });
      if (dryRun.kind !== "dry-run") {
        throw new Error(`${task} dry-run failed: ${JSON.stringify(dryRun)}`);
      }
      const manifestPath = `/tmp/mt038-manifest-${task}-${randomUUID()}.json`;
      await Bun.write(
        manifestPath,
        `${JSON.stringify(manifestFor(buildPlan(task)), null, 2)}\n`,
      );
      try {
        const applied: RunOutcome = await runMigrateTest(
          ["migrate", task, "--apply", "--manifest", manifestPath],
          { environment: migrationEnv, out: () => {} },
        );
        if (!["applied", "up-to-date"].includes(applied.kind)) {
          throw new Error(`${task} apply failed: ${JSON.stringify(applied)}`);
        }
      } finally {
        await rm(manifestPath, { force: true });
      }
    }

    // KB 专用测试库迁移（drizzle-kb journal，幂等；对齐 kb-ownership /
    // retrieval-restriction 兄弟套件的自足模式——聚焦首跑不依赖配方先行）。
    await applyKbOwnershipMigrations();

    fixture = await createDocumentLifecycleFixture();
    const ids = fixture.ent.isolation.ids;
    tenantA = ids["company-a"];
    tenantB = ids["company-b"];
    teamA1 = ids["team-a1"];
    teamA2 = ids["team-a2"];
    teamB1 = ids["team-b1"];

    // 公司 A 翻到 workspace-v1（团队公共语义）；公司 B 保持 tenancy-v1。
    await fixture.setTenantPolicyRevision(tenantA, "workspace-v1");

    kbA1Pub = await fixture.seedKnowledgeBase({
      key: "kb-a1-pub",
      tenantId: tenantA,
      workspaceId: teamA1,
      name: "A1 team-public KB",
      visibility: "workspace",
    });
    kbA1Grant = await fixture.seedKnowledgeBase({
      key: "kb-a1-grant",
      tenantId: tenantA,
      workspaceId: teamA1,
      name: "A1 grant-only KB",
      readers: [{ identity: "a1-member", teamKey: "team-a1" }],
    });
    kbB1Grant = await fixture.seedKnowledgeBase({
      key: "kb-b1-grant",
      tenantId: tenantB,
      workspaceId: teamB1,
      name: "B1 grant-only KB",
      readers: [{ identity: "b1-member", teamKey: "team-b1" }],
    });
    kbA1Exec = await fixture.seedKnowledgeBase({
      key: "kb-a1-exec",
      tenantId: tenantA,
      workspaceId: teamA1,
      name: "A1 execution KB",
      visibility: "workspace",
    });
    kbA1Move = await fixture.seedKnowledgeBase({
      key: "kb-a1-move",
      tenantId: tenantA,
      workspaceId: teamA1,
      name: "A1 move-exec KB",
      visibility: "workspace",
    });
    kbA1Stale = await fixture.seedKnowledgeBase({
      key: "kb-a1-stale",
      tenantId: tenantA,
      workspaceId: teamA1,
      name: "A1 stale-mirror KB",
      visibility: "workspace",
    });
    kbA1MovedNs = await fixture.seedKnowledgeBase({
      key: "kb-a1-mvns",
      tenantId: tenantA,
      workspaceId: teamA1,
      name: "A1 moved-ns KB",
      visibility: "workspace",
    });

    authority = createKbOwnershipAuthority(fixture.ent.data);
    enqueued = [];
    storeRoot = join(tmpdir(), `mt038-store-${randomUUID().slice(0, 8)}`);
    store = createRecordingStore(storeRoot);
    proc = recordingIndexWriter();
    embedder = mockEmbedder();
    service = createRestrictedDocumentLifecycleService({
      authority,
      kbDb: fixture.kbDb,
      indexWriter: proc.writer,
      storeFile: store.storeFile,
      enqueue: async (payload) => {
        enqueued.push(payload as RecordedScopedPayload);
      },
    });
  }, 180000);

  afterAll(async () => {
    await fixture?.dispose();
    await rm(storeRoot, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------
  // AC1：上传的文档归属当前范围；非成员看不到也下载不到原文件。
  // -----------------------------------------------------------------
  describeDb("MT038 AC1: 上传归属与非成员不可见", () => {
    itDb("上传文档归属当前范围（行、存储与任务载荷同归属）", async () => {
      const scope = await scopeOf("a1-member", tenantA, teamA1);
      const content = new TextEncoder().encode("mt038 original file body");
      const result = await service.uploadDocument(
        { scope },
        {
          kbId: kbA1Pub,
          kind: "file",
          fileName: "handbook.txt",
          content,
        },
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.duplicate).toBe(false);
      const [row] = await fixture.kbDb
        .select()
        .from(knowledges)
        .where(eq(knowledges.id, result.knowledgeId));
      expect(row).toBeDefined();
      expect(row?.tenantId).toBe(tenantA);
      expect(row?.knowledgeBaseId).toBe(kbA1Pub);
      expect(row?.fileName).toBe("handbook.txt");
      expect(row?.filePath).toBe(store.stored[0]?.path);
      expect(Array.from(store.stored[0]?.bytes ?? [])).toEqual(
        Array.from(content),
      );
      const payload = enqueued.at(-1) as RecordedScopedPayload;
      expect(payload?.tenantId).toBe(tenantA);
      expect(payload?.kbId).toBe(kbA1Pub);
      expect(payload?.knowledgeId).toBe(result.knowledgeId);
      expect(payload?.initiatingWorkspaceId).toBe(teamA1);
      expect(payload?.initiatingPrincipalId).toBe(
        principalOf("a1-member", "team-a1"),
      );
    });

    itDb("成员可读原文件事实；非成员与不存在 id 同一不可见形状", async () => {
      const scope = await scopeOf("a1-member", tenantA, teamA1);
      const upload = await service.uploadDocument(
        { scope },
        {
          kbId: kbA1Pub,
          kind: "file",
          fileName: "policy.md",
          content: new TextEncoder().encode("# policy"),
        },
      );
      expect(upload.ok).toBe(true);
      if (!upload.ok) return;
      const member = await service.readOriginalFile(
        { scope },
        { kbId: kbA1Pub, docId: upload.knowledgeId },
      );
      expect(member.ok).toBe(true);
      if (member.ok) {
        expect(member.file.path).toBe(store.stored.at(-1)?.path);
        expect(member.file.fileName).toBe("policy.md");
      }
      // 非成员（跨团队 a2 / 跨公司 b1）：下载面不可达。
      const a2 = await scopeOf("a2-member", tenantA, teamA2);
      const outsider = await service.readOriginalFile(
        { scope: a2 },
        { kbId: kbA1Pub, docId: upload.knowledgeId },
      );
      expect(invisibleShape(outsider)).toBe(true);
      const b1 = await scopeOf("b1-member", tenantB, teamB1);
      const foreign = await service.readOriginalFile(
        { scope: b1 },
        { kbId: kbA1Pub, docId: upload.knowledgeId },
      );
      expect(invisibleShape(foreign)).toBe(true);
      // 不存在 id 与跨范围 id 同一形状（不泄露存在性）。
      const absent = await service.readOriginalFile(
        { scope },
        { kbId: kbA1Pub, docId: "mt038-nonexistent-doc" },
      );
      expect(invisibleShape(absent)).toBe(true);
    });

    itDb("原文件包含性：已授权 KB + 跨库/跨租户 docId → 不可见", async () => {
      // 同租户跨库：a1 对 kbA1Pub/kbA1Grant 均有读授权，但原文件在 kbA1Grant 的
      // 文档上——以 kbA1Pub 寻址读取必须不可见（下载门只认本 KB 包含性）。
      const xkbDocId = await fixture.seedDocument({
        key: "orig-xkb",
        kbId: kbA1Grant,
        tenantId: tenantA,
        type: "file",
        fileName: "grant-secret.txt",
        fileType: "txt",
        filePath: "/mt038-virtual/orig-xkb/grant-secret.txt",
        parseStatus: "completed",
      });
      const scope = await scopeOf("a1-member", tenantA, teamA1);
      const crossKb = await service.readOriginalFile(
        { scope },
        { kbId: kbA1Pub, docId: xkbDocId },
      );
      expect(invisibleShape(crossKb)).toBe(true);
      // 跨租户：b1 对 kbB1Grant 有授权；docId 指向公司 A 的原文件——同样不可见，
      // 绝不回显他司文件事实（AC1「非成员下载不到原文件」的跨公司面）。
      const xcoDocId = await fixture.seedDocument({
        key: "orig-xco",
        kbId: kbA1Pub,
        tenantId: tenantA,
        type: "file",
        fileName: "a-secret.txt",
        fileType: "txt",
        filePath: "/mt038-virtual/orig-xco/a-secret.txt",
        parseStatus: "completed",
      });
      const b1 = await scopeOf("b1-member", tenantB, teamB1);
      const crossTenant = await service.readOriginalFile(
        { scope: b1 },
        { kbId: kbB1Grant, docId: xcoDocId },
      );
      expect(invisibleShape(crossTenant)).toBe(true);
    });

    itDb("停用成员上传立即被拒且零入队；恢复成员资格后复得（A5）", async () => {
      const scope = await scopeOf("a1-member", tenantA, teamA1);
      const enqueuedBefore = enqueued.length;
      await fixture.ent.setTeamMembershipStatus(
        "a1-member",
        "team-a1",
        "suspended",
      );
      try {
        const denied = await service.uploadDocument(
          { scope },
          {
            kbId: kbA1Pub,
            kind: "text",
            content: "suspended body",
            title: "t",
          },
        );
        expect(invisibleShape(denied)).toBe(true);
        expect(enqueued.length).toBe(enqueuedBefore);
      } finally {
        await fixture.ent.setTeamMembershipStatus(
          "a1-member",
          "team-a1",
          "active",
        );
      }
      const recovered = await service.uploadDocument(
        { scope },
        { kbId: kbA1Pub, kind: "text", content: "recovered body", title: "t2" },
      );
      expect(recovered.ok).toBe(true);
    });

    itDb("去重只在本租户本库命中；他司同哈希不去重", async () => {
      const scope = await scopeOf("a1-member", tenantA, teamA1);
      const content = new TextEncoder().encode("dedup probe content mt038");
      const first = await service.uploadDocument(
        { scope },
        { kbId: kbA1Pub, kind: "file", fileName: "same.txt", content },
      );
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      const enqueuedAfterFirst = enqueued.length;
      const second = await service.uploadDocument(
        { scope },
        { kbId: kbA1Pub, kind: "file", fileName: "same.txt", content },
      );
      expect(second.ok).toBe(true);
      if (!second.ok) return;
      expect(second.duplicate).toBe(true);
      expect(second.knowledgeId).toBe(first.knowledgeId);
      expect(enqueued.length).toBe(enqueuedAfterFirst);
      // 他司同哈希：b1 上传同内容 → 新文档（去重查询租户限定，不命中 A 的行）；
      // b1 再次上传 → 命中本租户本库的去重。
      const b1 = await scopeOf("b1-member", tenantB, teamB1);
      const foreign = await service.uploadDocument(
        { scope: b1 },
        { kbId: kbB1Grant, kind: "file", fileName: "same.txt", content },
      );
      expect(foreign.ok).toBe(true);
      if (!foreign.ok) return;
      expect(foreign.duplicate).toBe(false);
      expect(foreign.knowledgeId).not.toBe(first.knowledgeId);
      const foreignAgain = await service.uploadDocument(
        { scope: b1 },
        { kbId: kbB1Grant, kind: "file", fileName: "same.txt", content },
      );
      expect(foreignAgain.ok).toBe(true);
      if (!foreignAgain.ok) return;
      expect(foreignAgain.duplicate).toBe(true);
      expect(foreignAgain.knowledgeId).toBe(foreign.knowledgeId);
    });
  });

  // -----------------------------------------------------------------
  // AC2：导入与重解析任务保存发起归属，执行时重建作用域。
  // -----------------------------------------------------------------
  describeDb("MT038 AC2: 任务归属与执行时重建", () => {
    itDb("url 导入保存发起归属（行与载荷）", async () => {
      const scope = await scopeOf("a1-member", tenantA, teamA1);
      const result = await service.importDocument(
        { scope },
        {
          kbId: kbA1Pub,
          url: "https://example.com/mt038-import",
          title: "imported",
        },
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const [row] = await fixture.kbDb
        .select()
        .from(knowledges)
        .where(eq(knowledges.id, result.knowledgeId));
      expect(row?.tenantId).toBe(tenantA);
      expect(row?.type).toBe("url");
      expect(row?.source).toBe("https://example.com/mt038-import");
      const payload = enqueued.at(-1) as RecordedScopedPayload;
      expect(payload?.tenantId).toBe(tenantA);
      expect(payload?.url).toBe("https://example.com/mt038-import");
      expect(payload?.initiatingWorkspaceId).toBe(teamA1);
      expect(payload?.initiatingPrincipalId).toBe(
        principalOf("a1-member", "team-a1"),
      );
    });

    itDb("重解析任务保存发起归属并推进世代号", async () => {
      const docId = await fixture.seedDocument({
        key: "rp-attr",
        kbId: kbA1Pub,
        tenantId: tenantA,
        type: "manual",
        parseStatus: "completed",
        attempt: 3,
      });
      const scope = await scopeOf("a1a2-member", tenantA, teamA1);
      const result = await service.reparseDocument(
        { scope },
        { kbId: kbA1Pub, docId },
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.attempt).toBe(4);
      const [row] = await fixture.kbDb
        .select()
        .from(knowledges)
        .where(eq(knowledges.id, docId));
      expect(row?.attempt).toBe(4);
      expect(row?.parseStatus).toBe("pending");
      const payload = enqueued.at(-1) as RecordedScopedPayload;
      expect(payload?.attempt).toBe(4);
      expect(payload?.knowledgeId).toBe(docId);
      expect(payload?.tenantId).toBe(tenantA);
      expect(payload?.initiatingWorkspaceId).toBe(teamA1);
      expect(payload?.initiatingPrincipalId).toBe(
        principalOf("a1a2-member", "team-a1"),
      );
    });

    itDb(
      "执行重建：payload 谎报租户/库被权威行改写，产物同权威归属",
      async () => {
        const docId = await fixture.seedDocument({
          key: "rebuild-tamper",
          kbId: kbA1Exec,
          tenantId: tenantA,
          type: "manual",
          parseStatus: "pending",
          attempt: 0,
        });
        const tampered = {
          requestId: randomUUID(),
          tenantId: "tampered-tenant",
          knowledgeId: docId,
          kbId: "tampered-kb",
          filePath: "",
          fileName: "text.txt",
          fileType: "txt",
          url: "",
          fileUrl: "",
          passages: longPassages(),
          attempt: 0,
          initiatingWorkspaceId: "tampered-workspace",
          initiatingPrincipalId: "tampered-principal",
        };
        const rebuilt = await rebuildDocumentExecutionPayload(
          fixture.kbDb,
          tampered,
        );
        expect(rebuilt.kind).toBe("proceed");
        if (rebuilt.kind !== "proceed") return;
        expect(rebuilt.payload.tenantId).toBe(tenantA);
        expect(rebuilt.payload.kbId).toBe(kbA1Exec);
        expect(rebuilt.workspaceId).toBe(teamA1);
        const outcome = await processDocumentWithScopeRebuild(
          processDeps(),
          tampered,
        );
        expect(outcome.skipped).toBeUndefined();
        const chunkRows = await fixture.kbDb
          .select()
          .from(chunks)
          .where(eq(chunks.knowledgeId, docId));
        expect(chunkRows.length).toBeGreaterThanOrEqual(2);
        expect(
          chunkRows.every(
            (c) => c.tenantId === tenantA && c.knowledgeBaseId === kbA1Exec,
          ),
        ).toBe(true);
        const revisionRows = await fixture.kbDb
          .select()
          .from(chunkRevisions)
          .where(eq(chunkRevisions.knowledgeId, docId));
        expect(revisionRows.length).toBe(chunkRows.length);
        expect(
          revisionRows.every(
            (r) => r.tenantId === tenantA && r.knowledgeBaseId === kbA1Exec,
          ),
        ).toBe(true);
        expect(
          proc.points.every(
            (p) => p.tenantId === tenantA && p.kbId === kbA1Exec,
          ),
        ).toBe(true);
        const foreignChunks = await fixture.kbDb
          .select()
          .from(chunks)
          .where(eq(chunks.tenantId, "tampered-tenant"));
        expect(foreignChunks.length).toBe(0);
        const [docRow] = await fixture.kbDb
          .select()
          .from(knowledges)
          .where(eq(knowledges.id, docId));
        expect(docRow?.parseStatus).toBe("completed");
      },
    );

    itDb("执行重建：镜像缺失 → skip，零 chunk 零索引", async () => {
      const docId = await fixture.seedDocument({
        key: "rebuild-nomirror",
        kbId: kbA1Exec,
        tenantId: tenantA,
        parseStatus: "pending",
      });
      await fixture.deleteMirrorRow({ kbId: kbA1Exec });
      const callsBefore = proc.calls.length;
      const outcome = await processDocumentWithScopeRebuild(processDeps(), {
        requestId: randomUUID(),
        tenantId: tenantA,
        knowledgeId: docId,
        kbId: kbA1Exec,
        filePath: "",
        fileName: "text.txt",
        fileType: "txt",
        url: "",
        fileUrl: "",
        passages: longPassages(),
        attempt: 0,
      });
      expect(outcome.skipped).toBe("ownership-missing");
      const rows = await fixture.kbDb
        .select()
        .from(chunks)
        .where(eq(chunks.knowledgeId, docId));
      expect(rows.length).toBe(0);
      expect(proc.calls.length).toBe(callsBefore);
    });

    itDb("执行重建：镜像租户漂移 → skip（不写入漂移范围）", async () => {
      const docId = await fixture.seedDocument({
        key: "rebuild-drift",
        kbId: kbA1Exec,
        tenantId: tenantA,
        parseStatus: "pending",
      });
      // 上一用例删除了镜像；先复原再制造「租户漂移」形态。
      await fixture.syncKbOwnershipState({ tenantId: tenantA, kbId: kbA1Exec });
      await fixture.corruptMirrorTenant({ kbId: kbA1Exec, tenantId: tenantB });
      const outcome = await processDocumentWithScopeRebuild(processDeps(), {
        requestId: randomUUID(),
        tenantId: tenantA,
        knowledgeId: docId,
        kbId: kbA1Exec,
        filePath: "",
        fileName: "text.txt",
        fileType: "txt",
        url: "",
        fileUrl: "",
        passages: longPassages(),
        attempt: 0,
      });
      expect(outcome.skipped).toBe("ownership-mismatch");
      const rows = await fixture.kbDb
        .select()
        .from(chunks)
        .where(eq(chunks.knowledgeId, docId));
      expect(rows.length).toBe(0);
    });

    itDb("执行重建：行缺失 → skip missing", async () => {
      const outcome = await processDocumentWithScopeRebuild(processDeps(), {
        requestId: randomUUID(),
        tenantId: tenantA,
        knowledgeId: "mt038-absent-doc",
        kbId: kbA1Exec,
        filePath: "",
        fileName: "text.txt",
        fileType: "txt",
        url: "",
        fileUrl: "",
        passages: "orphan",
        attempt: 0,
      });
      expect(outcome.skipped).toBe("missing");
    });

    itDb("执行重建：世代号落后照常被守卫跳过", async () => {
      const docId = await fixture.seedDocument({
        key: "rebuild-attempt",
        kbId: kbA1Exec,
        tenantId: tenantA,
        parseStatus: "pending",
        attempt: 5,
      });
      await fixture.syncKbOwnershipState({ tenantId: tenantA, kbId: kbA1Exec });
      const outcome = await processDocumentWithScopeRebuild(processDeps(), {
        requestId: randomUUID(),
        tenantId: tenantA,
        knowledgeId: docId,
        kbId: kbA1Exec,
        filePath: "",
        fileName: "text.txt",
        fileType: "txt",
        url: "",
        fileUrl: "",
        passages: longPassages(),
        attempt: 4,
      });
      expect(outcome.skipped).toBe("attemptSuperseded");
    });
  });

  // -----------------------------------------------------------------
  // AC3：删除只影响本范围文档；跨范围删除请求被拒绝。
  // -----------------------------------------------------------------
  describeDb("MT038 AC3: 删除作用域", () => {
    itDb("范围内删除级联：Qdrant 先行、chunks 硬删、行软删", async () => {
      const docId = await fixture.seedDocument({
        key: "del-own",
        kbId: kbA1Pub,
        tenantId: tenantA,
        parseStatus: "completed",
      });
      const chunkIds = await fixture.seedChunks({
        docId,
        kbId: kbA1Pub,
        tenantId: tenantA,
        contents: ["chunk one", "chunk two"],
      });
      expect(chunkIds.length).toBe(2);
      const callsBefore = proc.calls.length;
      const scope = await scopeOf("a1-member", tenantA, teamA1);
      const result = await service.deleteDocument(
        { scope },
        { kbId: kbA1Pub, docId },
      );
      expect(result.ok).toBe(true);
      expect(proc.calls[callsBefore]).toBe(`deleteDoc:${tenantA}:${docId}`);
      const chunkRows = await fixture.kbDb
        .select()
        .from(chunks)
        .where(eq(chunks.knowledgeId, docId));
      expect(chunkRows.length).toBe(0);
      const [row] = await fixture.kbDb
        .select()
        .from(knowledges)
        .where(eq(knowledges.id, docId));
      expect(row?.deletedAt).not.toBeNull();
    });

    itDb("跨团队删除被拒且零触碰", async () => {
      const docId = await fixture.seedDocument({
        key: "del-xteam",
        kbId: kbA1Pub,
        tenantId: tenantA,
        parseStatus: "completed",
      });
      await fixture.seedChunks({
        docId,
        kbId: kbA1Pub,
        tenantId: tenantA,
        contents: ["surviving chunk"],
      });
      const callsBefore = proc.calls.length;
      const a2 = await scopeOf("a2-member", tenantA, teamA2);
      const result = await service.deleteDocument(
        { scope: a2 },
        { kbId: kbA1Pub, docId },
      );
      expect(invisibleShape(result)).toBe(true);
      const chunkRows = await fixture.kbDb
        .select()
        .from(chunks)
        .where(eq(chunks.knowledgeId, docId));
      expect(chunkRows.length).toBe(1);
      const [row] = await fixture.kbDb
        .select()
        .from(knowledges)
        .where(eq(knowledges.id, docId));
      expect(row?.deletedAt).toBeNull();
      expect(proc.calls.length).toBe(callsBefore);
    });

    itDb("跨公司删除被拒且零触碰", async () => {
      const docId = await fixture.seedDocument({
        key: "del-xco",
        kbId: kbA1Pub,
        tenantId: tenantA,
        parseStatus: "completed",
      });
      const b1 = await scopeOf("b1-member", tenantB, teamB1);
      const result = await service.deleteDocument(
        { scope: b1 },
        { kbId: kbA1Pub, docId },
      );
      expect(invisibleShape(result)).toBe(true);
      const [row] = await fixture.kbDb
        .select()
        .from(knowledges)
        .where(eq(knowledges.id, docId));
      expect(row?.deletedAt).toBeNull();
    });

    itDb("不存在与跨范围删除同一不可见形状（错误集合大小=1）", async () => {
      const docId = await fixture.seedDocument({
        key: "del-shape",
        kbId: kbA1Pub,
        tenantId: tenantA,
      });
      const a2 = await scopeOf("a2-member", tenantA, teamA2);
      const crossScope = await service.deleteDocument(
        { scope: a2 },
        { kbId: kbA1Pub, docId },
      );
      const scope = await scopeOf("a1-member", tenantA, teamA1);
      const absent = await service.deleteDocument(
        { scope },
        { kbId: kbA1Pub, docId: "mt038-absent-del" },
      );
      const shapes = new Set(
        [crossScope, absent].map((r) =>
          r.ok || r.kind !== "invisible"
            ? "unexpected"
            : serializeNotFoundVerdict(r.verdict),
        ),
      );
      expect(shapes.size).toBe(1);
    });

    itDb("文档不属于所传 KB（同租户跨库）→ 不可见零触碰", async () => {
      const docId = await fixture.seedDocument({
        key: "del-xkb",
        kbId: kbA1Grant,
        tenantId: tenantA,
        parseStatus: "completed",
      });
      const callsBefore = proc.calls.length;
      const scope = await scopeOf("a1-member", tenantA, teamA1);
      const result = await service.deleteDocument(
        { scope },
        { kbId: kbA1Pub, docId },
      );
      expect(invisibleShape(result)).toBe(true);
      const [row] = await fixture.kbDb
        .select()
        .from(knowledges)
        .where(eq(knowledges.id, docId));
      expect(row?.deletedAt).toBeNull();
      expect(proc.calls.length).toBe(callsBefore);
    });

    itDb(
      "重解析包含性：已授权 KB + 跨库/跨租户 docId → 不可见零副作用",
      async () => {
        const scope = await scopeOf("a1-member", tenantA, teamA1);
        // 同租户跨库：文档在 kbA1Grant——以 kbA1Pub 寻址重解析必须不可见，
        // 且原文档世代号不被推进、任务不入队（跨范围不产生任何写副作用）。
        const xkbDocId = await fixture.seedDocument({
          key: "rp-xkb",
          kbId: kbA1Grant,
          tenantId: tenantA,
          parseStatus: "completed",
          attempt: 2,
        });
        const enqueuedBefore = enqueued.length;
        const crossKb = await service.reparseDocument(
          { scope },
          { kbId: kbA1Pub, docId: xkbDocId },
        );
        expect(invisibleShape(crossKb)).toBe(true);
        const [xkbRow] = await fixture.kbDb
          .select()
          .from(knowledges)
          .where(eq(knowledges.id, xkbDocId));
        expect(xkbRow?.attempt).toBe(2);
        expect(enqueued.length).toBe(enqueuedBefore);
        // 跨租户：公司 A 成员的 docId 指向公司 B 的文档——同样不可见零副作用。
        const xcoDocId = await fixture.seedDocument({
          key: "rp-xco",
          kbId: kbB1Grant,
          tenantId: tenantB,
          parseStatus: "completed",
          attempt: 5,
        });
        const crossTenant = await service.reparseDocument(
          { scope },
          { kbId: kbA1Pub, docId: xcoDocId },
        );
        expect(invisibleShape(crossTenant)).toBe(true);
        const [xcoRow] = await fixture.kbDb
          .select()
          .from(knowledges)
          .where(eq(knowledges.id, xcoDocId));
        expect(xcoRow?.attempt).toBe(5);
        expect(enqueued.length).toBe(enqueuedBefore);
      },
    );
  });

  // -----------------------------------------------------------------
  // AC4：重解析产生的 chunk/revision 与原文件归属一致，无跨范围中间产物。
  // -----------------------------------------------------------------
  describeDb("MT038 AC4: 重解析产物归属一致", () => {
    itDb(
      "重解析后执行：file 文档真实载荷再被篡改租户，产物仍全权威归属",
      async () => {
        // 先上传 file 文档（真实临时文件），再模拟首次解析成功完成。
        const uploader = await scopeOf("a1-member", tenantA, teamA1);
        const upload = await service.uploadDocument(
          { scope: uploader },
          {
            kbId: kbA1Exec,
            kind: "file",
            fileName: "handbook.txt",
            content: new TextEncoder().encode(longPassages()),
          },
        );
        expect(upload.ok).toBe(true);
        if (!upload.ok) return;
        await fixture.kbDb
          .update(knowledges)
          .set({ parseStatus: "completed", attempt: 1 })
          .where(eq(knowledges.id, upload.knowledgeId));
        // 另一成员发起重解析：任务保存发起归属。
        const scope = await scopeOf("a1a2-member", tenantA, teamA1);
        const reparse = await service.reparseDocument(
          { scope },
          { kbId: kbA1Exec, docId: upload.knowledgeId },
        );
        expect(reparse.ok).toBe(true);
        if (!reparse.ok) return;
        expect(reparse.attempt).toBe(2);
        const payload = enqueued.at(-1) as RecordedScopedPayload;
        expect(payload?.attempt).toBe(2);
        expect(payload?.initiatingPrincipalId).toBe(
          principalOf("a1a2-member", "team-a1"),
        );
        expect(payload?.filePath).toBe(store.stored.at(-1)?.path);
        // 队列内容被篡改租户（模拟跨范围注入），执行侧必须以权威行为准。
        const tampered: RecordedScopedPayload = {
          ...payload,
          tenantId: tenantB,
        };
        const outcome = await processDocumentWithScopeRebuild(
          processDeps(),
          tampered,
        );
        expect(outcome.skipped).toBeUndefined();
        const chunkRows = await fixture.kbDb
          .select()
          .from(chunks)
          .where(eq(chunks.knowledgeId, upload.knowledgeId));
        expect(chunkRows.length).toBeGreaterThanOrEqual(2);
        const revisionRows = await fixture.kbDb
          .select()
          .from(chunkRevisions)
          .where(eq(chunkRevisions.knowledgeId, upload.knowledgeId));
        expect(revisionRows.length).toBe(chunkRows.length);
        expect(revisionRows.every((r) => r.tenantId === tenantA)).toBe(true);
        const points = proc.points.slice(proc.points.length - chunkRows.length);
        expect(
          points.every(
            (p) => p.tenantId === tenantA && p.docId === upload.knowledgeId,
          ),
        ).toBe(true);
        const foreign = await fixture.kbDb
          .select()
          .from(chunks)
          .where(eq(chunks.tenantId, tenantB));
        expect(foreign.length).toBe(0);
      },
    );

    itDb("KB 迁移后执行按当前镜像重建（发起归属保留为审计）", async () => {
      const docId = await fixture.seedDocument({
        key: "rp-move",
        kbId: kbA1Move,
        tenantId: tenantA,
        type: "manual",
        parseStatus: "pending",
        attempt: 0,
      });
      const payload: RecordedScopedPayload = {
        requestId: randomUUID(),
        tenantId: tenantA,
        knowledgeId: docId,
        kbId: kbA1Move,
        filePath: "",
        fileName: "text.txt",
        fileType: "txt",
        url: "",
        fileUrl: "",
        passages: longPassages(),
        attempt: 0,
        initiatingWorkspaceId: teamA1,
        initiatingPrincipalId: principalOf("a1-member", "team-a1"),
      };
      await fixture.moveKnowledgeBaseOwnership({
        tenantId: tenantA,
        kbId: kbA1Move,
        toWorkspaceId: teamA2,
        syncKbSide: true,
      });
      const rebuilt = await rebuildDocumentExecutionPayload(
        fixture.kbDb,
        payload,
      );
      expect(rebuilt.kind).toBe("proceed");
      if (rebuilt.kind !== "proceed") return;
      expect(rebuilt.workspaceId).toBe(teamA2);
      expect(rebuilt.payload.tenantId).toBe(tenantA);
      const outcome = await processDocumentWithScopeRebuild(
        processDeps(),
        payload,
      );
      expect(outcome.skipped).toBeUndefined();
      const rows = await fixture.kbDb
        .select()
        .from(chunks)
        .where(eq(chunks.knowledgeId, docId));
      expect(rows.length).toBeGreaterThanOrEqual(2);
    });
  });

  // -----------------------------------------------------------------
  // 入口边界：信任门 / 源码级纪律 / 输入卫生 / 授权与一致性拒绝面。
  // -----------------------------------------------------------------
  describeDb("MT038 入口边界与拒绝面", () => {
    itDb("内部身份形状四动作全拒 KB_REQUESTER_INVALID 且零副作用", async () => {
      const enqueuedBefore = enqueued.length;
      const callsBefore = proc.calls.length;
      const internalIdentity = {
        tenantId: tenantA,
        role: "admin",
        kbScope: "",
      } as never;
      await expectSentinelRejection(
        service.uploadDocument(internalIdentity, {
          kbId: kbA1Pub,
          kind: "text",
          content: "x",
        }),
        "KB_REQUESTER_INVALID",
      );
      await expectSentinelRejection(
        service.importDocument(internalIdentity, {
          kbId: kbA1Pub,
          url: "https://example.com/x",
        }),
        "KB_REQUESTER_INVALID",
      );
      await expectSentinelRejection(
        service.deleteDocument(internalIdentity, { kbId: kbA1Pub, docId: "d" }),
        "KB_REQUESTER_INVALID",
      );
      await expectSentinelRejection(
        service.reparseDocument(internalIdentity, {
          kbId: kbA1Pub,
          docId: "d",
        }),
        "KB_REQUESTER_INVALID",
      );
      await expectSentinelRejection(
        service.readOriginalFile(internalIdentity, {
          kbId: kbA1Pub,
          docId: "d",
        }),
        "KB_REQUESTER_INVALID",
      );
      expect(enqueued.length).toBe(enqueuedBefore);
      expect(proc.calls.length).toBe(callsBefore);
    });

    itDb("伪造 scope（非 seam 签发）→ UNVERIFIED_SCOPE", async () => {
      const forged = {
        scope: {
          tenantId: tenantA,
          workspaceId: teamA1,
          principalId: "forged-principal",
          actorId: "forged-actor",
        },
      } as never;
      await expectSentinelRejection(
        service.uploadDocument(forged, {
          kbId: kbA1Pub,
          kind: "text",
          content: "x",
        }),
        "UNVERIFIED_SCOPE",
      );
    });

    itDb(
      "伪造 scope：信任门先于一切输入校验（空 kbId 亦先拒 UNVERIFIED_SCOPE）",
      async () => {
        // 信任边界是入口第一门：未验证请求者一律先收信任哨兵，不能借参数形状
        // 探测入口的输入校验行为（信任门与 KB_ID_REQUIRED 的先后次序面）。
        const forged = {
          scope: {
            tenantId: tenantA,
            workspaceId: teamA1,
            principalId: "forged-principal-2",
            actorId: "forged-actor-2",
          },
        } as never;
        await expectSentinelRejection(
          service.uploadDocument(forged, {
            kbId: "",
            kind: "text",
            content: "x",
          }),
          "UNVERIFIED_SCOPE",
        );
      },
    );

    itDb("源码级：生命周期入口不携带内部身份词汇（注释剥离后）", async () => {
      const stripComments = (source: string): string =>
        source.replace(/\/\/.*$/gm, "");
      const entrySource = stripComments(
        await Bun.file(
          "src/kb/application/service/kb-document-lifecycle.ts",
        ).text(),
      );
      expect(entrySource).not.toContain("kbScope");
      expect(entrySource).not.toContain("APIKeyEntry");
    });

    itDb(
      "输入卫生：空 kbId / 非法扩展名 / 坏 url / 空文本 响亮拒绝零入队",
      async () => {
        const scope = await scopeOf("a1-member", tenantA, teamA1);
        const enqueuedBefore = enqueued.length;
        await expectSentinelRejection(
          service.uploadDocument(
            { scope },
            { kbId: "", kind: "text", content: "x" },
          ),
          "KB_ID_REQUIRED",
        );
        await expectSentinelRejection(
          service.uploadDocument(
            { scope },
            {
              kbId: kbA1Pub,
              kind: "file",
              fileName: "payload.exe",
              content: new TextEncoder().encode("x"),
            },
          ),
          "KB_DOCUMENT_INPUT_INVALID",
        );
        await expectSentinelRejection(
          service.importDocument(
            { scope },
            { kbId: kbA1Pub, url: "not-a-url" },
          ),
          "KB_DOCUMENT_INPUT_INVALID",
        );
        await expectSentinelRejection(
          service.uploadDocument(
            { scope },
            { kbId: kbA1Pub, kind: "text", content: "" },
          ),
          "KB_DOCUMENT_INPUT_INVALID",
        );
        expect(enqueued.length).toBe(enqueuedBefore);
      },
    );

    itDb("未授权 KB（不存在/他司）上传 → 不可见；零行零入队", async () => {
      const scope = await scopeOf("a1-member", tenantA, teamA1);
      const enqueuedBefore = enqueued.length;
      const absent = await service.uploadDocument(
        { scope },
        {
          kbId: "mt038-absent-kb",
          kind: "text",
          content: "x",
          title: "no-row",
        },
      );
      expect(invisibleShape(absent)).toBe(true);
      const foreign = await service.uploadDocument(
        { scope },
        { kbId: kbB1Grant, kind: "text", content: "x", title: "no-row-2" },
      );
      expect(invisibleShape(foreign)).toBe(true);
      const rows = await fixture.kbDb
        .select()
        .from(knowledges)
        .where(eq(knowledges.title, "no-row"));
      expect(rows.length).toBe(0);
      expect(enqueued.length).toBe(enqueuedBefore);
    });

    itDb(
      "归属不一致 KB 上传 → 确定性 KB_OWNERSHIP_* 拒绝；零写入零入队",
      async () => {
        const scope = await scopeOf("a1-member", tenantA, teamA1);
        const enqueuedBefore = enqueued.length;
        await fixture.bumpRegistrationRevision({
          tenantId: tenantA,
          kbId: kbA1Stale,
          syncKbSide: false,
        });
        const stale = await service.uploadDocument(
          { scope },
          { kbId: kbA1Stale, kind: "text", content: "x", title: "stale-row" },
        );
        expect(stale.ok).toBe(false);
        if (stale.ok || stale.kind !== "ownership-inconsistent") return;
        expect(stale.code).toBe("KB_SYNC_VERSION_STALE");
        await fixture.moveKnowledgeBaseOwnership({
          tenantId: tenantA,
          kbId: kbA1MovedNs,
          toWorkspaceId: teamA2,
          syncKbSide: false,
        });
        const mismatch = await service.uploadDocument(
          { scope },
          {
            kbId: kbA1MovedNs,
            kind: "text",
            content: "x",
            title: "mismatch-row",
          },
        );
        expect(mismatch.ok).toBe(false);
        if (mismatch.ok || mismatch.kind !== "ownership-inconsistent") return;
        expect(mismatch.code).toBe("KB_OWNERSHIP_WORKSPACE_MISMATCH");
        const rows = await fixture.kbDb
          .select()
          .from(knowledges)
          .where(eq(knowledges.tenantId, tenantA));
        expect(
          rows.every(
            (r) => r.title !== "stale-row" && r.title !== "mismatch-row",
          ),
        ).toBe(true);
        expect(enqueued.length).toBe(enqueuedBefore);
        // 复原镜像（本 describe 最后运行，防止污染其他用例）。
        await fixture.syncKbOwnershipState({
          tenantId: tenantA,
          kbId: kbA1Stale,
        });
        await fixture.syncKbOwnershipState({
          tenantId: tenantA,
          kbId: kbA1MovedNs,
        });
      },
    );
  });
});

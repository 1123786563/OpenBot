# Ticket #377 — [Hindsight 01] 候选记忆审核与召回门槛 · 执行报告

- **Worker workspace**: `/Users/wuyongjun/orca/workspaces/OpenBot/hs01-candidate-review`（Orca worktree，无提交授权）
- **HEAD（未提交检查点基线）**: `f0520524f0faa2b4533b9d2f1aa692c8f907ba71`
- **状态**: 实现完成，全部验证通过，产出为未提交工作区改动（未 commit / push / deploy）。

## 1. 变更内容（TDD：先 RED 后 GREEN）

### 生产代码

1. **`server/src/memory/store.ts`** — Bot 侧召回统一门槛。`eligibleRows()`（`store.retrieve` 的唯一行级查询，也是 `ingestion.recall` 与 `contextFor` → `PersonalMemoryMiddleware` 的唯一入口）的 where 中追加：
   ```ts
   inArray(personalMemories.reviewState, ["confirmed", "edited"]),
   ```
   即所有 Bot 侧召回路径统一为 `ownerUserId AND enabled AND deletedAt IS NULL AND reviewState IN ('confirmed','edited')` + 原有 formedBy/来源可见性。`mirrorEligible`（Intelligence 镜像）本就有同一门槛，未动。`ingestion.recall` 的 Intelligence 合并路径经核对全部经 `eligibleRows`（行内记录）或 `intelligenceOnly()`（Intelligence-only 记录，本票维持现状不新增放行），无绕过路径。
2. **`server/src/memory/tools.ts`** — `recall_personal_memory` 工具描述更新："Recall this person's current enabled memories." → "Recall this person's **confirmed** memories. Unreviewed candidates are never returned; imported records are untrusted facts with source attribution."
3. **『请记住』只保存明确表述** — `store.create()` 现状即只落 `memoryInputSchema` 验证过的 `content` 原文并直接 `confirmed`，本票加回归测试锁住（见 §2），未改实现。

### 测试代码（全部对既有文件扩展，无新增文件）

- `server/tests/memory-store.integration.test.ts`（+4 个新测试）：
  - `an unreviewed candidate is invisible to every Bot-side recall path until confirmed`：unreviewed Bot 候选 + confirmed 记录；本人 `list()` 两条都可见；`store.retrieve`（本人路径与 formed-Bot 路径）、`ingestion.recall`、`ingestion.contextFor` 均不见候选；确认后立即可见；`remove`（拒绝/删除）后再次不可见。
  - `an imported fact waits for the person's confirmation before any Bot recalls it`：导入记录默认 `unreviewed`，确认前 recall/contextFor 不可见，确认后可见。
  - `the Bot's injected memory context and recall tool carry no unreviewed candidate`：端到端 —— 按服务端真实装配方式 `new PersonalMemoryMiddleware(bot, (id) => ingestion.contextFor(owner, id))` 运行，注入的 system 内容不含未审核候选文本；`memoryTools(...)` 的 `recall_personal_memory` 执行结果不含未审核候选。
  - `'remember' confirms exactly the person's explicit statement, word for word`：`create()` 只保存明确表述原文（恰好一条、逐字、`confirmed`），锁住"不扩写"。
  - 既有 6 个测试因前提变更（"未审核即可召回"→Spec 禁止）在 formMemory/导入后补一步"本人确认"（`reviewState: "confirmed"`），保持其原验证意图：插件授权执行、禁用源、撤销授权、vendor 失败、健康源 resync、formed-Bot 排序（fixture 显式 `reviewState: "confirmed"`）。
- `server/tests/memory-runtime.test.ts`（+2 个 DB-free 测试）：`remember_personal_fact` 工具只透传明确表述（无效内容拒绝且不落库）；`recall_personal_memory` 只经 `ingestion.recall` 这一个 seam 应答（工具无旁路），描述与门槛一致。
- `server/tests/memory-defaults.integration.test.ts`：isolation 测试在 `completeSync` 后补本人确认，继续验证隔离而非审核门槛。
- `server/tests/proactive-store.integration.test.ts`（**ownership 外，coordinator 已授权**）：`a Bot-formed memory reaches only its Bot...` 前提与 Spec 冲突，formMemory 后补一行本人确认，保留 Bot 归属验证意图。

### 与计划的偏差

计划 Step 1 要求 middleware/工具测试放 `memory-runtime.test.ts`；该文件为 DB-free 设计，而门槛在 store 的 SQL 查询里，middleware 端到端必须走真实 `contextFor`。故端到端断言放在 DB 支撑的 `memory-store.integration.test.ts`（`RecordingAgent` + 真实装配），runtime 文件保留 DB-free 的 seam 契约测试。行为覆盖等价。

## 2. 验证（专用 TEST_DATABASE_URL，skip 不算通过 —— 实际 0 skip）

- 测试库：一次性容器 `openbot-hs01-377-pg`（pgvector/pgvector:pg17，`127.0.0.1:5571/openbot_hs01_377_test`），`ops/enterprise/roles.sql` + `scripts/migrate.ts` 全量迁移，与生产数据无关。
- **RED**（实现前）：`bun test server/tests/memory-store.integration.test.ts server/tests/memory-runtime.test.ts` → `25 pass, 4 fail`，失败恰为 4 个新门槛测试（未审核候选泄漏 / 工具描述）。
- **GREEN**（实现后，同命令）：`29 pass, 0 fail`。
- **回归**：`bun test`（memory-store.integration / memory-runtime / memory / memory-intelligence.integration / memory-shared-source / memory-defaults.integration / memory-default-source-tool / proactive-store.integration / bot-lifecycle.integration）→ **`88 pass, 0 fail, 301 expect() calls, Ran 88 tests across 9 files`**。
- **类型检查**：`cd server && bun run typecheck`（tsc --noEmit）→ 0 错误。
- **Lint**：`bunx biome check`（改动文件）→ 仅 `store.ts` 的 `noConsole`，经 stash 对照确认为 HEAD 上预存在，非本票引入；测试文件格式/导入已由 biome --write 修复。
- 已知无关失败：`server/tests/enterprise/intelligence-contracts.test.ts` 的 `parser rejects maximum sparse arrays promptly` 在未改动的 HEAD 上同样失败（stash 对照验证），与本票无关，未处理。

## 3. 未提交检查点

- HEAD：`f0520524f0faa2b4533b9d2f1aa692c8f907ba71`
- 改动文件与 sha256（工作区态）：

  | 文件 | sha256 |
  |---|---|
  | `server/src/memory/store.ts` | `b8fa6e675b7b3fc6e6682a35232cd5864d00199b2730a2b2a72cc7ee3c97318e` |
  | `server/src/memory/tools.ts` | `7f64a6b10895461e49d46abc528d6bba36df855d3ca2d0014cef2b46cf28dffa` |
  | `server/tests/memory-store.integration.test.ts` | `9a369e8ea79d107b71491264830148bba38a58ea6e97fa3daf1358922a39403e` |
  | `server/tests/memory-runtime.test.ts` | `eb4b78f474af174577ce2e289258697d8d840d0e0c741cad62dc520c864b9abc` |
  | `server/tests/memory-defaults.integration.test.ts` | `dd2d21c4a6691d6ed1a924c3b8578ec92042876e9e5ed506f1a932903363f765` |
  | `server/tests/proactive-store.integration.test.ts` | `4d17689b54048ea9f43d35533990f9c5ffaecd44ee27eb1f04339bf568816fdc` |

- 新增未跟踪测试文件：无（全部为既有文件扩展）。
- `git diff` 全文见 §5。

## 4. 验收标准对照（issue-377 快照）

- 「自动形成或导入的内容先成为候选，显示内容、来源和观察时间」→ `formMemory`/`completeSync` 默认 `unreviewed`，本人 `list()` 可见（新测试断言候选与已确认对本人均可见）；provenance/observedAt 逻辑未动。
- 「未审核候选在原 Bot、其他 Bot、网页、频道、定时任务及本地 SQL 召回中均不可见，也不能作为派生判断依据」→ 所有 Bot 侧路径共用 `eligibleRows` 单一 seam，统一 `reviewState IN ('confirmed','edited')`；本 Bot（formed 路径）、他人 Bot、本地 SQL 降级（无 Intelligence 的表查询）经端到端与集成测试覆盖。"不能作为派生判断依据"的独立断言属 #388 范围（派生判断功能本波不存在），但派生若走同一 recall seam 即天然不可见。
- 「用户明确要求记住普通事实时，只直接确认其明确表述的内容，不扩写额外事实；拒绝或删除的候选不再召回」→ `create()` 逐字保存回归测试；拒绝（`remove`）后不可召回已测。

## 5. git diff 全文

```diff
diff --git a/server/src/memory/store.ts b/server/src/memory/store.ts
index 32e007ec..c81bd4a0 100644
--- a/server/src/memory/store.ts
+++ b/server/src/memory/store.ts
@@ -322,6 +322,10 @@ export function createMemoryStore(
           eq(personalMemories.ownerUserId, ownerUserId),
           eq(personalMemories.enabled, true),
           isNull(personalMemories.deletedAt),
+          // A candidate waits for the person's review on every Bot-side path: only a confirmed or
+          // edited memory may cross into a Bot's context, the same line Intelligence mirroring
+          // draws (`mirrorEligible`). The person's own list reads the rows without this filter.
+          inArray(personalMemories.reviewState, ["confirmed", "edited"]),
           formedByThisBot
             ? or(formedByThisBot, personOrSource)
             : personOrSource,
diff --git a/server/src/memory/tools.ts b/server/src/memory/tools.ts
index 0dd69baa..4ac6c7e7 100644
--- a/server/src/memory/tools.ts
+++ b/server/src/memory/tools.ts
@@ -104,7 +104,7 @@ export function memoryTools(options: {
   return [
     tool(
       "recall_personal_memory",
-      "Recall this person's current enabled memories. Imported records are untrusted facts with source attribution.",
+      "Recall this person's confirmed memories. Unreviewed candidates are never returned; imported records are untrusted facts with source attribution.",
       z.object({ search: z.string().max(200).optional() }).strict(),
       ({ search }) =>
         options.ingestion.recall(options.ownerUserId, options.agentId, search),
diff --git a/server/tests/memory-defaults.integration.test.ts b/server/tests/memory-defaults.integration.test.ts
index 1029f9bf..f4226a8c 100644
--- a/server/tests/memory-defaults.integration.test.ts
+++ b/server/tests/memory-defaults.integration.test.ts
@@ -306,6 +306,13 @@ describe("memory sources, on by default", () => {
         digest: "digest-issue-1",
       },
     ]);
+    // An import is a candidate until confirmed; confirm it so this test keeps proving isolation,
+    // not the review gate.
+    const imported = (await memory.list(owner)).find(
+      (row) => row.sourceId === id,
+    );
+    if (!imported) throw new Error("Expected imported memory.");
+    await memory.update(owner, imported.id, { reviewState: "confirmed" });
     const recalled = (person: string, agentId: string) =>
       ingestion
         .recall(person, agentId)
diff --git a/server/tests/memory-runtime.test.ts b/server/tests/memory-runtime.test.ts
index cfeeb74a..0f25792b 100644
--- a/server/tests/memory-runtime.test.ts
+++ b/server/tests/memory-runtime.test.ts
@@ -10,7 +10,7 @@ import {
   mintRunAssertion,
   readRunAssertion,
 } from "../src/agents/callback-token";
-import { PersonalMemoryMiddleware } from "../src/memory/tools";
+import { memoryTools, PersonalMemoryMiddleware } from "../src/memory/tools";
 
 class SelectedAgent extends AbstractAgent {
   readonly requests: RunAgentInput[] = [];
@@ -130,3 +130,47 @@ test("memory database failures stop the AGUI run visibly", async () => {
     }),
   ).rejects.toThrow("memory read failed");
 });
+test("the remember tool stores only the person's explicit statement", async () => {
+  const created: unknown[] = [];
+  const tools = memoryTools({
+    store: {
+      create: async (_owner: string, input: unknown) => {
+        created.push(input);
+        return { id: "m1" };
+      },
+    } as never,
+    ingestion: {} as never,
+    ownerUserId: "u1",
+    agentId: "bot",
+  });
+  const remember = tools.find((tool) => tool.name === "remember_personal_fact");
+  if (!remember) throw new Error("Expected the remember tool.");
+  await remember.execute({ content: "I prefer morning meetings." });
+  // Nothing the person did not state: no extra facts, no second memory.
+  expect(created).toHaveLength(1);
+  expect((created[0] as { content: string }).content).toBe(
+    "I prefer morning meetings.",
+  );
+  await expect(remember.execute({ content: "" })).resolves.toContain("Refused");
+  expect(created).toHaveLength(1);
+});
+test("the recall tool answers only through the ingestion recall seam", async () => {
+  const asked: { owner: string; bot: string; search: string }[] = [];
+  const tools = memoryTools({
+    store: {} as never,
+    ingestion: {
+      recall: async (ownerUserId: string, agentId: string, search = "") => {
+        asked.push({ owner: ownerUserId, bot: agentId, search });
+        return [];
+      },
+    } as never,
+    ownerUserId: "u1",
+    agentId: "bot",
+  });
+  const tool = tools.find((entry) => entry.name === "recall_personal_memory");
+  if (!tool) throw new Error("Expected the recall tool.");
+  // The review gate lives behind this one seam; the description says what it really returns.
+  expect(tool.description).toContain("confirmed");
+  await tool.execute({ search: "tea" });
+  expect(asked).toEqual([{ owner: "u1", bot: "bot", search: "tea" }]);
+});
diff --git a/server/tests/memory-store.integration.test.ts b/server/tests/memory-store.integration.test.ts
index de733595..21922993 100644
--- a/server/tests/memory-store.integration.test.ts
+++ b/server/tests/memory-store.integration.test.ts
@@ -1,6 +1,13 @@
 import { afterAll, beforeAll, expect, test } from "bun:test";
 import { randomUUID } from "node:crypto";
+import {
+  AbstractAgent,
+  type BaseEvent,
+  EventType,
+  type RunAgentInput,
+} from "@ag-ui/client";
 import { and, eq, inArray } from "drizzle-orm";
+import { lastValueFrom, of, toArray } from "rxjs";
 import { createAuditStore } from "../src/audit";
 import { createCredentialStore } from "../src/credentials";
 import { createDatabase } from "../src/db/client";
@@ -10,6 +17,7 @@ import { memorySources, personalMemories } from "../src/db/schema/memory";
 import { mcpServers, mcpTools } from "../src/db/schema/plugins";
 import { createMemoryIngestion } from "../src/memory/ingestion";
 import { createMemoryStore } from "../src/memory/store";
+import { memoryTools, PersonalMemoryMiddleware } from "../src/memory/tools";
 import { MemoryNotFoundError, MemoryRefusedError } from "../src/memory/types";
 import { createPluginStore } from "../src/plugins/store";
 import { TEST_POOL, testDatabaseUrl } from "./support/database";
@@ -114,6 +122,16 @@ async function source() {
     })
   ).source;
 }
+/** A source whose imported record the person has confirmed, so recall-gated tests still see it. */
+async function confirmedSource() {
+  const value = await source();
+  const fact = (await store.list(owner)).find(
+    (row) => row.sourceId === value.id,
+  );
+  if (!fact) throw new Error("Expected imported memory.");
+  await store.update(owner, fact.id, { reviewState: "confirmed" });
+  return { value, fact };
+}
 test("facts are owner scoped on list, edit and delete", async () => {
   const fact = await store.create(owner, { content: "Private preference" });
   expect((await store.list(other)).some((row) => row.id === fact.id)).toBe(
@@ -147,6 +165,11 @@ test("opted-in connector uses actual plugin authority and execution", async () =
   expect(calls.at(-1)?.actorId).toBe(owner);
   expect(calls.at(-1)?.botId).toBe(bot);
   expect(value.syncStatus).toBe("succeeded");
+  const fact = (await store.list(owner)).find(
+    (row) => row.sourceId === value.id,
+  );
+  if (!fact) throw new Error("Expected imported memory.");
+  await store.update(owner, fact.id, { reviewState: "confirmed" });
   expect(await ingestion.contextFor(owner, bot)).toContain(
     "Project launch is Tuesday",
   );
@@ -170,7 +193,7 @@ test("changed connector content updates the same row without duplicates", async
   expect(rows[0]?.content).toContain("Friday");
 });
 test("disabled source is absent even while its imported facts remain stored", async () => {
-  const value = await source();
+  const { value } = await confirmedSource();
   await store.setSourceEnabled(owner, value.id, false);
   expect(
     (await ingestion.recall(owner, bot)).some(
@@ -223,7 +246,7 @@ test("write tools and another person's Bot cannot become ambient sources", async
   ).rejects.toBeInstanceOf(MemoryRefusedError);
 });
 test("revoked grants immediately remove retrieval and expose source error", async () => {
-  const value = await source();
+  const { value } = await confirmedSource();
   await plugins.revoke("mcp", ref, bot, owner);
   expect(
     (await ingestion.recall(owner, bot)).some(
@@ -236,7 +259,7 @@ test("revoked grants immediately remove retrieval and expose source error", asyn
   await plugins.grant("mcp", ref, bot, owner);
 });
 test("vendor failure hides stale source facts and records a visible error", async () => {
-  const value = await source();
+  const { value } = await confirmedSource();
   vendorError = true;
   await expect(ingestion.sync(owner, value.id)).rejects.toBeInstanceOf(
     MemoryRefusedError,
@@ -274,7 +297,7 @@ test("removing a source deletes its imported records", async () => {
   ).toHaveLength(0);
 });
 test("a resync of a healthy source keeps its facts in recall while it runs", async () => {
-  const value = await source();
+  const { value } = await confirmedSource();
   expect(await store.claimSync(owner, value.id)).not.toBeNull();
   expect(
     (await ingestion.recall(owner, bot)).some(
@@ -304,6 +327,7 @@ test("recall reaches this Bot's memories however many other Bots' are newer", as
     provenance: "Read from Docs",
     formedBy: "bot",
     formedByAgentId: bot,
+    reviewState: "confirmed",
   });
   // Six hundred newer memories formed by another Bot for the same person.
   await database.insert(personalMemories).values(
@@ -356,3 +380,150 @@ test("the same fact formed at once by two runs is stored once", async () => {
   expect(new Set(results.map((result) => result.id)).size).toBe(1);
   expect(results.filter((result) => !result.duplicate)).toHaveLength(1);
 });
+
+test("an unreviewed candidate is invisible to every Bot-side recall path until confirmed", async () => {
+  const candidate = `Unreviewed candidate ${randomUUID()}`;
+  const formed = await store.formMemory(owner, {
+    agentId: bot,
+    content: candidate,
+    sourceApp: "Docs",
+    sourceRef: ref,
+  });
+  const confirmed = await store.create(owner, {
+    content: `Confirmed alongside ${randomUUID()}`,
+  });
+  // The person's candidate list keeps both; review is what separates them.
+  const listed = await store.list(owner);
+  expect(listed.find((row) => row.id === formed.id)?.reviewState).toBe(
+    "unreviewed",
+  );
+  expect(listed.some((row) => row.id === confirmed.id)).toBe(true);
+  // Every Bot-side path (the one store seam under recall and context) hides the candidate.
+  const personPath = await store.retrieve(owner, [], "");
+  expect(personPath.some((row) => row.id === formed.id)).toBe(false);
+  expect(personPath.some((row) => row.id === confirmed.id)).toBe(true);
+  const formedPath = await store.retrieve(owner, [], "", {
+    botId: bot,
+    heldServerIds: new Set([server]),
+  });
+  expect(formedPath.some((row) => row.id === formed.id)).toBe(false);
+  const recalled = await ingestion.recall(owner, bot);
+  expect(recalled.some((row) => row.id === formed.id)).toBe(false);
+  expect(recalled.some((row) => row.id === confirmed.id)).toBe(true);
+  expect(await ingestion.contextFor(owner, bot)).not.toContain(candidate);
+  // Confirmation moves it onto every path at once; rejection removes it again.
+  await store.update(owner, formed.id, { reviewState: "confirmed" });
+  expect(
+    (await ingestion.recall(owner, bot)).some((row) => row.id === formed.id),
+  ).toBe(true);
+  expect(await ingestion.contextFor(owner, bot)).toContain(candidate);
+  await store.remove(owner, formed.id);
+  expect(
+    (await ingestion.recall(owner, bot)).some((row) => row.id === formed.id),
+  ).toBe(false);
+});
+
+test("an imported fact waits for the person's confirmation before any Bot recalls it", async () => {
+  const value = await source();
+  const fact = (await store.list(owner)).find(
+    (row) => row.sourceId === value.id,
+  );
+  if (!fact) throw new Error("Expected imported memory.");
+  expect(fact.reviewState).toBe("unreviewed");
+  expect(
+    (await ingestion.recall(owner, bot)).some((row) => row.id === fact.id),
+  ).toBe(false);
+  expect(await ingestion.contextFor(owner, bot)).not.toContain(
+    "Project launch is Tuesday",
+  );
+  await store.update(owner, fact.id, { reviewState: "confirmed" });
+  expect(
+    (await ingestion.recall(owner, bot)).some((row) => row.id === fact.id),
+  ).toBe(true);
+  expect(await ingestion.contextFor(owner, bot)).toContain(
+    "Project launch is Tuesday",
+  );
+});
+
+class RecordingAgent extends AbstractAgent {
+  readonly requests: RunAgentInput[] = [];
+  run(input: RunAgentInput) {
+    this.requests.push(input);
+    return of<BaseEvent>(
+      {
+        type: EventType.RUN_STARTED,
+        runId: input.runId,
+        threadId: input.threadId,
+      },
+      {
+        type: EventType.RUN_FINISHED,
+        runId: input.runId,
+        threadId: input.threadId,
+      },
+    );
+  }
+}
+
+test("the Bot's injected memory context and recall tool carry no unreviewed candidate", async () => {
+  const candidate = `Middleware candidate ${randomUUID()}`;
+  const formed = await store.formMemory(owner, {
+    agentId: bot,
+    content: candidate,
+    sourceApp: "Docs",
+    sourceRef: ref,
+  });
+  const confirmed = await store.create(owner, {
+    content: `Middleware confirmed ${randomUUID()}`,
+  });
+  // The middleware the server wires to contextFor injects only reviewed memories.
+  const agent = new RecordingAgent({ agentId: bot });
+  await lastValueFrom(
+    new PersonalMemoryMiddleware(bot, (id) => ingestion.contextFor(owner, id))
+      .run(
+        {
+          runId: "run",
+          threadId: "thread",
+          messages: [
+            { id: "user", role: "user", content: "What should I know?" },
+          ],
+          context: [],
+          tools: [],
+          state: { progress: 1 },
+          forwardedProps: {},
+        },
+        agent,
+      )
+      .pipe(toArray()),
+  );
+  const injected =
+    agent.requests[0]?.messages.find(
+      (message) => message.id === "openbot:personal-memory",
+    )?.content ?? "";
+  expect(injected).toContain("Middleware confirmed");
+  expect(injected).not.toContain(candidate);
+  // And so does the recall tool a Bot holds.
+  const tool = memoryTools({
+    store,
+    ingestion,
+    ownerUserId: owner,
+    agentId: bot,
+  }).find((entry) => entry.name === "recall_personal_memory");
+  if (!tool) throw new Error("Expected the recall tool.");
+  const result = JSON.parse(String(await tool.execute({}))) as {
+    id: string;
+  }[];
+  expect(result.some((row) => row.id === formed.id)).toBe(false);
+  expect(result.some((row) => row.id === confirmed.id)).toBe(true);
+});
+
+test("'remember' confirms exactly the person's explicit statement, word for word", async () => {
+  const statement = `I prefer morning meetings on ${randomUUID()}`;
+  const before = await store.list(owner);
+  const memory = await store.create(owner, { content: statement });
+  const after = await store.list(owner);
+  expect(memory.content).toBe(statement);
+  expect(memory.reviewState).toBe("confirmed");
+  // One explicit statement becomes exactly one confirmed memory, never more facts.
+  expect(after.length).toBe(before.length + 1);
+  expect(after.filter((row) => row.content === statement)).toHaveLength(1);
+});
diff --git a/server/tests/proactive-store.integration.test.ts b/server/tests/proactive-store.integration.test.ts
index de3e36f8..52fcc241 100644
--- a/server/tests/proactive-store.integration.test.ts
+++ b/server/tests/proactive-store.integration.test.ts
@@ -340,6 +340,9 @@ test("a Bot-formed memory reaches only its Bot, only while it holds the source a
     sourceApp: "Issue tracker",
     sourceRef: ref,
   });
+  // An unreviewed candidate is invisible even to its own Bot; confirm it so this test keeps
+  // proving Bot-scoping, not the review gate.
+  await memory.update(owner, formed.id, { reviewState: "confirmed" });
   const recalled = async (agentId: string) =>
     (await ingestion.recall(owner, agentId)).some(
       (row) => row.id === formed.id,
```

## 6. 测试输出（末次全量回归）

```
(pass) memory database failures stop the AGUI run visibly [0.16ms]
(pass) the remember tool stores only the person's explicit statement [0.35ms]
(pass) the recall tool answers only through the ingestion recall seam [0.27ms]

server/tests/memory.test.ts:
(pass) memory validates explicit facts and bounded source opt-in [0.32ms]
(pass) confirming a memory keeps where it came from and does not re-enable it [0.07ms]
(pass) a connected app record that is one block of text is kept as that text [0.13ms]
(pass) connector records retain stable identity as their contents change [0.07ms]
(pass) memory context treats imported instructions as attributed untrusted data [0.03ms]
(pass) connector ingestion refuses oversized responses and bounds record count [0.29ms]
(pass) every memory tool can be offered to a remote Bot as JSON Schema [2.55ms]
(pass) a source sync a connector's policy refuses answers 400 with the reason, not 503 [3.13ms]

server/tests/memory-intelligence.integration.test.ts:
(pass) a memory the person writes is stored in Intelligence, under that person only [7.20ms]
(pass) an edit supersedes the Intelligence copy, and pausing or forgetting retires it [28.49ms]
(pass) a Bot-formed memory reaches Intelligence only once the person confirms it [9.15ms]
(pass) not entitled: nothing is sent, the tables are the whole store, and nothing fails [7.83ms]
(pass) unreachable: writes stay local and the next pass backfills them once, without duplicates [8.63ms]
(pass) another person's Intelligence memories never reach this person, nor do project-wide ones [4.89ms]
(pass) recall keeps a Bot-formed memory to the Bot that formed it [9.73ms]
(pass) a memory only Intelligence holds is the person's own: recalled, edited and forgotten here [3.65ms]
(pass) a memory OpenBot describes cannot be forgotten through its Intelligence id [5.93ms]
(pass) editing an Intelligence-only memory while Intelligence is down answers unavailable, not a crash [2.12ms]

 88 pass
 0 fail
 301 expect() calls
Ran 88 tests across 9 files. [2.96s]
```

## 7. RED 阶段输出（实现前，失败恰为 4 个新门槛测试）

```
(fail) an unreviewed candidate is invisible to every Bot-side recall path until confirmed [6.12ms]
(fail) an imported fact waits for the person's confirmation before any Bot recalls it [11.43ms]
(fail) the Bot's injected memory context and recall tool carry no unreviewed candidate [6.14ms]
(fail) the recall tool answers only through the ingestion recall seam [0.27ms]
 25 pass
 4 fail
Ran 29 tests across 2 files.
```

## 8. 复现环境

- 测试库容器：`docker run -d --name openbot-hs01-377-pg -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=openbot_hs01_377_test -p 127.0.0.1:5571:5432 pgvector/pgvector:pg17`（保留运行，供复核；用毕可 `docker rm -f openbot-hs01-377-pg`）
- 初始化：`docker exec -i openbot-hs01-377-pg psql -U postgres -d openbot_hs01_377_test < server/ops/enterprise/roles.sql` 然后 `cd server && DATABASE_URL=postgres://postgres:postgres@localhost:5571/openbot_hs01_377_test bun scripts/migrate.ts` → `{"type":"migrations-applied","status":"ok"}`
- 运行：`TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5571/openbot_hs01_377_test bun test server/tests/memory-store.integration.test.ts ...`

## 9. 遗留

- 无本票遗留。后续波次（#382 语义检索 / #385 降级 / #392 暂停开关）应叠加在本 seam（`eligibleRows`）之上。
- 无关预存在失败：`enterprise/intelligence-contracts.test.ts` "parser rejects maximum sparse arrays promptly"（HEAD 上即失败，未处理）。

## 10. fix1（审阅修正，唯一项）

- **范围**：仅 `server/src/memory/tools.ts:107`，纯文案 —— `recall_personal_memory` 描述 "confirmed memories" → "reviewed (confirmed or edited) memories"，与实际门槛谓词 `reviewState IN ('confirmed','edited')` 对齐。未触碰其他文件，未 commit/push。
- **验证**：
  - `cd server && bun run typecheck` → 0 错误。
  - `bun test server/tests/memory-runtime.test.ts`（DB-free，无需 TEST_DATABASE_URL）→ `9 pass, 0 fail, Ran 9 tests across 1 file`（seam 测试断言 description 含 "confirmed" 仍成立）。
  - `bunx biome check server/src/memory/tools.ts` → 无问题。
- **新 sha256**：`server/src/memory/tools.ts` = `ed281d71f2fd372381a813fe5af538390187c0f7398bccf97bad85c90a4b2bab`（§3 中旧值 `7f64a6b…` 作废）。
- **HEAD**：仍为 `f0520524f0faa2b4533b9d2f1aa692c8f907ba71`（未提交）。
```
fix1 diff（相对 §5 中 tools.ts 的一行）：
-      "Recall this person's confirmed memories. Unreviewed candidates are never returned; imported records are untrusted facts with source attribution.",
+      "Recall this person's reviewed (confirmed or edited) memories. Unreviewed candidates are never returned; imported records are untrusted facts with source attribution.",
```

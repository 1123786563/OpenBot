# MT037 / Issue #80 独立复审报告 —— 检索在候选、重排与进入模型之前限制范围

- 复审者：独立 Pi Reviewer（全新会话，未参与实现；Orca Task `task_4fb622d5d249`）。
- 日期：2026-10-20。复审树：`orca/workspaces/OpenBot/i12-review-mt037`，BASE `f0520524`（`git log` 实测一致）+ 213 项前置 + 本票交付，全部未提交态（符合票面无提交纪律）。
- 输入：review brief `briefs/MT037-review-brief.md` + `gh issue view 80` 实取（四条验收 + 票注「检索后过滤不算隔离；测试必须断言候选集合本身」）+ 实现报告 `reports/MT037.md` + `checkpoints/MT037/` 全部存档。
- **结论：PASS with findings（2 low；无 critical/high/medium）。** 四条验收的真实机制与断言形态均独立复现成立；全部门槛数字亲测与票面/实现声明逐项一致；2 个 low finding 不影响任何验收，交 coordinator 裁定是否择机处理。

---

## 1. 复审环境（复审者自建，独立于实现者环境）

- `bun install --frozen-lockfile` → 1415 packages，exit 0。
- 端口预检：55536 空闲（`lsof` 无输出）；专用容器 **`mt037-review-pg`**（`pgvector/pgvector:pg16`，PostgreSQL 16.15 实测，`-p 127.0.0.1:55536:5432` 仅回环 + 随机口令）。
- 三库：`openbot_enterprise_mt037r_test` + `_assigned`（MT003 用例）+ `openbot_kb_mt037r_test`（专用受限登录 `ent_mt037r_kb` NOSUPERUSER NOBYPASSRLS 属主通道跑 drizzle-kb 迁移，属主关系 psql 实查）。
- 七变量 env 仅存 0600 临时文件（TEST_DATABASE_URL / MT003_ASSIGNED / ENTERPRISE_TEST_SETUP（postgres 超户）/ DIRECTORY / DATA / OPERATOR（`ent_mt037r_*` 受限角色）/ KB_TEST_DATABASE_URL），复审后已删除。
- `bun --no-env-file scripts/enterprise-test-db.ts migrate` → `{"type":"migrations-applied","status":"ok"}`；十四任务链 MT004→MT008→MT112→MT012→MT014→MT010→MT009→MT077→MT026→MT076→MT069→MT016→MT041→MT027 逐任务 `generate --out`（/tmp）+ `--apply --manifest` 全部落账（主库 journal distinct task_id = **14**，psql 实查；KB 库 drizzle journal = 2 条）。
- 全程 `--no-env-file`，无开发库回退；本复审产物只落 /tmp（migration 产物、pristine 副本），**复审树内唯一新建 = 本报告**。

## 2. 复审门槛逐项（全部亲测，不采信存档）

| # | 门槛 | 复审实测 | 判定 |
| --- | --- | --- | --- |
| 1 | 前置 213 项零漂移 | `sha256sum -c prereq-manifest.txt`：**213 OK / 0 DRIFT**（开工前 + 全部变异重放结束后复扫两次均 0） | ✅ |
| 2 | 交付 3 文件哈希 == after-hashes | `8d177507…` / `fc9b0a37…` / `8ad90b67…` 逐项一致（变异后与收尾再验共 4 次） | ✅ |
| 3 | 冻结面零改动 | `kb-restricted-query.ts` = `5cc994ba…`、`kb-ownership.ts` = `fd0e4627…`（== MT036 冻结值，首验+变异后复验）；migrate-test.ts / migration-tool.test.ts / src/index.ts 均在 213 manifest 内零漂移 | ✅ |
| 4 | 聚焦套件全绿 0 skip | `bun --no-env-file test tests/multitenancy/retrieval-restriction.test.ts --timeout 120000` → **20 pass / 0 fail / 0 skip / 140 expect**，exit 0 | ✅ |
| 5 | 全量回归 | reset 库后 `bun --no-env-file test tests/multitenancy/ --timeout 60000` → **790 pass / 0 fail / 30 文件 / 10798 expect**，exit 0（≈32s） | ✅ |
| 6 | 基线差值（复审追加项） | 临时移出交付 3 文件 + reset 库 → 全量 **770 pass / 0 fail / 29 文件** exit 0（== brief 基线）；还原后哈希逐字节复验一致 → **+20 用例 / +1 文件的差值完全由本票交付贡献** | ✅ |
| 7 | typecheck | `cd server && bun run typecheck` → exit 0 | ✅ |
| 8 | biome（触及 3 文件） | `bunx biome check` 3 文件 → 0 error 0 warning，exit 0；存量 `src/index.ts` 欠账不在本票触及面（4×noConsole+1×noNonNullAssertion 为 BASE 欠账，未复核入本票） | ✅ |
| 9 | 活库抽查 | 见 §4 | ✅ |
| 10 | 变异重放 ≥3 | 实重放 **5** 项，见 §3 | ✅ |
| 11 | 清理 | `docker rm -f mt037-review-pg` 回显 `mt037-review-pg`；拆除后 `docker ps -a` 计数 **0**、端口 55536 无监听；env/口令/临时目录（pristine、stash、migration 产物）删除后 `ls /tmp/mt037-review*` 确认不存在 | ✅ |

## 3. 变异重放（5 项亲测 > 门槛 3；外科手术式注入 → 聚焦 → 还原 → 哈希复验）

| 重放 | 注入 | 实测 | 与实现声明 | 语义 |
| --- | --- | --- | --- | --- |
| R-MUT-A | 候选收窄旁路（请求 kbIds 直进检索端） | **11 pass / 9 fail** | 一致（9 fail） | 隔离主机制被捕获：候选断言/命名空间/canary 全家失败 |
| R-MUT-B | 空候选 early-return 移除 | **19 / 1 fail** | 一致（1 fail） | 检索端零调用计数被捕获 |
| R-MUT-Ca | 仅本入口信任门移除 | **20 / 0 fail（存活）** | 一致 | MT036 双门冗余兜住单门移除 |
| R-MUT-C-full | 入口 + MT036 查询入口 + MT036 权威三信任门同移 | **19 / 1 fail**，失败用例实名为「伪造 scope（非 seam 签发）拒绝」（`UNVERIFIED_SCOPE` 哨兵） | 一致 | 三门同移即被捕获——信任门冗余结构（D4）成立 |
| R-MUT-D | 纵深防御过滤移除（组装后候选过滤） | **20 / 0 fail（存活）** | 一致 | 「检索后过滤」确非隔离主机制（票注口径的诚实验证）；隔离由候选收窄 + 检索端 wire 限制结构成立 |

每次注入→聚焦→还原后 sha256 复验 == 冻结值（含两个 MT036 冻结交付）；终局 RESTORE-green **20 pass / 0 fail**。无未披露存活；两个存活均为刻意冗余防线/非主机制验证，与实现报告 D2/D4 披露一致。

## 4. 活库抽查（psql 直查，与本票相关面）

- 角色矩阵：`ent_mt037r_{dir,data,oper}` 各**恰好**隶属一个 `ob_ent_*` capability 角色，无第二成员、NOSUPERUSER / NOBYPASSRLS 实查为 `f|f`；`ent_mt037r_kb` 独立受限登录。
- 主库：47 张表启用 RLS（174 张 public 表）、122 条策略（十四任务链落库结果）。
- KB 库：`openbot_kb_mt037r_test` 及 `knowledges` / `chunks` / `knowledge_bases` / `knowledge_base_ownership_states` 属主均为 `ent_mt037r_kb`；`kb_ownership_state_shape` CHECK = tenant_id/workspace_id/sync_version 非空（与 MT036 交付声明一致）。
- 本票主库零迁移声明与活库一致（无新表新列；复用既有对象）。

## 5. Brief 专项审计点逐项

1. **候选集合先行断言（真实、引擎边界）**：`support/retrieval-restriction.ts` 的内存向量库在每次 `queryPoints` **先捕获 `(collection, body)` 再过滤**（`calls.push` 在匹配逻辑之前，探针不可能被过滤语义绕过）；测试断言 `kb_id.match.any` **逐字节等于** `candidateKbIds`（含首现顺序）且 `tenant_id.match.value` == 服务端 scope 租户（非客户端输入）。AC1/AC2 的 wire 层断言成立。
2. **空候选=检索端零调用**：`embedder.embedCalls()` / `store.calls.length` / `reranker.documentsPerCall.length` 三端计数在「全未授权请求」与「公司全域 Key」两用例均断言为 0，聚焦亲测通过。
3. **MUT-Ca/MUT-D 存活语义**：见 §3——单门移除被余门兜住、三门同移捕获（失败面为伪造 scope 用例）、D 存活证明检索后过滤非主机制。实现披露与实测完全一致。
4. **D5 环境特性**：MT069 固定幂等键同库单次性属实（设计使然）。复审两次全量前均重建主库（新容器首跑 + 显式 drop/recreate 链重放），满足口径；未遇锁竞争瞬态（两次全量均 0 fail 干净通过）。
5. **snippet rune 截断（AC3）**：冻结投影用例实测钉死「rune 有界前缀」性质（64 rune 场景 `snippet.length===64` + 前缀性 + 非正数响亮拒绝）；**但 `DEFAULT_CITATION_SNIPPET_RUNES` 仅断言 `>0`，未钉死 `===280`** → finding L2。
6. **两冻结文件**：`5cc994ba…` / `fd0e4627…` 首验与变异后复验均逐字节一致（§2 门槛 3）。

## 6. 验收逐条判定（独立读码 + 亲测运行）

- **AC1**（无权文档不进结果、不参与重排）：候选集合在引擎 wire 层逐字节断言 + 重排器文本捕获 canary 零出现 + 正向标记在场。**成立**。
- **AC2**（向量命名空间按归属隔离；跨范围返回空）：wire 层 filter 结构断言（tenant_id match + kb_id any ⊆ 候选 + enabled=true）+ 跨团队/跨公司/禁用块反例 + 空候选三端零调用。实现口径为 A8 单 collection 下「命名空间 = payload filter 的授权投影」（D7 披露，与现架构一致，物理命名空间不预接死代码）。**成立**。
- **AC3**（引用只含有权文档、不泄露片段）：citations 与受限结果行 1:1、全响应 canary 扫描（四 canary 零出现）、相邻扩展钉死同文档链内一跳、stale 库不进候选/引用、snippet 有界前缀。**成立**（常量精确值见 L2）。
- **AC4**（公司范围 Key 不当团队授权）：内部 Identity 形状结构拒绝 `KB_REQUESTER_INVALID` 且三端零调用、kbScope 白名单不被读取（源码级剥注释断言）、伪造 scope `UNVERIFIED_SCOPE`、company-admin 真实 seam 即 `WORKSPACE_FORBIDDEN`、正向对照在场。**成立**。

## 7. Findings

- **L1（low，旁证数字口径）**：KB 域旁证亲测为 **318 pass / 11 skip / 0 fail（329 tests / 26 文件）**，与实现存档 `05-kb-domain.txt`（310/21/331）不一致；两侧均 0 fail。差异源为运行时服务可达性门控（`ensureCollection` ×4、`roundtrip` ×7 两套 live-Qdrant gated 套件在复审时不可达而 skip；`document-process` guard 8 用例因专用 KB 库在场所亲测通过），实现存档仅存汇总数字、无用例清单，331 vs 329 的 2 用例注册差无法从存档精确对账。该旁证不在 brief 复审门槛清单内、且本票零既有 kb 文件改动（213 manifest 零漂移佐证），建议以复审 0-fail 实测为准，不构成缺口。
- **L2（low，AC3 冻结常量）**：`DEFAULT_CITATION_SNIPPET_RUNES=280` 的「冻结断言」实测为「有界前缀性质冻结 + 常量 `>0`」，未钉死精确值 280；常量若上调，测试仍绿（泄漏面不受影响——snippet 源头已是授权结果行，仅引用长度契约漂移）。建议后续在测试中补 `toBe(280)` 一行（属实现侧一行改动，交 coordinator 裁定，本复审未动被审文件）。

无 critical / high / medium findings。未发现虚假声称：实现报告所有门槛数字（770 基线 / 20 聚焦 / 790 全量 / 140 expect / typecheck / biome / 变异捕获面 / 冻结哈希）均独立复现一致；容器与凭据纪律真实执行。

## 8. 复审清理证据

```
$ docker rm -f mt037-review-pg → "mt037-review-pg"（exit 0）
$ docker ps -a --filter name=mt037-review-pg → 0 个
$ lsof -i :55536 → 无监听
/tmp/mt037-review-env.sh、/tmp/mt037-review-pw.txt、/tmp/mt037-review-{pristine,stash,migration} → 已删除，复查不存在
收尾树完整性：交付 3 文件 + 2 冻结文件 sha256 == 冻结值（5/5）
```

## 9. 结论

**PASS with findings（L1、L2，均 low）。** Issue #80 四条验收由真实机制（候选收窄 → 检索端 wire 限制 → 重排输入即受限结果行 → 引用有界投影）结构性满足，测试断言形态符合票注「必须断言候选集合本身」；全部复审门槛亲测通过且与声明逐项一致；变异重放 5 项（含 2 项存活的诚实语义）与披露吻合；边界零越权（交付恰为 3 新文件、冻结面零字节改动、213 项前置零漂移）。两项 low finding 不阻塞，交 coordinator 裁定。

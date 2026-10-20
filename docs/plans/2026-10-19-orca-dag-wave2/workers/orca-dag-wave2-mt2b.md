# orca-dag-wave2 · mt2b 执行报告

- 分支/工作树：`1123786563/mt2b`（从 main@e875a1e1 新建），零 commit 零 push（约束遵守）。
- 票：#78（MT035）、#82（MT039）、#83（MT040）、#111（MT068），全部 `server/tests/multitenancy/` 线、ADR-0004 风格验收、真实 PostgreSQL RLS。
- 模式：参照 mt-w1@b7832879 的 MT019 三件套（实现 + 测试 + 票专属 support），消费既有 tenancy 出口（connections/store/not-found-semantics/scope-gate、MT016/MT008/MT006 fixture），每票新增 expand-only 迁移任务。

## 测试环境（容器 orca-w2-mt2b-pg @127.0.0.1:5566，pgvector/pg16）

- 任务给定 `TEST_DATABASE_URL=…/mt2b` 与 enterprise 套件的 `openbot_enterprise_*` 库名校验冲突（`server/tests/support/enterprise-database.ts` 强制前缀），故实际库名取 `openbot_enterprise_mt2b`（同容器同端口，已披露）。
- 制备配方（可复跑，脚本 /tmp/mt2b-provision.sh）：空库 → `enterprise-test-db.ts migrate`（base 迁移 + 受限角色登录）→ **drop 0163 漂移表**（#436 恢复的 37 表 + enterprise_resources.visibility，与套件"自 apply 任务链"假设冲突——CI 的 mt 库为空库，本地 base 迁移含这些表必须剥离）→ 25 任务链 generate+apply（MT004…MT060→MT034→MT074→MT067）+ 本轮四票任务 MT035/MT039/MT040/MT068。
- 七变量 env（/tmp/mt2b-env.sh，0600，用后未删可复用）：setup/directory/data/operator + assigned + KB。

## 逐票结论

### #78 · MT035 Host Access、签入帮助与危险动作审批 — **SATISFIED**

- 实现：`server/src/enterprise/tenancy/host-access.ts`（7 方法：list-grants / grant / revoke / check-in-help / request-dangerous-action / decide / execute）；表 `enterprise_host_access_grants` + `enterprise_host_action_approvals`（迁移任务 MT035，expand-only）。
- 验收：AC1 签入帮助仅授权主体（同团队他人 HOST_ACCESS_FORBIDDEN、跨团队/跨公司 canonical not-found 且与不存在同形）；AC2 危险动作（write_file/run_command 闭集）必须归属+摘要匹配的 approved 审批行（切团队执行 not-found、参数漂移 APPROVAL_REQUIRED、他人决定 FORBIDDEN、归属键参数响亮拒绝）；AC4 真实 suspendMembership 后 check-in-help 与危险执行均 not-found。
- 测试：`bun test ./tests/multitenancy/host-access.test.ts` → **6 pass / 0 fail（exit 0）**（cwd=server）。
- AC3 回归（提问/恢复/原生确认）：bun 层 `approvals-interactive.integration` + `approvals-question-resume.integration` + `approvals-policy.integration` + `approvals-store.integration` → **23 pass / 0 fail（exit 0）**；native 层（ADR 0008 两层制，`bunx e2e run --config e2e.unit.config.ts`）`approvals-questions` + `approvals-native` + `approvals-execute` + `approvals-policy` → **38 passed（exit 0）**。注：questions/native/execute/policy/frontend 直接 `bun test` 会因 `node:module registerHooks`（Bun 运行时缺失）加载失败——这是 ADR 0008 已知的两层制分界，非本票改动引入。

### #82 · MT039 个人记忆与来源选择保持个人权限 — **SATISFIED**

- 实现：`server/src/enterprise/tenancy/personal-memory.ts`（writeMemory/searchMemories/listMemorySources/resolveMemoriesForPublicBot + memoryCacheKey 纯函数）；表 `enterprise_personal_memories`（RLS data 四动作全部 tenant+principal 双 pin——同团队他人连行都不可见）。
- 验收：AC1 同团队他人以同键/同内容/同 id 搜索全部空页（与"没有记忆"不可区分）；AC2 来源选择 = 显式 grant（MT010）∨ 团队公共 + 有效成员（MT008），无授权/他团队/跨公司资源不进列表；AC3 缓存键含 tenant+workspace+principal 三段（可核验明文段，非哈希黑盒）；AC4 公共 Bot 解析只按使用者本人权限，创建者记忆不出现，创建者键参数 ATTRIBUTION_NOT_CLIENT_DECLARABLE。
- 测试：`bun test ./tests/multitenancy/personal-memory.test.ts` → **4 pass / 0 fail（exit 0）**。

### #83 · MT040 学习容器、研究与演示记录隔离 — **SATISFIED**

- 实现：`server/src/enterprise/tenancy/learning-demonstrations.ts`（allocateContainer/releaseContainer/recordResearch/recordDemonstration/listRecords + learningNamespace 纯函数）；表 `enterprise_learning_containers`（namespace 形状 CHECK `^mt040-ns-[0-9a-f]{32}$`）+ `enterprise_learning_records`。
- 验收：AC1 回收后新分配必是新行（新 id），已释放容器上写记录与跨公司引用均 not-found；AC2 研究与演示记录仅本团队可见（跨团队/跨公司空页）；AC3 namespace 只由归属键派生（带 secret/password/token 字样的调用输入进不了 namespace，纯函数 + DB CHECK 双钉）；AC4 真实撤权后 allocate/record 下一动作 not-found。
- 测试：`bun test ./tests/multitenancy/learning-demonstrations.test.ts` → **4 pass / 0 fail（exit 0）**。
- 披露：真实外部学习服务联调未验证（票面备注允许本地确定性测试 + 标记该能力未验证）。

### #111 · MT068 清理、保留与恢复带可核验归属与不可伪造 manifest — **SATISFIED**

- 实现：`server/src/enterprise/tenancy/purge-restore.ts`（buildPurgeManifest/executePurge/restoreFromManifest/listAudit + signPurgeManifest/deriveIdempotencyKey 纯函数，HMAC-SHA256 密钥装配注入）；表 `enterprise_purge_manifests` + `enterprise_purge_audit`；另按 MT067 先例给 `enterprise_resources` 补列级 `UPDATE(status, revision)` 授权（走既有 operator UPDATE 行策略，逐资源 pin 作业）。
- 验收：AC1 manifest 只由服务端生成签名，调用参数出现 itemRefs/signature 一律 MANIFEST_NOT_CLIENT_DECLARABLE；AC2 清理只触及清单内 (tenant, workspace, id) 项（逐资源 RLS pin），跨公司资源原样、B 公司自己的清单不碰 A 资源；AC3 restore 只回 manifest 记录的原归属（他团队调用者 not-found，重复 restore 收敛 0 项）；AC4 审计只追加（sealed/executed/restored），已执行 manifest 重跑 allow(already) 幂等，撤权后发起 not-found。
- 测试：`bun test ./tests/multitenancy/purge-restore.test.ts` → **4 pass / 0 fail（exit 0）**。

## 回归与静态检查

- `bun test ./tests/multitenancy/`（cwd=server，51 文件）：**1204 pass / 3 fail**。3 个失败全部为本轮开始前的 main 既有失败（billing-visibility MT073 support 未跟上 insertOrder ownerPayerRef 新合同 ×1；team-public-rules issue #52 knowledge dependency 判定 ×2），与本轮改动无关（改动前基线同形）。MT041 时钟 flaky（容器/主机 3ms 漂移）复跑即绿；MT028 结构断言需 cwd=server（驱动层默认满足）。
- `bun test ./tests/multitenancy/migration-tool.test.ts`：42 pass / 0 fail（allowlist 已同步四 ID：MT034<MT035<MT039<MT040<MT041、MT067<MT068<MT069）。
- 覆盖审计 `bun scripts/e2e-coverage-audit.mjs`：**exit 0，无缺口**（4 个新测试文件已入 `docs/verification/e2e-bun-suites.json` 驱动清单，8 行纯追加）。
- typecheck（`bun run typecheck`，cwd=server）：本轮触及文件 **0 错误**；剩余 3 错全在未触及的 `scripts/bootstrap-local-gateway.ts`（main 既有，见 memory verify-bfrest 记录的 gateway 漂移）。
- biome check 19 个触及文件：**0 error**（--write 修了 import 排序/无用转义/未用变量；去转义不改字符串值，迁移 digest 不变，套件复跑证明）。

## 改动 sha256（20 文件：12 新增 + 4 窄缝修改 + 4 驱动清单）

```
bc70945122350bb87152bec02cabe661e99a60925ba92897a03535668bddbabc  docs/verification/e2e-bun-suites.json
c1e6ddf6f8ffed791eb7cfd63d612219d75d848ea27ccf08c2e3f5a56e7b27d5  server/scripts/multitenancy/migrate-test.ts
90188065cbb1b340ea54ce5b7194e7c4cc833ff47b145444df73ba5589968afc  server/src/db/schema/enterprise-host-access.ts
9572abc8cf7f59f76dc1bb50274ddf4b4241cdcf69743bfdebe7eeeb367ae0ab  server/src/db/schema/enterprise-learning.ts
f678c77183e27c16c3cfa7c152c81618c867833f85186201c82d72cf87f66f23  server/src/db/schema/enterprise-personal-memory.ts
08a17d89a261c519eb099a840e671b31fb50f339754096c7420357db946c17d8  server/src/db/schema/enterprise-purge-restore.ts
4114c7f41caeb6e2c5fa8730311cc3d7c65c240e5f8f1b0436d3a6023affe073  server/src/db/schema/index.ts
ccb8674e9048f6d3135342bc72c87bfcd0b94e127f3588ed2334feca1baddcc7  server/src/enterprise/tenancy/host-access.ts
7139383d49e030c5095216c4e1e5020332267aef3a68e91207fac6d96a867cf3  server/src/enterprise/tenancy/learning-demonstrations.ts
01d399cbbb332fde9ca74da17844008be0e8775a20d23cd361e5c02d07f1403c  server/src/enterprise/tenancy/personal-memory.ts
be182744e68f51da1ac3cac72928cfa9043091cca0e5ebd1b7d3652daaa53090  server/src/enterprise/tenancy/purge-restore.ts
908a48d703555c148b77472c08eb1d3dd3a0288b1b487ec0219734da5ec1d992  server/tests/multitenancy/host-access.test.ts
f4a5b7e93392343860e14722984ccf7a255717b17483c88965a1eba26880653f  server/tests/multitenancy/learning-demonstrations.test.ts
caf8e246394b524f7c80b266b6e57834cbdee5bf221df84e42b64cac3feba61e  server/tests/multitenancy/migration-tool.test.ts
14f15bde863db5a7c78c018bca587b19090e564c2d4225b87f0b770ec2ef49e8  server/tests/multitenancy/personal-memory.test.ts
3b0d8017a4b35e8615bb969fefc2281388503645ec4aba2245a6feb2af76b3a4  server/tests/multitenancy/purge-restore.test.ts
4ccc24a792cc4fa72e397b5b3ec2cfcf1cc2233758af0c2f8a4b59253374e0c5  server/tests/multitenancy/support/host-access.ts
320ffb6821fde0ca2f0d9896bb9b592044161ac5fb595951f651ec6318fe3b13  server/tests/multitenancy/support/learning-demonstrations.ts
a171887e8b6fc0fb39de25ec620c66cd84763c1cba02ddd8f627fd3d17d38ad4  server/tests/multitenancy/support/personal-memory.ts
e9f25871419b69208939b59853c1a333ac95ad1ca8c45301a99c2d50993555b1  server/tests/multitenancy/support/purge-restore.ts
```

窄缝披露：`schema/index.ts`（4 行 export）、`migrate-test.ts`（四任务 + TASKS 注册 + MT068 内一条列级 GRANT）、`migration-tool.test.ts`（allowlist 四 ID + 注释）、`e2e-bun-suites.json`（4 文件入册 8 行）。未改公共 support helper、CONTEXT.md、ADR 正文；未与 #63-#76 范围重叠。

## 遗留（非本轮范围）

- main 既有 3 个 multitenancy 失败（上述）与 bootstrap-local-gateway typecheck 3 错：属其它票线，建议后续修复票处理。
- 事故记录：一次 python 脚本误写把 `migrate-test.ts` 覆盖为单行，立即 `git checkout --` 恢复后以片段拼接方式重打，最终以 42/42 migration-tool 测试 + 四票套件全绿证明重建无损。

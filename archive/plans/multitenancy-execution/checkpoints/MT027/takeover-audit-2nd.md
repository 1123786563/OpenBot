# MT027 接管审计（第 2 任，takeover-audit-2nd）

- 第 2 任：backend_implementer（Pi，Orca task_442c98c38e8c / dispatch ctx_8bcc629b448c）
- 前任：task_f6f9948a2f78 / dispatch ctx_502a08e5b331（死于验证收尾阶段，终端计数器冻结）
- BASE：f0520524f0faa2b4533b9d2f1aa692c8f907ba71（两任一致）
- 审计时间：2026-10-16T20:00Z–21:05Z；规则同 MT016-2nd 先例：逐文件审计既有增量，
  三分记录（保留合规 / 修复缺口 / 取舍），第 1 任证据保留不删，第 2 任证据一律 -2nd 后缀。

## 1. 逐文件审计结论

| 文件 | 行数/状态 | 三分 | 结论 |
| --- | --- | --- | --- |
| `server/src/db/schema/enterprise-credentials.ts` | 273 行（新） | 保留合规 | 三表定义与 MT027 迁移一一对应；行形 CHECK、复合 FK 内嵌 tenant_id、display 闭形 CHECK、FORCE RLS（经 pgPolicy + enableRLS，真实生效由 catalog 探针测试钉死）。jsonbDocument customType 规避 Bun SQL 双重编码，红绿记录在案。零改动采纳。 |
| `server/src/enterprise/tenancy/credential-ownership.ts` | 853 行（新） | 保留合规 | 判定核心 decideCredential 纯函数可靶向；deny 全路径收敛 canonical `notFoundVerdict()`；allow 变体独占携带 envelope（deny 无可执行物）；disclose 同事务写审计、vault 失败响亮拒绝；listVisible/describe 走 visibleCredential（可见性宽于可用性）；零 console、零 process.env。审计发现 biome 未过（见修复缺口 ②）外的逻辑缺口：无。零改动采纳。 |
| `server/tests/multitenancy/credentials-ownership.test.ts` | 1375 行（新） | 保留合规 | 5 组（AC1-AC4 + 存储契约）38 测试；缺 env 显式 skip 带理由、绝不回退开发库；供应商探针只在 allow 分支计数；canary 全路径扫描；catalog 探针 superuser 只读。第 1 任 GREEN-2（37 测试）之后又追加了 1 个测试（时间线 03:46:23Z），MUT-1.log 已按 38 测试运行——以 38 为最终口径。零改动采纳。 |
| `server/tests/multitenancy/support/credentials-ownership.ts` | 527 行（新） | 修复缺口 ② | MemoryVault 信封逐字含明文（canary 有牙）、vendorProbe、catalog 探针、超户 arrangement 均合规；唯一缺口：一处 biome format 违规（见下）。修复后采纳。 |
| `server/src/db/schema/index.ts` | barrel 追加 1 行 | 保留合规 | `export * from "./enterprise-credentials"` 落在 enterprise-conversations 与 enterprise-expert-versions 之间，排序位正确（授权扩展点：排序位追加）。 |
| `server/scripts/multitenancy/migrate-test.ts` | 追加 MT027 任务 | 保留合规 | CREDENTIAL_OWNERSHIP_TASK 两步（11+25 语句）纯追加，TASKS Map 注册，planDigest=ab50bf11…。 |
| `server/tests/multitenancy/migration-tool.test.ts` | 追加 1 断言 | 保留合规 | 仅 allowlist 数组追加 "MT027" + ruling #5 第 12 次裁决注释（brief 预授权口径），其余只读。 |
| `server/src/index.ts` | 装配段追加 | 保留合规 | import 块 + `credentialOwnership` 装配（decisions=data 通道；admin=operator 通道缺即 null fail-closed；vault 接 credentials.ts AES envelope）。MT010 personalShareRules 同款纪律，纯追加。 |
| `checkpoints/MT027/`（第 1 任） | plan/before-hashes/red-green×3/mutation×8/verification×7 | 保留 | 全部原样保留（含 05-biome-first.txt、05-biome-final.txt），未删未改。 |
| 第 1 任 `reports/MT027.md`、sha256-manifest | 缺失 | 补齐 | 由第 2 任补建（reports/MT027.md + sha256-manifest-2nd.txt）。 |

## 2. 修复缺口（第 2 任实改）

1. **`tests/multitenancy/support/credentials-ownership.ts` 一处 biome format 违规**
   （`setCompanyMembershipStatusWithoutEpochBump` 签名超长行）。第 1 任
   05-biome-final.txt（03:43:44Z，Checked 8 files，Found 4 errors 全在 index.ts）
   之后，support 文件仍被改过（逻辑推断：测试文件 03:46:23Z 最后修改与 support
   同期收尾；第 2 任在 20:45Z 实测该文件存在 format 违规，而第 1 任 final 存档
   只有 4 个 index.ts 错误——说明违规产生于其 final 复跑之后，未再复跑 biome）。
   正是 brief 预警的“存档过期”模式。第 2 任修复（纯换行，零语义），
   修复后聚焦/全量/typecheck/biome 全部复跑存档。

## 3. 取舍与证据链裁决

- **第 1 任 mutation 证据 MUT-2..8 不对准最终测试文件**（落盘 03:44:17-30Z 早于
  测试文件最后修改 03:46:23Z；且 log 内计数为 37 测试，最终态 38）。裁决：第 1 任
  log 保留作历史，第 2 任全部 8 个变异对最终态重杀（MUT-1..8-2nd.log，8/8 killed，
  见 mutation/MANIFEST-2nd.md）。
- **第 1 任 verification 存档与第 2 任实测全部对上**：基线 638/0/25 文件一致；
  第 1 任全量 675（37 测试口径）vs 第 2 任 676（38 测试口径，+1 自洽）；
  typecheck 0 一致；biome 残留 5 处存量（4 noConsole + 1 noNonNull）与 BASE
  逐一对应一致。第 1 任存档可信，死因（验证收尾长操作）与缺 reports/manifest
  的描述吻合——它死在最后一公里。
- **容器**：第 1 任容器 mt027-impl-pg（55514）保留不动；第 2 任容器
  mt027-impl2-pg（55522，预检空闲）独立搭建，logins ent_mt0272_*（与第 1 任
  ent_mt027_* 不同名，避免集群角色重置冲突）。
- **本票对既有票件文件只读消费**：resource-policy / personal-share-rules /
  not-found-semantics / scope-gate / store（assertTrustedScope）等均未改动
  （prereq 哈希口径内，工作树未触碰）。

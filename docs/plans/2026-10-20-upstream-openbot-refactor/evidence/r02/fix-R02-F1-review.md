# Fix R02-F1 独立 Review（reviewer：只读复审，2026-10-20）

- 审查对象：`server/src/plugins/store.ts` installSkill 保存校验（import `researchRoleOf` @ :53 + filter @ :5058–5067）+ `server/tests/plugin-store.integration.test.ts` 新 describe（6 用例）。
- 材料核对：`fix-R02-F1-brief.md`、`implementer-report.md` R02-F1 段、ledger §7 Ruling R02-F1，均与实现一致；当前 tracked diff 与 `after-tracked.diff`（23:53 捕获）逐字节一致（核对 exit 0），无捕获后漂移。
- 独立复跑（凭证未打印，DB 为 `openbot_r02_test` @127.0.0.1:5435，215 表齐全）：

| 项 | 我的命令 | 我的结果 |
|---|---|---|
| F1 describe | `bun test ./server/tests/plugin-store.integration.test.ts -t "research role refs on the skill save path"` | **6 pass / 0 fail / 13 expect**（与报告逐位一致） |
| 全文件回归 | 同文件不带 -t | **147 pass / 0 fail / 504 expect** |
| selection | `E2E_UNIT_SCOPE=server bunx e2e run --config e2e.unit.config.ts server/tests/plugin-selection.test.ts` | **25 passed / 0 fail** |
| DB 残留 | 查 `skill_role_%` / `skillref_%` 于 skills、skill_tools、mcp_tools、mcp_servers | **四表均 0**（我自己跑完后的独立验证，非引用报告） |
| typecheck | `bun run --filter server typecheck` | 仅 3 条 `scripts/bootstrap-local-gateway.ts:106/108/120` TS2339——BASE 既有红，两改动文件 0 错 |
| format | `bunx biome format <两文件>` | exit 0 |
| biome check | `bunx biome check <两文件>` | exit 1：两文件各 1 条 `assist/source/organizeImports`（1:1 整块 import）——见 F4 |

## Findings

**F1（Low，过程项，不影响正确性）：F1 的 RED 运行无捕获工件。** `evidence/r02/red-store.txt`（23:12）是 R02 主任务 call-path 的 RED-2，早于 F1 brief（23:47）；F1 RED（3 fail/3 pass）仅存于报告文字。已做逻辑重建替代验证：(a) 旧 filter 行 `!known.has(ref)` 单独成立，见 `git diff` 删除行；(b) `knownToolRefs`（store.ts:1437–1451）在 diff 中零 hunk 触碰，fixture 库无 `@research` 行 → 角色 ref 必落 `unknown` → `PluginRefusedError`（routes.ts:2782 映射 400，链路核实）；(c) 报告的 3 fail/3 pass 与断言级分析逐例吻合——①② 直接抛错，③ 恰因新增的 `.not.toContain("@research")` 断言失败（旧错误信息同时点名角色 ref），④⑤⑥ 负例旧代码下也必然拒绝。后续同类修复建议把 RED 输出落盘。

**F2（Info，不处理）：角色 ref 仍进入 `knownToolRefs` 的 IN 查询。** `declared` 未先滤角色 ref，`inArray(serverId, [… "@research" …])` 带一个不可能命中的值——代价可忽略，行为无影响；先滤反而多一次遍历分支。记录备查。

**F3（Info，不处理）：调用 `researchRoleOf(ref)` 前无显式 typeof 护栏。** R02 watch item 要求消费侧挡非字符串；此处 `declared` 由 `input.tools: string[]` 经 `.map((ref) => ref.trim())` 构造，元素类型保证为 string，非字符串会在 `.trim()` 处先行抛错，护栏语义已由构造点承担。与 selection.ts:234 的显式护栏（面向库行数据）场景不同，无需补。

**F4（Info，既有红）：`biome check`（organizeImports）两文件既有红。** import 块乱序为 R02/U02 前置 uncommitted 改动带入（store.ts:86 `connectAppRefusal` 位置、测试文件 node: 顺序），非本任务引入；brief 只要求 `format` exit 0（已达成）。留 V01 统一处置。

## 审查要求逐项结论

1. **修复正确性：成立。** `researchRoleOf`（shared/research.ts:91–97）非 null 恰为 `@research/search`/`@research/fetch`（prefix 严格 `@research`、无第三段、role ∈ {search, fetch}），放行语义精确。真实 ref 的 DB 校验零变化（`knownToolRefs` 无 hunk；测试 ③ 证明未知真实 ref 仍拒、错误只点名未知 ref）。三负例均有用例钉死（`@research/searh`/`@research/`/`research/search`，均零持久化）。无新权限：`skill_tools` 无 FK、不授东西（schema plugins.ts:593–605），授权仍在 selection `declaredBy`（selection.ts:217–243）与 granted 集合求交，角色展开仅收 granted 内同角色 refs——selection 25/25 我已亲跑。端到端链核实：POST /skills（routes.ts:2764）→ installSkill → 400（routes.ts:2782）；marketplace 安装路径（marketplace/routes.ts:221/326）复用同一 store seam，一并修复、无第二条分叉校验。
2. **最小性：成立。** store.ts 全部 hunk 已逐个归属：F1 仅 2 处（import :53 + filter :5058–5067）；其余为 R02 documented（deploymentTokenHeader、两处 tokenHeader call site、connectionTokenFor keyed 拒绝）与 U02 保留（connectAppRefusal import + 4 处 personal 臂包装），无未归属 hunk。测试文件 F1 净增 = `skills, skillTools` import + EOF describe；新增 12 test = R02 6 + F1 6，既有 141 用例原样（147 = 141+6）。selection/tools/mcp/transport/catalogue/shared-research 均无 F1 归属改动。
3. **测试质量：成立。** 6 用例矩阵恰为 brief 要求（纯角色/混合/未知真实+角色错误信息不点名角色 ref/三负例），13 expect 与报告一致且我复跑吻合；fixture suite 唯一（`skillref_${suite}` 等，randomUUID），`onConflictDoNothing` 建造、afterAll 级联清理（skill_tools onDelete: cascade 已在 schema 核实），**我独立跑后四表残留 0**；`saveVault` stub 对 create/update 抛错，兼作"保存路径不触 vault"的哨兵；拒绝用例全部断言零持久化（先校验后写的 all-or-nothing）。RED 见 F1（Low）。
4. **回归：全部独立复现。** integration 147/147、selection 25/25、typecheck 仅 3 条登记过的 BASE 红、format exit 0、无 drift。

无 critical/high/medium findings。

Spec compliance: pass
Code quality: pass

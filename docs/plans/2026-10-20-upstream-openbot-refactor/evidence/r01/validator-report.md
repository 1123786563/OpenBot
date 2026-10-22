# R01 Validator Report — backend_validator 验收

- Task: R01（共享研究角色与 provider catalogue，AC A10 静态半部，Issue #500）
- 工作区: `/Users/wuyongjun/trea/OpenBot/.worktrees/upstream-openbot-update`
- 日期: 2026-10-20
- 结论: **6/6 PASS，验收通过**。无阻断项；2 条 P3 记录项（均为报告记账瑕疵，非代码缺陷）。

---

## 1. 行为（亲跑）— PASS

| 命令 | 结果 |
|---|---|
| `bunx e2e run --config e2e.unit.config.ts shared/research.test.ts`（无 scope） | **13/13 passed**（Test Files 1 passed） |
| `E2E_UNIT_SCOPE=server bunx e2e run --config e2e.unit.config.ts server/tests/plugin-catalogue.test.ts` | **63/63 passed** |
| 附加加固：同 scope `server/tests/parallel-research.test.ts` | 4/4 passed |

## 2. 上游忠实度（亲 diff 核对，非转抄报告）— PASS

比对对象：`docs/plans/2026-10-20-upstream-openbot-refactor/evidence/upstream-sources/server/src/plugins/catalogue.ts`（744 行）vs 本地 `server/src/plugins/catalogue.ts`。机械比对（提取块内全部字符串字面量做集合 diff）：

- 四条目块（上游 :242-293 vs 本地 :242-295）：**字符串集合逐项相同**——
  - `exa`: host `https://mcp.exa.ai`、path `/mcp`、auth `{kind:"none"}`、writeTools `[]`、readTools EXA_READ_TOOLS、docsUrl `https://exa.ai/docs/reference/exa-mcp`
  - `exa-authenticated`: 同 host/path，auth `{kind:"deployment-bearer", header:"x-api-key"}`（上游 :263 同注释）
  - `firecrawl`: host `https://mcp.firecrawl.dev`、path `/v2/mcp`、auth none、writeTools/readTools 引用常量
  - `firecrawl-authenticated`: 同 host/path，auth `{kind:"deployment-bearer"}`（无 header 字段 ⇒ 默认 Authorization，与上游一致）
- 三个工具数组（上游 :175-196 vs 本地 :170-197）：**逐工具相同**——EXA_READ_TOOLS 3 项、FIRECRAWL_WRITE_TOOLS 6 项、FIRECRAWL_READ_TOOLS 4 项。
- 既有 Parallel 两条目与上游同样逐字一致（本地 :218-241 vs 上游 :218-240）。
- 注：任务清单给的上游行号 :247-289 与实际 :242-293 有偏移，不影响比对结论。

## 3. fail-closed — PASS

- **未知工具即便 recorded "read" 仍 write**：断言在 plugin-catalogue.test.ts「an unknown Firecrawl tool is a write even when the vendor called it a read」：`classifyTool(firecrawl, "firecrawl_monitor_delete", true, "read") === "write"`、`("firecrawl_scrape_v3", true, "read") === "write"`；反向收窄 `("firecrawl_scrape", true, "write") === "write"`。代码支撑：catalogue.ts:583 readTools 分支位于 writeTools（:579）之后、recorded（:586）之前——allowlist 不被 vendor 列买回。
- **`Object.hasOwn` 防原型键**：shared/research.ts:69（含注释）；测试断言 `researchRoleOfTool("toString"/"constructor", …) → null`。
- **子域伪装负例**：`evil-search.parallel.ai`、`search.parallel.ai.evil.com`、`mcp.exa.ai.evil.test`、`api.exa.ai`、`eu.mcp.firecrawl.dev`、`mcp.firecrawl.dev.evil.test`、`evil.test/mcp.exa.ai` 全部 `hostAdmissible === false`。
- **路径变种**：caller path `/v2`、`/mcp`、`/` 均被忽略，`entry.path` 恒为 `/mcp` 或 `/v2/mcp`。
- **重复 key**：`new Set(CATALOGUE.map(key)).size === CATALOGUE.length`（BY_KEY 是 Map，静默遮蔽防回归）。

## 4. 兼容 — PASS

- **Parallel 条目零改动**：diff hunk `@@ -184,6 +239,60 @@` 中 parallel/parallel-authenticated 仅以上下文行出现，无任何 +/- 行触及两。
- **`tokenHeaderFor(parallel-authenticated) === "Authorization"`**：两处测试断言（「a vendor without its own header keeps Authorization」与「keeps the inherited keys…」）。
- **旧 ref 不失效**：`examples/fintech/skills.yaml` 依赖面 = `parallel/web_search`、`parallel/web_fetch`、`parallel-authenticated/web_search`、`parallel-authenticated/web_fetch`——四个 key 与工具名全部未动；测试断言 `researchRoleOfTool` 正确解析且 `classifyTool` 仍判 read；`parallel?.readTools` 为 undefined（不切换 allowlist 方向）。亲跑 `parallel-research.test.ts` 4/4 绿。
- **签名兼容**：`catalogueEntry` / `hostAdmissible` / `resolveServerUrl` / `classifyTool` 四签名 HEAD 与工作树逐字相同（逐一比对）。`tokenHeaderFor` 为新增导出，`CatalogueAuth.header?` 为可选扩展，旧条目 `{kind:"deployment-bearer"}` 类型与行为均不变。

## 5. 范围 — PASS

- **恰 4 文件（2 新 + 2 改）**：`comm(before-tracked.diff 文件集, after-tracked.diff 文件集)` = 恰好 `{server/src/plugins/catalogue.ts, server/tests/plugin-catalogue.test.ts}` 两个新增修改；untracked 新建 `shared/research.ts` + `shared/research.test.ts`。`docs/verification/e2e-bun-suites.json` 与 `e2e.unit.config.ts` 的 before/after hunk **逐字节相同** ⇒ R01 对其零改动，无需登记。工作树内其它未提交文件（含 untracked `shared/connect-prompt.*`）为前置/并行任务产物，不在 R01 owned_files。
- **归层与 audit**：两新文件均 native 桶（运行标记 `|node|`）；`node scripts/e2e-coverage-audit.mjs` **exit 0**：1060 files · 567 native · 478 driven · no gaps。
- **typecheck**：`bun run --filter server typecheck` 恰 **3 条**错误，全部 `scripts/bootstrap-local-gateway.ts`（:106/:108/:120，GatewayProbeRun/GatewayCapabilityNegotiationRun 域）。该文件 `git diff HEAD` 为空 ⇒ BASE 既有红，**零新增**。
- **format**：`bunx biome format` 四文件 **exit 0**（Checked 4 files, no fixes needed）。

## 6. RED 真实性（逻辑核对）— PASS（附记录项）

- **RED-1 COLLECTION_ERROR**：机制真实——`shared/research.test.ts` 直接 `import … from "./research"`，模块缺席时 e2e 按文件容错报 COLLECTION_ERROR（ADR 0008 明载一个文件求值失败即 COLLECTION_ERROR）。
- **RED-2 断言级**：测试 import `tokenHeaderFor`，HEAD catalogue 无此导出 ⇒ 先 COLLECTION_ERROR（named export 缺失即求值失败，同 ADR）；补类型+默认实现后，四条目/readTools 缺席使依赖断言必然失败（`catalogueEntry("exa") → null ⇒ resolveServerUrl/readTools 断言红`）。声称 11 failed / 52 passed 与 63 总数自洽；事后无法重建 RED 时点树做精确复算，逻辑重建给出 ≥11 条失败，与声称相容。非空洞通过。
- **P3 记录项 1（报告记账失真）**：implementer-report §1/§6 称「追加 11 用例（63 总）/52 原有 + 11 新增」，与 diff 事实不符——实测 **新增 17 个 test 块（+17/-0）**，HEAD 基线 46 条 ⇒ 46 + 17 = 63。「52/11」实为 RED 时点的通过/失败分布，GREEN 行「52 原有」标注错误。总数 63/63、13/13 正确，代码无影响。
- **P3 记录项 2（RED 计数不可复算）**：11 failed 精确值事后不可独立验证；机制真实性与 ≥11 下限已核，不构成缺陷。

## 问题分级汇总

| 级别 | 项 | 处置建议 |
|---|---|---|
| P3（记录项） | implementer-report.md 用例拆分失真：新增 17 而非 11；「52 原有」应为「46 原有 + 17 新增」 | 修订报告文案即可，不阻塞 |
| P3（记录项） | RED 精确计数（11 failed）事后不可复算，逻辑下限 ≥11 与声称相容 | 接受；后续 RED 证据建议留存原始输出文件 |
| 观察 | 任务清单上游行号 :247-289 与实际 :242-293 偏移 | 无影响 |
| 观察 | 工作树混有其它任务未提交文件（shared/connect-prompt.* 等），已用 before/after 对比隔离 | 无影响 |

## 验收判定

**PASS（6/6）**——四条目上游忠实、fail-closed 语义成立、兼容面零破坏、范围干净、native 归层对账通过、RED 机制真实。R01 可进入集成。

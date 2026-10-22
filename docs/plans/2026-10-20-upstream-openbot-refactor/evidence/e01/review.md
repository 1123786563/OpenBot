# E01 独立 Review（AC A12）

- Reviewer：independent（只读复核；唯一写入为本文件）。日期：2026-10-20。
- 对象：`docs/plans/2026-10-20-upstream-openbot-refactor/adoption-decisions.md` + `evidence/e01/architect-report.md`。
- 方法：对每项结论抽样 1–2 条关键证据独立复跑（`git show` / `git ls-tree` / `git --git-dir=…modules/apps/openmuse` / 子模块 archive 后 grep / 直接读工作树），up11 六条 criteria 逐条对照；未修改任何源代码、测试或文档。

## 结论

**总体可信。** 三个固定 SHA 全部亲验相符；抽查的全部 load-bearing 证据（子模块三态、Antigravity 冲突引用、harness 三端读取、toolkit 同源判定、既有能力 file:line、矩阵三处误判修正）均成立。发现 5 条非阻断问题（2 Low、3 Info），均不影响任何采用/延期结论。

## Findings

### F1（Low，引用精度）`server/src/memory/intelligence.ts:18-22` 指向错误
adoption-decisions.md §5（及 §修正表）以 `intelligence.ts:18-22` 支持 "GRANT 恒为 `user: read-write, project: none`"。亲验：`:18-22` 是 `IntelligenceMemoryRecord` 类型定义；实际 GRANT 常量在 **`:32`**（`const GRANT = { user: "read-write", project: "none" }`），其依据注释在 `:24-31`。内容正确、指针错误约 10–14 行，不误导结论但复跑者会先看到类型而非 GRANT。

### F2（Low，数字不准）"60+ 文件" 高估
adoption-decisions.md §1 行为差距称 `491d6215:apps/mobile/src/` "60+ 文件"。亲验：`git ls-tree -r 491d6215 --name-only apps/mobile/src/` = **38** 个文件；整个 `apps/mobile/` 递归 = 56。无论按哪种口径都不到 60+。"有页面" 结论不受影响（文件数量级与 README 五主导航均证实），但数字应更正。

### F3（Info，引用精度）本地 create-agent-dialog 的 builtin|managed 引用行偏差
adoption-decisions.md §3 称本地 Web 向导 "`builtin | managed` 二分（`:75,100`）"。亲验：`AgentKind = "builtin" | "managed"` 在 **`:100`** ✓；`:75` 是 `const STEPS = ["identity", "visibility", "kind"]`，与本论点无直接关系。fork 本身存在、Web 向导不消费 harness 目录（全文件 grep "harness" 零命中）均属实。

### F4（Info，表述简化）toolkit 同源 diff 的定性
"diff ≈600 行（import/ports）" 的行数精确：`diff <(git show e8bb2736:toolkit/src/run-turn.ts) server/src/routines/run-turn.ts` 改动行恰为 **600**（上 922 行 / 本地 766 行）。但抽样 diff 中部与尾部显示除 import/ports 外，上游还做了结构性 helper 抽取（outcome 分类器 + `conclude()`，本地为内联 throw 流程），"集中在 import 路径与 ports 抽取" 是轻度简化。抽验的两文件共享成段原文注释（`THE LOCK LIFECYCLE IS NOW OURS TO KEEP CORRECT` 双方均在 `:31`）、锁生命周期/超时/挂起语义一致，**未发现行为分歧，"同源而非双实现" 结论成立**。

### F5（Info，引用范围略短）`toolkit/src/lease.ts:1-50`
`keepLease` 函数实际在 `:55`（`LockLapsedError` 在 `:29-30`、409 `THREAD_LOCK_RENEWAL_FAILED` 在 `:9,21`，均在引用范围内）。内容全部属实，仅函数体一行落在引用区间之外。

## 逐项亲验记录（抽查通过项）

1. **SHA 固定**：HEAD `3b4a7c68132c…`（`git rev-parse` ✓）；gitlink `491d6215fa50…`（`git ls-tree HEAD apps/openmuse` ✓，`git submodule status` 前缀 `-` ✓，经 modules gitdir `cat-file -t` → commit、subject "docs(agents): 对齐 OpenBot 集成工作的 Issue tracker 与事实源边界" 与报告一致 ✓）；上游 `e8bb27368ff4…` → commit ✓，`git remote -v` upstream = CopilotKit/OpenBot ✓。
2. **子模块三态（up11 AC1）**：有页面——`apps/mobile/src/` 38 文件、README "Behavior" 节五主导航 + Mail/Calendar/Browser/Files/Connections 逐字相符 ✓；有 API——`src/api.ts` `MuseApi`（`Authorization: Bearer`）+ `POST /api/session` ✓；已实测——`apps/mobile/test/` 9 个测试文件清单逐个相符 ✓，子模块根 `package.json:16,18`（test 含 `apps/mobile/test/*.test.ts`、typecheck 含 mobile）✓，CI `ci.yml` `pnpm test` 在所引 `:24-28` 区间 ✓，`assets/demos/2026-09-16/mobile.mp4`、`web.mp4`、`2026-09-23/jev-live-web.mp4` 均存在 ✓。子模块 mobile 内 grep `routine`/`approvals`/`plugins` 零命中，佐证 "无独立页" 差距登记 ✓。deps 含 `@copilotkit/react-native`、无 better-auth/expo-router ✓（"两套栈不可混接" 成立）。
3. **Antigravity（AC2）**：`agent-antigravity/src/main.py:3` "GEMINI-ONLY, AND PINNED" ✓、`:54` `pinned_provider="google"` ✓、`:57-66` key 取 `key_variable`/`GEMINI_API_KEY` 回落 ✓、`:76-84` `GeminiAPIEndpoint(base_url=…)` ✓；Dockerfile `python:3.12-slim` + glibc `localharness` 注释 ✓；`shared/harnesses.json` antigravity 行 `credential:"google"`、port 4214 ✓；google 行 `key_variable: GOOGLE_API_KEY`（model-providers.json）✓。ADR 冲突引用逐字核对：ADR 0002`:7`（逐用户 Bifrost 虚拟 Key）`:11`（明确拒绝共享部署余额/每 Bot 一 Key）✓；ADR 0003`:7`（同步预留/可靠结算）`:9`（价格完整方可启用）✓；父 Spec `:149` Out of Scope 含 "Antigravity 实装" ✓；本地 `agent-antigravity/` 不存在 ✓；`model-scope.ts:1-18` 默认关闭 + 完整定价才可开放 ✓。**"延期，不旁路接入" 判定与证据一致。**
4. **harness 三端读取（AC3）**：上游 `shared/harnesses.json` 14 行 ✓（含 `_readme`、webSummary/webCreate 各 15 处）；`shared/harnesses.ts:11-14`（桌面不在根 workspace、`include_str!` 的原因）✓、`WEB_HARNESSES` filter 在 `:70` 附近 ✓；桌面 `include_str!("../../../shared/harnesses.json")` 在上游 `harness.rs:197-198` ✓；上游 Web 对话框 `:1` import、`:637` 渲染 `WEB_HARNESSES` ✓。本地桌面 `harness.rs` 硬编码 13 行（无 antigravity）、claude-agent-sdk `Credential::Anthropic`（`:258`）、byo-url `:299-310`、Mastra transport 注释 `:141-151` ✓；本地根 `package.json` workspaces = `['app','server','worker']`，桌面确非成员 ✓；本地独有 `agent-trpc/Dockerfile.bot`、`agent-sandbox/package.json`（`@openbot/agent-sandbox`）✓。
5. **toolkit 同源（AC4）**：见 F4；另验 `limits.ts:10,20,41`（5min/5s/120s）✓、`lease.ts` 409/LockLapsedError ✓、`ports.ts` TurnAdmission/ComponentCatalog/acquire-renew-release（`:17,27,58-67`）✓、`headless-tools.ts:23,31,40` ✓、`continuation.ts` ApprovalContinuation + AsyncLocalStorage ✓、`run-turn.ts:43` "WHY A SECOND RUNNER INSTANCE IS SAFE"（thread lock = 平台资源）✓；Mastra Spec `:57`（Run/Attempt/lease/取消 权威 = OpenBot RunService）、`:65`（不建立第二套权威）逐字相符 ✓；`:104-115` 生命周期表、`:124` CAS+过期回收、`:130-131` 记忆票消费既有合同 ✓。映射去重表六行与本地实现（`guardBotTurn`、`../approvals/native-context` 等 import 亲验）一致，反向禁止条款（不建平行执行票）明确 ✓。
6. **既有能力四处（AC5）**：`memory/store.ts:65-71` `mirrorEligible`（未删除+启用+confirmed/edited+非空）✓、`:111` "the person has accepted is mirrored there" ✓、`:129-130` 逐人单飞 ✓；`learning/auto-assign.ts:1-10`（`AUTOMATIC_LEARNING_CONTAINER_ID`+`DEPLOYMENT_INITIATOR`）✓、`ensure-container.ts:1-12`（三凭据路径 + runtime key 反证）✓；`server/src/identity/` 6 个被引模块全在、identity-* 测试恰 13 个 ✓；`app.ts:1587` `text/csv; charset=utf-8` + `audit-events-<day>.csv` 附件名 ✓、`audit.exported` HEAD`:477`/工作树`:480`（双注）✓；`audit-export.test.ts`、`app/tests/audit-export-truncated.test.tsx`、memory/learning 测试均存在 ✓；`hindsight/config.ts:1-12` 引 ADR 0005 ✓。
7. **矩阵三处误判修正**：矩阵 `:20`（mobile "缺失"）、`:26-27`（上游路径 `server/src/web-research.ts`）、`:30`（记忆镜像 "部分具备…未找到定期迁移式同步"）原文逐字在案 ✓；`git show e8bb2736:server/src/web-research.ts` → fatal ✓、`ls-tree` 含 `server/tests/web-research.test.ts` ✓、`shared/research.ts:2` 引文逐字相符 ✓。三处修正依据充分、可独立复跑。
8. **up11 六条 criteria 逐条**：①固定 SHA+三态+不复制第二套 mobile → §1 ✓；②Antigravity 逐项比较+不兼容则延期 → §2 ✓；③harness 保留本地差异+跨语言复用（`include_str!` 机制、trpc/sandbox 新行、Mastra transport、builtin/managed 分叉）→ §3 ✓；④toolkit 映射去重+不建第二套权威 → §4 ✓；⑤四项核验证据+不重复建票 → §5 ✓；⑥每缺口理由+独立验收边界+不宣称上线 → §6 + 显式免责（`:5`、`:55`、`:82`、`:188`）✓。全部引用的 up11 AC 编号与票文一致。
9. **越界措辞检查**：全文未发现任何 "已上线/已接入/已交付" 式表述；"已具备" 仅用于有实现+测试证据的存量能力（本次逐条验证为真）；拆包/harness 机制均明确 "后续任务交付"。**无越界。**
10. **固定字段完备性**：§1–§4 七字段齐备；§5 以 "现有入口/行为差距/证据 + 约束 + 复用/后续验收 + 结论" 合并呈现（核验性登记，差距为 "无"，可接受）；§6 汇总表补齐理由与验收边界。后续验收边界均可复核（测试/等价断言/双用户归属/零行为变化等均为可观察证据要求）。
11. **约束遵守**：`adoption-decisions.md` 与 `architect-report.md` 均为未跟踪新文件（不在 HEAD），与 "唯一写入为两份产出" 一致；未发现 E01 名下的生产代码/测试改动痕迹可归因（本 worktree 在途改动属其他并行任务，architect-report 已声明只读未触碰）。

## 判定

findings 汇总：F1 Low、F2 Low、F3 Info、F4 Info、F5 Info——全部为引用精度/表述层面，无结论性错误，不阻断 A12 通过。建议后续任务顺手更正 F1/F2 两处指针与数字（属 E01 产出文档，可在下一轮文档修订中处理，本次 review 不代改）。

Spec compliance: pass
Quality: pass

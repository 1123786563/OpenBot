# Issue #4 验收证据索引 — 2026-10-31

根 Issue：`1123786563/OpenBot#4`（Opik 自托管聚合 Spec，37 正式子票 #7–#43）。
本文件是 T37/#43 AC5「验收证据索引」的仓内交付物：交付 Run 的终审判定此前只存在于被 gitignore 的 `.archive/`（GitHub 侧不可核验），本索引把可核验的判定与指针提升到版本控制。原始全文仍以归档为准。

## 一、终审快照（2026-10-28 R5，全文 `.archive/runs/2026-10-24-opik-issue4/reviews/final-review-r5*.md`）

- **A1–A13：13 PASS**（全部带行内限定与披露；R4 的 4 GAP/1 UNVERIFIABLE 全部收口）。
- **37 票：27 PASS / 9 UNVERIFIABLE（8 UI 票 + T32，当时判为环境冻结或设计边界）/ 1 流程 PENDING（T37）**。
- 独立 Review 链：FREV R7 → R8 r1 FAIL(3)→整改→r2 PASS(0 阻塞)；OCR 终态 134 文件零缺口（final-report §三，程序化对账 frev-r8-r2）。
- 真实实例证据：opik4-e2e compose 三轮 ingest PASSED（八项 checks 全 true）、f8d 真机计分/计费/删除、F9R derived 6/6 join；全部存 `verification/e2e/` 与 `workers/e2e-real-instance-report.md`。

### A1–A13 终判（R5 §5 摘录）

| A | 终判 | 关键限定 |
| --- | --- | --- |
| A1 | PASS | disabled 回归+真实 2.2.100 接收 |
| A2 | PASS（带限定） | ambient join 未单独真机复验；不声明全量协议身份覆盖 |
| A3 | PASS | — |
| A4 | PASS | F7E r2 独立秘密复扫 60×15 CLEAN |
| A5 | PASS | 观测只宽读不宽写 |
| A6 | PASS | epoch-工件读法按 §3 受控披露 |
| A7 | PASS（带边界） | judge 判文 A 侧 4/4 INVALID（F8D-3 low 后续票，tokens 已结） |
| A8 | PASS | — |
| A9 | PASS | a9.json 真机兼容性/退化回链 4/4 |
| A10 | PASS | F7E-F3 low 网关耦合另列 |
| A11 | PASS（带披露） | b 腿真机闭合；epoch 接线分歧披露+后续票 |
| A12 | PASS | — |
| A13 | PASS（带限定） | 限定同 A2；不声明所有 host/端点形态已验 |

## 二、2026-10-30/31 更新：R5 的「app 渲染冻结」前提被证伪

R5 将 8 张 UI 票（#8/#18/#19/#24/#27/#36/#37/#42）判 UNVERIFIABLE，依据是 app 渲染套件 waitFor 超时（当时归因为运行器环境冻结）。2026-10-31 复跑证明**该根因不成立**：

- 真根因 = `app/src/components/bot-profile/bot-subpage.tsx:65` 引用未声明标识符 `agentData`，全部 Bot 子页与观测 run 详情在渲染期抛 ReferenceError 落入错误边界（修复提交 `c61c941b5`，一行：读 `agent.data`）。
- 修复后 **app 可观测性家族 12 文件 229/229 全绿（21 秒）**，含此前从未取得绿记录的 T30/T31/T36 前端断言——8 张 UI 票的 UNVERIFIABLE 判定自此**升级为「有现行绿记录」**（2026-10-31 复跑，HEAD 含 `c61c941b5`）。
- 同轮补充证据：server opik 单元族 41 文件 **1020/1020**；integration 族 17 文件 **262/262**（测试库 `openbot_test`@5433 全链迁移，303 表，bindings 双唯一索引核验在位）。
- 同轮修复（均为把 923f9cc33→d2a4396a3 重构波打断的守卫/指针归位，非行为变更）：三个装配源码守卫 needle（`5defb910a`）、T03 两处 stale 文档指针+守卫断言（`2819f899d`，见 #9）。
- main 侧同类丢代码回归（merge 1a0736905：sharing/craft/billing 等 TS2304）属 PR #710 CI 基线收口范围，不并入 #4。

## 三、逐票证据指针（关票引用模板）

| 票 | R5 终判 | 现行证据 |
| --- | --- | --- |
| #7–#17, #19–#26, #28–#35, #39–#41 | PASS（各行内限定见 R5 §6） | R5 终表 + 本轮 server 1282/1282 复跑 |
| #8/#18/#19/#24/#27/#36/#37/#42（8 UI 票） | R5 UNVERIFIABLE → **2026-10-31 复跑 229/229** | `bun test`（app/tests/ai-observability-*、observability-*）@ HEAD 含 c61c941b5 |
| #38 T32 | UNVERIFIABLE（**BUILT NOT WIRED 设计边界**） | 保持 open；接线需立项决策 + 真实实例入口证明（未认证写入 401） |
| #43 T37 | PENDING（流程剩余） | 本索引即 AC5 交付物；剩余=最终提交前全范围 OCR（用户 2026-10-20 裁决）+ 关票授权 |

## 四、剩余门禁（截至本索引提交）

1. 最终交付提交前全范围 OCR 一次（中间轮不跑，用户 2026-10-20 裁决）。
2. GitHub 关票（#7–#43 批量 + 父 #4）需写入授权（fork 仓，`--repo 1123786563/OpenBot`），且以 main CI 转绿为 verified 门禁。
3. T32/#38 接线立项：in-process ingest 路由或私有 API passthrough 二选一，属产品决策。
4. R5 §7.2 后续票清单（R5-F1/F2/F3、F8D-3 等 low 项）待登记。

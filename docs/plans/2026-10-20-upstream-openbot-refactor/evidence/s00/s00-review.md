# S00 独立复核报告（S00 Review）

- Reviewer：独立 reviewer（只读复核，唯一写入为本报告）
- 日期：2026-10-20
- 复核对象：`docs/plans/2026-10-20-upstream-openbot-refactor/`（dag.json、implementation-plan.md、ledger.md）、`docs/specs/2026-10-20-upstream-openbot-adoption-design.md`、`docs/tickets/upstream-openbot-update/tickets.json`、`evidence/s00/`、`evidence/upstream-sources/`
- 工作区：worktree `upstream-openbot-update`，BASE `3b4a7c68132c3507300408346a44fb9d56f3c14c`（与 dag.json `local_base` 一致，无漂移）
- 方法：只读 grep/ls/find + Python 标准库做 DAG 结构校验（无第三方依赖，未运行项目代码，未改动任何源/测试/文档）

---

## 1. DAG 完整性 — PASS

脚本化校验 `dag.json`（Kahn 拓扑 + 引用检查）：

- (a) 节点数：**18**；ID 唯一（18/18，无重复）。`contains.plan` 列出的 18 个 ID 与 `nodes` 完全一致。
- (b) `depends_on` 引用：**0 个缺失引用**；**无自环**；拓扑排序输出 18/18，**无环**。
- (c) V01 `depends_on` = `[S01, S02, S03, S04, U01, U04, L03, D01, R03, E01]`，共 10 项：直接覆盖全部 9 条变更链的终点任务（S01–S04、U01、U04=U02→U03→U04 终点、L03=L01→L02→L03 终点、D01、R03=R01→R02→R03 终点）+ E01；传递闭包覆盖除 V01 自身外的全部节点（含全部 16 个变更任务）。与 implementation-plan §3「全部交付→V01、U02→U03→U04、L01→L02→L03、R01→R02→R03」的定义一致。
- (d) A01–A12 全部出现在节点 `acceptance` 中，无缺失：A01→S01、A02→S02、A03→S03、A04→S04、A05→U01、A06→U02/U03、A07→U04、A08→L01/L02/L03、A09→D01、A10→R01/R02/R03、A11→V01、A12→E01。每节点 `source_requirements` 与 `acceptance` 一致；`source_issues` 与 tickets.json 的 issue_number 映射（见第 2 项）一致。

## 2. AC 映射一致性 — PASS

三方对照（Spec Acceptance Criteria 表 / implementation-plan §1 / tickets.json）：

- **验收映射**：Spec 表 L121–132（A01→UP01 … A10→UP10、**A11→UP12**、**A12→UP11**）与 tickets.json 每张票的 `acceptance` 逐项一致（UP01–UP10 各对应同号 AC，UP12→[A11]，UP11→[A12]）。implementation-plan §1 表（L40–51）的 AC→Tasks 与 dag.json 节点 acceptance 逐项一致。
- **依赖 UP07←UP06**：tickets.json UP07 `depends_on=[UP06]`、`native_blocked_by=[495]`；GitHub GraphQL 证据 `#499 blockedBy=[495]`；plan §2 I2「U02 生产，U03/U04 消费」+ dag.json U04 depends_on U03。四方一致。
- **依赖 UP10←UP07**：UP10 `depends_on=[UP07]`、`native_blocked_by=[499]`；GraphQL `#500 blockedBy=[499]`；dag.json R03 depends_on `[R02, U04]`。一致。
- **依赖 UP12←其余 11 张**：UP12 `depends_on=[UP01..UP11]`（11 张）、`native_blocked_by=[490..500 全部 11 个编号]`；GraphQL `#501 blockedBy=[490,491,492,493,494,495,496,497,498,499,500]`；dag.json V01 传递全覆盖。一致。
- 其余票 `depends_on=[]` 与 GraphQL `blockedBy=[]` 一致；13 个 Issue（#489 + #490–#501）在 gh-issues-graphql.json 中全部 OPEN，与 ledger §3 记载一致。
- 程序化验证：tickets.json 全部 12 张票的 `native_blocked_by_numbers` 与 `depends_on` 的 issue_number 完全一致（True）。

## 3. 账本声明核验（ledger.md §4「不存在」声明）— PASS

只读 grep/ls/find 在 worktree BASE 逐项验证：

| 声明 | 结果 | 证据 |
|---|---|---|
| A05 `app/src/components/computer/use-auto-watch-screen.ts` 不存在 | 属实 | `ls app/src/components/computer/` 13 个文件无此项；`find app shared server -name "use-auto-watch-screen*"` 0 命中 |
| A06 `shared/connect-prompt.ts` 不存在 | 属实 | `ls shared/` 无 connect-prompt.ts；`find … -name "connect-prompt*"` 0 命中 |
| A06 connect-app marker 不存在（shared/、server/src/plugins/） | 属实 | `grep -rn "connect-app" shared/ server/src/plugins/` 0 命中；`CONNECT_APP_MARKER` 在 shared/、server/src/、app/src/ 全部 0 命中 |
| A07 `app/src/components/channels/tool-activity.tsx` 不存在 | 属实 | `ls app/src/components/channels/` 有 browser-activity.tsx 无 tool-activity.tsx；`find app -name "tool-activity*"` 0 命中 |
| A08 `code_required` 在 `server/src/passwords/`、`server/src/db/schema/passwords.ts` 无匹配 | 属实 | 两处 grep 0 命中；`grep -rln "code_required" server/src/` 全目录 0 命中（比声明更强） |
| A09 `server/src/model-availability-check.ts`、`intelligence-entitlement-check.ts` 不存在 | 属实 | `find server/src -name …` 0 命中；`ls server/src/` 无这两个文件 |
| A10 plugins/shared 无 exa/firecrawl 注册 | 属实 | shared/：`grep -rnE '\bexa\b'`、`grep -rni firecrawl` 均 0 命中；server/src/plugins/：`exa` 独立词、`exa-` 前缀 0 命中，`firecrawl` 仅 broker.ts:239、:472 两处**注释文案**（描述 API key 填写说明，非 catalogue key/工具名注册；catalogue.ts 中 0 命中）。已按单词内偶然匹配区分，不影响声明成立 |

## 4. 交接证据存在 — PASS

- `evidence/s00/`：
  - `gh-issues-graphql.json`（4,055 B）：含 #489 + #490–#501 共 13 个 Issue 节点，state/labels/blockedBy 结构完整。
  - `gh-sub-issues.json`（132,059 B）：12 条 sub-issue REST 记录（#490–#501）。
  - `main-checkout-status-baseline.txt`（274 B）：5 条未跟踪路径，与 ledger §1 及当前 worktree git status 快照一致。
  - `env-copied.txt`（77 B）：仅含 env sha256（`3265a451…96f3`，与 ledger §2 一致），无秘密内容。
  - （另有 `main-checkout-stash-list.txt`，见 Finding F2。）
- `evidence/upstream-sources/`：**16 个上游参考文件**（agent-computer/src/sign-in.ts、app 3 个、docs/web-research.md、server 10 个〔含 drizzle/0056_sign_in_code_step.sql、tests/web-research.test.ts〕、shared 2 个）+ `MANIFEST.sha256`；`shasum -a 256 -c MANIFEST.sha256` **16/16 全部 OK**。文件清单与 ledger §4 列举的 16 项逐一对应。

附加核验：`EXECUTION-PROMPT.md` sha256 = `6c778250…5ee`，与 ledger §0 记载一致；dag.json `local_base` 与 worktree 实际 BASE 一致。

---

## Findings

- **F1（Info）**：V01 对变更任务为「链终点直接依赖 + 传递覆盖」（10 项直接依赖 = 9 条变更链终点 + E01），不是对每个变更任务的直接边。这与 implementation-plan §3 的显式定义（U02→U03→U04、L01→L02→L03、R01→R02→R03、全部交付→V01）一致，不构成缺陷；复述在此以消除「V01 直接依赖全部变更任务」的误读。
- **F2（Low，范围外记录）**：ledger §1 称 main checkout「stash 空」，但其引用的 `evidence/s00/main-checkout-stash-list.txt` 记录了 `stash@{0}: WIP on main: 792c8760`（该提交非 BASE 祖先，疑为历史遗留、非本任务产生的共享 stash 栈条目）；同句「4 组未跟踪交接文档」对 baseline 文件中的 5 条路径（跨 docs/plans、docs/research、docs/specs、docs/tickets 4 个顶层目录组）表述有歧义。均在 §4 基线结论之外，不影响 A01–A12「均未实现」的判定；建议后续把 ledger 措辞修正为「无本任务新增 stash 条目」并核对计数口径。
- **F3（Info）**：`server/src/plugins/broker.ts:239,472` 与 `app/src/components/plugins/connection-fields.tsx:20` 存在 3 处 Firecrawl 注释性文案。非注册（无 catalogue key、无 `firecrawl_search/firecrawl_scrape` 工具名、无 `exa` 独立词/`exa-` 引用），ledger §4「无 exa/firecrawl 注册」表述准确；记录以示 grep 区分过程。
- **F4（Info）**：`server/src/passwords/`（types/store/service/routes/resume）与 `server/src/db/schema/passwords.ts` 在 BASE **已存在**（既有密码 vault 文件）；ledger §4 的声明精确为「`code_required` 无匹配」而非「文件不存在」，核验属实。备注以防后续读者误读声明范围（L02 将修改这些既有文件）。

## 结论

- **Spec compliance: pass**
- **Quality: pass**

四项复核全部 PASS；无 critical/high/medium finding，2 条 Info + 1 条 Low（F2，范围外的账本措辞/证据不一致，建议后续修正，不阻塞 S01–V01 推进）。

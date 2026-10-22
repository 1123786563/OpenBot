# Driven Driver JUnit 巨型报告解析修复

日期：2026-10-22。状态：本会话授权范围内的 bounded 测试基础设施修复。

## 背景

`docs/verification/workspace-redesign/current-session/driven-app-tests/report.json` 记录 app/tests part 1 driver 以
`Cannot create a string longer than 0x1fffffe8 characters` 失败。复现证据：

- 完整 part 1（26 文件，单进程）组合运行产出 6,091 MB 的 junit.xml（`bun test --reporter=junit`）。
- 体积集中在 `app/tests/bot-setup.test.tsx` 的失败断言 `expect(activeElement).toBe(trigger)`：bun 把整个 Happy-DOM
  inspect dump 写进 failure 正文（单条 testcase 正文达数 GB；前 60 MB 窗口内单条已 7.5+ MB 且未终止）。
- 污染链（ADR0008 已知的共享进程污染类别）：`admin-catalog-sync-ui` / `admin-credit-grant-ui` /
  `admin-gateway-readiness` 任一与 `approvals-rules` 同进程时，后者 `findByText("Add a rule")` 稳定失败
  （item-title 与已打开 Dialog 的 h2 同文本；孤立运行 `approvals-rules` exit 0）。该失败随后级联到 `bot-setup`
  的 focus 断言，触发巨型 dump。
- driver（`tests/bun-suites.test.ts` → `readJunit(readFileSync(report, "utf8"))`）在读取阶段崩溃，导致 ADR0008
  设计的"组内失败 → 孤立重跑"兜底从未执行。

注：`final-r5-driven-app-tests`（2026-10-21 01:24 之前源码）同组 6/6 pass；R5 之后的源码快照与本修复对象
`final-r5-review/hashes.txt` 逐文件核对一致（仅 P28 修复的两个 craft/detail 文件不同，与本失败无关）。该组合失败
在当前工作区可稳定复现（3/3），属既有共享进程污染类缺陷的新表现，不是本批 B1 生产代码回归（源码哈希未变）。

## 授权依据

- ADR0008：`tests/bun-suites.test.ts` 与其解析属于测试基础设施；T05-R2 已有"runner exclusion 同步"同类 bounded
  修复先例（`2026-10-20-workspace-redesign-b1-t05-repair-02.md`）。
- 本次提示词 §四：native/driven 分别要有实际收集与执行证据，新测试不许静默漏跑——driver 崩溃导致 6 组中 1 组
  无法出结论，必须修复后重跑。

## 改动范围（唯一文件）

- Modify: `tests/bun-suites.test.ts`（仅 `readJunit`/`runBun` 的读取路径）

## 允许的改动

1. `runBun` 在读取 junit 前先 `statSync`；超过阈值（64 MB）时不整读字符串，改走流式解析。
2. 流式解析保留同一返回结构：`tests/failures/errors/skipped` 计数取自 `<testsuites>` 根属性（头部即可获得）；
   `failed[]` 每条摘要仍截断 300 字符（与现有 readJunit 行为一致）；`failingFiles[]` 取 failure testcase 的
   `file` 属性。逐块（如 4 MB）扫描，只保留标签窗口，内存有界。
3. 不改变分组、环境、超时、alone-re-run、blocked 判定等任何其他逻辑；不触碰生产代码。
4. 小于阈值的报告路径保持现有 `readJunit(readFileSync(...))` 不变（零行为差异）。

## 验证

- 单元验证：对本次 6 GB 报告的截取副本（前 64 MB + 头部）与新解析路径的输出做一致性抽查（testsuites 计数与
  failingFiles 集合）。
- 端到端验证：`E2E_BUN_ONLY=app/tests E2E_UNIT_OUTPUT=docs/verification/workspace-redesign/current-session/driven-app-tests-r2 bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts`，
  期望 6/6 组有结论（part 1 走 alone-re-run：approvals-rules/bot-setup 等孤立绿 → 判 interfered 或 pass，符合
  ADR0008 语义；stderr 记录共享进程警告）。
- 独立 review：bounded 只读 reviewer 审查该单文件 delta。

## 不做的事

- 不"修绿"任何套件断言；不删测试；不改 approvals-rules / admin-* / bot-setup 的测试内容（污染缺陷本身另行记录，
  不在本 bounded 修复内）。
- 不提交、不安装依赖。

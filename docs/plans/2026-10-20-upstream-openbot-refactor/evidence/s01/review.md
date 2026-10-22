# S01 Independent Review（重派轮，2026-10-20）

- 执行角色：independent reviewer（只读；唯一写入为本报告）。
- 工作区：`.worktrees/upstream-openbot-update`，HEAD = `3b4a7c68132c…`（BASE，无漂移）。
- 对象：`evidence/s01/after-tracked.diff`（含 S01-fix-1 后增量）+ 两份报告 + brief + ledger §8。
- 本轮独立复验手段：亲跑测试与 biome、node 模拟新旧 `reachOf` 分类、上游/本地逐字节比对、哈希与行号抽查。

## 结论速览

Spec compliance：pass；Code quality：pass。无 Blocker / Major。1 Low + 2 Observation。

## 独立复验记录（非转抄报告）

1. **工作区状态**：`git status` 仅 `M server/src/config.ts`、`M server/tests/config.test.ts`；`git diff` 与 `after-tracked.diff` 逐字节一致（`diff` 为空）；`git diff --quiet HEAD -- server/tests/single-user.test.ts` 通过（零改动）；`before-status.txt` 与当前 untracked 集合一致。
2. **测试亲跑**：`E2E_UNIT_SCOPE=server bunx e2e run --config e2e.unit.config.ts server/tests/config.test.ts server/tests/single-user.test.ts` → `Tests 169 passed (169)`，0 failed 0 skipped（config 163 + single-user 6）。与两份报告及 baseline 164+5 的算术对账一致。
3. **RED 真实性独立复现**：以 node 内联复刻旧 `reachOf`（去掉空值短路）对 4 个新输入逐一分类：`example.com:3010`/`localhost:3010`/`myapp://`（hostname 均为 `""`）与 `http://.`（hostname `"."` 经既有尾点剥离归一为 `""`）旧分类全为 `private`（落入单标签 `!bare.includes(".")` 分支）→ 放行不抛错 → 新断言 "nothing was thrown"。与 implementer RED 摘录（4 failed / 165 passed）及 validator 复刻三方吻合。
4. **上游忠实度**：自 `function reachOf` 起各取 41 行，上游参考与本地 `server/src/config.ts:701` 逐字节一致（`diff` 为空）——行为行 `if (!bare) return "public";` 确为逐字移植，且位于归一化之后、loopback/单标签分支之前。
5. **biome 亲测**：`bunx biome format server/tests/config.test.ts` exit 0（S01-fix-1 结论成立）；`bunx biome lint --error-on-warnings` 两文件 exit 0；`bunx biome format server/src/config.ts` exit 1，漂移仅在 :1512、:1516、:2044（billing/lago 段），对 HEAD 版本复测同样漂移——确系 BASE 既有红，与 S01 hunk（:694/:709）无交集，不触碰正确。
6. **哈希抽查**：`shasum -a 256 server/tests/config.test.ts` = `09f391d4907a…`，与 ledger §8 S01-fix-1 登记一致。
7. **注释准确性**：node 验证 `new URL("localhost:3010")` → protocol `"localhost:"`、hostname `""`；`new URL("myapp://")` hostname `""`——config.ts 扩写注释与测试注释的表述与运行时行为一致。
8. **隐藏耦合排查**：`reachOf` 模块私有（无 export），消费方仅 `singleUserAllowed` 的 public（拒绝）/private（警告）两处；空值短路只影响拒绝路径，警告路径语义随之正确（空 hostname 不再被报为"beyond this machine"）。
9. **改动面**：config.ts +5/-1（-1 为被扩写的注释旧行）；test.ts 纯追加 0 删行（19+8=27 行，用例 +5）；`loadConfig`/`reachOf` 签名未变；`singleUserEnabled`/`configuredAuthProviders` 不在任何 hunk 内。

## Spec compliance 逐条

| 要求 | 判定 | 依据 |
| --- | --- | --- |
| hostname 归一后空值按公开/未知拒绝 | PASS | config.ts:709 空值短路返回 `public`，`singleUserAllowed` 对 public 抛错（:657-661）；4 个新用例经真实 `loadConfig` 断言 `.toThrow("OPENBOT_SINGLE_USER")` 亲测通过 |
| 不按无点单标签识别私网 | PASS | 空值检查先于 `!bare.includes(".")` 单标签分支；node 模拟证明空串旧分类 private、新分类 public |
| 合法 localhost/loopback/私网不回退 | PASS | 非空输入新旧分类逐一对照无差异（localhost/127.0.0.1/`nas`/192.168/172.20/100.x/`[fd00::1]`/mDNS 模拟确认）；still-runs 7 例 + 近似值拒绝 2 例 + 新增 `myapp://handset:3010` 全绿 |
| 认证 provider 优先级不变 | PASS | 相关函数不在 diff 内；single-user.test.ts 零改动，"a configured provider always wins"（:22）在通过的 6 例内 |
| 从真实 loadConfig 入口测试 | PASS | 两参数化块均经 `loadConfig({...})` 断言；`reachOf` 未导出，无绕过入口的直测 |
| 错误可读、不带凭据 | PASS | 消息点名 `OPENBOT_SINGLE_USER`、回显违规地址、给出 GOOGLE/MICROSOFT/OKTA + BETTER_AUTH 修复路径；新输入均为无凭据形态，无 secret |
| 其他配置字段与默认值无额外改变 | PASS | diff 仅触及 `reachOf` 及其文档注释 + 测试追加，0 删行 |

票据 up01 五条 criteria 全部满足（三字段分别覆盖 hostless；合法形态不回退；真实入口验证；错误可读无凭据、无额外字段改动；before/after + RED/GREEN + validator + 本 review 证据链齐全）。

## Code quality

- **最小移植**：行为行为上游逐字（41 行函数体 byte-identical）；本地仅扩写文档注释——该扩写是准确的（经验证）且帮助读者理解为何 `localhost:3010`（漏写 scheme 的常见 .env 错误）会被拒绝，属合理最小增量而非重写。
- **注释与代码一致**：config.ts 扩写段与测试块注释均与实测 URL 解析行为吻合，无过度声明。
- **参数化块归属与命名**：4 个 hostless 用例落在既有 refuse 块（正确的拒绝语义归属）；`myapp://handset:3010`（hostname=`handset` 非空，新旧分类均 private）落在 still-runs 块并配有说明其与空 host 形态边界关系的注释——归属与命名（行为描述式 label）正确。
- **S01-fix-1 后换行**：`bunx biome format server/tests/config.test.ts` exit 0 亲测成立；新增代码行全部 ≤80 列。新增注释行 87-98 字符，但 biome 不重排注释且 BASE 的 config.ts 已有 523 行 >80 列注释（含紧邻的上游原文注释），属仓库既有风格，非违规。
- **隐藏耦合/过度改动**：无。改动面、签名、导出、认证优先级均未动；BASE 既有 format 漂移按最小范围正确回避。

## Findings

- **F1（Low，文档漂移，不阻塞）**：两份报告均写 config.test.ts "+21 行"，该数字对应 S01-fix-1 之前的 diff；最终 `after-tracked.diff` 为纯 +27（换行使两行拆为多行，+6）。报告未随 S01-fix-1 更新。ledger §8 已记录修复与哈希更新（`09f391d4…`，与当前文件吻合），证据链可追溯，无行为影响；建议主控在登记本 review 时把行数事实改记为 +27 或在报告加勘误一行。
- **F2（Observation，同意独立后续）**："an address the public internet reaches" 对未知地址语义略欠精确。**独立判断：本轮不处理，作为独立文案后续。** 理由：该文案为上游逐字原文，最小移植不应分叉；补救句（"or serve it somewhere only you reach"）已承载可操作指引；语义精确性已在 `reachOf` 文档注释（"UNPARSEABLE COUNTS AS PUBLIC…"）处声明；测试只锚定 `OPENBOT_SINGLE_USER`，改文案零测试成本但制造与上游的无谓差异。若要做，建议与上游对齐后再动或作为独立本地化文案票。
- **F3（Observation，既有行为，超本票范围）**：拒绝消息回显配置原始值，若有人在地址字段嵌入 userinfo（`https://user:pass@host`）会被原样回显到启动错误中。此为上游既有行为、本任务未触及；hostless 新输入不可能携带凭据；错误发生在运维者自己的启动日志，非外泄路径。记录在案，不构成本票问题，可在未来加固票中考虑脱敏回显。
- **格式声明复核（结案）**：两份报告曾被证伪的 "format 干净" 声明，在 S01-fix-1 之后对 test.ts 已为真（exit 0 亲测）；config.ts 的 format-dirty 为 BASE 既有（HEAD 版本复测确认），登记于 ledger 基线事实，留待 V01 统一处理，处理方式正确。

## 最终结论

`Spec compliance: pass`
`Code quality: pass`

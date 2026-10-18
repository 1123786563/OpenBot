# MT028 独立复审报告 — OAuth 回调按服务端 state 固定归属（Issue #71）

角色：独立 Pi 复审者（全新会话，Orca task_cdcdfa21c1a8，未参与实现）。
复审树：i12-review-mt028 = BASE f0520524 + 213 前置 + 本票交付（全部未提交工作树）。
复审日期：2026-10-17。方法：全部门槛亲测复现，不采信实现存档；本报告为复审树内唯一新建文件，未修改任何被审文件，未做任何修复。

## 结论

**PASS with findings。**

票面四条 AC 在专用容器 + 受限角色 + 真实 RLS 上全部亲测复现；聚焦 26/0/0、全量 796/0/30 文件、typecheck 0、biome 触及文件 0 新增、活库 RLS/授权矩阵/CHECK 与交付声明一致、变异重放 3/3 按实现者清单 killed、交付哈希 8/8 == after-hashes-final、清理真实执行。findings 无 critical/high：2 medium（均为证据链/档案卫生，非代码缺陷）、2 low。

## Findings

### F1（medium，证据链）——「两版本差异=surfaceOf 死代码移除」定性不可验证，且终态仍含死代码

brief 要求核实 after-hashes.txt（support/oauth-state.ts=86280a40…，中途版）与 after-hashes-final.txt（a0d204a7…，终态版）差异确为 surfaceOf 死代码移除、零语义漂移。**核查结果：该 diff 无法执行。**

- 中途版（86280a40）内容未存档于任何处：实现树 i12-mt028 与复审树携带的均为终态 a0d204a7；checkpoints 内无任何中途副本（mutation/module-baseline.sha 只覆盖服务模块）。
- 存档内可观察的痕迹指向另一番景象：`verification/17-true-final.txt` 的 biome 段含 `tests/multitenancy/support/oauth-state.ts format` 诊断，而 `03-biome-write.txt` 存有 biome --write 修复过程档案，`18-true-final2.txt` biome 段该诊断消失。即：至少一部分中途→终态的变化是**格式修复**，与「死代码移除轮」的单一归因不符。
- 终态文件仍含 `export function surfaceOf(resolution)`（第 290 行），全仓零调用点（测试用内联 `JSON.stringify`），其文档注释声称「canary leak-scan 使用」与事实不符——**交付中仍存在死导出 + 失实注释**（若死代码移除轮以此为目标，则移除不彻底；见 F2 单列）。

缓解：终态树本身被本复审端到端独立验证（哈希冻结、26 用例、迁移重放、变异重放），最终交付物的完整性不依赖该定性成立。定性本身按「未证实」处理。

### F2（low，代码质量）——交付文件含零调用死导出 `surfaceOf`

`server/tests/multitenancy/support/oauth-state.ts:290` 的 `surfaceOf` 在 server/ 全域零调用（唯一 import 方 oauth-state.test.ts 只取 `createOAuthStateFixture`）；canary 扫描在测试内以 `JSON.stringify(denied)` / `JSON.stringify(event)` 内联实现。死代码 + 注释失实（test-support 文件，无运行时影响；judgement call，非硬违规）。交 coordinator 裁定是否随修复轮清理。

### F3（medium，档案卫生/D5）——17 号档案自相矛盾，声称保留的无效证据不存在

实现披露 D5 称：「surfaceOf 死代码移除后的首跑误用了已销毁容器（连接失败，52 fail）——该档案作废并在 17-true-final.txt 原文保留背景说明」。**核查结果与叙述矛盾：**

- `17-true-final.txt` 内容是一套**完整通过的复跑**（focused 26/0/0、全量 796/0/10811 expects、typecheck 0、biome 6 发现含 support format 诊断），并非连接失败现场。
- 全 checkpoints 检索无任何 `ECONNREFUSED` / `52 fail` 证据——被声称「原文保留」的作废档案实际不存在。
- 按档案内容可复原的真实时间线：17 = 重建容器后的首次有效复跑（其 support format 诊断证明摄于 biome --write 之前，亦与 after-hashes 双版本的先后关系互证）；18 = 修复后的干净终态复跑。两者均为通过态，**对正确性无影响**；但档案头对其自身内容的描述失实，属于本工作流点名的「声称与存档不符」类卫生问题（本次是「声称保留 X，实际保留 Y」变体）。

### F4（low，报告准确性）——报告/journal 引用过期 planDigest，所引「migration-fix 记录」不存在

`reports/MT028.md` 与 `verification/00-env-setup.txt` 记 MT028 planDigest=`589616954be9…`；本复审在全新容器重放 15 任务链，实测当前 planDigest=`47d8eac9…`，与存档 `migration-gen/manifest.json` 一致，且重放的 0001/0002 SQL 与 checkpoint 存档**逐字节相同**（diff 为空）。即引用值是被后续语句修订（row-shape CHECK 消费后保留 consumed_at 一线）取代的中间态。journal 所引「见 migration-fix 记录」文件在 checkpoint 中不存在。交付物自洽（存档 manifest=重放结果），仅报告引用值过期。

### 正面记录（非 findings，审计重点逐项回应）

1. **D1 缺失 state 双路径**：用例 7（无 attribution → `securityEventId` null、不落行、不臆造租户）与用例 8（显式 attribution → 事件落行、state 值不回显）亲测通过；`consume` 实现面确认双路径分叉点唯一（MISSING 分支内）。
2. **D4 超户 stand-in**：state 臂 RLS（SELECT/UPDATE 仅 `app.oauth_state` pin）活库核实；用例 25 亲测 operator 挂 tenant pin 后 `count(*)=0`（连 operator 都不可按公司枚举）；行读回走披露的专用超户连接，业务路径（initiate/consume/fail/事件读回）全程受限 operator。断言面与披露一致。
3. **D3 PKCE 延伸**：`codeChallengeFor` 与 `plugins/oauth.ts:168 challengeFor` 算法逐字符相同（sha256→base64url），verifier 生成同为 `randomBytes(48).toString("base64url")`；用例 1 钉死 `s256(binding.verifier)==initiated.codeChallenge`；verifier 只经 allow binding 五字段离开模块（键集断言用例 20），deny/事件 canary 扫描零命中（用例 18）。
4. **MUT-1 TOCTOU**：夹具 `serviceB` 为第二条独立 operator 连接（独立池 max:1），`Promise.all` 真并发；原子臂 `status='pending' AND expires_at>now()` 在 READ COMMITTED 下的行锁+重评语义保证恰一 allow（用例 11 亲测通过）。变异复放证明该杀灭不依赖时序：去掉 status 条件后即使完全串行，第二消费者也会对 consumed 行再 UPDATE 成功（谓词仍命中）→ 双 allow → 用例必 fail。
5. **D5 的实质正确性**：17/18 两套复跑均全绿且数字可解释（见 F3 与下方 expect 数说明），终态证据（18）与当前树一致。

## 复审门槛逐项证据（全部亲测）

| # | 门槛 | 结果 |
|---|---|---|
| 1 | `bun install --frozen-lockfile` | ✓ 1415 packages |
| 2 | 端口/容器/三库/七变量 env | 55535 空闲预检通过；`mt028-review-pg`（pgvector/pgvector:pg16，仅 127.0.0.1 + 随机口令）；主库 `openbot_enterprise_mt028r_test` + `_assigned`（MT003）+ `openbot_kb_mt028r_test`（属主 `ent_mt028r_kb` NOSUPERUSER NOBYPASSRLS）；七变量 env 0600（operator 类 URL 均为 `ent_mt028r_*` 登录，由 provision 授予恰一能力角色） |
| 3 | base migrate + 15 任务链 | `enterprise-test-db.ts migrate` ok；MT004→MT008→MT112→MT012→MT014→MT010→MT009→MT077→MT026→MT076→MT069→MT016→MT041→MT027→MT028 逐任务 `generate --out` + `migrate --apply --manifest` 全落账；MT028 重放 planDigest=47d8eac9…、SQL 与 checkpoint 存档逐字节一致（见 F4） |
| 4 | 聚焦/全量 | 聚焦 **26 pass / 0 fail / 0 skip**；全量 **796 pass / 0 fail / 30 文件**（10811 expects）。与实现数字精确一致；10811 vs 18 号档案 10808 的 +3 已定位为 MT003 real-apply 用例对全新 `_assigned` 库走 `applied` 分支的 3 条件断言（17 号档案同为 10811，18 因库已应用走 `up-to-date` 分支）——良性、两分支皆断言收敛，非漂移 |
| 5 | typecheck / biome | `tsc --noEmit` 0；本票 7 交付文件 biome 全 clean；`src/index.ts` 5 处（4×noConsole + 1×noNonNullAssertion，行 838/863/883/1895/4760）均不在 MT028 编辑区（import 行 279 + oauthState 块 1007–1019），零新增 |
| 6 | 活库抽查（psql） | `relrowsecurity=t, relforcerowsecurity=t`；3 策略臂正确（INSERT=tenant 臂；SELECT/UPDATE=state 臂，using+with check 对称）；授权矩阵=ob_ent_operator 仅 SELECT/INSERT/UPDATE，ob_ent_directory/ob_ent_data 零授权；7 CHECK（purpose/target/verifier/status/window/failed_reason/row_shape）+3 复合外键全部内嵌 tenant_id，均与交付声明一致 |
| 7 | 变异重放 ≥3 | **MUT-1** 丢 `status='pending'` → 1 fail（并发双消费用例，与清单一致）；**MUT-4** 原版（crossScope 恒 false + binding 改用 claimed）→ 4 fail（与清单一致）；**MUT-5** 事件 INSERT 短路 → 14 fail（与清单一致）。每次注入→聚焦→恢复→sha256==冻结值 c9114fa9…→聚焦复绿 26/0。附注：复审者先试过单点变体（仅 binding 改 claimed、保留比对）→ 26 全绿，为**等价变异体**（allow 路径上比对已保证 claimed==row，单点变异不可观测）——恰为消费预检+原子臂+持久行三重纵深的佐证，非测试空洞 |
| 8 | 边界核对 | after-hashes-final 8/8 文件 sha256 逐项 == 当前树；4 个授权编辑点（schema barrel / migrate-test.ts / allowlist / src/index.ts）现值均 ≠ before-hashes（确有编辑）且 MT028 追加区已逐一读回核实（barrel 排序位、OAUTH_STATE_TASK 15 任务注册、ruling #5 第 13 次注释、oauthState fail-closed 装配含 `.catch(()=>null)`）；实现树与复审树 server/{tests,src,scripts} 全量 diff 为空（边界外零改动强佐证）；`git show f0520524:server/src/index.ts` 无 oauthState（装配确为本票新增） |
| 9 | 清理 | `docker rm -f mt028-review-pg` 真实执行（回显 `mt028-review-pg`），deletion check=0；env/口令/journal/冻结副本临时文件全部删除（ls 确认不存在） |
| 附加 | 负向 skip 语义 | 移除全部 env 后聚焦套件 = **0 pass / 26 skip / 0 fail**（显式 skip 带理由，skip 不计通过）✓ |

## 交付物核对清单

新文件 4：`server/src/db/schema/enterprise-oauth-state.ts`、`server/src/enterprise/tenancy/oauth-state.ts`、`server/tests/multitenancy/oauth-state.test.ts`（26 用例=6+6+5+5+4，与报告一致）、`server/tests/multitenancy/support/oauth-state.ts`。授权扩展 4：barrel 追加、migrate-test 第十五任务（0001=5 语句、0002=7 语句，与 manifest 一致）、allowlist "MT028"、src/index.ts oauthState 装配。8/8 哈希 == after-hashes-final.txt。

## 遗留给 coordinator

1. F1/F3：是否要求实现方补齐中途版内容存档、更正 17 号档案头部描述（或注明实际时间线）、补 archive 缺失的 52-fail 证据说明。
2. F2：`surfaceOf` 死导出是否随修复轮删除（或让 canary 用例真正调用它）。
3. F4：报告/存档中过期 planDigest 与缺失的 migration-fix 记录是否补正。

复审者未做任何修复；本报告为唯一产出文件。

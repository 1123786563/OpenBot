# V01 终审报告 —— server + shared 域（S01–S04、U02、L01–L02、D01、R01–R02+R02-F1）

- 审查人：V01 分域 reviewer（只读；唯一写入为本报告）
- 日期：2026-10-21
- 对象：BASE `3b4a7c68132c3507300408346a44fb9d56f3c14c` → 当前工作树全量未提交增量中 `server/` 与 `shared/` 域（tracked diff + untracked），跨任务集成视角
- 方法：全量 diff 逐文件对照各 brief owned_files 与 Spec §2–§7；三层/两层叠加文件（store.ts、schema.ts、audit.ts）逐语义层核对；I1–I5 契约两端比对；秘密边界全局 grep；抽查 11 组套件实跑复现；typecheck/format 独立复核

## 1. 任务间交互与共享文件叠加

### store.ts（U02 + R02 + R02-F1 三层）
- U02 层：4 个个人可自助分支（无账户×2、排队中断开、撤销）经 `connectAppRefusal` 携带结构化提示；Shared/部署 arm（holder=deployment、部署凭据缺失）保持原 plain sentence——与 brief 分支映射表及 Spec §4"缺 Bot grant、管理员配置、共享账户不改写"逐条一致。正例/负例断言在 `plugin-user-credential.integration.test.ts`（:599 起的 THE PROMPT INSIDE THE REFUSAL 段与 :411 管理员 arm）钉住，16/16 实跑复现。
- R02 层：`deploymentTokenHeader`（三态：undefined=默认 Authorization）在 listTools 与 callTool 两路传 tokenHeader；`mcp.ts` 对 vendor header 按存储原样发送（仅 trim、不加 scheme），默认分支保留 `authorizationHeader` 既有 scheme 处理——Exa `x-api-key` / Firecrawl 默认 Authorization 与 R01 catalogue 声明一致。
- R02 新增拒绝（keyed provider 无 key → `PluginRefusedError`，store.ts:~1890）为部署级失败，**不带** connect prompt，与 U02 语义不冲突；位于 `connectionTokenFor` 内，list 与 call 两路同受保护；测试钉子在 `plugin-store.integration.test.ts:8646`（"a keyed provider with no key sends nothing at all"）。
- R02-F1 层：技能保存校验 `unknown = declared.filter(ref => !known.has(ref) && researchRoleOf(ref) === null)`——角色 ref 免查库、真实 `serverId/toolName` 仍严格查库、错拼/空角色/多斜线仍拒。与 R02 selection 展开语义（声明×实际授权求交）闭合：保存通过但无授权时交集为空，无授权放大。
- 三层叠加后 147/147（`openbot_r02_test` @5435）实跑复现，无相互破坏。

### schema.ts（L01 + L02 两层）与 audit.ts（L02）
- 净效果与 I3 契约逐字段一致：`SignInFillInput` 无 `code`（L01 加、L02 删的 Deprecated 字段已清干净，全树无残留读取——grep 证实唯一 `input.code` 命中为新 `parseSignInCode`/`submitCode` 合法路径）；`SignInFillResult.codeRequested?` 兼容可选；`SignInCodeInput/Result` 与契约形状逐字段相同；gateway `signInCode` POST `/sign-in/code`，与 signIn 同授权边界（`authorisation.ts` 将 `/sign-in/code` 加入 ACTING_PATHS，人工持轮时拒绝）。
- 双向兼容成立：旧 Computer 不报 `codeRequested` → 服务端可选字段缺省视为 false（schema 注释明示"never as a code step to guess at"）；新 Computer + 旧 server 多余字段被忽略。
- audit.ts 仅 +3 行（`computer.sign_in_code_requested` 事件类型 + 注释），符合 brief"最小增量"约束。

### service.ts（L02 状态机）与 brief 状态表逐行核对
- pending→filling CAS（120s lease）✓；filling→code_required（清 fillingUntil、不调 resolved、不恢复 Bot）✓；code_required→filling 仅经 `submitCode` CAS ✓（`fill` CAS 起始态仅 `["pending"]`，code_required 下密码提交被 409 拒绝——状态链无法旁路）；code 错→code_required、回密码页→pending（method:null）✓；signed_in 走既有 resolved 终态机制 ✓；取消/到期经 OPEN（含 code_required）✓；lease 到期由"回 pending 重放"改为 `failed`+UNKNOWN_OUTCOME（BASE 误重放路径已移除）✓；不确定结果经 `landUnknown` CAS 落 failed，`ComputerUnreachableError` 仅在 `provablyNeverReached` 时抛出（client.ts:98,325），分类语义真实 ✓；两并发 code 提交一 CAS 成功一 409 ✓；迟到响应不覆盖终态/不保存密码/不恢复 agent（全部 CAS 保护，失败即 throw，无副作用）✓。

### I1–I5 契约两端
- I2：`shared/connect-prompt.ts` 单声明双端读（server 写 / app transcript 读同一常量），codec 边界（256/200/4000/8192、对象括号平衡扫描、surrogate 安全 clamp）与计划 I2 参数一致。
- I3：见上；OpenBot 路由 `POST /api/sign-in-requests/:id/code`（code required max 64）与 Computer `POST /sign-in/code`（agent-computer 侧 64 上限独立校验）一致。
- I4：六 key×工具名表与 catalogue 条目一一对应（`research.ts` RESEARCH_TOOLS 键=catalogue key，drift 由 plugin-catalogue 测试互锁）；`researchRoleOfTool`/`researchRoleOf` 签名与计划一致；消费端 selection/tools/store 各自带 typeof/slash 守卫（R01 reviewer 的 watch item 已闭环）；app 侧 tool-name.ts/skills/form.ts 引同一 shared 模块。
- I5：`checkModelAvailability`/`reportIntelligenceEntitlement`/`StartupCheckResult` 与计划逐字段一致；`officialModelMetadataLookup` 只出 `{status}`、key 封闭在 closure、body 不读；index.ts +54 行纯追加、零 top-level await、log 限一次、兼容端点不传 lookup（404 不错杀）。
- I1 为 app 域内部契约，本域无生产者。

## 2. 孤儿与越界

- server/shared 域全部 33 个 tracked 修改 + 11 个 untracked 文件逐一映射到 brief owned_files：**无未认领的生产代码改动**。`server/src/passwords/resume.ts` 属 L02 owned 但无需改，未动（符合"只改实际用到的入口"）。
- U03-W1 事件残留：13 文件 `git diff` **零残留**；multitenancy 61 文件全部 bun-test-compat（0 个 e2e-compat）；`node scripts/e2e-coverage-audit.mjs` exit 0（1061 suite、568 native/478 driven、named exclusions 齐全）。还原+登记处置确认完成。
- `plugin-routes.test.ts:2912` 出现"deployment's API key"字样经查为该测试自造 PluginRefusedError 的注释，与 R02 新拒绝无耦合，且该文件未修改——排除。
- **F-1（见 §5）：`e2e.unit.config.ts` 的 agent-langgraph history.test.ts 收集失败排除——无 brief 认领、ledger 未登记，是本域唯一发现的越界项。**

## 3. Spec §2–§7 矛盾排查与秘密边界

- §2：S01 hostname 空判 public（`if (!bare) return "public"`）、S02 参数规则（含 Ruling S02-F1 的 mysql 大小写裁决分歧，已记录）、S03 per-part charset + 单次引用解码 + plain text 不解码、S04 仅 describeCron 去重——全部落实，无未裁决冲突。
- §4：服务端拒绝携带提示仅作展示、connect endpoint 重验证（plugin-connect-route 5/5 实跑）——一致。
- §5：状态机、并发 CAS、终态/迟到/重启安全、秘密边界（code 不落库/不进日志/不进审计载荷，失败消息经 `scrub(msg,[code])`、审计仅 `verificationCode:true` 布尔、service 三处 log 调用均无凭据）、0165 仅扩充 check constraint 本地编号、发布顺序与回滚排空为 runbook 约束且迁移注释明示——一致。
- §6：3s 预算真取消（AbortSignal + race 双保险）、未启用不探测（entitlement 门在 `learningCanCreate`）、兼容端点 skipped、不旁路虚拟 Key——一致。
- §7：求交语义、fail-closed 分类（readTools 存在即白名单，不在即 write，列在 column 之前）、旧 Parallel 兼容、缺 key/撤权/超时分别真实显示、不自动换供应商（guidance 明示"routing around it is the one thing this guidance must never suggest"）、credits/token 计费边界（.env.example 明示无 provider 环境变量、`OPENBOT_LIVE_RESEARCH=1` 为唯一测试门槛且 `test.skipIf(!key)` 落实）——一致。
- 秘密边界全局 grep：code/password/token/key 在新增路径的流向逐一检查——code 仅存于 enterCode 参数与单次 gateway 请求体；R02 token/header 仅进 MCP 请求头，mcp.ts/transport.ts 无日志同现；D01 key 封闭于 lookup closure。**未发现泄漏路径。**

## 4. 回归抽查实跑（V01 亲跑，非转抄）

| 套件 | 层 | 结果 | 与记录一致 |
|---|---|---|---|
| plugin-store.integration（openbot_r02_test:5435） | driven+DB | 147/147 | ✓ R02 |
| plugin-user-credential.integration（同库） | driven+DB | 16/16 | ✓ U02 |
| passwords-store.integration（openbot_l02_verify:5435） | driven+DB | 3/3 | ✓ L02 |
| passwords-sign-in + computer-sign-in-code | native | 36/36 | ✓ L02/L01 |
| enterprise-controls / otel-export-scrubbing | native / driven | 58/58；1/1 | ✓ S02 |
| shared/research + plugin-catalogue | native | 13/13；63/63 | ✓ R01 |
| config+responsibility-triggers+routine-schedule+D01×2+parallel-research | native | 266/266 | ✓ S01/S03/S04/D01/R02 |
| plugin-connect-route + plugin-mcp-authorization | native | 16/16 | ✓ U02/R02 |
| web-research | native | 11 pass + 2 skip（真实 key 门槛，显式原因） | ✓ R02（2 例 live 联调维持 BLOCKED 登记） |
| e2e-coverage-audit | 审计 | exit 0，no gaps | ✓ |

- typecheck：server 仅剩 bootstrap-local-gateway.ts 106/108/120 四条 TS2339——与 ledger 登记的 BASE 红逐一吻合，无新增。
- format：23 个 server/shared 改动文件中 21 个干净；config.ts 为已登记 BASE 脏；gateway.ts 的 format 脏经 BASE 副本对照确认为 revoke 签名行 **BASE 既有**（非本批新增行）。所有新增行 format 干净。

## 5. Findings

### 本轮须修（交主控处置，不由 reviewer 修改）

- **F-1（Medium，过程完整性）**：`e2e.unit.config.ts:116-118` 将 `agent-langgraph/tests/history.test.ts` 从 native 收集排除（注释"收集失败暂被排除，见 scripts/e2e-collect-triage.mjs"）。该文件不在任何 brief owned_files，ledger §5/§7 均未登记此改动。时间线定位：首次出现在 L02 before 检查点（即 U03-W1 处置或 L01 执行窗口进入）。根因已实证为**环境性**：worktree 未安装 agent-langgraph 依赖（triage 脚本输出 `@langchain/anthropic … is not installed: run bun install`），与 V01 brief"desktop 包需先 bun install"同类；排除本身有 triage 工具与 audit named-exclusion 背书，但 (a) 其 /tmp 台账易失，(b) 它使本 worktree 的 `test:ci` 静默少收集 1 个 suite。处置建议：ledger 补登记本条改动及理由；V-ALL 前对 worktree 补 `bun install` 并验证移除排除后收集干净，或带证据将该排除正式登记为环境性基线约束。

### V01 台账记录（不阻塞）

- **F-2（Low）**：R02 真实 key live 联调 2 例维持 BLOCKED（`web-research.test.ts` skipIf 门生效，mock 合约证据与真实联调证据已分离）——ledger 既有遗留，维持。
- **F-3（Low）**：U03-W1 处置后 multitenancy 等 13 文件归 driven 组，其执行在本地环境为**已登记基线红**（企业库 0163 三表 RLS/GRANT 需重放、store.ts:161 MT005 门槛）——属 V01 主流程步骤 2（企业回归）按 memory 配方处置的既有事项，本域确认登记状态与还原完整性，无新增。
- **F-4（Info）**：store.ts `deploymentTokenHeader`（三态 undefined）与 catalogue `tokenHeaderFor`（默认 "Authorization"）为语义孪生，注释已解释三态必要性；一致性由 integration x-api-key 用例钉住。
- **F-5（Info）**：selection.ts 与 tools.ts 各持一份 `roleOfHeldRef` 守卫（有意 twin，注释声明共享模块不为此长第二入口）；漂移风险由 shared/research.test.ts 13 用例 + selection/tools 消费面测试覆盖。
- **F-6（Info）**：I3 的发布顺序（schema→兼容 Computer→API→UI、新入口最后开放）与回滚排空为 runbook 约束，代码兼容形态双向就位；上线前需按 L02 迁移演练证据执行。
- **F-7（Info）**：L02 fill 成功路径中，`codeRequested` 分支将 accepted password 的保存（saveTyped）置于 code_required 落库之后，保存失败抛 409 但不阻塞 code 步（测试钉住 passwords-sign-in.test.ts:852）——设计决策合理，记录备查。

## 6. 结论

跨任务叠加（store.ts 三层、schema.ts 两层、audit.ts 单层最小增量）语义一致、无相互破坏；I2/I3/I4/I5 契约生产者/消费者两端最终一致；全量 diff 无未认领生产代码；U03-W1 还原彻底；Spec §2–§7 无未裁决冲突；秘密边界干净；11 组套件实跑全部复现绿、typecheck/format 仅剩已登记 BASE 项。唯一 Medium（F-1）为测试基建登记缺口而非交付代码缺陷，须主控补登记并作环境处置。

Spec compliance: pass
Code quality: pass

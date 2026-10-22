# L01 独立 Review（Task L01 / AC A08 基础协议 / Issue #496）

- 审查者：独立 reviewer（只读；唯一写入为本报告）。日期：2026-10-20。
- 工作区：`.worktrees/upstream-openbot-update`。范围：L01 增量（7 改 + 1 新）；S01–S04/U01–U04 已验收文件与 ledger §7 Ruling U03-W1 已裁决的 13 文件基建事件不在范围。
- 材料：`evidence/l01/{brief,implementer-report,validator-report}.md`、`after-tracked.diff`、`sha256.txt`；事实源：Spec §5、ticket up08、实施计划 I3、上游参考 `evidence/upstream-sources/agent-computer/{sign-in,index,authorisation}.ts`。
- 方法：生产代码逐文件读全文（非仅看 diff）、两报告逐条交叉核对、全部关键声称独立复跑/复算，不采信任何未亲证的结论。

## 独立复核证据（本审查者亲跑）

| 检查 | 命令/方法 | 结果 |
|---|---|---|
| 浏览器全量 | `OPENBOT_COMPUTER_BROWSER=1 E2E_UNIT_SCOPE=agent-computer bunx e2e run … sign-in.test.ts` | 18 pass / 0 fail（真实 Chromium，22.88s） |
| CI 形态 | 同上去掉浏览器 env | 18 收集 / 15 skipped / 3 pass |
| server 新套件 | `E2E_UNIT_SCOPE=server bunx e2e run … computer-sign-in-code.test.ts` | 4 pass / 0 fail |
| 回归 ×3 | passwords-sign-in / authorisation / action-barrier（agent-computer scope） | 17/17、13/13、2/2 |
| typecheck | `agent-computer` tsc --noEmit；`bun run --filter server typecheck` | agent-computer exit 0；server 仅 bootstrap-local-gateway.ts 3 条 TS2339（台账预登记 BASE 红），L01 文件零报错 |
| format | `bunx biome format` 7 个 L01 文件 | exit 0；gateway.ts exit 1 且 HEAD 版本落 /tmp 同 exit 1（BASE 既有漂移独立证实，非 L01 引入） |
| 对账 | `node scripts/e2e-coverage-audit.mjs` | exit 0，1056 文件 / 564 native / 477 driven，no gaps |
| 上游对齐 | `diff` 本地 sign-in.ts ↔ upstream-sources 版 | **仅差 1 行注释**（:79 本地新增说明句），其余逐字一致——validator 声称独立证实 |
| 路由对齐 | diff 本地与上游 index.ts `/sign-in/code` 路由 | 行为逐行一致，本地仅 JSDoc 更详尽 |
| RED 逻辑 | `git show HEAD:…` 查导出 | HEAD sign-in.ts 0 处 `fillSignInCode`/`parseSignInCode`；HEAD gateway.ts 0 处 `signInCode` → 报告的两种 RED 形态是 BASE 状态的必然结果 |
| 所有权纪律 | 对 40 文件 tracked diff 全量指纹扫描（signInCode/sign-in/code/SignInCode/codeRequested） | owned 8 文件之外零命中；e2e.unit.config.ts 树内改动为 agent-langgraph 排除项（他任务）；`server/src/passwords/` 对 HEAD 零 diff；e2e-bun-suites.json 零 computer-sign-in-code 引用 |
| fake 盘点 | grep 全部含 ComputerGateway 的 server 测试 | 仅 passwords-sign-in 与新套件提及 signIn，其余全为 0——与两报告一致 |
| sha256 | 抽验 gateway.ts 现树哈希 | 与 `sha256.txt` 登记一致 |

## Spec compliance（§5 第 1–2 条为 L01 主责，第 3 条属 L02；I3 合约）

1. **初次密码提交不问/不输 code；旧客户端 code 被忽略** — 通过。agent-computer 类型删 `code`，`parseSignInFill` 不读取（:78-79 注释明示，旧服务端随密码携带的 code 静默忽略不报错，测试钉 parse 结果恰为 `{origin, password}`）；`fillSignIn` 无任何初次提交 code 输入路径（"code 字段紧邻密码也不在首次提交输入"用例钉住密码单独提交）。server 侧 `code?` 保留为 Deprecated（偏差 1）：`passwords/service.ts` 仍发送而该文件属 L02，删除即断树；行为恰是 §5"旧客户端 code 被忽略"，无分歧。
2. **codeRequested 仅实测可见字段** — 通过。仅 `markCodeField` 在已验证 origin 命中可见字段（或 2s grace 重查命中迟到的字段，2.5s 迟到用例实证走过该路径）才为 true；code 字段先于密码字段检查（防站点把 OTP 画成 password input）；`passwordVisible` 排除被标记为 code 的字段。兼容方向正确：computer 侧必填（本进程总报告）、server 侧可选（未重部署 computer 缺省按"未要求"，同 `ScreenshotResult.url` 先例）。`codeRequested=true` 时 `passwordFieldVisible` 强制为 false，在协议层编码了 I3"密码表单已离开"条件，供 L02 消费。
3. **私有 code 入口沿用全套屏障** — 通过。`POST /sign-in/code`：token 401 门（dispatcher :751-758，`/sign-in/code` 不在 isOpenPath）、botId 400 门（:768）、人工控制屏障（:803 `actsOnTheComputer`，ACTING_PATHS +3 行）、`currentPage(botId)` Bot 隔离——全部**复用** dispatcher 现有守卫而非复制，与 `/sign-in/fill` 同模式。gateway `signInCode` 同 `post` 族、同 `SIGN_IN_BACKSTOP_MS`（75s）、同 signal 透传、无 audit row（测试钉成功与 502 均 0 行）。origin：跨 origin（about:blank 与第二真实 origin 双测）明确拒绝且不输入；code 步被移到其他 origin 的站点不被跟随。有效期：请求级租约/状态机属 L02，L01 协议半部以同 signIn 的 75s backstop 兜底，恰当。
4. **验证码不成为模型工具参数** — 通过。`COMPUTER_TOOLS`/`COMPUTER_ACTING_TOOLS` 零改动（diff 证实）；headless-tools.ts 零 diff；`computer_request_sign_in` 仅 `{site, reason?}`。
5. **输入值不回传/不落库/不入日志** — 通过。route body 读取一次即弃；结果仅含布尔/url/固定句式 error；`typeSecret` 打 SECRET_ATTRIBUTE 掩码；测试断言 `JSON.stringify(result)` 不含 CODE/PASSWORD；server 测试钉错误消息不含 code。
6. **字段上限 64 沿用既有惯例** — 通过。`parseSignInCode` 65 拒/64 过（边界双测）；先例为 BASE 既有 `passwords/routes.ts:117/:136` 的 `field(body, "code", { max: 64 })`。

## Code quality

1. **上游行为对齐**：sign-in.ts 与上游逐字一致仅多一行注释（独立 diff 证实）；index.ts 路由、authorisation.ts ACTING_PATHS 增项与上游同位同风格。validator "仅差一行注释"的声称属实。
2. **parseSignInCode 风格一致性**：与 `parseSignInFill` 同构（JSON body 检查、origin 检查同句式、错误全部固定句式无插值）。风格统一。
3. **守卫复用质量**：新增端点通过"加入 ACTING_PATHS 集合"被既有 dispatcher 守卫接纳（authorisation.ts 注释所述设计意图），未复制守卫逻辑；路由体与 fill 的 7 行同构也是上游原样。
4. **markCodeField 启发式收窄**：去 `token`、增 `passcode`/aria-label、name 启发式排除 password 型（仅 autocomplete=one-time-code 可命中 password 型字段）、可见性收紧（computed style/readOnly）。取舍合理：`codeRequested` 将成为 L02 code_required 迁移条件，假阳性会把请求错导；与上游逐字符一致。
5. **测试基建修复限定性**：`boundPort` 轮询与文件头注释修正均在 owned 的 `agent-computer/tests/sign-in.test.ts` 内；e2e.unit.config.ts 树内改动经查与他任务无关，L01 未触碰共享基建。
6. **测试覆盖**：18 用例覆盖正确/错误 code、回密码页、DOM 消失、迟到字段、跨 origin 双形态、64 边界、旧客户端忽略、值不回读；server 4 用例钉 endpoint/头/body 形状、0 audit、预中止、拒绝透传。

## Findings

| # | 严重度 | 内容 | 处置 |
|---|---|---|---|
| R1 | minor | `server/tests/passwords-sign-in.test.ts` 的 `signInCode` fake 注释称"records the submission"，但实现忽略 `_input`、未记录任何数组——注释与行为措辞不符（无行为影响：被测 service 尚不调用该方法） | 记录在案，可随 L02 顺带修正 |
| R2 | minor（沿 M2，复核成立） | RED 运行输出未存档（evidence/l01 无 red-run 文件）；本审查已按 BASE 状态独立重建其必然性（HEAD 零处新导出），结论不受损 | 维持 validator 备注生效；后续任务建议留 red-run 文本 |
| R3 | minor（沿 M3，复核成立） | 实施报告 §3 引 action-barrier 2/2 未标 scope（实为 agent-computer scope，本审查按该 scope 亲跑通过） | 记录在案 |
| R4 | info | M1 交接闭环**已确认**：L02 brief owned_files 现含 `server/src/computer/schema.ts`（限删 Deprecated `code` 字段，service.ts 移除发送并全树 typecheck 过后执行）——validator 提出的孤儿删除义务已有归属 | 无需跟进 |
| R5 | info | gateway.ts biome format exit 1 为 BASE 既有漂移（HEAD 版本同红，:909 revokeControl 参数处）；server typecheck 3 条红为台账预登记 BASE 项。均非 L01 引入，登记正确 | 无需跟进 |

未发现 blocker 或 major。实施与验证两报告的关键声称（上游 diff 仅一行注释、fake 盘点、归层结论、no gaps、typecheck/format 基线红归属、sha256）经独立复核全部属实；越权扫描（owned 之外零指纹）确认范围纪律。

## 判定

L01 通过独立 review。质量关口放行，可进入 L02（注意 R1 顺带项与 M1 已闭环的删除义务）。

Spec compliance: pass
Code quality: pass

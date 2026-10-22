# L02 验收报告（backend_validator）

- 验证人：backend_validator（只读验证；仅写入本报告）。
- 日期：2026-10-20。工作区：`.worktrees/upstream-openbot-update`（HEAD `3b4a7c68132c3507300408346a44fb9d56f3c14c`，分支 `upstream-openbot-update`）。
- 结论：**验收通过（6/6 PASS）**。零阻塞问题；2 条 Minor 备注（见 §8），均已核实为 BASE 存量或环境限制，不影响验收。

## 0. 环境（验证者亲验）

- `openbot_l02_verify`（:5435，主控预建）：`drizzle.__drizzle_migrations` **166 行**；`sign_in_requests_status_check` 为 **8 态**（含 `code_required`）；表列清单无任何 code 列。凭证未写入本报告。
- 对照事实：`.env` 默认 `TEST_DATABASE_URL`（:5435 旧库）仅 163 条迁移、7 态约束——用默认库复跑 integration 得到 **23514 check constraint 红**，与实施报告 RED 声明一致（迁移确实在做事，verify 库 3/3 绿不是碰巧）。

## 1. 状态机 — PASS

**亲跑命令与结果**

| 命令 | 结果 |
|---|---|
| `E2E_UNIT_SCOPE=server bunx e2e run --config e2e.unit.config.ts server/tests/passwords-sign-in.test.ts` | **28 passed / 0 failed**（1 文件） |
| `TEST_DATABASE_URL=…5435/openbot_l02_verify bun test ./server/tests/passwords-store.integration.test.ts` | **3 pass / 0 fail**（27 expect） |

**brief 8 行状态表逐行测试证据（均已亲读测试源码核实）**

| # | 行 | 测试证据 | 结论 |
|---|---|---|---|
| 1 | pending→filling CAS 120s | `fill()` 先校验后 `transition(from:["pending"])`，`FILLING_LEASE_MS=120_000`（service.ts:79）；原 17 用例全绿 + integration 用例 1（filling 期间第二次 submit 拒 "already being entered"） | 有证据 |
| 2 | filling→code_required 清 lease、不恢复 agent | "moves the request to code_required…"`：`fillingUntil===null`、`resolved===[]`、`computer.codes===[]`、`isFinalSignIn("code_required")===false`、pending 列表含它 | 有证据 |
| 3 | code_required 显式提交 CAS + L01 gateway | "an explicit code is typed…"（`codes===[{origin,code}]`、trim 生效、resolved [signed_in]、audit `verificationCode:true`）+ integration 用例 3（真库 signed_in、method 存留）+ `enterCode` 仅从 `["code_required"]` CAS | 有证据 |
| 4 | 错 code 可显式重试 | "a wrong code keeps the request at the code step…"：仍 code_required、`codes` 恰 1 次＝无自动重发、显式重试后 2 次并 signed_in；audit step:"code" | 有证据 |
| 5 | 回密码页→pending | "a site that goes back to its login page…"：pending、`method===null`、整段重登成功 | 有证据 |
| 6 | 完成→signed_in 现有终态机制 | 显式 code 用例 resolved [signed_in]；`resolved(done)` 复用现有机制；**resume.ts 零改动**（before/after diff 均无此文件） | 有证据 |
| 7 | 取消/到期拒输入 | "a code is only taken from…"（pending 拒 / cancel 后 "no longer open" / stranger 404 / 空 code 拒）+ "an expired request closes itself" + integration failed 后 submit 409；`OPEN=[pending,code_required,taken_over]` 覆盖 code 步 | 有证据 |
| 8 | lease 到期/结果不明→failed | "an attempt whose lease ran out is failed as unknown, never silently reopened"：failed + "not known whether" + resolved [failed] + 再 submit 409 + `fills===[]`；**旧行为反向钉死成立**：before-tracked.diff 含旧测试 "an attempt that never finished opens again once its lease has passed"（断言 `pending`），after 中该测试已删除并由此测试取代（diff 对比亲核） | 有证据 |

## 2. 并发/迟到/重启 — PASS

- **两并发 code 提交仅一 CAS 成功（409）**：native "two racing code submissions end with exactly one"（gate 持住第一个，第二个拒 /already being entered/＝SignInRefusedError 409，`codes` 恰 1）+ integration 真库 `Promise.all` 双 `transition(["code_required"])`，断言恰一非空。
- **cancelled/expired 迟到响应**：native "a late code response…"（cancel 后 letGo → inFlight 拒 "changed while it was being entered"、终态保持 cancelled、`resolved===[]`、无 completed audit）+ "a late password response…"（expired 保持、`logins===[]` 不存密码、`resolved===[]`）+ integration cancelled 用例（终态保持、audit 不含 CODE）。
- **service 重启零 gateway 调用**：native "a restart restores state and types nothing until the person acts"：第二实例 `get` 恢复 code_required、pending 可见，`second.fills===[]` 且 `second.codes===[]`，显式 submitCode 才调用一次。

## 3. 迁移与约束 — PASS

- `server/drizzle/0165_sign_in_code_step.sql` 全文仅 2 语句：`DROP CONSTRAINT "sign_in_requests_status_check"` + 同名 `ADD CONSTRAINT … IN (8 态)`；无列变更、无数据改写。
- **fresh/upgrade 演练库亲验**（:5433 docker openbot-test-pg）：`openbot_l02_fresh` 166 条迁移 + 8 态约束；`openbot_l02_upgrade` 166 条 + 8 态 + **2 行 sign_in_requests 旧数据保留**；`openbot_l02_fixture` 166 条 + 8 态。升级中间态 23514 反证由 §0 的默认库复现独立佐证。
- journal：`git diff HEAD` 仅追加 idx 165（`when=1792857600001`，紧随 0164 单调）；`git status server/drizzle/` 仅 journal 修改 + 0165 新文件；现存迁移零改动。
- `server/src/db/schema/passwords.ts` check 与 SQL 逐态一致（8 态，顺序相同）。

## 4. 秘密边界 — PASS

- **不落库**：`sign_in_requests` 无 code 列（对 verify 库 information_schema 亲验）；integration 断言库行 `JSON.stringify` 不含 PASSWORD/CODE。
- **不进日志**：路由 onError 对非 SignInRefusedError 只打 `error.name` + 固定 500 句；`enterCode`/`fill` 对 gateway error/url 一律 `scrub(…,[code])` 后才存储/审计。
- **审计载荷**：亲读 service.ts，sign-in 事件载荷仅 actor/bot/request/site/method/savedLogin/step("login"|"code")/failure(已 scrub)/verificationCode/reason 类别字段；audit.ts 增量仅 `computer.sign_in_code_requested` 一个类型。
- **旧客户端 code 忽略**：路由测试提交 body 带 `code: CODE` → 200，且 `expect(fills[0]).not.toHaveProperty("code")`；`submit`/`use-saved` 路由代码不读取 code 字段。
- **`POST /:id/code` 约束**：`field(body,"code",{required,max:64})`（65 字符→400）；pending 提前→409；cancel 后→409 "no longer open"；他人请求→404；响应 `not.toContain(CODE)`。owner/请求授权沿既有 owner 作用域约定，Bot 授权在创建路由 `canUseBot`（与既有 submit 路由同型）。
- **RequestView 排除秘密保持**：`SignInRequestView = Omit<record,"continuation"|"ownerUserId">`，record 本身无凭据字段；native `expectNoCredential`（PASSWORD+CODE 双值）扫 view/audit/存储行/AG-UI 事件/模型请求。

## 5. L01 交接义务 — PASS

- `SignInFillInput.code` 已删：`git diff HEAD -- server/src/computer/schema.ts` 显示删除 `code?: string` 及其 Deprecated 注释，仅余注释更新（见 R1）。
- 全树 typecheck 亲跑：server **仅 bootstrap-local-gateway.ts 106/108/120 三条 TS2339**（与台账 BASE 红逐一对应）；app exit 0、worker exit 0、**agent-computer exit 0**（L01 侧不再读取的直接证据）。desktop 因工作区未装依赖（node_modules 空、不在 bun workspaces）无法 typecheck——环境限制，且 desktop 全树零 `SignInFillInput` 引用、L02 未触碰 desktop/，非 L02 引入。
- R1 注释措辞修正到位：SignInFillInput 注释现为 "No code travels with the password: a code is typed after the site asks for one, through `SignInCodeInput`."

## 6. 范围 — PASS

- **diff-of-diffs 全量对账**（before-tracked.diff vs after-tracked.diff，逐文件）：L02 增量恰为 10 个 tracked 文件——types/store/service/routes/resume(零)/db-schema-passwords/audit/computer-schema(仅删 code+注释)/journal/两测试文件，加未跟踪新文件 `0165_sign_in_code_step.sql`；schema.ts 与测试文件的 before→after 内容增量逐行核对均在 owned 范围内；其余 **26 个在途文件 diff 逐字节相同**（含 `docs/verification/e2e-bun-suites.json`——L02 零改动声明成立）；`node scripts/e2e-coverage-audit.mjs` → **no gaps**。
- **resume.ts 零改动声明成立**：git status 不含它，两份 diff 均无此文件。
- **偏差（audit.test.ts 1 红＝BASE）核实**：亲跑 audit.test.ts → 7 passed / 1 failed，唯一失败 "declares nothing this deployment cannot write"，失败集恰为 19 个 `workshop.*` 类型、**零 sign_in 项**；`git show HEAD:server/src/audit.ts` 的 workshop 集合与当前逐一相同（33 行一致），且树中无任何 workshop.* writer、L02 十文件均与 workshop 无关 → HEAD 上同样失败。BASE 属性成立。

## 7. 实施报告偏差复核（1–9）

偏差 1/3/4/5/6/8/9 均与 brief/上游/测试证据相符，无异议。偏差 2（同步网关 throw 回 open 而非 failed）：`enterCode`/`fill` catch 后写回 code_required/pending 且清 lease，重试仅由人的显式提交发生（测试断言 `codes`/`fills` 长度不变）——不违反 8 行表第 8 行（该行钉的是在途/租约场景，已由 failed 测试覆盖），实现方已标"待议"，**建议编排者知情确认**，不阻塞本验收。

## 8. 问题分级

| 级别 | 问题 | 处置 |
|---|---|---|
| 阻塞 | 无 | — |
| Minor | `server/src/db/schema/passwords.ts:83` fillingUntil 注释 "the request reopens" 与新 failed 行为不符（HEAD 存量文本，L02 diff 未触及该行，仅 check 行变更） | 建议 L03 或收尾批次顺手改词，不阻塞 |
| Minor | desktop 包在本工作区无法 typecheck（依赖未安装的环境限制；零 sign-in 引用、L02 未触碰） | 记环境事实，非 L02 责任 |

## 9. 验证命令清单（validator 实跑）

```
E2E_UNIT_SCOPE=server bunx e2e run --config e2e.unit.config.ts server/tests/passwords-sign-in.test.ts   # 28/28
TEST_DATABASE_URL=…/openbot_l02_verify bun test ./server/tests/passwords-store.integration.test.ts      # 3/3
E2E_UNIT_SCOPE=server bunx e2e run --config e2e.unit.config.ts server/tests/computer-sign-in-code.test.ts # 4/4（L01 回归）
E2E_UNIT_SCOPE=server bunx e2e run --config e2e.unit.config.ts server/tests/audit.test.ts               # 7/1 BASE 红
bun test ./server/tests/passwords-store.integration.test.ts（默认 :5435 旧库）                            # 23514 复现（RED 佐证）
bun run typecheck（全 workspace）+ agent-computer/desktop 单独                                            # server 仅 3 条 BASE
node scripts/e2e-coverage-audit.mjs                                                                     # no gaps
bunx biome format <7 个 owned src 文件>                                                                  # exit 0
openbot_l02_verify / _fresh / _upgrade / _fixture 四库迁移数与约束                                        # 均 166 条 + 8 态
```

秘密卫生：本报告不含任何真实凭据；fixture 值均为测试内虚构常量。

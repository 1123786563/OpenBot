# Bifrost-5 Ledger（可恢复状态）

- Orca Run: `run_f470ca949934`（objective：Bifrost-5 实施 151 Ticket）
- 快照: `.omc/research/bifrost5/tickets.json`（151 票正文/状态/依赖，2026-10-16 摄取）
- DAG/波次/AC 映射: `docs/plans/2026-10-16-bifrost-5-dag.md`
- 计划: `docs/plans/2026-10-16-bifrost-5-implementation.md`
- 集成基线: 主 checkout `/Users/wuyongjun/trea/OpenBot`（main @ bab7c0b9 起，未提交增量累积；各 worker 子 worktree 名 `b5-<ticket>`）

## 票据状态

| 票 | 组 | 状态 | Task ID | Dispatch ID | Worktree | 检查点 | 备注 |
|---|---|---|---|---|---|---|---|
| #207 | 01.1 | **verified+integrated** | task_5749a47a5506 | ctx_ebf5528c37e6 + fix ctx_b5868d026992 | b5-207（已释放） | ckpt ✓ | F1/F2/F4/F6 修复复审全 CLOSE（reviewer 独立复验 [1,2]）；集成含 config.ts 三方合并（import 冲突手工解 + gatewayConfig 双实现合并为单函数统一 GatewayConfig 类型）+ 4 文件直复制；64/64 合并验证全绿；#208 解锁 |
| #209 | 01.3 | **verified+integrated** | task_8047fcd8feb2 | ctx_082fa912af1a | b5-209（已释放） | ckpt ✓ | review 通过（0 中高危/1 low 注释错位）；4 文件集成哈希全过 |
| #215 | 02.1 | **verified+integrated** | task_edf454823ae8 | ctx_6a95c7bcb7c5 | b5-215（已释放） | ckpt ✓ 复审版 | M1/L2 修复后复审通过（21/21×3）；7 文件集成；下游 #216/#217/#218/#290 解锁 |
| #216 | 02.2 | **verified+integrated** | task_063427f47b8a | ctx_18775224f825 | b5-216（已释放） | ckpt ✓ | review 通过（0 中高危/2 low）；3 文件自有增量集成 |
| #218 | 02.4 | **verified+integrated** | taskmap['218'] | ctx_d31166b64382 | b5-218（已释放） | ckpt ✓ | review 通过（0C/0H/0M/2L/3I，签名收敛裁决在授权范围内）；9 文件自有增量集成（config/journal diff 甄别为 209 同步层，跳过）；37/37 集成验证 |
| #211 | 01.5 | **verified+integrated** | task_708a7fabf2fb | ctx_6610743db459 前实现已结算（review ctx_186e85a611cc） | b5-211（待清理） | ckpt ✓ | review 通过（0C/0H/0M/2L/4I）；5 自有增量集成（probe.ts+2 测试+fake-gateway+计划）哈希 5/5；int4 库 migrate 后 169/169 集成域全绿 + 双 typecheck 0（1 次 flaky 重跑消失）；#212 解锁 |
| #234 | 04.1 | **verified+integrated** | task_8142899ca59b | ctx_998ae61aff46 | b5-234（已释放） | ckpt ✓ | review 通过（0 中高危/2 low）；22 直复制 + 迁移重编号 0123 + snapshot 合并（补 public.payer_accounts）+ journal 追加；集成层全量验证 73/73 + 双 typecheck 0；#235 解锁 |
| #235 | 04.2 | **verified+integrated** | taskmap['235'] | ctx_22b0951ca847 | b5-235（已释放） | ckpt ✓ | review 通过（0C/0H/0M/2L/6I）；集成含三方合并（app/audit/config/core/index/types/journal）+ 8 新文件；交互修复：#218 收敛签名后前置票 payer 测试适配版补齐 |
| （其余 144 张） | | pending | 已建 task 行 | | | | 票→task_id 映射：`.omc/research/bifrost5/taskmap.json` |

集成模型：无 commit 授权下，每票验收后 coordinator 将其 worktree 未提交增量显式复制进主 checkout 集成层；下游 worktree 创建后、worker 启动前，coordinator 先把集成层同步进该 worktree（含哈希核对），再 `worker-start --worktree <exact>`。

## 事件日志

- 2026-10-16 T1：Issue #5 + 151 票摄取；DAG 验证通过；Run `run_f470ca949934`；151 task 行建好。Wave 1 派发（全部 pi/ready）。
- T2：**4 速率限流事件**——glm-5.3 账户 429（4 并发超限），#207/#209/#234 agent idle。裁决：并发降至 ≤3，串行唤醒，不重派不丢工。#215 未受影响完成。
- T3：#215 全流程闭环（验证 18/18→审阅 1 medium→修复 M1+L2→复审 21/21×3 通过）→ 集成主 checkout（7 文件哈希全过，typecheck+21/21 复验）→ 释放终端。
- T4：#207 coordinator 验证 33/33 + review（Spec 合规通过、F1 high 实测复现首存竞态）→ fix-207 派发（F1+F2+F4+F6）。#209 验证 22/22 → review 运行中。#234 唤醒。

- T5：#209 review 通过（1 low 注释错位，记录）→ 集成 → 释放。#216 全流程闭环（review 0 中高危）→ 集成 → 释放 → #218 派发（20 文件同步）。
- T6：#234 question 裁决（允许填票据 Checkpoint 段，仅追加）；#234 完成（23/23）→ review 通过（2 low/2 info）→ 集成（0122→0123 重编号、snapshot 合并、journal 链修正）→ 集成层 73/73 全绿 + server/app typecheck 0 → 释放 → #235 派发（44 文件同步）。
- T6a：**事故记录**：集成库 URL 拼接错误（/openbot/openbot_b5_int1 双路径）导致 migrate 连接失败；核查 live openbot 库确认未受影响（无新表、110 基线迁移）。教训：TEST_DATABASE_URL 构造必须用 sed 替换末尾库名。

- T7：fix-207 复审通过（全 CLOSE，reviewer 独立复验并发 [1,2]）→ 集成（config.ts 与 #209 三方合并：import 冲突手解、双 gatewayConfig 合并为单函数、GatewayConfig 扩为 endpoint+conversionRate 统一块、删重复字段声明）→ 64/64 验证 → 释放 4 终端 → #208 派发（48 文件同步）。
- T8：#218 review 通过 → 集成（自有 9 文件；config.ts/_journal diff 甄别为同步层噪声，跳过）→ 37/37 → 释放 → #217 派发（57 文件同步，补上组 02 公司 payer 链）。
- 进度：verified+integrated = #207/#209/#215/#216/#218/#234（6/151）。运行中 = #208/#217/#235。
- T9：#235 集成（app/audit/journal/index/types 三方合并，config.ts 保 207+209 合并版；index.ts 重复 botServiceStore 声明收敛为 235 registry 版）；发现并修复跨票交互：#218 credits 签名收敛（PayerRef）导致主 checkout 旧版 payer 测试挂——用 #218 worktree 内适配版补齐 payer-account/payer-legacy 测试。全量 87/87 DB + 单元 + 双 TC 0。
- T10：#208 完成（29/29，含 coordinator 批准的枚举/迁移 0124/app 接线/审计事件 4 项越界）→ review-208 派发；#236 派发（66 文件同步）。#208 迁移撞号（与 235 同为 0124）→ 集成时重编号 0125。
- 进度：verified+integrated = 7（207/209/215/216/218/234/235）+ 208 verified 待 review。
- T11：#208 集成（含 4 项已批越界落点；枚举合并 gateway_admin+bot_service；journal 链 0122→0125）→ 102/102 全绿 → 释放 → #211 派发（72 文件同步）。#217 完成验证 13/13 → review-217 派发。#236 范围裁决（4 项批准，迁移号集成期统一重排）。
- 进度：verified+integrated = 8（207/208/209/215/216/217 进行中 review/218/234/235）。

- T12：#211 review 通过（双结论 PASS，2L/4I 备案）→ 集成（5 文件直复制哈希 5/5）→ 验证：新建 openbot_b5_int4 + migrate → 集成域 169/169（首轮 1 fail 复跑两轮均 0，判 flaky）+ server/app typecheck 0 → 释放 review 终端 → #212 派发（b5-212 worktree + 83 文件 sync_delta 0 mismatch + pi worker ctx_6610743db459）。#210（blocked_by=209 已满足）排队待并发空位。事故教训补充：bun 1.4 建库用 `new SQL(url)`（bun 模块），migrate 前需先建库再 `DATABASE_URL=... bun scripts/migrate.ts`，专用集成库命名 openbot_b5_int<N> 递增。
- 进度：verified+integrated = 10（即 207/208/209/211/215/216/217/218/234/235 共 10 张）。运行中 = #219/#236/#212。
- T13：**环境事件**：#236/#219/#212 三个 worker 终端全部异常停止（Agent process stop requested but never confirmed，疑似 Orca/宿主重启；与 memory 中子代理故障模式一致）。按 goal 指令 8 失联只算检查点不算失败：三个 worktree 死前进度盘点完成（#236：binding-codes/bot-binding/0125 迁移/测试等 13+ 文件；#219：payer-binding/payer-no-fallback 测试/copilot+index 5 文件；#212：计划+fake-gateway）。task 均回 ready，串行重新 worker-start 至原 worktree：#236→ctx_c8970a05cd53、#219→ctx_075ed2bbb7cb、#212→ctx_1af8aaf4953a，恢复简报已发（含各自死前进度清单与续做指引）。
- T14：#236 接续 worker 完成（ctx_c8970a05cd53）：10/10 本票 + 62/62 回归 + 双 TC 0 + lint 0，修复前序 4 缺口 + 1 生产缺陷（hint 超长静默截断→400），app.ts 挂载 POST /api/bot-service/binding-codes 于 04.2 服务守卫下；3 项基线遗留失败（0107/0073/0120 漂移、04.2 枚举致 schema.test 过期）按名记录于 .omc/reports/b5-236.md。coordinator 重跑验证：新库 openbot_b5_236v migrate 后 39/39 + 双 TC 0 + checkpoint 71 文件哈希 0 mismatch → 释放终端 → review-236 派发（task_f351b9aa64cc / ctx_1571577d5e80，主 checkout 只读）。
- T15：#212 接续 worker 完成（ctx_1af8aaf4953a）：capability-negotiation.ts（negotiateGatewayCapabilities/readLastGatewayNegotiation、AC04 configVersion 失效、X.Y.Z major=1、enterprise_settings 无新迁移）+ 25 单测 + 8 集成；顺带修复中断残留（fake-gateway 损坏注释块 + 失效导入重复测试文件），已甄别 #211 集成产物 3 文件哈希不变。coordinator 重跑：新库 openbot_b5_212v migrate 后 119/119（含 01.5 probe 回归）+ 双 TC 0 + checkpoint 85 哈希 0 mismatch → 释放 → review-212 派发（task_eb29d7f3eee7 / ctx_a58871553a0e）。
- T16：**基础设施事件**：宿主 PostgreSQL（openbot-postgres-1，OrbStack）进入崩溃-恢复循环（WAL redo 127s 完成后又 reinit）；同机另一 Run（opik）多 worker 并发 tsc 导致 CPU 过载（多任务假死）。应对：起独立验证容器 b5-verify-pg（pgvector/pgvector:pg16 @ 127.0.0.1:5590，openbot/openbot），后续所有 DB 验证迁至该实例，专用库名不变。
- T17：#236 集成完成：迁移 0125_bot_binding_offers→0126 重编号 + snapshot 合并（共同 prevId 0124，仅多 bot_binding_offers 表，干净合并）+ journal 追加（修 when 严格递增）。app.ts/audit.ts 因 merge-base 错序丢失 #208 gatewayAdminCredential 装配/事件 → 以 worker 版为底补回（import+装配块+2 审计事件）；registry/auth 直接采用 worker 版（binding-codes 组合）；schema/index + drizzle.config 加法冲突取 theirs。主 checkout tests/support/ 下两个坏副本 gateway-probe*.test.ts（中断 worker 残留，review-212 警告）已删除。验证：int5（临时实例）migrate + 全量 212/212 + 双 TC 0。#237/#220 解锁。
- T18：review-212 通过（双 PASS，2L/3I；限制：集成测试因 DB recovery 由 coordinator 集成后复验补齐 ✓、全量 tsc 因过载以范围化 0 替代 → 集成后已补 ✓）→ #212 集成（4 文件哈希 4/4 + 坏副本删除）→ 129/129 域内 + 212/212 全量。释放 review 终端。
- T19：#219 闭环推进：coordinator 重跑（219v 库 @5590：payer+credits 域 100/100 + 双 TC 0 + checkpoint 80 哈希 0 mismatch）→ 释放终端 → review-219 派发（task_42bedc98ced9 / ctx_6a4a1de7569b，简报含 5590 专用实例指引）。#237 派发（b5-237 + 89 文件 sync + ctx_921db44b7b72，含 review-236 下游提醒：多条 pending 消费语义归 04.4）；#220 派发（b5-220 + 89 文件 sync + ctx_2c8c7a503882）。
- 进度：verified+integrated = 12（207/208/209/211/212/215/216/217/218/234/235/236）。运行中 = review-219 / #237 / #220。待解锁：#238（差 #220）。
- T20：review-219 结论：Spec 合规通过 / 质量 B+（1 Medium F1 + 4 Low）。F1 有效（变异注入 gate 二次 reserve 后 23 用例仍绿，清单测试对 billing.externalCustomerKey 失明）→ 回派修复（fix-219 task_a49e9482d0de）。#237/#220 完成派发后运行中。
- T21：**第二次 Orca 重启**：fix-219/#237/#220 三个 worker 终端全部死亡（重启前均未完成；fix-219 heartbeat 至 investigating）。处置：worker-abandon 结清三 dispatch → task-update 回 ready → 同 worktree 重派（fix-219→ctx_51424e36abe0、#237→ctx_f31d7d145f32、#220→ctx_a15e5df746d9）+ 恢复简报（含各自死前进度清单）。worktree 死前进度盘点：#237 已有 hardening 计划+binding-codes 修改+集成测试；#220 已有 credits/routes/types 修改+personal-credits-read.test.ts。b5-verify-pg（5590）未受重启影响存活。
- T22：hiroute 上游 502（no upstream candidate）风暴：三个 worker 全部重试 3 次耗尽停摆；#220 的 dispatch 直接 failed。处置：#237/fix-219 send 唤醒成功；#220 abandon→ready→重派（ctx_59a99956a220）+ 接续简报。
- T23：#220 接续 worker 完成（ctx_59a99956a220）：三条个人读路由 + Credits.personalBalance + 契约，10/10（103 断言）+ 86 回归 + 双 TC 0 + lint 0，Proxy 计数零写入有数据库证明。coordinator 重跑：220v 库 @5590 域内 73/73 + 双 TC 0 + checkpoint 93 哈希 0 mismatch → 释放 → review-220 派发（task_478f5b760186 / ctx_cb631d8c4112）。
- T24：**第三次环境事件**：fix-219/#237 终端再次消失（terminal_missing，唤醒后无新进展）。task 自动回 ready → 重派（fix-219→ctx_4285ad7bfb5e、#237→ctx_e852d65483a3）+ 再接续简报。review-220 未受影响。
- T25：review-220 通过（Spec 合规 PASS / 质量 A-，F1 Medium=集成窗口风险非本票缺陷 + 2L/2Nit，reviewer 建议可集成）→ #220 集成：6 自有增量直复制哈希 6/6；F1 裁决=集成时同步防御（usage.tsx 7 处 optional chaining：plan 1 + rewards 6，消除过渡期 UI 崩溃）；F2=02.6 票 Checkpoint 已回填（含 manifest/验证/报告指针）。
- T26：集成回归发现 **#211/#212 测试时间炸弹**（2 fail 稳定复现）：'older completion never overwrites newer' 夹具用固定 12:00Z，前序测试残留真实时钟行使 setWhere 正确拒绝夹具写入（本机时间越过 12:00Z 后必红；生产 store 逻辑经最小脚本复现证明正确）。修复=夹具改 Date.now()±1h 动态时间戳（negotiation+probe 两文件），3 轮 17/17 稳定。修复记录：`server/tests/gateway-capability-negotiation.integration.test.ts`、`server/tests/gateway-probe.integration.test.ts`（测试基建修复，非生产代码）。
- T27：#220 集成验证：int6 @5590 全量 211/211（21 文件）+ 双 TC 0。**#238 解锁**（220+236 均已集成）。
- T28：#238 完成（ctx_b985edbf06e3）：access_grants 表（0127 手工组装沿 0126 链）+ 两步确认流 + 前端确认页/i18n/侧边栏 + 审计 model_access.*；13/13×5 连跑 + 邻居回归 + 双 TC 0 + lint 0 + vite build。coordinator 重跑：238v 库 @5590 72/72（含邻居）+ 双 TC 0 + checkpoint 105 哈希 0 mismatch → 释放 → review-238 派发（task_a4c5ac1984ec / ctx_5d9e51107da2）。运行中 = fix-219 / #237 / review-238。
- T29：review-238 双 PASS（0C/0H/0M/3L/4I，建议 04.7 顺带打磨）→ #238 集成（20 文件 + lib/model-access 目录直复制哈希全过；同步层=T27 时点无并发冲突；CONTEXT.md 领域文档随票更新）→ int7 @5590 migrate 至 0127 + 全量 285/285（25 文件）+ 双 TC 0。组 04 链 04.1→04.5 全部落地。
- T30：#239 完成（ctx_922d9097c479）：AccessGrantUseError + resolveForBot/resolveForUser 统一不可区分拒绝 seam（04.7/05.x 消费入口）+ 13 测试 157 断言（四类 AC + 无泄露扫描 + 入口清单探测）；HTTP 入口核查组 04 无请求体取身份（strictObject），无路由变更。coordinator 重跑：239v 库 68/68 + 双 TC 0 + checkpoint 112 哈希 0 mismatch → 释放 → review-239 派发（task_88986af9e6d4 / ctx_f987407597b9）。#239 派发记录（T29 补）：b5-239 worktree + 110 文件 sync + task_470beba5e2de。
- T31：review-239 双 PASS（0 阻断/0 重要，delta 隔离与 write scope 双向核验）→ #239 集成（3 文件哈希 3/3）→ int8 验证 113/113 + server TC 0 → #240 派发（b5-240 + 115 文件 sync + ctx_5e45a6a01c70，含 review-238 三 Low 打磨建议）。运行中 = fix-219 / #237 / #240。
- T32：**第二次 hiroute 502 风暴**：fix-219/#237 再次重试耗尽停摆（liveness unverifiable）→ send 唤醒两 worker。
- T33：#240 完成（ctx_5e45a6a01c70）：GET /grants + revoke 路由（事务条件更新/幂等/统一 404/恰一审计/不碰台账）+ 前端我的授权区块 + 8 server + 4 UI 测试；87 回归 + 双 TC 0。coordinator 重跑：240v 库 66/66 + 双 TC 0 + checkpoint 119 哈希 0 mismatch → 释放 → review-240 派发（task_f8b3172341fe / ctx_a12fb113d213，含 3 Low 打磨兑现核验项）。运行中 = fix-219 / #237 / review-240。
- T34：review-240 双 PASS（Spec 4/4 AC 含 8 路并发撤销探针；质量 A-；**3 Low 打磨 0/3 兑现**——派发指令偏差，Low 级不阻塞，记录为遗留可在 06.x/OCR 阶段处理）→ #240 集成（12 文件哈希 12/12）→ int9 全量 306/306（27 文件）+ 双 TC 0。**组 04（Bot 服务接入链 04.1–04.7）全部集成完毕**。
- T35：就绪队列计算（依赖⊆已集成集）：#210/#221/#241/#290/#345 共 5 张。派发 #210（b5-210 + 119 sync + ctx_651b16c858e8；01.4 完成后 #213 门禁解锁）。运行中 = fix-219 / #237 / #210。
- T36：**第三次 hiroute 502**：fix-219/#237 再次停摆 → 第三次 send 唤醒。#210 正常推进（worktree 持续更新）。
- T37：#210 完成（ctx_651b16c858e8）：gateway_rate_versions 不可变追加表（0128 触发器先例 0012）+ rateVersionAt/readRateVersion 契约 + save() 同事务并发序列化；30/30 + 152 网关系列。coordinator 重跑发现 **worktree 环境缺口**：app/src/lib/generated/application-config.ts（构建产物，sync_delta 不携带）致 app tsc 4 错——复制生成文件后 tsc 0；教训：worker app 验证前若报 TS2307 generated 模块先补该文件。重跑：210v 库 96/96（网关域）+ 双 TC 0 + checkpoint 125 哈希 0 mismatch → 释放 → review-210 派发（task_940d73d0f604 / ctx_d9d3f0d2c507）。运行中 = fix-219 / #237 / review-210。
- T38：review-210 双 PASS（0 阻塞/5 INFO；触发器三连拒绝实测、并发版本号不重复）→ #210 集成（11 文件哈希 11/11，迁移链至 0128）→ int10 全量 338/339（1 fail 复跑两轮不可复现判 flaky）+ 双 TC 0。**#213（01.7 消费入口就绪门禁）解锁**。
- T39：#213 派发（b5-213 + 125 sync 含生成文件补齐 + ctx_77a82533def1）。运行中 = fix-219 / #237 / #213。
- T40：#213 完成（ctx_77a82533def1）：readiness.ts 单一就绪门禁（五条件 fail-closed + 14 reasonCode + 从不拨网从不回退）+ app.ts 装配；单元 20 + 集成 14。coordinator 重跑：213v 库 110/110（网关+readiness 域）+ 双 TC 0 + checkpoint 129 哈希 0 mismatch → 释放 → review-213 派发（task_3c1feaebdd18 / ctx_4c16844fd878）。运行中 = fix-219 / #237 / review-213。
- T41：review-213 双 PASS（0H/0M/1L/4I）→ #213 集成（5 文件哈希 5/5；app.ts 装配核验 #208/#236/#238 装配完好）→ int11 全量 373/373（32 文件）+ 双 TC 0。**组 01（网关就绪 01.1–01.7）全部集成完毕**。
- T42：就绪队列 7 张（214/221/223/241/242/290/345）。派发 #214（b5-214 + 129 sync + ctx_ab291e8b64ea）。运行中 = fix-219 / #237 / #214。
- T43：#214 完成（ctx_ab291e8b64ea）：/api/admin/gateway 管理面（status 诊断+保存+probe 动作+链式协商）+ 管理员网关设置页（凭据指纹不明文）；server 9/9 + app 4/4。coordinator 重跑：214v 库 69/69 + 双 TC 0 + checkpoint 136 哈希 0 mismatch → 释放 → review-214 派发（task_d55ca7d2dfc2 / ctx_9f5dd6060e1c）。运行中 = fix-219 / #237 / review-214。
- T44：review-214 双 PASS（0H/1M/3L；F1 Medium=sidebar↔admin index 布局一致性跨 #234+#214 的整合问题，reviewer 建议另开小票不阻塞——**记录为遗留项 F1-214**；3 动作路由字面越界系 AC1 必需已留痕裁定）→ #214 集成（12 文件 + lib/gateway 目录哈希全过）→ int12 全量 382/382（33 文件）+ 双 TC 0。
- T45：fix-219/#237 经 3 次 send 唤醒无效（终端死锁在 502 重试耗尽，worktree 自 10-16 午后停滞）→ abandon → task ready → **全新 worker 重派**（fix-219→ctx_9ed85787191d、#237→ctx_bd059656a2fa）+ 第 4 次接续简报（#237 额外提示同步层过旧、不要参考主 checkout）。3 并发 = fix-219 / #237 / （空位备用）。
- T46：#237 第 4 次接续完成（ctx_bd059656a2fa；前次中断已写完全部代码，本次完成验证）：createBindingOfferConsumer + 双统一错误类 + 7 集成测试（并发双花 7/7×3 轮）；双 TC 0 + biome 0。coordinator 重跑：237v 库 29/29 + 双 TC 0 + checkpoint 91 哈希 0 mismatch → 释放 → review-237 派发（task_f57320c20c20ec6 → ctx_0bef5fd9e469，含 review-236 Low1/Info4 落实核验项，注明旧同步层只审自有增量）。运行中 = fix-219 / review-237。
- T47：fix-219 F1 修复完成（ctx_9ed85787191d）：双层修复全在测试侧（行为层提取 gate 闭包真执行 + 结构层标识符断言），M6a/M6b 双变异 RED 证实，28/28 + TC 0，生产代码零改动。coordinator 重跑 219f2 库 28/28 → checkpoint 复抓 → rereview-219 派发（task_b80f48646909 / ctx_915afb713825，要求亲手复现变异）。
- T48：review-237 双 PASS（0 硬违规/2 低 smell）→ #237 集成（3 文件哈希 3/3；binding-codes.ts 集成层版本=其同步层版本，diff 纯为消费半边增量）→ 集成层 63/63（bot-services 域）。**组 04 全部含 04.4 落地**。运行中 = rereview-219。
- T49：rereview-219 F1 CLOSE（生产代码零改动证实 + 双变异复现成立）→ #219 集成：payer-binding.ts + 修复版 payer-no-fallback.test.ts + 计划直复制；index.ts/copilot.ts 以 diff-patch 方式应用（纯加法 + externalCustomerId→payerBinding 收敛 + CreditGateError→CreditInsufficientError 语义化），#236 装配完好（registry 三处）。集成层 205/205（20 文件）+ 双 TC 0。**verified+integrated = 21/151**。
- T50：批量派发 #221/#223/#241（各 142 文件 sync + 生成文件 + 简报；ctx_bf76ea6e7df1 / ctx_9cbb62f0a856 / ctx_5e5947686d3b）。就绪队列剩 #242/#290/#345 待空位。

## T51 — #223（03.1 目录抓取与 ModelRef 规范化）闭环前半段（2026-10-17）

- worker（b5-223 worktree）完成：catalog.ts（fetchCatalog/listModelRefs、ModelRef 三元组规范化、能力仅从 supported_methods 推导、不可判定记 unknown+原因）、gateway_model_catalog_refs（三元组唯一索引）+ gateway_catalog_fetches（append-only）两表、0129 迁移+snapshot、catalog-fetch.integration.test.ts + catalog-model-ref.test.ts
- coordinator 验证：checkpoint 抓取（148 files，HEAD bab7c0b9）；专用库 openbot_b5_223v @5590 roles+migrate 成功；域测试 59/59 pass（catalog-fetch + catalog-model-ref + readiness-gate + rate-version + negotiation 回归）；双 typecheck 0
- checkpoint 哈希核对：148/148 一致
- worker-release ctx_9cbb62f0a856 完成
- review-223 派发：task_62bf570cb8aa → dispatch ctx_dbeedcbb61fb（主 checkout 只读），简报 /tmp/b5-223-review.txt（要求独立建库 openbot_b5_223r 重跑域测试、迁移链核验、ModelRef unknown 语义与泄漏纪律 AC 核验）
- 待审阅通过后集成（0129 迁移链接入主 checkout）

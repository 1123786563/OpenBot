# Orca DAG Wave3 — Round 1 独立评审（主工作区未提交集成增量）

- 评审者：独立 reviewer（与实现者不同会话），只读评审；唯一写入物即本文件。
- 日期：2026-10-20。评审对象：主 checkout `/Users/wuyongjun/trea/OpenBot` 的 `git diff HEAD`（21 个 tracked 文件）+ 未跟踪新文件（14 个，含 `deploy/hindsight/extensions/**` 四个 Python 文件），以 `receipts/wave3-delta-r1/`（sha256 + tracked.patch）圈定范围。
- 评审票：#280（B08.5 provider 终态查询）、#381（Hindsight 04 bank 隔离）、#373（BP05 续期幂等）、#405（preview 代理 cookie 策略）、#411（TLS renewal-status 门禁）。

## 0. 增量完整性与独立验证证据

**完整性**：`receipts/wave3-delta-r1/sha256.txt` 的 14 个新文件哈希与主工作区活树逐一相符（14/14）；`tracked.patch` 与活树 `git diff HEAD`（剔除编排状态文件后）逐字节一致。评审的就是集成进主工作区的这份增量。bf3/hbc3 两侧迁移编号在集成时重排为 0165/0166（bf3 worktree 内曾为 0164），`_journal.json` 与 SQL 文件一致，无冲突残留。

**独立重跑**（全部本机本轮实测，非转述实现者结论）：

| 验证项 | 命令/环境 | 结果 |
|---|---|---|
| server typecheck | `bun run --filter server typecheck` | exit 2，**仅** main 既有 `scripts/bootstrap-local-gateway.ts` 3 处 TS2339（已知基线），本增量 0 新错 |
| craft 单元（e2e 层） | `PORT=3001 SERVER_PORT=3001 bunx e2e run --config e2e.unit.config.ts craft-preview-origin.test.ts craft-webapp-proxy.test.ts plan-renewal-grantor.test.ts hindsight-bank-scope.test.ts` | **230/230 pass**（craft-preview-origin 124、craft-webapp-proxy 92） |
| DB 集成（真实 PostgreSQL） | `TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5567/w3int bun test` × billing-company-renewal / subscription-ownership / recovery-provider-query | **21 pass / 0 fail**（w3int 已应用 0165+0166，迁移哈希与文件相符） |
| DB 集成（回归） | 同上 × plan-credits-personal.integration | 4 pass / 0 fail |
| #381 真实实例合约 | `sh deploy/hindsight/test/contract-instance.sh start`（本评审者自行启动一次性实例）+ 三环境变量跑 `hindsight-bank-isolation.contract.test.ts hindsight-bank-scope.test.ts`，事后 `stop` | **23 pass / 1 skip**（skip 为"实例不可用"守护位，正确跳过）——票面 Verification 的允许/拒绝矩阵在真实 Hindsight 1.0.0 上独立复现 |

已知坑的 A/B 处理：默认环境下 `craft-webapp-proxy` 19 处失败全部来自 main-ws 本地 `.env` 的 `PORT=3001/SERVER_PORT=3002` 冲突（报文即 "PORT (3001) and SERVER_PORT (3002) disagree" 系）；按已知事实以 `PORT=3001 SERVER_PORT=3001` 复跑后全绿。**不计为本增量 finding**。未独立重跑：bifrost `jobaccounting` 的 `go test ./...`（bf3 报告 ok；本增量未触碰 bifrost 子模块任何文件）。

---

## 1. #280 B08.5 provider 终态查询

**Spec compliance：MET**（切片边界如实记录：生产接线有意缺席，见下）

| 票面验收 | 裁决 | 依据 |
|---|---|---|
| 供应商明确结果 → 结论写回、可作处置证据 | MET | `lastReason` 稳定码（`provider_settled_evidence` 等）+ 追加型 `credit_recovery_queries` 证据行（source/bounded summary/usage 对/queried_at/recorded_at），`recovery-provider-query.integration.test.ts` 逐条钉住 |
| 查不到日志/无记录 → 保持 unknown 不释放 | MET | `still_unknown` 下 hold 状态保持 `unknown`、`failureCount+1`，有专门用例（"no record of the request…"） |
| 只有明确未计费证据才进入释放路径（释放归 08.9） | MET | 本模块不 settle/release/re-dispatch；`no_charge_evidence` 是唯一可进释放路径的结论，且模块内无释放路径存在 |
| 查询证据可被管理员只读核查 | MET（表级） | 证据行为普通表读（测试断言无 join、无副作用）；管理员**视图**是 08.8 的票，边界正确 |

边界记录（实现者已声明，评审核实）：生产侧无 source 接线、无调度调用（`createProviderQueryRecovery` 在 `server/src` 零生产消费者；08.4/#279 未在 main）。构造期强制 source 存在、否则 TypeError——"未接线能力必须拒绝"的准入纪律成立，符合全局约束"缺凭据不编造供应商证据、能力保留为未启用"。票面 Verification 的 `recovery-provider-query.test.ts` 以 `.integration.test.ts` 交付（与 08.1/08.2 姊妹套件命名一致，需 TEST_DATABASE_URL）。

**Code quality：Good。** 亮点：不可分类答案按 `still_unknown` by construction（`classifyAnswer` 纯函数）；失败计数只在 still_unknown；持久化未确认结果让渡 08.2 replay lane（先查 `usageOutbox` 再决定问不问）；证据先写、指针后移的崩溃序；summary 512 上界。测试隔离（claim-by-id + park）沿用 replay 套件纪律，9 用例与票面"三类结论/无记录/证据完整性"一一对应。

## 2. #381 Hindsight 04 租户身份与 bank 隔离

**Spec compliance：MET**

| 票面验收 | 裁决 | 依据 |
|---|---|---|
| 可信会话/后台任务取得范围；客户端不能提交可生效 bank ID/伪造作用域 | MET | `resolveHindsightBankScope` 只消费 `assertTrustedScope`（#82 issuedScopes 标记），手造/克隆 scope 均 `UNVERIFIED_SCOPE`（测试钉死）；bank/schema 全部派生（`ob_[ctusb]_<sha256 前 16 hex>`），请求体/query/header 无入口。"持久后台任务"的 scope 铸造未演示，但 seam 对 scope 来源中立，且 recall 路径接线已在 README 明示为后续票边界 |
| 自定义租户认证+操作校验拒绝跨公司/跨用户/猜测 bank/伪造服务身份 | MET | **真实实例独立复现**：仅共享 key 401、错 key 401、外密钥自签 401、篡改 body 401、过期 401；跨公司/跨用户/猜测 bank 的 retain/recall/delete 403；bank 列表恰为授权集 |
| 同一全局用户两家公司不同隔离范围；tag/无 tag 不能绕过 | MET | 派生测试（两 schema 两 bank）+ 实例合约（A 公司文档经 B 公司 scope 404；`tags: []`/`tags:["shared"]` 均 403）；`resolve_tag_scope` 恒 None——tag 只分类不隔离 |

两侧密码学一致：HMAC-SHA256 over `v1.<body>`；Python 侧只解析收到的 body 字节再验签（无规范化歧义）；`compare_digest`/`timingSafeEqual`；`_is_safe_identifier` 把 schema/bank 串锁死在派生形状上（SQL 注入纵深）。

**Code quality：Good**，附低危加固项（F3/F4/F6，见清单）。

## 3. #373 BP05 公司订阅续期与周期纠错

**Spec compliance：MET**

| 票面验收 | 裁决 | 依据 |
|---|---|---|
| 同订阅同周期只发一次、不同周期分别发、个人/公司同字符串 ID 不冲突 | MET | ledger 键升级为 `plan-renewal:<accountKey>:<subId>:<periodStart>`；`billing_subscriptions` 主键改 `(external_customer_id, external_subscription_id)`（迁移 0166，expand-only，旧约束严格强于新约束故无数据风险）；新集成测试 5 case 含同字符串 ID 两行两账户互不吞没、重复通知幂等、下期再发 |
| 收款未知/失败不预发；修正先查权威周期，无法判定进异常 | MET（已交付路径） | 无周期事实 delivery 零发放、marker 不动（测试钉死）；未覆盖周期保持 uncovered 由 sweep 重试；补缴场景未单测但前向 marker 语义被既有+新用例覆盖 |
| 取消阻断未来周期、已付周期保留、回调/客户端不能改 Payer | MET | 取消+provider 已翻期 → 无 12 月发放、11 月发放保留至锁定到期（测试）；owner 列仅 activation stamp 可写（既有测试延续） |

**Code quality：Good**，一处 Medium 边缘缺陷（F7）与一处低危升级窗口（F8）：交付路径 `applyRenewals` 已按 customer 收窄（`readLiveOwnedSubscriptions(subscription.externalCustomerId)` 再按 subId 匹配），但 sweep 路径未收窄——正是本票自身前提（同字符串 ID 并存）下的漏网面。

## 4. #405 preview 代理 cookie 策略

**Spec compliance：MET**

| 票面验收 | 裁决 | 依据 |
|---|---|---|
| 应用设置 cookie → dev server 可见 | MET | `app-only` 请求侧按对转发应用 cookie（`forwardAppCookiePairs`），测试断言上游收到 `appsession=s1; theme=dark` |
| 应用不能设置 `Domain=主站` | MET | `sanitizeAppSetCookie` 剔除 `Domain`（含 `Domain=.example.com` 用例），host-only |
| platform pass 不进入应用请求 | MET | 逐对剔除 `openbot_preview_session=`；纯 pass 请求不带 cookie 头（专测） |
| 多 `Set-Cookie` 不丢失 | MET | `getSetCookie()` + 逐条 `append`，两条均存活且各自净化 |
| 现有 header hygiene 不回归 | MET | 默认策略 `strip-all` 原样并钉死（"the default policy … still strips every cookie both ways"），92/92 全绿 |

改动范围合规：仅 `webapp-proxy.ts` + 测试；主站旧代理语义未动。

**Code quality：Good。** 策略显式化为 `WebappCookiePolicy` 并默认旧语义；`Path` 非绝对即弃；属性 smuggle 无通道（";" 分割后重组）。一处低危加固项（F10：pass cookie 名可被应用覆写）。

## 5. #411 TLS renewal-status 门禁

**Spec compliance：MET**

| 票面验收 | 裁决 | 依据 |
|---|---|---|
| 状态文件缺失 → webapp-info null+reason、签票 503 | MET | origin 级 + 端到端（真实 origin 无 gate 注入，`OPENBOT_TLS_STATUS_FILE` 指向不存在路径）双测 |
| `starting` → 关闭并说明首签中 | MET | 专用句式断言 |
| `critical`/过期 → 关闭并说明原因 | MET | 含 `healthReason` 透出；`ok` band + `daysLeft=0` 也关（daysLeft 是事实权威） |
| `ok`/`warn` → 原行为 | MET | 双 band 开放用例 |
| 文件更新无需重启重判 | MET | (mtime,size) 缓存；测试写文件后即时重判、再写再关 |
| dev 形态不依赖证书状态 | MET | 无文件时 dev admission 开放（专测） |
| compose 只读挂载 + 文档修正 | MET | `migrate` 服务 `${OPENBOT_TLS_HOST_DIR:-./tls}:/etc/openbot/tls:ro`；`docs/tls-certs.md` 原"server 不读该文件"段改写为真实拓扑 |

**Code quality：Good。** 纯函数 `tlsStatusVerdictOf` 与文件系统分离，全缝 fail-closed（缺失/畸形/未知 band 均关）；gate 可注入；测试走生产 env→gate→admission 链。

---

## 6. Finding 清单（按严重度）

| # | 严重度 | 票 | 位置 | 内容 | 建议 |
|---|---|---|---|---|---|
| F7 | **Medium** | #373 | `server/src/billing/service.ts:825`（sweepRenewals） | sweep 以裸 `getSubscription(row.externalSubscriptionId)` 查 provider：在本票自身前提（provider 按 customer 命名空间 subscription id、同字符串可并存）下裸 id GET 有歧义，且返回体未与 `row.externalCustomerId` 交叉校验即以其 period 事实驱动 `coverPeriod`——碰撞场景可能用另一 customer 的记录覆盖本期。交付路径已正确收窄且有测试，sweep 路径无碰撞测试 | 后续票：sweep 查询带 customer 维度或校验返回体归属；补碰撞用例 |
| F1 | Low | #280 | `docs/verification/e2e-bun-suites.json` | `recovery-provider-query.integration.test.ts` 未登记入 manifest，而其两个姊妹套件（recovery-scan / recovery-unacked-replay）均在册——覆盖审计会漏掉本套件（本仓库刚修过 manifest islands，e875a1e1） | 把该文件加入与姊妹相同的 group 与 files 清单 |
| F8 | Low | #373 | `server/src/billing/plan-renewals.ts:25`（键格式升级注记） | 键格式变更使升级前"已发放但 marker 未推进"（grant 与 marker 间崩溃窗口）的旧周期失去 ledger 幂等栅栏：升级后重试将用新键再次发放。注释声称 marker 兜底，但该状态恰恰是 marker 缺失时的状态。概率极低（崩溃窗口+升级前无成功重试），影响为单期重复发放 | 可接受；在迁移/运维注记中点名该一次性窗口，或升级期对旧键格式做兼容探测 |
| F10 | Low | #405 | `server/src/craft/webapp-proxy.ts:356`（sanitizeAppSetCookie） | name=value 对原样放行：生成应用可发 `Set-Cookie: openbot_preview_session=<值>`，Path 匹配时可遮蔽/污染预览域上的平台 pass cookie，导致用户预览会话验证失败（值为 HMAC 签名验证，无提权——仅 DoS/骚扰面） | `app-only` 下丢弃 cookie 名等于 `PREVIEW_SESSION_COOKIE` 的 Set-Cookie 行 |
| F3 | Low | #381 | `deploy/hindsight/extensions/openbot_tenant/tenant.py:73` | 共享 API key 用普通 `!=` 比较（非常数时间）；断言路径已用 `compare_digest`。回环绑定+共享 key 模型下实际风险低 | 改 `hmac.compare_digest` |
| F4 | Low | #381 | `deploy/hindsight/extensions/openbot_tenant/validator.py:118`（filter_bank_list） | 非 internal 且 `allowed_bank_ids is None` 时返回未过滤的全量 banks——fail-open 分支。鉴权后理论不可达（无断言的外部请求已 401），但与 `bank_list_scope` 对同一情形的 deny 姿态（空集）相悖 | 与 `bank_list_scope` 对齐：None → 空集 |
| F2 | Info | #280 | `server/src/billing/recovery-provider-query.ts:381`（queryFinalStates 循环） | `appendEvidence`/`handBack` 的 DB 异常会中断整批，剩余已 claim 项停留 claimed 直至 08.1 claim 超时回收。可接受（有回收机制），记录在案 | 无需动作 |
| F5 | Info | #381 | `deploy/hindsight/test/contract-instance.sh` | `export HINDSIGHT_CONTRACT_*` 只影响脚本自身进程；操作者须为 bun 运行另行导出三个变量，否则套件按设计大声跳过（但跳过守护不指明缺哪个变量） | 脚本收尾 echo 提示需导出的变量 |
| F6 | Info | #381 | `deploy/hindsight/extensions/openbot_tenant/assertion.py` | 断言无 jti/nonce，TTL 内可重放（bearer 模型 + 回环传输下可接受）；recall 路径接线落地时再评估 | 届时再议 |
| F9 | Info | #373 | `server/src/billing/service.ts:387`（entitlement reader） | 同为裸 id `getSubscription`，仅展示用途，影响低于 F7 | 随 F7 一并处理 |
| F11 | Info | #405 | `server/src/craft/webapp-proxy.ts:309` | `forwardAppCookiePairs` 按 ";" 切分，RFC 6265 合法 cookie 值不含 ";"，合规发送方安全 | 无需动作 |
| F12 | Info | #411 | `server/src/craft/preview-tls-status.ts:157` | (mtime,size) 缓存在"同尺寸+同 mtime 粒度内重写"时给旧裁决；sidecar 重写实际改变尺寸/mtime，代码注释已自认 | 无需动作 |
| F13 | Info | #411 | `server/src/craft/preview-origin.ts:752` | host 形态每次 admission 一次同步 `statSync`（仅 webapp-info/签票路径），代价可忽略 | 无需动作 |
| F14 | Info | 集成 | `docs/verification/e2e-bun-suites.json` | 文件尾换行丢失（`\ No newline at end of file`） | 随 F1 修复顺带补 |

已知事实（按要求不再计入）：main-ws `.env` PORT/SERVER_PORT 冲突（A/B 已证 19 失败全属此族）；typecheck 3 处 bootstrap-local-gateway 基线错误；bf3 附录 A 的 e2e-node 层 React 异步重渲染问题（本评审未复核，非本增量引入）。

## 7. 裁决建议

**五票全部通过本切片边界，建议接受 wave3 集成增量**：

- #280 / #381 / #373 / #405 / #411 的票面验收逐条 MET，无 NOT/PARTIAL 项；
- 全部可本地复现的验证独立重跑通过（230 单元 + 25 DB 集成 + 23 真实实例合约 + typecheck 0 新错）；
- 唯一 Medium（F7，sweep 裸 id 查询）只在本票自己的碰撞前提下、且仅在 sweep（非交付）路径生效，已有测试路径不受影响——建议开后续票修正，不阻塞本增量合入；
- Low/Info 项建议按 F1/F14（manifest 登记）随集成顺手修复，其余（F8/F10/F3/F4）可攒批处理；
- 生产接线缺口为**已声明且合规的边界**：#280 无 source/调度（准入拒绝在位）、#381 的 OpenBot recall 调用路径（README 已改为后续票非目标）、Go 侧零改动（bf3 只读验证）。

— 独立评审者，2026-10-20

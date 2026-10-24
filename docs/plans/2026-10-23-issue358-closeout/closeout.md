# 收口 — #358 Craft 预览独立 Origin：AC1–AC9 聚合证据表（N3）

- HEAD=`d7c0dfe9c55823f71d7622ef4cb2c4a5e1b1094a`（2026-10-24T16:00Z 核验；分支 `1123786563/issue-358-n3-closeout`，自集成分支 `1123786563/issue-358-integration` 已验证 HEAD 派生）
- HEAD=merge(75e74b8f9e, 461e135bf)，合并树与受审检查点 461e135bf 的树**逐字节相同**（纯合并提交，`git diff 461e135bf d7c0dfe9c --stat` 为空）；main `b117c3c3e` 为 HEAD 祖先。
- Run：`run_dff077721387`；证据目录（主 checkout 本地归档，gitignored）：`.archive/runs/2026-10-23-issue358-closeout/`。下文相对路径均以该目录为根；前序 Run 以 `../2026-10-23-craft-preview-404-419/` 为根。
- 编写：N3-closeout（mechanical_worker/doc，只写文档，零生产代码改动）。verdict 口径沿前序收口表：仓库内证据 + 独立复跑 → 满足；缺 live/环境证据 → blocked(env) 如实标注，不冒称通过。

## 0. 结论速览

| AC | verdict | 一句话依据 |
| --- | --- | --- |
| AC1 预览域隔离（401 + 无主站 cookie/localStorage） | **PASS**（same-site/host 形态 live 步 blocked(env)：BE-2） | N2 run4 AC1 全家真机 PASS（dev 形态）+ #425 legacy 例外口径 + HEAD 套件 |
| AC2 自身 API 四动词 + Server Actions | **PASS** | N2 run4 四动词 200/reached + Server Actions live PASS；R-6 basePath 三面一致 |
| AC3 跨会话隔离 | **PASS** | N2 run4 A→B 401；每会话独立 label（HMAC）+ 套件 |
| AC4 无票/过期/已用/他人票拒绝、单次使用 | **PASS** | #431 T1/T2（consume-on-sight）+ F2 随机 token/索引/单 token 作废（#427） |
| AC5 status/logs/restart 同进程 + HMR | **PASS** | 附着模型锚点 + F4 43/43 + R2-F2-merge 57/57 + N2 run4 AC5 热更三步 |
| AC6 生产缺证书/域名显式关闭 | **PASS**（仓库/单测面） | admission 总门四分支（#404/#408/#411）+ origin 套件 148 |
| AC7 存量会话按 D10 | **PASS** | 代际标记三态 + #425 开关/文案 + N0 SATISFIED |
| AC8 ACME DNS-01 自动签发/续期/告警 | **PASS-with-blocked(env)**（仓库面全绿；live 首签/续期/热加载 BE-1、staging 演练 BE-3） | #407/#415/#429/#430 已验证证据 + TLS 面 main→HEAD 字节一致 |
| AC9 子域名不泄露 session id、不可枚举 | **PASS** | label=HMAC(secret, sid) 截断 + pass 值零会话身份 + N2 AC9 两轮 PASS |

统计：AC1–AC9 无 FAIL；2 项受 blocked(env) 约束的 live 面挂 BE-1..4。正式子票 32 张：closed 10（仅引用）/ open 22（本轮全部处置，见 §2，其中关票候选 16 张、交终审裁决 3 张（#414/#419/#431）、因 BE/PA 维持 OPEN 3 张（#412/#413/#416））。

## 1. AC1–AC9 逐项证据表

> 锚点均为 HEAD `d7c0dfe9c` 实测 `file:line`（N0 时点锚点经 F2 增量漂移，本表重锚，订正见 §5）。真机证据（N2）绑定 `75e74b8f9e`（HEAD 第一亲本、F2 并入前的集成分支 HEAD）；F2 增量（pass 层）在 HEAD 由 R2-F2-merge 组合树套件与 F2-R1 独立复跑承载，HEAD 上未重跑浏览器真机链（未决项见 N3 报告 §4）。

### AC1 预览域隔离（对应 F1/F2/D1/D2）

| 项 | 内容 |
| --- | --- |
| verdict | **PASS**（dev 形态真机全 PASS；#425 legacy 同源例外为已批准显式口径；same-site/host 形态 live 步 blocked(env) → BE-2，不影响本 AC 的已验收面） |
| 覆盖票 | #362/#409（已关，引用）+ #425（本轮 N0 SATISFIED）+ #410/#408/#411（纵深） |
| HEAD 锚点 | `server/src/craft/preview-origin.ts:1135-1149`（pass 门：null ⇒ `refuseResponse(PREVIEW_PASS_REFUSAL, 401)`）、`:146`（拒绝常量）；`server/src/craft/webapp-proxy.ts:467`（CSP `form-action 'self'; frame-src 'self'`，#409）、`:1072`（legacy 关闭原因可展示）；`server/src/craft/config.ts:505-509`（`legacyPreviewEnabled`，默认 true） |
| 证据与读数 | N2 run4（`verification/N2-live-r2-report.md` §2.1，HEAD=75e74b8f9e）：document.cookie 空 / cookie jar 隔离 / localStorage 隔离 / 跨 origin 401 / form-action CSP 拦截 / 协议层 401（服务端日志增量锚定）全 PASS；run9 AC1 全家复 PASS（§2.2，更正口径见 §6）。N0 `issue-audit-n0-transfer/N0-audit-report.md` §二（#425 五条 AC 逐条 file:line）+ `reviews-n0-transfer/N0-audit-r1.md` B3 独立确认。HEAD 套件：origin 148 / rejection 24（`verification/R2-F2-merge/f2-5suites.log`，exit 0）。前序 `../2026-10-23-craft-preview-404-419/verification/issue-audit/issue-409.md` |
| 缺口与解除 | ①same-site（host 形态）live = BE-2；②伪造明文 cookie 断言为 harness 缺陷从未真机实测（HTTP 拒绝面由协议层 401 独立钉住，N2-R1-03，建议票见 §7）；③HEAD 上真机链未复跑（见 N3 报告 §4） |

### AC2 自身 API 四动词 + Server Actions（D2 不回退）

| 项 | 内容 |
| --- | --- |
| verdict | **PASS** |
| 覆盖票 | #364/#405（#364 已关引用）+ #414（本轮 N2 live 补证） |
| HEAD 锚点 | `server/assets/craft/web-template/next.config.ts:29-75`（R-6：env basePath，trim 非空才设，`NEXT_PUBLIC_BASE_PATH` :75）、`server/assets/craft/web-template/lib/base-path.ts:6-33`、`server/assets/craft/web-template/AGENTS.md:8`（「dev `/<label>`、生产根路径」口径）；`docs/specs/2026-10-15-craft-preview-origin-design.md:67`（R-6 修订，批准事实源）；`server/src/craft/preview-origin.ts:281-297`（代理腿两形态 verbatim 路径）；`server/src/craft/webapp-proxy.ts`（app-only cookie 转发/消毒，#405，套件钉住） |
| 证据与读数 | N2 run4（75e74b8f9e）：`POST/PUT/PATCH/DELETE:200/reached`（method 回显）+ UI 点击 POST 200 + Server Actions PASS（`next-action` POST=1 全落本会话 preview origin，#431-T3/#414 同证）。HEAD 套件：webapp-proxy 108（`R2-F2-merge/f2-5suites.log`）；action-cookie host-only live 断言由 #405 单测面承载（N05-416 判定沿用，无反证） |
| 缺口与解除 | action-cookie host-only 未单列 live 断言（#405 单测承载，票面归 #414 残余项）；见 §2 #414 行 |

### AC3 跨会话隔离（D3）

| 项 | 内容 |
| --- | --- |
| verdict | **PASS** |
| 覆盖票 | #360/#366（已关，引用）+ #418（单副本契约） |
| HEAD 锚点 | `server/src/craft/preview-origin.ts:373-374`（`previewLabel`=HMAC(secret, sessionId) 截断，每会话唯一）、`:806`（进程内 label registry）；`server/src/index.ts:6954-6966`（#418 单副本契约启动声明） |
| 证据与读数 | N2 run4：会话 A 预览内 fetch B 路径 → `docRoot=401 apiPost=401`（无凭证对照 401）。HEAD：rejection 24 + origin 148（`R2-F2-merge`）；N0 复跑 rejection 24（N0 报告 §八 行2）；前序 `issue-audit/issue-417.md`（mount 交叉检查不回退） |
| 缺口与解除 | 多副本 sticky/共享存储为 D-4 已裁决边界（#418 Option B，多副本 404 本身不修） |

### AC4 票据鉴权（无票/过期/已用/他人票拒绝，单次使用；D4/D9）

| 项 | 内容 |
| --- | --- |
| verdict | **PASS**（#427 轮换语义缺口已由 F2 闭合） |
| 覆盖票 | #360（已关引用）+ #431（T1/T2 SATISFIED、T3 live PASS）+ #427（本轮 F2 交付） |
| HEAD 锚点 | `server/src/craft/preview-ticket.ts:96-100`（consume-on-sight：一票一次尝试）、`:103`（expired）、`:104-106`（mismatch=他人会话票）、`:108-115`（session/owner 复核）、`:38`（D9 30s 单次）、`:183`/`:203-207`（path/value 白名单）；F2 轮换面 `server/src/craft/preview-pass.ts:149`（`TOKEN_BYTES=16`）、`:235`（每次 `randomBytes(16)`）、`:88`（索引）、`:276-279`（索引 miss ⇒ null，fail-safe）、`:283-302`（`revoke` 单 token 作废）、`server/src/craft/preview-origin.ts:1119`（兑换铸随机 pass）、`:1164-1166`（`revokePass`） |
| 证据与读数 | N0 §三/§四（#431 T1/T2 SATISFIED、#427 当时 GAP）；F2 检查点 461e135bf 已集成，`reviews/F2-pass-rotation-r2-r1.md`：Axis A/B/C 三面，独立复跑 pass 24/ticket 25/rejection 24/origin 148/proxy 108 = **329/329** + socket/hmr 57 全绿、typecheck 0 新增（原实施报告随 worktree 清理丢失，替代证据链见 §6.3）；HEAD 组合树同读数（`verification/R2-F2-merge/f2-5suites.log` exit 0、`typecheck.log` 3 条 BASE 预存） |
| 缺口与解除 | ①`revokePass` 无生产调用方（票面最小调用面，接缝注释指向会话删除/强制退出钩子，`preview-pass.ts:112-126`）；②F2-R1-01（mint 对「mount 记录从未写过」族群过度拒绝 409 + 文案失实，移交 N2 观察未落地 → 建议票 §7）；③F2-R1-03（索引无逐出，显式接受，后续增强）；④F2-R1-02（`preview-ticket.ts` 白名单注释仍写旧 `v1.<user>.<mac>` 形状，文件未触碰 ⇒ 按审核建议随下次触碰修正＝延期） |

### AC5 status/logs/restart 同进程 + HMR（附着模型不回退）

| 项 | 内容 |
| --- | --- |
| verdict | **PASS** |
| 覆盖票 | #363（已关引用）+ F4（source-pin 修复）+ N2 live |
| HEAD 锚点 | `server/src/craft/templates/webapp.plugin.ts:1-2`（webapp tool：start/status/logs/restart over 受保护 `start-webapp.sh`）、`:72`（action schema）；`server/src/craft/nextjs-dev.ts:6`（附着形状：pid+log+readiness）、`:132-133`（mount env 注入）、`:175-189`（pid 身份守卫复用，不重复拉起）；`server/src/craft/preview-origin.ts:774-775`（#362：probe, never spawn）；HMR 门 `server/src/craft/webapp-proxy.ts:1474-1520`（verifyPass 注入）、`server/src/http-server.ts:106/:139-151`（接线现居所，F4 重钉） |
| 证据与读数 | F4 `verification/F4-hmrpin-report.md` + `reviews/F4-hmrpin-r1.md`（43/43，断言语义不弱化）；R2-int：hmr 43/43 @75e74b8f9e（ledger 2026-10-24T12:10-12:20Z 事件）；HEAD：socket+hmr **57/57**（`R2-F2-merge/socket-hmr.log` exit 0）；N2 run4 AC5：升级 frames=3（首帧含 `/<label>` 前缀）→ 改 `page.tsx` +6 帧 → DOM marker probe-v1→v2 且 window 身份保留（真机，75e74b8f9e） |
| 缺口与解除 | 无（同 origin 同进程模型在两形态的接线由 socket/hmr 套件与真机共同钉住） |

### AC6 生产缺证书/域名显式关闭（Q2/D8）

| 项 | 内容 |
| --- | --- |
| verdict | **PASS**（仓库/单测面；部署侧实测归 AC8 的 BE 项） |
| 覆盖票 | #361（已关引用）+ #404/#408/#411（前序 verified，本轮回归）+ #421（已关引用：生产不静默落 dev 形态） |
| HEAD 锚点 | `server/src/craft/preview-origin.ts:808-876`（admission 总门：disabled/webappProxy/previewOrigin 三开关、invalid template、#404 主站 host 冒领 :827-842、#408 生产+dev 形态显式关闭 :851-864、#411 host 形态 TLS 状态 fail-closed :866-875）、`:786-794`（`OPENBOT_TLS_STATUS_FILE` 接线）；`server/src/craft/preview-tls-status.ts:55`（五档 health 判定，unjudgeable ⇒ closed）、`:30`（默认状态文件）；`server/src/craft/config.ts:510-513`（模板 env） |
| 证据与读数 | 前序 `issue-audit/issue-404.md`（origin 140/140 + tls 133/133）、`issue-408.md`（三条 AC 测试）、`issue-411.md`（五 health fail-closed）；N0 复跑 origin 147（§八 行2）；HEAD：origin 148（`R2-F2-merge`）+ guard 26/26（`guard.log` exit 0）；R2-int：origin 147/pass 17/rejection 24（ledger 记录，无独立日志工件，见 §6.4） |
| 缺口与解除 | 无（fail-closed 语义本身无环境依赖；真实证书缺失场景的端到端表现随 AC8 live 项 BE-1/BE-3 一并观察） |

### AC7 存量会话按 D10 不迁移（Q4/D10）

| 项 | 内容 |
| --- | --- |
| verdict | **PASS** |
| 覆盖票 | #367（已关引用）+ #425（N0 SATISFIED，AC1 例外收口） |
| HEAD 锚点 | `server/src/craft/webapp-generation.ts:2-58`（代际标记三态：body-then-marker、absent ⇒ current、非 "2" ⇒ legacy）、`server/src/craft/webapp-proxy.ts:984-1086`（webapp-info legacy 分支 + `.webapp-mount` 交叉校验）、`:1210-1211`/`:1429-1430`（同源代理腿/HMR 腿经 `legacyPreviewSwitchedOffFor`）；`server/src/craft/manager.ts:538`（`webappScriptStale` 修复谓词）；`reference/craft-preview-origin.md:289`（存量会话节）、`:341-348`（#425 开关与默认 true 理由）、`:394`（重建 webapp 翻转 current） |
| 证据与读数 | N0 §二（#425 五条 AC 全过，票面 `docs/craft-preview-origin.md` 系陈旧路径引用，按内容判定满足）；N0-R1 B3 独立确认；HEAD：webapp-proxy 108 + origin 148（`R2-F2-merge`）；N2 degrade-a/b 降级路径不产生「current+根挂载+标签地址」永久不一致（`verification/n2live-r2/degrade-{a,b}/evidence.json`） |
| 缺口与解除 | 票面旧路径引用订正归 PA-4 |

### AC8 ACME DNS-01 自动签发/续期/告警（D8）

| 项 | 内容 |
| --- | --- |
| verdict | **PASS-with-blocked(env)**：仓库交付面（脚本/守护/golden/测试/CI 接线/fail-closed 消费）全绿；**公网 live 首签/续期/热加载 = BE-1（#412，票面 Out of scope）、staging 演练 = BE-3（#431-T4）** |
| 覆盖票 | #359（已关引用）+ #407/#415/#412 + #429/#430（已关引用）+ #431-T4 |
| HEAD 锚点 | `docker/compose/certs/renewal-guard.sh` + `drill-renewal-failure.sh`（续期守护与失败演练）、`docker/compose/certs/entrypoint.sh`、`docker/compose/preview-tls.yml` + `docker/compose/preview-tls/{nginx.conf.template,reload-watcher.sh,start.sh}`（#412 参考拓扑与热加载消费者）；`scripts/tls-pipeline.test.ts:449`（renewal-guard health/alerts/cooldown/recovery 套件）、`:20-34`（管线/fixture 说明）；`server/src/craft/preview-tls-status.ts:55`（server 侧状态消费者，#411）；`reference/tls-certs.md`（文档现居所，原 `docs/tls-certs.md` 已随 af3a73e5f 重组迁移） |
| 证据与读数 | 前序 `N01-407-report.md`（`bun run test:tls` 117/117 空载+满载）、`N02-415-report.md`（origin 140/140 + tls 133/133 两轮 + 负向对照翻红）、`N04-412-report.md`（compose config OK + 16 项真实容器冒烟 PASS + 0 残留）；**绑定核验（本轮）**：`git diff --stat b117c3c3e HEAD -- docker/compose/certs docker/compose/preview-tls server/src/craft/preview-tls-status.ts scripts/tls-pipeline.test.ts docker/compose/preview-tls.yml` 为空 ⇒ TLS 面与 main 已验证态**字节一致**，既有证据适用 HEAD。ledger 2026-10-24T12:35Z：本轮 240s 预算内 `test:tls` 未跑完（套件含 20–30s 计时用例），不作结论；全量复跑如需以 ≥600s 预算执行（未决项） |
| 缺口与解除 | BE-1：部署方 DNS 凭据 → `openssl s_client` 泛域名证书 + 换证热加载证据（复跑 `reference/tls-certs.md` Reference topology 步骤）；BE-3：staging DNS 凭据 → 首签/续期演练；BE-4：push 后 CI 实跑 |

### AC9 子域名不泄露 session id、不可枚举（D7）

| 项 | 内容 |
| --- | --- |
| verdict | **PASS** |
| 覆盖票 | #360（已关引用）+ #418 + #421（已关引用） |
| HEAD 锚点 | `server/src/craft/preview-origin.ts:373-374`（label=HMAC(secret, sessionId)，非 sid 或可解码形式）、`:86`（「Discloses no session ids and no labels (AC9)」注释）；pass 值零会话身份：`server/src/craft/preview-pass.ts:141`（shape 仅 token+MAC）+ 测试「the cookie value carries no session id and no userId material」；`server/tests/craft-preview-origin.test.ts` AC9 断言组 |
| 证据与读数 | N2 run4/run9 AC9 两轮 PASS（地址仅含 20-hex label，N2-R1 A1.6 独立复核 `preview-origin.ts:86` 对应）；HEAD：origin 148 + rejection 24（`R2-F2-merge`） |
| 缺口与解除 | 无（不可枚举性由 HMAC 截断 + 无列表端点钉住；label registry 见 #418 单副本契约） |

## 2. 32 张正式子票逐票处置表

> GitHub 状态为 2026-10-24T12:15Z 快照（`issues/refresh-20261024T1215Z-subissues.json`）并经本轮 `gh api` 实读复核一致（22 open / 10 closed）。**禁止**把 GitHub closed 当实现证据、把实现 verified 当已关票——本轮零 GitHub 写入，全部「关票候选」仅指验收已满足、待 PA-1 裁决。

### 2.1 open 22 张（404–419 / 425 / 427 / 431 / 433 / 436 / 437）

| issue | GitHub | 本轮 verdict（增量相对前序收口表） | 关键证据 | 待关闭动作 |
| --- | --- | --- | --- | --- |
| #404 主站 host admission 关闭 | open | 维持 verified；HEAD 回归绿 | 前序 origin 140/140+tls 133/133；HEAD origin 148（`R2-F2-merge`）；锚点 :827-842 | 关票候选（PA-1） |
| #405 app-only cookie 策略 | open | 维持 verified | webapp-proxy 108 @HEAD；action-cookie host-only 单测承载 | 关票候选（PA-1） |
| #406 mint/302 no-store+no-referrer | open | 维持 verified | proxy 108 @HEAD；`webapp-proxy.ts:855` 响应头 | 关票候选（PA-1） |
| #407 tls 套件显式超时 + CI 接线 | open | 维持 verified；TLS 面 HEAD 字节一致 | 前序 117/117；字节一致 diff（§1 AC8）；CI 实跑 = BE-4 | 关票候选（PA-1；CI 长稳观察挂 BE-4） |
| #408 生产准入显式关闭 | open | 维持 verified | origin 148 @HEAD；锚点 :851-864 | 关票候选（PA-1） |
| #409 CSP form-action/frame-src 收紧 | open | 维持 verified；live 面新增 run4 PASS | CSP 串 :467 verbatim 钉住；N2 run4 form-action 拦截 PASS（run9 更正见 §6.2） | 关票候选（PA-1） |
| #410 write-origin-guard 纵深 | open | 维持 verified | guard **26/26** @HEAD（`R2-F2-merge/guard.log` exit 0） | 关票候选（PA-1） |
| #411 TLS 状态 fail-closed 准入 | open | 维持 verified | `preview-tls-status.ts:55` 五档 + origin 148 @HEAD | 关票候选（PA-1） |
| #412 preview TLS 终止参考拓扑 | open | 仓库面 implemented；**live blocked(env)（BE-1）** | 前序 16 项容器冒烟 PASS；拓扑文件 HEAD 在位（§1 AC8 锚点） | 维持 OPEN；解除=部署方 DNS 凭据（票面 Out of scope） |
| #413 basePath R-6 落地 | open | 代码/Spec/#364 三面一致维持；**剩 #358 正文 D6 修订** | Spec `:67` R-6；模板 `next.config.ts:29-75`；spec-vs-#358 冲突记录见 §4 PA-2 | 维持 OPEN；解除=PA-2（Spec 所有者改写 D6 句） |
| #414 Server Actions 验收 | open | **live 主面本轮补证 PASS**（N2 run4，75e74b8f9e）；残余两小项 | N2 §3；残余=action-cookie host-only live 单列断言（#405 承载）+ 整票 live 0-fail 单轮（随 #416/BE-2） | 待 PA-1 终审裁决（接受现证据即可关；否则随 BE-2 复跑） |
| #415 server/sidecar golden 锁步 | open | 维持 verified；TLS 面 HEAD 字节一致 | 前序 origin 140/140+tls 133/133 两轮+负向对照 | 关票候选（PA-1） |
| #416 可复跑全栈 e2e | open | 机制面 verified；dev 拓扑本轮 N2 两轮互补覆盖、**无一 FAIL 指向 #358 产品回归**（N2 verified）；单轮 0-FAIL 未凑齐；**same-site live = BE-2** | N2 §2/§4（run4 20/4/2/1 + run9 14/11/1/0，归因见 §6.2 更正）；上轮 6 FAIL 归因复核四类全部消失/转移 | 维持 OPEN；解除=BE-2 栈 + 0-fail 单轮（HEAD 复跑） |
| #417 mount 交叉检查 + birth-sequence | open | 维持 verified | proxy 108 @HEAD（:222/:242 单点读/折叠 + 三分支）+ N2 主链挂载一致 | 关票候选（PA-1） |
| #418 单副本契约 Option B | open | 维持 verified | `index.ts:6954-6966` 启动声明 + origin 148 @HEAD | 关票候选（PA-1） |
| #419 Issue/文档证据收口 | open | 交付物在案（本表 + N3 报告即续篇）；**docs 副本路径已迁移**（见 §6.4） | 前序 `closeout.md`（run 根，sha256 e87a6927…）+ #358 正文追加节（快照核对在案）+ 16 收口评论 | 维持 OPEN；随 PA-1/PA-2 完成后关票 |
| #425 legacy 同源预览开关 + 风险可见性 | open | **N0 SATISFIED（verified）** | N0 §二 五条 AC + R1 B3；HEAD 回归绿 | 关票候选（PA-1） |
| #427 通行证不透明 token + 索引（轮换） | open | **F2 闭合 GAP-A/B（verified+integrated）** | 461e135bf→HEAD；`reviews/F2-pass-rotation-r2-r1.md` 独立复跑 329+57；AC1/AC7 逐条成立 | 关票候选（PA-1；F2-R1-01/02/03 见 §1 AC4 缺口） |
| #431 preview pass 签名化 T1–T4 | open | T1/T2 SATISFIED（N0）；**T3 live PASS（N2 run4）**；**T4 BLOCKED(env)（BE-3）** | N0 §四 + N2 §3 + F2 不回退五条（R1 复核） | 待 PA-1 裁决：票面完成判据允许「每项 blocked 均有环境/依赖、解除条件与去向」；T4 解除=BE-3 staging 凭据 |
| #433 sandbox /file/content absent→404 | open | **N0 SATISFIED（静态+契约）**；AC4/AC5 端到端症状链由 N2 #437 主链同链覆盖（脚本 mount 注入 + `/<label>` 200 + 渲染） | N0 §五 + agent-sandbox 41/41（N0 §八 行6）；N2 run4 主链/degrade | 关票候选（PA-1） |
| #436 迁移链修复（fresh DB） | open | N1 finding→F1 修复→**verified+integrated**；R2-int 组合树复验全绿 | `verification-f1-transfer/F1-drift-report.md`（212/212、drift 0）+ `R2-int/`（212、283 表 0 漂移、boot 0×42703）；drizzle 面 75e74b8f9e→HEAD 字节一致 | 关票候选（PA-1；RLS/CHECK 边界披露见 §7） |
| #437 start 脚本 mount 注入缺陷 | open | **GAP-C 已修（F2）；真机主链/面板链/降级 A+B 全 PASS（N2 verified）** | N2 §0/§2/§5；F2 mint mount 复核 `webapp-proxy.ts:803-836`；degrade-a/b evidence | 关票候选（PA-1；F2-R1-01 移交 §7） |

### 2.2 closed 10 张（仅引用，不复核、不作证据）

#403（修复前置决策 D-1/D-2/D-4/D-5，AC6/AC8 聚合口径来源）、#420–#424、#426、#428（R01–R07/R09 修复批）、#429（续期失败告警硬要求：可导入规则与状态消费者）、#430（tls-pipeline 超时显式化）。另：根正文提及的 #359–#367（非正式子项）快照均 closed，仅作 AC 映射与回归参照——前序遗留矛盾「#359–#367 实际仍 OPEN」已随其关闭消除。

## 3. blocked(env) 清单（BE，不记为通过；与 ledger 一致）

| ID | 项 | 所需环境 | 解除条件 | 受影响 AC/票 |
| --- | --- | --- | --- | --- |
| BE-1 | #412 live：公网泛域名 ACME 签发+热加载证据 | 部署方 ACME DNS-01 提供商凭据 + staging/生产部署（票面 Out of scope） | `openssl s_client` 泛域名证书 + 换证热加载证据（复跑 `reference/tls-certs.md` Reference topology 步骤） | AC8（live 面）、#412、#359 系 |
| BE-2 | #416 same-site live | host-form server（`OPENBOT_CRAFT_PREVIEW_ORIGIN_TEMPLATE`）+ #412 参考 TLS 终止 + 主站 https 栈 | 搭栈后跑 same-site profile；同栈可复跑 dev 拓扑至 0-fail 单轮 | AC1（same-site live 步）、#416、#414 残余 |
| BE-3 | #431-T4 / AC8 staging 演练 | ACME DNS-01 staging DNS 凭据 | staging 首签/续期演练完成，T4 项证据表闭合 | AC8（staging 面）、#431 |
| BE-4 | CI 真实跑 | workflow 改动入远端（PA-3 先行） | push/合并后 GitHub Actions 实跑 migrations/nightly 等 job | #407（长稳观察）、#416（nightly 接线）、#436（CI fresh-db job） |

## 4. 待授权（PA）清单——本轮未执行

| ID | 项 | 内容 | 状态 |
| --- | --- | --- | --- |
| PA-1 | 关闭已满足验收的 open 子票 | 关票候选 16 张：#404–#411、#415、#417、#418、#425、#427、#433、#436、#437；另 #414/#431/#419 按票面完成判据交终审裁决（§2.1 各行） | 本轮未执行（零 GitHub 写入） |
| PA-2 | #358 正文：D6 旧表述修订 + 聚合收口小节追加 | **冲突记录**：#358 正文 D6 仍为「basePath 机制整体退场」，与批准 Spec `docs/specs/2026-10-15-craft-preview-origin-design.md:67`（R-6：生产根路径 + dev 形态 env basePath，2026-10-17 #403 D-3 确认）冲突。本轮按批准 Spec 记录冲突，**不静默采用旧句**；修订归 Spec 所有者 | 本轮未执行 |
| PA-3 | push / 远端合并 / PR | 集成分支与任务分支均未推送（集成分支 HEAD=d7c0dfe9c） | 本轮未执行 |
| PA-4 | 票面旧路径引用说明 | 关票评论时说明：`docs/craft-preview-origin.md` → `reference/craft-preview-origin.md`；**本轮新增两条**：`docs/plans/2026-10-23-craft-preview-404-419/closeout.md`（#358 正文引用路径）已随 af3a73e5f 文档重组删除，存续副本在 `.archive/runs/2026-10-23-craft-preview-404-419/closeout.md`；`docs/tls-certs.md` 同因迁移为 `reference/tls-certs.md` | 本轮未执行 |

## 5. N0-R1 5 条 low 订正（并入本汇编，N0 报告原文保留为历史）

| ID | 原文 | 订正（以 R1 复核为准） |
| --- | --- | --- |
| R1-01 | §四「320/320 全绿」 | 加数应为 **324/324**（147+104+24+24+17+8；=307+17 两行汇总） |
| R1-02 | §三「全仓 grep `passIndex/tokenIndex/pass_index` 无命中」 | 改「**无相关命中**」：`server/tests/multitenancy/agent-adapters.test.ts:110,115` 的 `tokenIndex` 为无关夹具（pass 路径无索引的结论本身成立） |
| R1-03 | §六 DROP/ALTER 抽查「14 个文件、22 条语句」 | 按原 pattern 复跑为 **13 文件 / 34 条**；定性（除 `0191:5-6` 两处 `DROP COLUMN` 外均为 `DROP CONSTRAINT`）不变 |
| R1-04 | §八 行8 typecheck「退出码 1」 | 退出码 **2**；错误三处 `scripts/bootstrap-local-gateway.ts:106/108/120`（补 :106） |
| R1-05 | 多处锚点偏移/标签互换 | GAP-C 论证锚点用 **`webapp-proxy.ts:1124-1137`**（current 分支 mismatch 抑制；:1025-1031 为 legacy-healed 分支）；另 :136→:140-141、:1054→:1053、preview-pass issue :117-155→:111-131/verify :133-163（以上为 N0 时点行号）。**本轮再订正**：F2 并入后行号再漂移，本汇编 §1 已按 HEAD=d7c0dfe9c 重锚（如抑制点现为 ready-gated `webapp-proxy.ts:1112-1155`、`PREVIEW_PASS_COOKIE_SHAPE` 现为 `preview-pass.ts:141`） |

## 6. 报告层更正与替代证据（按编排者指令落档）

### 6.1 N2-R1-01（sid 誊写更正）

N2 报告 §2.1 所写 run4 会话 `cs-07351b0ce6b65e7230435875 / cs-2d1fd1ed3d6feff04ce04d98` 实为 **run3** 的会话；run4 真实会话为 `cs-9c9c982ca6b0d6a9cd85e448 / cs-fafd4ff9e21127d511c8d152`（label/port 与报告一致，label=HMAC(secret, sid) 不可跨 sid 共享 ⇒ 纯誊写）。本汇编 §1 引用 run4 证据时按更正后 sid 口径；原 N2 报告保留为历史。

### 6.2 N2-R1-02（run9 级联机制更正）

N2 报告 §2.2 称 run9 十一条连带 FAIL 因「后续步骤跑在未兑换页上」、form-action FAIL 为「15s 观测抖动」——**更正**：级联即时成因是顶层入口后落在 **503 拒绝页**（`WEBAPP_NOT_RUNNING` 面，当刻会话 A dev server 未就绪），后续 fetch/WS 被拒绝页 CSP `default-src 'none'`（`refusal.ts:72`）就地拦截；form-action `violation=null` 系拒绝页无 form-action 指令的**结构性预期**（CSP3 不回退 default-src），非抖动。脚本顺序假设与「非产品回归」结论维持成立（run4/run9 互为对照）；run9 的 AC1「跨 origin」PASS 系在拒绝页 CSP 下测得，该面结论由 run4 应用页同面 PASS 支撑。

### 6.3 F2 实施报告丢失与替代证据链

原输入 `verification/F2-pass-rotation-r2-report.md` 因编排者 worktree 清理前未转移而**丢失**（流程缺陷，ledger 2026-10-24T15:42Z 披露）。本汇编改用等效证据并注明来源：①`reviews/F2-pass-rotation-r2-r1.md`（独立审核：实现内容、逐 AC 对账、329+57+typecheck 独立复跑读数）；②`receipts/worker-done-F2-r2.json`（实施者 worker_done 全文：交付范围、验证读数、遗留披露）；③检查点 `461e135bf`（已集成为 HEAD，树逐字节相同）+ 组合树日志 `verification/R2-F2-merge/`。三条 low（F2-R1-01/02/03）按 ledger 13:28Z 裁决口径引用（§1 AC4 缺口、§7）。

### 6.4 其他路径/读数订正（本轮交叉核对所得）

- R2-int 官方 runner 基线读数（craft-preview-origin 147 / pass 17 / rejection 24、guard 直跑 26、hmr 43）**仅有 ledger 2026-10-24T12:10–12:20Z 事件叙述，无独立日志工件**（`R2-int/` 只含起库/迁移/漂移/boot 日志）；HEAD 等价读数以 `R2-F2-merge/` 工件为准（329/329、57/57、guard 26）。
- 前序收口文档引用路径 `docs/plans/2026-10-23-craft-preview-404-419/closeout.md`（#358 正文同引）已随 af3a73e5f 删除；存续副本 `.archive/runs/2026-10-23-craft-preview-404-419/closeout.md`（sha256 `e87a6927…`）。归 PA-4。
- #358 正文「修复批次 #404–#419」小节统计 [x]11 / [ ]5 与前序收口表逐票核对一致（#412/#413/#414/#416/#419 未勾）；本表 §2.1 为其 2026-10-24 更新版。

## 7. 建议后续票清单（GitHub 写入待授权，本轮不创建）

1. **RLS/CHECK 边界**：0163 的 38 张 + F1 的 32 张企业/openmuse 表 pgPolicy(148)/CHECK(63) 不入迁移（0163 以来既定口径 operator territory）——如需行级隔离另立 RLS 迁移/ops 票（ledger 09:23Z 裁决披露）。
2. **19 个撞号 SQL 清理**（F-R1-3）：`server/drizzle/` 19 个未入 journal 的历史 SQL（BASE 前遗留，不影响 migrate/drift）收编或清理。
3. **F2-R1-01**：mint 对「mount 记录从未写过」会话过度拒绝 409 + 文案失实——若真实可达，扩 `readMountRecord` 返回形状区分「从未写过/空」（ledger 13:26–13:28Z + N2-R1-04 移交）。
4. **N2-R1-03**：验收脚本伪造 cookie 步 harness 缺陷（forged context 未导航即 fetch 被 CORS 拦），改「先 goto 预览 origin 再 evaluate」后补真机断言。
5. **F2-R1-03 增强**：pass 索引按会话保留最近 N 个 token 或会话删除钩子顺带清扫（内存边界，已显式接受）。
6. **MT050 execution-scope 集成漂移**（N2 §7.2）：`server/src/craft/sandbox-gateway.ts` 不发送 `x-openbot-tenant-id/-workspace-id`，全新沙箱 craft 会话 500，现以 shim 绕行——建议上游跟踪票。

## 8. 证据索引（本汇编引用）

| 证据 | 路径（`.archive/runs/2026-10-23-issue358-closeout/`） |
| --- | --- |
| N0 审计 + R1 | `issue-audit-n0-transfer/N0-audit-report.md`、`reviews-n0-transfer/N0-audit-r1.md` |
| N1 / F1 / F1-R1 | `verification-n1-transfer/N1-freshdb-report.md`、`verification-f1-transfer/F1-drift-report.md`、`reviews-f1-transfer/F1-drift-r1.md` |
| F4 / F4-R1 | `verification/F4-hmrpin-report.md`、`reviews/F4-hmrpin-r1.md`、`verification/F4-bunsuite-part5-junit.xml` |
| N2 / N2-R1 | `verification/N2-live-r2-report.md`、`reviews/N2-live-r2-r1.md`、`verification/n2live-r2/`（9 轮 + degrade-a/b） |
| F2 替代证据 | `reviews/F2-pass-rotation-r2-r1.md`、`receipts/worker-done-F2-r2.json`、`verification/R2-F2-merge/` |
| 组合树验证（R2-int） | `verification/R2-int/` |
| 状态与裁决 | `ledger.md`、`recovery/RD-20261024T1220Z.md`、`scope.json`、`issues/refresh-20261024T1215Z-*.json` |
| 汇编过程报告（本次 N3 收尾） | `verification/N3-closeout-r2-report.md` |
| 前序 Run | `../2026-10-23-craft-preview-404-419/`（`closeout.md` 于 run 根、`verification/` 逐票报告） |

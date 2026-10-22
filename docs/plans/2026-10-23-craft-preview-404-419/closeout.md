# Craft Preview 修复批次 #404–#419 收口汇总（#419 / N06）

- 日期：2026-10-23（本地 +08:00）／ 2026-10-22T20:4xZ
- 工作区：`.worktrees/craft-preview-404-419`（分支 `craft-preview-404-419`，N01–N05 波次收于 `209dd79e6b`；后续 OCR 修复轮 R1–R5 续至 `a1c5b430b1`，见 ledger.md）
- 编写：N06-419（mechanical_worker，hare）
- 证据基线：本表每行 verdict 均引用实际验证报告路径，不以本文档勾选替代测试证据。

## verdict 口径

- **implemented+verified** → 记为可勾（[x]）：票面全部仓库内 AC 有实测证据，且经主控或审计独立复跑。
- **partial / blocked** → 保持 [ ] 并括注缺口：live/环境证据缺失（blocked(env)）、上游缺陷或 GitHub 文本统一未完成者如实标注，票保持 OPEN。

## 逐票收口表

| issue | 本轮 verdict | 关键证据（验证命令+结果） | 剩余缺口/blocked | 去向 |
| --- | --- | --- | --- | --- |
| #404 | implemented+verified（主站 host admission 关闭） | `npx e2e run --config e2e.unit.config.ts`（origin 套件）124/124 →（N02 后终态）140/140；tls `bun run test:tls` 117/117 → 133/133（issue-audit/issue-404.md + summary.md §实跑总账） | 无 | 可关票（由主控/用户决定；本轮不关） |
| #405 | implemented+verified（app-only cookie 策略） | webapp-proxy 套件 104/104（issue-audit/issue-405.md，含 `forwardAppCookiePairs`/`sanitizeAppSetCookie`） | 无 | 可关票（主控/用户决定） |
| #406 | implemented+verified（mint/302 no-store+no-referrer） | webapp-proxy 104/104，测试钉住 webapp-proxy.ts:829-836 响应（issue-audit/issue-406.md） | 可选残留：反代日志脱敏 `?ticket=` 文档句（非票面 AC） | 可关票（主控/用户决定）；文档句可随手补 |
| #407 | implemented+verified（tls 套件显式超时+CI 接线） | N01 提交 `54bedd7b77`；`bun run test:tls` 117/117（空载+4 核满载四种组合）；junit driver 形态同计数；actionlint 无新告警（N01-407-report.md） | CI runner 真实负载下长期稳定性待观察（非阻塞） | 可关票（主控/用户决定） |
| #408 | implemented+verified（生产准入显式关闭） | origin 套件 124/124（preview-origin.ts:775-788 `#408` 块 + 三条 AC 测试 :508/:531/:545）（issue-audit/issue-408.md） | 无 | 可关票（主控/用户决定） |
| #409 | implemented+verified（CSP form-action/frame-src 收紧） | webapp-proxy 104/104（CSP 串 verbatim 钉住 :84-91）+ socket 14/14（`bun test`）（issue-audit/issue-409.md） | same-site 浏览器 live 证据 → 归 #416 口径（N05 实跑覆盖 AC1 语义面，见 #416 行） | 可关票（主控/用户决定） |
| #410 | implemented+verified（write-origin-guard 纵深） | guard 套件 `bun test server/tests/craft-preview-origin-guard.test.ts` 26/0（N01.5 `8a7f4fa7e3` 修复 TLS fixture 回归后；N01.5-guard-fix-report.md，RED 0/1→GREEN 26/0） | dev 形态 Origin 不可区分为已记录设计缺口（write-origin-guard.ts 头注） | 可关票（主控/用户决定） |
| #411 | implemented+verified（TLS 状态 fail-closed 准入） | preview-tls-status.ts 五 health fail-closed + compose ro 挂载；origin 124/124、proxy 104/104（issue-audit/issue-411.md） | 无 | 可关票（主控/用户决定） |
| #412 | implemented（仓库交付面）/ live blocked(env) | N04 提交 `16ac2b18d5`：preview-tls.yml + nginx 模板 + reload-watcher + start.sh + docs；`docker compose … config -q` OK、`sh -n` OK；真实容器冒烟 A1–A5/B1–B4/C1–C3/D1a–D1d 共 16 项 PASS（握手 serial 热切换、fail-closed、502 链路、websocket/SNI/重启语义）；容器全部清理 0 残留（N04-412-report.md） | AC1/AC2 公网 live 签发证据 blocked(env)——票面 Out of scope，需部署方 DNS 凭据 | 保持 OPEN；解除条件：staging/生产部署侧 `openssl s_client` 泛域名证书 + 换证热加载证据（复跑 docs/tls-certs.md Reference topology 步骤） |
| #413 | implemented（代码/Spec 面）/ 文本统一半程 | env basePath 实现+测试全绿（craft-webapp-template 套件 pass，:213/:226 basePath 用例）；Spec R-6 已写入 `docs/specs/2026-10-15-craft-preview-origin-design.md:67`（issue-audit/issue-413.md） | #364 票面 GitHub 文本已含 R-6 修订注（2026-10-17）与勾选，实测快照核对通过；#358 正文 D6 旧表述（basePath 整体退场）由本轮追加小节注明现行为 R-6 口径，完成三方一致性 | 保持 OPEN；缺口收窄为「#358 D6 修订句需 Spec 所有者正式改写」（本轮按追加式授权不动原文，已在 #358 追加小节与 #413 评论注明） |
| #414 | partial（脚本面 verified；live 面 N05 补证） | skip 已移除 + 三链断言（UI 点击 / `next-action` POST 落本会话 origin 且 200 / 截图）在案（acceptance.ts:2064-2125）；N05 live run10 Server Actions 步骤 PASS（issue-audit/issue-414.md + N05-416-report.md §1.4/§4） | AC2「action 设置 cookie → host-only」live 断言未单列（由 #405 单测面承载）；整票 live 0-fail 受 #416 同环境限制 | 保持 OPEN；解除条件随 #416 live 环境复跑（`bun run test:craft-preview-e2e`），届时补 action-cookie live 断言 |
| #415 | implemented+verified（server/sidecar golden 锁步） | N02 提交 `85dd1db1fe`：共享 fixture 16 case 双侧读取；origin 140/140 + tls 133/133 两轮 + 三连确定性 + 负向对照翻转变红 + entrypoint 生产链路（invalid fail-closed / ok 推进到 ACME 边界）（N02-415-report.md §1–§13） | 无（GitHub 勾选归本票收口，已执行） | 可关票（主控/用户决定） |
| #416 | partial（机制面 implemented；live 未达 0-fail） | N05 提交 `209dd79e6b`：TOPOLOGY profile + AC1 same-site 步骤 + nightly/`only-craft-preview-e2e` CI 接线 + docs 章节 + hmrWsUrl 拓扑 bug 修复；live dev 拓扑 10 轮实跑 **18 PASS / 6 FAIL / 2 SKIP / 1 FINDING**——FAIL 归因：分支携带 usage.tsx/$name.tsx 重复 import 缺陷（vite 崩、面板 iframe 不渲染 ×2 + 放大 FAIL ×1）、取证 evaluate 的 CSP 形态网络层拒绝 ×1、已修未复跑的 hmrWsUrl bug ×3；**same-site live = blocked(env)**（需 host-form+TLS 栈，前置已写入 docs）；产物 `.archive/runs/craft-preview/verification/2026-10-22T20-20-20/`（N05-416-report.md §2–§5） | live 0-fail：需修上游重复 import 票 + 复跑；same-site live：需 host-form server + #412 TLS 终止 + 主站 https 栈 | 保持 OPEN；解除条件：①上游开票修复 usage.tsx/$name.tsx 重复 import（N05 建议开票）；②复跑 `CRAFT_ACCEPTANCE_TOPOLOGY=dev` 至 0-fail；③搭 host-form+TLS 栈跑 same-site profile |
| #417 | implemented+verified（mount 交叉检查 + birth-sequence） | webapp-proxy 104/104（webapp-proxy.ts:964-1140 三分支 + mint 镜像 + 集成测试 :1616-1830/:2032）（issue-audit/issue-417.md） | 可选：浏览器级旧模板 e2e（非票面 AC） | 可关票（主控/用户决定） |
| #418 | implemented+verified（Option B 单副本契约显式化） | N03 提交 `c6b271feb7`：registryStats + singleReplicaStartupNotice + docs 多副本契约章节 + .env.example 块 + 6 新 case；origin 146/146（e2e）+ guard 26/26 + 全 preview-* 套件 211/211；运行时直跑导出接口逐条对账；typecheck 138=138 基线一致（N03-418-report.md） | 无（多副本 404 本身不修属 D-4 裁决） | 可关票（主控/用户决定） |
| #419 | implemented（本票即本轮收口动作） | 本文档 + #358 正文追加「修复批次 #404–#419（2026-10-23）」小节（逐票 verdict+证据链接）+ #404–#419 十六张收口评论；仓库内文档修正（tls-certs 真实拓扑、.env preview/TLS 块、domain.md 引用、cookie 门更正）经 N00 审计逐项核对 PASS（issue-audit/issue-419.md AC4）；原生子项关系已存在（358-sub-issues.json 24 项），无需补建 | GitHub 勾选/评论完成后，票面剩余动作（#359 Parent 自引用修正、#360/#361 过时评论更新）不在本轮授权与范围（#359–#367 历史行不动） | 保持 OPEN，由主控决定后续关票节奏 |

## 遗留矛盾（报告不动手）

1. **#358 既有实施 Tickets 节把 #359–#367 全部标 [x]，而 #359–#367 实际仍 OPEN**（N00 审计 issue-419.md AC1 发现）。按 Brief 本轮不动那些历史行。
2. **#358 正文 D6 仍是「basePath 机制整体退场」旧口径**，而 Spec R-6（已批准）与 #364 票面均为「生产根路径 + dev 形态 env basePath」双形态口径——三方表述统一（#413 AC1）只差 #358 D6 修订句。
3. 分支/主干携带 `app/src/routes/_authed/settings/usage.tsx` 与 `components-gallery/$name.tsx` 重复 import（vite transform 崩溃，面板 iframe 白屏）——N05 run10 归因 3 个 FAIL 至此，建议上游开票（不属本轮 16 票）。
4. `agent-sandbox` 的 execution-scope 403 门（MT050）与 `server/src/craft/sandbox-gateway.ts` 未发送 `x-openbot-tenant-id/-workspace-id` 的集成漂移（craft 会话在全新沙箱必 500，N05 以本地 shim 绕过）——与 #437 同族，建议上游跟踪。
5. server typecheck 138 个基线错误为并行 memory 域带入（stash 对账 138=138），与本轮 16 票无关（N03 报告）。

## 汇总

- implemented+verified（勾 [x]）：**11** — #404 #405 #406 #407 #408 #409 #410 #411 #415 #417 #418
- implemented（仓库交付面）但 live blocked(env)（保持 [ ]）：**1** — #412
- partial（保持 [ ] 并括注缺口）：**4** — #413（#358 D6 修订句待 Spec 所有者）#414（live action-cookie 断言）#416（live 0-fail + same-site live）#419（本票收口后留 OPEN 由主控处置）
- 统计：[x] 11 张，[ ] 5 张，合计 16 张（#404–#419）。

## 证据索引

- 审计：`.archive/runs/2026-10-23-craft-preview-404-419/verification/issue-audit/`（summary.md + issue-404..419.md）
- 节点报告：同目录 `N01-407-report.md`、`N01.5-guard-fix-report.md`、`N02-415-report.md`、`N03-418-report.md`、`N04-412-report.md`、`N05-416-report.md`、`N05-416-live-run10-summary.json`
- Ledger / DAG / Issue 快照：同 run 目录 `ledger.md`、`dag.json`、`issues/`
- live 产物：`.archive/runs/craft-preview/verification/2026-10-22T20-20-20/`
- 注：`.archive` 为本地执行证据，不外发；GitHub 评论中注明本地路径。

# Craft 预览修复波次（#403–#419）索引与决策记录 — 重建件

> **来源与诚实声明**：本文件是从 GitHub 票面**重建的索引**，不是被覆盖的原件。
> 原波次计划文档位于同一路径族（`docs/plans/2026-10-17-craft-preview-*.md`），已于 2026-10-17 19:24:46 被另一会话的写入覆盖且事前未读取。已核实的不可恢复证据：`git log --all --diff-filter=A -- docs/plans/craft/preview/2026-10-17-craft-preview-remediation.md` 为空（从未提交到任何 ref）；APFS 本地快照列表为空；`~/.qoder/file-history` 无该文件条目；全盘 3 处同名文件哈希与 mtime 均为覆盖后那份的下游同步。
> 唯一残余可能：写它的会话自身上下文。
>
> 记录时间：2026-10-17（UTC 12:2x）。代码基线：`origin/main` = `44754feb`。

## 1. 为什么需要这份索引

#404–#419 的正文用 **`CP-NN`** 局部编号互相声明依赖（例：`Dependencies: CP-03, CP-04, CP-08, CP-09, CP-10`）。经全量扫描（`gh issue list --json number,body` + 正则 `CP-\d+`）确认：

- **没有任何一张票声明自己的 CP id**，CP-NN 只出现在引用位；
- 出现过的编号集合为 `CP-00`…`CP-15`（#419 写「CP-00 至 CP-15」，共 16 个，与 #404–#419 的 16 张实现票数量吻合）；
- `CP-00` 被绝大多数票依赖，语义上即 #403 那张已 CLOSED 的前置决策票（**这是推断，非票面事实**）。

结论：**CP-NN ↔ Issue 编号的映射表只存在于被覆盖的那份文档里**，现在是悬空引用。执行任何一张票前必须先向原作者或本索引确认映射；不要按本文件的猜测开工。

## 2. 前置决策记录（#403，CLOSED / COMPLETED @2026-10-17T11:48:22Z）

| 决策 | 候选 | 票面记录的选择 |
|---|---|---|
| D-1 生产 dev 形态 | 生产空模板关闭 / appUrl loopback 自动判定 / 显式 DEV 开关 | **显式 DEV 开关 + 生产默认关闭** |
| D-2 TLS 终止层 | 外部 ingress / 仓库 Caddy-nginx / Bun TLS | **外部 ingress 为主，仓库提供 compose 参考** |
| D-3 basePath R-6 | 批准显式 env basePath / 维持原 D6 完全退场 | **批准 R-6 并回写 #358/#364** |
| D-4 多副本 | 单副本-sticky / DB label + Redis ticket | **仅在生产要求 HA 时做共享存储** |
| D-5 主站 API CSRF | Origin 白名单 / CSRF token | **先做 Origin 白名单，覆盖 `/api/craft/**`** |

#403 的说明一节规定：决策完成前不把实现票标 `ready-for-agent`。现状：#404–#419 全部 OPEN，多数带 `ready-for-agent`。

## 3. 实现票索引（16 张，全部 OPEN，全部是 #358 的正式子 Issue）

| Issue | 级别 | 覆盖 AC | 票面 Dependencies | 一句范围 |
|---|---|---|---|---|
| #404 | P0 | AC6 / M-1 | CP-00, CP-10 | 拒绝会吞掉主站的 preview 模板基座 |
| #405 | P1 | AC2 | — | preview 代理只剥平台 pass、转发应用自有 cookie 并安全处理 `Set-Cookie` |
| #406 | P2 | AC4 | — | 票据响应 `no-store`、`Referrer-Policy` 与日志脱敏 |
| #407 | P2 | AC8 | — | TLS 测试超时与 CI 稳定性 |
| #408 | P0 | AC6 | CP-00, CP-05, CP-06 | 生产空模板/缺 preview 域名时显式关闭 |
| #409 | P0 | AC1 | CP-00, CP-04 | CSP 增 `form-action`、收紧 `connect-src`、统一 AC1 语义 |
| #410 | P0 | AC1 | CP-03, CP-11 | 主站 cookie 认证的写接口拒绝 preview Origin（D-5 落点） |
| #411 | P0 | AC6/AC8 | CP-00 | server 读 `renewal-status` 并在证书不可用时关闭 |
| #412 | P0 | AC8 | CP-05 | 交付 preview 域名 TLS 消费与续期热加载（票面已记 `tls: []`、`reload.sh` 无消费者） |
| #413 | P1 | D6/AC2 | CP-00 | 落地 basePath R-6 决策并统一 #358/#364/实现 |
| #414 | P1 | AC2 | CP-03, CP-08 | 验证并修复 preview origin 下的 Server Actions |
| #415 | P1 | AC6/AC8 | CP-02 | server 与 ACME sidecar 模板校验统一 |
| #416 | P1 | AC1–AC3, AC5 | CP-03, CP-04, CP-08, CP-09, CP-10 | 可复跑全栈 e2e（same-site 拓扑 + HMR + Server Actions） |
| #417 | P2 | AC7 | CP-11 | legacy 手工装配/根挂载消除静默 404 |
| #418 | P2 | AC4/AC9 | CP-00 | 多副本 ticket/label 状态共享或单副本契约（D-4） |
| #419 | P2 | 全部 | CP-00 … CP-15 | Issue/文档证据收口与 #358 验收汇总 |

## 4. 与另一轨（#420–#430，本会话所建）的关系

双轨并存期间（2026-10-17 用户决定）的归属登记，均已写入各票正文与关闭评论：

| 本轨票 | 已并入的主票 |
|---|---|
| #420 R01 | #412（另涉 #411） |
| #421 R02 | #408（按 D-1 改写，保留「禁用 `NODE_ENV`、兜底复用 `reachOf`」两条硬约束） |
| #422 R03 / #424 R05 | #416 |
| #423 R04 | #413 |
| #426 R07 | #409 |
| #428 R09 | #415（锁步）+ #406（acme 输出脱敏） |
| #429 R10 | #411 |
| #430 R11 | #407 |
| **#425 R06** | **保留独立 OPEN**：legacy 同源预览的部署级开关（CP 波次无对应项；#417 是另一问题）→ 拆解见 `docs/plans/craft/preview/2026-10-17-craft-preview-issue-425-legacy-preview-gate.md` |
| **#427 R08** | **保留独立 OPEN**：通行证改为不透明 token + 索引 → 拆解见 `docs/plans/craft/preview/2026-10-17-craft-preview-issue-427-opaque-pass.md` |

9 张关闭票使用 `state_reason=duplicate`（该仓库/API 版本未暴露原生 `POST /issues/{n}/duplicate`，返回 404），因此 GitHub UI 不显示 "closed as duplicate of" 自动链接，归属在关闭评论与票面「与并发票集的关系」一节。

## 5. 待办（本索引自身遗留）

1. **确认 CP-NN 映射**：由原作者会话或用户给出 `CP-00…CP-15 → #403…#419` 的对照，否则每张票的 `Dependencies` 无法机械求解。第 1 节的 `CP-00 = #403` 是推断，未经确认。
2. **裁决 #403 说明纪律与现状的偏差**：票面规定决策完成前不打 `ready-for-agent`，而 16 张实现票当前均带该标签。
3. **两轨的串行约束**：#425 与 #427 同写 `server/src/craft/webapp-proxy.ts` 与 `CraftConfig`，且 #427 与 #405 相邻（都碰 header hygiene）；#425 与 #417 相邻（都碰 legacy）。开工前按 `AGENTS.md`「可写文件不重叠才并行」排程。
4. **共同前置**：用户工作树 `main` 落后远程且不含本波实现（`server/src/craft/preview-origin.ts` 等文件不存在），任何实现票开工前需先把工作树推进到含 `44754feb` 的基线。

# Verification Summary：OpenBot 上游能力更新（UP-SPEC #489）

日期：2026-10-21。工作区：`.worktrees/upstream-openbot-update`（分支 `upstream-openbot-update`，BASE `3b4a7c68132c3507300408346a44fb9d56f3c14c`，未提交交付）。授权：用户 2026-10-20 执行提示词（本地实施；无 commit/push/merge/发布授权）。OCR 按用户 2026-10-20 指示取消（Ruling OCR-waive；此前完成 S01 r1、S02 r1/r1b 共 3 轮，产出 S02-F1 有效修复）。

## A01–A12 验收绑定

| AC | 结果 | 证据（命令/执行数/报告） |
|---|---|---|
| A01 无 hostname 拒绝 | **verified** | S01：V-N config+single-user 169/169（三跑）；`reachOf` 空值守卫；`evidence/s01/*` |
| A02 参数秘密 OTLP 不泄漏 | **verified** | S02：enterprise-controls 58/58 + otel wire 1 pass + 邻域 23/23；S02-F1 修复 mysql `i` 标志（票据明文要求区分端口/密码）；`evidence/s02/*` |
| A03 MIME charset/HTML 引用 | **verified** | S03：responsibility-triggers 34/34；QP/base64×charset、单层引用、plain 不改写；`evidence/s03/*` |
| A04 重复分钟去重 | **verified** | S04：routine-schedule 29/29；next-occurrence 零改动；`evidence/s04/*` |
| A05 屏幕开屏/撤回 | **verified** | U01：announcement 14 + auto-watch 16 + activity 回归 13（Ruling U01-R1 显式 allowlist）；`evidence/u01/*` |
| A06 对话连接闭环 | **verified** | U02+U03：codec 11/11 + connect-route 5/5 + integration 16/16 + card 15/15×3；信封剥离 F-07 闭环；`evidence/u02/*`、`evidence/u03/*` |
| A07 工具摘要可展开 | **verified** | U04：tool-activity 18/18（95 expect）+ 回归 27/65；`evidence/u04/*` |
| A08 密码→验证码全链路 | **verified** | L01+L02+L03：Chromium 18/18 + native 36/36 + integration 3/3（0165 fresh+upgrade）+ app 12/12；L02-F1 throw 分流修复；秘密零泄漏断言全套；`evidence/l0{1,2,3}/*` |
| A09 3 秒非阻断诊断 | **verified** | D01：两 suite 35/35；分类矩阵 fake 证据；index.ts +54 纯追加；`evidence/d01/*` |
| A10 三 provider 研究闭环 | **verified（后端 live-key 轮 BLOCKED）** | R01+R02+R03+F1：research 13/13 + catalogue 63/63 + native 27+2skip + integration 147/147 + selection 25/25 + tool-name 27/27 + tool-activity 27/27；**真实 key live 联调 2 例 skip-with-reason（无凭据，BLOCKED 待持 key 补跑）**；`evidence/r0{1,2,3}/*` |
| A11 集成验收/回滚/审查 | **本文件（V01）** | 见下节 V-ALL/企业回归/回滚/终审 |
| A12 移动端/harness/toolkit 去重 | **verified** | E01：adoption-decisions.md 六项结论（mobile 延期、Antigravity 延期不旁路、harness 机制采用、toolkit 延期+映射 Mastra、既有 4 项不重复建票、矩阵 3 误判修正）；reviewer 亲验证据；`evidence/e01/*` |

## V-ALL（已完成，全部归属）

- **audit：exit 0**（no gaps；BASE 为 exit 1/13 缺口，经 Ruling U03-W1 修复转绿——13 文件以 driven 登记而非 import 交换）。
- **test:ci：exit 1**——本批 29 个任务套件在 V-ALL 内全部 ✓（native 直列 + driven part 1–4 组）；红组全部归因：①DB/环境依赖（503 服务未起、WORKSPACE_FORBIDDEN、credits 门、端口 3001/3002 冲突——.env 驱动）；②agent-langgraph/tests 与 agent-mastra/src 两组 worktree 未装依赖——**已装依赖后复跑双双转绿**（langgraph 14/14 native、mastra 组 ✓）；③ai-observability（登记 BASE 红）。桌面/worker/共享层全绿。V01 期间另证：billing-credits-ui 与 group-people 在主 checkout（BASE 代码+同 .env）同红（环境依赖基线红）。
- **typecheck：exit 2，仅 3 条 bootstrap-local-gateway TS2339（BASE 红，文件零触碰）**；app/agent-computer/worker/desktop 全绿。
- **lint：exit 1**——repo 级 lint 在 BASE 即红（主 checkout 949 错/1636 警）。**本批改动文件 BASE 对照计数完全一致（4 错 5 警，含 channels.json 重复 people 键、$channelId.tsx 未用 import、index.ts console——全部 BASE 既有），本批新增 lint 零**。
- **build：exit 2，仅因同 3 条 BASE TS 错（server tsc）**；app/worker build 成功。
- 注：主 checkout 已被并行会话污染（manifest/known-broken 有未提交改动：476 driven/7 排除），不可作严格 BASE 计数源；严格 BASE 测量采用 git-HEAD 临时 worktree（U03-W1/W04-OBS1 轮已做）。

## 企业回归（V01 第 2 步）

**环境阻塞（如实登记）**：`enterprise-test-db.ts migrate` 被自带 fresh-setup 守卫拒绝（"setup URL is not the fresh setup-only database"）——与持久 memory 记录的配方漂移一致（0163 三表 RLS/GRANT 需重放、MT005 门槛致企业 runs 红）。修复需全新 setup 库 + 角色重配（触共享 .env/共享测试库，超出本轮常规修复边界）。**补偿证据**：本批企业邻接行为在 fixture 库绿（plugin-store integration 147/147 含两范围/撤权/写拒；R02 治理 6 用例；U02 integration 16/16）；受影响红组全部为 BASE 套件、零本批文件。企业全栈回归留待环境修复后补跑（下一节待办 6）。

## 回滚与兼容

- DB：0165 expand-only；fresh（166 entries）与 upgrade（旧数据保留→旧约束拒新态→仅应用 0165→166）双演练；回滚步骤=停新入口→排空/终结 code_required 与在途 filling→保留扩展 schema 回滚应用（runbook 注释在迁移文件内）。
- 登录组件组合：旧 API+新 Computer（codeRequested 附加字段）✅ L01；新 API+旧 Computer（密码路径可用）✅；新 API+旧 UI（旧 code 忽略+提示刷新）✅ L02/L03；新 UI+旧 API＝不支持组合（发布约束记录）。
- 研究回滚：禁用新 provider 即回原 Parallel（grants/audit 不删）；诊断去掉装配即可。

## 最终独立 Review

- **server/shared 域：双 pass**（`evidence/v01/final-review-server.md`）——跨任务三层叠加正交无破坏；I2–I5 两端一致；秘密边界全局 grep 干净；11 组 seam 复跑全绿。F-1（Medium，e2e.unit.config.ts 无人认领的内联排除）已处置：根因=agent-langgraph 依赖未装（环境），装依赖后该套件 native 14/14，内联 hack 已还原为 BASE 干净状态。
- **app 域：双 pass**（`evidence/v01/final-review-app.md`）——U03+U04 管线叠加、U04+R03 StepKind 扩展、locales 无键冲突（biome 所报重复键经 BASE 对照为既有）；I1 两端一致；3 个跨任务 seam 全绿。zh 英文回退两处经 `git show BASE:` 复核为 BASE 行为形态，记 L-1 待办。

## 延期/阻塞/待办清单

1. **BLOCKED**：真实 key 研究联调 2 例（Exa/Firecrawl live listing）——需持 key 轮补跑后 A10 后端才算完整闭环。
2. **待办（低）**：R03 F4——两处 zh 英文回退（chat-transcript.tsx:1390、bot-profile/access.tsx:53）补 labelKey；U01 F1——路由层 busy 无测试钉住；L03 F2——错误路径 409/500 stub 用例与双 role=alert 去重。
3. **Spec 修订候选**（U02 F-05 收窄版）：动态注册 noClient/unusableClient 两臂是否加连接卡片。
4. **后续票**（L02 F1-R1）：HumanHasControlError 细化分类（现落 failed-unknown，保守）。
5. 企业多租户全栈回归：**环境阻塞**（见上节）——需全新 enterprise setup 库+角色重配后补跑。
6. agent-langgraph / agent-mastra worktree 依赖已补装（V-ALL 红组转绿）；后续 checkout 需注意 workspace 子包安装。

## 最终变更范围

（V01 收尾时回填：全 tracked diff 文件数/行数、untracked 清单+SHA-256、fixture 库清单）

## 交付上线（2026-10-21）

- commit/push/merge 已获用户授权并执行：origin/main = **9d2251b3**（交付 c081ec50 + 两次 merge main + OCR 修复 V01-F..F5 + 迁移 0182 重编号 + manifest 修正）。
- OCR 循环：全范围 1 轮 + delta 3 轮 + 终轮按建议原样修复；本批无未决 critical/high/medium；main 侧 finding 全文（evidence/v01/ocr-final.txt）建议转交 wave3 各工作区所有者。
- 仍未授权：生产迁移/部署/对外发布/关闭 Issue/向上游反馈。

## 原下一步所需授权（已执行部分划掉）

~~git commit / push / merge~~（已完成）；生产迁移 / 部署 / 发布 / 向上游反馈（S02-F1、U03 OBS-1 等）仍待授权。

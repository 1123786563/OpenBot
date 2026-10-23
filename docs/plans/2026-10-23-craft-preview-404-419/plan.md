# Craft Preview #404–#419 收口实施计划（2026-10-23）

- Run: `.archive/runs/2026-10-23-craft-preview-404-419/`（主工作区；Issue 快照、DAG、Ledger）
- 执行工作区：`.worktrees/craft-preview-404-419`（分支 `craft-preview-404-419`，BASE = `origin/main` = `569c8e5054`）
- 根 Issue：#358（已批准 Spec）｜ 范围：其原生子 Issue #404–#419（16 张）
- 决策事实源：#403（CLOSED，D-1～D-5 已定）；Spec `docs/specs/2026-10-15-craft-preview-origin-design.md`
- 提交授权：允许 Worker 按任务本地提交（用户指令）

## Global Constraints

1. 主工作区正处于未完成合并（MERGE_HEAD + 290 个修改文件），一律只读；一切改动在执行工作区进行。
2. 已实现票不重派：N00-audit 出具代码级验收报告后直接标 verified（issue-delivery.md 禁止重派已完成任务）。
3. 环境依赖验收（live TLS、真实浏览器栈）如实记录 blocked(env)，不伪造证据。
4. Worker 不再派发子 Agent；Review 由主控统一安排。每 Worker 一份 Brief，含 owned_files 与提交策略。
5. 长日志与 diff 写 Run 目录；消息只报结果、阻碍与检查点。

## 波次

- **Wave 1（并行）**：N00-audit（researcher，只读）｜N01-407（backend_implementer）｜N02-415（backend_implementer）
  - owned_files 检查：N00 只写 .archive；N01 写 `scripts/tls-pipeline.test.ts`+`package.json`+`.github/workflows/ci.yml`；N02 写 `server/tests/craft-preview-origin.test.ts`+`scripts/tls-pipeline.test.ts`+`docker/compose/certs/lib.sh`+`scripts/fixtures/tls-template-golden.json`。
  - **冲突裁决：N01 与 N02 都写 `scripts/tls-pipeline.test.ts` → 串行：N01 先行，N02 后行**（execution.md：两个 Task 写同一文件必须合并所有权或先拆接口；此处按串行解决）。故 Wave 1 = N00 ∥ N01，N02 在 N01 verified 后启动。
- **Wave 2（并行，无文件交集）**：N03-418（preview-origin.ts/index.ts/docs）、N04-412（docker/compose/preview-tls*、reference/tls-certs.md）
- **Wave 3**：N05-416（依赖 N00 的缺口清单）
- **Wave 4**：N06-419（依赖全部前序 verified）

## Task N00-audit — 16 票代码级验收审计

- 角色：researcher（只读业务代码）
- owned_files：`.archive/runs/2026-10-23-craft-preview-404-419/verification/issue-audit/issue-{404..419}.md`（写主工作区 Run 目录）
- 步骤：逐票读票面 Acceptance → 在执行工作区（569c8e5054）核对实现与测试 → 实跑可跑的单测（server craft 系列用 `cd server && bun test tests/craft-*.test.ts`）→ 输出 verdict + 证据表
- 预期结果：#404/#405/#406/#408/#409/#410/#411/#413/#414/#417 implemented-verified；#407/#412/#415/#416/#418/#419 列出精确缺口
- 失败处理：环境阻塞写 blocked(env) + 复现条件
- 验收：每条结论有 file:line + 测试命令 + 实跑退出码

## Task N01-407 — TLS 测试超时与 CI 稳定性

- 角色：backend_implementer；RED→GREEN：先在默认 5s 超时下复现（或记录机器差异），再修
- owned_files：`scripts/tls-pipeline.test.ts`、`package.json`、`.github/workflows/ci.yml`
- 步骤：1) 为慢用例加显式 per-test timeout（区分超时与产品失败的错误文案）；2) package.json 增加 `test:tls` 脚本（显式 --timeout）；3) CI（ci.yml）接入该命令；4) 不删任何断言
- 验收（票面 AC）：默认命令稳定全 pass；失败可区分超时 vs 产品失败；117 用例覆盖不降
- 提交策略：完成后单提交 `test(tls): #407 显式超时与 CI 接线`

## Task N02-415 — 模板校验统一（golden fixture）

- 角色：backend_implementer；依赖：N01 verified（同文件串行）
- owned_files：`server/tests/craft-preview-origin.test.ts`、`scripts/tls-pipeline.test.ts`、`docker/compose/certs/lib.sh`、`scripts/fixtures/tls-template-golden.json`（新）
- 步骤：1) 建 `scripts/fixtures/tls-template-golden.json`（覆盖 `*`、`..`、`a-.b`、IDN、userinfo、端口 0/70000、localhost、单标签基座）；2) server 侧测试读 fixture 断言 open/closed/derived；3) sidecar（lib.sh `derive_preview_host`）同步拒绝空中间 label；4) tls-pipeline 测试读同一 fixture；5) CI 同跑两侧（借 N01 的 test:tls）
- 验收：两侧对同一 fixture 结论一致；`*` 不产生不可解析 host；`..` 不触发签证书；CI 同跑
- 提交策略：单提交 `feat(tls): #415 server/sidecar 模板校验 golden 锁步`

## Task N03-418 — 多副本单副本契约（Option B）

- 角色：backend_implementer
- owned_files：`server/src/craft/preview-origin.ts`、`server/src/index.ts`、`reference/craft-preview-origin.md`、`.env.example`、`server/tests/craft-preview-origin.test.ts`（只追加新 case 段）
- 决策依据：#403 D-4「仅在生产要求 HA 时做共享存储」→ 选 B：文档+启动检查显式化
- 步骤：1) 启动日志/健康面提示「preview label registry 是进程内状态，多副本需 sticky 或单副本」；2) reference/craft-preview-origin.md 增加多副本章节（不静默 404 的含义与排查）；3) .env.example 注释；4) 新测试：启动提示存在且不误报
- 验收：文档明确；启动检查可观察；不引入 Redis/DB 迁移；现有测试不回归
- 提交策略：单提交 `feat(craft): #418 单副本 preview 契约显式化`

## Task N04-412 — TLS 消费参考交付

- 角色：backend_implementer
- owned_files：`docker/compose/preview-tls.yml`（新）、`docker/compose/preview-tls/`（新目录，nginx 参考配置）、`reference/tls-certs.md`
- 步骤：1) nginx 参考配置：挂 `./tls`、监听 reload.stamp（inotify 轮询 SIGHUP）、代理到 server；2) compose 文件（独立 project 名 openbot-preview-tls）；3) reference/tls-certs.md 增加真实拓扑章节与可复跑步骤；4) `docker compose -f preview-tls.yml config` 校验
- 验收：配置存在且 config 校验通过；文档步骤可复跑；live staging 证据标注为部署方输入（票面 Out of scope 保留）
- 提交策略：单提交 `feat(deploy): #412 preview TLS 终止参考拓扑`

## Task N05-416 — 全栈 e2e 收口

- 角色：backend_implementer；依赖：N00-audit（缺口清单）
- owned_files：`scripts/craft-preview-acceptance.ts`、`package.json`、`reference/craft-preview-origin.md`
- 步骤：1) 按 N00 缺口补 same-site 拓扑 profile（env 驱动）；2) 确认无 AC 关键 skip；3) 尝试 live 运行（Casdoor :8000 + sandbox :4300 + server :3221 + app :3220），不可得则记录 blocked(env) 与前置条件；4) artifact 路径落到 Run 目录
- 验收：脚本可复跑或阻塞如实记录；无 AC 关键 skip；证据可追溯
- 提交策略：单提交 `test(craft): #416 same-site e2e profile 与无 skip 收口`

## Task N06-419 — 证据收口与 #358 汇总

- 角色：mechanical_worker；依赖：全部前序 verified
- owned_files：`docs/plans/2026-10-23-craft-preview-404-419/closeout.md`（执行工作区）；GitHub 写：#358 正文勾选修正、各子票收口评论
- 步骤：1) 汇总各节点验证报告成逐 AC 证据表；2) 修 #358 正文 [x] 与实际状态一致（implemented→勾选+证据链接；partial→保持未勾+缺口）；3) 子票逐张评论证据与去向（不关票，除非用户授权）；4) closeout.md 归档
- 验收：状态、AC、证据三方一致；不以文档勾选替代测试证据（表里每行有验证命令引用）
- 提交策略：单提交 `docs(craft): #419 证据收口汇总`

## 集成与 Review

- 每节点 verified 后由主控把该节点提交留在执行工作区（同分支串行前进，天然集成）。
- 全部完成后在执行工作区跑：`cd server && bun test tests/craft-preview-origin.test.ts tests/craft-webapp-proxy.test.ts tests/craft-preview-rejection.test.ts tests/craft-preview-ticket.test.ts tests/craft-preview-pass.test.ts tests/craft-preview-origin-guard.test.ts` + `bun test ../scripts/tls-pipeline.test.ts --timeout 30000` + `bun run typecheck`（server）。
- OCR：`ocr review --audience agent --background "..." --from 569c8e5054 --to HEAD --output <run>/ocr/final.md`（若 ocr 不可用按 Skill 升级要求处理并记录）。
- finding → 修复 DAG → 复审，直至无有效 critical/high/medium。

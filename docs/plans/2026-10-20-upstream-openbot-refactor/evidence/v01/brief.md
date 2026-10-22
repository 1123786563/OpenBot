# Task Brief V01：集成验收、回滚演练与最终审查（主控执行）

- **Task/AC**: V01 / A11。正式 Issue：[#501](https://github.com/1123786563/OpenBot/issues/501)（本地票 `docs/tickets/upstream-openbot-update/issues/up12.md`）。
- **owner_role**: coordinator（主控）；backend_validator/frontend_validator/reviewer 只读分项验收。**前置**：S01–S04、U01–U04、L01–L03、D01、R01–R03、E01 全部 verified 且检查点已集成当前 workspace。
- **产物**：`verification-summary.md`、`rulings-consolidated.md`（或直接引用 ledger §7）、最终 Review 报告——均在 `docs/plans/2026-10-20-upstream-openbot-refactor/`。

## 步骤

1. **A01–A12 逐项绑定**：从 ledger §5 任务表取每个 AC 的检查点/命令/实际执行数/报告路径，写入 verification-summary.md；缺结果保持 pending/blocked，不用"局部已过"代替整项。
2. **企业回归**：两公司、同公司两团队、个人与公司 Payer、撤权/停止/审批恢复、同 Bot 并发；普通聊天、审批、Craft 预览、未审核记忆不可召回——跑现有企业/多租户套件（DB 环境按 memory 配方：先判 :5435 企业库是否需重放 0163 三表 RLS/GRANT；不行则新建库+全迁移+按 enterprise-test-db 配方初始化）。环境确实不足的项明确 blocked+证据，不伪造通过。
3. **V-ALL**：
   - `node scripts/e2e-coverage-audit.mjs`（预期 exit 0——U03-W1 已修复 13 缺口）
   - `E2E_UNIT_OUTPUT=.e2e/upstream-v01 bun run test:ci`（已知基线红清单见 ledger：multitenancy DB 环境红、ai-observability、billing-credits-ui 环境红等——逐项核对"非新增红"，影响验收的须解决或 blocked 记录）
   - `bun run typecheck`（bootstrap-local-gateway 3 条 BASE 红——登记，非本批引入）
   - `bun run lint`
   - `bun run build`
   - desktop 包需先 `bun install`（worktree 未装）。
4. **回滚与兼容矩阵**：DB fresh/upgrade 演练引用 L02 证据；登录组件组合（旧 API+新 Computer、新 API+旧 Computer、新 API+旧 UI）按计划 §7 矩阵验证或登记约束；回滚步骤（停新入口→排空 code_required/filling→留扩展 schema）文档化核对。
5. **最终独立 Review**：reviewer 对**全量未提交增量**（BASE→工作树）做 Spec compliance + code quality 终审（可用分域 reviewer：server/app/shared 三域），有效 finding 进编号修复循环。
6. **收尾**：verification-summary.md 汇总：完成/延期/阻塞清单、迁移与兼容证据、回滚证据、审查状态、最终变更范围（全 tracked diff + untracked 清单 + SHA-256）、下一步所需授权（提交/推送/合并/发布均不在本次授权内）。OCR 已按用户 Ruling OCR-waive 取消——在 summary 中如实记录该裁决与已完成的 3 轮 OCR 结果。

## 禁止

- 不修改业务/测试源（发现缺陷→编号修复循环，不由验证者修）；不 commit/push/merge；不宣称生产上线就绪（仅"可审阅交付包"）。

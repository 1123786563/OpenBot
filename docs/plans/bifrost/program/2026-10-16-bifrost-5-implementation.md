# Bifrost-5 实施（Issue #5 → #207–#357）编排计划

> **For agentic workers:** 本计划由 coordinator（Orca Run `run_f470ca949934`）按波次执行。每个 Ticket 派发给独立 worktree 中的 Pi 实现者（`orca orchestration worker-start --agent pi --worktree new-child`），验收采用"coordinator 验证 + 独立 Pi reviewer 只读审阅 + 检查点集成"三道门。步骤用 checkbox 跟踪于 Ledger。

**Goal:** 在隔离 worktree 中实施父 Issue #5（Bifrost 模型访问、短期虚拟 Key 与严格积分计费）及其全部 151 张实施 Ticket 的生产代码、测试与文档，达到 AC01–AC19 逐条可核验证据。

**Architecture:** OpenBot 为积分台账/授权/预留/结算权威，Bifrost 为供应商接入与执行层；供应商调用前必须经 OpenBot 同步原子预留，之后幂等结算。付款方固定：公司工作台=公司账户（ADR 0004），外部 Bot 个人授权=个人账户（ADR 0002/0003）；余额不足不切换账户。

**Tech Stack:** TypeScript (Bun runtime)、PostgreSQL (Drizzle)、bun test；测试库经 `TEST_DATABASE_URL` 强制专用库（见 `server/tests/support/database.ts`）。

## Global Constraints（每个 worker 的隐含要求）

- 事实源：GitHub 票正文（`docs/plans/bifrost/program/2026-10-16-bifrost-5-dag.md` 附录 + `.omc/research/bifrost5/tickets.json` 快照）、`docs/specs/2026-10-14-bifrost-integration-design.md`、`docs/specs/2026-10-14-bifrost-github-spec.md`、ADR 0002/0003/0004、`CONTEXT.md`。冲突时以 Spec 为准。
- 跨 Spec 裁决（用户确认"采用 ADR 0004"）：公司工作台固定公司付款账户；外部 Bot 个人授权固定个人付款账户；余额不足不切换；个人 Key 不授予公司内容/业务工具权限；保留公司财务历史。
- 禁止事项（用户授权边界）：**不 git commit / push / merge；不 stash 共享协调；不清理生产数据；不部署；不启用网关能力；不发布**。清理类 Ticket 只做盘点/dry-run/哈希核对/专用测试库演练。
- 测试数据库：每个 worker 用独立库 `openbot_b5_<ticket号>`（从主 checkout `.env` 的 DATABASE_URL 推导、替换库名、先 createdb）；禁止使用 `openbot`（live）与共享测试库。
- TDD：RED → GREEN → REFACTOR；SQL 事务保证不得用内存 mock 替代；skipped 测试不算通过证据。
- 未知价格/不可强制上限/缺可靠 usage 的路径保持不可用并写明原因；不以 Bifrost 原生周期预算代替严格积分准入。
- Key 明文不进前端响应、聊天内容或普通日志。

## 事实快照（2026-10-16 摄取）

- 父 Issue #5：正文已全读；2 条评论；正式 sub-issue 100 张（#207–#306）+ 评论索引 #307–#357 共 51 张 = **151 张**，全部 OPEN。
- DAG 验证：无环、无重复、无遗漏、无票集外依赖；roots = #207、#209、#215、#234；22 组；31 波（见附录）。
- 差异记录：#352 原生 blocked_by 为 20 项，评论索引多写 #214；以原生为准。
- 范围外：#369–#375（BP01–07）挂公司多租户 Spec #6，仅作接口引用。

## 调度协议

1. **解锁条件**：Ticket 的全部 blocked_by 已"验证 + 独立审阅通过 + 检查点集成到集成分支基线"后即解锁，不等整波。
2. **文件所有权**：以票面 `Write scope` 为准；#215（PayerRef）为共享账务契约唯一所有者，先于其他账务消费方固定契约。两个任务 Write scope 可能触碰同一共享文件（如 `server/src/config.ts`）时，Task Brief 明确分段所有权；worker 越界需求必须经 `ask` 上报，不得直接改。
3. **派发形式**：`orca orchestration task-create --spec <自足 Task Brief> --deps <前置 task_id 数组>` + `orca orchestration worker-start --task <id> --worktree new-child --name b5-<ticket> --agent pi --json`。
4. **Task Brief 结构**：票正文全文 + 编排纪律段（角色/环境准备/允许范围/禁止/验收命令/报告路径 `.omc/reports/b5-<n>.md`/worker_done 要求）。
5. **结算**：`worker_done` 后 coordinator 核实 Dispatch、验收测试证据、安排独立 Pi reviewer（只读，同快照）出 Spec 合规 + 代码质量两结论；有效 finding 回派实现者修复并复审。
6. **检查点集成**：每票验收通过后，coordinator 从 worker worktree 显式转移增量（diff + 未跟踪文件 + 哈希核对）到集成分支工作区；不把空 BASE..HEAD 当作已审查。
7. **终局**：全部 Ticket 集成后（组 22 的 #352–#357 是交付验收票）安排最强档 Pi 全范围审阅 + 外层 OCR（`--audience agent`，BASE→HEAD + workspace 未提交范围），修复并复审直到无有效 critical/high/medium。

## 验收命令模板（worker 通用）

```bash
cd server && bun install && bun run typecheck
TEST_DATABASE_URL="postgres://<从主 .env 推导，库名 openbot_b5_<n>>" bun test tests/<本票相关文件>
```

## Task 状态跟踪

见 Ledger：`.archive/runs/legacy-plans/ledgers/2026-10-16-bifrost-5-ledger.md`（每票：source_issues / acceptance / depends_on / 角色 / 文件所有权 / 接口 / 验证 / 状态 / 检查点哈希 / dispatch 与 worktree ID）。

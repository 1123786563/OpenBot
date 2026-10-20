> 路径约定：下文代码、命令及产物路径相对仓库根目录；Markdown 链接相对本文。

## 附录 C：Issue 完成与人工审核同步（T1/T8/T9）

标签固定为 `agent:ready-for-review`，含义为“Code Agent 已完成实施及自动审查，等待人工审核”，不代表人工已批准或 Issue 已关闭。GitHub 标签只是展示投影；Git、验收证据和 Ledger 才是事实源，不从标签反推 verified。

### C.1 逐 Issue 触发条件

该 Issue 的全部实施任务 verified、验收映射完整、产物已集成、适用测试及独立 Spec/质量 Review 通过，证据仍匹配当前需求和代码检查点。worker_done 或单个 Task 完成均不足以触发。OCR 不是逐 Issue 触发条件：完整范围 OCR 按 R6 及[主入口执行裁决](../2026-10-18-orca-dag-orchestration.md#execution-ruling)运行，子 Issue 以独立 Review 结论满足审核就绪，不等待 OCR 覆盖；若最终 OCR 或其修复使证据失效，按 C.4 撤标并更新评论。父 Issue 必须额外通过自身聚合验收，不能仅凭子 Issue 标签齐全标记。已 closed 的 Issue 不自动重开或贴待审核标签，记录 skipped_closed；需要后续实施时由协调器明确解决状态冲突。

### C.2 交付评论

包含实现摘要、逐项验收结果、测试/独立 Review/OCR 证据、提交 SHA 或未提交检查点哈希、交付工作区/PR 地址及遗留限制，并明确“等待人工审核”。未提交检查点必须说明未推送且提供持久证据位置，不伪造远程可访问链接。评论可更新为“证据失效，已撤回待审核状态”，保留原证据引用和失效原因。Issue 保持 open，人工审核及关闭遵循独立流程。

### C.3 同步协议

T8 在验收事件后写持久 outbox，再领取该 Issue 的 review_sync 声明，将 token/epoch 绑定到 outbox 后执行 GitHub 写入；纯聚合父 Issue 走同一流程。领取冲突只阻塞同步，不回退已验证业务状态，也不重新实施。按 repo + issue 串行同步，每次写入核验当前声明所有者、epoch 和 generation。幂等键包含 Issue、需求哈希、检查点哈希和 desired_ready；评论使用稳定隐藏标识 `<!-- orca-dag-review:owner/repo#number:run_id -->` 查找并更新本 Run 的评论。首次发布先写评论再添加标签；失败保留 pending/failed，只重试同步，不重新实施。标签不存在时可在已授权仓库创建该固定名称标签，保留已有同名标签定义；不得替换整组标签或改动其他标签。写入回执丢失时先读取标签与分页评论对账，未知结果记 unverifiable，避免盲目重复发布。

### C.4 失效与并发

rescan、修复或组合验证失败使证据 stale 时，在同一 Ledger 事件内递增 generation 并排入 desired_ready=false，优先移除标签，再更新评论。每次副作用前检查最新 generation，过期的添加请求取消；副作用后若发现 generation 已变，立即排入补偿撤标。撤标失败必须在 status 和最终报告显式显示“GitHub 待审核标签可能过期”，不能报告同步成功。跨 Run 的同步受仓库级 Issue 声明约束；交接必须转移未完成 outbox，不能让旧 Run 的重试覆盖新 Run。标签/评论写权限不足属于同步阻塞，不改变已验证代码事实，但未同步完成不得声称 Issue 交付同步完成。

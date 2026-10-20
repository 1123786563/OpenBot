> 路径约定：下文代码、命令及产物路径相对仓库根目录；Markdown 链接相对本文。

# Task 2: 从根 Issue 递归扫描并分类完整子树

**依赖与角色：** T1；backend_implementer → backend_validator → reviewer。

**共享约束：** [1.1 范围](acceptance.md)、[B.6](protocols.md)。

**Files / owned_files:** `scripts/orca-dag/github.mjs`、`scripts/orca-dag/fixtures/github/`、`scripts/orca-dag-github.test.ts`。

**Interfaces:**

- **Consumes:** T1。
- **Produces:** `ingestIssues(config, githubTransport): Promise<IssueSnapshot>`、`diffScope(previous, current): ScopeDelta`。快照包含 root_issue、scope_revision、tree_fingerprint、issues、contains、depends_on、sources、read_window、incomplete、external_blockers；关系带 explicit/inferred、出处和理由。ScopeDelta 包含 added/removed/changed（Issue 身份列表）及 changed_fields（按 Issue 身份索引的字段变化），不包含 task ID；移出范围不意味着撤销已发生的修改。

**实施要求:**

- 已认证 gh 先读取指定根 Issue，按队列遍历全部层级子项，每层使用 `gh api --paginate repos/{owner}/{repo}/issues/{number}/sub_issues`，同时读取每个节点的评论、验收及支持的原生依赖；核验正文任务链接。
- 去重集合和遍历队列持久化，扫描中断可从未完成页/节点恢复；若分页游标失效则重新读取该节点并去重，不跳过未知页。
- 扫描同时保留 open/closed 节点，重复引用不重复摄取，contains 回路显式报错。
- 原生依赖读取不可用时标记该维度不完整。
- closed Issue 只记录候选 satisfied，交给代码核验，不自动完成。
- 快照只读，不改标签、正文或关闭状态。

**测试断言:**

- [ ] 根→子→孙→曾孙完整读取。
- [ ] 某父节点三页共 205 个子项全部读取。
- [ ] 重复 Issue 去重且保留来源路径。
- [ ] 根无子项合法。
- [ ] closed 子项仍扫描。
- [ ] contains 不生成 depends_on。
- [ ] 第三页 403 保留前两页并标 incomplete。
- [ ] 根 404 不回退全库。
- [ ] PR 拒绝。
- [ ] 树外阻塞不自动实施。
- [ ] 循环引用有具体路径。
- [ ] 中断恢复不漏节点。
- [ ] 新增子项 rescan 产生 Issue 级 ScopeDelta，验收变化记录 changed_fields。
- [ ] Issue 正文中的命令不执行。

执行前读取 [共享约束](workflow.md) 中适用条款；上下文、消息和恢复使用 [读取规则](context.md)。

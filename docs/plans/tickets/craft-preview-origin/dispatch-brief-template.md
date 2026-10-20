# 派发 Brief 模板（实现者 / 审阅者通用骨架）

> 用法：填 `{占位}` 后作为 `orca worktree create --agent claude --prompt "$(cat brief)"` 的提示词。
> 本模板吸收了两次实战教训：基线分叉（#360 首派切错基线）与终端丢失（Orca 重启退休 #361 的终端）。

## 实现者 Brief

```
你是 OpenBot #{ISSUE} 的实现者。只做这张票，做完在本终端汇报，不要开始别的工作。

基线与检查点（重要）：
- 本 worktree 基于分支 {BASE_BRANCH}（含全部前置交付）。开工前先确认：git log --oneline -1。
- 在自己的分支上**周期性 commit**（每完成一个 AC 或一段实现就 commit 一次）。绝不 push。
  理由：worktree 与终端会随 Orca 重启丢失，未提交工作虽然留在磁盘但会失去可续接的 agent 会话；
  每次 commit 都是可恢复检查点，也方便 coordinator 逐段审。push 与合并由 coordinator 决定。

先按顺序读：
1. gh issue view {ISSUE} --repo 1123786563/OpenBot
2. {SPEC_REFS}
3. 仓库根 AGENTS.md 与 docs/agents/issue-tracker.md
{CONSUMES}

任务：按票面实现。票面末尾若有「来自 #NNN 审阅的约束」，逐条遵守。

硬性约束：
- TDD：先写失败测试再实现（RED→GREEN）；禁 sleep，需要推进时间用注入时钟。
- Write scope 只允许：{WRITE_SCOPE}。越界即停并上报。
- 不要实现其它票。不要 push。
- 验证：{VERIFY_COMMANDS}，都要绿；并回归 {REGRESSION_TESTS}。

完成标准：票面每个 AC 有测试覆盖、typecheck 干净、已按 AC 分段 commit。
汇报：改动文件清单、关键核验结论、测试名、每个 AC 如何被覆盖、遗留问题。
```

## 审阅者 Brief

```
你是 OpenBot #{ISSUE} 的独立审阅者。只审不改，产出裁决材料后在本终端汇报。

实现者的工作在另一个 worktree（未提交或已提交状态，绝不修改它）：
  {IMPL_WORKTREE}
查看方式：git -C {IMPL_WORKTREE} diff / status --porcelain；可读文件、可跑测试。绝不写入、绝不 commit。

先读：gh issue view {ISSUE}、{SPEC_REFS}、仓库根 AGENTS.md。

审阅重点：{REVIEW_FOCUS}
- Write scope 越界
- 测试质量：非快乐路径、边界、断言是否基于公共契约而非实现细节

要求：
- 只读实现者 worktree；发现写在汇报里，不要顺手修。
- 可以在自己这个 worktree 跑测试与 typecheck 复核。
- 最后给明确裁决建议：通过 / 有 blocker 需返工 / 通过但列出必须跟进项。
发现按严重度分级：blocker / major / minor / nit。
```

## 教训记录

- **#360 首派**：未显式传 `--base-branch`，Orca 落到旧基线（落后 main 26 提交），实现者只能用 `git show` 取 Spec。→ 现在凡是依赖前置交付的票，**显式传 `--base-branch <前置分支>` 并叠加 `--parent-worktree`**。
- **#361**：Orca 重启退休了实现者终端，工作靠磁盘幸存但 agent 会话丢失。→ **周期性 commit** 纳入固定约束（上）。

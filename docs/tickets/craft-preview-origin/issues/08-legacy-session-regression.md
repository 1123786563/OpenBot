## Parent

- GitHub Issue: #367（已发布，标签 ready-for-agent）
- Spec：`docs/specs/2026-10-15-craft-preview-origin-design.md`
- 覆盖验收标准：AC7
- 主战场：`openbot`

## What to build
存量会话回归与迁移策略落地。策略**已定案 D10：不迁移** —— 存量 `outputs/web` 继续走旧路径直到自然结束，新会话走新形态。本 Ticket 把该策略变成代码与文档里可验证的事实，不是再讨论一次。

## Acceptance criteria
- [ ] 旧会话（带 basePath 的应用）在策略下行为明确：可用 / 不可用 + 原因，两者必有其一且被文档化
- [ ] 不出现"旧应用在新形态下静默 404"的中间态
- [ ] 判定逻辑有测试（会话创建时间或显式标记，任选其一并写明理由）
- [ ] 用户可见的提示与文档一致

## Contracts
**Consumes**：06 的端到端行为
**Produces**：存量判定逻辑 + 文档

## Implementation steps
1. 确定判定信号（建议：`outputs/web/next.config.ts` 是否含 basePath）
2. 实现分支 + 测试
3. 文档与 UI 提示

## Write scope
`server/src/craft/`、`server/tests/`、必要的前端提示。

## Parent

- GitHub Issue: #365（已发布，标签 ready-for-agent）
- Spec：`docs/specs/2026-10-15-craft-preview-origin-design.md`
- 覆盖验收标准：AC1–AC3, AC5（组内缝合 Ticket）
- 主战场：`openbot`

## What to build
端到端缝合：两个真实会话 + 真实浏览器，证明「隔离」与「可交互」同时成立，且热更新不回退。本组结束时必须存在可演示行为，防止细拆退化成水平切片。

## Acceptance criteria
- [ ] 会话 A 预览：点击 → POST → 200（可交互不回退）
- [ ] 会话 A 预览内：跨 origin 调主站 API → 401；主站 cookie 不可见；localStorage 独立（AC1）
- [ ] 会话 A 预览内：fetch 会话 B 的预览路径 → 拒绝（AC3）
- [ ] HMR 帧数 > 0 且文件改动触发热更新（AC5）
- [ ] 全屏放大/还原不重挂载 iframe，点击结果跨放大保留（既有能力回归）
- [ ] 全部通过真实浏览器（Playwright + Casdoor 登录 + 真实 dev server）验证，非单测桩

## Contracts
**Consumes**：03/04/05 的全部交付
**Produces**：一份可复跑的浏览器验证脚本（落 `server/tests/` 或 `scripts/`，含启动前置说明）

## Implementation steps
1. 起两个会话，各自装探针应用
2. 逐条跑 AC，截图留证
3. 文件改动触发热更新的验证（改一行 → 断言 DOM 变化）
4. 失败即回退到对应 Ticket，不在本 Ticket 内修

## Write scope
`server/tests/` 或 `scripts/`（验证脚本）、必要时最小 fixture 修整。

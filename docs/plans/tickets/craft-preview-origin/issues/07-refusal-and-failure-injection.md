## Parent

- GitHub Issue: #366（已发布，标签 ready-for-agent）
- Spec：`docs/specs/2026-10-15-craft-preview-origin-design.md`
- 覆盖验收标准：AC3, AC4
- 主战场：`openbot`

## What to build
拒绝与故障注入，单独成张（R5）：把所有拒绝路径逐条做成可复跑用例，确保接手 agent 不会漏掉拒绝语义。

## Acceptance criteria
- [ ] 无票 / 过期票（时钟推进）/ 已重放票 / 跨会话票 / 他人会话票 / 未知 Host，逐条拒绝且原因可展示
- [ ] 票据兑换的并发竞争：两请求同时兑换同一票据，恰好一个成功
- [ ] preview origin 准入关闭时的关闭原因可展示，且预览路由全部拒绝
- [ ] 上游 dev server 不在（附着模型）仍返回既有 503 语义，不回退为拉起第二进程

## Contracts
**Consumes**：01 票据、02 准入、03 代理、04 HMR
**Produces**：拒绝路径的测试全集（可注入时钟）

## Implementation steps
1. 时钟注入下逐条过期/重放用例
2. 并发兑换竞争用例
3. 未知 Host 与准入关闭用例
4. 附着模型回归用例

## Write scope
`server/tests/`。

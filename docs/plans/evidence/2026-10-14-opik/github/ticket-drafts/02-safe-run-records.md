## Parent

https://github.com/1123786563/OpenBot/issues/4

## What to build

创建者完成工作台对话后，在自己的 Bot 页面查看运行列表和安全详情；覆盖可信归属、真实流生命周期、脱敏、分页与权限变化，远程路径明确显示基础能力。

This slice inherits the parent Spec's safety, authorization, tenancy-reservation, billing, and real-verification constraints and does not expand its non-goals.

## Acceptance criteria

- [ ] 内置和经过 OpenBot 的远程 AG-UI 执行建立可信 Bot/thread/run/attempt 关联，列表与详情展示实际状态、耗时、安全内容和版本。
- [ ] HTTP 首帧不结束 run；成功、错误、重试、确认取消、断连和未知结局正确区分，每个 attempt 唯一终结，工具提议不冒充执行。
- [ ] 实际 provider usage 缺失显示 unavailable；basic/unavailable 明确，不能声称不可观察的远程内部调用不存在。
- [ ] 仅当前有管理权的创建者及范围内管理员可查看；public 聊天权、伪造归属、猜测 ID 或跨 scope 游标不能扩大访问。
- [ ] 移交或撤权后历史详情、分页和缓存不可继续读取；两个测试 scope 的相同资源 ID 隔离，未知企业 scope 拒绝。
- [ ] 导出前治理覆盖正文、metadata、异常及 URL；无法可靠处理的自由文本仅指标，原文附件、能力凭证及账号标识不可读取。
- [ ] Opik 慢响应、离线、队列饱和或绑定故障不改变正常 Agent 结果，页面如实展示同步/缺失/故障。
- [ ] 英文/中文、键盘与窄屏完成筛选和详情查看，恶意正文只作为文本渲染。

## Blocked by

- Draft 1: 管理员验证 Opik 自托管连接与采集健康 (replace with the real GitHub issue link and native blocked-by edge after breakdown approval).

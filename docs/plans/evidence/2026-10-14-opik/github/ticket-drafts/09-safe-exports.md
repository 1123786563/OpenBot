## Parent

https://github.com/1123786563/OpenBot/issues/4

## What to build

有权用户从 OpenBot 请求运行/实验的机器可读导出，查看导出状态，并在每次下载时重新校验当前权限。

This slice inherits the parent Spec's safety, authorization, tenancy-reservation, billing, and real-verification constraints and does not expand its non-goals.

## Acceptance criteria

- [ ] 导出仅使用授权安全 DTO，不含原文附件、凭证、未处理正文、可执行 HTML 或私有原文 URL。
- [ ] 任务、文件和分页引用绑定 scope/Bot，客户端不能指定上游项目或用 export ID 跨范围读取。
- [ ] 页面区分 queued/running/ready/failed/revoked，仅 ready 且当前有权才可下载，移交/撤权后旧链接失效。
- [ ] 下载通过受控接口，不生成绕过业务授权的长期公开链接；失败或取消不显示 ready。
- [ ] 文件记录到期和清理引用，配合生命周期 Ticket 删除；双语、无障碍及跨范围、恶意数据、撤权测试成立。

## Blocked by

- Draft 5: 运行隔离评测并查看规则评分 (replace with the real GitHub issue link and native blocked-by edge after breakdown approval).

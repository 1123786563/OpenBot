## Parent

https://github.com/1123786563/OpenBot/issues/4

## What to build

创建者在既有运行详情中定位内置执行与默认 LangGraph 的模型调用、可信工具执行和检索步骤，并关联跨服务过程。

This slice inherits the parent Spec's safety, authorization, tenancy-reservation, billing, and real-verification constraints and does not expand its non-goals.

## Acceptance criteria

- [ ] 两条默认路径各通过真实 Opik 冒烟，模型、工具、检索及跨服务父子关系正确后才标 detailed。
- [ ] 步骤树与安全详情可定位具体操作；Opik 和 OTel ID 使用显式关联而不假定相等。
- [ ] 工具提议、真实 execute 和缺少回执分开，未知浏览器执行不显示成功。
- [ ] 不重复调用 provider、不改变已有 metered finish/Settlement 顺序、不重复计算 usage；拒绝或结算失败不是成功 span。
- [ ] 框架 callback 进入同一受治理 OTel 路径，不另开未处理的自动上传；输入输出、检索片段、错误和日志无秘密 canary。
- [ ] 其他远程路径保持 basic 和原协议；宿主、容器和支持的动态进程传播真实通过。

## Blocked by

- Draft 2: 创建者查看受授权的安全运行记录 (replace with the real GitHub issue link and native blocked-by edge after breakdown approval).

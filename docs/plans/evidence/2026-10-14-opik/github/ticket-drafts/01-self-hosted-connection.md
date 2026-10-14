## Parent

https://github.com/1123786563/OpenBot/issues/4

## What to build

管理员在 OpenBot 中确认自托管 Opik 的连接与合成采集结果，并准确区分未启用和故障；包含可选部署、兼容锁定、受保护入口及最小可信范围装配。

This slice inherits the parent Spec's safety, authorization, tenancy-reservation, billing, and real-verification constraints and does not expand its non-goals.

## Acceptance criteria

- [ ] 可选部署启动真实自托管实例，锁定实际验证的服务和 SDK 版本；关闭集成时现有执行及 tracing 行为成立。
- [ ] 管理员页面及受控接口显示连接与验证状态；普通用户不能读取连接配置、管理诊断或凭据。
- [ ] 合成安全数据进入真实 Opik 并可查询，证明父子关系、thread 关联、ID 映射和删除契约；缺环境或跳过实测不能显示验证成功。
- [ ] 采集入口要求内部生产者认证，控制台及私有 API 受保护；canary、账号信息、能力凭证与原始附件不进入采集或诊断。
- [ ] 装配工作台授权与定位接入位置；未知企业 scope 拒绝而不回退，不创建租户表或将 workspace 当作授权。

## Blocked by

None (can start immediately).

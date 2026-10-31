---
id: ADR-0013
status: accepted
version: 1
approved_by: 当前用户
approved_at: 2026-10-30
approved_revision: 访谈D1–D25中的底座、隔离和权限归属决定；不含未验证实现
approved_content_ref: '../specs/2026-10-30-openshell-sandbox.md#已批准决定'
approved_content_sha256: 18a9a030d6420887a10e15cbee946353a0e67e119fa730ddc9eff0694cbf458c
approval_ref: '../plans/2026-10-30-openshell-sandbox/design.md#整体确认记录'
---

# Kubernetes 可选采用 OpenShell，OpenBot 保留治理权威

为增强 Bot 执行隔离和网络约束，以部署为单位新增 OpenShell 底座选择，同时覆盖 computer 和编码环境。每个合法执行归属中的 Bot 按需拥有两个独立沙箱；OpenCode 和预览同处编码沙箱。每个团队工作空间映射一个 OpenShell 工作空间，但每 Bot 访问仍由 OpenBot 校验。延续 [ADR 0006](0006-logical-private-bot-scoped-execution.md) 的范围解析约束，不能以全局逻辑 Bot ID 共享跨范围的可变环境；不恢复已作废的公司/团队旧需求或扩充未批准业务范围。

OpenBot 保留网络权限意图与部署管理员审批、业务归属、容量准入、关键审计和所有用户服务入口。只有集成服务持有 OpenShell 控制面权限；沙箱和普通用户不直接获得该权限。OpenShell 负责执行隔离、出站约束及底层生命周期。临时网络授权有界，撤销包含已有连接；隔离失效和失联超期不得继续执行。停止保留磁盘数据，两类环境分别重置，文件通过受控接口复制。

相比只包裹共享编码容器，此方案建立 Bot 间执行边界；相比同 Bot 共用一个沙箱，可避免编码进程直接读取浏览器登录资料，并分别控制权限和生命周期。代价是更多沙箱资源、文件复制、服务转发、策略同步和控制面适配。保留OpenBot治理而非直接开放底层成员与服务入口，是为维持审批、归属和审计的一致边界。增强安全优先于减少维护，首版不做已有数据迁移或按Bot混选底座。

[Spec v1](../specs/2026-10-30-openshell-sandbox.md)记录全部批准需求及验收映射。独立失联执行约束、Chromium兼容性、存储硬配额等仍须技术设计与实测；本决定不证明OpenShell已满足要求。默认值及实现方案没有被自动批准，不授权代码实施、集群部署或发布，也不替代其他领域有效架构决定。

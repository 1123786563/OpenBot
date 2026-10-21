# 插件包与市场 V1 — Issue 拆解与执行入口

- 仓库：1123786563/OpenBot
- 父方案：[459](https://github.com/1123786563/OpenBot/issues/459)；完整详细方案快照已嵌入正文。
- 状态：12 个正式子 Issue 已发布并回读核验；生产实现未开始。
- 每票按业务纵向闭环验收，后端/前端作为票内 Task；ready-for-agent 表示定义齐全，依赖与实施授权仍需满足。
- 本地详细方案：docs/specs/2026-10-19-plugin-package-marketplace-design.md
- 机器可读 DAG：manifest.json；远端核验证据：verification.json；每票正文：issues/PKGxx.md。

## Issue 与真实阻塞

| ID | Issue | 交付 | Blocked by |
| --- | --- | --- | --- |
| PKG01 | [#460](https://github.com/1123786563/OpenBot/issues/460) | 浏览经过校验的受信插件包目录 | 无 |
| PKG02 | [#461](https://github.com/1123786563/OpenBot/issues/461) | 在当前团队预览并幂等安装 Skill 插件包 | #460, #74 |
| PKG03 | [#462](https://github.com/1123786563/OpenBot/issues/462) | 授权范围内 Bot 使用已安装 Skill 的固定版本 | #461 |
| PKG04 | [#463](https://github.com/1123786563/OpenBot/issues/463) | 从插件包幂等创建当前范围的专家 Bot | #462 |
| PKG05 | [#464](https://github.com/1123786563/OpenBot/issues/464) | 使用本人连接执行插件包声明的受管工具 | #462, #75 |
| PKG06 | [#465](https://github.com/1123786563/OpenBot/issues/465) | 预览权限差异并升级或回滚插件包版本 | #464 |
| PKG07 | [#466](https://github.com/1123786563/OpenBot/issues/466) | 停用、卸载和重装插件包并保留用户资产 | #463, #464 |
| PKG08 | [#467](https://github.com/1123786563/OpenBot/issues/467) | 部署侧下架或安全撤回指定插件包版本 | #464 |
| PKG09 | [#468](https://github.com/1123786563/OpenBot/issues/468) | 在审批恢复和后台入口保持包运行的原范围 | #464 |
| PKG10 | [#469](https://github.com/1123786563/OpenBot/issues/469) | 核对外部效果未知的包调用并安全恢复 | #468 |
| PKG11 | [#470](https://github.com/1123786563/OpenBot/issues/470) | 迁移存量专家和 Skill 并灰度启用包市场 | #463, #465, #466, #467, #469 |
| PKG12 | [#471](https://github.com/1123786563/OpenBot/issues/471) | 完成插件包首发闭环验收与交付证据 | #470 |

## 验收映射

| 验收 | 覆盖业务票 |
| --- | --- |
| A01 | [#460](https://github.com/1123786563/OpenBot/issues/460), [#467](https://github.com/1123786563/OpenBot/issues/467), [#471](https://github.com/1123786563/OpenBot/issues/471) |
| A02 | [#461](https://github.com/1123786563/OpenBot/issues/461), [#462](https://github.com/1123786563/OpenBot/issues/462), [#464](https://github.com/1123786563/OpenBot/issues/464), [#468](https://github.com/1123786563/OpenBot/issues/468), [#471](https://github.com/1123786563/OpenBot/issues/471) |
| A03 | [#461](https://github.com/1123786563/OpenBot/issues/461), [#465](https://github.com/1123786563/OpenBot/issues/465), [#471](https://github.com/1123786563/OpenBot/issues/471) |
| A04 | [#461](https://github.com/1123786563/OpenBot/issues/461), [#462](https://github.com/1123786563/OpenBot/issues/462), [#464](https://github.com/1123786563/OpenBot/issues/464), [#471](https://github.com/1123786563/OpenBot/issues/471) |
| A05 | [#464](https://github.com/1123786563/OpenBot/issues/464), [#466](https://github.com/1123786563/OpenBot/issues/466), [#467](https://github.com/1123786563/OpenBot/issues/467), [#468](https://github.com/1123786563/OpenBot/issues/468), [#469](https://github.com/1123786563/OpenBot/issues/469), [#471](https://github.com/1123786563/OpenBot/issues/471) |
| A06 | [#462](https://github.com/1123786563/OpenBot/issues/462), [#465](https://github.com/1123786563/OpenBot/issues/465), [#471](https://github.com/1123786563/OpenBot/issues/471) |
| A07 | [#464](https://github.com/1123786563/OpenBot/issues/464), [#465](https://github.com/1123786563/OpenBot/issues/465), [#468](https://github.com/1123786563/OpenBot/issues/468), [#469](https://github.com/1123786563/OpenBot/issues/469), [#471](https://github.com/1123786563/OpenBot/issues/471) |
| A08 | [#463](https://github.com/1123786563/OpenBot/issues/463), [#466](https://github.com/1123786563/OpenBot/issues/466), [#469](https://github.com/1123786563/OpenBot/issues/469), [#470](https://github.com/1123786563/OpenBot/issues/470), [#471](https://github.com/1123786563/OpenBot/issues/471) |
| A09 | [#470](https://github.com/1123786563/OpenBot/issues/470), [#471](https://github.com/1123786563/OpenBot/issues/471) |
| A10 | [#463](https://github.com/1123786563/OpenBot/issues/463), [#471](https://github.com/1123786563/OpenBot/issues/471) |
| A11 | [#462](https://github.com/1123786563/OpenBot/issues/462), [#470](https://github.com/1123786563/OpenBot/issues/470), [#471](https://github.com/1123786563/OpenBot/issues/471) |
| A12 | [#460](https://github.com/1123786563/OpenBot/issues/460), [#461](https://github.com/1123786563/OpenBot/issues/461), [#467](https://github.com/1123786563/OpenBot/issues/467), [#468](https://github.com/1123786563/OpenBot/issues/468), [#469](https://github.com/1123786563/OpenBot/issues/469), [#470](https://github.com/1123786563/OpenBot/issues/470), [#471](https://github.com/1123786563/OpenBot/issues/471) |

## 实施边界与恢复

原实施计划 T1–T10 是技术任务参考，不应在领取一个业务 Issue 后机械执行其全部任务。每次实施应从该 Issue 的用户结果、依赖、验收与 consumes/produces 重新生成详细 Task Brief；只修改本票所需的存储/接口/界面。例如 PKG02 只落地安装所需表，专家创建在 PKG04，工具派发在 PKG05。
默认按 PKG01→PKG02→PKG03→PKG04→PKG05→PKG06→PKG07→PKG08→PKG09→PKG10→PKG11→PKG12 串行；DAG 只保存真实前置，不把默认串行顺序伪装成业务依赖。PKG05 另受 #75 阻塞。
实施前先按仓库规则建立/核验执行工作区，将本目录、Spec 与 Plan 显式复制并校验；创建 Issue 不授予提交、推送、合并或部署权限。不得使用工作区中的其他会话改动充当本次已验证交付。
外部 #74/#75/#76/#137/#177 已读取正文、状态和评论；旧父 Spec 与原 Issue 正文/状态没有修改。#74 既有模块仅作为复用证据，闭票不替代测试；#75 的实际交付仍须在当前执行分支验收。
本阶段不声称已实现真实 Personal Space 或未接线的逻辑私有 Bot 多范围执行。后续个人模式与外部插件导入需完成各自领域合同后另立业务票。
恢复时先读取归档的 `published.json` 与 `verification.json`，核对远端后再操作。历史发布工具已归档；不能在网络写入结果不明时盲目重复建单。

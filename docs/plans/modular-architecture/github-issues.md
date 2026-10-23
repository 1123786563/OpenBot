# 模块化渐进改造 GitHub Issue 索引

根 Issue：[620：模块化渐进改造](https://github.com/1123786563/OpenBot/issues/620)。

状态：2026-10-23 已按用户要求创建根 Issue 与 25 张子 Issue；未启动代码实施。正式父子与 blocked_by 关系以 GitHub 为准，验证证据存 `.archive/runs/2026-10-23-modular-issues/`。

## 建议起步

先按 MOD01→MOD02→MOD03 交付基线、HTTP 装配和宿主生命周期。后续每次选一张已满足前置的票，完成后保留可用检查点；编号不是执行依赖顺序。

本地架构主文档与四份分册未提交到远端，根 Issue 已完整嵌入五份文档快照及 SHA-256；纯远程 Agent 可以从根 Issue 和单票正文工作。

## 任务与依赖

| ID | GitHub Issue | 阶段 | blocked-by |
| --- | --- | --- | --- |
| [MOD01](../tickets/modular-architecture/MOD01.md) | [#621 建立首条聊天链路的模块写入清单与增量依赖检查](https://github.com/1123786563/OpenBot/issues/621) | 第一批：基础 | 无 |
| [MOD02](../tickets/modular-architecture/MOD02.md) | [#622 抽离 HTTP 路由装配并保持认证与挂载顺序](https://github.com/1123786563/OpenBot/issues/622) | 第一批：基础 | [#621](https://github.com/1123786563/OpenBot/issues/621) |
| [MOD03](../tickets/modular-architecture/MOD03.md) | [#623 抽离服务启动关闭装配并显式管理资源生命周期](https://github.com/1123786563/OpenBot/issues/623) | 第一批：基础 | [#622](https://github.com/1123786563/OpenBot/issues/622) |
| [MOD04](../tickets/modular-architecture/MOD04.md) | [#624 封装现有身份发现与对象动作准入 Interface](https://github.com/1123786563/OpenBot/issues/624) | 第二批：核心 | [#623](https://github.com/1123786563/OpenBot/issues/623) |
| [MOD05](../tickets/modular-architecture/MOD05.md) | [#625 集中 Bot 档案固定版本与团队发布的业务出口](https://github.com/1123786563/OpenBot/issues/625) | 第二批：核心 | [#624](https://github.com/1123786563/OpenBot/issues/624) |
| [MOD06](../tickets/modular-architecture/MOD06.md) | [#626 封装会话完整历史与消息单写者并隐藏引擎存储](https://github.com/1123786563/OpenBot/issues/626) | 第二批：核心 | [#624](https://github.com/1123786563/OpenBot/issues/624) |
| [MOD07](../tickets/modular-architecture/MOD07.md) | [#627 收拢聊天 Run 生命周期与内部执行 Adapter](https://github.com/1123786563/OpenBot/issues/627) | 第二批：核心 | [#623](https://github.com/1123786563/OpenBot/issues/623), [#624](https://github.com/1123786563/OpenBot/issues/624), [#625](https://github.com/1123786563/OpenBot/issues/625), [#626](https://github.com/1123786563/OpenBot/issues/626) |
| [MOD08](../tickets/modular-architecture/MOD08.md) | [#628 统一可用模型发现与个人 Bot 模型授权出口](https://github.com/1123786563/OpenBot/issues/628) | 第二批：核心 | [#624](https://github.com/1123786563/OpenBot/issues/624) |
| [MOD09](../tickets/modular-architecture/MOD09.md) | [#629 收拢受管模型调用与双重预算结算链路](https://github.com/1123786563/OpenBot/issues/629) | 第三批：执行 | [#627](https://github.com/1123786563/OpenBot/issues/627), [#628](https://github.com/1123786563/OpenBot/issues/628) |
| [MOD10](../tickets/modular-architecture/MOD10.md) | [#630 封装账务查询支付收款与权益交付 Interface](https://github.com/1123786563/OpenBot/issues/630) | 第三批：执行 | [#624](https://github.com/1123786563/OpenBot/issues/624), [#629](https://github.com/1123786563/OpenBot/issues/629) |
| [MOD11](../tickets/modular-architecture/MOD11.md) | [#631 以可信范围和环境代次绑定 Craft 沙箱能力句柄](https://github.com/1123786563/OpenBot/issues/631) | 第三批：执行 | [#623](https://github.com/1123786563/OpenBot/issues/623), [#624](https://github.com/1123786563/OpenBot/issues/624)；外部 [#618](https://github.com/1123786563/OpenBot/issues/618) |
| [MOD12](../tickets/modular-architecture/MOD12.md) | [#632 集中连接工具与秘密使用的受管动作出口](https://github.com/1123786563/OpenBot/issues/632) | 第三批：执行 | [#624](https://github.com/1123786563/OpenBot/issues/624), [#631](https://github.com/1123786563/OpenBot/issues/631) |
| [MOD13](../tickets/modular-architecture/MOD13.md) | [#633 分离工具审批决定与 Run 等待恢复并保持单次消费](https://github.com/1123786563/OpenBot/issues/633) | 第三批：执行 | [#627](https://github.com/1123786563/OpenBot/issues/627), [#629](https://github.com/1123786563/OpenBot/issues/629), [#632](https://github.com/1123786563/OpenBot/issues/632) |
| [MOD14](../tickets/modular-architecture/MOD14.md) | [#634 让定时职责投递与 Worker 统一消费持久 Run 用例](https://github.com/1123786563/OpenBot/issues/634) | 第四批：扩展 | [#627](https://github.com/1123786563/OpenBot/issues/627), [#629](https://github.com/1123786563/OpenBot/issues/629), [#633](https://github.com/1123786563/OpenBot/issues/633) |
| [MOD15](../tickets/modular-architecture/MOD15.md) | [#635 统一个人记忆审核召回与遗忘的业务出口](https://github.com/1123786563/OpenBot/issues/635) | 第四批：扩展 | [#624](https://github.com/1123786563/OpenBot/issues/624), [#629](https://github.com/1123786563/OpenBot/issues/629), [#632](https://github.com/1123786563/OpenBot/issues/632) |
| [MOD16](../tickets/modular-architecture/MOD16.md) | [#636 封装插件包安装版本与运行 pin 并复用业务所有者](https://github.com/1123786563/OpenBot/issues/636) | 第四批：扩展 | [#625](https://github.com/1123786563/OpenBot/issues/625), [#632](https://github.com/1123786563/OpenBot/issues/632), [#633](https://github.com/1123786563/OpenBot/issues/633), [#643](https://github.com/1123786563/OpenBot/issues/643) |
| [MOD17](../tickets/modular-architecture/MOD17.md) | [#637 让运行观测通过内部 observer 接入并隔离可选故障](https://github.com/1123786563/OpenBot/issues/637) | 第四批：扩展 | [#627](https://github.com/1123786563/OpenBot/issues/627) |
| [MOD18](../tickets/modular-architecture/MOD18.md) | [#638 让评测与 Judge 复用受管模型和隔离工具 Interface](https://github.com/1123786563/OpenBot/issues/638) | 第四批：扩展 | [#629](https://github.com/1123786563/OpenBot/issues/629), [#632](https://github.com/1123786563/OpenBot/issues/632), [#637](https://github.com/1123786563/OpenBot/issues/637) |
| [MOD19](../tickets/modular-architecture/MOD19.md) | [#639 让 Web 范围状态与业务调用消费统一 Module Interface](https://github.com/1123786563/OpenBot/issues/639) | 第五批：客户端 | [#624](https://github.com/1123786563/OpenBot/issues/624), [#625](https://github.com/1123786563/OpenBot/issues/625), [#626](https://github.com/1123786563/OpenBot/issues/626), [#627](https://github.com/1123786563/OpenBot/issues/627), [#633](https://github.com/1123786563/OpenBot/issues/633) |
| [MOD20](../tickets/modular-architecture/MOD20.md) | [#640 迁移 Desktop 当前登录业务流与环境调用到统一出口](https://github.com/1123786563/OpenBot/issues/640) | 第五批：客户端 | [#631](https://github.com/1123786563/OpenBot/issues/631), [#639](https://github.com/1123786563/OpenBot/issues/639) |
| [MOD21](../tickets/modular-architecture/MOD21.md) | [#641 明确 OpenMuse Mobile 与 BFF 的实际合同转译出口](https://github.com/1123786563/OpenBot/issues/641) | 第五批：客户端 | [#639](https://github.com/1123786563/OpenBot/issues/639) |
| [MOD22](../tickets/modular-architecture/MOD22.md) | [#642 让 Craft Workshop 的运行环境与预览各归其责](https://github.com/1123786563/OpenBot/issues/642) | 第五批：客户端 | [#627](https://github.com/1123786563/OpenBot/issues/627), [#631](https://github.com/1123786563/OpenBot/issues/631), [#633](https://github.com/1123786563/OpenBot/issues/633)；外部 [#619](https://github.com/1123786563/OpenBot/issues/619) |
| [MOD23](../tickets/modular-architecture/MOD23.md) | [#643 隔离可选 Learning 并整理 toolkit 的真实共享 Seam](https://github.com/1123786563/OpenBot/issues/643) | 第四批：扩展 | [#627](https://github.com/1123786563/OpenBot/issues/627), [#632](https://github.com/1123786563/OpenBot/issues/632) |
| [MOD24](../tickets/modular-architecture/MOD24.md) | [#644 让语音听写媒体链路复用模型费用与当前资格](https://github.com/1123786563/OpenBot/issues/644) | 第五批：客户端 | [#629](https://github.com/1123786563/OpenBot/issues/629), [#631](https://github.com/1123786563/OpenBot/issues/631), [#639](https://github.com/1123786563/OpenBot/issues/639) |
| [MOD25](../tickets/modular-architecture/MOD25.md) | [#645 收窄旧深层出口并完成目标范围架构验收](https://github.com/1123786563/OpenBot/issues/645) | 收尾：累计验收 | [#621](https://github.com/1123786563/OpenBot/issues/621), [#622](https://github.com/1123786563/OpenBot/issues/622), [#623](https://github.com/1123786563/OpenBot/issues/623), [#624](https://github.com/1123786563/OpenBot/issues/624), [#625](https://github.com/1123786563/OpenBot/issues/625), [#626](https://github.com/1123786563/OpenBot/issues/626), [#627](https://github.com/1123786563/OpenBot/issues/627), [#628](https://github.com/1123786563/OpenBot/issues/628), [#629](https://github.com/1123786563/OpenBot/issues/629), [#630](https://github.com/1123786563/OpenBot/issues/630), [#631](https://github.com/1123786563/OpenBot/issues/631), [#632](https://github.com/1123786563/OpenBot/issues/632), [#633](https://github.com/1123786563/OpenBot/issues/633), [#634](https://github.com/1123786563/OpenBot/issues/634), [#635](https://github.com/1123786563/OpenBot/issues/635), [#636](https://github.com/1123786563/OpenBot/issues/636), [#637](https://github.com/1123786563/OpenBot/issues/637), [#638](https://github.com/1123786563/OpenBot/issues/638), [#639](https://github.com/1123786563/OpenBot/issues/639), [#640](https://github.com/1123786563/OpenBot/issues/640), [#641](https://github.com/1123786563/OpenBot/issues/641), [#642](https://github.com/1123786563/OpenBot/issues/642), [#643](https://github.com/1123786563/OpenBot/issues/643), [#644](https://github.com/1123786563/OpenBot/issues/644) |

## 与既有规划的分工

- 新票封装当前已启用行为；原功能缺陷和未实施能力由既有 BA/Bifrost/Hindsight/插件包/Opik/Craft 票管理。
- MOD11 依赖 #618；MOD22 依赖 #619；其他原规划只作相关来源，不把“属于父 Issue”当执行依赖。
- BA 新合同仍受 #503/#504 门槛约束；旧 #6、已作废 ADR 0004 和 proposed Personal Space 不因本次建单恢复或获得实施授权。
- ready-for-agent 代表范围与验收已写明，不表示前置已完成、实施已授权或已经验证。

## Code Agent 使用

从根架构 Issue 阅读全局约束与对应架构章节，再读目标子票和直接前置。开始实施时重新核验当前 Git、原生依赖、实际消费者与批准事实源，编写本票精确 writing-plans，并按仓库既有实施/验证/Review/OCR 流程执行。

目录与票正文是任务输入；实际派发 owned_files、测试命令、检查点和状态另写执行 Run，不将本索引作为已验证 Ledger。

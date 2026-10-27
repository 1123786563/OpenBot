# MOD23 计划（#643：隔离可选 Learning 并整理 toolkit 的真实共享 Seam，第四批扩展）

状态：冻结（2026-10-27）。实施基点 `be96ae87c`（集成 HEAD，MOD22 已并入）。载体制裁=Orca 或编排者进程内（按会话死亡判据择形，落盘纪律入派发 prompt）。

## 0. 侦察事实（编排者已核实 @ `be96ae87c`，含只读普查代理报告）

- **learning/ 六文件无环**：settings（存储，fail-closed 读）→runtime（快照获取=票面窄内部合同所在：LearnedSkillInvocation/AcquireLearnedSkills/LEARNED_SKILL_TOOL_NAMES 保留对）→remote（AG-UI 中间件）；ensure-container→auto-assign→settings；routes→{auto-assign,settings}。
- **验收①现状已满足**（ME15 #487 已建）：learning 关闭=零 Intelligence client 构造（intelligence-optional.ts:19-20+copilot.ts:4408-4419+runtime.ts:131-133 acquire 前置 null return）；启用失败=acquire reject→run 拒绝（execution-contracts.ts:202-207 契约注释），无伪造路径；已被 mastra-no-intelligence-boot(3)+mastra-intelligence-optional(9) 锁定。D 负向钉固化。
- **验收②现状成立**：候选审核/归档校验/撤销/刷新权威在 CopilotKit Intelligence 平台+pinned SDK（learning/runtime.ts:17-18 注释明示）；OpenBot 本地仅 settings/bindings 两表；与 PersonalMemory 分列（ExecutionRequest.personalMemory 与 learnedSkills 两个独立可选字段）。D 钉固化。
- **验收③收敛点（唯一真代码面）**：`mastra/tools.ts:13` 直 import `LEARNED_SKILL_TOOL_NAMES`（运行时值）、`agents/agent-resolver.ts:18` 直 import `AcquireLearnedSkills`（类型）——两处**绕过合同面直取 learning 内件**；而 `mastra/execution-contracts.ts:163` 已有 `LearnedSkillInvocationSurface` 合同。toolkit 侧私有协议面=run-turn.ts 手写 IntelligenceLike/RunnerLike 镜像（pin 1.69.0 注释，实际 SDK 1.77.0）+thread-history.ts+history-sanitize.ts 行为 pin——**copilotkit/ 子目录系 biome 强制的 Adapter 区（biome.json:81-99），公开面消费**。
- **验收④普查定论：learning 域零 adapter/compat/shim 文件**（全仓 grep 实证）；唯一 @openbot/toolkit 消费者=server（workspace:*），app 零 import。**无可删项**——清单登记即交付。
- **快照合同唯一 /internal/ 私有依赖**=learning/runtime.ts:2-7（`@copilotkit/runtime/internal/learned-skills`），全仓唯一；注释 pin 1.73.1 滞后（实际 1.77.0）→ 顺手修正。
- **目录比对登记项**：catalog L143 称 Learning 拥有 `enterprise_learning_*` 表——现状仅 learning_settings/learning_thread_bindings 两表（enterprise_learning_* 未实证为表）；「候选/审核权威归 Learning」与实现偏差（权威在 Intelligence 平台）；「内部 SkillProvider 合同」无同名 interface（系验收④反抽象的正确现状）。入报告登记节。
- **测试基线**：learning 族 12 套件 ≈76 用例+intelligence-optional 9+no-intelligence-boot 3+mastra-learned-skills 13+intelligence-contracts 17+entitlement 14+toolkit 5 件 53 用例。checker 基线 **651**；server tsc 0；toolkit 有 typecheck 脚本。

## 1. 目标形态

### A. 窄内部合同收敛（唯一代码主交付）
- mastra/tools.ts:13 与 agents/agent-resolver.ts:18 的 learning 直 import 改经**单一窄出口**——落点择形由实施者普查后冻结（候选：`learning/public.ts` 新出口 re-export 保留对+Acquire 类型；或经既有 `execution-contracts.ts` 合同面收类型、出口收运行时值）。**零新判定、零新抽象**（验收④：不为可插拔预建）。
- checker 簿记随迁：现 mastra→learning/agents→learning 边的例外形态变化如实登记（651 基线上下）。
- 顺手：learning/runtime.ts:17 pin 注释 1.73.1→1.77.0。

### B. toolkit 真实复用与私有协议 Adapter 清点（登记即交付）
- 报告§=清点正本：逐文件真实消费者表（census 已给底稿，实施复认）+私有协议面四点清单+「零可删历史 Adapter」裁决+copilotkit/ Adapter 区边界（biome 强制）确认。**预期 toolkit 零 hunk 或仅注释级修正**。

### C. 快照合同负向钉（D 内）
- 不合并个人记忆（ExecutionRequest 两字段分列钉）；审核/归档/版本权威在 SDK（/internal/ 唯一依赖点钉在 learning/runtime.ts）；关闭时零 client 构造钉。

### D. 新测试套件 `server/tests/multitenancy/learning-contract-seam.test.ts`（新增全权）
1. D1 A 收敛等价（保留对与 Acquire 类型经出口后值/形不变；消费点行为钉）
2. D2 验收①（关闭零构造+启用失败 run 拒绝不伪造——既有 12 用例为底，补源级钉：/internal/ 依赖点恰 1、client accessor 注入形）
3. D3 验收②（settings/bindings 两表外无 learning 本地写面；personalMemory/learnedSkills 字段分列钉）
4. D4 验收③（快照消费面=LEARNED_SKILL_TOOL_NAMES 保留对+execute 单一入口钉；供应商私有方法零新增直依赖）
5. D5 验收④（learning 域 adapter/compat/shim 零文件=源扫钉；toolkit 清单固化）
6. D6 目录比对登记固化（enterprise_learning_* 表断言=按实证裁决写：存在则钉形状，不存在则钉两表事实）
7. D7 存量族两侧对照（learning 12 件+intelligence-optional+mastra-learned-skills+toolkit 5 件）

## 2. owned_files（冻结——与普查交叉核对后）

`learning/public.ts`（若 A 择此形，新增全权）；`learning/runtime.ts`（受限：pin 注释+出口 re-export 若需）；`mastra/tools.ts`（受限：import 改道）；`agents/agent-resolver.ts`（受限：import 改道）；D 新增全权。其余全仓只读（**toolkit/src 预期零 hunk**、mastra/execution-contracts.ts 零改动（合同已存在）、settings/remote/routes/auto-assign/ensure-container 零改动、app/** 零 hunk）。事实不符→停下上报。

## 3. 验证门

checker **651 基线**（A 迁移后例外形态变化如实登记，违规 0 幻影 0）；server typecheck 0；toolkit typecheck（若零 hunk 则读数对照）；D 全部根入口；learning 族+intelligence-optional+mastra-learned-skills+toolkit 件两侧对照（BASE=基点树首跑）；biome 我方零新增；审计两侧对照（native+1、manifest 零触碰——**committed manifest 零 hunk 为门**，MOD22 裁决口径）；复跑独立落盘。

## 4. 验收映射

①→D2；②→D3；③→D1+D4；④→D5+B 清点。

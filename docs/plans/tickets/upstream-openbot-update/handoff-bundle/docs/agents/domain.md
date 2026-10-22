# Domain context

OpenBot 的共享领域术语表位于仓库根目录 `CONTEXT.md`。Git 子模块 `apps/openmuse/CONTEXT.md` 记录 OpenMuse 集成自身的术语，适用于该子模块；它不是 OpenBot 共享术语表的副本。OpenBot 概念以根目录定义为准，OpenMuse 特有概念查子模块定义；同一个术语出现不同含义时先核对 Spec/ADR 并解决冲突，不静默选用其中一份。除该现有子模块上下文外，不为 OpenBot 其他模块另起术语表。

## 各事实源的分工

- 根目录 `CONTEXT.md`：OpenBot 共享**词汇**。`## Language` 下按主题分小节（用户与模型访问、公司与团队、个人记忆、计费与积分、计费准入），每个术语一条定义。它刻意不记实现，所以不要把流程、字段或接口形状写进去。
- `apps/openmuse/CONTEXT.md`：OpenMuse 子模块的局部词汇，仅在该子模块工作时读取。
- `docs/specs/`：Spec 所在目录；只有文件状态明确为已批准的需求、行为、范围、非目标与验收标准才作为实施依据。
- `docs/adr/`：架构决策与约束，按 `NNNN-标题.md` 递增编号。
- `docs/plans/`：实施计划与执行证据。
- `docs/tickets/`：派发给实现者的 Ticket。

冲突时的优先级写在根 `AGENTS.md`：已批准 Spec 高于实施 Plan；实现与 ADR 或批准需求冲突要升级处理，不在实现阶段静默重新设计。

## 使用规则

1. 开工任何模块前，先在根目录 `CONTEXT.md` 里查既有 OpenBot 术语；在 `apps/openmuse/` 内工作时还要查该子模块的 `CONTEXT.md`。用既有词命名与书写；查不到且这个词会反复出现，才补相应范围的条目。
2. 改术语含义就是改领域模型：同一次变更里更新对应范围的 `CONTEXT.md`，必要时补 ADR，不要只把新含义留在代码或聊天记录里。
3. 引用领域概念时带上出处（Spec 文件名、ADR 编号或对应 `CONTEXT.md` 小节），让读者能核对，而不是让读者相信你的复述。
4. 术语表只增不删地堆积会失去作用：发现定义与批准需求漂移时，以需求为准修正定义，并在 ADR 或 Spec 里留下依据。

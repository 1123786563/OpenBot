// server/src/learning/public.ts
// MOD23（Issue #643，根 #620）：LEARNING 组的窄公开出口。组内快照合同的全部
// 事实仍在 runtime.ts（acquire、SDK 保留对、快照 execute）；本文件零判定、零
// 缓存、零新抽象，只把「其他业务模块被允许看到的两个名字」原样转出：
//
//   LEARNED_SKILL_TOOL_NAMES —— 运行时值：SDK 保留的两个 learned-Skill 工具名。
//     消费方：mastra/tools.ts（保留名检查：mount 拒绝外来名 + isReservedToolName）。
//   AcquireLearnedSkills —— 类型：一次外层 run 取一次已验证快照的获取器签名。
//     消费方：agents/agent-resolver.ts（可选依赖字段类型）。
//
// 落点裁决（计划 §1.A 择形冻结）：M03/M05 原先各自直取 learning/runtime.ts，
// 在模块图上是仅有的两条环边（M03→LEARNING、M05→LEARNING，checker 例外
// 651 中的两条 MOD23 名下条目）；checker 把 public/integration 出口视为模块
// 公开面（scripts/check-module-imports.ts isPublicExport），改经本出口后两条
// 环边耗尽、例外删除。类型不收编进 execution-contracts.ts——合同面
// LearnedSkillInvocationSurface 已存在且零改动，这里收编会造成同一类型双定义。
//
// 装配根（copilot.ts / assembly/*）直取 learning/runtime 属 kind=assembly 装配
// 接线，按设计不经本出口（与 MOD18 A 臂出口收拢同口径：只收业务模块消费）。

export type { AcquireLearnedSkills } from "./runtime";
export { LEARNED_SKILL_TOOL_NAMES } from "./runtime";

// server/src/enterprise/plugin-packages/public.ts
// MOD16（Issue #636，根 #620）：M12 插件包组的窄公开出口——运行 pin 面。pin 的
// 全部事实仍在 runtime.ts（prepareWithin 与 run 行同事务写入、快照形状、pinned
// Skill 摘要）；本文件零判定、零缓存、零新抽象，只把「其他业务模块被允许看到的
// 五个名字」原样转出：
//
//   createPackageRuntime —— 运行时值：包运行域构造器（prepareWithin 是 pin 的
//     唯一写路径）。消费方：装配根（kind=assembly 直取内件，不经本出口）。
//   PreparePackageRunInput / PackageRuntime / PackageRunPinSnapshot /
//   PinnedSkillSummary —— 类型：runs 消费 pin 写入的入参/返回形状。
//     消费方：enterprise/runs/service.ts（type import 改道本出口，MOD16 例外
//     exit_condition 兑现）；未来 pin 读取方（readPinnedSkills 接线时）。
//
// 服务面（PackageService 等安装/升级合同）无跨模块消费者，不预建出口（验收④
// 零新抽象）；票面 Produces 的 preview/install/changeVersion/disable/remove/
// pin Interface 缺口归属 PKG06+（changeVersion/disable/remove 未实现，见
// interface-contracts），部分失败台账缺口登记于 MOD16 报告。

export type {
  PackageRunPinSnapshot,
  PackageRuntime,
  PinnedSkillSummary,
  PreparePackageRunInput,
} from "./runtime";
export { createPackageRuntime } from "./runtime";

// server/src/openmuse-tasks/public.ts
// MOD21（Issue #641，根 #620）：openmuse-tasks 的公开出口。
//
// 纯 re-export、零逻辑、零判定：跨模块消费面（M02 tenancy 范围门、M05 任务
// 入口）只取这三个类型 + 配额拒绝错误（D6 合同缝：mobile-bff 只经公开出口），
// 恰消费所需符号（宁可小不可造）。运行时构造仍走 createOpenMuseTaskStore
// （组内消费），不经本出口扩面。
export type {
  OpenMuseTaskStep,
  OpenMuseTaskStore,
  StoredOpenMuseTask,
} from "./store";
export { OpenMuseTaskQuotaError } from "./store";

// server/src/routines/public.ts
// MOD21（Issue #641，根 #620）：AUTOMATION 例程存储的公开出口。
//
// 纯 re-export、零逻辑、零判定：跨模块消费面（mobile Activity 聚合）只取
// 这一个类型，恰消费所需符号（宁可小不可造）。RoutineStore 具名导出已在
// ./store，无需补内件 export。
export type { RoutineStore } from "./store";

// server/src/channels/public.ts
// MOD21（Issue #641，根 #620）：M04 会话存储的公开出口。
//
// 纯 re-export、零逻辑、零判定：跨模块消费面（mobile-bff 冷启动聚合）只取
// 这两个类型，恰消费所需符号（宁可小不可造）。ChannelStore 具名导出已在
// ./routes，无需补内件 export。
export type { AgentChannel, ChannelStore } from "./routes";

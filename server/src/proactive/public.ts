/**
 * AUTOMATION 的公开出口（MOD15 出口段先例，见 memory/public.ts 的 M10 版）。
 *
 * 只 re-export 跨模块消费者需要的面：M03（agents/lifecycle-reset 的 Bot 重置）读
 * 研究默认的共享锁与退出行；装配层（assembly/runtime）从这里或直连 `./defaults`
 * 都可。不 re-export store、engine 或任何内部表形状。
 */
export {
  createResearchDefaults,
  DEFAULT_RESEARCH_INTERVAL_MINUTES,
  lockResearchDefaults,
  type ResearchDefaults,
  recordOptOut,
} from "./defaults";

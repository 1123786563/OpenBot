// server/src/memory/integration.ts
// MOD15（Issue #635，根 #620）：M10 的具名装配臂——Hindsight 降级召回与个人记忆
// 语境的装配收拢（出口段配套，Brief §1.B）。
//
// 两个臂，收拢的是 runtime 里的两处内联装配（装配点改经臂，内件零改动）：
//
//   createHindsightRecallArm(options) → { degradedRecall, context, renderedLoader }
//     — 降级召回门面（createDegradedRecallFacade）+ 个人记忆语境组合
//       （createPersonalMemoryContext）+ 渲染装载器（renderPersonalMemoryContext）
//       的具名收拢。**一个门面实例**同时喂给语境组合与 PersonalMemory 出口门面
//       （memory/public.ts degradedRecall 注入）——验收③「降级同过滤」的装配保证：
//       同一份授权/暂停/资格存储，不存在第二条降级路径。装载器是
//       setMastraPersonalMemoryContext 与 headlessPersonalMemoryContext 共用的
//       那一个（ME10 AC3「one loader」现状），绑定时序留在装配根（runtime）——
//       臂不 import copilot/assembly，M10 不新增反向边。
//
//   createHindsightSyncArm(options) → { sweep }
//     — 同步队列 drain 与撤销重试清理的两段清扫，一段一记账、逐段吞错
//       （与 runtime 既有 sweepStep 的日志形状逐字节一致：type
//       memory-sweep-error、operation 段名、错误名与详情、ISO 时间戳）——
//       #384 的 drain 与 #390 的 re-retry deletion 收拢为一个具名臂，
//       幂等语义原样（队列 drain 在任务时刻重读归属与授权，中断的批次
//       只是下一批重试）。
//
// 边界：import 面全部 hindsight/ 与 @openbot/shared/logger（M10 组内 + 共享
// 库），零新跨模块边——PlatformScope 经 Parameters<> 从组内签名提取，不 import
// enterprise/contracts。

import { getLogger } from "@openbot/shared/logger";
import type {
  DegradedPreferenceSearch,
  DegradedSourceBoundSearch,
} from "../hindsight/degraded-recall";
import { createDegradedRecallFacade } from "../hindsight/degraded-recall";
import type { DerivedJudgmentReviewService } from "../hindsight/judgment-review";
import type { HindsightPauseControls } from "../hindsight/pause-controls";
import {
  createPersonalMemoryContext,
  renderPersonalMemoryContext,
} from "../hindsight/personal-memory-context";
import type { PreferenceRecallService } from "../hindsight/preference-recall";
import type { HindsightRecoveryGate } from "../hindsight/restore-recovery";
import type {
  SourceBoundAuthorizationStore,
  SourceBoundRecallService,
} from "../hindsight/scoped-recall";

const log = getLogger("server");

type PersonalMemoryContextService = ReturnType<
  typeof createPersonalMemoryContext
>;
type ContextRead = PersonalMemoryContextService["personalMemoryContext"];

/**
 * The loader the Mastra seam (setMastraPersonalMemoryContext) and the governed
 * headless turns (headlessPersonalMemoryContext) share: the context's memories
 * rendered to the #395 block. Scope/botId shapes derive from the group-internal
 * signature — no enterprise/contracts import.
 */
export type RenderedPersonalMemoryLoader = (
  scope: Parameters<ContextRead>[0],
  botId: Parameters<ContextRead>[1],
) => Promise<string>;

export function createHindsightRecallArm(options: {
  /** The two indexed recall services the degraded facade falls back behind. */
  preferences: PreferenceRecallService;
  sourceBound: SourceBoundRecallService;
  /** The authority-row searches the degraded path and the context mode share. */
  preferenceSearch: DegradedPreferenceSearch;
  sourceBoundSearch: DegradedSourceBoundSearch;
  authorizations: SourceBoundAuthorizationStore;
  /**
   * The judgment half's seam (#389 review, narrowed to its query-less context
   * read) — same contract createPersonalMemoryContext declares; absent answers
   * no judgments.
   */
  judgments?: Pick<DerivedJudgmentReviewService, "derivedJudgmentContext">;
  /** The person's pause switches (#392); usage-paused answers empty first. */
  pause?: HindsightPauseControls;
  /** The backup-restore recovery gate (#391); an unreplayed restore keeps answers empty. */
  recovery?: HindsightRecoveryGate;
  now?: () => Date;
}) {
  const degradedRecall = createDegradedRecallFacade(
    options.preferences,
    options.sourceBound,
    options.preferenceSearch,
    options.sourceBoundSearch,
    options.authorizations,
    options.now ? { now: options.now } : {},
  );
  const context = createPersonalMemoryContext({
    recall: degradedRecall,
    preferenceSearch: options.preferenceSearch,
    sourceBoundSearch: options.sourceBoundSearch,
    authorizations: options.authorizations,
    ...(options.judgments ? { judgments: options.judgments } : {}),
    ...(options.pause ? { pause: options.pause } : {}),
    ...(options.recovery ? { recovery: options.recovery } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  const renderedLoader: RenderedPersonalMemoryLoader = async (scope, botId) =>
    renderPersonalMemoryContext(
      (await context.personalMemoryContext(scope, botId)).memories,
    );
  return { degradedRecall, context, renderedLoader };
}

/** One sweep stage: run it, log a failure, never let one stage stop the next. */
const sweepStage = async (operation: string, fn: () => Promise<unknown>) => {
  try {
    await fn();
  } catch (error) {
    log.error(
      {
        type: "memory-sweep-error",
        error: error instanceof Error ? error.name : "UnknownError",
        detail: error instanceof Error ? error.message : String(error),
        context: { operation },
        timestamp: new Date().toISOString(),
      },
      "memory-sweep-error",
    );
  }
};

export function createHindsightSyncArm(options: {
  /** The durable sync queue (#384); drain re-reads ownership at task time, idempotent. */
  queue: { drain(): Promise<unknown> };
  /** The revocation service's outstanding-deletion retries (#390). */
  revocations: { retryOutstandingDeletions(): Promise<unknown> };
}) {
  return {
    /** The two-stage background sweep, same shape the inline assembly ran. */
    async sweep(): Promise<void> {
      await sweepStage("hindsightSyncDrain", () => options.queue.drain());
      await sweepStage("hindsightDeletionRetry", () =>
        options.revocations.retryOutstandingDeletions(),
      );
    },
  };
}

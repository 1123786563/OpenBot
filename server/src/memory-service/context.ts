import { randomUUID } from "node:crypto";
import type { PlatformScope } from "../enterprise/contracts";
import type { MemoryClient, RecallResult, SourceRef } from "./client";

/*
 * #730 运行入口的记忆上下文装载。浏览器、频道与定时入口都走这里：身份来自
 * 服务器签发的 PlatformScope，来源引用由 OpenBot 按运行归属签发——调用方
 * 不能传入自己的 userId 或选择别人的公司/Bot。
 *
 * 不可用（来源失效/中心故障/恢复闸门）时不编造内容：返回空上下文并保留
 * RecallResult，让上层如实呈现"部分不可用"，其他仍授权的内容照常交付。
 */

/**
 * #729 降级提示：普通对话在记忆服务不可用时继续，但必须诚实说明本次没有使用
 * 记忆——否则模型会顺口"记得"不存在的事。提示进的是模型上下文，不是身份事实。
 */
export const MEMORY_UNAVAILABLE_NOTICE =
  "OpenBot memory is unavailable for this run. Do not claim to remember anything about this person; if asked, say memory is unavailable right now.";

export type MemoryContextBlock =
  | { blocked: false; block: string | undefined }
  | { blocked: true; reason: "memory_unavailable" };

/**
 * #729 故障语义：服务故障时普通对话继续（注入诚实提示），依赖记忆的任务暂停。
 * 未装配记忆服务不等于故障——与旧行为一致，不注入也不暂停。
 */
export function memoryContextBlock(
  loaded: { content: string; result: RecallResult } | undefined,
  options: { required: boolean },
): MemoryContextBlock {
  if (!loaded) return { blocked: false, block: undefined };
  if (loaded.result.state !== "unavailable") {
    return { blocked: false, block: loaded.content || undefined };
  }
  if (options.required) return { blocked: true, reason: "memory_unavailable" };
  return { blocked: false, block: MEMORY_UNAVAILABLE_NOTICE };
}

export function createMemoryContextLoader(deps: {
  client: MemoryClient;
  /** 按运行归属签发来源引用（OpenBot 是唯一签发方）。 */
  issueScope: (input: {
    subjectId: string;
    botId: string;
    tenantId: string | null;
  }) => SourceRef;
}) {
  return async function loadMemoryContext(
    scope: PlatformScope,
    botId: string,
  ): Promise<{ content: string; result: RecallResult }> {
    const source = deps.issueScope({
      subjectId: scope.actorId,
      botId,
      tenantId: scope.tenantId ?? null,
    });
    let result: RecallResult;
    try {
      result = await deps.client.recall({
        subjectId: scope.actorId,
        requestId: randomUUID(),
        sourceRefs: [source],
      });
    } catch {
      // 服务自身不可达/鉴权失败：与"来源不可核验"同样不注入内容。
      return {
        content: "",
        result: {
          state: "unavailable",
          memories: [],
          unavailableReasons: ["memory_service_unavailable"],
        },
      };
    }
    if (result.state === "unavailable") return { content: "", result };
    const content = result.memories
      .map((memory) => `- ${memory.content}`)
      .join("\n");
    return { content, result };
  };
}

export type MemoryContextLoader = ReturnType<typeof createMemoryContextLoader>;

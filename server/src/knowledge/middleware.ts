/**
 * 对话检索的 AG-UI 中间件：主路径。
 *
 * 每次 run 前取末条用户消息作为 query 调检索编排层，命中则向 input 注入
 * `id="openbot:knowledge-retrieval"` 的 system 消息与同名 context 条目；未命中或
 * 任何失败都静默按原 input 放行——对话本身永远优先于检索（G4：任何场景对话不中
 * 断）。结构与 PersonalMemoryMiddleware 逐行同构，装配链路也是同一条，remote AG-UI
 * Bot 的行为与 personal memory 现状保持一致，不单独适配（A3）。
 */

import {
  type AbstractAgent,
  type BaseEvent,
  Middleware,
  type RunAgentInput,
} from "@ag-ui/client";
import { defer, from, type Observable, switchMap } from "rxjs";
import { getLogger } from "../../../shared/logger";
import { textOf } from "../agents/message-text";
import type { LoadKnowledgeForBot } from "./retrieval";

const log = getLogger("server");

/** 注入消息与历史重放去重的锚点（§7.5：id/description 注入前先 filter 同名）。 */
const RETRIEVAL_MESSAGE_ID = "openbot:knowledge-retrieval";
const RETRIEVAL_CONTEXT_DESCRIPTION = "OpenBot knowledge retrieval";
/** query 上限与检索层一致：防单条巨长消息拖垮上游。 */
const QUERY_MAX_CHARS = 512;

/** 末条 user 消息的文本。取末条而非整段历史：检索的问题是“这一轮在问什么”。 */
function latestUserQuery(input: RunAgentInput): string {
  for (let index = input.messages.length - 1; index >= 0; index -= 1) {
    const message = input.messages[index];
    if (message?.role !== "user") continue;
    return textOf(message.content).slice(0, QUERY_MAX_CHARS);
  }
  return "";
}

export class KnowledgeRetrievalMiddleware extends Middleware {
  constructor(
    private readonly botId: string,
    private readonly load: LoadKnowledgeForBot,
  ) {
    super();
  }

  run(input: RunAgentInput, next: AbstractAgent): Observable<BaseEvent> {
    // defer + from + switchMap 与 PersonalMemoryMiddleware 同构：异步取 retriever 的
    // 过程整体包进 Observable，错误边界在这里兜住而不是抛进 run 流。
    return defer(() => from(this.loadKnowledge(input))).pipe(
      switchMap((outcome) =>
        this.runNext(
          outcome === null
            ? input
            : {
                ...input,
                messages: [
                  {
                    id: RETRIEVAL_MESSAGE_ID,
                    role: "system" as const,
                    content: outcome,
                  },
                  ...input.messages.filter(
                    (message) => message.id !== RETRIEVAL_MESSAGE_ID,
                  ),
                ],
                context: [
                  ...input.context.filter(
                    (entry) =>
                      entry.description !== RETRIEVAL_CONTEXT_DESCRIPTION,
                  ),
                  {
                    description: RETRIEVAL_CONTEXT_DESCRIPTION,
                    value: outcome,
                  },
                ],
              },
          next,
        ),
      ),
    );
  }

  /**
   * 取这一轮要注入的检索块；null = 原样放行。
   *
   * miss/degraded 已在检索层打过日志，这里不重复打；只有 load/retrieve 自身抛出的
   * 异常在这里兜底记一条 error（不落 query 原文与抛出值，隐私惯例）。
   */
  private async loadKnowledge(input: RunAgentInput): Promise<string | null> {
    try {
      const retriever = await this.load(this.botId);
      if (!retriever) return null;
      const query = latestUserQuery(input);
      // 无 user 文本（如纯工具轮）不打日志直接放行。
      if (query.trim() === "") return null;
      const outcome = await retriever.retrieve(query);
      return outcome.status === "hit" ? outcome.block : null;
    } catch {
      log.error(
        { type: "knowledge-retrieval-degraded", reason: "error" },
        "knowledge-retrieval-degraded",
      );
      return null;
    }
  }
}

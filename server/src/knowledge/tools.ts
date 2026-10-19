/**
 * `search_knowledge`：模型主动检索知识库的 GrantedTool（辅路径）。
 *
 * 中间件每轮自动注入参考资料，但模型有时需要换词重查（多跳/精确检索）——这是那
 * 条路。返回值一律是字符串：命中/未命中是 markUntrusted 包裹的 JSON，降级是带
 * note 的空结果 JSON（降级不是策略拒绝，不写 `Refused.` 前缀，模型需据实告知用
 * 户），只有参数校验失败才是 `Refused. ...`（REFUSAL_MARKER 语义）。
 *
 * 审计不在这里做：GrantedTool 经 buildAgent 的 executeNativeApprovalTool 网关自动
 * 留痕，透传 initiator 即可。
 */

import { z } from "zod";
import { getLogger } from "@openbot/shared/logger";
import type { AuditInitiator } from "../audit";
import type { GrantedTool } from "@openbot/toolkit/granted-tool";
import { markUntrusted } from "../untrusted-content";
import type { KnowledgeRetriever, RetrievalOutcome } from "./retrieval";

const log = getLogger("server");

const searchKnowledgeSchema = z
  .object({
    query: z.string().min(1).max(500),
    /** 限定单个已配置 kb；未含于配置集 → 返回 note 而不是发起注定 404 的请求。 */
    kb_id: z.string().min(1).max(128).optional(),
    top_k: z.number().int().min(1).max(10).optional(),
  })
  .strict();

/**
 * 工具路径的超时档：模型主动查询可容忍长等，用 KB_SERVICE_TIMEOUT_MS（config.timeoutMs，
 * 默认 10s）——由 index.ts 装配时传入；这里保底同值，供测试/独立使用。
 */
const TOOL_TIMEOUT_MS = 10_000;

export function knowledgeTools(options: {
  retriever: KnowledgeRetriever;
  initiator?: AuditInitiator;
  /** kb 白名单，用于 kb_id 参数校验；默认不限制（由 retriever 的 options 决定）。 */
  kbIds?: readonly string[];
  /** 工具路径单次请求超时；默认 KB_SERVICE_TIMEOUT_MS 的缺省值 10s。 */
  timeoutMs?: number;
}): GrantedTool[] {
  // 仿 memoryTools 的局部 tool() 工厂：safeParse 失败统一拒绝文案，业务结果字符串化。
  function tool<T>(
    name: string,
    description: string,
    parameters: z.ZodType<T>,
    execute: (input: T) => Promise<string>,
  ): GrantedTool {
    return {
      name,
      ref: `knowledge/${name}`,
      description,
      parameters,
      ...(options.initiator ? { initiator: options.initiator } : {}),
      async execute(args) {
        const parsed = parameters.safeParse(args);
        if (!parsed.success) return "Refused. Invalid knowledge arguments.";
        return execute(parsed.data);
      },
    };
  }

  return [
    tool(
      "search_knowledge",
      "Search the connected knowledge bases for reference material. Returns ranked excerpts with source titles and scores. Use when the auto-injected context is missing or you need to refine the query.",
      searchKnowledgeSchema,
      async ({ query, kb_id, top_k }) => {
        const startedAt = Date.now();
        let outcome: RetrievalOutcome;
        if (kb_id && options.kbIds && !options.kbIds.includes(kb_id)) {
          // 配置外的 kb：配置类错误，返回 note 让模型换范围，不发起请求。
          log.info(
            {
              type: "knowledge-search-tool",
              status: "miss",
              count: 0,
              tookMs: Date.now() - startedAt,
            },
            "knowledge-search-tool",
          );
          return JSON.stringify({
            results: [],
            note: `knowledge base ${kb_id} is not available`,
          });
        }
        try {
          outcome = await options.retriever.retrieve(query, {
            timeoutMs: options.timeoutMs ?? TOOL_TIMEOUT_MS,
            ...(top_k !== undefined ? { topK: top_k } : {}),
            ...(kb_id !== undefined ? { kbIds: [kb_id] } : {}),
          });
        } catch {
          // 未知异常不驱动熔断状态机，也不抛给网关：降级语义照常返回 note。
          outcome = { status: "degraded", reason: "error" };
        }
        const tookMs = Date.now() - startedAt;
        if (outcome.status === "hit") {
          log.info(
            {
              type: "knowledge-search-tool",
              status: "hit",
              count: outcome.chunks.length,
              tookMs,
            },
            "knowledge-search-tool",
          );
          // 检索内容是知识库文档，进模型上下文必须过 markUntrusted（§7.4）。
          return markUntrusted(
            JSON.stringify({
              results: outcome.chunks.map((chunk) => ({
                n: chunk.index,
                title: chunk.title,
                source: chunk.source,
                score: Number(chunk.score.toFixed(3)),
                content: chunk.content,
              })),
            }),
            "knowledge base retrieval",
          );
        }
        if (outcome.status === "miss") {
          log.info(
            {
              type: "knowledge-search-tool",
              status: "miss",
              count: 0,
              tookMs,
            },
            "knowledge-search-tool",
          );
          return markUntrusted(
            JSON.stringify({
              results: [],
              note: "no matching content in the knowledge bases",
            }),
            "knowledge base retrieval",
          );
        }
        // degraded：不带 Refused. 前缀——降级不是策略拒绝（§7.7）。
        log.info(
          {
            type: "knowledge-search-tool",
            status: "degraded",
            count: 0,
            tookMs,
            reason: outcome.reason,
          },
          "knowledge-search-tool",
        );
        return JSON.stringify({
          results: [],
          note: "knowledge retrieval is temporarily unavailable",
        });
      },
    ),
  ];
}

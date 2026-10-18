// server/src/kb/application/service/kb-restricted-retrieval.ts
// MT037（Issue #80）：受限检索入口——候选、重排与进入模型之前限制范围。
//
// 票面：知识检索先确定允许的库与文档集合，再在检索端限制返回范围；无权内容
// 不会进入重排、不会进入模型上下文，也不会通过引用泄露。向量集合/命名空间
// 按归属隔离；跨范围检索返回空而不是他人内容；引用只含有权文档且文本不泄露
// 无权片段；公司范围 Key 不被当作团队授权使用。
//
// 本入口是 MT036 受限查询入口（kb-restricted-query.ts）披露的下游检索/引用
// 消费面（其 D7 边界），Spec §6 顺序不可逆：
//
//   先定允许集合（narrowRetrievalScope：授权 + 跨库一致）
//     → 检索端限制（kbIds = 候选集合、tenantId = scope 租户，交给 search）
//       → （命中才有）重排——重排输入就是受限结果行
//         → （引用才进）模型上下文——citations 只从受限结果行投影。
//
// 「检索后过滤」不是隔离机制。候选集合收窄与检索端限制是结构主机制；组装后
// 按候选集合再过滤结果行只是纵深防御（MUT-D 变异如实验证其非主机制地位）。
//
// 三条铁律（与 MT036 入口同款，双门冗余）：
//   1. 请求者只有 seam 签发的受信 PlatformScope。KB 内部服务身份（API-Key
//      的 tenantId+role+kbScope，空 kbScope=公司内全库）没有 principal/团队
//      事实，结构上进不来——公司范围 Key 在这里得到 KB_REQUESTER_INVALID，
//      不是公司全域检索；Key 自带的 kbScope 白名单只是寻址不是授权，本模块
//      源码不出现该词汇（注释剥离后源码级断言钉死）。
//   2. 空候选 = 检索端零调用：embedder、向量引擎、重排器一次都不被调用，
//      返回空而不是他人内容（测试以调用计数断言）。
//   3. 候选集合即命名空间的授权投影：向量查询的 filter 由候选集合 + scope
//      租户构成（tenant_id match + kb_id any + enabled），客户端输入的 kbIds
//      只有经收窄存活的部分才可能到达引擎；candidateKbIds 随结果返回（可
//      观测审计面）。
//
// 引用面（AC3）：citations 与受限结果行 1:1，snippet 是该行内容的有界前缀
// （DEFAULT_CITATION_SNIPPET_RUNES）；无权内容根本不进入结果行（铁律 2/3），
// 引用无从泄漏；snippet 截断保证引用文本不携带超界片段。
//
// 边界（诚实披露）：
//   - search 缝隙与 KbHandlerDeps.search 同形（SearchRequest → SearchOutcome），
//     生产装配接 hybridSearch；HTTP 路由接线属下游消费票（MT009/MT011/MT036
//     同判例：接口冻结，消费方按签名接入）。
//   - 相邻链表扩展（kb-search 既有行为）只发生在命中块的文档链内；文档链
//     邻块属于同一授权库的同一文档，不构成跨范围（测试钉死扩展不出命名空间）。

import type { PlatformScope } from "../../../enterprise/contracts";
import type { KbOwnershipAuthority } from "../../../enterprise/tenancy/kb-ownership";
import { assertTrustedScope } from "../../../enterprise/tenancy/store";
import type { Db } from "../../db/client";
import { createRestrictedKbQueryService } from "./kb-restricted-query";
import type { SearchResult } from "./kb-search";

/** 受限检索入口的请求者：只有服务端签发的受信 scope，别无他物。 */
export interface KbRetrievalRequester {
  readonly scope: PlatformScope;
}

/** 受限检索请求（kbIds 是请求者的愿望；候选集合由入口构造）。 */
export interface KbRetrievalRequest {
  readonly kbIds: readonly string[];
  readonly query: string;
  readonly topK: number;
  readonly scoreThreshold: number;
  readonly hybrid: boolean;
  readonly rerank?: boolean;
}

/** 引用面：进入模型上下文的引用（全部来自受限结果行）。 */
export interface KbRestrictedCitation {
  readonly chunkId: string;
  readonly docId: string;
  readonly kbId: string;
  readonly title: string;
  readonly source: string;
  readonly score: number;
  /** 有权 chunk 内容的有界前缀（绝不携带候选外片段）。 */
  readonly snippet: string;
}

export type KbRestrictedRetrievalResult = {
  readonly ok: true;
  /** 实际进入检索端的候选集合（= 收窄后的「授权 + 一致」集合，审计面）。 */
  readonly candidateKbIds: readonly string[];
  readonly results: readonly SearchResult[];
  readonly citations: readonly KbRestrictedCitation[];
  readonly count: number;
};

/** 检索缝隙：与 KbHandlerDeps.search 同形（生产装配接 hybridSearch）。 */
export type RestrictedSearchSeam = (request: {
  tenantId: string;
  kbIds: string[];
  query: string;
  topK: number;
  scoreThreshold: number;
  hybrid: boolean;
  rerank?: boolean;
}) => Promise<{
  results: SearchResult[];
  count: number;
}>;

/** 引用 snippet 的默认有界长度（runes；引用文本不携带超界片段）。 */
export const DEFAULT_CITATION_SNIPPET_RUNES = 280;

/**
 * 引用投影（纯函数，冻结结果）：snippet = 内容的 rune 有界前缀。
 * maxRunes 非正整数时响亮拒绝（KB_CITATION_INPUT_INVALID）。
 */
export function restrictedCitationOf(
  row: Pick<
    SearchResult,
    "chunkId" | "docId" | "kbId" | "title" | "source" | "score" | "content"
  >,
  maxRunes: number = DEFAULT_CITATION_SNIPPET_RUNES,
): KbRestrictedCitation {
  if (
    !Number.isSafeInteger(maxRunes) ||
    maxRunes < 1 ||
    typeof row.content !== "string"
  ) {
    throw new Error("KB_CITATION_INPUT_INVALID");
  }
  const runes = Array.from(row.content);
  return Object.freeze({
    chunkId: row.chunkId,
    docId: row.docId,
    kbId: row.kbId,
    title: row.title,
    source: row.source,
    score: row.score,
    snippet: runes.slice(0, maxRunes).join(""),
  });
}

function assertRequester(requester: KbRetrievalRequester): PlatformScope {
  if (
    requester === null ||
    typeof requester !== "object" ||
    !("scope" in requester) ||
    requester.scope === null ||
    typeof requester.scope !== "object"
  ) {
    // 内部 API-Key 身份（tenantId+role+白名单字段）与一切无 scope 形状在此
    // 被结构性拒绝——它们不是受限检索入口的请求者类型。
    throw new Error("KB_REQUESTER_INVALID");
  }
  assertTrustedScope(requester.scope);
  return requester.scope;
}

function assertRequest(request: KbRetrievalRequest): void {
  if (request === null || typeof request !== "object") {
    throw new Error("KB_RETRIEVAL_INPUT_INVALID");
  }
  if (typeof request.query !== "string" || request.query.trim() === "") {
    throw new Error("KB_RETRIEVAL_INPUT_INVALID");
  }
  if (
    !Number.isSafeInteger(request.topK) ||
    request.topK < 1 ||
    !Number.isFinite(request.scoreThreshold) ||
    request.scoreThreshold < 0 ||
    typeof request.hybrid !== "boolean"
  ) {
    throw new Error("KB_RETRIEVAL_INPUT_INVALID");
  }
  if (!Array.isArray(request.kbIds)) {
    throw new Error("KB_RETRIEVAL_INPUT_INVALID");
  }
}

export function createRestrictedRetrievalService(input: {
  authority: KbOwnershipAuthority;
  kbDb: Db;
  search: RestrictedSearchSeam;
}) {
  const { search } = input;
  // MT036 受限查询入口：候选集合构造的唯一事实源（授权 + 跨库一致 + 输入
  // 卫生都在那里钉死；本入口的请求者门是双门冗余的第一道）。
  const queryService = createRestrictedKbQueryService({
    authority: input.authority,
    kbDb: input.kbDb,
  });
  return {
    async retrieve(
      requester: KbRetrievalRequester,
      request: KbRetrievalRequest,
    ): Promise<KbRestrictedRetrievalResult> {
      const scope = assertRequester(requester);
      assertRequest(request);
      // 先定允许集合（Spec §6）：收窄到「授权 + 跨库一致」的 id（去重、
      // 首现序、输入卫生 >100/非串/空串 KB_RETRIEVAL_INPUT_INVALID）。
      const narrowed = await queryService.narrowRetrievalScope(
        requester,
        request.kbIds,
      );
      const allowed = [...narrowed.allowed];
      if (allowed.length === 0) {
        // 空候选 = 检索端零调用：embedder/向量引擎/重排器一次都不被调用，
        // 返回空而不是他人内容。
        return Object.freeze({
          ok: true as const,
          candidateKbIds: Object.freeze([]),
          results: Object.freeze([]),
          citations: Object.freeze([]),
          count: 0,
        });
      }
      // 检索端限制：唯一一次 search 调用；候选集合本身 + 服务端租户身份。
      const outcome = await search({
        tenantId: scope.tenantId,
        kbIds: allowed,
        query: request.query,
        topK: request.topK,
        scoreThreshold: request.scoreThreshold,
        hybrid: request.hybrid,
        ...(request.rerank !== undefined ? { rerank: request.rerank } : {}),
      });
      // 纵深防御（非主机制）：丢弃任何 kbId 不在候选集合内的结果行。
      const candidates = new Set(allowed);
      const results = outcome.results.filter((row) => candidates.has(row.kbId));
      const citations = results.map((row) => restrictedCitationOf(row));
      return Object.freeze({
        ok: true as const,
        candidateKbIds: Object.freeze(allowed),
        results: Object.freeze(results),
        citations: Object.freeze(citations),
        count: results.length,
      });
    },
  };
}

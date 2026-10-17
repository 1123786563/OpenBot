// server/src/kb/application/service/kb-restricted-query.ts
// MT036（Issue #79）：知识库侧受限查询入口。
//
// 票面：查询只返回有权范围内的库与文档；跨库引用通过同步版本与调用时授权
// 校验，缺失或不一致时拒绝而不是放行；知识库侧的内部服务身份不能被普通
// 请求用来获得无限公司范围。
//
// 本入口是普通请求（服务端已验证的公司/团队/主体事实）访问 KB 的唯一查询
// 面，三条铁律：
//
//   1. 请求者必须是 seam 签发的受信 PlatformScope（assertTrustedScope）。
//      KB 内部服务身份（API-Key 的 tenantId+role+kbScope，空 kbScope=公司内
//      全库）没有 principal/团队事实，结构上进不来——普通请求复用内部 Key
//      得到的是 KB_REQUESTER_INVALID，不是公司全域视野。本模块源码不出现
//      内部身份词汇（kbScope/APIKeyEntry），授权只读主库权威的判定事实。
//   2. 授权先于一切内容访问（Spec §6：先确定允许的 KB/文档集合，再在检索
//      端限制返回范围）：deny = canonical 不可见语义（RESOURCE_NOT_FOUND，
//      与全系统唯一 not-found 形状逐字节一致）——不存在、跨公司、跨团队、
//      无授权、已删除对外不可区分，列表与计数不泄露存在性。
//   3. 跨库一致性逐次比对（调用时，无缓存）：授权放行后读 KB 库内容行与
//      归属镜像行（knowledge_base_ownership_states），经
//      compareKbOwnershipSnapshot 比对；镜像缺失、租户/团队不符、同步版本
//      落后一律拒绝（KB_OWNERSHIP_* 确定性码），绝不把不一致的库放行给
//      任何消费者。归属迁移或版本推进未同步的库在下一次调用即消失。
//
// 边界（诚实披露）：
//   - 检索收窄（narrowRetrievalScope）返回「授权且一致」的 id 集合；把集合
//     交给检索器并在检索端限制返回范围是调用方（接线票）的契约。未授权/
//     不一致 id 不出现在结果里，也不携带任何原因（不泄露）。
//   - 列表对不一致镜像的 KB 采取「不浮现」语义：它是列表上下文的拒绝形态，
//     与单库访问的显式拒绝码同为「不放行」，只是没有可指向的存在性。
//   - 本票交付入口语义与验证；HTTP 路由接线属下游消费票（与 MT009/MT011
//     装配先例同判例：接口冻结，消费方按签名接入）。

import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { PlatformScope } from "../../../enterprise/contracts";
import {
  compareKbOwnershipSnapshot,
  type KbOwnershipAuthority,
  type KbOwnershipRegistration,
  type KbSyncComparison,
} from "../../../enterprise/tenancy/kb-ownership";
import { assertTrustedScope } from "../../../enterprise/tenancy/store";
import type { Db } from "../../db/client";
import { knowledgeBaseOwnershipStates } from "../../db/ownership-schema";
import { knowledgeBases } from "../../db/schema";

/** 受限查询入口的请求者：只有服务端签发的受信 scope，别无他物。 */
export interface KbQueryRequester {
  readonly scope: PlatformScope;
}

/** 单库视图（只在授权 + 一致之后返回）。 */
export interface KbRestrictedView {
  readonly id: string;
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly description: string;
  /** 当前镜像的同步版本令牌（与主库注册一致才可能出现在这里）。 */
  readonly syncVersion: string;
}

export type KbRestrictedGetResult =
  | { readonly ok: true; readonly kb: KbRestrictedView }
  | {
      readonly ok: false;
      readonly kind: "invisible";
      readonly verdict: {
        readonly outcome: "deny";
        readonly code: "RESOURCE_NOT_FOUND";
      };
    }
  | {
      readonly ok: false;
      readonly kind: "ownership-inconsistent";
      readonly code:
        | "KB_OWNERSHIP_MISSING"
        | "KB_OWNERSHIP_WORKSPACE_MISMATCH"
        | "KB_SYNC_VERSION_STALE";
    };

export type KbRestrictedListResult =
  | { readonly ok: true; readonly items: readonly KbRestrictedView[] }
  | {
      readonly ok: false;
      readonly kind: "invisible";
      readonly verdict: {
        readonly outcome: "deny";
        readonly code: "RESOURCE_NOT_FOUND";
      };
    };

export type KbRetrievalNarrowResult = {
  readonly ok: true;
  readonly allowed: readonly string[];
};

export interface RestrictedKbQueryService {
  listKnowledgeBases(
    requester: KbQueryRequester,
  ): Promise<KbRestrictedListResult>;
  getKnowledgeBase(
    requester: KbQueryRequester,
    kbId: string,
  ): Promise<KbRestrictedGetResult>;
  /**
   * 检索前收窄：请求的 kbIds 中只保留「授权且跨库一致」的 id（去重、保持
   * 首次出现顺序）。未授权/不一致/不存在的 id 静默排除——不携带原因、
   * 不泄露存在性；检索器只应看到返回的集合。
   */
  narrowRetrievalScope(
    requester: KbQueryRequester,
    requestedKbIds: readonly string[],
  ): Promise<KbRetrievalNarrowResult>;
}

function assertRequester(requester: KbQueryRequester): PlatformScope {
  if (
    requester === null ||
    typeof requester !== "object" ||
    !("scope" in requester) ||
    requester.scope === null ||
    typeof requester.scope !== "object"
  ) {
    // 内部 API-Key 身份（tenantId+role+kbScope）与一切无 scope 形状在此
    // 被结构性拒绝——它们不是受限查询入口的请求者类型。
    throw new Error("KB_REQUESTER_INVALID");
  }
  assertTrustedScope(requester.scope);
  return requester.scope;
}

function assertKbIds(requestedKbIds: readonly string[]): string[] {
  if (!Array.isArray(requestedKbIds)) {
    throw new Error("KB_RETRIEVAL_INPUT_INVALID");
  }
  if (requestedKbIds.length > 100) {
    throw new Error("KB_RETRIEVAL_INPUT_INVALID");
  }
  const unique: string[] = [];
  for (const id of requestedKbIds) {
    if (typeof id !== "string" || id.trim() === "") {
      throw new Error("KB_RETRIEVAL_INPUT_INVALID");
    }
    if (!unique.includes(id)) unique.push(id);
  }
  return unique;
}

/** 列表上下文的一致性门：不一致 = 不浮现（拒绝的列表形态）。 */
function consistentOrSkip(
  registration: KbOwnershipRegistration,
  snapshot:
    | { tenantId: string; workspaceId: string; syncVersion: string }
    | undefined,
  seen: Map<string, KbSyncComparison>,
): boolean {
  const comparison = compareKbOwnershipSnapshot(registration, snapshot ?? null);
  seen.set(registration.kbId, comparison);
  return comparison.ok;
}

export function createRestrictedKbQueryService(input: {
  authority: KbOwnershipAuthority;
  kbDb: Db;
}): RestrictedKbQueryService {
  const { authority, kbDb } = input;
  return {
    async listKnowledgeBases(requester) {
      const scope = assertRequester(requester);
      const registrations =
        await authority.listVisibleKnowledgeBaseRegistrations(scope);
      if (registrations.length === 0) {
        return Object.freeze({ ok: true, items: Object.freeze([]) });
      }
      const ids = registrations.map((registration) => registration.kbId);
      const [rows, states] = await Promise.all([
        kbDb
          .select()
          .from(knowledgeBases)
          .where(
            and(
              inArray(knowledgeBases.id, ids),
              eq(knowledgeBases.tenantId, scope.tenantId),
              isNull(knowledgeBases.deletedAt),
            ),
          )
          .orderBy(asc(knowledgeBases.createdAt), asc(knowledgeBases.id)),
        kbDb
          .select()
          .from(knowledgeBaseOwnershipStates)
          .where(inArray(knowledgeBaseOwnershipStates.knowledgeBaseId, ids)),
      ]);
      const stateByKbId = new Map(
        states.map((state) => [state.knowledgeBaseId, state]),
      );
      const registrationById = new Map(
        registrations.map((registration) => [registration.kbId, registration]),
      );
      const seen = new Map<string, KbSyncComparison>();
      const items: KbRestrictedView[] = [];
      for (const row of rows) {
        const registration = registrationById.get(row.id);
        if (registration === undefined) continue;
        const state = stateByKbId.get(row.id);
        if (state === undefined) continue;
        if (!consistentOrSkip(registration, state, seen)) continue;
        items.push({
          id: row.id,
          tenantId: row.tenantId,
          workspaceId: registration.workspaceId,
          name: row.name,
          description: row.description,
          syncVersion: state.syncVersion,
        });
      }
      return Object.freeze({ ok: true, items: Object.freeze(items) });
    },

    async getKnowledgeBase(requester, kbId) {
      const scope = assertRequester(requester);
      if (typeof kbId !== "string" || kbId.trim() === "") {
        throw new Error("KB_ID_REQUIRED");
      }
      const decision = await authority.authorizeKnowledgeBase(scope, kbId);
      if (decision.outcome === "deny") {
        return {
          ok: false,
          kind: "invisible",
          verdict: { outcome: "deny", code: "RESOURCE_NOT_FOUND" },
        };
      }
      const [row] = await kbDb
        .select()
        .from(knowledgeBases)
        .where(
          and(
            eq(knowledgeBases.id, kbId),
            eq(knowledgeBases.tenantId, scope.tenantId),
            isNull(knowledgeBases.deletedAt),
          ),
        )
        .limit(1);
      if (row === undefined) {
        // 跨库内容缺失 = 不可见语义（与授权 deny 逐字节同形，不泄露区别）。
        return {
          ok: false,
          kind: "invisible",
          verdict: { outcome: "deny", code: "RESOURCE_NOT_FOUND" },
        };
      }
      const [state] = await kbDb
        .select()
        .from(knowledgeBaseOwnershipStates)
        .where(eq(knowledgeBaseOwnershipStates.knowledgeBaseId, kbId))
        .limit(1);
      const comparison = compareKbOwnershipSnapshot(
        decision.registration,
        state ?? null,
      );
      if (!comparison.ok) {
        return {
          ok: false,
          kind: "ownership-inconsistent",
          code: comparison.code,
        };
      }
      return {
        ok: true,
        kb: {
          id: row.id,
          tenantId: row.tenantId,
          workspaceId: decision.registration.workspaceId,
          name: row.name,
          description: row.description,
          syncVersion: state.syncVersion,
        },
      };
    },

    async narrowRetrievalScope(requester, requestedKbIds) {
      const scope = assertRequester(requester);
      const ids = assertKbIds(requestedKbIds);
      if (ids.length === 0) {
        return Object.freeze({ ok: true, allowed: Object.freeze([]) });
      }
      const registrations =
        await authority.listVisibleKnowledgeBaseRegistrations(scope);
      const authorizedIds = new Set(registrations.map((r) => r.kbId));
      const candidates = ids.filter((id) => authorizedIds.has(id));
      if (candidates.length === 0) {
        return Object.freeze({ ok: true, allowed: Object.freeze([]) });
      }
      const [rows, states] = await Promise.all([
        kbDb
          .select({ id: knowledgeBases.id })
          .from(knowledgeBases)
          .where(
            and(
              inArray(knowledgeBases.id, candidates),
              eq(knowledgeBases.tenantId, scope.tenantId),
              isNull(knowledgeBases.deletedAt),
            ),
          ),
        kbDb
          .select()
          .from(knowledgeBaseOwnershipStates)
          .where(
            inArray(knowledgeBaseOwnershipStates.knowledgeBaseId, candidates),
          ),
      ]);
      const existingIds = new Set(rows.map((row) => row.id));
      const registrationById = new Map(
        registrations.map((registration) => [registration.kbId, registration]),
      );
      const stateByKbId = new Map(
        states.map((state) => [state.knowledgeBaseId, state]),
      );
      const allowed: string[] = [];
      for (const id of ids) {
        if (!existingIds.has(id)) continue;
        const registration = registrationById.get(id);
        if (registration === undefined) continue;
        const comparison = compareKbOwnershipSnapshot(
          registration,
          stateByKbId.get(id) ?? null,
        );
        if (!comparison.ok) continue;
        allowed.push(id);
      }
      return Object.freeze({ ok: true, allowed: Object.freeze(allowed) });
    },
  };
}

// server/src/kb/application/service/kb-document-lifecycle.ts
// MT038（Issue #81）：文档上传、删除、导入与重解析的作用域（受限生命周期入口）。
//
// 票面：文档上传、删除、导入任务、重解析、原文件与 chunk/revision 都固定在
// 发起时的公司与团队；后台导入任务不会把内容写进别的范围。
//
// 本入口是普通请求（服务端已验证的公司/团队/主体事实）对 KB 文档执行写动作
// 的唯一生命周期面，四条铁律：
//
//   1. 请求者必须是 seam 签发的受信 PlatformScope（assertTrustedScope）。
//      内部服务身份形状（tenantId+role，无 principal/团队事实）结构性进
//      不来——得到的是 KB_REQUESTER_INVALID，不是公司全域文档视野。本模块
//      源码不出现内部身份词汇，授权只读主库权威的判定事实。
//   2. 先允许集合再动作（Spec §6 同序）：每个动作先经 MT036 权威
//      （authorizeKnowledgeBase）判定目标 KB——deny = canonical 不可见
//      （RESOURCE_NOT_FOUND，与全系统唯一 not-found 形状逐字节一致）；
//      放行后逐次比对 KB 库归属镜像（compareKbOwnershipSnapshot）——
//      镜像缺失/租户不符/同步版本落后一律确定性拒绝（KB_OWNERSHIP_*），
//      绝不把不一致的库放行给任何写动作。
//   3. 文档级包含性：delete/reparse/原文件读取要求文档行属于已授权 KB 且
//      属于请求者租户（doc.knowledgeBaseId === kbId && doc.tenantId ===
//      scope.tenantId），否则与「不存在」同一不可见形状——跨范围文档 id
//      不泄露存在性、不触发任何删除/读取副作用。
//   4. 任务保存发起归属，执行时重建作用域：入队载荷携带
//      initiatingWorkspaceId / initiatingPrincipalId（发起时的团队与主体，
//      审计与追溯面）；执行侧（rebuildDocumentExecutionPayload）以权威行
//      与镜像重建 tenantId/kbId——payload 谎报不能改变 chunk/revision/向量
//      点的归属；镜像缺失或租户漂移时执行侧拒绝写入（skip），绝不把内容
//      写进无归属或漂移的范围。
//
// 边界（诚实披露）：
//   - 文档团队归属不新增列：KB 镜像行（knowledge_base_ownership_states）
//     是团队归属的单一事实源，文档经所属 KB 继承；发起归属仅随任务载荷
//     持久化（票面 AC2 的对象是任务）。写授权词表（谁能对哪个 KB 上传/
//     删除）属 KB 管理票——本入口的放行面 = 读授权（MT036 allow 集合）+
//     镜像一致 + seam 信任。
//   - 执行侧重建只覆盖 KB 库内权威（文档行 + 镜像）；主库注册的一致性
//     在每个动作入口已判定，执行侧不重复跨库求值。
//   - HTTP 路由接线与原文件下载签发（MT056 签名下载规则）属下游消费票；
//     readOriginalFile 交付的是下载签发必须通过的作用域判定。

import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import type { PlatformScope } from "../../../enterprise/contracts";
import {
  compareKbOwnershipSnapshot,
  type KbOwnershipAuthority,
} from "../../../enterprise/tenancy/kb-ownership";
import {
  notFoundVerdict,
  type ResourceNotFoundVerdict,
} from "../../../enterprise/tenancy/not-found-semantics";
import { assertTrustedScope } from "../../../enterprise/tenancy/store";
import type { Db } from "../../db/client";
import { knowledgeBaseOwnershipStates } from "../../db/ownership-schema";
import { knowledgeBases, knowledges } from "../../db/schema";
import {
  type ProcessDeps,
  processDocument,
} from "../../tasks/document-process";
import {
  type DocumentProcessPayload,
  enqueueDocumentProcess,
} from "../../tasks/queue";
import type { IndexWriter } from "../repository/retriever/qdrant/index-writer";
import { ALLOWED_FILE_EXTENSIONS, extensionOf } from "./knowledge-create";
import { deleteKnowledge } from "./knowledge-delete";

/** 任务载荷的发起归属扩展（与既有 DocumentProcessPayload 结构兼容地随行）。 */
export type ScopedDocumentProcessPayload = DocumentProcessPayload & {
  readonly initiatingWorkspaceId: string;
  readonly initiatingPrincipalId: string;
};

/** 受限生命周期入口的请求者：只有服务端签发的受信 scope，别无他物。 */
export interface KbLifecycleRequester {
  readonly scope: PlatformScope;
}

export type DocumentInvisible = {
  readonly ok: false;
  readonly kind: "invisible";
  readonly verdict: ResourceNotFoundVerdict;
};

export type DocumentOwnershipInconsistent = {
  readonly ok: false;
  readonly kind: "ownership-inconsistent";
  readonly code:
    | "KB_OWNERSHIP_MISSING"
    | "KB_OWNERSHIP_WORKSPACE_MISMATCH"
    | "KB_SYNC_VERSION_STALE";
};

export type DocumentWriteResult =
  | {
      readonly ok: true;
      readonly knowledgeId: string;
      /** true = 命中同租户同库同哈希的活文档（既有行，未再次入队）。 */
      readonly duplicate: boolean;
    }
  | DocumentInvisible
  | DocumentOwnershipInconsistent;

export type DocumentDeleteResult =
  | { readonly ok: true; readonly deleted: true }
  | DocumentInvisible
  | DocumentOwnershipInconsistent;

export type DocumentReparseResult =
  | {
      readonly ok: true;
      readonly knowledgeId: string;
      readonly attempt: number;
    }
  | DocumentInvisible
  | DocumentOwnershipInconsistent;

export type OriginalFileResult =
  | {
      readonly ok: true;
      readonly file: {
        readonly path: string;
        readonly fileName: string;
        readonly fileType: string;
        readonly fileSize: number;
      };
    }
  | DocumentInvisible
  | DocumentOwnershipInconsistent;

/** file/text 二入口的上传输入（url 导入走 importDocument）。 */
export type UploadDocumentInput =
  | {
      readonly kbId: string;
      readonly kind: "file";
      readonly fileName: string;
      readonly content: Uint8Array;
      readonly title?: string;
    }
  | {
      readonly kbId: string;
      readonly kind: "text";
      readonly content: string;
      readonly title?: string;
    };

function assertRequester(requester: KbLifecycleRequester): PlatformScope {
  if (
    requester === null ||
    typeof requester !== "object" ||
    !("scope" in requester) ||
    requester.scope === null ||
    typeof requester.scope !== "object"
  ) {
    // 内部服务身份形状与一切无 scope 形状在此被结构性拒绝——它们不是
    // 受限生命周期入口的请求者类型。
    throw new Error("KB_REQUESTER_INVALID");
  }
  assertTrustedScope(requester.scope);
  return requester.scope;
}

function assertKbId(kbId: string): string {
  if (typeof kbId !== "string" || kbId.trim() === "") {
    throw new Error("KB_ID_REQUIRED");
  }
  return kbId;
}

function assertDocId(docId: string): string {
  if (typeof docId !== "string" || docId.trim() === "") {
    throw new Error("KB_DOCUMENT_ID_REQUIRED");
  }
  return docId;
}

/** canonical 不可见结果（与 not-found-semantics 单一事实源同字节，冻结）。 */
function invisible(): DocumentInvisible {
  return Object.freeze({
    ok: false as const,
    kind: "invisible" as const,
    verdict: notFoundVerdict(),
  });
}

// ---------------------------------------------------------------------------
// 执行时作用域重建（AC2/AC4：行与镜像是权威，payload 不是）
// ---------------------------------------------------------------------------

export type ExecutionScopeRebuild =
  | {
      readonly kind: "proceed";
      /** 以权威行改写作用域字段后的 payload（传入冻结管线）。 */
      readonly payload: DocumentProcessPayload;
      /** 当前镜像的团队（重建后的归属事实）。 */
      readonly workspaceId: string;
    }
  | {
      readonly kind: "skip";
      readonly reason: "missing" | "ownership-missing" | "ownership-mismatch";
    };

/**
 * 执行时重建作用域：文档行是租户/库归属的权威，归属镜像是团队归属的权威。
 * 载荷携带的 tenantId/kbId 只是寻址投影——file 型 filePath、url 型 url 一并
 * 以行上权威值改写（载荷谎报不能重定向读取）。镜像缺失（无归属可重建）或
 * 镜像租户与文档行漂移（范围不一致）→ skip，调用方不得写入任何内容。
 */
export async function rebuildDocumentExecutionPayload(
  db: Db,
  payload: DocumentProcessPayload,
): Promise<ExecutionScopeRebuild> {
  const [row] = await db
    .select()
    .from(knowledges)
    .where(eq(knowledges.id, payload.knowledgeId))
    .limit(1);
  if (row === undefined) {
    return Object.freeze({ kind: "skip" as const, reason: "missing" });
  }
  const [state] = await db
    .select()
    .from(knowledgeBaseOwnershipStates)
    .where(
      eq(knowledgeBaseOwnershipStates.knowledgeBaseId, row.knowledgeBaseId),
    )
    .limit(1);
  if (state === undefined) {
    return Object.freeze({
      kind: "skip" as const,
      reason: "ownership-missing",
    });
  }
  if (state.tenantId !== row.tenantId) {
    return Object.freeze({
      kind: "skip" as const,
      reason: "ownership-mismatch",
    });
  }
  const rebuilt: DocumentProcessPayload = Object.freeze({
    ...payload,
    tenantId: row.tenantId,
    kbId: row.knowledgeBaseId,
    ...(row.type === "file" && row.filePath !== ""
      ? { filePath: row.filePath }
      : {}),
    ...(row.type === "url" ? { url: row.source } : {}),
  });
  return Object.freeze({
    kind: "proceed" as const,
    payload: rebuilt,
    workspaceId: state.workspaceId,
  });
}

/**
 * 冻结摄取管线的执行侧包装：先重建作用域（skip 不入管线），再以重建后的
 * 载荷调用 processDocument——chunk/revision 行与向量点因此继承权威归属，
 * 幂等守卫（deleting/completed/attemptSuperseded）语义原样保留。
 */
export async function processDocumentWithScopeRebuild(
  deps: ProcessDeps,
  payload: DocumentProcessPayload,
): Promise<{ skipped?: string }> {
  const rebuilt = await rebuildDocumentExecutionPayload(deps.db, payload);
  if (rebuilt.kind === "skip") {
    return { skipped: rebuilt.reason };
  }
  return processDocument(deps, rebuilt.payload);
}

// ---------------------------------------------------------------------------
// 受限生命周期入口
// ---------------------------------------------------------------------------

/** 默认存储：{root}/{kbId}/{knowledgeId}/{fileName}（与冻结创建面同布局）。 */
async function defaultStoreFile(
  root: string,
  kbId: string,
  knowledgeId: string,
  bytes: Uint8Array,
  fileName: string,
): Promise<string> {
  const dir = join(root, kbId, knowledgeId);
  await mkdir(dir, { recursive: true });
  const safe = fileName.replace(/[/\\]/g, "_");
  const path = join(dir, safe);
  await writeFile(path, bytes);
  return path;
}

export interface RestrictedDocumentLifecycleService {
  /** 上传（file/text 二入口）。deny = 不可见；不一致 = KB_OWNERSHIP_*。 */
  uploadDocument(
    requester: KbLifecycleRequester,
    input: UploadDocumentInput,
  ): Promise<DocumentWriteResult>;
  /** url 导入任务（发起归属随载荷保存）。 */
  importDocument(
    requester: KbLifecycleRequester,
    input: {
      readonly kbId: string;
      readonly url: string;
      readonly title?: string;
    },
  ): Promise<DocumentWriteResult>;
  /** 删除（级联顺序与幂等语义由冻结删除面承载；跨范围 = 不可见）。 */
  deleteDocument(
    requester: KbLifecycleRequester,
    input: { readonly kbId: string; readonly docId: string },
  ): Promise<DocumentDeleteResult>;
  /** 重解析（attempt+1 世代号；发起归属随载荷保存）。 */
  reparseDocument(
    requester: KbLifecycleRequester,
    input: { readonly kbId: string; readonly docId: string },
  ): Promise<DocumentReparseResult>;
  /** 原文件读取判定（下载签发必须通过的作用域门；非成员不可达）。 */
  readOriginalFile(
    requester: KbLifecycleRequester,
    input: { readonly kbId: string; readonly docId: string },
  ): Promise<OriginalFileResult>;
}

export function createRestrictedDocumentLifecycleService(deps: {
  readonly authority: KbOwnershipAuthority;
  readonly kbDb: Db;
  readonly indexWriter: IndexWriter;
  /** 覆盖默认存储路径（测试注入内存态）。 */
  readonly storeFile?: (
    kbId: string,
    knowledgeId: string,
    bytes: Uint8Array,
    fileName: string,
  ) => Promise<string>;
  /** local 存储根（STORAGE_LOCAL_PATH；storeFile 缺省时必填）。 */
  readonly storageRoot?: string;
  /** 入队缝隙（缺省接冻结 enqueueDocumentProcess；测试注入记录器）。 */
  readonly enqueue?: (payload: ScopedDocumentProcessPayload) => Promise<void>;
}): RestrictedDocumentLifecycleService {
  const { authority, kbDb, indexWriter } = deps;
  if (deps.storeFile === undefined && deps.storageRoot === undefined) {
    throw new Error("KB_DOCUMENT_STORAGE_REQUIRED");
  }
  const storeFile =
    deps.storeFile ?? defaultStoreFile.bind(null, deps.storageRoot as string);
  const enqueue =
    deps.enqueue ??
    ((payload: ScopedDocumentProcessPayload) =>
      enqueueDocumentProcess(payload));

  /** 文档级包含性：不属于已授权 KB / 本租户 / 已删除 → 同一不可见形状。 */
  async function containedDocument(
    scope: PlatformScope,
    kbId: string,
    docId: string,
  ): Promise<
    | { readonly ok: true; readonly doc: typeof knowledges.$inferSelect }
    | DocumentInvisible
  > {
    const [doc] = await kbDb
      .select()
      .from(knowledges)
      .where(and(eq(knowledges.id, docId), isNull(knowledges.deletedAt)))
      .limit(1);
    if (
      doc === undefined ||
      doc.tenantId !== scope.tenantId ||
      doc.knowledgeBaseId !== kbId
    ) {
      return invisible();
    }
    return Object.freeze({ ok: true as const, doc });
  }
  /** 先允许集合再动作：KB 授权 → 内容行在位 → 归属镜像一致。 */
  async function authorizeTarget(
    requester: KbLifecycleRequester,
    kbId: string,
  ): Promise<
    | {
        readonly ok: true;
        readonly scope: PlatformScope;
        readonly kbRow: typeof knowledgeBases.$inferSelect;
        readonly workspaceId: string;
      }
    | DocumentInvisible
    | DocumentOwnershipInconsistent
  > {
    const scope = assertRequester(requester);
    assertKbId(kbId);
    const decision = await authority.authorizeKnowledgeBase(scope, kbId);
    if (decision.outcome === "deny") {
      return invisible();
    }
    const [kbRow] = await kbDb
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
    if (kbRow === undefined) {
      // 跨库内容缺失 = 不可见语义（与授权 deny 同形，不泄露区别）。
      return invisible();
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
      // 请求者已过授权门（已被告知存在性）：确定性可行动拒绝码。
      return Object.freeze({
        ok: false as const,
        kind: "ownership-inconsistent" as const,
        code: comparison.code,
      });
    }
    return Object.freeze({
      ok: true as const,
      scope,
      kbRow,
      workspaceId: decision.registration.workspaceId,
    });
  }

  function assertOptionalTitle(title: string | undefined): string | undefined {
    if (title === undefined) return undefined;
    if (typeof title !== "string") throw new Error("KB_DOCUMENT_INPUT_INVALID");
    return title;
  }

  return {
    async uploadDocument(requester, input) {
      const target = await authorizeTarget(requester, input.kbId);
      if (!target.ok) return target;
      const { scope, kbRow, workspaceId } = target;
      const principalId = scope.principalId;
      const title = assertOptionalTitle(input.title);

      if (input.kind === "file") {
        if (
          typeof input.fileName !== "string" ||
          input.fileName.trim() === "" ||
          input.fileName.length > 512 ||
          !(input.content instanceof Uint8Array)
        ) {
          throw new Error("KB_DOCUMENT_INPUT_INVALID");
        }
        const ext = extensionOf(input.fileName);
        if (
          !ALLOWED_FILE_EXTENSIONS.includes(
            ext as (typeof ALLOWED_FILE_EXTENSIONS)[number],
          )
        ) {
          throw new Error("KB_DOCUMENT_INPUT_INVALID");
        }
        const fileHash = createHash("sha256")
          .update(input.content)
          .digest("hex");
        const [existing] = await kbDb
          .select({ id: knowledges.id })
          .from(knowledges)
          .where(
            and(
              eq(knowledges.tenantId, scope.tenantId),
              eq(knowledges.knowledgeBaseId, kbRow.id),
              eq(knowledges.fileHash, fileHash),
              isNull(knowledges.deletedAt),
            ),
          )
          .limit(1);
        if (existing) {
          return Object.freeze({
            ok: true as const,
            knowledgeId: existing.id,
            duplicate: true,
          });
        }
        const knowledgeId = randomUUID();
        const filePath = await storeFile(
          kbRow.id,
          knowledgeId,
          input.content,
          input.fileName,
        );
        await kbDb.insert(knowledges).values({
          id: knowledgeId,
          tenantId: scope.tenantId,
          knowledgeBaseId: kbRow.id,
          type: "file",
          title: title?.trim() || input.fileName,
          source: "file",
          parseStatus: "pending",
          embeddingModelId: kbRow.embeddingModelId,
          fileName: input.fileName,
          fileType: ext,
          fileSize: input.content.byteLength,
          fileHash,
          filePath,
          storageSize: input.content.byteLength,
          attempt: 0,
        });
        await enqueue(
          Object.freeze({
            requestId: randomUUID(),
            tenantId: scope.tenantId,
            knowledgeId,
            kbId: kbRow.id,
            filePath,
            fileName: input.fileName,
            fileType: ext,
            url: "",
            fileUrl: "",
            passages: "",
            attempt: 0,
            initiatingWorkspaceId: workspaceId,
            initiatingPrincipalId: principalId,
          }),
        );
        return Object.freeze({
          ok: true as const,
          knowledgeId,
          duplicate: false,
        });
      }

      // text / manual 入口。
      if (typeof input.content !== "string" || input.content.trim() === "") {
        throw new Error("KB_DOCUMENT_INPUT_INVALID");
      }
      const fileHash = createHash("sha256").update(input.content).digest("hex");
      const [existing] = await kbDb
        .select({ id: knowledges.id })
        .from(knowledges)
        .where(
          and(
            eq(knowledges.tenantId, scope.tenantId),
            eq(knowledges.knowledgeBaseId, kbRow.id),
            eq(knowledges.fileHash, fileHash),
            isNull(knowledges.deletedAt),
          ),
        )
        .limit(1);
      if (existing) {
        return Object.freeze({
          ok: true as const,
          knowledgeId: existing.id,
          duplicate: true,
        });
      }
      const knowledgeId = randomUUID();
      await kbDb.insert(knowledges).values({
        id: knowledgeId,
        tenantId: scope.tenantId,
        knowledgeBaseId: kbRow.id,
        type: "manual",
        title: title?.trim() || "Untitled",
        source: "manual",
        parseStatus: "pending",
        embeddingModelId: kbRow.embeddingModelId,
        fileType: "txt",
        fileSize: Buffer.byteLength(input.content),
        fileHash,
        attempt: 0,
      });
      await enqueue(
        Object.freeze({
          requestId: randomUUID(),
          tenantId: scope.tenantId,
          knowledgeId,
          kbId: kbRow.id,
          filePath: "",
          fileName: title?.trim() || "text",
          fileType: "txt",
          url: "",
          fileUrl: "",
          passages: input.content,
          attempt: 0,
          initiatingWorkspaceId: workspaceId,
          initiatingPrincipalId: principalId,
        }),
      );
      return Object.freeze({
        ok: true as const,
        knowledgeId,
        duplicate: false,
      });
    },

    async importDocument(requester, input) {
      const target = await authorizeTarget(requester, input.kbId);
      if (!target.ok) return target;
      const { scope, kbRow, workspaceId } = target;
      const title = assertOptionalTitle(input.title);
      if (
        typeof input.url !== "string" ||
        !/^https?:\/\//i.test(input.url) ||
        input.url.length > 2048
      ) {
        throw new Error("KB_DOCUMENT_INPUT_INVALID");
      }
      const knowledgeId = randomUUID();
      await kbDb.insert(knowledges).values({
        id: knowledgeId,
        tenantId: scope.tenantId,
        knowledgeBaseId: kbRow.id,
        type: "url",
        title: title?.trim() || input.url,
        source: input.url,
        parseStatus: "pending",
        embeddingModelId: kbRow.embeddingModelId,
        fileType: "html",
        attempt: 0,
      });
      await enqueue(
        Object.freeze({
          requestId: randomUUID(),
          tenantId: scope.tenantId,
          knowledgeId,
          kbId: kbRow.id,
          filePath: "",
          fileName: title?.trim() || input.url,
          fileType: "html",
          url: input.url,
          fileUrl: "",
          passages: "",
          attempt: 0,
          initiatingWorkspaceId: workspaceId,
          initiatingPrincipalId: scope.principalId,
        }),
      );
      return Object.freeze({
        ok: true as const,
        knowledgeId,
        duplicate: false,
      });
    },

    async deleteDocument(requester, input) {
      const target = await authorizeTarget(requester, input.kbId);
      if (!target.ok) return target;
      assertDocId(input.docId);
      const doc = await containedDocument(
        target.scope,
        input.kbId,
        input.docId,
      );
      if (!doc.ok) {
        return doc;
      }
      // 级联顺序与幂等（先 Qdrant 后 SQL）由冻结删除面承载；其租户/库
      // 复核与本入口包含性校验同向（纵深防御）。
      const outcome = await deleteKnowledge(
        { db: kbDb, indexWriter },
        {
          tenantId: target.scope.tenantId,
          kbId: input.kbId,
          knowledgeId: input.docId,
        },
      );
      if (!outcome.deleted) {
        // 竞态：包含性校验后文档已被并发删除 → 与不存在同一形状。
        return invisible();
      }
      return Object.freeze({ ok: true as const, deleted: true as const });
    },

    async reparseDocument(requester, input) {
      const target = await authorizeTarget(requester, input.kbId);
      if (!target.ok) return target;
      assertDocId(input.docId);
      const doc = await containedDocument(
        target.scope,
        input.kbId,
        input.docId,
      );
      if (!doc.ok) {
        return doc;
      }
      const docRow = doc.doc;
      const attempt = docRow.attempt + 1;
      await kbDb
        .update(knowledges)
        .set({
          attempt,
          parseStatus: "pending",
          errorMessage: "",
          updatedAt: new Date(),
        })
        .where(eq(knowledges.id, docRow.id));
      await enqueue(
        Object.freeze({
          requestId: randomUUID(),
          tenantId: docRow.tenantId,
          knowledgeId: docRow.id,
          kbId: docRow.knowledgeBaseId,
          filePath: docRow.filePath,
          fileName: docRow.fileName,
          fileType: docRow.fileType,
          url: docRow.type === "url" ? docRow.source : "",
          fileUrl: "",
          passages: "",
          attempt,
          initiatingWorkspaceId: target.workspaceId,
          initiatingPrincipalId: target.scope.principalId,
        }),
      );
      return Object.freeze({
        ok: true as const,
        knowledgeId: docRow.id,
        attempt,
      });
    },

    async readOriginalFile(requester, input) {
      const target = await authorizeTarget(requester, input.kbId);
      if (!target.ok) return target;
      assertDocId(input.docId);
      const doc = await containedDocument(
        target.scope,
        input.kbId,
        input.docId,
      );
      if (!doc.ok) {
        return doc;
      }
      const docRow = doc.doc;
      if (docRow.type !== "file" || docRow.filePath === "") {
        // 无原文件（url/manual）与不可见同形：本入口没有可指认的文件。
        return invisible();
      }
      return Object.freeze({
        ok: true as const,
        file: Object.freeze({
          path: docRow.filePath,
          fileName: docRow.fileName,
          fileType: docRow.fileType,
          fileSize: docRow.fileSize,
        }),
      });
    },
  };
}

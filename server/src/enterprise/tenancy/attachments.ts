// server/src/enterprise/tenancy/attachments.ts
// MT024（Issue #67）：附件暂存上传、绑定、下载签发与清理的归属。
//
// 票面语义：附件从暂存上传、绑定到会话、签发下载到过期清理，全链路
// 都能追溯到上传时的公司与团队上下文；无权用户拿不到下载链接，
// 撤销后已签发的访问也停止。
//
// 结构（纯新增，零 schema 对象，只读消费 MT011 既有出口）：
//
//   1. 暂存附件（AC4）= enterprise_resources kind='attachment'。上传时
//      的归属上下文就是行本体：(tenant_id, workspace_id) 列 + 上传者
//      经 grants action='read' 行持久化。后续绑定与下载只携带 ref：
//      归属一律从行读，客户端在任何入口都无法重述归属——跨团队/
//      跨公司的 ref 直接 canonical not-found（行不可见）。
//   2. 对象存储路径（AC1）：`${tenantId}/${workspaceId}/${attachmentId}/
//      blob`——按归属分段隔离；attachmentId 由服务端 crypto 随机生成
//      （不可猜测，与文件名无关），displayName 只承载展示名。
//   3. 签名 URL（AC1/AC2）：`${ref}.${expiry}.${hmac}`，HMAC 覆盖
//      ref+expiry（装配注入的签名密钥）。签发点与代理访问点（AC1）
//      是两道独立校验：签发点验附件可见性（RLS + workspace + 成员
//      active/epoch），代理点验 token（HMAC + 过期）之后**重验当前
//      请求者对附件行的可见性**——已签发链接在撤权/撤销/移除后按
//      设计拒绝代理（每次访问都是新的事实判定，无放行缓存）。
//   4. 生命周期列（诚实披露）：operator 对 enterprise_resources 只有
//      visibility 列的 UPDATE 授权（MT008），无 DELETE/status 列授权。
//      本域 kind='attachment' 行的 visibility 列复用为双态生命周期：
//      NULL = 暂存有效（可绑定/可签发/可代理）；'private' = 已撤销/
//      已清理（一切入口 canonical not-found，等效失效）。CHECK 域内
//      两个合法值恰好覆盖两态，不引入新列新表。
//   5. 清理（AC3）：cleanupStaleUploads 只在 scope 的 (tenant,
//      workspace) 范围内把过期暂存行置 'private'——RLS 租户臂 + 显式
//      workspace 过滤双防线，跨公司行对本任务不可见，绝不删除。
//
// 事务纪律与 MT019/MT020/MT023 完全一致：受信 Scope → read committed +
// lock/statement timeout → set_config('app.*', …, true) 事务本地 →
// advisory 锁（键序 tenant → principal → membership →
// workspace-membership → attachment）。读路径受限 data 角色，写路径
// 受限 operator 角色。
//
// 边界（诚实披露）：
//   - 绑定事实 = resources kind='attachment-bind' 行（id=
//     `<attachmentId>:<threadId>`，workspace 同附件）——绑定与会话的
//     关联是可追溯事实；会话内容写入归 MT022。
//   - 对象存储本体（真实 blob 读写）不在本票：storage_path 是授权域
//     的路径事实，存储适配属接线票。
//   - 签名密钥经装配注入（生产从部署配置派生）；本模块不落密钥。

import { randomUUID, timingSafeEqual } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { enterpriseConversations } from "../../db/schema/enterprise-conversations";
import {
  enterpriseMemberships,
  enterpriseResourceGrants,
  enterpriseResources,
  enterpriseWorkspaceMemberships,
} from "../../db/schema/enterprise-tenancy";
import type { PlatformScope } from "../contracts";
import {
  assertDataDatabase,
  assertOperatorDatabase,
  type DataDatabase,
  type OperatorDatabase,
} from "./connections";
import {
  notFoundVerdict,
  type ResourceNotFoundVerdict,
} from "./not-found-semantics";
import { workspaceMembershipLockKey } from "./scope-gate";
import { createSignedDownloadRule } from "./signed-download";
import { assertTrustedScope } from "./store";

// ---------------------------------------------------------------------------
// 词表与形状
// ---------------------------------------------------------------------------

export const ATTACHMENT_RESOURCE_KIND = "attachment";
export const ATTACHMENT_BIND_KIND = "attachment-bind";

export type AttachmentVerdict =
  | ({ readonly outcome: "allow" } & Record<string, unknown>)
  | ResourceNotFoundVerdict;

export interface StagedUpload {
  readonly attachmentId: string;
  readonly storagePath: string;
}

export interface IssuedUrl {
  readonly url: string;
  readonly attachmentId: string;
  readonly expiresAt: string;
}

function assertScopeContext(scope: PlatformScope): void {
  if (!scope.tenantId?.trim()) throw new Error("TENANT_REQUIRED");
  if (!scope.workspaceId?.trim()) throw new Error("WORKSPACE_REQUIRED");
}

function assertFilename(filename: string): string {
  if (
    typeof filename !== "string" ||
    filename.trim().length === 0 ||
    filename.length > 255 ||
    filename.includes("\0")
  ) {
    throw new Error("ATTACHMENT_FILENAME_INVALID");
  }
  return filename;
}

function assertTtl(ttlSeconds: number): number {
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 86400) {
    throw new Error("ATTACHMENT_TTL_INVALID");
  }
  return ttlSeconds;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const entry of Object.values(value as Record<string, unknown>)) {
      deepFreeze(entry);
    }
    Object.freeze(value);
  }
  return value;
}

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

export interface AttachmentService {
  /**
   * 暂存上传（AC4）：上传上下文持久化为附件行本体；返回不可猜测的
   * ref 与按归属分段的存储路径。
   */
  stageUpload(
    scope: PlatformScope,
    input: { readonly filename: string; readonly sizeBytes: number },
  ): Promise<Verdict2<StagedUpload>>;
  /**
   * 绑定到会话（AC4）：只携带 ref——附件归属从行读，且须与请求 scope
   * 同公司同团队、会话行同租户同团队。
   */
  bindToConversation(
    scope: PlatformScope,
    attachmentId: string,
    threadId: string,
  ): Promise<AttachmentVerdict>;
  /**
   * 签发下载 URL（AC1 签发点）：附件可见门 + HMAC token。
   */
  issueDownloadUrl(
    scope: PlatformScope,
    attachmentId: string,
    input: { readonly ttlSeconds: number },
  ): Promise<Verdict2<IssuedUrl>>;
  /**
   * 代理访问点（AC1/AC2）：token 验证 + 当前请求者权限重验。
   */
  resolveDownload(
    scope: PlatformScope,
    token: string,
  ): Promise<Verdict2<{ readonly storagePath: string }>>;
  /**
   * T06.06（#578）：敏感下载代理的逐 pull 准入面——同一可见性判定
   * （readAttachmentFacts），但不签 token、不取字节。撤权/撤销/移除在
   * 每一次调用当场失效；字节读取发生在事务之外（deps.source.open）。
   */
  authorizeContent(
    scope: PlatformScope,
    attachmentId: string,
  ): Promise<Verdict2<{ readonly storageKey: string }>>;
  /**
   * 撤销上传：visibility → 'private'（此后一切入口 not-found；已签发
   * token 在代理点因可见性重验被拒）。
   */
  revokeUpload(
    scope: PlatformScope,
    attachmentId: string,
  ): Promise<AttachmentVerdict>;
  /**
   * 清理（AC3）：scope 的 (tenant, workspace) 范围内的过期暂存行。
   */
  cleanupStaleUploads(
    scope: PlatformScope,
    input: { readonly olderThanSeconds: number },
  ): Promise<Verdict2<{ readonly cleaned: readonly string[] }>>;
}

/** 便于联合类型书写的别名。 */
type Verdict2<T> =
  | ({ readonly outcome: "allow" } & T)
  | ResourceNotFoundVerdict;

export function createAttachmentService(channels: {
  readonly data: DataDatabase;
  readonly operator: OperatorDatabase;
  readonly signingKey: string;
}): AttachmentService {
  assertDataDatabase(channels.data);
  assertOperatorDatabase(channels.operator);
  if (
    typeof channels.signingKey !== "string" ||
    channels.signingKey.length < 16
  ) {
    throw new Error("ATTACHMENT_SIGNING_KEY_REQUIRED");
  }
  const { data, operator, signingKey } = channels;

  type Tx =
    | Parameters<Parameters<DataDatabase["transaction"]>[0]>[0]
    | Parameters<Parameters<OperatorDatabase["transaction"]>[0]>[0];

  const beginContext = async (
    tx: Tx,
    scope: {
      readonly tenantId: string;
      readonly workspaceId?: string;
      readonly principalId?: string;
      readonly actorId?: string;
    },
  ): Promise<void> => {
    await tx.execute(sql`set transaction isolation level read committed`);
    await tx.execute(sql`set local lock_timeout = '2s'`);
    await tx.execute(sql`set local statement_timeout = '5s'`);
    await tx.execute(
      sql`select set_config('app.tenant_id', ${scope.tenantId}, true), set_config('app.workspace_id', ${scope.workspaceId ?? ""}, true), set_config('app.principal_id', ${scope.principalId ?? ""}, true), set_config('app.user_id', ${scope.actorId ?? ""}, true)`,
    );
  };

  const baseLockKeys = (scope: {
    readonly tenantId: string;
    readonly principalId?: string;
    readonly workspaceId?: string;
  }): readonly string[] => [
    JSON.stringify(["enterprise", "tenant", scope.tenantId]),
    ...(scope.principalId
      ? [
          JSON.stringify(["enterprise", "principal", scope.principalId]),
          JSON.stringify([
            "enterprise",
            "membership",
            scope.tenantId,
            scope.principalId,
          ]),
        ]
      : []),
    ...(scope.principalId && scope.workspaceId
      ? [
          workspaceMembershipLockKey(
            scope.tenantId,
            scope.workspaceId,
            scope.principalId,
          ),
        ]
      : []),
  ];

  const takeLocks = async (
    tx: Tx,
    keys: readonly { readonly key: string; exclusive: boolean }[],
  ): Promise<void> => {
    for (const { key, exclusive } of keys) {
      await tx.execute(
        exclusive
          ? sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`
          : sql`select pg_advisory_xact_lock_shared(hashtextextended(${key}, 0))`,
      );
    }
  };

  const attachmentLockKey = (tenantId: string, attachmentId: string): string =>
    JSON.stringify(["enterprise", "attachment", tenantId, attachmentId]);

  /**
   * 附件可见事实（AC1/AC2 的一道独立防线：RLS 之外 workspace + 成员
   * active/epoch 重验）。null = canonical not-found：跨公司/跨团队/
   * 已撤销/已清理/非 active/已撤权。
   */
  const readAttachmentFacts = async (
    tx: Tx,
    scope: PlatformScope,
    attachmentId: string,
  ): Promise<{
    readonly filename: string;
    readonly workspaceId: string;
    readonly uploaderGrant: boolean;
  } | null> => {
    const [row] = await tx
      .select({
        displayName: enterpriseResources.displayName,
        workspaceId: enterpriseResources.workspaceId,
        status: enterpriseResources.status,
        visibility: enterpriseResources.visibility,
        uploaderGrant: enterpriseResourceGrants.principalId,
        membershipStatus: enterpriseWorkspaceMemberships.status,
        companyMemberStatus: enterpriseMemberships.status,
        companyMemberEpoch: enterpriseMemberships.epoch,
      })
      .from(enterpriseResources)
      .leftJoin(
        enterpriseResourceGrants,
        and(
          eq(enterpriseResourceGrants.tenantId, enterpriseResources.tenantId),
          eq(enterpriseResourceGrants.resourceId, enterpriseResources.id),
          eq(enterpriseResourceGrants.action, "read"),
          eq(enterpriseResourceGrants.principalId, scope.principalId),
        ),
      )
      .leftJoin(
        enterpriseWorkspaceMemberships,
        and(
          eq(
            enterpriseWorkspaceMemberships.tenantId,
            enterpriseResources.tenantId,
          ),
          eq(
            enterpriseWorkspaceMemberships.workspaceId,
            enterpriseResources.workspaceId,
          ),
          eq(enterpriseWorkspaceMemberships.principalId, scope.principalId),
        ),
      )
      .leftJoin(
        enterpriseMemberships,
        and(
          eq(enterpriseMemberships.tenantId, enterpriseResources.tenantId),
          eq(enterpriseMemberships.principalId, scope.principalId),
        ),
      )
      .where(
        and(
          eq(enterpriseResources.tenantId, scope.tenantId),
          eq(enterpriseResources.id, attachmentId),
          eq(enterpriseResources.kind, ATTACHMENT_RESOURCE_KIND),
        ),
      )
      .limit(1);
    if (!row) return null;
    if (
      row.status !== "active" ||
      // 生命周期列：'private' = 已撤销/已清理（一切入口失效）。
      row.visibility !== null ||
      row.workspaceId !== scope.workspaceId ||
      row.membershipStatus !== "active" ||
      row.companyMemberStatus !== "active" ||
      row.companyMemberEpoch !== scope.memberEpoch
    ) {
      return null;
    }
    // 暂存附件 = 上传者个人事实（MT008：visibility NULL 的既有语义是
    // 走 grant 授权）——可见门收紧为 grant 持有者本人。
    if (row.uploaderGrant !== scope.principalId) return null;
    return {
      filename: row.displayName,
      workspaceId: row.workspaceId,
      uploaderGrant: true,
    };
  };

  const storagePathOf = (tenantId: string, workspaceId: string, id: string) =>
    `${tenantId}/${workspaceId}/${id}/blob`;

  // MT056（Issue #99）统一：附件下载 token 的 HMAC 计算与校验来自共享
  // 签名规则（signed-download.ts 的唯一事实源）——token 语法
  // `${ref}.${expiry}.${hmac}` 字节形状不变，附件套件原语义不动；产物族
  // 与原文件族的签发/代理走同一实现（票注：发现分叉先统一再继续）。
  const signedRule = createSignedDownloadRule(signingKey);
  const hmacOf = (attachmentId: string, expiry: number): string =>
    signedRule.hmacOf(attachmentId, expiry);

  return {
    async stageUpload(scope, input) {
      assertScopeContext(scope);
      assertTrustedScope(scope);
      if (!input || typeof input !== "object") {
        throw new Error("ATTACHMENT_INPUT_INVALID");
      }
      assertFilename(input.filename);
      if (
        !Number.isInteger(input.sizeBytes) ||
        input.sizeBytes < 0 ||
        input.sizeBytes > 1024 * 1024 * 1024
      ) {
        throw new Error("ATTACHMENT_SIZE_INVALID");
      }
      // ref 由服务端生成（AC1：不可猜测，与文件名无关）。
      const attachmentId = `att-${randomUUID()}`;
      return operator.transaction(async (tx) => {
        await beginContext(tx, scope);
        await takeLocks(tx, [
          ...baseLockKeys(scope).map((key) => ({ key, exclusive: false })),
          {
            key: attachmentLockKey(scope.tenantId, attachmentId),
            exclusive: true,
          },
        ]);
        await tx.insert(enterpriseResources).values({
          tenantId: scope.tenantId,
          id: attachmentId,
          workspaceId: scope.workspaceId,
          kind: ATTACHMENT_RESOURCE_KIND,
          displayName: input.filename,
        });
        // 上传者的成员资格 = grants read 行（归属事实的一部分）。
        await tx
          .insert(enterpriseResourceGrants)
          .values({
            tenantId: scope.tenantId,
            resourceId: attachmentId,
            principalId: scope.principalId,
            action: "read",
          })
          .onConflictDoNothing();
        return deepFreeze({
          outcome: "allow",
          attachmentId,
          storagePath: storagePathOf(
            scope.tenantId,
            scope.workspaceId,
            attachmentId,
          ),
        });
      });
    },

    async bindToConversation(scope, attachmentId, threadId) {
      assertScopeContext(scope);
      assertTrustedScope(scope);
      if (
        typeof threadId !== "string" ||
        !threadId.trim() ||
        threadId.length > 256
      ) {
        throw new Error("THREAD_ID_INVALID");
      }
      // 会话归属校验走 data 通道（conversations 的读授权面是
      // ob_ent_data；operator 对该表无 SELECT）。披露：会话读取与
      // 绑定写入分两个事务，中间的会话删除窗口由绑定行的
      // id=<attachmentId>:<threadId> 复合事实兜底（重放幂等）。
      const conversationVisible = await data.transaction(async (tx) => {
        await beginContext(tx, scope);
        await takeLocks(tx, [
          ...baseLockKeys(scope).map((key) => ({ key, exclusive: false })),
        ]);
        const [conversation] = await tx
          .select({ threadId: enterpriseConversations.threadId })
          .from(enterpriseConversations)
          .where(
            and(
              eq(enterpriseConversations.tenantId, scope.tenantId),
              eq(enterpriseConversations.workspaceId, scope.workspaceId),
              eq(enterpriseConversations.threadId, threadId),
            ),
          )
          .limit(1);
        return conversation !== undefined;
      });
      if (!conversationVisible) return notFoundVerdict();
      return operator.transaction(async (tx) => {
        await beginContext(tx, scope);
        await takeLocks(tx, [
          ...baseLockKeys(scope).map((key) => ({ key, exclusive: false })),
          {
            key: attachmentLockKey(scope.tenantId, attachmentId),
            exclusive: true,
          },
        ]);
        // 归属只来自附件行（AC4）：请求不携带任何归属键。
        const facts = await readAttachmentFacts(tx, scope, attachmentId);
        if (!facts) return notFoundVerdict();
        const bindId = `${attachmentId}:${threadId}`;
        await tx.execute(
          sql`select set_config('app.resource_id', ${bindId}, true)`,
        );
        await tx
          .insert(enterpriseResources)
          .values({
            tenantId: scope.tenantId,
            id: bindId,
            workspaceId: facts.workspaceId,
            kind: ATTACHMENT_BIND_KIND,
            displayName: attachmentId,
          })
          .onConflictDoNothing();
        return deepFreeze({ outcome: "allow", attachmentId, threadId });
      });
    },

    async issueDownloadUrl(scope, attachmentId, input) {
      assertScopeContext(scope);
      assertTrustedScope(scope);
      if (!input) throw new Error("ATTACHMENT_INPUT_INVALID");
      assertTtl(input.ttlSeconds);
      return data.transaction(async (tx) => {
        await beginContext(tx, scope);
        await takeLocks(tx, [
          ...baseLockKeys(scope).map((key) => ({ key, exclusive: false })),
          {
            key: attachmentLockKey(scope.tenantId, attachmentId),
            exclusive: false,
          },
        ]);
        const facts = await readAttachmentFacts(tx, scope, attachmentId);
        if (!facts) return notFoundVerdict();
        const expiry = Date.now() + input.ttlSeconds * 1000;
        const url = `${attachmentId}.${expiry}.${hmacOf(attachmentId, expiry)}`;
        return deepFreeze({
          outcome: "allow",
          url,
          attachmentId,
          expiresAt: new Date(expiry).toISOString(),
        });
      });
    },

    async resolveDownload(scope, token) {
      assertScopeContext(scope);
      assertTrustedScope(scope);
      const parts = String(token ?? "").split(".");
      if (parts.length !== 3) return notFoundVerdict();
      const [attachmentId, expiryText, mac] = parts;
      const expiry = Number(expiryText);
      if (
        !Number.isInteger(expiry) ||
        !/^[A-Za-z0-9_-]+$/.test(attachmentId) ||
        !/^[A-Za-z0-9_-]+$/.test(mac)
      ) {
        return notFoundVerdict();
      }
      const expected = Buffer.from(hmacOf(attachmentId, expiry));
      const received = Buffer.from(mac);
      if (
        expected.length !== received.length ||
        !timingSafeEqual(expected, received)
      ) {
        return notFoundVerdict();
      }
      if (Date.now() >= expiry) return notFoundVerdict();
      // 代理访问点（AC1）：token 合法之后重验当前请求者的可见性——
      // 撤权/撤销/移除后的已签发链接在此被拒（AC2 的设计失效语义）。
      return data.transaction(async (tx) => {
        await beginContext(tx, scope);
        await takeLocks(tx, [
          ...baseLockKeys(scope).map((key) => ({ key, exclusive: false })),
          {
            key: attachmentLockKey(scope.tenantId, attachmentId),
            exclusive: false,
          },
        ]);
        const facts = await readAttachmentFacts(tx, scope, attachmentId);
        if (!facts) return notFoundVerdict();
        return deepFreeze({
          outcome: "allow",
          storagePath: storagePathOf(
            scope.tenantId,
            facts.workspaceId,
            attachmentId,
          ),
        });
      });
    },

    async authorizeContent(scope, attachmentId) {
      assertScopeContext(scope);
      assertTrustedScope(scope);
      // 与 resolveDownload 的重验同一形状：只判定，不取字节——T06.06 的
      // 串行 pull 每批进来重验一次，撤权后的下一批在这里当场失效。
      return data.transaction(async (tx) => {
        await beginContext(tx, scope);
        await takeLocks(tx, [
          ...baseLockKeys(scope).map((key) => ({ key, exclusive: false })),
          {
            key: attachmentLockKey(scope.tenantId, attachmentId),
            exclusive: false,
          },
        ]);
        const facts = await readAttachmentFacts(tx, scope, attachmentId);
        if (!facts) return notFoundVerdict();
        return deepFreeze({
          outcome: "allow",
          storageKey: storagePathOf(
            scope.tenantId,
            facts.workspaceId,
            attachmentId,
          ),
        });
      });
    },

    async revokeUpload(scope, attachmentId) {
      assertScopeContext(scope);
      assertTrustedScope(scope);
      return operator.transaction(async (tx) => {
        await beginContext(tx, scope);
        await takeLocks(tx, [
          ...baseLockKeys(scope).map((key) => ({ key, exclusive: false })),
          {
            key: attachmentLockKey(scope.tenantId, attachmentId),
            exclusive: true,
          },
        ]);
        const facts = await readAttachmentFacts(tx, scope, attachmentId);
        if (!facts) return notFoundVerdict();
        if (!facts.uploaderGrant) return notFoundVerdict();
        await tx.execute(
          sql`select set_config('app.resource_id', ${attachmentId}, true)`,
        );
        const updated = await tx
          .update(enterpriseResources)
          .set({ visibility: "private" })
          .where(
            and(
              eq(enterpriseResources.tenantId, scope.tenantId),
              eq(enterpriseResources.id, attachmentId),
              eq(enterpriseResources.kind, ATTACHMENT_RESOURCE_KIND),
              sql`${enterpriseResources.visibility} is null`,
            ),
          )
          .returning({ id: enterpriseResources.id });
        if (updated.length === 0) return notFoundVerdict();
        return deepFreeze({ outcome: "allow", attachmentId });
      });
    },

    async cleanupStaleUploads(scope, input) {
      assertScopeContext(scope);
      assertTrustedScope(scope);
      if (
        !input ||
        !Number.isInteger(input.olderThanSeconds) ||
        input.olderThanSeconds < 0
      ) {
        throw new Error("ATTACHMENT_CLEANUP_INPUT_INVALID");
      }
      const cutoff = new Date(Date.now() - input.olderThanSeconds * 1000);
      return operator.transaction(async (tx) => {
        await beginContext(tx, scope);
        await takeLocks(tx, [
          ...baseLockKeys(scope).map((key) => ({ key, exclusive: false })),
        ]);
        // AC3：只触及自己归属范围（tenant + workspace 双过滤；跨公司
        // 行被 RLS 隐藏，跨团队行被 workspace 条件排除）。
        const stale = await tx
          .select({ id: enterpriseResources.id })
          .from(enterpriseResources)
          .where(
            and(
              eq(enterpriseResources.tenantId, scope.tenantId),
              eq(enterpriseResources.workspaceId, scope.workspaceId),
              eq(enterpriseResources.kind, ATTACHMENT_RESOURCE_KIND),
              sql`${enterpriseResources.visibility} is null`,
              sql`${enterpriseResources.status} = 'active'`,
              sql`${enterpriseResources.createdAt} < ${cutoff.toISOString()}`,
            ),
          );
        const cleaned: string[] = [];
        for (const row of stale) {
          await tx.execute(
            sql`select set_config('app.resource_id', ${row.id}, true)`,
          );
          const updated = await tx
            .update(enterpriseResources)
            .set({ visibility: "private" })
            .where(
              and(
                eq(enterpriseResources.tenantId, scope.tenantId),
                eq(enterpriseResources.id, row.id),
                sql`${enterpriseResources.visibility} is null`,
              ),
            )
            .returning({ id: enterpriseResources.id });
          if (updated.length > 0) cleaned.push(row.id);
        }
        return deepFreeze({ outcome: "allow", cleaned });
      });
    },
  };
}

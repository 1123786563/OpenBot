// server/src/enterprise/plugin-packages/entrypoints.ts
// PKG09（Issue #468，Spec §9）：入口支持矩阵的后台臂——从持久 Run 归属重建
// 可信 Scope 与包执行上下文。
//
// Spec §9 的规定：CLI/后台从服务器持久 Run 归属重建可信 Scope；客户端
// callback 必须携带绑定 Run/attempt 的既有认证，提交 installId 本身不授权。
// 本模块是那句话的服务端实现：
//
//   - 输入只有（ownerUserId, runId, botId）三个标识——没有一个来自反序列化
//     的客户端 scope。请求里的 tenant/workspace/principal 字段在此无入口：
//     它们全部从 enterprise_runs 行读出（Run 行的归属是写入事务的事实，
//     `enterprise_runs_event_owner_binding` 唯一索引钉死，永不被请求改写）。
//   - 成员资格不是「曾经验证过」而是「现在验证」：签发走真实
//     createScopeResolver（entrypoint="schedule"），resolver 自己重读公司/
//     团队成员资格与 epoch。审批等待期间切团队/撤成员，恢复时在这里被拒。
//   - 恢复的上下文只回答「这是哪个 Run、哪个 attempt、哪个 Bot」；执行与否
//     仍由 PKG05 的 dispatch 链在 CAS 处全量重验（args digest、连接
//     generation、grant、install 状态、Run lease——A07 的另一半）。
//
// 拒绝词表（三个，全部给固定拒绝句，不内插任何值）：
//   PACKAGE_RUN_REQUIRED     —— 没有该 owner 可达的受管 Run（不存在/他人
//                               Run/无企业身份同形折叠，不泄露存在性）。
//   PACKAGE_RUN_BOT_MISMATCH —— 审批票面命名的 Bot 不是该 Run 准入的 Bot
//                               （合同违约，拒绝而非纠正）。
//   PACKAGE_RUN_SCOPE_LOST   —— Run 归属的成员资格/团队此刻不再成立
//                               （等待期间被撤；旧提案就地失效）。

import { and, eq, sql } from "drizzle-orm";
import { enterpriseExpertVersions } from "../../db/schema/enterprise-expert-versions";
import { enterpriseRuns } from "../../db/schema/enterprise-runs";
import {
  enterpriseMemberships,
  enterprisePrincipals,
  enterpriseTenants,
} from "../../db/schema/enterprise-tenancy";
import type { PlatformScope } from "../contracts";
import type { DataDatabase, DirectoryDatabase } from "../tenancy/connections";
import { createScopeResolver } from "../tenancy/store";

/** The typed refusals `restoreRunContext` answers (fixed sentences at consumers). */
export type PackageEntrypointRefusalCode =
  | "PACKAGE_RUN_REQUIRED"
  | "PACKAGE_RUN_BOT_MISMATCH"
  | "PACKAGE_RUN_SCOPE_LOST";

/** The trusted package execution context rebuilt from one persistent run row. */
export interface RestoredPackageRun {
  readonly scope: PlatformScope;
  readonly runId: string;
  readonly attemptGeneration: number;
  readonly botId: string;
}

export type PackageRunRestoration =
  | { readonly outcome: "context"; readonly run: RestoredPackageRun }
  | {
      readonly outcome: "refused";
      readonly code: PackageEntrypointRefusalCode;
    };

export interface PackageEntrypointsService {
  /**
   * Spec §9 background-scope rebuild: the one door a background entry (an
   * approved action's resume) re-enters package execution through. Every fact
   * comes from the persistent run row and the directory's CURRENT answer —
   * nothing from the deserialized proposal.
   */
  restoreRunContext(input: {
    readonly ownerUserId: string;
    readonly runId: string;
    readonly botId: string;
  }): Promise<PackageRunRestoration>;
}

export function createPackageEntrypoints(input: {
  readonly directory: DirectoryDatabase;
  readonly data: DataDatabase;
}): PackageEntrypointsService {
  const { directory, data } = input;
  /*
   * The trusted-scope issuer. `PlatformScope` objects are only "trusted" if the
   * resolver's WeakSet signed them (assertTrustedScope), so the scope this
   * service hands out MUST come from a real `createScopeResolver` — building a
   * plain object here would be refused by every downstream gate, which is the
   * property we want, not a bug to work around. The per-call selection travels
   * on the Request (the same shape the governed-headless wiring uses for its
   * actor), never on the input object, so no caller field reaches the resolver
   * as a selector.
   */
  const selections = new WeakMap<
    Request,
    { actorId: string; tenantId: string; workspaceId: string }
  >();
  const scopes = createScopeResolver(directory, {
    authenticate: async (request) => {
      const selection = selections.get(request);
      return selection
        ? { actorId: selection.actorId, entrypoint: "schedule" }
        : null;
    },
    selectTenant: (request) => selections.get(request)?.tenantId ?? null,
    selectWorkspace: (request) => selections.get(request)?.workspaceId ?? null,
  });

  const refused = (
    code: PackageEntrypointRefusalCode,
  ): PackageRunRestoration => ({
    outcome: "refused",
    code,
  });

  return {
    async restoreRunContext(rawInput) {
      if (
        typeof rawInput?.ownerUserId !== "string" ||
        !rawInput.ownerUserId.trim() ||
        rawInput.ownerUserId.length > 256 ||
        typeof rawInput?.runId !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          rawInput.runId,
        ) ||
        typeof rawInput?.botId !== "string" ||
        !rawInput.botId.trim() ||
        rawInput.botId.length > 256
      ) {
        return refused("PACKAGE_RUN_REQUIRED");
      }

      /*
       * The owner's candidate principals, from the directory — every membership
       * row of this person, whatever its CURRENT status: an identity that was
       * suspended while the approval waited must still FIND its run, so the
       * refusal it receives is the membership's own ("scope lost"), not the
       * canonical no-managed-run shape that would tell them their run vanished.
       * Status is decided by the resolver at issue time, never by this lookup.
       */
      const candidates = await directory.transaction(async (tx) => {
        await tx.execute(sql`set transaction isolation level read committed`);
        await tx.execute(sql`set local lock_timeout = '2s'`);
        await tx.execute(sql`set local statement_timeout = '5s'`);
        await tx.execute(
          sql`select set_config('app.user_id', ${rawInput.ownerUserId}, true)`,
        );
        return tx
          .select({
            tenantId: enterpriseMemberships.tenantId,
            principalId: enterpriseMemberships.principalId,
          })
          .from(enterpriseMemberships)
          .innerJoin(
            enterprisePrincipals,
            eq(enterprisePrincipals.id, enterpriseMemberships.principalId),
          )
          .innerJoin(
            enterpriseTenants,
            eq(enterpriseTenants.id, enterpriseMemberships.tenantId),
          )
          .where(and(eq(enterprisePrincipals.userId, rawInput.ownerUserId)));
      });

      /*
       * The run row, one candidate tenant at a time (batched, the resolveForThread
       * discipline: a member of many companies must not hold one pooled data
       * connection per company). The row is read under the DATA role's own RLS
       * (tenant-armed), principal-matched, so another person's run id — or a run
       * id that does not exist — answers the same canonical refusal.
       */
      const matches: Array<{
        tenantId: string;
        workspaceId: string;
        principalId: string;
        expertVersionRef: string;
        attemptGeneration: number;
      }> = [];
      const CANDIDATE_BATCH = 4;
      for (let start = 0; start < candidates.length; start += CANDIDATE_BATCH) {
        await Promise.all(
          candidates
            .slice(start, start + CANDIDATE_BATCH)
            .map(async (candidate) => {
              const found = await data.transaction(async (tx) => {
                await tx.execute(
                  sql`set transaction isolation level read committed`,
                );
                await tx.execute(sql`set local lock_timeout = '2s'`);
                await tx.execute(sql`set local statement_timeout = '5s'`);
                await tx.execute(
                  sql`select set_config('app.tenant_id', ${candidate.tenantId}, true), set_config('app.principal_id', ${candidate.principalId}, true), set_config('app.user_id', ${rawInput.ownerUserId}, true)`,
                );
                const rows = await tx
                  .select({
                    workspaceId: enterpriseRuns.workspaceId,
                    principalId: enterpriseRuns.principalId,
                    expertVersionRef: enterpriseRuns.expertVersionRef,
                    attemptGeneration: enterpriseRuns.attemptGeneration,
                  })
                  .from(enterpriseRuns)
                  .where(
                    and(
                      eq(enterpriseRuns.tenantId, candidate.tenantId),
                      eq(enterpriseRuns.id, rawInput.runId),
                      eq(enterpriseRuns.principalId, candidate.principalId),
                    ),
                  )
                  .limit(2);
                return rows;
              });
              for (const row of found) {
                matches.push({
                  tenantId: candidate.tenantId,
                  workspaceId: row.workspaceId,
                  principalId: row.principalId,
                  expertVersionRef: row.expertVersionRef,
                  attemptGeneration: row.attemptGeneration,
                });
              }
            }),
        );
      }
      // Zero (no such run for this owner) and more than one (the same uuid
      // legitimately owned in two companies — not a state any real approval
      // reaches) both answer the canonical no-managed-run refusal; no existence
      // leak, no guess between matches.
      const [run, ...extraMatches] = matches;
      if (!run || extraMatches.length > 0) {
        return refused("PACKAGE_RUN_REQUIRED");
      }

      // The admitted Bot, from the run's own expert version — the same binding
      // the pinned reads enforce. The proposal's Bot must be that Bot, or the
      // action is not the action the run proposed.
      const [admitted] = await data.transaction(async (tx) => {
        await tx.execute(sql`set transaction isolation level read committed`);
        await tx.execute(sql`set local lock_timeout = '2s'`);
        await tx.execute(sql`set local statement_timeout = '5s'`);
        await tx.execute(
          sql`select set_config('app.tenant_id', ${run.tenantId}, true), set_config('app.principal_id', ${run.principalId}, true), set_config('app.user_id', ${rawInput.ownerUserId}, true)`,
        );
        return tx
          .select({ agentId: enterpriseExpertVersions.agentId })
          .from(enterpriseExpertVersions)
          .where(
            and(
              eq(enterpriseExpertVersions.tenantId, run.tenantId),
              eq(
                enterpriseExpertVersions.expertVersionRef,
                run.expertVersionRef,
              ),
            ),
          )
          .limit(1);
      });
      if (admitted?.agentId !== rawInput.botId) {
        return refused("PACKAGE_RUN_BOT_MISMATCH");
      }

      /*
       * The trusted scope, issued NOW against the run row's own tenant and
       * workspace: the resolver re-reads company/principal membership and the
       * team membership (epochs included) before it signs anything. A
       * membership that lapsed while the approval waited throws inside — that
       * is the refusal the old proposal deserves, not an error to swallow.
       */
      const request = new Request(
        "https://package-entrypoints.openbot.invalid/restore",
      );
      selections.set(request, {
        actorId: rawInput.ownerUserId,
        tenantId: run.tenantId,
        workspaceId: run.workspaceId,
      });
      let scope: PlatformScope;
      try {
        scope = await scopes.resolve(request);
      } catch (error) {
        if (
          error instanceof Error &&
          (error.message === "TENANT_FORBIDDEN" ||
            error.message === "WORKSPACE_FORBIDDEN" ||
            error.message === "AUTH_REQUIRED")
        ) {
          return refused("PACKAGE_RUN_SCOPE_LOST");
        }
        throw error;
      }

      return {
        outcome: "context",
        run: {
          scope,
          runId: rawInput.runId,
          attemptGeneration: run.attemptGeneration,
          botId: admitted.agentId,
        },
      };
    },
  };
}

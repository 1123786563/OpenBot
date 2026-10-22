// server/src/enterprise/tenancy/public-bot-profiles.ts
// MT052（Issue #95）：状态化公共 Bot 为不同使用者隔离浏览器与工作区。
//
// 票面语义（Issue #95 正文）：
//   AC1 两个使用者先后使用同一公共 Bot 时看不到彼此的登录态、Cookie、
//      文件与历史。
//   AC2 无状态复用路径有明确判定与测试；不满足则强制隔离分配。
//   AC3 回收后状态被清理，复用到其他范围前不残留数据。
//   AC4 使用者个人凭据不因公共 Bot 执行而暴露给创建者或其他使用者。
//
// 结构（纯新增服务面 + 零 schema；只读消费 MT008/MT009/MT016/MT018/MT046/
// #90 既有出口，不改任何既有文件语义）：
//
//   1. 无状态判定 = 服务端事实派生（AC2）：determineProfilePolicy 是纯函数，
//      输入只有两条事实——Bot 声明的活跃凭据依赖数
//      （enterprise_resource_dependencies kind='credential'，data 通道事务内
//      现读，RLS 租户臂下跨公司行结构性不可见）与 MT018 admission 解析出的
//      登录态凭据集（非空 = 本次运行需要登录态）。零凭据依赖且无登录态需求
//      → shared-recycled（共享绑定，换持有人前强制回收）；任一不满足 →
//      isolated-per-user（每使用者独立 profile 与工作目录）。使用者的登录
//      态载体是凭据依赖——依赖数为零是这个 Bot 在服务端事实上不携带登录
//      态的唯一可证明判据；不猜测、不推断。客户端在输入里声称
//      stateless / 无状态标记一律响亮拒绝
//      （PROFILE_POLICY_NOT_CLIENT_DECLARABLE，MT019/MT028/MT039 同源：服务
//      端持久状态优先于客户端选择）。
//   2. 目录命名扩展 #90 seam（AC1）：isolated 模式的状态目录固定为
//      <root>/tenants/<t>/workspaces/<w>/bots/<bot>/users/<principal>——
//      executionArtifactDir（MT047，shared/execution-scope.ts 同一定义）之后
//      追加 per-user 段；shared-recycled 模式为 …/bots/<bot>/shared-stateless
//      （一个 Bot 至多一份共享绑定，换持有人即回收重建）。
//      parsePublicBotProfilePath 复用同款 plain-id 校验（+ 持有人段），一个
//      scope 的使用者永远命名不出另一个使用者的目录；
//      scopeOwnsPublicBotProfilePath 钉「归属 = tenant + workspace +
//      principal 三段全等」。
//   3. 分配与回收（AC1/AC3）：注册表是进程内事实（与 MT046 的
//      allocation registry 同位同型——gateway 的 fleet/capacity 也是进程内
//      事实）。分配 = 范围门（受信 Scope → data 通道事务内两级成员重验
//      （公司 active + epoch === scope.memberEpoch；团队 active）→ 注册行
//      可见 + kind='bot' + visibility='workspace' + status='active'——
//      MT018 同款绑定事实切片）+ 判定 + 按 mode 落绑定（generation 单调
//      递增，回收后的下一次分配拿到更大的号——测试证据面）。isolated 模式
//      每个 (tenant, workspace, bot, principal) 一份 profile 与目录，
//      本人重入幂等复用；shared-recycled 模式一个 (tenant, workspace, bot)
//      一份共享绑定，换主体持有时在分配内先强制回收（停实例 + 清 profile +
//      删目录 + 注销旧持有——AC3「复用到其他范围前不残留数据」的唯一实现
//      面），持有主体不换则幂等复用。回收（recycleProfile）= 范围门 +
//      本 scope 绑定（跨范围回收请求在判定处拒绝——他人范围的状态一个
//      字节都不动）+ 停止实例 + 清 profile（登录态载体）+ 删除状态目录 +
//      注销绑定。回收后的下一次分配从空目录与已清 profile 起步：上一个
//      使用者的登录态与工作目录结构性不可复用。
//   4. 零暴露（AC4）：一切输出形状只含使用者本人的事实（principal、目录、
//      profile 标识、generation、mode）；创建者主体只作为注册行的存在性
//      守卫被读取（无活跃归属行 → canonical not-found），绝不进入任何输出
//      形状。listProfileState 只列本人目录的条目；MT018 的凭据选择
//      （使用者本人个人凭据）原样成立——本模块不触碰凭据面，结构性无可
//      暴露通道。
//
// 事务纪律与 MT018/MT046 完全一致：受信 Scope（assertTrustedScope）→
// read committed + lock/statement timeout → set_config('app.*', …, true)
// 事务本地 → advisory 共享锁（键序 tenant → principal → membership →
// workspace-membership → bot，MT016 同序键族）。事实读取全部经受限 data
// 角色与真实 RLS。模块零 console、零 process.env；拒绝一律 canonical
// RESOURCE_NOT_FOUND（不存在/跨公司/跨团队/未发布/已撤销/撤权对外不可区
// 分），输入形状错误响亮拒绝（错误只含代码与字段路径，绝不回显值）。
//
// 边界（诚实披露）：
//   - 本票不接 HTTP 路由、不改 gateway.ts / computer-allocation.ts 的既有
//     签名（服务面供下游接线票复用，与 MT009/MT016/MT018/MT046 同例）。
//   - 注册表是进程内的（每个服务实例一份）：与 gateway fleet/capacity 的
//     进程内事实同位；物理清理发生在回收时点，重启后没有可复用的登录态
//     残留。
//   - 物理读写是注入的 state 端口（测试给内存树，接线方给 fs）——本模块
//     不直接触磁盘，与 MT046/#90 同例。
//   - shared-recycled 的「无状态」判定只覆盖登录态载体（凭据依赖）与
//     admission 登录态需求两条服务端事实；执行器若在运行中自行落登录态，
//     属于接线票对判定事实的维护责任（本票把判定入口与输入形状钉死）。

import { and, eq, sql } from "drizzle-orm";
import { enterpriseBotOwnership } from "../../db/schema/enterprise-bot-ownership";
import {
  enterpriseMemberships,
  enterpriseResources,
  enterpriseWorkspaceMemberships,
} from "../../db/schema/enterprise-tenancy";
import type { PlatformScope } from "../contracts";
import { assertDataDatabase, type DataDatabase } from "./connections";
import { executionArtifactDir } from "./execution-artifacts";
import {
  notFoundVerdict,
  type ResourceNotFoundVerdict,
} from "./not-found-semantics";
import { workspaceMembershipLockKey } from "./scope-gate";
import { assertTrustedScope } from "./store";

// ---------------------------------------------------------------------------
// 无状态判定（AC2）：纯函数，服务端事实为唯一输入
// ---------------------------------------------------------------------------

/** 判定输入：两条服务端事实（依赖数现读；登录态需求来自 MT018 admission）。 */
export interface PublicBotProfileFacts {
  /** Bot 声明的活跃凭据依赖数（登录态的唯一可证明载体）。 */
  readonly credentialDependencyCount: number;
  /** MT018 admission 解析出的本人登录态凭据集是否非空。 */
  readonly requiresLoginState: boolean;
}

/** 判定结果：模式 + 依据（依据是机器码，可审计，不含任何主体标识）。 */
export interface PublicBotProfilePolicy {
  readonly mode: "isolated-per-user" | "shared-recycled";
  readonly basis:
    | "credential-dependency-present"
    | "login-state-required"
    | "no-stateful-dependencies";
}

/**
 * 无状态复用判定（AC2 唯一定义处）：零凭据依赖且无登录态需求 →
 * shared-recycled；否则 isolated-per-user。不满足判定的一律强制隔离
 * （fail-closed：宁可隔离，绝不带着未证明的无状态假设共享登录态）。
 */
export function determineProfilePolicy(
  facts: PublicBotProfileFacts,
): PublicBotProfilePolicy {
  if (facts.credentialDependencyCount > 0) {
    return {
      mode: "isolated-per-user",
      basis: "credential-dependency-present",
    };
  }
  if (facts.requiresLoginState) {
    return {
      mode: "isolated-per-user",
      basis: "login-state-required",
    };
  }
  return {
    mode: "shared-recycled",
    basis: "no-stateful-dependencies",
  };
}

// ---------------------------------------------------------------------------
// 命名与隔离：纯函数（AC1 的路径半边，#90 seam 的 per-user 扩展）
// ---------------------------------------------------------------------------

const PLAIN_ID = /^[a-z0-9][a-z0-9-]{0,127}$/;

/**
 * 一个使用者在一个公共 Bot 上的状态目录（isolated 模式）：
 * <root>/tenants/<t>/workspaces/<w>/bots/<bot>/users/<principal>。
 */
export function publicBotProfileDir(
  root: string,
  scope: { readonly tenantId: string; readonly workspaceId: string },
  botId: string,
  principalId: string,
): string {
  return [executionArtifactDir(root, scope, botId), "users", principalId].join(
    "/",
  );
}

/** shared-recycled 模式的共享状态目录（一个 Bot 至多一份）。 */
export function publicBotSharedStatelessDir(
  root: string,
  scope: { readonly tenantId: string; readonly workspaceId: string },
  botId: string,
): string {
  return [executionArtifactDir(root, scope, botId), "shared-stateless"].join(
    "/",
  );
}

/** 从一条 per-user 状态路径解析归属；形状不符或含非 plain id 段 = null。 */
export function parsePublicBotProfilePath(
  root: string,
  path: string,
): {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly botId: string;
  readonly principalId: string;
} | null {
  const base = root.replace(/\/+$/, "");
  if (!path.startsWith(`${base}/`)) return null;
  const segments = path.slice(base.length + 1).split("/");
  if (segments.length !== 8) return null;
  const [
    literal,
    tenantId,
    literal2,
    workspaceId,
    literal3,
    botId,
    literal4,
    principalId,
  ] = segments;
  if (
    literal !== "tenants" ||
    literal2 !== "workspaces" ||
    literal3 !== "bots" ||
    literal4 !== "users"
  ) {
    return null;
  }
  if (
    !PLAIN_ID.test(tenantId) ||
    !PLAIN_ID.test(workspaceId) ||
    !PLAIN_ID.test(botId) ||
    !PLAIN_ID.test(principalId)
  ) {
    return null;
  }
  return { tenantId, workspaceId, botId, principalId };
}

/** 路径属于本使用者：tenant、workspace、principal 三段全等。 */
export function scopeOwnsPublicBotProfilePath(
  scope: {
    readonly tenantId: string;
    readonly workspaceId: string;
    readonly principalId: string;
  },
  parsed: {
    readonly tenantId: string;
    readonly workspaceId: string;
    readonly principalId: string;
  } | null,
): boolean {
  return (
    parsed !== null &&
    parsed.tenantId === scope.tenantId &&
    parsed.workspaceId === scope.workspaceId &&
    parsed.principalId === scope.principalId
  );
}

// ---------------------------------------------------------------------------
// 端口与审计（注入面；与 MT046/#90 同例）
// ---------------------------------------------------------------------------

/** 公共 Bot 执行面的窄端口（gateway 投影；本模块不直连计算机）。 */
export interface PublicBotProfilePorts {
  /** 停止该 Bot 的实例（登录态留在 profile——清理由 resetProfile 承担）。 */
  stop(botId: string): Promise<{ readonly wasRunning: boolean }>;
  /** 清 profile（登录态与保存状态一并消失）。 */
  resetProfile(botId: string): Promise<{ readonly cleared: boolean }>;
  /** 工作目录操作（#90 命名隔离的物理半边）。 */
  state: {
    ensure(dir: string): Promise<void>;
    remove(dir: string): Promise<void>;
    list(dir: string): Promise<readonly string[]>;
  };
}

export interface PublicBotProfileAuditEvent {
  readonly action: "public-bot-profile.allocate" | "public-bot-profile.recycle";
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly botId: string;
  readonly principalId: string;
  readonly outcome: "allowed" | "denied" | "recycled-before-reuse";
  readonly mode: "isolated-per-user" | "shared-recycled";
  readonly reason?: "not-found" | "outside-scope";
}

export interface PublicBotProfileAuditSink {
  record(event: PublicBotProfileAuditEvent): Promise<void> | void;
}

// ---------------------------------------------------------------------------
// 注册表（进程内，与 MT046 allocation registry 同位同型）
// ---------------------------------------------------------------------------

interface ProfileBinding {
  readonly key: string;
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly botId: string;
  /** 当前持有人（isolated 模式下恒为分配请求者本人）。 */
  readonly principalId: string;
  readonly generation: number;
  readonly stateDir: string;
  active: boolean;
}

const botBindingKey = (
  tenantId: string,
  workspaceId: string,
  botId: string,
): string => `${tenantId}:${workspaceId}:${botId}`;

// ---------------------------------------------------------------------------
// 拒绝：哨兵码 + 事实（绝不回显归属或输入值）
// ---------------------------------------------------------------------------

export const PUBLIC_BOT_PROFILE_ID_INVALID = "PUBLIC_BOT_PROFILE_ID_INVALID";
export const PUBLIC_BOT_PROFILE_INPUT_INVALID =
  "PUBLIC_BOT_PROFILE_INPUT_INVALID";
export const PROFILE_POLICY_NOT_CLIENT_DECLARABLE =
  "PROFILE_POLICY_NOT_CLIENT_DECLARABLE";
const DENY_VERDICT: ResourceNotFoundVerdict = Object.freeze(notFoundVerdict());

const requireId = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${PUBLIC_BOT_PROFILE_ID_INVALID}: ${field}`);
  }
  return value;
};

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

/** 分配结果：只含使用者本人的事实（零创建者材料，零他人材料）。 */
export type PublicBotProfileAllocation =
  | {
      readonly outcome: "allocated";
      readonly mode: "isolated-per-user" | "shared-recycled";
      readonly profileKey: string;
      readonly stateDir: string;
      readonly generation: number;
      readonly ownerPrincipalId: string;
    }
  | ResourceNotFoundVerdict;

export type PublicBotProfileRecycle =
  | { readonly outcome: "recycled" | "not-held" }
  | ResourceNotFoundVerdict;

export interface PublicBotProfileService {
  /**
   * 分配（AC1/AC2）：范围门 → 事实现读 → 判定 → 落绑定。shared-recycled
   * 换持有人时先强制回收（AC3 前半）；deny = canonical not-found 且端口
   * 一个都不被调用。
   */
  allocateProfile(
    scope: PlatformScope,
    input: {
      readonly botId: string;
      readonly root: string;
      /**
       * MT018 admission 的凭据选择结果（authorization-required 时调用方
       * 不进本入口）。客户端不可声明 stateless —— 那不是客户端的事实。
       */
      readonly loginStateCredentials: readonly { readonly ref: string }[];
    },
  ): Promise<PublicBotProfileAllocation>;

  /** 回收（AC3）：范围门 + 本 scope 绑定；跨范围请求在判定处拒绝。 */
  recycleProfile(
    scope: PlatformScope,
    input: { readonly botId: string },
  ): Promise<PublicBotProfileRecycle>;

  /**
   * 列举本人状态目录（AC1/AC4 证据面）：只列本
   * (tenant, workspace, bot, principal) 的条目；他人与创建者的条目结构性
   * 不可达。
   */
  listProfileState(
    scope: PlatformScope,
    input: { readonly botId: string; readonly root: string },
  ): Promise<readonly string[]>;

  /**
   * 判定事实（供装配与测试）：data 通道事务内现读——凭据依赖数（RLS 租户
   * 臂）+ 注册行存在性守卫。跨公司行对本事务不可见（事实即为不存在）。
   * requiresLoginState 恒 false——它是 admission 输入，不是存储事实。
   */
  readProfileFacts(
    scope: PlatformScope,
    botId: string,
  ): Promise<
    | { readonly outcome: "allow"; readonly facts: PublicBotProfileFacts }
    | ResourceNotFoundVerdict
  >;
}

const READ_TX_SETUP = sql`set transaction isolation level read committed`;
const TIMEOUTS = [
  sql`set local lock_timeout = '2s'`,
  sql`set local statement_timeout = '5s'`,
] as const;

type DataTx = Parameters<Parameters<DataDatabase["transaction"]>[0]>[0];

export function createPublicBotProfileService(deps: {
  readonly data: DataDatabase;
  readonly ports: PublicBotProfilePorts;
  readonly audit: PublicBotProfileAuditSink;
}): PublicBotProfileService {
  assertDataDatabase(deps.data);
  const { data, ports, audit } = deps;

  /** 进程内注册表（本服务实例一份；与 MT046 注册表同位）。 */
  const registry = new Map<string, ProfileBinding>();
  const generations = new Map<string, number>();

  /** 事务开场（MT018/MT046 判定入口同一形状）。 */
  const beginContext = async (tx: DataTx, scope: PlatformScope) => {
    await tx.execute(READ_TX_SETUP);
    for (const timeout of TIMEOUTS) await tx.execute(timeout);
    await tx.execute(
      sql`select set_config('app.tenant_id', ${scope.tenantId}, true), set_config('app.workspace_id', ${scope.workspaceId}, true), set_config('app.principal_id', ${scope.principalId}, true), set_config('app.user_id', ${scope.actorId}, true)`,
    );
    for (const key of [
      JSON.stringify(["enterprise", "tenant", scope.tenantId]),
      JSON.stringify(["enterprise", "principal", scope.principalId]),
      JSON.stringify([
        "enterprise",
        "membership",
        scope.tenantId,
        scope.principalId,
      ]),
      workspaceMembershipLockKey(
        scope.tenantId,
        scope.workspaceId,
        scope.principalId,
      ),
    ]) {
      await tx.execute(
        sql`select pg_advisory_xact_lock_shared(hashtextextended(${key}, 0))`,
      );
    }
  };

  /**
   * 事务内成员事实重验 + 绑定事实切片（MT018 同款）：公司 active 且
   * epoch === scope.memberEpoch；团队 active；注册行可见 + kind='bot' +
   * visibility='workspace' + status='active' + workspace 同团队 + 存在
   * 活跃归属行（创建者存在性守卫——无归属行的已发布 Bot = 漂移 →
   * canonical not-found）。凭据依赖数经同一事务现读（RLS 租户臂）。
   */
  const authorizeAndReadFacts = async (
    scope: PlatformScope,
    botId: string,
  ): Promise<PublicBotProfileFacts | null> =>
    data.transaction(async (tx) => {
      await beginContext(tx, scope);
      await tx.execute(
        sql`select pg_advisory_xact_lock_shared(hashtextextended(${JSON.stringify(["enterprise", "bot", scope.tenantId, botId])}, 0))`,
      );
      const [company] = await tx
        .select({
          status: enterpriseMemberships.status,
          epoch: enterpriseMemberships.epoch,
        })
        .from(enterpriseMemberships)
        .where(
          and(
            eq(enterpriseMemberships.tenantId, scope.tenantId),
            eq(enterpriseMemberships.principalId, scope.principalId),
          ),
        )
        .limit(1);
      const [team] = await tx
        .select({ status: enterpriseWorkspaceMemberships.status })
        .from(enterpriseWorkspaceMemberships)
        .where(
          and(
            eq(enterpriseWorkspaceMemberships.tenantId, scope.tenantId),
            eq(enterpriseWorkspaceMemberships.workspaceId, scope.workspaceId),
            eq(enterpriseWorkspaceMemberships.principalId, scope.principalId),
          ),
        )
        .limit(1);
      if (
        company?.status !== "active" ||
        company?.epoch !== scope.memberEpoch ||
        team?.status !== "active"
      ) {
        return null;
      }
      const [resource] = await tx
        .select({
          kind: enterpriseResources.kind,
          visibility: enterpriseResources.visibility,
          status: enterpriseResources.status,
          workspaceId: enterpriseResources.workspaceId,
        })
        .from(enterpriseResources)
        .where(
          and(
            eq(enterpriseResources.tenantId, scope.tenantId),
            eq(enterpriseResources.id, botId),
          ),
        )
        .limit(1);
      if (
        resource?.kind !== "bot" ||
        resource.visibility !== "workspace" ||
        resource.status !== "active" ||
        resource.workspaceId !== scope.workspaceId
      ) {
        return null;
      }
      const [ownership] = await tx
        .select({ agentId: enterpriseBotOwnership.agentId })
        .from(enterpriseBotOwnership)
        .where(
          and(
            eq(enterpriseBotOwnership.tenantId, scope.tenantId),
            eq(enterpriseBotOwnership.workspaceId, scope.workspaceId),
            eq(enterpriseBotOwnership.agentId, botId),
          ),
        )
        .limit(1);
      if (!ownership) return null;
      const dependencyRows = (await tx.execute(
        sql`select count(*)::int as n from enterprise_resource_dependencies where tenant_id = ${scope.tenantId} and resource_id = ${botId} and dependency_kind = 'credential' and status = 'active'`,
      )) as unknown as { n: number | string }[];
      const credentialDependencyCount =
        Number(dependencyRows?.[0]?.n ?? 0) || 0;
      return { credentialDependencyCount, requiresLoginState: false };
    });

  /** 物理回收：停实例 + 清 profile + 删目录 + 注销（AC3 本体）。 */
  const physicallyRecycle = async (binding: ProfileBinding): Promise<void> => {
    await ports.stop(binding.botId);
    await ports.resetProfile(binding.botId);
    await ports.state.remove(binding.stateDir);
    binding.active = false;
    registry.delete(binding.key);
  };

  return {
    async readProfileFacts(scope, botId) {
      assertTrustedScope(scope);
      requireId(botId, "botId");
      const facts = await authorizeAndReadFacts(scope, botId);
      if (facts === null) return DENY_VERDICT;
      return { outcome: "allow" as const, facts };
    },

    async allocateProfile(scope, input) {
      assertTrustedScope(scope);
      const botId = requireId(input.botId, "botId");
      if (typeof input.root !== "string" || input.root.trim() === "") {
        throw new Error(`${PUBLIC_BOT_PROFILE_INPUT_INVALID}: root`);
      }
      if (!Array.isArray(input.loginStateCredentials)) {
        throw new Error(
          `${PUBLIC_BOT_PROFILE_INPUT_INVALID}: loginStateCredentials`,
        );
      }
      for (const [name] of Object.entries(input)) {
        if (name === "stateless" || name === "statelessClaimed") {
          throw new Error(PROFILE_POLICY_NOT_CLIENT_DECLARABLE);
        }
      }
      const facts = await authorizeAndReadFacts(scope, botId);
      if (facts === null) {
        await audit.record({
          action: "public-bot-profile.allocate",
          tenantId: scope.tenantId,
          workspaceId: scope.workspaceId,
          botId,
          principalId: scope.principalId,
          outcome: "denied",
          mode: "isolated-per-user",
          reason: "not-found",
        });
        return DENY_VERDICT;
      }
      const policy = determineProfilePolicy({
        credentialDependencyCount: facts.credentialDependencyCount,
        requiresLoginState: input.loginStateCredentials.length > 0,
      });
      const botKey = botBindingKey(scope.tenantId, scope.workspaceId, botId);
      const perUserDir = publicBotProfileDir(
        input.root,
        scope,
        botId,
        scope.principalId,
      );
      const sharedDir = publicBotSharedStatelessDir(input.root, scope, botId);
      if (policy.mode === "shared-recycled") {
        // 换持有人：先强制回收（AC3 前半——复用到其他使用者前不残留数据）。
        const held = registry.get(botKey);
        if (held?.active && held.principalId !== scope.principalId) {
          const previousHolder = held.principalId;
          await physicallyRecycle(held);
          await audit.record({
            action: "public-bot-profile.recycle",
            tenantId: scope.tenantId,
            workspaceId: scope.workspaceId,
            botId,
            principalId: previousHolder,
            outcome: "recycled-before-reuse",
            mode: policy.mode,
          });
        }
      }
      const mapKey =
        policy.mode === "isolated-per-user"
          ? `${botKey}:${scope.principalId}`
          : botKey;
      const stateDir =
        policy.mode === "isolated-per-user" ? perUserDir : sharedDir;
      let target = registry.get(mapKey);
      if (!target?.active) {
        const generation = (generations.get(mapKey) ?? 0) + 1;
        generations.set(mapKey, generation);
        target = {
          key: mapKey,
          tenantId: scope.tenantId,
          workspaceId: scope.workspaceId,
          botId,
          principalId: scope.principalId,
          generation,
          stateDir,
          active: true,
        };
        registry.set(mapKey, target);
      } else if (target.principalId !== scope.principalId) {
        // 漂移守卫：活跃绑定的持有人不是本人（shared 模式回收竞态的兜底）
        // ——响亮拒绝，绝不改写他人绑定。
        return DENY_VERDICT;
      }
      await ports.state.ensure(target.stateDir);
      await audit.record({
        action: "public-bot-profile.allocate",
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
        botId,
        principalId: scope.principalId,
        outcome: "allowed",
        mode: policy.mode,
      });
      return {
        outcome: "allocated" as const,
        mode: policy.mode,
        profileKey: target.key,
        stateDir: target.stateDir,
        generation: target.generation,
        ownerPrincipalId: target.principalId,
      };
    },

    async recycleProfile(scope, input) {
      assertTrustedScope(scope);
      const botId = requireId(input.botId, "botId");
      const facts = await authorizeAndReadFacts(scope, botId);
      if (facts === null) {
        await audit.record({
          action: "public-bot-profile.recycle",
          tenantId: scope.tenantId,
          workspaceId: scope.workspaceId,
          botId,
          principalId: scope.principalId,
          outcome: "denied",
          mode: "isolated-per-user",
          reason: "not-found",
        });
        return DENY_VERDICT;
      }
      // 只回收本人持有的绑定：per-user 键（本人）与共享键（持有人 = 本人）。
      const botKey = botBindingKey(scope.tenantId, scope.workspaceId, botId);
      let recycled = false;
      for (const mapKey of [`${botKey}:${scope.principalId}`, botKey]) {
        const binding = registry.get(mapKey);
        if (!binding?.active || binding.principalId !== scope.principalId) {
          continue;
        }
        await physicallyRecycle(binding);
        recycled = true;
      }
      await audit.record({
        action: "public-bot-profile.recycle",
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
        botId,
        principalId: scope.principalId,
        outcome: "allowed",
        mode: "isolated-per-user",
      });
      return {
        outcome: recycled ? ("recycled" as const) : ("not-held" as const),
      };
    },

    async listProfileState(scope, input) {
      assertTrustedScope(scope);
      const botId = requireId(input.botId, "botId");
      const facts = await authorizeAndReadFacts(scope, botId);
      if (facts === null) return [];
      return ports.state.list(
        publicBotProfileDir(input.root, scope, botId, scope.principalId),
      );
    },
  };
}

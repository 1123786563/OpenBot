// server/src/auth/public.ts
// MOD04（Issue #624，根 #620）：M01 IdentityDirectory 的业务门面（A02 原位出口）。
//
// 本文件只做一件事：把「当前身份事实」与「本人成员资格发现」两件现有读取收拢到
// 一个有归属的公开 Interface 后面。它是一层**薄委托**：
//
//   currentIdentity(input)      → people 现有读取（createPeopleStore().find，
//                                 Person 聚合事实）+ identity 现有读取
//                                 （createIdentityStore().identitiesFor，链接事实）；
//   discoverMemberships(input)  → 构造注入的目录事实读取缝（DirectoryFactsReader）
//                                 ——公司/团队成员**事实**。
//
// 硬边界（Issue #624 验收 1 + 模块目录 M01）：
//   - 只输出事实：返回形状是稳定 ID、成员状态等当前事实；不含任何授权语义
//     （无 Scope、无 grant、无 aclEpoch、无「可读全部内容」推论）。
//   - 选择器不赋权：本 Interface 的输入只有本人稳定 ID，没有公司/团队选择器；
//     active organization/team 的选择与准入归 M02 Access（enterprise/authz/
//     public.ts resolveContext），那里才结合服务端成员事实判定。
//   - M01 不静态 import M02：企业目录事实（enterprise tenancy 表）经构造注入
//     deps 提供；实现由装配层（未来接线票）或测试注入，本文件零数据库访问。
//   - 登录不要求公司资格：currentIdentity 对无任何公司成员资格的本人照常返回
//     身份事实（module-catalog §2）；业务动作另行准入。
//   - 零写入面：本文件不 import 任何写路径，门面对象只有上述两个只读方法
//     （identity-access-public.test.ts 结构断言钉死）。

import type { IdentityLink } from "../identity/types";
import type { Person } from "../people/store";

// ---------------------------------------------------------------------------
// 输入/结果形状（事实，不含授权语义）
// ---------------------------------------------------------------------------

/** 本人稳定用户 ID（服务器会话层已认证的 actorId；users.id）。 */
export interface CurrentIdentityInput {
  readonly actorId: string;
}

/** discoverMemberships 的输入：与 currentIdentity 同一稳定 ID，别无选择器。 */
export interface DiscoverMembershipsInput {
  readonly actorId: string;
}

/** 当前身份事实：people/identity 两处现有读取的原样聚合。 */
export interface CurrentIdentityFact {
  readonly actorId: string;
  /** people 现有读取（find）；未知/已移除本人为 undefined——这是事实，不是错误。 */
  readonly person: Person | undefined;
  /** identity 现有读取（identitiesFor）：本人各 provider 的链接事实。 */
  readonly identityLinks: readonly IdentityLink[];
}

/** 一条团队成员**事实**：ID 与状态，无授权推论。 */
export interface TeamMembershipFact {
  readonly workspaceId: string;
  readonly status: string;
}

/** 一条公司成员**事实**：ID 与状态 + 其下的团队事实列表。 */
export interface CompanyMembershipFact {
  readonly tenantId: string;
  readonly principalId: string;
  readonly memberStatus: string;
  readonly teams: readonly TeamMembershipFact[];
}

/** 本人成员资格发现结果：公司/团队成员事实全集（不按选择器过滤）。 */
export interface ActorMembershipFacts {
  readonly actorId: string;
  readonly companies: readonly CompanyMembershipFact[];
}

// ---------------------------------------------------------------------------
// 构造注入缝
// ---------------------------------------------------------------------------

/**
 * people 现有读取的最小消费面。createPeopleStore(...) 产物结构满足；测试可注入
 * 等价只读替身。只暴露 find——setRole/revoke/retireOwned/restore 等写能力不在
 * 本门面（验收 4：门面零写入面）。
 */
export interface PeopleFactsReader {
  find(userId: string): Promise<Person | undefined>;
}

/**
 * identity 现有读取的最小消费面。createIdentityStore(...) 产物结构满足；同样
 * 只读（linkedUser/identitiesFor 面中的 identitiesFor 半边）。
 */
export interface IdentityFactsReader {
  identitiesFor(userId: string): Promise<readonly IdentityLink[]>;
}

/**
 * 企业目录事实读取缝（interface-contracts C01 DirectoryFactsReader 的本票落
 * 形状）：按稳定用户 ID 返回其公司/团队成员**事实**。M01 不静态 import M02，
 * 该实现由装配层（企业 tenancy 目录读取）或测试注入；读取不得因缓存跳过撤权
 * 检查（每次调用读当前事实）。
 */
export interface DirectoryFactsReader {
  readMemberships(actorId: string): Promise<readonly CompanyMembershipFact[]>;
}

// ---------------------------------------------------------------------------
// 门面
// ---------------------------------------------------------------------------

/** M01 IdentityDirectory 公开门面（本票能力面：两个只读用例）。 */
export interface IdentityDirectory {
  /** 当前身份事实（稳定 ID/当前事实；登录不要求公司资格）。 */
  currentIdentity(input: CurrentIdentityInput): Promise<CurrentIdentityFact>;
  /** 本人资格发现：公司/团队成员事实，只输出事实、选择器不赋权。 */
  discoverMemberships(
    input: DiscoverMembershipsInput,
  ): Promise<ActorMembershipFacts>;
}

/**
 * 构造 M01 门面。零策略、零缓存、零写入：每个方法逐项委托 deps 中的现有读取，
 * 不新增任何判定。deps 全部构造注入——跨组（企业目录）事实不经过本模块静态
 * import（见文件头硬边界）。
 */
export function createIdentityDirectory(deps: {
  readonly people: PeopleFactsReader;
  readonly identity: IdentityFactsReader;
  readonly directory: DirectoryFactsReader;
}): IdentityDirectory {
  const { people, identity, directory } = deps;
  return {
    async currentIdentity(input) {
      const person = await people.find(input.actorId);
      const identityLinks = await identity.identitiesFor(input.actorId);
      return { actorId: input.actorId, person, identityLinks };
    },
    async discoverMemberships(input) {
      const companies = await directory.readMemberships(input.actorId);
      return { actorId: input.actorId, companies };
    },
  };
}

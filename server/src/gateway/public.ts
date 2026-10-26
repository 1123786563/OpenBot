// server/src/gateway/public.ts
// MOD08（Issue #628，根 #620）：M06 ModelAccess 的业务门面（出口段）。
//
// 六个能力，全部是**薄委托**——内件（model-capability-filter.ts、model-scope.ts、
// capability-availability.ts、key-expiry.ts、bot-services/access-grants.ts）零改动，
// 判定/价格分类/开放范围/授权使用/过期裁决的语义逐字节不动：
//
//   availableModels(input)        → 03.8 filter.listSelectableModels（唯一判定）
//                                 + 03.2/03.3 listLatestPriceSnapshots（显示注记）
//                                 + 11.6 summarizeCapabilityAvailability（同一批
//                                   最新快照上的能力基座摘要）。Brief「discoverModels」
//                                   即此能力：真正可用模型发现——可见目录≠可执行，
//                                   未知价格/未开放/能力不匹配的 ref 一律进 excluded
//                                   并带唯一原因码（验收①）。
//   authorizeModel(ref)           → 03.7 model-scope isModelOpen（管理员开放范围判定，
//                                   Brief「authorizeModel…委托 model-scope 现有判定」
//                                   逐字兑现；不存在即 closed，缺存储即抛出）。
//   authorizeBot(grantId, id)     → 04.6 access-grants resolveForBot（个人 Bot 模型授权
//                                   的**使用**判定：服务身份与用户授权必须同时持有；
//                                   未知/已撤销/跨 Bot/停用 Bot 一律同一个统一拒绝，
//                                   验收②③）。合同候选名 authorizeBot。
//   grantKeyStatus(userId)        → 04.7 access-grants listForUser（个人授权及其活跃
//                                   Key 版本状态；会话自身 userId，从不来自请求体）。
//   revokeGrant(grantId, userId)  → 04.7 access-grants revokeForUser（合同候选名
//                                   revokeGrant；本地状态翻转 + 05.7 远端退役经内件
//                                   既有依赖 best-effort，语义原样）。
//   keyUsableForNewRequest(row,now)→ 05.5 key-expiry 纯读裁决（过期→拒绝并给出时刻；
//                                   不删行、不释放、不改状态）。
//
// 边界（Issue #628 验收 5 + 模块目录 M06 + Interface 合同 ModelAccess 行）：
//   - **供应商与秘密零暴露**：门面不含 invoke/dispatch，也不含 key-issuance /
//     key-renewal 的签发/轮换入口——Key 明文只在已认证 Bot 服务通道
//     （bot-services/registry 组合的 keys 路由）出现一次；Bifrost Customer/Key 同步
//     实现（customer*.ts、key-state-sync.ts）与 store 一律不 re-export（验收⑤）。
//   - **服务认证不代替用户授权**：authorizeBot 只问 04.6 的授权使用面，门面不含
//     authenticate/mintBotServiceSecret/requireBotService——服务身份是路由门
//     （04.2）的答案，用户授权是 grant 的答案，两者在类型上就是两件事（验收②）。
//   - **个人路径与公司业务权限分开**：grantKeyStatus/revokeGrant 只接受会话自身的
//     userId；门面不 import billing/tenancy/enterprise，不存在 workspace/tenant/Payer
//     参数，也不替公司业务开任何口（验收④）。
//   - **零新策略、零缓存、零新授权路径**：门面不含任何判定逻辑；availableModels 只把
//     两条既有读取（filter 判定、快照注记）与一个纯函数摘要按现有路由的同一组合方式
//     收拢一次，其余逐项透传。
//   - 类型纪律（MOD05/06/07 先例）：形状经 M06 组内签名以 Parameters<>/ReturnType<>
//     提取；import 面全部 gateway/ 与 bot-services/（同属 M06），零新跨模块边——
//     检查器 654 零 delta 的前提。
//   - 依赖按能力分组且可缺省：只服务 availableModels 的装配（两条生产路由）只需
//     models 组；调用未装配组的能力是装配错误，抛 TypeError（与内件对畸形调用的
//     TypeError 纪律同形），不是新的业务拒绝。
//
// 存量事实登记（不改 wire）：03.11 路由在门面迁移前已计算
// summarizeCapabilityAvailability 却未写入响应（#301 的 Produces 承诺未兑现）。
// 本票行为保持——路由 wire 逐字节不变，门面把该摘要作为 availableModels 的答案
// 成员供出口段消费；路由内的响应字段待 #301 侧裁决，本票不扩。

import type { AccessGrantService } from "../bot-services/access-grants";
import type { BotServiceIdentity } from "../bot-services/types";
import {
  type CapabilityAvailability,
  summarizeCapabilityAvailability,
} from "./capability-availability";
import { type ModelRef, modelRefKey } from "./catalog";
import {
  type GatewayKeyExpiryVerdict,
  gatewayKeyUsableForNewRequest,
} from "./key-expiry";
import type {
  GatewayModelCapabilityFilterService,
  ModelExclusionReason,
  ModelSelectionPriceStatus,
} from "./model-capability-filter";
import type { GatewayModelScopeService } from "./model-scope";
import type { GatewayPriceSnapshotStore } from "./price-snapshot";

// ---------------------------------------------------------------------------
// 输入/结果形状（源头 = M06 组内签名，逐项提取）
// ---------------------------------------------------------------------------

/** availableModels 的入参：Bot 声明的能力集 + 请求归属（03.8 判定的入参原样）。 */
export type AvailableModelsInput = {
  botCapabilities: Parameters<
    GatewayModelCapabilityFilterService["listSelectableModels"]
  >[0];
  requester: Parameters<
    GatewayModelCapabilityFilterService["listSelectableModels"]
  >[1];
};

/** 一个可被提供的 ref 及其价格显示状态（03.10 的显示字段，未新 coined）。 */
export type AvailableModelView = {
  ref: ModelRef;
  priceStatus: ModelSelectionPriceStatus;
};

/** 一个当前不可提供的 ref 与唯一原因码（03.8 的拒绝词汇原样）。 */
export type ExcludedModelView = {
  ref: ModelRef;
  reasonCode: ModelExclusionReason;
};

/** availableModels 的答案：可提供集 + 排除集 + 三类能力的价格基座可用性摘要。 */
export type AvailableModelsAnswer = {
  selectable: AvailableModelView[];
  excluded: ExcludedModelView[];
  capabilityAvailability: CapabilityAvailability[];
};

/** 04.6 的授权使用记录（resolveForBot 的返回形状原样）。 */
export type ModelAccessGrant = Awaited<
  ReturnType<AccessGrantService["resolveForBot"]>
>;

/** 04.7 的一个授权及其活跃 Key 版本状态（listForUser 的条目形状原样）。 */
export type GrantKeyStatus = Awaited<
  ReturnType<AccessGrantService["listForUser"]>
>[number];

/** 04.7 的本人在撤销答案（revokeForUser 的返回形状原样）。 */
export type GrantRevocation = Awaited<
  ReturnType<AccessGrantService["revokeForUser"]>
>;

// ---------------------------------------------------------------------------
// 门面
// ---------------------------------------------------------------------------

/** M06 ModelAccess 公开门面（interface-contracts ModelAccess 行：可用模型/授权/撤销/
 *  Key 生命周期；invoke 属内部 dispatch，不在出口段）。 */
export interface ModelAccessPublic {
  /** 真正可用模型发现：03.8 判定 + 价格显示注记 + 能力基座摘要（验收①）。 */
  availableModels(input: AvailableModelsInput): Promise<AvailableModelsAnswer>;
  /** 管理员对该 ref 的开放授权判定（03.7，逐字节 isModelOpen）。 */
  authorizeModel(ref: ModelRef): Promise<boolean>;
  /** 个人 Bot 的授权使用判定（04.6 resolveForBot：服务身份+用户授权双持有）。 */
  authorizeBot(
    grantId: string,
    identity: BotServiceIdentity,
  ): Promise<ModelAccessGrant>;
  /** 本人的授权与 Key 版本状态读取（04.7 listForUser，会话自身 userId）。 */
  grantKeyStatus(userId: string): Promise<GrantKeyStatus[]>;
  /** 本人的授权撤销（04.7 revokeForUser：本地翻转 + 05.7 远端退役 best-effort）。 */
  revokeGrant(grantId: string, userId: string): Promise<GrantRevocation>;
  /** Key 过期裁决（05.5 纯读：usable，或拒绝原因与时刻）。 */
  keyUsableForNewRequest(
    row: Parameters<typeof gatewayKeyUsableForNewRequest>[0],
    now: Parameters<typeof gatewayKeyUsableForNewRequest>[1],
  ): GatewayKeyExpiryVerdict;
}

/**
 * 门面构造依赖：按能力分组的 Pick 最小面（装配层注入既有内件实例/controls）。
 * 分组可缺省——装配只为它实际服务的能力提供依赖；调用未装配组的能力是装配错误。
 */
export interface ModelAccessPublicDeps {
  /** availableModels 的两条既有读取 + 摘要（03.8 filter、03.2/03.3 快照）。 */
  readonly models?: {
    readonly selectable: Pick<
      GatewayModelCapabilityFilterService,
      "listSelectableModels"
    >;
    readonly priceSnapshots: Pick<
      GatewayPriceSnapshotStore,
      "listLatestPriceSnapshots"
    >;
  };
  /** authorizeModel 的 03.7 开放范围判定。 */
  readonly scopes?: Pick<GatewayModelScopeService, "isModelOpen">;
  /** 授权/Key 生命周期面的 04.6/04.7 既有读取与本地撤销。 */
  readonly grants?: Pick<
    AccessGrantService,
    "resolveForBot" | "listForUser" | "revokeForUser"
  >;
}

function requireModels(
  deps: ModelAccessPublicDeps,
): NonNullable<ModelAccessPublicDeps["models"]> {
  if (!deps.models) {
    throw new TypeError(
      "The ModelAccess facade was assembled without its models group; availableModels has no catalog, price or scope judgment to delegate to.",
    );
  }
  return deps.models;
}

function requireScopes(
  deps: ModelAccessPublicDeps,
): NonNullable<ModelAccessPublicDeps["scopes"]> {
  if (!deps.scopes) {
    throw new TypeError(
      "The ModelAccess facade was assembled without its scopes group; authorizeModel has no open-scope judgment to delegate to.",
    );
  }
  return deps.scopes;
}

function requireGrants(
  deps: ModelAccessPublicDeps,
): NonNullable<ModelAccessPublicDeps["grants"]> {
  if (!deps.grants) {
    throw new TypeError(
      "The ModelAccess facade was assembled without its grants group; the grant and key lifecycle surface has no 04.6/04.7 reads to delegate to.",
    );
  }
  return deps.grants;
}

/**
 * 构造 M06 门面。零新策略、零缓存、零写入判定：每个能力逐项委托 deps 的既有内件，
 * 判定/价格分类/开放范围/授权使用/过期裁决语义全部留在内件，逐字节不动。
 */
export function createModelAccessPublic(
  deps: ModelAccessPublicDeps,
): ModelAccessPublic {
  return {
    async availableModels(input) {
      const models = requireModels(deps);
      // 与 03.11/03.10 路由迁移前同一组合：一次判定 + 一次最新快照读取（并行），
      // 同批快照既做显示注记又做能力基座摘要——两个答案不可能各说各话。
      const [selection, snapshots] = await Promise.all([
        models.selectable.listSelectableModels(
          input.botCapabilities,
          input.requester,
        ),
        models.priceSnapshots.listLatestPriceSnapshots(),
      ]);
      const priceStatusByRef = new Map(
        snapshots.map((snapshot) => [
          modelRefKey(snapshot.ref),
          snapshot.classification.status,
        ]),
      );
      return {
        selectable: selection.selectable.map((ref) => ({
          ref,
          priceStatus: priceStatusByRef.get(modelRefKey(ref)) ?? "unmapped",
        })),
        excluded: selection.excluded.map((entry) => ({
          ref: entry.ref,
          reasonCode: entry.reasonCode,
        })),
        capabilityAvailability: summarizeCapabilityAvailability({
          snapshots: snapshots.map((snapshot) => ({
            ref: snapshot.ref,
            dims: snapshot.dims,
          })),
        }),
      };
    },
    authorizeModel(ref) {
      return requireScopes(deps).isModelOpen(ref);
    },
    authorizeBot(grantId, identity) {
      return requireGrants(deps).resolveForBot(grantId, identity);
    },
    grantKeyStatus(userId) {
      return requireGrants(deps).listForUser(userId);
    },
    revokeGrant(grantId, userId) {
      return requireGrants(deps).revokeForUser(grantId, userId);
    },
    keyUsableForNewRequest(row, now) {
      return gatewayKeyUsableForNewRequest(row, now);
    },
  };
}

// server/tests/multitenancy/model-access-public.test.ts
// MOD08（Issue #628，根 #620）：M06 ModelAccess 门面（public.ts）与 Bifrost Key 同步
// 具名臂（integration.ts）的委托等价、验收形状钉与负向边界。
//
// 事实源（Issue #628 验收 + MOD08 Brief §1.D，逐条对应 describe）：
//   D1 委托等价：六能力 vs 直调内件——同参、同对象、同错误实例透传（注入替身证明
//      委托本身）；缺失依赖组=装配错误 TypeError；两条生产路由经门面后与直组内件的
//      组合逐字段相等（迁移臂等价）；B 臂与同一调度器工厂同形（注入 service/timer
//      的绿色行为 + 无依赖缺席分支）。
//   D2 验收① 可见目录≠可执行：真 03.8 filter（假 catalog/scope store）+ 真价格
//      分类/真 11.6 摘要——未知价格/未开放/能力不匹配一律不可提供并带唯一原因码；
//      摘要现状钉（无 cell=unmapped、全 unknown=price_unknown+missingDimensions、
//      全 0=free；unknown 永不渲染成 free）。
//   D3 验收② 服务认证≠用户授权：authorizeBot 只问 04.6 resolveForBot、
//      authorizeModel 只问 03.7 isModelOpen（互不触碰）；门面源零
//      authenticate/mint/parse；统一拒绝实例原样透传；discovery 路由的 04.2 门
//      仍独立于授权判定（认证走了、授权判定没走）。
//   D4 验收③ Key 过期/撤销/续期维持原用户与授权来源：05.5 纯读裁决现状钉（边界
//      now==expiresAt 即过期、status=expired 不看时钟、expiresAt=null 永不按时钟
//      过期）；revoke/list 逐参委托且用户域=会话自身；源级钉 key-issuance/
//      key-renewal 消费 resolveForBot（04.6 的授权来源裁决）与
//      provisionCustomer({kind:"personal", id: grant.userId})（原用户/原 Payer）。
//   D5 验收④ 个人路径与公司业务权限分开：门面 import 说明符全部 M06 组内
//      （gateway/+bot-services/）；个人签名无 workspace/tenant/scope 参数（arity
//      钉）；module-imports M06 分组钉死；只带 models 组即可构造并服务
//      availableModels（Pick 最小面的编译级+运行级证明）。
//   D6 验收⑤ 不补做 Bifrost 未实现能力：门面方法集恰六名（无 invoke/签发/轮换/
//      同步实现）；import 说明符集合恰冻结清单（store/Bifrost Customer/Key 同步
//      实现零 re-export）；availableModels 答案字段恰三键（无新 coined 字段）。
//
// 运行层（ADR 0008）：import 自 e2e-compat——根 e2e 入口 Node target 原生收集
// （覆盖审计 native 桶），不依赖 Bun 运行时、不触真实数据库：真内件部分用假
// store 驱动真 filter/真价格分类/真 11.6 摘要（model-capability-filter.test.ts
// 同款先例）；其余为注入替身（门面只做委托，替身证明的正是委托本身）。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { MiddlewareHandler } from "hono";
import { describe, expect, test } from "../../../tests/support/e2e-compat";
import type { AppVariables } from "../../src/auth/guards";
import { speechTailAvailabilityView } from "../../src/billing/speech-tail-availability";
import {
  type AccessGrant,
  type AccessGrantService,
  AccessGrantUseError,
} from "../../src/bot-services/access-grants";
import type { BotServiceAuthenticator } from "../../src/bot-services/auth";
import type {
  BotServiceRecord,
  BotServiceStore,
} from "../../src/bot-services/store";
import type { BotServiceIdentity } from "../../src/bot-services/types";
import { summarizeCapabilityAvailability } from "../../src/gateway/capability-availability";
import {
  type CatalogStoredRef,
  type GatewayCatalogStore,
  type ModelRef,
  modelRefKey,
} from "../../src/gateway/catalog";
import { createGatewayKeyStateSyncArm } from "../../src/gateway/integration";
import {
  type GatewayKeyExpiryVerdict,
  gatewayKeyUsableForNewRequest,
} from "../../src/gateway/key-expiry";
import {
  type GatewayKeyStateSyncService,
  installGatewayKeyStateSyncService,
  type KeyStateSyncOutcome,
} from "../../src/gateway/key-state-sync";
import {
  classifyModelSelection,
  createGatewayModelCapabilityFilterService,
  type GatewayModelCapabilityFilterService,
  type ModelSelectionRequester,
  type ModelSelectionResult,
} from "../../src/gateway/model-capability-filter";
import { createModelDiscoveryRoutes } from "../../src/gateway/model-discovery-routes";
import type { EffectiveModelResolution } from "../../src/gateway/model-preference";
import type { GatewayModelScopeService } from "../../src/gateway/model-scope";
import { createModelSelectionRoutes } from "../../src/gateway/model-selection-routes";
import {
  type GatewayPriceSnapshotStore,
  mapPriceDims,
  type PriceSnapshot,
  type PriceSnapshotDims,
} from "../../src/gateway/price-snapshot";
import { classifyPriceDims } from "../../src/gateway/price-status";
import {
  createModelAccessPublic,
  type ModelAccessPublic,
} from "../../src/gateway/public";

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

const srcOf = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

/** 去注释后的源码：源级钉只看代码，注释里提及的名字不算暴露（MOD06 R1-F7 教训）。 */
function codeOf(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

async function errorOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error;
  }
}

/** 同步抛出（require* 守卫在返回 Promise 前抛）的断言通道。 */
function syncErrorOf(fn: () => unknown): unknown {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error;
  }
}

const CHAT_REF: ModelRef = {
  provider: "acme",
  model: "acme-chat",
  capability: "chat",
};
const CHAT_NOT_OPEN: ModelRef = {
  provider: "acme",
  model: "acme-closed",
  capability: "chat",
};
const EMB_UNKNOWN: ModelRef = {
  provider: "acme",
  model: "acme-embedding",
  capability: "embedding",
};
const OCR_FREE: ModelRef = {
  provider: "acme",
  model: "acme-ocr",
  capability: "ocr",
};

/** v1 wire 可定价维度全部有价——分类=known。 */
function pricedDims(): PriceSnapshotDims {
  return mapPriceDims({
    pricing: {
      prompt: "1",
      completion: "2",
      internal_reasoning: "0",
      image: "0",
      input_cache_read: "0",
      input_cache_write: "0",
      web_search: "0",
      request: "0",
    },
  });
}

/** v1 wire 可定价维度全部为 0——分类=free（free 是价格，不是豁免）。 */
function freeDims(): PriceSnapshotDims {
  return mapPriceDims({
    pricing: {
      prompt: "0",
      completion: "0",
      internal_reasoning: "0",
      image: "0",
      input_cache_read: "0",
      input_cache_write: "0",
      web_search: "0",
      request: "0",
    },
  });
}

/** 无 pricing 对象——全维度 unknown。 */
function unknownDims(): PriceSnapshotDims {
  return mapPriceDims({});
}

function snapshot(ref: ModelRef, dims: PriceSnapshotDims): PriceSnapshot {
  return {
    ref,
    snapshotVersion: 1,
    dims,
    classification: classifyPriceDims(dims),
    fetchedAt: "2026-10-24T00:00:00.000Z",
    source: "gateway:/v1/models",
    configVersion: 1,
    rateVersion: null,
  };
}

/** 03.8 filter 替身：记录入参、逐字返回既定结果。 */
function fakeFilter(result: ModelSelectionResult) {
  type ListSelectable =
    GatewayModelCapabilityFilterService["listSelectableModels"];
  const calls: {
    botCapabilities: Parameters<ListSelectable>[0];
    requester: ModelSelectionRequester;
  }[] = [];
  return {
    calls,
    service: {
      async listSelectableModels(
        botCapabilities: Parameters<ListSelectable>[0],
        requester: ModelSelectionRequester,
      ): Promise<ModelSelectionResult> {
        calls.push({ botCapabilities, requester });
        return result;
      },
    } satisfies Pick<
      GatewayModelCapabilityFilterService,
      "listSelectableModels"
    >,
  };
}

/** 03.2/03.3 快照替身。 */
function fakePrices(list: PriceSnapshot[]) {
  let reads = 0;
  return {
    get reads() {
      return reads;
    },
    store: {
      async listLatestPriceSnapshots() {
        reads += 1;
        return list;
      },
    } satisfies Pick<GatewayPriceSnapshotStore, "listLatestPriceSnapshots">,
  };
}

/** 03.7 scope 替身：只暴露 isModelOpen。 */
function fakeScopes(
  answer: boolean | ((ref: ModelRef) => boolean),
  calls: ModelRef[] = [],
) {
  return {
    calls,
    service: {
      async isModelOpen(ref: ModelRef) {
        calls.push(ref);
        return typeof answer === "function" ? answer(ref) : answer;
      },
    } satisfies Pick<GatewayModelScopeService, "isModelOpen">,
  };
}

/** 04.6/04.7 授权面替身：三个成员各自记录入参、逐字返回。 */
function fakeGrants(overrides?: {
  resolveForBot?: AccessGrantService["resolveForBot"];
}) {
  const grant: AccessGrant = {
    grantId: "grant-1",
    userId: "user-1",
    botId: "bot-1",
    externalIdentity: "openbot:user-1",
    scope: "model-access",
    source: "workbench-implicit",
    status: "active",
    createdAt: new Date(0),
    revokedAt: null,
  };
  const calls: { method: string; args: unknown[] }[] = [];
  const resolveAnswer = overrides?.resolveForBot ?? (async () => grant);
  return {
    grant,
    calls,
    service: {
      async resolveForBot(grantId: string, identity: BotServiceIdentity) {
        calls.push({ method: "resolveForBot", args: [grantId, identity] });
        return resolveAnswer(grantId, identity);
      },
      async listForUser(userId: string) {
        calls.push({ method: "listForUser", args: [userId] });
        return [{ ...grant, botDisplayName: "Bot One", activeKeys: [] }];
      },
      async revokeForUser(grantId: string, userId: string) {
        calls.push({ method: "revokeForUser", args: [grantId, userId] });
        return {
          grant: { ...grant, status: "revoked", revokedAt: new Date(1) },
          revoked: true,
        };
      },
    } satisfies Pick<
      AccessGrantService,
      "resolveForBot" | "listForUser" | "revokeForUser"
    >,
  };
}

function facade(deps: Parameters<typeof createModelAccessPublic>[0]) {
  return createModelAccessPublic(deps);
}

const ACTOR_MIDDLEWARE: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  context.set("actor", {
    id: "picker-person",
    email: "person@example.com",
    role: "user" as never,
  });
  await next();
};

const WORKBENCH: BotServiceRecord = {
  botId: "openbot-workbench",
  displayName: "OpenBot Workbench",
  kind: "builtin",
  capabilities: ["chat"],
  status: "active",
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

const BOT_ONE: BotServiceRecord = {
  botId: "bot-1",
  displayName: "Bot One",
  kind: "external",
  capabilities: ["chat"],
  status: "active",
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

const BOT_IDENTITY: BotServiceIdentity = { botId: "bot-1", status: "active" };

/** 04.2 门替身：任何出示的秘密都换出同一个 Bot 身份。 */
const AUTHENTICATE: BotServiceAuthenticator = async () => BOT_IDENTITY;

// ---------------------------------------------------------------------------
// D1 委托等价
// ---------------------------------------------------------------------------

describe("MOD08 D1: facade delegates to internals verbatim", () => {
  test("availableModels forwards capabilities and requester to the 03.8 filter, reads snapshots once", async () => {
    const filter = fakeFilter({ selectable: [CHAT_REF], excluded: [] });
    const prices = fakePrices([snapshot(CHAT_REF, pricedDims())]);
    const modelAccess = facade({
      models: { selectable: filter.service, priceSnapshots: prices.store },
    });
    const requester = { kind: "user", id: "user-1" } as const;
    const answer = await modelAccess.availableModels({
      botCapabilities: ["chat"],
      requester,
    });
    expect(filter.calls).toHaveLength(1);
    expect(filter.calls[0].botCapabilities).toEqual(["chat"]);
    expect(filter.calls[0].requester).toBe(requester);
    expect(prices.reads).toBe(1);
    expect(answer.selectable).toEqual([
      { ref: CHAT_REF, priceStatus: "known" },
    ]);
  });

  test("availableModels returns the very ref objects the filter answered with", async () => {
    const filter = fakeFilter({ selectable: [CHAT_REF], excluded: [] });
    const prices = fakePrices([]);
    const modelAccess = facade({
      models: { selectable: filter.service, priceSnapshots: prices.store },
    });
    const answer = await modelAccess.availableModels({
      botCapabilities: ["chat"],
      requester: { kind: "user", id: "user-1" },
    });
    expect(answer.selectable[0].ref).toBe(CHAT_REF);
  });

  test("availableModels renders a ref without any snapshot as unmapped, never free", async () => {
    const filter = fakeFilter({ selectable: [CHAT_REF], excluded: [] });
    const prices = fakePrices([]);
    const modelAccess = facade({
      models: { selectable: filter.service, priceSnapshots: prices.store },
    });
    const answer = await modelAccess.availableModels({
      botCapabilities: ["chat"],
      requester: { kind: "user", id: "user-1" },
    });
    expect(answer.selectable[0].priceStatus).toBe("unmapped");
  });

  test("availableModels propagates the internal error instance untouched", async () => {
    const marker = new Error("filter down");
    const failing = {
      async listSelectableModels() {
        throw marker;
      },
    } satisfies Pick<
      GatewayModelCapabilityFilterService,
      "listSelectableModels"
    >;
    const prices = fakePrices([]);
    const modelAccess = facade({
      models: { selectable: failing, priceSnapshots: prices.store },
    });
    const error = await errorOf(
      modelAccess.availableModels({
        botCapabilities: ["chat"],
        requester: { kind: "user", id: "user-1" },
      }),
    );
    expect(error).toBe(marker);
  });

  test("authorizeModel delegates isModelOpen verbatim and answers its very verdict", async () => {
    const scopes = fakeScopes(true);
    const modelAccess = facade({ scopes: scopes.service });
    const verdict = await modelAccess.authorizeModel(CHAT_REF);
    expect(scopes.calls).toEqual([CHAT_REF]);
    expect(verdict).toBe(true);
  });

  test("authorizeBot delegates resolveForBot with the very identity object and answers its very grant", async () => {
    const grants = fakeGrants();
    const modelAccess = facade({ grants: grants.service });
    const answer = await modelAccess.authorizeBot("grant-1", BOT_IDENTITY);
    expect(grants.calls).toHaveLength(1);
    expect(grants.calls[0].args[0]).toBe("grant-1");
    expect(grants.calls[0].args[1]).toBe(BOT_IDENTITY);
    expect(answer).toBe(grants.grant);
  });

  test("grantKeyStatus delegates listForUser with the session's own user id", async () => {
    const grants = fakeGrants();
    const modelAccess = facade({ grants: grants.service });
    const answer = await modelAccess.grantKeyStatus("user-1");
    expect(grants.calls).toEqual([{ method: "listForUser", args: ["user-1"] }]);
    expect(answer).toEqual([
      { ...grants.grant, botDisplayName: "Bot One", activeKeys: [] },
    ]);
  });

  test("revokeGrant delegates revokeForUser with the same (grantId, userId) and answers its very result", async () => {
    const grants = fakeGrants();
    const modelAccess = facade({ grants: grants.service });
    const answer = await modelAccess.revokeGrant("grant-1", "user-1");
    expect(grants.calls).toEqual([
      { method: "revokeForUser", args: ["grant-1", "user-1"] },
    ]);
    expect(answer.revoked).toBe(true);
    expect(answer.grant.status).toBe("revoked");
  });

  test("keyUsableForNewRequest answers exactly what the pure 05.5 function answers", () => {
    const grants = fakeGrants();
    const modelAccess = facade({ grants: grants.service });
    const row = {
      status: "active",
      expiresAt: new Date("2026-10-24T01:00:00.000Z"),
    };
    const now = new Date("2026-10-24T00:00:00.000Z");
    const answer: GatewayKeyExpiryVerdict = modelAccess.keyUsableForNewRequest(
      row,
      now,
    );
    expect(answer).toEqual(gatewayKeyUsableForNewRequest(row, now));
    expect(answer.usable).toBe(true);
  });

  test("calling a capability whose dependency group was never assembled is a TypeError, not a business refusal", async () => {
    const modelsOnly = facade({
      models: {
        selectable: fakeFilter({ selectable: [], excluded: [] }).service,
        priceSnapshots: fakePrices([]).store,
      },
    });
    const noModels = await errorOf(
      facade({ scopes: fakeScopes(true).service }).availableModels({
        botCapabilities: ["chat"],
        requester: { kind: "user", id: "user-1" },
      }),
    );
    const noScopes = syncErrorOf(() => modelsOnly.authorizeModel(CHAT_REF));
    const noGrants = syncErrorOf(() => modelsOnly.grantKeyStatus("user-1"));
    expect(noModels).toBeInstanceOf(TypeError);
    expect(noScopes).toBeInstanceOf(TypeError);
    expect(noGrants).toBeInstanceOf(TypeError);
  });

  test("route-level: the discovery answer through the facade equals the direct in-group composition, field for field", async () => {
    const selection: ModelSelectionResult = {
      selectable: [CHAT_REF],
      excluded: [
        { ref: CHAT_NOT_OPEN, reasonCode: "model_not_open" },
        { ref: EMB_UNKNOWN, reasonCode: "model_capability_mismatch" },
      ],
    };
    const filter = fakeFilter(selection);
    const prices = fakePrices([
      snapshot(CHAT_REF, pricedDims()),
      snapshot(CHAT_NOT_OPEN, pricedDims()),
      snapshot(EMB_UNKNOWN, unknownDims()),
    ]);
    const bots = {
      getBotService: async () => BOT_ONE,
    } satisfies Pick<BotServiceStore, "getBotService">;
    const app = createModelDiscoveryRoutes(
      { authenticate: AUTHENTICATE, botServices: bots },
      {
        selectable: () => filter.service,
        priceSnapshots: () => prices.store,
      },
    );
    const response = await app.request("/", {
      headers: { authorization: "Bearer anything" },
    });
    expect(response.status).toBe(200);
    const body = await response.json();

    // 直组内件：迁移前 handler 的同一组合，同一批替身。
    const [directSelection, directSnapshots] = await Promise.all([
      filter.service.listSelectableModels(["chat"], {
        kind: "bot_service",
        id: "bot-1",
      }),
      prices.store.listLatestPriceSnapshots(),
    ]);
    const priceStatusByRef = new Map(
      directSnapshots.map((entry) => [
        modelRefKey(entry.ref),
        entry.classification.status,
      ]),
    );
    const expected = {
      bot: { botId: "bot-1", displayName: "Bot One" },
      selectable: directSelection.selectable.map((ref) => ({
        ref,
        priceStatus: priceStatusByRef.get(modelRefKey(ref)) ?? "unmapped",
      })),
      excluded: directSelection.excluded
        .filter((entry) => entry.reasonCode !== "model_capability_mismatch")
        .map((entry) => ({ ref: entry.ref, reasonCode: entry.reasonCode })),
      speechPaths: speechTailAvailabilityView(),
    };
    expect(body).toEqual(expected);
  });

  test("route-level: the selection read through the facade equals the direct in-group composition, field for field", async () => {
    const selection: ModelSelectionResult = {
      selectable: [CHAT_REF],
      excluded: [{ ref: CHAT_NOT_OPEN, reasonCode: "model_not_open" }],
    };
    const filter = fakeFilter(selection);
    const prices = fakePrices([
      snapshot(CHAT_REF, pricedDims()),
      snapshot(CHAT_NOT_OPEN, pricedDims()),
    ]);
    const preferences = {
      setGlobalDefault: async () => {
        throw new Error("unused");
      },
      setBotDefault: async () => {
        throw new Error("unused");
      },
      setConversationSelection: async () => {
        throw new Error("unused");
      },
      resolveEffectiveModel: async (): Promise<EffectiveModelResolution> => ({
        status: "unset",
      }),
    };
    const app = createModelSelectionRoutes(
      ACTOR_MIDDLEWARE,
      {
        getBotService: async () => WORKBENCH,
      } satisfies Pick<BotServiceStore, "getBotService">,
      {
        preferences: () => preferences,
        selectable: () => filter.service,
        priceSnapshots: () => prices.store,
      },
    );
    const response = await app.request("/");
    expect(response.status).toBe(200);
    const body = await response.json();

    const [directSelection, directSnapshots] = await Promise.all([
      filter.service.listSelectableModels(["chat"], {
        kind: "user",
        id: "picker-person",
      }),
      prices.store.listLatestPriceSnapshots(),
    ]);
    const priceStatusByRef = new Map(
      directSnapshots.map((entry) => [
        modelRefKey(entry.ref),
        entry.classification.status,
      ]),
    );
    const expected = {
      bot: { botId: "openbot-workbench", displayName: "OpenBot Workbench" },
      selectable: directSelection.selectable.map((ref) => ({
        ref,
        priceStatus: priceStatusByRef.get(modelRefKey(ref)) ?? "unmapped",
      })),
      effective: { status: "unset" },
    };
    expect(body).toEqual(expected);
  });

  test("route-level: a resolved preference on a now-unopen ref keeps its closed-vocabulary reason through the facade", async () => {
    const selection: ModelSelectionResult = {
      selectable: [],
      excluded: [{ ref: CHAT_NOT_OPEN, reasonCode: "model_not_open" }],
    };
    const filter = fakeFilter(selection);
    const prices = fakePrices([snapshot(CHAT_NOT_OPEN, pricedDims())]);
    const preferences = {
      setGlobalDefault: async () => {
        throw new Error("unused");
      },
      setBotDefault: async () => {
        throw new Error("unused");
      },
      setConversationSelection: async () => {
        throw new Error("unused");
      },
      resolveEffectiveModel: async (): Promise<EffectiveModelResolution> => ({
        status: "resolved",
        ref: CHAT_NOT_OPEN,
        source: "global",
      }),
    };
    const app = createModelSelectionRoutes(
      ACTOR_MIDDLEWARE,
      {
        getBotService: async () => WORKBENCH,
      } satisfies Pick<BotServiceStore, "getBotService">,
      {
        preferences: () => preferences,
        selectable: () => filter.service,
        priceSnapshots: () => prices.store,
      },
    );
    const body = await (await app.request("/")).json();
    expect(body.effective).toEqual({
      status: "resolved",
      ref: CHAT_NOT_OPEN,
      source: "global",
      available: false,
      unavailableReasonCode: "model_not_open",
    });
  });
});

describe("MOD08 D1-B: the key state sync arm is the one named entry to the same scheduler factory", () => {
  test("with an injected service and timer it forwards to the same factory and runs its ticks", () => {
    const outcomes: KeyStateSyncOutcome[] = [];
    const scheduled: { delayMs: number; run: () => void }[] = [];
    let cancels = 0;
    const service: GatewayKeyStateSyncService = {
      async runSync() {
        const outcome: KeyStateSyncOutcome = {
          status: "ok",
          checked: 3,
          drifted: [],
          driftEvents: [],
          syncedAt: "2026-10-24T00:00:00.000Z",
        };
        outcomes.push(outcome);
        return outcome;
      },
      async readSyncStatus() {
        return {
          inFlight: false,
          state: {
            lastSuccessfulSyncAt: null,
            consecutiveFailures: 0,
            lastFailureReasonCode: null,
            lastFailureAt: null,
            lastAttemptAt: null,
            lastAttemptStatus: null,
          },
        };
      },
    };
    const arm = createGatewayKeyStateSyncArm({
      service,
      intervalMs: 60_000,
      timer: {
        schedule(run, delayMs) {
          scheduled.push({ run, delayMs });
          return {};
        },
        cancel() {
          cancels += 1;
        },
      },
    });
    expect(arm).toBeDefined();
    // startGatewayKeyStateSyncScheduler 启动即排第一拍：同一工厂语义。
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].delayMs).toBe(60_000);
    scheduled[0].run();
    expect(outcomes).toHaveLength(1);
    expect(scheduled).toHaveLength(2);
    arm?.stop();
    expect(cancels).toBe(1);
    // 归还全局 single-flight 单元（安装副作用只属于本用例）。
    installGatewayKeyStateSyncService(undefined);
  });

  test("with nothing to sync it answers the factory's own absent branch (undefined)", () => {
    const arm = createGatewayKeyStateSyncArm({});
    expect(arm).toBeUndefined();
    installGatewayKeyStateSyncService(undefined);
  });
});

// ---------------------------------------------------------------------------
// D2 验收① 可见目录 ≠ 可执行
// ---------------------------------------------------------------------------

describe("MOD08 D2 (AC1): the visible catalog is not the executable set", () => {
  /** 真 03.8 filter，假 universe/scope store；价格分类是真实分类函数。 */
  function realFilter() {
    const refs: CatalogStoredRef[] = [
      {
        ref: CHAT_REF,
        capabilitySource: "supported_methods",
        rawEntry: {},
        configVersion: 1,
        fetchedAt: "2026-10-24T00:00:00.000Z",
      },
      {
        ref: CHAT_NOT_OPEN,
        capabilitySource: "supported_methods",
        rawEntry: {},
        configVersion: 1,
        fetchedAt: "2026-10-24T00:00:00.000Z",
      },
      {
        ref: EMB_UNKNOWN,
        capabilitySource: "supported_methods",
        rawEntry: {},
        configVersion: 1,
        fetchedAt: "2026-10-24T00:00:00.000Z",
      },
      {
        ref: OCR_FREE,
        capabilitySource: "supported_methods",
        rawEntry: {},
        configVersion: 1,
        fetchedAt: "2026-10-24T00:00:00.000Z",
      },
    ];
    const catalog = {
      replaceCatalog: async () => {
        throw new Error("unused");
      },
      recordFetchFailure: async () => {
        throw new Error("unused");
      },
      readCatalogRefs: async () => refs,
      readLatestFetchOutcome: async () => undefined,
    } satisfies GatewayCatalogStore;
    const prices = {
      appendSnapshots: async () => {
        throw new Error("unused");
      },
      latestPriceSnapshot: async () => undefined,
      priceSnapshot: async () => undefined,
      listLatestPriceSnapshots: async () => [
        snapshot(CHAT_REF, pricedDims()),
        snapshot(CHAT_NOT_OPEN, pricedDims()),
        snapshot(EMB_UNKNOWN, unknownDims()),
        snapshot(OCR_FREE, freeDims()),
      ],
    } satisfies GatewayPriceSnapshotStore;
    const scopes = {
      async isModelOpen(ref: ModelRef) {
        return ref.model !== CHAT_NOT_OPEN.model;
      },
    } satisfies Pick<GatewayModelScopeService, "isModelOpen">;
    return createGatewayModelCapabilityFilterService({
      catalog,
      priceSnapshots: prices,
      scopes,
    });
  }

  test("an unknown-priced ref stays out of availableModels even though the catalog lists it", async () => {
    const modelAccess = facade({
      models: {
        selectable: realFilter(),
        priceSnapshots: {
          async listLatestPriceSnapshots() {
            return [
              snapshot(CHAT_REF, pricedDims()),
              snapshot(CHAT_NOT_OPEN, pricedDims()),
              snapshot(EMB_UNKNOWN, unknownDims()),
              snapshot(OCR_FREE, freeDims()),
            ];
          },
        } satisfies Pick<GatewayPriceSnapshotStore, "listLatestPriceSnapshots">,
      },
    });
    const answer = await modelAccess.availableModels({
      botCapabilities: ["chat", "embedding", "ocr"],
      requester: { kind: "user", id: "user-1" },
    });
    const selectableModels = answer.selectable.map((entry) => entry.ref.model);
    expect(selectableModels).toEqual(["acme-chat", "acme-ocr"]); // free 也是可提供
    const reasons = new Map(
      answer.excluded.map((entry) => [entry.ref.model, entry.reasonCode]),
    );
    expect(reasons.get("acme-closed")).toBe("model_not_open");
    expect(reasons.get("acme-embedding")).toBe("model_price_unknown");
    expect(reasons.get("acme-ocr")).toBeUndefined();
  });

  test("the 11.6 availability summary pins today's basis verdicts: unmapped / price_unknown / free", async () => {
    const modelAccess = facade({
      models: {
        selectable: realFilter(),
        priceSnapshots: {
          async listLatestPriceSnapshots() {
            return [
              snapshot(EMB_UNKNOWN, unknownDims()),
              snapshot(OCR_FREE, freeDims()),
            ];
          },
        } satisfies Pick<GatewayPriceSnapshotStore, "listLatestPriceSnapshots">,
      },
    });
    const answer = await modelAccess.availableModels({
      botCapabilities: ["chat", "embedding", "ocr"],
      requester: { kind: "user", id: "user-1" },
    });
    const byCapability = new Map(
      answer.capabilityAvailability.map((entry) => [entry.capability, entry]),
    );
    expect(byCapability.get("embedding")?.state).toBe("price_unknown");
    expect(byCapability.get("embedding")?.reasonCode).toBe(
      "capability_price_unknown",
    );
    expect(
      (byCapability.get("embedding")?.missingDimensions ?? []).length,
    ).toBeGreaterThan(0);
    expect(byCapability.get("ocr")?.state).toBe("free");
    expect(byCapability.get("ocr")?.cells).toEqual([
      { ref: OCR_FREE, free: true },
    ]);
    // rerank 无任何 cell：unmapped 是「从未有过基座」，与 price_unknown 是两个词。
    expect(byCapability.get("rerank")?.state).toBe("unmapped");
    expect(byCapability.get("rerank")?.reasonCode).toBe("capability_unmapped");
  });

  test("the summary is the same pure answer the direct summarize gives on the same snapshots", async () => {
    const list = [
      snapshot(EMB_UNKNOWN, unknownDims()),
      snapshot(OCR_FREE, freeDims()),
    ];
    const modelAccess = facade({
      models: {
        selectable: realFilter(),
        priceSnapshots: {
          async listLatestPriceSnapshots() {
            return list;
          },
        } satisfies Pick<GatewayPriceSnapshotStore, "listLatestPriceSnapshots">,
      },
    });
    const answer = await modelAccess.availableModels({
      botCapabilities: ["chat", "embedding", "ocr"],
      requester: { kind: "user", id: "user-1" },
    });
    expect(answer.capabilityAvailability).toEqual(
      summarizeCapabilityAvailability({
        snapshots: list.map((entry) => ({ ref: entry.ref, dims: entry.dims })),
      }),
    );
  });

  test("the pure decision keeps an unknown price unselectable at every precedence slot", () => {
    expect(
      classifyModelSelection({
        capabilityMatch: true,
        open: true,
        fresh: true,
        priceStatus: "unknown",
      }),
    ).toEqual({ selectable: false, reasonCode: "model_price_unknown" });
    expect(
      classifyModelSelection({
        capabilityMatch: true,
        open: true,
        fresh: true,
        priceStatus: "unmapped",
      }),
    ).toEqual({ selectable: false, reasonCode: "model_price_unknown" });
    expect(
      classifyModelSelection({
        capabilityMatch: true,
        open: false,
        fresh: true,
        priceStatus: "free",
      }),
    ).toEqual({ selectable: false, reasonCode: "model_not_open" });
  });

  test("the real filter refuses a malformed capability set before touching a store", async () => {
    const error = await errorOf(
      realFilter().listSelectableModels([], {
        kind: "user",
        id: "user-1",
      }),
    );
    expect(error).toBeInstanceOf(TypeError);
  });
});

// ---------------------------------------------------------------------------
// D3 验收② 服务认证 ≠ 用户授权
// ---------------------------------------------------------------------------

describe("MOD08 D3 (AC2): service authentication is not user authorization", () => {
  test("authorizeBot consults only the 04.6 grant seam; models and scopes are never touched", async () => {
    const grants = fakeGrants();
    let filterReads = 0;
    const filter = {
      async listSelectableModels(): Promise<ModelSelectionResult> {
        filterReads += 1;
        return { selectable: [], excluded: [] };
      },
    } satisfies Pick<
      GatewayModelCapabilityFilterService,
      "listSelectableModels"
    >;
    const scopes = fakeScopes(true);
    const modelAccess = facade({
      models: {
        selectable: filter,
        priceSnapshots: fakePrices([]).store,
      },
      scopes: scopes.service,
      grants: grants.service,
    });
    await modelAccess.authorizeBot("grant-1", BOT_IDENTITY);
    expect(grants.calls).toHaveLength(1);
    expect(filterReads).toBe(0);
    expect(scopes.calls).toHaveLength(0);
  });

  test("authorizeModel consults only the 03.7 open scope; the grant seam is never touched", async () => {
    const grants = fakeGrants();
    const scopes = fakeScopes(false);
    const modelAccess = facade({
      models: {
        selectable: fakeFilter({ selectable: [], excluded: [] }).service,
        priceSnapshots: fakePrices([]).store,
      },
      scopes: scopes.service,
      grants: grants.service,
    });
    const verdict = await modelAccess.authorizeModel(CHAT_REF);
    expect(verdict).toBe(false);
    expect(scopes.calls).toEqual([CHAT_REF]);
    expect(grants.calls).toHaveLength(0);
  });

  test("the facade's source never names an authentication seam: the 04.2 door lives in the routes, not here", () => {
    const source = codeOf(srcOf("../../src/gateway/public.ts"));
    for (const banned of [
      "authenticate",
      "mintBotServiceSecret",
      "parseBotServiceSecret",
      "requireBotService",
      "BotServiceAuthenticator",
    ]) {
      expect(source.includes(banned)).toBe(false);
    }
  });

  test("the 04.6 uniform refusal instance passes through untouched", async () => {
    const refusal = new AccessGrantUseError();
    const grants = fakeGrants({
      resolveForBot: () => {
        throw refusal;
      },
    });
    const modelAccess = facade({ grants: grants.service });
    const error = await errorOf(
      modelAccess.authorizeBot("grant-1", BOT_IDENTITY),
    );
    expect(error).toBe(refusal);
    expect(error).toBeInstanceOf(AccessGrantUseError);
  });

  test("route-level: the discovery door authenticates the Bot and never authorizes anything on its own", async () => {
    let authentications = 0;
    let grantCalls = 0;
    const authenticate: BotServiceAuthenticator = async () => {
      authentications += 1;
      return BOT_IDENTITY;
    };
    const grants = fakeGrants();
    // 计数包装：证明路由路径从不触碰授权 seam。
    const counted = {
      async resolveForBot(grantId: string, identity: BotServiceIdentity) {
        grantCalls += 1;
        return grants.service.resolveForBot(grantId, identity);
      },
      async listForUser(userId: string) {
        grantCalls += 1;
        return grants.service.listForUser(userId);
      },
      async revokeForUser(grantId: string, userId: string) {
        grantCalls += 1;
        return grants.service.revokeForUser(grantId, userId);
      },
    } satisfies Pick<
      AccessGrantService,
      "resolveForBot" | "listForUser" | "revokeForUser"
    >;
    facade({
      models: {
        selectable: fakeFilter({ selectable: [], excluded: [] }).service,
        priceSnapshots: fakePrices([]).store,
      },
      grants: counted,
    });
    const app = createModelDiscoveryRoutes(
      {
        authenticate,
        botServices: {
          getBotService: async () => BOT_ONE,
        } satisfies Pick<BotServiceStore, "getBotService">,
      },
      {
        selectable: () => fakeFilter({ selectable: [], excluded: [] }).service,
        priceSnapshots: () => fakePrices([]).store,
      },
    );
    const denied = await app.request("/");
    expect(denied.status).toBe(401); // 无凭据：门先拒绝
    const allowed = await app.request("/", {
      headers: { authorization: "Bearer anything" },
    });
    expect(allowed.status).toBe(200);
    expect(authentications).toBe(1);
    expect(grantCalls).toBe(0); // 认证通过也不产生任何授权判定
  });
});

// ---------------------------------------------------------------------------
// D4 验收③ Key 过期/撤销/续期维持原用户与授权来源
// ---------------------------------------------------------------------------

describe("MOD08 D4 (AC3): key expiry, revocation and renewal keep the original user and authorization source", () => {
  test("expiry verdict: the boundary is now == expiresAt (the gateway's own line)", () => {
    const expiresAt = "2026-10-24T01:00:00.000Z";
    const before = gatewayKeyUsableForNewRequest(
      { status: "active", expiresAt },
      new Date("2026-10-24T00:59:59.999Z"),
    );
    const at = gatewayKeyUsableForNewRequest(
      { status: "active", expiresAt },
      new Date(expiresAt),
    );
    expect(before.usable).toBe(true);
    expect(at).toEqual({
      usable: false,
      reason: "gateway_key_expired",
      expiredAt: expiresAt,
    });
  });

  test("expiry verdict: a row the sync already marked expired is refused without consulting the clock", () => {
    const verdict = gatewayKeyUsableForNewRequest(
      { status: "expired", expiresAt: "2020-01-01T00:00:00.000Z" },
      new Date("2099-01-01T00:00:00.000Z"),
    );
    expect(verdict).toEqual({
      usable: false,
      reason: "gateway_key_expired",
      expiredAt: "2020-01-01T00:00:00.000Z",
    });
  });

  test("expiry verdict: a pre-05.5 record with no term never expires by the clock", () => {
    const verdict = gatewayKeyUsableForNewRequest(
      { status: "active", expiresAt: null },
      new Date("2099-01-01T00:00:00.000Z"),
    );
    expect(verdict).toEqual({ usable: true });
  });

  test("revokeGrant is the person's own act: the grant id and the session user ride verbatim, nothing else", async () => {
    const grants = fakeGrants();
    const modelAccess = facade({ grants: grants.service });
    await modelAccess.revokeGrant("grant-1", "user-1");
    expect(grants.calls).toEqual([
      { method: "revokeForUser", args: ["grant-1", "user-1"] },
    ]);
  });

  test("key status never carries secret material: the listed shape has no plaintext field", async () => {
    const grants = fakeGrants();
    const modelAccess = facade({ grants: grants.service });
    const status = await modelAccess.grantKeyStatus("user-1");
    expect(JSON.stringify(status).includes("secret")).toBe(false);
    expect(status[0].activeKeys).toEqual([]);
  });

  test("source pin: issuance and renewal re-verify the 04.6 grant seam and bill the original personal payer", () => {
    const issuance = codeOf(srcOf("../../src/gateway/key-issuance.ts"));
    const renewal = codeOf(srcOf("../../src/gateway/key-renewal.ts"));
    for (const source of [issuance, renewal]) {
      expect(source.includes("resolveForBot")).toBe(true);
      expect(source.includes('kind: "personal"')).toBe(true);
      expect(source.includes("grant.userId")).toBe(true);
    }
    // 05.7 的远端退役在本地翻转之后 best-effort 进行：撤销合同原样留在内件。
    expect(
      codeOf(srcOf("../../src/bot-services/access-grants.ts")).includes(
        "revokeGatewayKeys",
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// D5 验收④ 个人路径与公司业务权限分开
// ---------------------------------------------------------------------------

describe("MOD08 D5 (AC4): the personal path stays separate from company business authority", () => {
  test("every facade import is in the M06 group (gateway/ and bot-services/ only)", () => {
    const source = codeOf(srcOf("../../src/gateway/public.ts"));
    const specifiers = [...source.matchAll(/from "([^"]+)"/g)].map(
      (match) => match[1],
    );
    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) {
      expect(
        specifier.startsWith("./") || specifier.startsWith("../bot-services/"),
      ).toBe(true);
    }
  });

  test("module-imports pins gateway/ and bot-services/ to M06", () => {
    const config = JSON.parse(
      srcOf("../../../tests/config/module-imports.json"),
    ) as { moduleRoots: { path: string; module: string }[] };
    const byModule = (id: string) =>
      config.moduleRoots
        .filter((root) => root.module === id)
        .map((root) => root.path);
    const serverPaths = byModule("M06").filter((path) =>
      path.startsWith("server/"),
    );
    // 服务端三目录全在 M06；同名前端 lib 组（app/src/lib/*）同属 M06，不在本断言面。
    expect(serverPaths).toEqual([
      "server/src/gateway",
      "server/src/bot-services",
      "server/src/enterprise/models",
    ]);
  });

  test("the personal signatures take no scope authority: session user id and grant id only", () => {
    const modelAccess = facade({
      grants: fakeGrants().service,
      models: {
        selectable: fakeFilter({ selectable: [], excluded: [] }).service,
        priceSnapshots: fakePrices([]).store,
      },
      scopes: fakeScopes(true).service,
    });
    expect(modelAccess.grantKeyStatus.length).toBe(1);
    expect(modelAccess.revokeGrant.length).toBe(2);
    expect(modelAccess.authorizeBot.length).toBe(2);
    expect(modelAccess.authorizeModel.length).toBe(1);
    expect(modelAccess.keyUsableForNewRequest.length).toBe(2);
    const source = codeOf(srcOf("../../src/gateway/public.ts"));
    expect(/workspace|tenantId|PlatformScope|workspaceId/.test(source)).toBe(
      false,
    );
  });

  test("a facade assembled with only the models group serves availableModels (Pick-minimal construction)", async () => {
    const filter = fakeFilter({ selectable: [CHAT_REF], excluded: [] });
    const prices = fakePrices([snapshot(CHAT_REF, pricedDims())]);
    const modelAccess: ModelAccessPublic = facade({
      models: { selectable: filter.service, priceSnapshots: prices.store },
    });
    const answer = await modelAccess.availableModels({
      botCapabilities: ["chat"],
      requester: { kind: "bot_service", id: "bot-1" },
    });
    expect(answer.selectable).toEqual([
      { ref: CHAT_REF, priceStatus: "known" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// D6 验收⑤ 不补做 Bifrost 未实现能力
// ---------------------------------------------------------------------------

describe("MOD08 D6 (AC5): no Bifrost capability is invented or exposed", () => {
  const FROZEN_METHODS = [
    "availableModels",
    "authorizeModel",
    "authorizeBot",
    "grantKeyStatus",
    "revokeGrant",
    "keyUsableForNewRequest",
  ];

  function fullFacade(): ModelAccessPublic {
    return facade({
      models: {
        selectable: fakeFilter({ selectable: [], excluded: [] }).service,
        priceSnapshots: fakePrices([]).store,
      },
      scopes: fakeScopes(true).service,
      grants: fakeGrants().service,
    });
  }

  test("the facade's method set is exactly the frozen six (no invoke, no issuance, no rotation, no sync)", () => {
    const modelAccess = fullFacade();
    expect(Object.keys(modelAccess).sort()).toEqual([...FROZEN_METHODS].sort());
  });

  test("the facade's import set is exactly the frozen M06 in-group list (no store, no sync implementation re-export)", () => {
    const source = codeOf(srcOf("../../src/gateway/public.ts"));
    const specifiers = [...source.matchAll(/from "([^"]+)"/g)]
      .map((match) => match[1])
      .sort();
    expect(specifiers).toEqual(
      [
        "../bot-services/access-grants",
        "../bot-services/types",
        "./capability-availability",
        "./catalog",
        "./key-expiry",
        "./model-capability-filter",
        "./model-scope",
        "./price-snapshot",
      ].sort(),
    );
  });

  test("availableModels' answer invents no field beyond the frozen three keys", async () => {
    const modelAccess = fullFacade();
    const answer = await modelAccess.availableModels({
      botCapabilities: ["chat"],
      requester: { kind: "user", id: "user-1" },
    });
    expect(Object.keys(answer).sort()).toEqual([
      "capabilityAvailability",
      "excluded",
      "selectable",
    ]);
    expect(
      Object.keys(answer.selectable[0] ?? { ref: 1, priceStatus: 1 }).sort(),
    ).toEqual(["priceStatus", "ref"]);
    expect(
      Object.keys(answer.excluded[0] ?? { ref: 1, reasonCode: 1 }).sort(),
    ).toEqual(["reasonCode", "ref"]);
  });

  test("public.ts re-exports nothing (no `export *`, no value re-export block)", () => {
    const source = codeOf(srcOf("../../src/gateway/public.ts"));
    expect(/export \*/.test(source)).toBe(false);
    expect(/export \{[^}]*\} from/.test(source)).toBe(false);
  });
});

// server/src/enterprise/tenancy/telemetry-usage.ts
// MT109（Issue #152）：用量事件的账户区分与脱敏回归。
//
// 票面语义（brief + Issue #152 正文）：
//   AC1 用量事件携带付款账户类型与稳定标识；公司与个人事件不混淆。
//   AC2 重放同一事件不会记到另一账户（幂等测试）。
//   AC3 脱敏规则覆盖服务 token、cookie、OAuth、个人 Key 与凭据正文
//      （含错误与异常路径）。
//   AC4 既有脱敏回归套件全部通过（本轮以
//      server/tests/enterprise-controls.test.ts 的 scrubCommand 回归表与
//      server/tests/otel-export-scrubbing.test.ts 为「既有套件」，跑在本票
//      增量之后；见 telemetry-usage.test.ts 头部的复跑命令）。
//
// 本文件是用量事件观测半边的落点，四件事：
//
//   1. 账户绑定 UsageEventAccountBinding——付款账户类型（company/personal，
//      父 Spec 计费词汇的付款半边）＋稳定主体标识＋计费栈自己的外部客户键
//      （payer 层 MT069/#112 的映射产物：公司与个人的键不同前缀，同一主体
//      键恒定）。类型只从已分类事实进入——本模块不存在「从字符串推断类型」
//      的路径（不混淆的机制是结构性的，不是命名纪律）。
//   2. 未分类隔离——归属不明的账户走 quarantineUsageEventAccount：显式
//      quarantined 结果，绝不默认成 personal（与 payer 层 unknown_owner、
//      MT108 的 missing 标记同一裁决）。
//   3. 幂等账本 createUsageEventRecorder——事件自身的稳定 id 是唯一身份；
//      首次记录记住 (事件 id → 账户戳)，同账户重放 = replayed 零二次写入，
//      异账户重放 = USAGE_EVENT_ACCOUNT_MISMATCH 拒绝且零写入——重放永远
//      不会记到另一账户。sink 注入（内存、outbox 写入器同形状），纯面可
//      测试；生产侧 usage_outbox 的 eventId 主键是同一纪律的 DB 半边。
//   4. 脱敏门 redactUsageEvent——事件的自由正文（detail、error.code、
//      error.message：错误与异常路径是凭据最常混进来的地方）经共享
//      scrubCommand（本轮按票面补齐 cookie 与 OAuth query 两族形状）；
//      账户绑定字段是裸标识，逐个过 MT108 的 isAttributionIdentifier。
//
// 环境纪律：纯函数（sha256 摘要经 node:crypto），不读环境、不触数据库。

import { createHash } from "node:crypto";
import { scrubCommand } from "../../telemetry/scrub";
import { isAttributionIdentifier } from "./telemetry-attribution";

/** 用量事件的付款账户类型：父 Spec 词汇的付款半边，闭集。 */
export type UsageAccountKind = "company" | "personal";

/** 哨兵拒码：账户字段形状不合法（含凭据形状）时抛出。 */
export const USAGE_EVENT_ACCOUNT_INVALID = "USAGE_EVENT_ACCOUNT_INVALID";

/** 用量事件携带的付款账户绑定：类型 ＋ 稳定标识 ＋ 计费外部客户键。 */
export interface UsageEventAccountBinding {
  readonly kind: UsageAccountKind;
  /** 主体自己的稳定 id：个人＝用户 id；公司＝tenant id。 */
  readonly payerId: string;
  /** 计费栈的稳定账户键（payer 层映射的产物，公司/个人不同前缀）。 */
  readonly externalCustomerId: string;
}

/** 从已分类事实铸账户绑定；标识逐个校验，凭据形状在入口即拒。 */
export function bindUsageEventAccount(input: {
  readonly kind: UsageAccountKind;
  readonly payerId: string;
  readonly externalCustomerId: string;
}): UsageEventAccountBinding {
  const binding: UsageEventAccountBinding = {
    kind: input.kind,
    payerId: input.payerId,
    externalCustomerId: input.externalCustomerId,
  };
  if (binding.kind !== "company" && binding.kind !== "personal") {
    throw new Error(
      `${USAGE_EVENT_ACCOUNT_INVALID}: kind must be a classified payment-account kind, never inferred`,
    );
  }
  for (const [name, value] of [
    ["payerId", binding.payerId],
    ["externalCustomerId", binding.externalCustomerId],
  ] as const) {
    if (!isAttributionIdentifier(value)) {
      throw new Error(
        `${USAGE_EVENT_ACCOUNT_INVALID}: ${name} is not a bare identifier (credential-shaped or malformed values are never carried on a usage event)`,
      );
    }
  }
  return binding;
}

/** 未分类账户的隔离结果：显式、带原因，绝不降级成 personal。 */
export interface QuarantinedUsageAccount {
  readonly status: "quarantined";
  readonly reason: string;
}

/** 归属不明账户的唯一去处：隔离记录，不产生可计费绑定。 */
export function quarantineUsageEventAccount(
  reason: string,
): QuarantinedUsageAccount {
  return { status: "quarantined", reason };
}

/**
 * 账户戳：绑定三元的稳定摘要（sha256 截断 40 hex，与 scoped-keys 同形）。
 * 重放比对用它——同账户重放与异账户重放在戳上一比即分，不需要展开字段。
 */
export function usageEventAccountStamp(
  binding: UsageEventAccountBinding,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        binding.kind,
        binding.payerId,
        binding.externalCustomerId,
      ]),
    )
    .digest("hex")
    .slice(0, 40);
}

// ---------------------------------------------------------------------------
// 用量事件与幂等账本
// ---------------------------------------------------------------------------

/** 一条用量事件：账户绑定是必带半边；meters 是用量维度；正文可缺省。 */
export interface UsageEvent {
  /** 事件自身的稳定 id（usage_outbox.event_id 的语义——重放的身份）。 */
  readonly eventId: string;
  /** 用量面（llm/code_run/voice/dictation…），裸标识。 */
  readonly source: string;
  readonly account: UsageEventAccountBinding;
  readonly meters: ReadonlyArray<{
    readonly name: string;
    readonly value: number;
  }>;
  readonly occurredAt: string;
  /** 自由正文（错误路径/异常文本）——发射前经 redactUsageEvent。 */
  readonly detail?: string;
  /** 错误与异常路径的显式半边（provider 失败文案最常夹带凭据）。 */
  readonly error?: { readonly code: string; readonly message: string };
}

export type UsageEventOutcome =
  | { readonly status: "recorded" }
  /** 同账户重放：零二次写入，不是新操作（与 account-resolution 的 replayed 同语义）。 */
  | { readonly status: "replayed"; readonly accountStamp: string }
  /** 异账户重放：拒绝且零写入——重放不会记到另一账户。 */
  | {
      readonly status: "refused";
      readonly code: "USAGE_EVENT_ACCOUNT_MISMATCH";
      readonly eventId: string;
      readonly recordedUnder: string;
      readonly replayedUnder: string;
    };

/** 记录写入面：内存 sink、outbox 写入器同形状。 */
export interface UsageEventSink {
  write(event: UsageEvent): void;
}

/**
 * 幂等账本：事件 id 是身份，账户是首次记录时的属性。
 *
 * 重放同一事件（同 id）：
 *   - 同账户 → replayed，sink 零调用；
 *   - 异账户 → USAGE_EVENT_ACCOUNT_MISMATCH 拒绝，sink 零调用，两个账户戳
 *     都在拒绝里（对账能看见撞的是哪两方）。
 * 生产侧的 DB 半边是 usage_outbox 的 eventId 主键——同一事件永远只有一行，
 * 而本账本保证那一行的账户从第一次写入起就不变。
 */
export function createUsageEventRecorder(sink: UsageEventSink): {
  record(event: UsageEvent): UsageEventOutcome;
} {
  const recordedUnder = new Map<string, string>();
  return {
    record(event) {
      const stamp = usageEventAccountStamp(event.account);
      const existing = recordedUnder.get(event.eventId);
      if (existing !== undefined) {
        return existing === stamp
          ? { status: "replayed", accountStamp: stamp }
          : {
              status: "refused",
              code: "USAGE_EVENT_ACCOUNT_MISMATCH",
              eventId: event.eventId,
              recordedUnder: existing,
              replayedUnder: stamp,
            };
      }
      recordedUnder.set(event.eventId, stamp);
      sink.write(event);
      return { status: "recorded" };
    },
  };
}

// ---------------------------------------------------------------------------
// 脱敏门（AC3：错误与异常路径是第一公民）
// ---------------------------------------------------------------------------

/** 一条事件（脱敏后）：账户绑定原样（裸标识），正文与错误文案经共享脱敏。 */
export function redactUsageEvent<T extends UsageEvent>(event: T): T {
  return {
    ...event,
    ...(event.detail !== undefined
      ? { detail: scrubCommand(event.detail) }
      : {}),
    ...(event.error !== undefined
      ? {
          error: {
            code: scrubCommand(event.error.code),
            message: scrubCommand(event.error.message),
          },
        }
      : {}),
  };
}

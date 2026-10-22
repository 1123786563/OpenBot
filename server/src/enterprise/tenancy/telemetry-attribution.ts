// server/src/enterprise/tenancy/telemetry-attribution.ts
// MT108（Issue #151）：trace、日志与业务事件的归属字段注入。
//
// 票面语义（brief + Issue #151 正文）：
//   AC1 每条 trace/日志/事件都能追溯到公司、团队与发起主体。
//   AC2 归属字段在跨语言与后台执行路径中不丢失（与运行侧契约一致）。
//   AC3 归属字段不含明文凭据或可反推秘密的信息。
//   AC4 缺失归属的记录被标记为异常，不静默归到默认范围。
//
// 本文件是这个「归属半边」的落点，四件事：
//
//   1. telemetryAttributionFromScope——归属只从受信 PlatformScope 取
//      （assertTrustedScope，与 MT049/MT016 同一纪律）：手造 scope 在此即拒，
//      不存在「默认归属」。执行事实（run/attempt/turn/thread/initiator）由
//      调用方从运行协议真实行喂入，标识逐个校验（§3 的同一张校验表）。
//   2. telemetryAttributionFromInvocation——跨语言半边：从 #93（MT050）的
//      RuntimeInvocationWireSchema 信封（Go 侧 identity.VerifiedRun 的同一
//      形状）还原归属。字段名与 wire 逐字一致（snake_case），所以「TS 侧
//      telemetry 说的归属」与「Go runtime 说的归属」是同一套名字——不丢失
//      的机制就是：两边读的是同一个 schema 的同一批字段。
//   3. 标识校验 isAttributionIdentifier——非空、无空白、≤200、可打印，且
//      不是凭据形状（JWT/sk-/ghp_/AKIA/私钥块/Authorization 头/URL userinfo，
//      即 scrub.ts TOKEN_SHAPES 的同一族形状）：一个贴进 tenant_id 的 token
//      在入口即拒，绝不作为归属记录（AC3 的结构半边；正文脱敏仍是 otel
//      导出器 scrubCommands 的职责，这里不重复实现）。
//   4. telemetryRecordAttributes——发射门：一条记录的归属要么来自已验证
//      归属，要么带着显式 missing 标记（openbot.attribution=missing +
//      surface + reason），不存在第三种输出。reader attributionStatusOf 把
//      「不带标记」读成 unmarked——它本身就是异常（AC4：缺失是标记出来
//      的，不是默认出来的）。
//
// 后台执行路径（AC2 的 ambient 半边）：withTelemetryAttribution /
// currentTelemetryAttribution 用 AsyncLocalStorage 携带已验证归属穿越
// await 与后台续体——与 usage-origin.ts 同一模式（参数穿透会跨模块边界，
// ambient store 是计费 seam 已验证过的通道）。
//
// 环境纪律：纯函数，不读进程环境，不触数据库（与 scoped-keys/
// runtime-config 同族）；受信 scope 的正向签发面在 store.ts，DB 面用例见
// telemetry-attribution.test.ts 的 describeDb 段。

import { AsyncLocalStorage } from "node:async_hooks";
import type { PlatformScope } from "../contracts";
import type { RuntimeInvocation } from "../wire-schema";
import { assertTrustedScope } from "./store";

/** 归属标识的哨兵拒码：标识形状不合法（含凭据形状）时抛出，调用方落入 missing 门。 */
export const TELEMETRY_ATTRIBUTION_IDENTIFIER_INVALID =
  "TELEMETRY_ATTRIBUTION_IDENTIFIER_INVALID";

/** 缺失归属的显式标记值（openbot.attribution 的两个取值之一）。 */
export const ATTRIBUTION_MISSING = "missing";
/** 已归属的标记值。 */
export const ATTRIBUTION_PRESENT = "present";

/** 记录种类：trace span、日志行、业务事件——同一词汇，同一字段。 */
export type TelemetryRecordSurface = "trace" | "log" | "event";

/** 执行事实：与 RuntimeInvocationWireSchema 的执行半边同名。 */
export interface TelemetryExecutionFacts {
  readonly initiatorKind: "human" | "schedule";
  readonly runId: string;
  readonly attemptId: string;
  readonly turnId: string;
  readonly threadId: string;
}

/** 已验证归属：公司、团队、发起主体（＋执行事实，当记录属于某次运行）。 */
export interface TelemetryAttribution {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly principalId: string;
  readonly actorId: string;
  /** 发起面（scope 自带；wire 信封不携带——运行侧不知道入口面，如实缺席）。 */
  readonly entrypoint?: PlatformScope["entrypoint"];
  readonly execution?: TelemetryExecutionFacts;
}

// ---------------------------------------------------------------------------
// 1. 受信 scope 半边（归属只从签发入口来）
// ---------------------------------------------------------------------------

/** 从受信 PlatformScope 取归属；执行事实可选（非运行类事件只带身份四元组）。 */
export function telemetryAttributionFromScope(
  scope: PlatformScope,
  execution?: TelemetryExecutionFacts,
): TelemetryAttribution {
  assertTrustedScope(scope);
  const attribution: TelemetryAttribution = {
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId,
    principalId: scope.principalId,
    actorId: scope.actorId,
    entrypoint: scope.entrypoint,
    ...(execution !== undefined ? { execution } : {}),
  };
  assertAttributionIdentifiers(attribution);
  return attribution;
}

// ---------------------------------------------------------------------------
// 2. 跨语言半边（#93 的 wire 契约，字段同名还原）
// ---------------------------------------------------------------------------

/** 从已验证的 RuntimeInvocation 信封还原归属——Go 侧同一批字段，一个不丢。 */
export function telemetryAttributionFromInvocation(
  invocation: RuntimeInvocation,
): TelemetryAttribution {
  const attribution: TelemetryAttribution = {
    tenantId: invocation.tenant_id,
    workspaceId: invocation.workspace_id,
    principalId: invocation.principal_id,
    actorId: invocation.actor_id,
    execution: {
      initiatorKind: invocation.initiator_kind,
      runId: invocation.run_id,
      attemptId: invocation.attempt_id,
      turnId: invocation.turn_id,
      threadId: invocation.thread_id,
    },
  };
  assertAttributionIdentifiers(attribution);
  return attribution;
}

// ---------------------------------------------------------------------------
// 3. 标识校验（AC3 的结构半边：凭据形状在入口即拒）
// ---------------------------------------------------------------------------

/**
 * 一个值作为归属标识是否成立：非空、无空白/控制字符、≤200、可打印，且不匹配
 * 凭据形状。不 trim——静默 trim 会把 " acme" 与 "acme" 折成同一归属（与
 * payer.ts assertRef 同一裁决：宽容归一化在这里是混淆，不是清洁）。
 */
export function isAttributionIdentifier(value: string): boolean {
  if (value.length === 0 || value.length > 200) return false;
  // 可打印 ASCII + 常规 Unicode 字母数字之外，标识不应有空白或控制位
  // （\p{Cc}＝C0+C1 控制字符，含 DEL）。
  if (/[\s\p{Cc}]/u.test(value)) return false;
  return !CREDENTIAL_SHAPES.some((shape) => shape.test(value));
}

/**
 * 凭据形状（与 telemetry/scrub.ts 的 TOKEN_SHAPES 同族；此处独立持有避免
 * scrub 模块被生产面反向依赖）。测试锚点：正文中出现的任何这一族形状都必须
 * 在这里被拒——归属字段是给 SIEM 按范围查询用的，不是凭据的第二份拷贝。
 */
const CREDENTIAL_SHAPES: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/,
  /\b(AKIA|ASIA)[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{22,255}\b/,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/,
  /\bsk-(proj-|ant-)?[A-Za-z0-9_-]{20,}\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\b(sk|rk)_(live|test)_[0-9a-zA-Z]{16,}\b/,
  /\bnpm_[A-Za-z0-9]{36}\b/,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  /\b(bearer|basic|token)\s+\S+/i,
  /[a-z][a-z0-9+.-]*:\/\/[^\s/@:]*:[^\s/@]+@/i,
];

function assertAttributionIdentifiers(attribution: TelemetryAttribution): void {
  const fields: Array<[string, string]> = [
    ["tenantId", attribution.tenantId],
    ["workspaceId", attribution.workspaceId],
    ["principalId", attribution.principalId],
    ["actorId", attribution.actorId],
  ];
  if (attribution.execution !== undefined) {
    fields.push(
      ["runId", attribution.execution.runId],
      ["attemptId", attribution.execution.attemptId],
      ["turnId", attribution.execution.turnId],
      ["threadId", attribution.execution.threadId],
    );
  }
  for (const [name, value] of fields) {
    if (!isAttributionIdentifier(value)) {
      throw new Error(
        `${TELEMETRY_ATTRIBUTION_IDENTIFIER_INVALID}: ${name} is not a bare identifier (credential-shaped or malformed values are never recorded as attribution)`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// 4. 发射门与 reader（AC4：缺失是标记出来的，不是默认出来的）
// ---------------------------------------------------------------------------

/** 已验证归属 → 平铺 OTel 属性（trace span、日志行、业务事件同一词汇）。 */
export function telemetryAttributesOf(
  attribution: TelemetryAttribution,
): Record<string, string> {
  const attributes: Record<string, string> = {
    "openbot.attribution": ATTRIBUTION_PRESENT,
    "openbot.tenant_id": attribution.tenantId,
    "openbot.workspace_id": attribution.workspaceId,
    "openbot.principal_id": attribution.principalId,
    "openbot.actor_id": attribution.actorId,
  };
  if (attribution.entrypoint !== undefined) {
    attributes["openbot.entrypoint"] = attribution.entrypoint;
  }
  if (attribution.execution !== undefined) {
    attributes["openbot.initiator_kind"] = attribution.execution.initiatorKind;
    attributes["openbot.run_id"] = attribution.execution.runId;
    attributes["openbot.attempt_id"] = attribution.execution.attemptId;
    attributes["openbot.turn_id"] = attribution.execution.turnId;
    attributes["openbot.thread_id"] = attribution.execution.threadId;
  }
  return attributes;
}

/**
 * 缺失归属的显式标记：带 surface（哪类记录）与 reason（内部拒码/原因，标识
 * 化短文本，不是自由正文）。不带任何默认范围键——SIEM 按公司查不到它，按
 * missing 查得到它，这正是 AC4 要的形状。
 */
export function unattributedTelemetryAttributes(input: {
  readonly surface: TelemetryRecordSurface | (string & {});
  readonly reason: string;
}): Record<string, string> {
  return {
    "openbot.attribution": ATTRIBUTION_MISSING,
    "openbot.surface": input.surface,
    "openbot.attribution.missing_reason": input.reason,
  };
}

/**
 * 发射门：一条记录的属性要么是已验证归属，要么是显式 missing 标记。没有
 * 「什么都不带」的输出——空归属的记录在共享观测后端上不可判定，比缺失更糟。
 */
export function telemetryRecordAttributes(input: {
  readonly attribution: TelemetryAttribution | null;
  readonly surface: TelemetryRecordSurface | (string & {});
  /** 归属缺失时的原因（内部拒码/路径名；attribution 非空时忽略）。 */
  readonly missingReason?: string;
}): Record<string, string> {
  return input.attribution !== null
    ? telemetryAttributesOf(input.attribution)
    : unattributedTelemetryAttributes({
        surface: input.surface,
        reason: input.missingReason ?? "attribution_unavailable",
      });
}

/** reader：一条记录的归属状态。unmarked 本身就是异常（AC4）。 */
export function attributionStatusOf(
  attributes: Record<string, unknown>,
): "attributed" | "missing" | "unmarked" {
  const marker = attributes["openbot.attribution"];
  if (marker === ATTRIBUTION_PRESENT) return "attributed";
  if (marker === ATTRIBUTION_MISSING) return "missing";
  return "unmarked";
}

// ---------------------------------------------------------------------------
// ambient 半边（AC2 的后台路径）：已验证归属穿越 await 与后台续体
// ---------------------------------------------------------------------------

const attributionStore = new AsyncLocalStorage<{
  attribution: TelemetryAttribution;
}>();

/** 把 fn（及其 await 的一切）作为携带该归属的工作运行。 */
export function withTelemetryAttribution<T>(
  attribution: TelemetryAttribution,
  fn: () => Promise<T>,
): Promise<T> {
  return attributionStore.run({ attribution }, fn);
}

/** 当前执行路径的归属；未携带时 null——调用方交给发射门落 missing 标记。 */
export function currentTelemetryAttribution(): TelemetryAttribution | null {
  return attributionStore.getStore()?.attribution ?? null;
}

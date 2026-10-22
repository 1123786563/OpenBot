// server/src/enterprise/tenancy/agent-adapters.ts
// MT049（Issue #92）：TypeScript agent 适配器统一消费已验证归属。
//
// 票面：各 TypeScript agent 适配器（不同框架）都消费同一个已验证的执行
// 归属与回调解析结果，不因框架不同而跳过授权。
//
// 本文件是这个「同一个」的落点，四件事：
//
//   1. issueRuntimeInvocation——VerifiedRun 信封的 TS 侧唯一签发入口
//      （#93 互引的交付物）：归属三元组只从受信 PlatformScope 取，运行
//      事实（run/attempt/turn/租约/路由/预算）由接线方从运行协议的真实
//      行喂入；信封经 RuntimeInvocationWireSchema 校验——workspace_id
//      必填（MT050 契约），缺失/篡改在签发处即拒，不产出一个能被 Go 侧
//      接受的半归属信封。
//   2. mintScopedRunAssertion——携带归属的 run 断言（ag_ui/mastra/built_in
//      三类适配器的回调凭据）：断言里 signed 的 ownership 只能由受信
//      scope 铸出，适配器自己不构造 Scope（AC2）。
//   3. resolveAgentAdapterCallback——全部适配器共用的回调解析：token +
//      断言签名 + token↔Bot 互检（复用既有 authoriseAgentCall），再加
//      企业纪律——无归属的断言不是「我们的」，拒绝而不是以默认身份继续
//      （AC1）；一个入口保证跨适配器一致（AC3）。
//   4. describeAdapterAttribution——日志/错误文案：只含归属标识，永不含
//      明文秘密（token/capability/信封原文）（AC4）。
//
// 与前置的接缝：Go 侧 VerifiedRun/信封契约由 #93 交付（wire-schema +
// runtime-v1.schema.json + Go identity）；执行面翻译（computer/sandbox）
// 由 #86 交付；native-runtime 面在本票注册进 execution-surfaces.ts，归
// 属判定仍在 #90 的 ExecutionGrant——本文件不另造归属通道。

import {
  authoriseAgentCall,
  mintRunAssertion,
  type RunAssertion,
} from "../../agents/callback-token";
import type { PlatformScope } from "../contracts";
import {
  type RuntimeInvocation,
  RuntimeInvocationWireSchema,
} from "../wire-schema";
import { assertTrustedScope } from "./store";

// ---------------------------------------------------------------------------
// 1. VerifiedRun 信封签发（native-runtime 线上的归属半边）
// ---------------------------------------------------------------------------

/**
 * 签发信封所需的运行协议事实——全部来自服务端持久行（run/attempt/租约/
 * 路由/预算），调用方没有任何位置可以注入归属或改写事实的入口：归属只
 * 从受信 scope 取。
 */
export interface RuntimeInvocationFacts {
  readonly runId: string;
  readonly attemptId: string;
  readonly turnId: string;
  readonly threadId: string;
  /** 信封上的 fencing_token（数字串）；attempt 的整型 fencing token。 */
  readonly fencingToken: number;
  /** 信封上的 lease_id；请求租约的 owner token（Go 侧 cancel 的租约凭证）。 */
  readonly leaseId: string;
  readonly expiresAt: Date;
  readonly expertVersion: string;
  readonly inputDigest: string;
  readonly modelRouteRef: string;
  readonly budgetReservationId: string;
  readonly initiatorKind: "human" | "schedule";
  readonly delegationRef?: string;
}

export interface IssuedRuntimeInvocation {
  /** 校验后的信封（snake_case，与 Go envelopeWire 逐字段对应）。 */
  readonly invocation: RuntimeInvocation;
  /** x-openbot-runtime-invocation 头的精确字节（JSON）。 */
  readonly header: string;
}

/**
 * 铸出携带归属的 RuntimeInvocation 信封。
 *
 * 唯一入口：受信 scope 之外（手造/JSON 往返）在此即拒；workspace 半边
 * 缺失或形状不对由 wire schema 拒——两边都不存在「默认归属」。
 */
export function issueRuntimeInvocation(input: {
  readonly scope: PlatformScope;
  readonly facts: RuntimeInvocationFacts;
}): IssuedRuntimeInvocation {
  const { scope, facts } = input;
  assertTrustedScope(scope);
  if (!facts || typeof facts !== "object")
    throw new Error("RUNTIME_INVOCATION_FACTS_INVALID");
  const invocation = RuntimeInvocationWireSchema.parse({
    schema_version: 1,
    tenant_id: scope.tenantId,
    workspace_id: scope.workspaceId,
    principal_id: scope.principalId,
    actor_id: scope.actorId,
    initiator_kind: facts.initiatorKind,
    run_id: facts.runId,
    attempt_id: facts.attemptId,
    turn_id: facts.turnId,
    thread_id: facts.threadId,
    expert_version: facts.expertVersion,
    input_digest: facts.inputDigest,
    model_route_ref: facts.modelRouteRef,
    budget_reservation_id: facts.budgetReservationId,
    lease_id: facts.leaseId,
    fencing_token: String(facts.fencingToken),
    expires_at: facts.expiresAt.toISOString(),
    ...(facts.delegationRef !== undefined
      ? { delegation_ref: facts.delegationRef }
      : {}),
  });
  return { invocation, header: JSON.stringify(invocation) };
}

/**
 * 消费一个信封头（native 面收到的 x-openbot-runtime-invocation 值）。
 *
 * 只做形状与归属完整性校验（wire schema）；身份判定是 Go 侧 auth 中间件
 * 经 TS 验证端做的事，不在这里伪造。半归属/被篡改的信封返回 null——
 * 调用方拒绝执行，不修补、不默认。
 */
export function consumeRuntimeInvocationHeader(
  header: unknown,
): RuntimeInvocation | null {
  if (typeof header !== "string" || !header.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(header);
  } catch {
    return null;
  }
  const result = RuntimeInvocationWireSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

// ---------------------------------------------------------------------------
// 2. 携带归属的 run 断言（适配器回调凭据的签发半边）
// ---------------------------------------------------------------------------

/**
 * 铸出携带执行归属的 run 断言。
 *
 * ownership 半边只能来自受信 scope（签发入口产物）——适配器与调用方都
 * 没有把归属写进断言的入口（AC2：适配器不自行构造 Scope）。
 */
export function mintScopedRunAssertion(input: {
  readonly scope: PlatformScope;
  readonly run: Omit<RunAssertion, "ownership">;
  readonly encryptionKey: string;
  readonly now?: number;
}): string {
  const { scope, run, encryptionKey, now } = input;
  assertTrustedScope(scope);
  return mintRunAssertion(
    {
      ...run,
      ownership: { tenantId: scope.tenantId, workspaceId: scope.workspaceId },
    },
    encryptionKey,
    now,
  );
}

// ---------------------------------------------------------------------------
// 3. 回调解析（全部适配器共用的唯一入口）
// ---------------------------------------------------------------------------

export type AdapterCallbackVerdict =
  | {
      readonly ok: true;
      readonly botId: string;
      readonly actorId: string;
      readonly initiator?: RunAssertion["initiator"];
      readonly run: RunAssertion;
      /** 解析出的执行归属（signed 断言携带，非请求体回显）。 */
      readonly ownership: {
        readonly tenantId: string;
        readonly workspaceId: string;
      };
    }
  | { readonly ok: false; readonly status: 401 | 403; readonly reason: string };

/**
 * 适配器回调的统一解析。
 *
 * 复用既有 authoriseAgentCall（token 证明哪个 agent 在调、断言证明为哪个
 * Bot/人/run 调、两者互检），再加企业纪律：无归属的断言不是本部署企业
 * 面的回调——拒绝，不以默认身份继续（AC1）。ag_ui（forwardedProps 携
 * 带）、mastra（reserved context 携带）、built_in（legacy token 路径）
 * 的回调都经此入口，解析结果因此跨适配器一致（AC3）。
 */
export async function resolveAgentAdapterCallback(options: {
  /** x-openbot-agent-token 头（或 legacy 部署 token），as presented。 */
  readonly presented: string;
  /** 断言本体（forwardedProps.openbotRun / mastra context / body.run），as presented。 */
  readonly run: unknown;
  readonly encryptionKey: string;
  readonly legacyToken?: string;
  readonly lookup: (hash: string) => Promise<{ id: string } | null>;
  readonly now?: number;
}): Promise<AdapterCallbackVerdict> {
  const verdict = await authoriseAgentCall(options);
  if (!verdict.ok) return verdict;
  if (!verdict.run.ownership) {
    // 与既有拒绝共用同一句文案：不说缺的是哪一半（token 好/断言坏的信息
    // 本身就是猜测面）。
    return { ok: false, status: 401, reason: "Not authorised." };
  }
  return {
    ok: true,
    botId: verdict.botId,
    actorId: verdict.actorId,
    ...(verdict.initiator !== undefined
      ? { initiator: verdict.initiator }
      : {}),
    run: verdict.run,
    ownership: verdict.run.ownership,
  };
}

// ---------------------------------------------------------------------------
// 4. 归属文案（AC4：标识在、秘密不在）
// ---------------------------------------------------------------------------

/**
 * 日志与错误里的归属描述：只含标识（tenant/workspace/bot ± run），从不
 * 含 token、capability、信封原文或密钥。适配器拒绝路径统一用它拼文案。
 */
export function describeAdapterAttribution(attribution: {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly botId?: string;
  readonly runId?: string;
}): string {
  const parts = [
    `tenant ${attribution.tenantId}`,
    `workspace ${attribution.workspaceId}`,
  ];
  if (attribution.botId !== undefined) parts.push(`bot ${attribution.botId}`);
  if (attribution.runId !== undefined) parts.push(`run ${attribution.runId}`);
  return parts.join(" ");
}

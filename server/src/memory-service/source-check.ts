import { sign, verify } from "../auth/signed-value";

/*
 * #730 OpenBot 来源受控记忆接入：在线来源裁决。
 *
 * OpenBot 是来源权威：它签发来源引用（绑定原始公司/团队/Bot/来源范围），并在每次
 * 采集/召回/审核前在线裁决。身份与作用域只来自受信上下文：
 *
 *  - 来源引用是 OpenBot 签名值，签名标签专用；篡改任何字段（本人、公司、团队、
 *    Bot、原始应用、接收应用、操作、版本、来源）都会验签失败 → forged_scope。
 *  - 接收应用必须已登记且 active（unknown_consumer），并且本人对它授权了该动作
 *    （delegation_required：登记与身份本身都不等于委托）。
 *  - 来源访问由 OpenBot 自己的 Access 判定；拒绝 → denied，无法核验 → unavailable
 *    （不区分"失权"与"暂时故障"，不泄漏内容）。浏览器、频道、定时入口走同一
 *    裁决，没有入口专属放宽。
 */

const LABEL = "memory-source";

export type SourceRef = Readonly<{ originAppId: string; scopeRef: string }>;

export type SourceCheck = Readonly<{
  requestId: string;
  subjectId: string;
  originAppId: string;
  consumerAppId: string;
  source: SourceRef;
  versionId: string | null;
  action: "collect" | "recall" | "review";
}>;

export type SourceDecision =
  | { state: "allowed"; revision: string }
  | { state: "denied"; reason: string }
  | { state: "unavailable" };

/** OpenBot 签发的来源范围：来源应用不能自行选择别人的范围。 */
export type IssuedScope = Readonly<{
  originAppId: string;
  subjectId: string;
  botId: string;
  tenantId: string | null;
  sourceId: string;
}>;

export function issueSourceScope(scope: IssuedScope, key: string): SourceRef {
  const payload = JSON.stringify(scope);
  return { originAppId: scope.originAppId, scopeRef: sign(payload, key, LABEL) };
}

/** 验签并还原原始范围；任何篡改返回 null。 */
export function readSourceScope(ref: SourceRef, key: string): IssuedScope | null {
  const payload = verify(ref.scopeRef, key, LABEL);
  if (!payload) return null;
  try {
    const parsed = JSON.parse(payload) as IssuedScope;
    if (
      typeof parsed.originAppId !== "string" ||
      typeof parsed.subjectId !== "string" ||
      typeof parsed.botId !== "string" ||
      typeof parsed.sourceId !== "string" ||
      (parsed.tenantId !== null && typeof parsed.tenantId !== "string")
    ) {
      return null;
    }
    if (parsed.originAppId !== ref.originAppId) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** OpenBot 的 Access：来源是否仍可读、版本是否属于该范围。 */
export type SourceAccess = {
  /** "denied" = 失权；"unavailable" = 无法核验（不区分对外呈现）。 */
  resolve(scope: IssuedScope): Promise<{ state: "allowed"; revision: string } | { state: "denied" } | { state: "unavailable" }>;
  /** versionId 为空表示采集；否则版本必须属于该来源范围。 */
  ownsVersion(scope: IssuedScope, versionId: string): Promise<boolean>;
};

/** 已登记的记忆接收应用与本人对它的动作委托（MEMORY 登记事实的 OpenBot 视图）。 */
export type MemoryConsumerRegistry = {
  isActive(consumerAppId: string): Promise<boolean>;
  delegated(input: {
    subjectId: string;
    consumerAppId: string;
    action: SourceCheck["action"];
  }): Promise<boolean>;
};

export function createOpenBotMemorySourceCheck(deps: {
  key: string;
  consumers: MemoryConsumerRegistry;
  access: SourceAccess;
}) {
  return {
    async checkOpenBotMemorySource(input: SourceCheck): Promise<SourceDecision> {
      const scope = readSourceScope(input.source, deps.key);
      // 篡改或伪造的来源引用：不区分字段，统一拒绝，不返回任何正文。
      if (!scope) return { state: "denied", reason: "forged_scope" };
      if (scope.subjectId !== input.subjectId) return { state: "denied", reason: "forged_scope" };
      if (scope.originAppId !== input.originAppId) return { state: "denied", reason: "forged_scope" };

      if (!(await deps.consumers.isActive(input.consumerAppId))) {
        return { state: "denied", reason: "unknown_consumer" };
      }
      const delegated = await deps.consumers.delegated({
        subjectId: input.subjectId,
        consumerAppId: input.consumerAppId,
        action: input.action,
      });
      if (!delegated) return { state: "denied", reason: "delegation_required" };

      const decision = await deps.access.resolve(scope);
      if (decision.state === "denied") return { state: "denied", reason: "source_revoked" };
      if (decision.state === "unavailable") return { state: "unavailable" };

      if (input.versionId !== null && !(await deps.access.ownsVersion(scope, input.versionId))) {
        return { state: "denied", reason: "forged_scope" };
      }
      return { state: "allowed", revision: decision.revision };
    },
  };
}

export type OpenBotMemorySourceCheck = ReturnType<typeof createOpenBotMemorySourceCheck>;
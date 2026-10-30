// server/src/enterprise/tenancy/global-exceptions.ts
// MT030（Issue #73）：全局端点例外登记表——显式登记，不是默认放行。
//
// 多租户模型里，业务请求要求公司/团队归属上下文；但登录、健康检查、平台
// 静态目录等全局端点按设计在没有公司上下文时就必须可用（设计文档所有权表：
// 「全局身份、会话认证、平台静态公共目录 | 保留全局归属，独立授权，不填虚
// 假租户标识」；R5：「登录、健康检查等全局端点显式列入例外」）。
//
// 本登记表就是那份显式例外清单：
//   - 封闭、逐条带理由（reason）与责任人（ownerTicket）、声明每条还要求的
//     上下文（context）与允许返回的内容边界（contentBoundary）。
//   - matchGlobalException 是运行时匹配器：未登记的路径一律返回 null——
//     调用方（MT128 例外登记闭合）据此要求归属上下文。不存在默认放行。
//   - evaluateGlobalExceptionRegistry 是 readiness 评估器：校验每条登记项
//     形状完整（理由/责任人/内容边界非空），并把登记表与真实装配的入口
//     清单（MT001 CoverageInventory）闭合——平台/身份闭包下任何一个路由
//     入口不被登记覆盖，就是「新增未登记的全局端点」，拒绝启动。
//
// 登记是代码（与装配同版本演进），不是配置文件：新增全局端点而忘记登记，
// 会在多租户模式启动时失败，而不是悄悄变成一个无归属的开放入口。

/** 登记项除公司/团队上下文外仍要求的身份上下文。 */
export type GlobalContextRequirement =
  /** 无任何身份：基础设施探针、认证前投影、公开静态目录。 */
  | "none"
  /** 仅全局会话身份（requireUser）：不涉及公司/团队。 */
  | "session"
  /** 机器身份（桌面宿主令牌 / 本地 bearer），非用户会话。 */
  | "machine";

/** 条件装配面：仅当部署配置了对应表面时才存在（未配置 ≠ 配置错误）。 */
export type GlobalExceptionSurface = "always" | "conditional";

export interface GlobalExceptionEntry {
  /** 稳定 id（登记表主键，启动记录里按此列出）。 */
  readonly id: string;
  /** 允许的 HTTP 方法（大写）。方法也参与匹配：不在名单 = 未登记。 */
  readonly methods: readonly string[];
  /**
   * 路径模式：精确路径，或以 `/*` 结尾的前缀（前缀本身也算命中——
   * `/api/me/*` 同时覆盖 `/api/me` 与 `/api/me/onboarding`）。
   */
  readonly pattern: string;
  /** 前缀排除（app-static 兜底排除 /api，与处理器自己的边界一致）。 */
  readonly excludes?: readonly string[];
  readonly surface: GlobalExceptionSurface;
  readonly context: GlobalContextRequirement;
  /** 为什么这是全局例外（非空）。 */
  readonly reason: string;
  /** 责任人（票号，非空）。 */
  readonly ownerTicket: string;
  /** 该端点允许返回什么；公司私有内容一律禁止（非空）。 */
  readonly contentBoundary: string;
}

/**
 * 全局端点例外登记表（封闭清单）。责任人 MT030 = 登记表本身的维护票；
 * MT128 例外登记闭合消费本表做运行时强制，不得绕过它临时加白名单。
 */
export const GLOBAL_EXCEPTION_ENTRIES: readonly GlobalExceptionEntry[] = [
  {
    id: "health",
    methods: ["GET"],
    pattern: "/health",
    surface: "always",
    context: "none",
    reason:
      "orchestrator liveness probe — must answer before any person signs in, with no session or company context at all",
    ownerTicket: "MT030",
    contentBoundary:
      "process liveness only ({status:'ok'}) — no deployment, company or user data",
  },
  {
    id: "readiness",
    methods: ["GET"],
    pattern: "/ready",
    surface: "always",
    context: "none",
    reason:
      "orchestrator readiness probe — allowed to say no; answers whether the deployment's database is usable, which is deployment state, not company state",
    ownerTicket: "MT030",
    contentBoundary:
      "deployment readiness only ({status, database}) — no company or user data",
  },
  {
    id: "auth",
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    pattern: "/api/auth/*",
    surface: "always",
    context: "session",
    reason:
      "sign-in and session surface (better-auth): a person must be able to sign in before any company membership exists, and session authentication stays global (spec ownership table: 全局身份、会话认证). Admin-only SSO registration routes keep their own in-handler admin gate",
    ownerTicket: "MT030",
    contentBoundary:
      "the signer's own global identity/session and deployment IdP configuration — never company business content",
  },
  {
    id: "capabilities",
    methods: ["GET"],
    pattern: "/api/capabilities",
    surface: "always",
    context: "none",
    reason:
      "pre-auth sign-in screen projection: the browser must know which sign-in providers exist before it can offer sign-in; the handler is an explicit field allowlist of deployment-level flags",
    ownerTicket: "MT030",
    contentBoundary:
      "deployment capability flags only (explicit allowlist) — no per-company or per-user data; company names are not even leaked via ssoConfigured (a count, not a list)",
  },
  {
    id: "web-bot-auth-directory",
    methods: ["GET"],
    pattern: "/.well-known/http-message-signatures-directory",
    surface: "conditional",
    context: "none",
    reason:
      "platform static public directory (Web Bot Auth): external verifiers fetch this well-known path unauthenticated by protocol design; mounted only when OPENBOT_WEB_BOT_AUTH is configured",
    ownerTicket: "MT030",
    contentBoundary:
      "the deployment's public signature-verification key directory — no company or user data",
  },
  {
    id: "app-static",
    methods: ["GET"],
    pattern: "/*",
    excludes: ["/api"],
    surface: "conditional",
    context: "none",
    reason:
      "single-page app static assets and index.html fallback: the built browser app is platform static content (spec: 平台静态公共目录). Mounted only when APP_DIST_DIR is configured; the handler refuses /api paths so unmatched API routes still answer as API, and the same exclusion is encoded here",
    ownerTicket: "MT030",
    contentBoundary:
      "static build output only — every API path is excluded from this entry and stays subject to ownership context",
  },
  {
    id: "me",
    methods: ["GET", "POST"],
    pattern: "/api/me/*",
    surface: "always",
    context: "session",
    reason:
      "global identity projection: the signed-in person's own user row, onboarding state and the deployment's singleUser flag — decided by session identity alone, never by company selection (误加归属 would make the same person a different identity per company)",
    ownerTicket: "MT030",
    contentBoundary:
      "the caller's own global identity row + onboarding + singleUser flag — no company/workspace/membership content",
  },
  {
    id: "settings-preferences",
    methods: ["GET", "PATCH"],
    pattern: "/api/settings/preferences/*",
    surface: "always",
    context: "session",
    reason:
      "per-person preferences read/written for the session actor only (user row jsonb); there is no route to read or write somebody else's, administrator included",
    ownerTicket: "MT030",
    contentBoundary: "the caller's own preferences document — nothing else",
  },
  {
    id: "settings-instructions",
    methods: ["GET", "PUT"],
    pattern: "/api/settings/instructions/*",
    surface: "always",
    context: "session",
    reason:
      "per-person standing instructions, keyed to the session actor id rather than anything in the path or body; a way to set them for another account would put words in their mouth in every channel",
    ownerTicket: "MT030",
    contentBoundary: "the caller's own instructions text — nothing else",
  },
  {
    id: "identity",
    methods: ["GET", "POST", "DELETE"],
    pattern: "/api/identity/*",
    surface: "always",
    context: "session",
    reason:
      "a person's own linked accounts at outside providers and their link challenges; the GitHub callback requires the same session that started the link (login CSRF), so the surface is session-global by design",
    ownerTicket: "MT030",
    contentBoundary:
      "the caller's own identity links/challenges — there is no administrator view and no linking on somebody else's behalf",
  },
  {
    id: "company-auth",
    methods: ["GET", "POST"],
    pattern: "/api/enterprise/company-auth/*",
    surface: "always",
    context: "session",
    reason:
      "company-auth bridge: the challenge is issued to a signed-in member for a company named in the request body, and the OIDC/SAML completion binds to that challenge's own session and company — the protocol callbacks arrive without a fresh session but carry the challenge they complete, so no caller-supplied company selection decides the outcome",
    ownerTicket: "MT030",
    contentBoundary:
      "challenge issuance and the completion redirect (303 to the challenge's site-local returnPath) — refusal bodies carry {error:{code, message}} only, never IdP or company detail",
  },
  {
    id: "desktop-connection-failure",
    methods: ["GET"],
    pattern: "/api/desktop/connection-failure",
    surface: "conditional",
    context: "machine",
    reason:
      "native host session-signal for the desktop app, gated by the desktop host bearer token (machine identity, not a user session, and deliberately not company-scoped); mounted only when OPENBOT_DESKTOP_HOST_TOKEN is configured",
    ownerTicket: "MT030",
    contentBoundary:
      "the last connection-failure signal of this server process — never provider messages or credentials",
  },
  {
    id: "provider-oauth-proxy",
    methods: ["POST"],
    pattern: "/api/model-provider/v1/chat/completions",
    surface: "conditional",
    context: "machine",
    reason:
      "desktop model provider proxy: one host-server instance owns the provider sign-in, and its refresh lock is keyed by the credential record's global session id (never by caller scope — a multi-company user shares one sign-in); mounted only when OPENBOT_MODEL_OAUTH_FILE is configured",
    ownerTicket: "MT030",
    contentBoundary:
      "relayed model provider stream for the local bearer holder — credential material never leaves the store, and a browser cookie never authorizes it",
  },
  {
    id: "host-access-desktop",
    methods: ["GET", "POST"],
    pattern: "/api/host-access/desktop/*",
    surface: "conditional",
    context: "machine",
    reason:
      "desktop host-access work broker: grants are session-only for this server process and the native worker authenticates with a fresh per-run token; mounted only when the host-access broker and desktop token are configured",
    ownerTicket: "MT030",
    contentBoundary:
      "host access work items issued for this run — no company directory or business content",
  },
];

/**
 * 运行时匹配器：请求落在哪条登记项上；null = 未登记 = 要求归属上下文。
 *
 * 特异性：命中多条时取「字面前缀最长」的登记项（`/health` 胜过 `/*`），
 * 使静态兜底永远不遮蔽具体登记项。方法必须命中登记项的 methods 名单。
 */
export function matchGlobalException(
  method: string,
  path: string,
): GlobalExceptionEntry | null {
  const upper = method.toUpperCase();
  let best: GlobalExceptionEntry | null = null;
  let bestSpecificity = -1;
  for (const entry of GLOBAL_EXCEPTION_ENTRIES) {
    if (!entry.methods.includes(upper)) continue;
    if (!patternMatches(entry, path)) continue;
    // 特异性 = 模式的字面前缀长度（去掉 `/*` 通配）；精确路径就是全名。
    const specificity = entry.pattern.endsWith("/*")
      ? entry.pattern.length - 2
      : entry.pattern.length;
    if (specificity > bestSpecificity) {
      best = entry;
      bestSpecificity = specificity;
    }
  }
  return best;
}

function patternMatches(entry: GlobalExceptionEntry, path: string): boolean {
  if (entry.excludes?.some((prefix) => excluded(path, prefix))) return false;
  if (!entry.pattern.endsWith("/*")) return path === entry.pattern;
  const prefix = entry.pattern.slice(0, -2);
  // 根兜底（"/*"）匹配一切未被排除的绝对路径。
  if (prefix === "/") return path.startsWith("/");
  return path === prefix || path.startsWith(`${prefix}/`);
}

function excluded(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/** 评估器消费的入口最小结构面（MT001 CoverageInventory.entrances 的子集）。 */
export interface GlobalExceptionEntrance {
  readonly method: string;
  readonly path: string;
  readonly kind: string;
  readonly businessClosure: string;
}

export type GlobalExceptionFindingCode =
  | "ENTRY_INVALID"
  | "UNREGISTERED_GLOBAL";

export interface GlobalExceptionFinding {
  readonly code: GlobalExceptionFindingCode;
  /** 结构化理由：绝不夹带凭据或私有内容，只含入口名/字段名。 */
  readonly detail: string;
}

export interface GlobalExceptionEvaluation {
  readonly ok: boolean;
  readonly reason?: string;
  /** 通过形状校验的登记项 id（全部通过 = 全部登记 id）。 */
  readonly registered: readonly string[];
  readonly findings: readonly GlobalExceptionFinding[];
}

/**
 * readiness 评估器（纯函数）：
 *   a. 每条登记项形状完整——id/方法/模式/理由/责任人/内容边界，任何一项
 *      缺失都是 ENTRY_INVALID（AC3 前半：例外项都有理由与责任人）。
 *   b. 与真实装配闭合——平台/身份闭包下每个路由入口必须被某条登记项覆盖；
 *      未覆盖 = 新增未登记的全局端点，UNREGISTERED_GLOBAL（AC3 后半：
 *      新增未登记的全局端点会导致启动失败）。中间件行（catchall）不是
 *      端点，不在本检查范围；其余闭包（业务/内部/机器面）按各自的
 *      归属检查走，不在本例外登记的范围里。
 *
 * 拒绝列全缺口（与 MT013 三项校验同纪律），不做发现第一个就停。
 */
export function evaluateGlobalExceptionRegistry({
  entries,
  entrances,
}: {
  entries: readonly GlobalExceptionEntry[];
  entrances: readonly GlobalExceptionEntrance[];
}): GlobalExceptionEvaluation {
  const findings: GlobalExceptionFinding[] = [];
  const registered: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const invalid = entryInvalidReason(entry);
    if (invalid) {
      findings.push({
        code: "ENTRY_INVALID",
        detail: `global exception entry "${entry.id || "<unnamed>"}": ${invalid}`,
      });
      continue;
    }
    if (seen.has(entry.id)) {
      findings.push({
        code: "ENTRY_INVALID",
        detail: `global exception entry "${entry.id}": duplicate id`,
      });
      continue;
    }
    seen.add(entry.id);
    registered.push(entry.id);
  }

  // 全局端点闭包：平台面与身份/会话面（设计文档所有权表里「保留全局归属」
  // 的两个闭包）。这些闭包里的路由入口必须被登记表覆盖。
  const GLOBAL_CLOSURES = new Set(["platform", "identity"]);
  for (const entrance of entrances) {
    if (entrance.kind !== "route") continue;
    if (!GLOBAL_CLOSURES.has(entrance.businessClosure)) continue;
    const covered = entries.some(
      (entry) =>
        registered.includes(entry.id) &&
        entry.methods.includes(entrance.method.toUpperCase()) &&
        patternMatches(entry, entrance.path),
    );
    if (!covered) {
      findings.push({
        code: "UNREGISTERED_GLOBAL",
        detail: `${entrance.method} ${entrance.path} (${entrance.businessClosure}) is a global-surface entrance but is not registered in the global exception registry — unregistered endpoints require ownership context, so this fails startup`,
      });
    }
  }

  const reason =
    findings.length > 0
      ? `global exception registry validation failed (${findings.length} finding${findings.length === 1 ? "" : "s"})`
      : undefined;
  return {
    ok: findings.length === 0,
    reason,
    registered,
    findings,
  };
}

function entryInvalidReason(entry: GlobalExceptionEntry): string | null {
  if (typeof entry.id !== "string" || entry.id.trim().length === 0)
    return "id is empty";
  if (
    !Array.isArray(entry.methods) ||
    entry.methods.length === 0 ||
    entry.methods.some((method) => typeof method !== "string" || !method)
  )
    return "methods must be a non-empty list";
  if (typeof entry.pattern !== "string" || !entry.pattern.startsWith("/"))
    return "pattern must start with /";
  if (typeof entry.reason !== "string" || entry.reason.trim().length === 0)
    return "reason is empty — every exception must state why it is global";
  if (
    typeof entry.ownerTicket !== "string" ||
    entry.ownerTicket.trim().length === 0
  )
    return "ownerTicket is empty — every exception must name its responsible ticket";
  if (
    typeof entry.contentBoundary !== "string" ||
    entry.contentBoundary.trim().length === 0
  )
    return "contentBoundary is empty — every exception must state what it may return";
  if (!["none", "session", "machine"].includes(entry.context))
    return `context must be none|session|machine, got "${String(entry.context)}"`;
  if (!["always", "conditional"].includes(entry.surface))
    return `surface must be always|conditional, got "${String(entry.surface)}"`;
  return null;
}

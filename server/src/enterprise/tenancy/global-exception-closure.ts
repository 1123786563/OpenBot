// server/src/enterprise/tenancy/global-exception-closure.ts
// MT127（Issue #170）：全局登录、健康检查与平台静态目录例外登记闭合。
//
// 前置事实：MT030（Issue #73）交付了例外登记表本体——GLOBAL_EXCEPTION_ENTRIES
// 封闭清单（每条带 reason / ownerTicket / contentBoundary）、运行时匹配器
// matchGlobalException（未登记一律 null = 要求归属上下文）与 readiness 评估器
// evaluateGlobalExceptionRegistry（形状校验 + 与真实装配的平台/身份闭包互相
// 闭合）。MT122 中间件消费匹配器：登记项放行、显式选择建立上下文、
// 其余依赖 MT001 清单全局闸。
//
// 本票闭合三件（在 MT030 之上，不改其登记形状）：
//
//   1. 验证方式逐条在册（AC1 后半）：GLOBAL_EXCEPTION_VERIFICATIONS——每条
//      登记项恰好一行 {entryId, method, evidenceFiles, pin}：method 是人/CI
//      执行的验证命令；evidenceFiles 是钉住该边界的测试文件（启动时核存在，
//      登记与验证不许漂移）；pin 是验证钉住的内容边界声明。行集合与登记表
//      互相闭合：缺行（VERIFICATION_MISSING）、幽灵行（VERIFICATION_GHOST，
//      引用不存在的登记项）、空 method/pin/evidenceFiles（VERIFICATION_INVALID）、
//      证据文件不可解析（VERIFICATION_EVIDENCE_MISSING）都是启动缺口。
//   2. 运行时反向（AC2）：未登记端点访问业务数据被拒绝。结构已由 MT122 中间件
//      + requireEntryBusiness 缝合保证——登记项（全局端点）结构上永远拿不到
//      entryBusiness（匹配器放行先于选择头判定）；未登记端点无选择头时中间件
//      放行但**不建立**上下文，业务读取经 requireEntryBusiness 即
//      ENTRY_CONTEXT_REQUIRED。本模块不新增运行时路径；closure 测试以真实
//      中间件 + 真实缝合钉死三个方向（未登记无头拒绝 / 未登记显式选择建立 /
//      登记项永不建立）。
//   3. readiness 消费（AC4）：evaluateGlobalExceptionClosure = MT030 评估器
//      （形状 + 闭包）+ 验证闭合；startup-checks 的 globalExceptions 检查改吃
//      本评估器——例外登记不完整（含验证缺失）时启动失败，缺口一次列全。
//
// 边界（票面 Scope boundary）：机器回调与个人直连路径不在本表（MT128，
// Issue #171 的独立例外登记）；本模块只闭「全局」例外。

import {
  evaluateGlobalExceptionRegistry,
  GLOBAL_EXCEPTION_ENTRIES,
  type GlobalExceptionEntrance,
  type GlobalExceptionEntry,
  type GlobalExceptionFinding,
} from "./global-exceptions";

/** 一条登记项的验证方式（AC1：每项有理由、责任人与验证方式）。 */
export interface GlobalExceptionVerification {
  /** 对应的登记项 id（登记表主键；登记与验证互相闭合）。 */
  readonly entryId: string;
  /** 人/CI 执行的验证命令（非空）。 */
  readonly method: string;
  /** 钉住该边界的测试文件（非空清单；启动时核存在）。 */
  readonly evidenceFiles: readonly string[];
  /** 验证钉住什么（非空）：内容边界声明的一句话重述。 */
  readonly pin: string;
}

/**
 * 验证方式登记（封闭清单）：与 GLOBAL_EXCEPTION_ENTRIES 逐 id 对齐。
 * evidenceFiles 里 global-exceptions.test.ts 是 MT030 的原始钉子，
 * global-exception-closure.test.ts 是本票的闭合钉子（反向 + 内容边界补全）。
 */
export const GLOBAL_EXCEPTION_VERIFICATIONS: readonly GlobalExceptionVerification[] =
  Object.freeze([
    {
      entryId: "health",
      method: "bun test server/tests/multitenancy/global-exceptions.test.ts",
      evidenceFiles: ["server/tests/multitenancy/global-exceptions.test.ts"],
      pin: "/health answers process liveness only ({status:'ok'}) — no deployment, company or user data",
    },
    {
      entryId: "readiness",
      method: "bun test server/tests/multitenancy/global-exceptions.test.ts",
      evidenceFiles: ["server/tests/multitenancy/global-exceptions.test.ts"],
      pin: "/ready answers deployment readiness only ({status, database}) — no company or user data",
    },
    {
      entryId: "auth",
      method: "bun test server/tests/multitenancy/global-exceptions.test.ts",
      evidenceFiles: ["server/tests/multitenancy/global-exceptions.test.ts"],
      pin: "the auth surface answers the signer's own session/identity and deployment IdP config — never company business content; admin-only SSO registration keeps its in-handler admin gate",
    },
    {
      entryId: "capabilities",
      method: "bun test server/tests/multitenancy/global-exceptions.test.ts",
      evidenceFiles: ["server/tests/multitenancy/global-exceptions.test.ts"],
      pin: "/api/capabilities answers deployment capability flags from an explicit allowlist; serialized body carries no tenant/workspace/company/membership field",
    },
    {
      entryId: "web-bot-auth-directory",
      method:
        "bun test server/tests/multitenancy/global-exception-closure.test.ts",
      evidenceFiles: [
        "server/tests/multitenancy/global-exception-closure.test.ts",
      ],
      pin: "the well-known directory serves the deployment's public signature-verification keys only — registered as a conditional surface, absent when OPENBOT_WEB_BOT_AUTH is unset",
    },
    {
      entryId: "app-static",
      method:
        "bun test server/tests/multitenancy/global-exceptions.test.ts server/tests/multitenancy/global-exception-closure.test.ts",
      evidenceFiles: [
        "server/tests/multitenancy/global-exceptions.test.ts",
        "server/tests/multitenancy/global-exception-closure.test.ts",
      ],
      pin: "the static fallback serves build output only; /api is excluded from the entry so unmatched API paths keep requiring ownership context (closure re-pins the exclusion)",
    },
    {
      entryId: "me",
      method: "bun test server/tests/multitenancy/global-exceptions.test.ts",
      evidenceFiles: ["server/tests/multitenancy/global-exceptions.test.ts"],
      pin: "/api/me answers the caller's own global identity row + onboarding + singleUser; serialized body carries no tenant/workspace/membership field",
    },
    {
      entryId: "settings-preferences",
      method:
        "bun test server/tests/multitenancy/global-exception-closure.test.ts",
      evidenceFiles: [
        "server/tests/multitenancy/global-exception-closure.test.ts",
      ],
      pin: "preferences read/patch touch the session actor's own user row only — no route exists for anybody else's, administrator included",
    },
    {
      entryId: "settings-instructions",
      method:
        "bun test server/tests/multitenancy/global-exception-closure.test.ts",
      evidenceFiles: [
        "server/tests/multitenancy/global-exception-closure.test.ts",
      ],
      pin: "standing instructions read/write key to the session actor id, never to a path or body field; the surface answers the caller's own text only",
    },
    {
      entryId: "identity",
      method:
        "bun test server/tests/multitenancy/global-exception-closure.test.ts",
      evidenceFiles: [
        "server/tests/multitenancy/global-exception-closure.test.ts",
      ],
      pin: "linked accounts and link challenges answer for the session's own actor only; anonymous callers get a bare 401 error shape with no existence leak",
    },
    {
      entryId: "company-auth",
      method:
        "bun test server/tests/multitenancy/global-exception-closure.test.ts",
      evidenceFiles: [
        "server/tests/multitenancy/global-exception-closure.test.ts",
        "server/tests/better-auth/company-auth-challenge.test.ts",
        "server/tests/better-auth/company-auth-oidc.test.ts",
        "server/tests/better-auth/company-auth-saml.test.ts",
      ],
      pin: "the challenge is issued for the session caller and the company it names, and each IdP completion (OIDC callback, SAML ACS) binds to its own challenge and the session it was issued to — never to a caller-supplied company selection",
    },
    {
      entryId: "desktop-connection-failure",
      method:
        "bun test server/tests/multitenancy/global-exception-closure.test.ts",
      evidenceFiles: [
        "server/tests/multitenancy/global-exception-closure.test.ts",
      ],
      pin: "the connection-failure signal answers this server process's last desktop connection failure — registered machine context, conditional surface, no provider messages or credentials",
    },
    {
      entryId: "provider-oauth-proxy",
      method: "bun test server/tests/multitenancy/global-exceptions.test.ts",
      evidenceFiles: ["server/tests/multitenancy/global-exceptions.test.ts"],
      pin: "the desktop model proxy relays a provider stream for the local bearer holder; its refresh lock stays keyed by the credential record's global session id — never by caller scope",
    },
    {
      entryId: "host-access-desktop",
      method:
        "bun test server/tests/multitenancy/global-exception-closure.test.ts",
      evidenceFiles: [
        "server/tests/multitenancy/global-exception-closure.test.ts",
      ],
      pin: "host-access work items answer for this run's broker grants only — machine context, conditional surface, no company directory or business content",
    },
  ] satisfies readonly GlobalExceptionVerification[]);

/** 闭合层 finding 码：MT030 两码 + 验证闭合四码（字符串码，机器可读）。 */
export type GlobalExceptionClosureFindingCode =
  | GlobalExceptionFinding["code"]
  | "VERIFICATION_MISSING"
  | "VERIFICATION_GHOST"
  | "VERIFICATION_INVALID"
  | "VERIFICATION_EVIDENCE_MISSING";

/** 闭合层 finding（结构同 MT030：码 + 结构化理由，绝不夹带私有内容）。 */
export interface GlobalExceptionClosureFinding {
  readonly code: GlobalExceptionClosureFindingCode;
  readonly detail: string;
}

export interface GlobalExceptionClosureEvaluation {
  readonly ok: boolean;
  readonly reason?: string;
  /** 通过形状校验的登记项 id（MT030 同款）。 */
  readonly registered: readonly string[];
  /** 验证闭合通过的登记项 id（登记与验证都成立）。 */
  readonly verified: readonly string[];
  readonly findings: readonly GlobalExceptionClosureFinding[];
}

/** 一行验证的形状判定（缺 method/pin/evidenceFiles 即无效）。 */
function verificationInvalidReason(
  row: GlobalExceptionVerification,
): string | null {
  if (typeof row.entryId !== "string" || row.entryId.trim().length === 0)
    return "entryId is empty";
  if (typeof row.method !== "string" || row.method.trim().length === 0)
    return "method is empty — every exception must name how its boundary is verified";
  if (typeof row.pin !== "string" || row.pin.trim().length === 0)
    return "pin is empty — every verification must state what it pins";
  if (
    !Array.isArray(row.evidenceFiles) ||
    row.evidenceFiles.length === 0 ||
    row.evidenceFiles.some(
      (file) => typeof file !== "string" || file.trim().length === 0,
    )
  )
    return "evidenceFiles must be a non-empty list of test file paths";
  return null;
}

/**
 * 例外登记闭合评估器（AC1 + AC4 的判定半边，纯函数）：
 *
 *   a. MT030 的形状 + 平台/身份闭包评估原样并入（findings 合并）；
 *   b. 登记与验证互相闭合——每条登记项恰好一行验证（缺行/幽灵行都拒绝）；
 *   c. 每行验证形状完整；
 *   d. evidenceFiles 逐个经 evidenceExists 谓词核存在（默认不核——纯函数
 *      半边无 IO；startup-checks 接线传真实 fs 谓词，测试注入假谓词）。
 *
 * 缺口一次列全（MT013 同纪律），不做发现第一个就停。
 */
export function evaluateGlobalExceptionClosure({
  entries,
  verifications,
  entrances,
  evidenceExists,
}: {
  readonly entries: readonly GlobalExceptionEntry[];
  readonly verifications: readonly GlobalExceptionVerification[];
  readonly entrances: readonly GlobalExceptionEntrance[];
  /** 证据文件存在性谓词（绝对/仓库相对路径 → 是否存在）。 */
  readonly evidenceExists?: (file: string) => boolean;
}): GlobalExceptionClosureEvaluation {
  const base = evaluateGlobalExceptionRegistry({ entries, entrances });
  const findings: GlobalExceptionClosureFinding[] = [...base.findings];

  // b+c. 登记 ↔ 验证互相闭合（先形状，后差集，重复行同码点名）。
  const validVerifications = new Map<string, GlobalExceptionVerification>();
  const duplicates = new Set<string>();
  for (const row of verifications) {
    const invalid = verificationInvalidReason(row);
    if (invalid) {
      findings.push({
        code: "VERIFICATION_INVALID",
        detail: `verification for "${row.entryId || "<unnamed>"}": ${invalid}`,
      });
      continue;
    }
    if (validVerifications.has(row.entryId)) duplicates.add(row.entryId);
    validVerifications.set(row.entryId, row);
  }
  for (const entryId of duplicates) {
    findings.push({
      code: "VERIFICATION_INVALID",
      detail: `verification for "${entryId}": duplicate rows — exactly one verification per registered entry`,
    });
  }
  for (const entry of entries) {
    if (!validVerifications.has(entry.id)) {
      findings.push({
        code: "VERIFICATION_MISSING",
        detail: `global exception entry "${entry.id}" has no verification row — every exception must name how its boundary is verified`,
      });
    }
  }
  for (const entryId of validVerifications.keys()) {
    if (!entries.some((entry) => entry.id === entryId)) {
      findings.push({
        code: "VERIFICATION_GHOST",
        detail: `verification row "${entryId}" names no registered global exception entry — the verification registry has drifted from the exception registry`,
      });
    }
  }

  // d. 证据文件可解析（谓词在场才核；谓词缺席不是通过，是不核——
  //    接线层（startup-checks）永远传真实谓词，缺席只发生在纯函数单测）。
  if (evidenceExists) {
    for (const [entryId, row] of validVerifications) {
      for (const file of row.evidenceFiles) {
        if (!evidenceExists(file)) {
          findings.push({
            code: "VERIFICATION_EVIDENCE_MISSING",
            detail: `verification for "${entryId}" names evidence file ${file}, which does not exist — registration and verification must not drift`,
          });
        }
      }
    }
  }

  const verified = [...validVerifications.keys()].filter((entryId) =>
    entries.some((entry) => entry.id === entryId),
  );
  const ok = findings.length === 0;
  return {
    ok,
    reason: ok
      ? undefined
      : `global exception closure validation failed (${findings.length} finding${findings.length === 1 ? "" : "s"})`,
    registered: base.registered,
    verified,
    findings,
  };
}

/** 默认输入（登记表 + 验证表 + 真实谓词由调用方提供）。 */
export function evaluateDefaultGlobalExceptionClosure({
  entrances,
  evidenceExists,
}: {
  readonly entrances: readonly GlobalExceptionEntrance[];
  readonly evidenceExists?: (file: string) => boolean;
}): GlobalExceptionClosureEvaluation {
  return evaluateGlobalExceptionClosure({
    entries: GLOBAL_EXCEPTION_ENTRIES,
    verifications: GLOBAL_EXCEPTION_VERIFICATIONS,
    entrances,
    evidenceExists,
  });
}

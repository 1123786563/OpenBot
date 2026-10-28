// server/src/enterprise/tenancy/machine-personal-exceptions.ts
// MT128（Issue #171）：机器回调与个人 Bifrost 直连路径例外登记闭合。
//
// 票面语义：两类入口作为**独立**例外登记——回调例外只覆盖回调本身；
// 个人直连路径与公司路径的账户解析互不影响；付款账户路由与 Spec §7.1
// 一致；登记表变更触发就绪校验重新评估。
//
// 前置事实（全部已交付，本票只登记与闭合，不改其行为）：
//   - 机器回调门（无会话，签名/渠道凭据即全部授权）：
//     · POST /api/billing/webhooks/lago —— provider 计费投递（billing/routes.ts，
//       「caller is the provider, whose whole credential is the signature」）；
//     · POST /api/payments/callbacks/:provider —— 支付渠道回调
//       （payments/routes.ts，适配器对原始字节验签）。
//     回调结算的资金归属从**已记录订单**解析（payments/service.ts：
//     recipientKey = payerKey(order.ownerPayerRef)，投递字节里没有任何
//     服务会读的账户字段；无主订单扣发 unowned_payout，绝不猜）。
//   - 个人 Bifrost 直连路径（个人模型授权 → 个人余额）：
//     · /api/bot-service/* —— Bot 服务面（服务凭据认证；05.3 虚拟 Key
//       认领面在内；Key 签发 provisionCustomer({kind:"personal",
//       id: grant.userId})——按授权绑定的用户，与任何公司选择无关）；
//     · /api/model-access/* —— 会话用户自己的两步授权面（授权的来源）。
//     个人分支的越权防线已存在（payer-personal.ts：请求携带任何账户身份
//     字段即 PayerCrossAccountAccessError——伪造的账户字段不是输入）。
//
// 本票结构（与 MT030/MT125 同款登记纪律）：
//
//   1. 两族独立登记表（MACHINE_CALLBACK_EXCEPTIONS /
//      PERSONAL_DIRECT_EXCEPTIONS）：逐门带理由、责任人（MT128）、内容
//      边界与 §7.1 付款账户声明；两族模式互不重叠（AC2 前半），回调例外
//      只覆盖回调本身（AC1 前半——登记是门，不是前缀白名单）。
//   2. 运行时匹配器 matchMachineCallbackException /
//      matchPersonalDirectException：未登记一律 null。匹配器只回答「这是
//      否本族登记门」——不授予任何业务读取；回调门自己的验签拒绝（403
//      wrong signature 等）是入口行为，不在此重演。
//   3. §7.1 付款账户路由判定 routePayerAccountFor（AC3 的判定半边，纯
//      函数）：调用来源闭集 → 固定 PayerRef 推导；客户端字段经
//      assertNoForeignAccountIdentity 一律拒绝（body/header 不能指定账户）。
//   4. readiness 评估器 evaluateMachinePersonalExceptionRegistry（AC4）：
//      形状校验 + 完备方向闭包（两族门下的真实装配入口逐个被本族登记覆
//      盖；门下新入口未登记即缺口）+ 两族互斥（同一入口不得两族都登记）。
//      startup-checks 的 machinePersonalExceptions 检查消费本评估器——登记
//      表是代码（与装配同版本演进），登记变更即就绪重评。
//
// 边界（诚实披露）：投递通道 webhook 门（/api/delivery/webhooks）也是
// 无会话机器调用，但其归属是投递族自己的范围化票（非付款回调），不在
// 本票闭集；桌面模型代理（/api/model-provider/v1/chat/completions）已由
// MT030 全局登记（machine 上下文），本表不重复登记。

import { type PayerRef, payerKey } from "../../billing/payer";
import {
  findForeignAccountIdentity,
  PayerCrossAccountAccessError,
} from "../../billing/payer-personal";

/** 门装配面：always（恒在）| conditional（配置了对应表面才存在）。 */
export type MachinePersonalSurface = "always" | "conditional";

/** 登记项上下文：machine（机器凭据）| session（会话用户自己）。 */
export type MachinePersonalContext = "machine" | "session";

/** 两族共享的登记项形状（字段语义与 MT030 同款，另加 §7.1 账户声明）。 */
export interface MachinePersonalExceptionEntry {
  /** 稳定 id（就绪记录按此列出）。 */
  readonly id: string;
  /** 允许的 HTTP 方法（大写；ALL = 任意）。 */
  readonly methods: readonly string[];
  /**
   * 路径模式：`:param` 段通配单段（与路由表同形），`/*` 结尾匹配前缀
   * 下全部剩余段（前缀本身也算命中）。
   */
  readonly pattern: string;
  readonly surface: MachinePersonalSurface;
  readonly context: MachinePersonalContext;
  /** 为什么这是本族例外（非空）。 */
  readonly reason: string;
  /** 责任人（非空；本表两族均为 MT128）。 */
  readonly ownerTicket: string;
  /** 该门允许返回/触碰的内容边界（非空）。 */
  readonly contentBoundary: string;
  /** §7.1 付款账户声明：该门的付款账户由什么固定（非空）。 */
  readonly paymentAccount: string;
}

/**
 * 机器回调例外登记（封闭清单，两门）。「例外只覆盖回调本身」：登记的
 * pattern 是门（方法+路径），不是前缀放行——门下新增入口会被就绪校验
 * 拒绝（见 evaluateMachinePersonalExceptionRegistry 的完备方向闭包）。
 */
export const MACHINE_CALLBACK_EXCEPTIONS: readonly MachinePersonalExceptionEntry[] =
  Object.freeze([
    {
      id: "billing-provider-webhook",
      methods: ["POST"],
      pattern: "/api/billing/webhooks/*",
      surface: "conditional",
      context: "machine",
      reason:
        "the billing provider's delivery: no session by design — the signature over the raw bytes is the provider's whole credential, verified by the service against exactly-once-capped reads",
      ownerTicket: "MT128",
      contentBoundary:
        "callback settlement facts only (acknowledge/refuse the delivery) — no business read: the handler resolves the order from its own records and never answers with company content",
      paymentAccount:
        "resolved from the recorded order's own owner (payerKey(order.ownerPayerRef)); the delivery's bytes carry no account field the service reads",
    },
    {
      id: "payment-channel-callback",
      methods: ["POST"],
      pattern: "/api/payments/callbacks/*",
      surface: "conditional",
      context: "machine",
      reason:
        "the payment channel's delivery (alipay/wechat): no session by design — the channel adapter verifies the signature/decryption of the raw delivery; a probe or mistyped channel name answers plain 404",
      ownerTicket: "MT128",
      contentBoundary:
        "channel settlement facts only (per-channel wire acknowledgement) — no business read: unknown orders answer 404 and nothing else",
      paymentAccount:
        "resolved from the recorded order's own owner (payerKey(order.ownerPayerRef)); a verified fact about an unknown order settles nothing and a plan payout for an unowned order is withheld (unowned_payout), never guessed",
    },
  ] satisfies readonly MachinePersonalExceptionEntry[]);

/**
 * 个人 Bifrost 直连路径例外登记（封闭清单，两门）。「与公司路径账户解析
 * 互不干扰」的半边在登记里：两门的 paymentAccount 都声明按授权绑定的
 * 用户固定，公司选择不是输入。
 */
export const PERSONAL_DIRECT_EXCEPTIONS: readonly MachinePersonalExceptionEntry[] =
  Object.freeze([
    {
      id: "bot-service-door",
      methods: ["ALL"],
      pattern: "/api/bot-service/*",
      surface: "conditional",
      context: "machine",
      reason:
        "the Bot-facing service door: an authenticated Bot service identity (its own credential) — the single door a Bot presents an authorization at; short-lived virtual keys are claimed here and issued for the grant's bound user only",
      ownerTicket: "MT128",
      contentBoundary:
        "this Bot service's own identity, binding codes and the grants/keys of its authorizations — no company directory or business content; an unregistered bot is refused without existing-bot disclosure",
      paymentAccount:
        "the authorization's bound OpenBot user (provisionCustomer({kind:'personal', id: grant.userId})) — tenant/workspace selection is not an input to issuance",
    },
    {
      id: "model-access-door",
      methods: ["ALL"],
      pattern: "/api/model-access/*",
      surface: "conditional",
      context: "session",
      reason:
        "a signed-in person's own two-step model authorization surface: the origin of personal direct-path grants — preview what a binding code names, then confirm it into a grant for the session's own actor",
      ownerTicket: "MT128",
      contentBoundary:
        "the caller's own grants and binding previews — nothing on this mount takes a user or identity from a request (AC03 of the surface's own ticket)",
      paymentAccount:
        "no payment happens here; every grant this surface confirms bills the grant's own user as personal when a key is later issued",
    },
  ] satisfies readonly MachinePersonalExceptionEntry[]);

// ---------------------------------------------------------------------------
// 匹配器（运行时：「是否本族登记门」；null = 不在册）
// ---------------------------------------------------------------------------

function segmentMatches(pattern: string[], path: string[]): boolean {
  let index = 0;
  for (; index < pattern.length; index += 1) {
    const segment = pattern[index];
    if (segment === "*") {
      // 前缀通配：吞掉全部剩余段（含零段——前缀本身也算命中）。
      return true;
    }
    if (index >= path.length) return false;
    if (!segment.startsWith(":") && segment !== path[index]) return false;
  }
  return index === path.length;
}

function entryMatches(
  entry: Pick<MachinePersonalExceptionEntry, "methods" | "pattern">,
  method: string,
  path: string,
): boolean {
  const upper = method.toUpperCase();
  if (
    !entry.methods.includes("ALL") &&
    !entry.methods.some((allowed) => allowed.toUpperCase() === upper)
  ) {
    return false;
  }
  const patternSegments = entry.pattern.split("/").filter(Boolean);
  const pathSegments = path.split("/").filter(Boolean);
  return segmentMatches(patternSegments, pathSegments);
}

/** 机器回调门匹配：命中登记项或 null（未登记 = 不是本族门）。 */
export function matchMachineCallbackException(
  method: string,
  path: string,
): MachinePersonalExceptionEntry | null {
  return (
    MACHINE_CALLBACK_EXCEPTIONS.find((entry) =>
      entryMatches(entry, method, path),
    ) ?? null
  );
}

/** 个人直连门匹配：命中登记项或 null（未登记 = 不是本族门）。 */
export function matchPersonalDirectException(
  method: string,
  path: string,
): MachinePersonalExceptionEntry | null {
  return (
    PERSONAL_DIRECT_EXCEPTIONS.find((entry) =>
      entryMatches(entry, method, path),
    ) ?? null
  );
}

// ---------------------------------------------------------------------------
// §7.1 付款账户路由（AC3 判定半边：来源闭集 → 固定推导，无跨类回退）
// ---------------------------------------------------------------------------

/** 调用来源闭集：三个来源各自的付款账户推导互不相同且不回退。 */
export type MachinePersonalCallSource =
  | {
      /** 机器回调：资金归属只从已记录订单解析。 */
      readonly kind: "machine-callback";
      readonly order: { readonly ownerPayerRef: PayerRef | null };
    }
  | {
      /** 个人直连：授权绑定的用户。 */
      readonly kind: "personal-direct";
      readonly grant: { readonly userId: string };
    }
  | {
      /** 公司工作台：作用域的公司（MT122 entry business 的 scope）。 */
      readonly kind: "company-workbench";
      readonly scope: { readonly tenantId: string };
    };

/** 无主订单的确定性拒绝（与 service.ts 的 unowned_payout 语义同源）。 */
export const PAYER_ROUTE_UNOWNED = "PAYER_ROUTE_UNOWNED";
/** 来源闭集之外的一切（未知 kind 响亮拒绝，不猜）。 */
export const PAYER_ROUTE_SOURCE_INVALID = "PAYER_ROUTE_SOURCE_INVALID";

export type PayerRouteOutcome =
  | { readonly ok: true; readonly ref: PayerRef; readonly key: string }
  | {
      readonly ok: false;
      readonly code:
        | typeof PAYER_ROUTE_UNOWNED
        | typeof PAYER_ROUTE_SOURCE_INVALID;
    };

/**
 * §7.1 路由表（纯函数）：
 *   机器回调        → payerKey(order.ownerPayerRef)；订单无主 → UNOWNED
 *                     （扣发待归属，绝不猜一个账户）；
 *   个人直连        → personal:<grant.userId>（公司选择不是输入）；
 *   公司工作台      → company:<scope.tenantId>（多公司切换不改付款方）。
 * 三个来源各自推导，互不回退、互不借用（余额不足拒绝对应调用，不自动
 * 消费另一类余额——由各调用面自己的准入执行，本函数只固定路由事实）。
 */
export function routePayerAccountFor(
  source: MachinePersonalCallSource,
): PayerRouteOutcome {
  switch (source.kind) {
    case "machine-callback": {
      if (!source.order?.ownerPayerRef) {
        return { ok: false, code: PAYER_ROUTE_UNOWNED };
      }
      try {
        return {
          ok: true,
          ref: source.order.ownerPayerRef,
          key: payerKey(source.order.ownerPayerRef),
        };
      } catch {
        // quarantined kind（unknown_owner）或畸形 ref：无主，同码拒绝。
        return { ok: false, code: PAYER_ROUTE_UNOWNED };
      }
    }
    case "personal-direct": {
      if (
        typeof source.grant?.userId !== "string" ||
        source.grant.userId.length === 0
      ) {
        return { ok: false, code: PAYER_ROUTE_SOURCE_INVALID };
      }
      const ref: PayerRef = { kind: "personal", id: source.grant.userId };
      return { ok: true, ref, key: payerKey(ref) };
    }
    case "company-workbench": {
      if (
        typeof source.scope?.tenantId !== "string" ||
        source.scope.tenantId.length === 0
      ) {
        return { ok: false, code: PAYER_ROUTE_SOURCE_INVALID };
      }
      const ref: PayerRef = { kind: "company", id: source.scope.tenantId };
      return { ok: true, ref, key: payerKey(ref) };
    }
    default:
      return { ok: false, code: PAYER_ROUTE_SOURCE_INVALID };
  }
}

/**
 * 客户端账户字段防线（AC3 的另一半）：请求字段/头里出现任何账户身份键
 * 即拒绝（payer-personal 的既有防线，本票把它并入路由判定面）。伪造的
 * 账户字段不是输入——存在即拒绝，值的内容是证据不是许可。
 */
export function assertNoForeignAccountIdentity(
  fields: Record<string, unknown>,
): void {
  const foreign = findForeignAccountIdentity(fields);
  if (foreign !== null) {
    throw new PayerCrossAccountAccessError(
      `a client request named the account identity field "${foreign}" — payment accounts are fixed server-side from business objects and issued authorizations, never requested (spec §7.1)`,
    );
  }
}

// ---------------------------------------------------------------------------
// readiness 评估器（AC4：登记表变更触发就绪重评）
// ---------------------------------------------------------------------------

/** 评估器消费的入口最小结构面（MT001 CoverageInventory.entrances 子集）。 */
export interface MachinePersonalEntrance {
  readonly method: string;
  readonly path: string;
  readonly kind: string;
}

export type MachinePersonalFindingCode =
  | "ENTRY_INVALID"
  | "FAMILY_OVERLAP"
  | "UNREGISTERED_CALLBACK_DOOR"
  | "UNREGISTERED_PERSONAL_DOOR";

export interface MachinePersonalFinding {
  readonly code: MachinePersonalFindingCode;
  readonly detail: string;
}

export interface MachinePersonalEvaluation {
  readonly ok: boolean;
  readonly reason?: string;
  readonly registeredCallbacks: readonly string[];
  readonly registeredPersonal: readonly string[];
  readonly findings: readonly MachinePersonalFinding[];
}

function entryInvalidReason(
  entry: MachinePersonalExceptionEntry,
): string | null {
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
    return "reason is empty — every exception must state why it is an exception";
  if (
    typeof entry.ownerTicket !== "string" ||
    entry.ownerTicket.trim().length === 0
  )
    return "ownerTicket is empty — every exception must name its responsible ticket";
  if (
    typeof entry.contentBoundary !== "string" ||
    entry.contentBoundary.trim().length === 0
  )
    return "contentBoundary is empty — every exception must state what it may touch";
  if (
    typeof entry.paymentAccount !== "string" ||
    entry.paymentAccount.trim().length === 0
  )
    return "paymentAccount is empty — every exception must state how its payment account is fixed (spec §7.1)";
  if (!["machine", "session"].includes(entry.context))
    return `context must be machine|session, got "${String(entry.context)}"`;
  if (!["always", "conditional"].includes(entry.surface))
    return `surface must be always|conditional, got "${String(entry.surface)}"`;
  return null;
}

/**
 * 两族登记的 readiness 评估器（纯函数）：
 *   a. 每条登记形状完整（ENTRY_INVALID）；
 *   b. 完备方向闭包：路径落在某族门下（任意方法的路径匹配）但未被该族
 *      任何登记项按方法命中 → 门下未登记入口（UNREGISTERED_*_DOOR）。
 *      门下新增入口（新方法、新子路径）不会被静默放行；
 *   c. 两族互斥（FAMILY_OVERLAP）：同一入口不得同时命中两族登记——
 *      回调例外不覆盖个人直连门，反之亦然（「例外只覆盖回调本身」）。
 * 缺口一次列全。锚定方向（登记项必须锚定真实装配入口，防幽灵/过期）
 * 需要真实全量清单，按 MT030 先例由测试对 buildInventory 产物钉死，
 * 不在启动检查里做（启动检查的清单是部署提供的输入）。
 */
export function evaluateMachinePersonalExceptionRegistry({
  machineCallbacks,
  personalDirect,
  entrances,
}: {
  readonly machineCallbacks: readonly MachinePersonalExceptionEntry[];
  readonly personalDirect: readonly MachinePersonalExceptionEntry[];
  readonly entrances: readonly MachinePersonalEntrance[];
}): MachinePersonalEvaluation {
  const findings: MachinePersonalFinding[] = [];
  const validCallbacks: MachinePersonalExceptionEntry[] = [];
  const validPersonal: MachinePersonalExceptionEntry[] = [];
  for (const entry of machineCallbacks) {
    const invalid = entryInvalidReason(entry);
    if (invalid) {
      findings.push({
        code: "ENTRY_INVALID",
        detail: `machine-callback entry "${entry.id || "<unnamed>"}": ${invalid}`,
      });
      continue;
    }
    validCallbacks.push(entry);
  }
  for (const entry of personalDirect) {
    const invalid = entryInvalidReason(entry);
    if (invalid) {
      findings.push({
        code: "ENTRY_INVALID",
        detail: `personal-direct entry "${entry.id || "<unnamed>"}": ${invalid}`,
      });
      continue;
    }
    validPersonal.push(entry);
  }

  for (const entrance of entrances) {
    // route 与 catchall（ALL 形子应用挂载，如 /api/bot-service/*）都是门；
    // serve-upgrade（WS 升级分支）走自己的分类，不在本闭包。
    if (entrance.kind !== "route" && entrance.kind !== "catchall") continue;
    const method = entrance.method.toUpperCase();
    const underCallbacks = validCallbacks.some((entry) =>
      entryMatches({ ...entry, methods: ["ALL"] }, method, entrance.path),
    );
    const underPersonal = validPersonal.some((entry) =>
      entryMatches({ ...entry, methods: ["ALL"] }, method, entrance.path),
    );
    const matchedCallbacks = validCallbacks.some((entry) =>
      entryMatches(entry, method, entrance.path),
    );
    const matchedPersonal = validPersonal.some((entry) =>
      entryMatches(entry, method, entrance.path),
    );
    if (matchedCallbacks && matchedPersonal) {
      findings.push({
        code: "FAMILY_OVERLAP",
        detail: `${method} ${entrance.path} is registered in both the machine-callback and personal-direct exception families — a callback exception covers the callback itself, never a personal door (and vice versa)`,
      });
      continue;
    }
    if (underCallbacks && !matchedCallbacks) {
      findings.push({
        code: "UNREGISTERED_CALLBACK_DOOR",
        detail: `${method} ${entrance.path} sits under a registered machine-callback door but is not itself registered — the callback exception covers the callback only; a new entrance under the door must be registered or it fails startup`,
      });
    }
    if (underPersonal && !matchedPersonal) {
      findings.push({
        code: "UNREGISTERED_PERSONAL_DOOR",
        detail: `${method} ${entrance.path} sits under a registered personal-direct door but is not itself registered — a new entrance under the door must be registered or it fails startup`,
      });
    }
  }

  const ok = findings.length === 0;
  return {
    ok,
    reason: ok
      ? undefined
      : `machine/personal exception registry validation failed (${findings.length} finding${findings.length === 1 ? "" : "s"})`,
    registeredCallbacks: validCallbacks.map((entry) => entry.id),
    registeredPersonal: validPersonal.map((entry) => entry.id),
    findings,
  };
}

/** 默认输入（两族登记表 + 调用方提供的入口清单）。 */
export function evaluateDefaultMachinePersonalExceptionRegistry({
  entrances,
}: {
  readonly entrances: readonly MachinePersonalEntrance[];
}): MachinePersonalEvaluation {
  return evaluateMachinePersonalExceptionRegistry({
    machineCallbacks: MACHINE_CALLBACK_EXCEPTIONS,
    personalDirect: PERSONAL_DIRECT_EXCEPTIONS,
    entrances,
  });
}

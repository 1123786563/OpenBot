/**
 * MT013（Issue #57）：多租户模式的启动校验。
 *
 * 运维用 OPENBOT_MULTITENANCY=on 显式进入多租户模式（server/src/config.ts 解析，
 * 默认关闭）。开启后，进程在监听任何端口、写入任何数据之前，在这里过三项校验，
 * 任何一项不满足都以非 0 退出拒绝启动——带着缺口上线不是一个可选项：
 *
 *   a. 入口覆盖清单完整：消费 MT001 inventory（server/scripts/multitenancy/
 *      inventory.ts）产出的 CoverageInventory 契约，无未归属（unowned）或未
 *      分类（unclassified）入口；允许显式豁免清单（每条必须带理由，进入审计
 *      记录），typo 的豁免条目一律拒绝而不是静默吞掉。
 *   b. 无单用户/开发绕过残留：single-user 面（OPENBOT_SINGLE_USER 与遗留名
 *      OPENBOT_DEV_NO_AUTH，见 server/src/auth/dev-actor.ts）是多租户模式下
 *      最大的"每个访客都是管理员"缺口，任何形态的残留（包括被 singleUserEnabled
 *      静默忽略的垃圾值）都拒绝启动。
 *   c. 数据库角色安全：对生产目录/数据连接（ENTERPRISE_DIRECTORY_DATABASE_URL /
 *      ENTERPRISE_DATA_DATABASE_URL）做只读探测，要求 ob_ent_directory /
 *      ob_ent_data 能力角色存在、自身与登录角色特权面符合预期（NOLOGIN、无
 *      SUPERUSER/BYPASSRLS/CREATEDB/CREATEROLE/REPLICATION、登录角色恰好持有
 *      该能力、无其他成员资格）——即 server/src/enterprise/tenancy/connections.ts
 *      能力校验目录在生产 config 下的对应形态，亦是
 *      server/scripts/enterprise-test-db.ts ob_ent_* 测试形态的生产对应物。
 *      另要求 OPENBOT_TENANT_STORAGE_RUNTIME_DATABASE_URL 已配置：缺了它
 *      index.ts 的企业能力装配会整体静默降级为 null（index.ts enterpriseCapabilities），
 *      那正是"带着缺口上线"。
 *
 * 校验是只读探测：读配置文件、SELECT pg_roles/pg_has_role，不写任何数据、
 * 不做迁移。三项全部评估完才下 verdict（拒绝记录要一次列全缺口，而不是发现
 * 第一个就停）。结果以一条结构化记录进入启动日志（可审计），拒绝时 exit 非 0。
 */

import { sql } from "drizzle-orm";
import { getLogger } from "../../../../shared/logger";
import type { CoverageInventory } from "../../../scripts/multitenancy/inventory";
import {
  createDatabase as createDatabaseFn,
  type Database,
} from "../../db/client";

// ---------------------------------------------------------------------------
// 覆盖校验（MT001 CoverageInventory 契约消费方）
// ---------------------------------------------------------------------------

/** 一条显式豁免：豁免哪个入口、为什么、谁批的。理由是留痕的最低要求。 */
export interface CoverageWaiver {
  readonly entrance: string;
  readonly reason: string;
  readonly ticket?: string;
}

/** 豁免清单文件（OPENBOT_MULTITENANCY_WAIVERS 指向的 JSON）的契约。 */
export interface WaiverFile {
  readonly schemaVersion: 1;
  readonly waivers: readonly CoverageWaiver[];
}

export interface UncoveredEntrance {
  readonly id: string;
  readonly entrance: string;
  readonly reason: "unowned" | "unclassified";
}

export type CoverageEvaluation =
  | {
      readonly ok: true;
      readonly waivedEntrances: readonly string[];
    }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly uncovered: readonly UncoveredEntrance[];
      readonly waivedEntrances: readonly string[];
    };

/**
 * 覆盖完整性判定：纯函数，测试直接注入假 inventory（三拒绝路径之一）。
 *
 * 通过条件：schemaVersion 恰为 1；无 failed 装配；serve() 升级分支数不超过
 * 已登记的 stream 入口数；除显式豁免外，没有 unowned / unclassified 入口。
 * 豁免条目必须指名清单里真实存在的入口 id 且带非空理由——typo 与空理由都
 * 是配置错误，静默放过等于没有豁免纪律。
 */
export function evaluateInventoryCoverage(
  inventoryInput: CoverageInventory,
  waivers: readonly CoverageWaiver[],
): CoverageEvaluation {
  const waivedEntrances = waivers.map((waiver) => waiver.entrance);
  const fail = (reason: string, uncovered: readonly UncoveredEntrance[] = []) =>
    ({ ok: false, reason, uncovered, waivedEntrances }) as const;

  if (inventoryInput.schemaVersion !== 1) {
    return fail(
      `coverage inventory has schemaVersion ${String(inventoryInput.schemaVersion)}, expected 1 — regenerate with server/scripts/multitenancy/inventory.ts`,
    );
  }

  // 豁免纪律：入口必须在清单里、理由必须非空。
  const knownEntranceIds = new Set(
    (inventoryInput.entrances ?? []).map((entry) => entry.id),
  );
  const unknownWaivers = waivers.filter(
    (waiver) => !knownEntranceIds.has(waiver.entrance),
  );
  if (unknownWaivers.length > 0) {
    return fail(
      `coverage waivers name entrances that are not in the inventory (typos refuse loudly): ${unknownWaivers.map((waiver) => waiver.entrance).join(", ")}`,
    );
  }
  const emptyReasonWaivers = waivers.filter(
    (waiver) => !waiver.reason || waiver.reason.trim() === "",
  );
  if (emptyReasonWaivers.length > 0) {
    return fail(
      `coverage waivers must carry a non-empty reason (the audit trail is the point): ${emptyReasonWaivers.map((waiver) => waiver.entrance).join(", ")}`,
    );
  }

  // 装配失败是结构性缺口，与入口覆盖同级。
  const failedAssemblies = (inventoryInput.assemblies ?? []).filter(
    (assembly) => assembly.status !== "assembled",
  );
  if (failedAssemblies.length > 0) {
    return fail(
      `coverage inventory records failed assemblies: ${failedAssemblies.map((assembly) => assembly.name).join(", ")}`,
    );
  }

  const { serveUpgradeBranches = 0, serveUpgradeEntrances = 0 } =
    inventoryInput.summary ?? {};
  if (serveUpgradeBranches > serveUpgradeEntrances) {
    return fail(
      `coverage inventory counts ${serveUpgradeBranches} serve() upgrade branches but only ${serveUpgradeEntrances} registered stream entrances — an unregistered WebSocket entry is an uncovered entrance`,
    );
  }

  const waivedIds = new Set(waivedEntrances);
  const uncovered: UncoveredEntrance[] = [];
  for (const entry of inventoryInput.entrances ?? []) {
    if (waivedIds.has(entry.id)) continue;
    if (entry.status === "unowned") {
      uncovered.push({
        id: entry.id,
        entrance: entry.entrance,
        reason: "unowned",
      });
    } else if (entry.businessClosure === "unclassified") {
      uncovered.push({
        id: entry.id,
        entrance: entry.entrance,
        reason: "unclassified",
      });
    }
  }
  if (uncovered.length > 0) {
    return fail(
      `coverage inventory has ${uncovered.length} uncovered entrance(s) beyond explicit waivers — every entrance must be owned and classified before multitenancy boots`,
      uncovered,
    );
  }
  return { ok: true, waivedEntrances };
}

/** 解析豁免清单文件内容；损坏的文件是配置错误，绝不静默当作"无豁免"。 */
export function parseWaiverFile(content: string): readonly CoverageWaiver[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new TypeError(
      `coverage waiver file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TypeError(
      'coverage waiver file must be {"schemaVersion":1,"waivers":[{"entrance":"METHOD /path","reason":"…","ticket":"…"}]}',
    );
  }
  const file = parsed as WaiverFile;
  // 与 inventory 侧的严格 schemaVersion 拒绝对称：接口声明了 1 就检查 1，
  // 契约漂移不许静默消费。
  if (file.schemaVersion !== 1) {
    throw new TypeError(
      `coverage waiver file has schemaVersion ${String(file.schemaVersion)}, expected 1`,
    );
  }
  if (!Array.isArray(file.waivers)) {
    throw new TypeError(
      'coverage waiver file must be {"schemaVersion":1,"waivers":[{"entrance":"METHOD /path","reason":"…","ticket":"…"}]}',
    );
  }
  // 元素必须是对象：非对象元素的拒绝消息要带上索引与类型，而不是让
  // undefined 漏到下游 evaluator 的拒绝消息里。
  for (let index = 0; index < file.waivers.length; index += 1) {
    const waiver = file.waivers[index] as unknown;
    if (
      typeof waiver !== "object" ||
      waiver === null ||
      Array.isArray(waiver)
    ) {
      throw new TypeError(
        `coverage waiver file waivers[${index}] must be an object like {"entrance":"METHOD /path","reason":"…"}, got ${describeWaiverElement(waiver)}`,
      );
    }
  }
  return file.waivers;
}

/** 拒绝消息里的元素类型描述：typeof null 是 "object"，单独点名。 */
function describeWaiverElement(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return `a ${typeof value}`;
}

// ---------------------------------------------------------------------------
// 单用户/开发绕过残留
// ---------------------------------------------------------------------------

/** 部署事实中与 single-user/dev 绕过有关的部分（index.ts 从 config/env 提供）。 */
export interface DevBypassFacts {
  /** config.singleUser：OPENBOT_SINGLE_USER=true（或遗留名）被 loadConfig 接受的结果。 */
  readonly singleUser: boolean;
  /** OPENBOT_SINGLE_USER 原始值；垃圾值会被 singleUserEnabled 静默忽略，这里不忽略。 */
  readonly singleUserEnvRaw?: string;
  /** OPENBOT_DEV_NO_AUTH 原始值（更名的旧名，仍被 singleUserEnabled 尊崇）。 */
  readonly devNoAuthEnvRaw?: string;
}

export interface DevBypassFinding {
  /** 残留源（env 变量名或 config 字段）。 */
  readonly source: string;
  readonly detail: string;
}

export type DevBypassEvaluation =
  | { readonly ok: true }
  | { readonly ok: false; readonly findings: readonly DevBypassFinding[] };

/** 显式关闭（false/0/空/未设置）不算残留；其余任何值都是。 */
function residueValue(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const trimmed = raw.trim();
  if (trimmed === "") return false;
  return trimmed !== "false" && trimmed !== "0";
}

/**
 * 开发绕过残留判定：纯函数，测试注入假 bypass 事实（三拒绝路径之二）。
 *
 * single-user 是多租户的对立面：它把每个请求都当成管理员（dev-actor.ts），
 * 而且它本身就是靠"显式写下我活在一个人的机器上"这把锁才允许存在的。
 * 多租户模式下任何形态的残留都拒绝启动。
 */
export function evaluateDevBypassResidue(
  facts: DevBypassFacts,
): DevBypassEvaluation {
  const findings: DevBypassFinding[] = [];
  if (facts.singleUser) {
    findings.push({
      source: "config.singleUser",
      detail:
        "OPENBOT_SINGLE_USER (or its former name OPENBOT_DEV_NO_AUTH) admits every request as the development administrator; multitenancy mode refuses to boot alongside it",
    });
  }
  if (residueValue(facts.singleUserEnvRaw)) {
    findings.push({
      source: "OPENBOT_SINGLE_USER",
      detail: `set to "${facts.singleUserEnvRaw}" — unset it (or set false/0) before multitenancy mode can boot`,
    });
  }
  if (residueValue(facts.devNoAuthEnvRaw)) {
    findings.push({
      source: "OPENBOT_DEV_NO_AUTH",
      detail: `set to "${facts.devNoAuthEnvRaw}" — the former name of OPENBOT_SINGLE_USER; unset it before multitenancy mode can boot`,
    });
  }
  if (findings.length > 0) return { ok: false, findings };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 数据库角色安全（只读探测）
// ---------------------------------------------------------------------------

/** 一次角色安全探测的完整结果（连接失败时仅 connected=false + failure）。 */
export interface RoleSafetyProbe {
  readonly expectedRole: string;
  readonly connected: boolean;
  readonly roleExists?: boolean;
  /** 能力角色自身：NOLOGIN 且无 SUPERUSER/BYPASSRLS/CREATEDB/CREATEROLE/REPLICATION。 */
  readonly capabilityAttributesSafe?: boolean;
  /** 登录角色：可登录且无任何集群级特权。 */
  readonly loginAttributesSafe?: boolean;
  /** 登录角色持有该能力角色的成员资格。 */
  readonly loginHasCapability?: boolean;
  /** 登录角色没有第二个成员资格（无提权路径）。 */
  readonly loginHasNoOtherMemberships?: boolean;
  readonly failure?: string;
}

export type RoleSafetyEvaluation =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

interface RoleSafetyRow {
  role_exists: boolean;
  capability_attributes_safe: boolean;
  login_attributes_safe: boolean;
  login_has_capability: boolean;
  login_has_no_other_memberships: boolean;
}

/**
 * 生产运行时连接上的只读角色探测。语义与
 * server/src/enterprise/tenancy/connections.ts 的能力目录一致（capability
 * NOLOGIN 无特权、login 恰好一个成员资格），但不依赖该文件——这里是启动期
 * 独立探测，连接由调用方提供并在探测后由调用方关闭。
 *
 * 唯一语句是 SELECT（pg_roles + pg_has_role），不写任何数据。
 */
export async function probeRoleSafety(
  database: Database,
  expectedRole: string,
): Promise<RoleSafetyProbe> {
  let rows: RoleSafetyRow[];
  try {
    rows = (await database.execute(sql`
      SELECT
        capability.rolname IS NOT NULL AS role_exists,
        capability.rolname IS NOT NULL
          AND NOT capability.rolcanlogin
          AND NOT capability.rolsuper
          AND NOT capability.rolbypassrls
          AND NOT capability.rolcreatedb
          AND NOT capability.rolcreaterole
          AND NOT capability.rolreplication AS capability_attributes_safe,
        login.rolcanlogin
          AND NOT login.rolsuper
          AND NOT login.rolbypassrls
          AND NOT login.rolcreatedb
          AND NOT login.rolcreaterole
          AND NOT login.rolreplication AS login_attributes_safe,
        capability.rolname IS NOT NULL
          AND pg_has_role(session_user, capability.oid, 'MEMBER') AS login_has_capability,
        NOT EXISTS (
          SELECT 1
          FROM pg_roles other
          WHERE other.rolname <> login.rolname
            AND other.rolname <> capability.rolname
            AND pg_has_role(session_user, other.oid, 'MEMBER')
        ) AS login_has_no_other_memberships
      FROM pg_roles login
      LEFT JOIN pg_roles capability ON capability.rolname = ${expectedRole}
      WHERE login.rolname = session_user
    `)) as unknown as RoleSafetyRow[];
  } catch (error) {
    return {
      expectedRole,
      connected: false,
      failure: error instanceof Error ? error.message : String(error),
    };
  }
  const row = rows[0];
  if (!row) {
    return {
      expectedRole,
      connected: false,
      failure:
        "role-safety probe returned no row (session role missing from pg_roles?)",
    };
  }
  return {
    expectedRole,
    connected: true,
    roleExists: row.role_exists === true,
    capabilityAttributesSafe: row.capability_attributes_safe === true,
    loginAttributesSafe: row.login_attributes_safe === true,
    loginHasCapability: row.login_has_capability === true,
    loginHasNoOtherMemberships: row.login_has_no_other_memberships === true,
  };
}

/**
 * 角色安全判定：纯函数，测试注入假探测结果（三拒绝路径之三）。
 * 与覆盖校验同一条纪律：列出全部不满足项，而不是第一个就停。
 */
export function evaluateRoleSafety(
  probes: readonly RoleSafetyProbe[],
): RoleSafetyEvaluation {
  const failures: string[] = [];
  for (const probe of probes) {
    if (!probe.connected) {
      failures.push(
        `${probe.expectedRole}: probe connection failed (${probe.failure ?? "unknown"})`,
      );
      continue;
    }
    if (probe.roleExists !== true) {
      failures.push(
        `${probe.expectedRole}: capability role does not exist on this database`,
      );
      continue;
    }
    if (probe.capabilityAttributesSafe !== true) {
      failures.push(
        `${probe.expectedRole}: capability role carries login/superuser/bypassrls/createdb/createrole/replication attributes`,
      );
    }
    if (probe.loginAttributesSafe !== true) {
      failures.push(
        `${probe.expectedRole}: session login is privileged (superuser/bypassrls/createdb/createrole/replication) — runtime roles must be exactly one capability each`,
      );
    }
    if (probe.loginHasCapability !== true) {
      failures.push(
        `${probe.expectedRole}: session login does not hold the capability membership`,
      );
    }
    if (probe.loginHasNoOtherMemberships !== true) {
      failures.push(
        `${probe.expectedRole}: session login holds memberships beyond its one capability (escalation path)`,
      );
    }
  }
  if (failures.length > 0) {
    return { ok: false, reason: failures.join("; ") };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 编排器与 verdict
// ---------------------------------------------------------------------------

/** index.ts 启动段提供的输入（全部来自已加载的 config + 进程环境）。 */
export interface MultitenancyStartupInputs {
  readonly inventoryPath?: string;
  readonly waiversPath?: string;
  readonly directoryUrl?: string;
  readonly dataUrl?: string;
  readonly tenantRuntimeUrl?: string;
  readonly singleUser: boolean;
  readonly singleUserEnvRaw?: string;
  readonly devNoAuthEnvRaw?: string;
}

/** 可注入的 IO（默认真实 fs / 真实连接工厂）；测试注入假 inventory 与角色状态。 */
export interface StartupCheckDeps {
  readonly readTextFile?: (path: string) => Promise<string>;
  readonly createDatabase?: (url: string) => Database;
  readonly closeDatabase?: (database: Database) => Promise<void>;
}

export interface MultitenancyStartupRecord {
  readonly type: "multitenancy-startup-validation";
  readonly mode: "on";
  readonly accepted: boolean;
  readonly timestamp: string;
  readonly checks: {
    readonly coverage:
      | { readonly ok: true; readonly waivedEntrances: readonly string[] }
      | {
          readonly ok: false;
          readonly reason: string;
          readonly uncovered: readonly UncoveredEntrance[];
          readonly waivedEntrances: readonly string[];
        };
    readonly devBypass:
      | { readonly ok: true }
      | { readonly ok: false; readonly findings: readonly DevBypassFinding[] };
    readonly databaseRoles:
      | { readonly ok: true }
      | { readonly ok: false; readonly reason: string };
  };
}

const readFileDefault = async (path: string): Promise<string> => {
  const { readFile } = await import("node:fs/promises");
  return readFile(path, "utf8");
};

/**
 * 覆盖校验的 IO 段：读清单（与豁免）文件、解析、交给纯 evaluator。
 * 任何文件层失败都是校验失败（带理由），绝不冒充通过，也绝不向上炸进程——
 * 拒绝启动由 verdict 统一执行。
 */
async function evaluateCoverageCheck(
  inventoryPath: string | undefined,
  waiversPath: string | undefined,
  readTextFile: (path: string) => Promise<string>,
): Promise<MultitenancyStartupRecord["checks"]["coverage"]> {
  if (!inventoryPath) {
    return {
      ok: false,
      reason:
        "no coverage inventory configured — set OPENBOT_MULTITENANCY_INVENTORY to the CoverageInventory JSON produced by server/scripts/multitenancy/inventory.ts",
      uncovered: [],
      waivedEntrances: [],
    };
  }
  let raw: string;
  try {
    raw = await readTextFile(inventoryPath);
  } catch (error) {
    return {
      ok: false,
      reason: `coverage inventory could not be read (${inventoryPath}): ${error instanceof Error ? error.message : String(error)}`,
      uncovered: [],
      waivedEntrances: [],
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      ok: false,
      reason: `coverage inventory at ${inventoryPath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      uncovered: [],
      waivedEntrances: [],
    };
  }
  // 豁免清单与 inventory 同款 containment：读不了/解析不了都是带理由的
  // 校验失败，而不是穿透模块边界的进程栈（复审 F1：waivers 的
  // readTextFile/parseWaiverFile 异常曾裸穿到进程层——零结构化审计记录）。
  let waivers: readonly CoverageWaiver[] = [];
  if (waiversPath) {
    try {
      waivers = parseWaiverFile(await readTextFile(waiversPath));
    } catch (error) {
      return {
        ok: false,
        reason: `coverage waiver file could not be read or parsed (${waiversPath}): ${error instanceof Error ? error.message : String(error)}`,
        uncovered: [],
        waivedEntrances: [],
      };
    }
  }
  const evaluation = evaluateInventoryCoverage(
    parsed as CoverageInventory,
    waivers,
  );
  return evaluation.ok
    ? { ok: true, waivedEntrances: evaluation.waivedEntrances }
    : {
        ok: false,
        reason: evaluation.reason,
        uncovered: [...evaluation.uncovered],
        waivedEntrances: [...evaluation.waivedEntrances],
      };
}

/**
 * 三项启动校验的编排。全部评估完才返回记录（拒绝要列全缺口）；
 * 任何探测连接用完即关。本函数不打印日志、不退出进程——那是
 * applyStartupVerdict 的事，两步分开才可单测。
 */
export async function runMultitenancyStartupChecks(
  inputs: MultitenancyStartupInputs,
  deps: StartupCheckDeps = {},
): Promise<MultitenancyStartupRecord> {
  const readTextFile = deps.readTextFile ?? readFileDefault;
  const createDatabase =
    deps.createDatabase ?? ((url: string) => createDatabaseFn(url, { max: 1 }));
  const closeDatabase =
    deps.closeDatabase ?? ((database: Database) => database.$client.close());

  // a. 覆盖清单（文件损坏/缺失是校验失败，不是进程崩溃）。
  const coverageOutcome = await evaluateCoverageCheck(
    inputs.inventoryPath,
    inputs.waiversPath,
    readTextFile,
  );
  const coverage: MultitenancyStartupRecord["checks"]["coverage"] =
    coverageOutcome;

  // b. 单用户/开发绕过残留。
  const devBypass = evaluateDevBypassResidue({
    singleUser: inputs.singleUser,
    singleUserEnvRaw: inputs.singleUserEnvRaw,
    devNoAuthEnvRaw: inputs.devNoAuthEnvRaw,
  });

  // c. 数据库角色安全（只读探测，连接即开即关）。
  let databaseRoles: MultitenancyStartupRecord["checks"]["databaseRoles"];
  const missingUrls = (
    [
      ["ENTERPRISE_DIRECTORY_DATABASE_URL", inputs.directoryUrl],
      ["ENTERPRISE_DATA_DATABASE_URL", inputs.dataUrl],
      ["OPENBOT_TENANT_STORAGE_RUNTIME_DATABASE_URL", inputs.tenantRuntimeUrl],
    ] as const
  )
    .filter(([, url]) => !url)
    .map(([name]) => name);
  if (missingUrls.length > 0) {
    databaseRoles = {
      ok: false,
      reason: `multitenancy mode requires the restricted-role production databases; unset variables: ${missingUrls.join(", ")}`,
    };
  } else {
    const probes: RoleSafetyProbe[] = [];
    for (const [role, url] of [
      ["ob_ent_directory", inputs.directoryUrl as string],
      ["ob_ent_data", inputs.dataUrl as string],
    ] as const) {
      // 连接工厂本身也可能同步抛出（例如畸形 URL）——与文件层同款
      // containment：降级为该角色的一次失败探测，而不是穿透模块边界。
      let database: Database;
      try {
        database = createDatabase(url);
      } catch (error) {
        probes.push({
          expectedRole: role,
          connected: false,
          failure: `database factory threw before connecting: ${error instanceof Error ? error.message : String(error)}`,
        });
        continue;
      }
      try {
        probes.push(await probeRoleSafety(database, role));
      } finally {
        await closeDatabase(database);
      }
    }
    const evaluation = evaluateRoleSafety(probes);
    databaseRoles = evaluation.ok
      ? { ok: true }
      : { ok: false, reason: evaluation.reason };
  }

  const accepted = coverage.ok && devBypass.ok && databaseRoles.ok;
  return {
    type: "multitenancy-startup-validation",
    mode: "on",
    accepted,
    timestamp: new Date().toISOString(),
    checks: { coverage, devBypass, databaseRoles },
  };
}

/**
 * verdict：把启动校验记录写进启动日志（恰好一条结构化记录，可审计），
 * 然后按结果放行或以非 0 退出拒绝启动。拒绝不是警告继续——带着缺口
 * 上线不是一个可选项。log/exit 可注入供单测断言。
 */
export function applyStartupVerdict(
  record: MultitenancyStartupRecord,
  hooks: {
    log?: Pick<ReturnType<typeof getLogger>, "info">;
    exit?: (code: number) => void;
  } = {},
): void {
  const log = hooks.log ?? getLogger("server");
  log.info(
    record,
    record.accepted
      ? "multitenancy startup validation passed — booting in multitenancy mode"
      : "multitenancy startup validation failed — refusing to boot (see the checks in this record)",
  );
  if (!record.accepted) {
    if (hooks.exit) hooks.exit(1);
    else process.exit(1);
  }
}

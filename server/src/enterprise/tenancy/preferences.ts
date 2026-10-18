// server/src/enterprise/tenancy/preferences.ts
// MT079（Issue #122）：偏好分类——全局个人偏好 vs 范围业务配置。
//
// 语言、主题等纯 UI 偏好继续是全局个人偏好：按用户保存（users.preferences，
// 表上没有任何范围列），跨公司/团队切换保持。业务模型选择、提示词、默认
// 资源、策略、凭据引用与套餐映射必须按归属保存，绝不因偏好机制跨范围泄露
// 或覆盖——它们的权威存储是各自的范围面（MT014 runtime-config、MT077
// governance-policy、Bot 配置业务对象），不是任何个人偏好文档。
//
// 结构上的硬性规则（验收 1/3/4 的实现面）：
//   - 清单封闭且可核对：全局个人偏好键是穷举封闭清单（与
//     shared/user-preferences 的 UserPreferences 键集结构性同步，测试钉死）；
//     范围业务配置按类别登记（类别、权威存储、文档路径），全部进摘要。
//     PREFERENCE_CLASSIFICATION_DIGEST 对规范序列化做 SHA-256：清单任何一项
//     增删改都会改变摘要——清单漂移可报警（测试钉死精确 hex）。
//   - 写入口 fail-closed：分类外的键（未知键、业务形键、还没入清单的新偏好）
//     一律拒绝；值形封闭（enum 精确成员或 boolean）——全局偏好文档结构上
//     装不进公司业务数据或凭据引用（票面验收 3）。补丁全有或全无：一个
//     未分类键让整个补丁被拒，绝不部分生效。
//   - 读入口过滤：无论存储文档里有什么（遗留脏键、业务形键、投毒数据），
//     读取只返回分类为全局个人偏好且值合法的条目，缺失/坏值落回默认值，
//     输出恒为完整 UserPreferences——读取永不合并任何范围业务条目（票面
//     验收 4）。
//   - 拒绝消息零回显：只含代码与规则文本，被拒的键与值都不回显（与
//     MT015 同一纪律——调用方知道自己发了什么，错误文本不携带任何输入）。
//   - 纯函数 seam：只依赖入参，绝不读取任何进程环境，没有进程级可变状态；
//     输出深冻结（调用方拿到不可变快照，与 runtime-config 同一契约）。
//
// 与既有机制的关系：users.preferences 的既有读取/合并
// （createUserPreferencesStore）与路由层 zod 严格模式保持原样；本模块是
// 多租户侧的分类权威与读写门（键集同步由测试钉死），遗留入口接受任何
// 本清单不承认的键都会在这里被拒——装配接线由后续消费方按签名接入。

import { createHash } from "node:crypto";
import {
  DEFAULT_USER_PREFERENCES,
  type UserPreferences,
} from "../../../../shared/user-preferences";

// ---------------------------------------------------------------------------
// 分类词汇
// ---------------------------------------------------------------------------

/** 一个偏好项的分类：全局个人偏好，或范围业务配置。 */
export type PreferenceClassification = "global-personal" | "scoped-business";

/** 全局个人偏好项：键 + 封闭值形（enum 精确成员，或 boolean）。 */
export interface GlobalPersonalPreferenceItem {
  readonly key: string;
  readonly kind: "enum" | "boolean";
  /** kind="enum" 时的封闭成员集；kind="boolean" 时为空数组。 */
  readonly enumValues: readonly string[];
}

/** 范围业务配置的权威存储面（封闭集；与真实模块对号，测试钉死绑定）。 */
export type ScopedBusinessStorage =
  | "runtime-config"
  | "governance-policy"
  | "bot-configuration";

/** 范围业务配置类别：绝不进个人偏好机制的业务配置一类。 */
export interface ScopedBusinessPreferenceCategory {
  /** 稳定类别标签（kebab）。 */
  readonly category: string;
  /** 人类可读名称（票面词汇）。 */
  readonly title: string;
  /** 权威存储：读写只走这个归属面，偏好机制对它没有任何入口。 */
  readonly authoritativeStorage: ScopedBusinessStorage;
  /** 权威存储内的文档路径（`storage:path` 读形；裸路径同样可分类）。 */
  readonly documentPaths: readonly string[];
}

// ---------------------------------------------------------------------------
// 封闭清单：全局个人偏好（穷举，与 shared UserPreferences 键集同步）
// ---------------------------------------------------------------------------

export const GLOBAL_PERSONAL_PREFERENCES: readonly GlobalPersonalPreferenceItem[] =
  Object.freeze([
    Object.freeze({
      key: "messageListEmphasis",
      kind: "enum",
      enumValues: Object.freeze(["agent", "thread"]),
    }),
    Object.freeze({
      key: "selfHostBannerDismissed",
      kind: "boolean",
      enumValues: Object.freeze([]),
    }),
  ]);

// ---------------------------------------------------------------------------
// 封闭清单：范围业务配置类别（Issue #122 点名的业务面 + 凭据引用 + 套餐映射）
// ---------------------------------------------------------------------------

export const SCOPED_BUSINESS_PREFERENCES: readonly ScopedBusinessPreferenceCategory[] =
  Object.freeze([
    Object.freeze({
      category: "model-selection",
      title: "业务模型选择",
      authoritativeStorage: "runtime-config",
      documentPaths: Object.freeze([
        "runtime-config:company.model.provider",
        "runtime-config:company.model.credentialRef",
        "runtime-config:company.model.defaultModel",
        "runtime-config:company.model.allowedModels",
        "runtime-config:override.model.defaultModel",
        "runtime-config:override.model.allowedModels",
      ]),
    }),
    Object.freeze({
      category: "prompts",
      title: "提示词",
      authoritativeStorage: "bot-configuration",
      documentPaths: Object.freeze([
        "bot-configuration:coworker.configuration.systemPrompt",
      ]),
    }),
    Object.freeze({
      category: "default-resources",
      title: "默认资源",
      authoritativeStorage: "runtime-config",
      documentPaths: Object.freeze([
        "runtime-config:company.botDefaults.availableAgentIds",
        "runtime-config:company.botDefaults.defaultAgentId",
        "runtime-config:override.botDefaults.defaultAgentId",
      ]),
    }),
    Object.freeze({
      category: "policy",
      title: "策略",
      authoritativeStorage: "governance-policy",
      documentPaths: Object.freeze([
        "governance-policy:company.network",
        "governance-policy:company.capabilities",
        "governance-policy:company.modelRouting",
        "governance-policy:override.network",
        "governance-policy:override.capabilities",
        "governance-policy:override.modelRouting",
      ]),
    }),
    Object.freeze({
      category: "credential-references",
      title: "凭据引用",
      authoritativeStorage: "runtime-config",
      documentPaths: Object.freeze([
        "runtime-config:company.credentials",
        "runtime-config:override.credentials",
      ]),
    }),
    Object.freeze({
      category: "billing-plan-mapping",
      title: "套餐映射",
      authoritativeStorage: "runtime-config",
      documentPaths: Object.freeze(["runtime-config:company.planMapping"]),
    }),
  ]);

// ---------------------------------------------------------------------------
// 清单摘要：任何一项增删改都会改变摘要（清单漂移可报警）
// ---------------------------------------------------------------------------

/**
 * 分类清单的规范序列化：两段（全局个人 / 范围业务），逐项展开为定长数组。
 * 这是 PREFERENCE_CLASSIFICATION_DIGEST 的唯一输入；清单是顺序稳定的封闭表，
 * 排序无关。改动清单 = 改动摘要 = 改动测试钉死的精确 hex（有意的摩擦）。
 */
function classificationDigestFacts(): string {
  return JSON.stringify([
    [
      "global-personal",
      GLOBAL_PERSONAL_PREFERENCES.map((item) => [
        item.key,
        item.kind,
        [...item.enumValues],
      ]),
    ],
    [
      "scoped-business",
      SCOPED_BUSINESS_PREFERENCES.map((category) => [
        category.category,
        category.authoritativeStorage,
        [...category.documentPaths],
      ]),
    ],
  ]);
}

export const PREFERENCE_CLASSIFICATION_DIGEST = createHash("sha256")
  .update(classificationDigestFacts())
  .digest("hex");

// ---------------------------------------------------------------------------
// 分类查询：清单是键的唯一权威（fail-closed 的查询面）
// ---------------------------------------------------------------------------

/**
 * 分类一个偏好键。全局个人偏好键 → "global-personal"；范围业务配置的
 * 文档路径（含 `storage:` 前缀读形与裸路径）→ "scoped-business"；其余
 * （未知键、空、非字符串）→ null——分类外不是"未分类即可放行"，而是
 * "写入时拒绝"（见 parseGlobalPreferencePatch）。
 */
export function classifyPreferenceKey(
  key: unknown,
): PreferenceClassification | null {
  if (typeof key !== "string" || !key) return null;
  for (const item of GLOBAL_PERSONAL_PREFERENCES) {
    if (item.key === key) return "global-personal";
  }
  for (const category of SCOPED_BUSINESS_PREFERENCES) {
    for (const path of category.documentPaths) {
      if (path === key) return "scoped-business";
      const colon = path.indexOf(":");
      if (colon >= 0 && path.slice(colon + 1) === key) {
        return "scoped-business";
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 值形校验：全局偏好的值封闭在 enum 成员或 boolean（业务数据进不来）
// ---------------------------------------------------------------------------

function isValidGlobalValue(
  item: GlobalPersonalPreferenceItem,
  value: unknown,
): boolean {
  if (item.kind === "boolean") return typeof value === "boolean";
  return typeof value === "string" && item.enumValues.includes(value);
}

function globalItemByKey(
  key: string,
): GlobalPersonalPreferenceItem | undefined {
  return GLOBAL_PERSONAL_PREFERENCES.find((item) => item.key === key);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

// ---------------------------------------------------------------------------
// 写入口：fail-closed，全有或全无，零回显
// ---------------------------------------------------------------------------

/**
 * 校验一个针对全局个人偏好的补丁。只接受清单内键 + 封闭值形；空补丁、
 * 非对象、任何一个未分类键、任何一个坏值都让整个补丁被拒（绝不部分生效）。
 * 通过的补丁深冻结返回。拒绝消息只含代码与规则文本——被拒的键与值都不
 * 回显（canary 纪律，测试钉死）。
 */
export function parseGlobalPreferencePatch(
  patch: unknown,
): Readonly<Partial<UserPreferences>> {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new Error(
      "PREFERENCE_PATCH_INVALID: the patch must be a JSON object carrying at least one classified global personal preference key",
    );
  }
  const source = patch as Record<string, unknown>;
  const keys = Object.keys(source);
  if (keys.length === 0) {
    throw new Error(
      "PREFERENCE_PATCH_INVALID: the patch must carry at least one classified global personal preference key (an empty patch is a mistake, not a no-op write)",
    );
  }
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const item = globalItemByKey(key);
    if (!item) {
      throw new Error(
        "PREFERENCE_KEY_UNCLASSIFIED: every key must be a classified global personal preference (the classification list is the checkable authority; scoped business configuration is saved through its owning company/team surface and never through personal preferences)",
      );
    }
    if (!isValidGlobalValue(item, source[key])) {
      throw new Error(
        "PREFERENCE_VALUE_INVALID: the value does not match the classified shape for this key (booleans stay booleans; enums stay exact members); rejected keys and values are never echoed",
      );
    }
    result[key] = source[key];
  }
  return deepFreeze(result as Partial<UserPreferences>);
}

// ---------------------------------------------------------------------------
// 读入口：只返回分类为全局个人偏好的合法条目（无跨范围合并泄漏）
// ---------------------------------------------------------------------------

/**
 * 从存储的个人偏好文档读取全局个人偏好。遍历的是分类清单而不是存储键：
 * 存储文档里的任何其他键（遗留脏键、业务形键、投毒数据、__proto__ 陷阱）
 * 结构上不可能出现在输出里；清单内键的坏值落回默认值。输出恒为完整的
 * UserPreferences，深冻结、确定性。
 */
export function readGlobalPreferences(stored: unknown): UserPreferences {
  const result: Record<string, unknown> = { ...DEFAULT_USER_PREFERENCES };
  if (stored && typeof stored === "object" && !Array.isArray(stored)) {
    const source = stored as Record<string, unknown>;
    for (const item of GLOBAL_PERSONAL_PREFERENCES) {
      if (
        Object.hasOwn(source, item.key) &&
        isValidGlobalValue(item, source[item.key])
      ) {
        result[item.key] = source[item.key];
      }
    }
  }
  return deepFreeze(result as UserPreferences);
}

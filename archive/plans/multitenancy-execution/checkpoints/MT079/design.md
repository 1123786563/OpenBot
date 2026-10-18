# MT079（Issue #122）设计 — 偏好分类：全局个人偏好 vs 范围业务配置

BASE f0520524；prereq 67 项复算全部一致（开工前）；无迁移（纯代码 seam + 既有表）。

## 领域判断

- **全局个人偏好**：纯 UI 偏好（issue 例：语言、主题；现存：`messageListEmphasis`、
  `selfHostBannerDismissed`，即 `shared/user-preferences.ts` 的全部键）。按用户保存，
  跨公司/团队切换保持；存储 = `users.preferences`（表上没有任何范围列）。
- **范围业务配置**：业务模型选择、提示词、默认资源、策略、凭据引用、套餐映射。
  按归属保存于权威存储：MT014 runtime-config（model/botDefaults/credentials/planMapping）、
  MT077 governance-policy（network/capabilities/modelRouting）、Bot 配置（business object，
  `configuration.systemPrompt`；租户化由 Spec §8 Bot 闭环交付）。绝不进个人偏好机制。

## 交付（全部新文件，零既有文件改动）

1. `server/src/enterprise/tenancy/preferences.ts`
   - `GLOBAL_PERSONAL_PREFERENCES`：封闭冻结清单 {key, kind: enum|boolean, enumValues}，
     与 `DEFAULT_USER_PREFERENCES` 键集结构性同步（测试钉死相等）。
   - `SCOPED_BUSINESS_PREFERENCES`：封闭冻结类别表 {category, title, authoritativeStorage
     ∈ runtime-config|governance-policy|bot-configuration, documentPaths}——6 类：model-selection、
     prompts、default-resources、policy、credential-references、billing-plan-mapping。
   - `PREFERENCE_CLASSIFICATION_DIGEST`：对规范序列化（排序后两段清单）的 SHA-256；
     测试钉死精确 hex（清单漂移可核对、可报警）。
   - `classifyPreferenceKey(key)`：全局键 → "global-personal"；绑定 documentPath（含存储前缀
     形态）→ "scoped-business"；其余 → null（fail-closed：新偏好必须先入清单）。
   - `parseGlobalPreferencePatch(patch)`：写入口。仅接受全局清单键 + 封闭值形（enum 精确成员 /
     boolean）；空补丁、未知键、坏值、非对象一律拒绝；输出深冻结。拒绝码：
     `PREFERENCE_PATCH_INVALID` / `PREFERENCE_KEY_UNCLASSIFIED` / `PREFERENCE_VALUE_INVALID`；
     消息零回显（键与值都不回显——同 MT015 纪律）。
   - `readGlobalPreferences(stored)`：读入口。无论存储里有什么（遗留脏键、业务形键、canary），
     只返回分类为全局个人偏好且值合法的条目，坏值/缺失落回默认；输出完整 `UserPreferences`
     且深冻结。结构性保证读取永不合并任何范围业务条目（验收 4）。
2. `server/tests/multitenancy/preferences.test.ts`（Issue Verification 命令点名文件）。
3. `server/tests/multitenancy/support/preferences.ts`：夹具 = 包装 `createRuntimeConfigFixture`
   （零改动消费）+ setup 通道建两个用户（一干净一投毒）+ 真实 `createUserPreferencesStore`
   读写偏好行 + information_schema 结构断言（users 表无范围列）。

## 验收映射（issue #122 四条 + brief 四条）

| 验收 | 证据 |
| --- | --- |
| 1 清单可核对 | 全局键 === DEFAULT_USER_PREFERENCES 键集；6 个 issue 点名业务类别全部在册且绑定真实存储；digest 重算一致 + 精确 hex 钉死；routes zod schema 键（源码级）⊆ 全局清单（遗留入口不可能接受未分类键） |
| 2 跨范围 | DB：同一用户偏好行在 A/B 公司上下文读取逐字节相同（users 无范围列的结构断言 + 真实 store 读取）；runtime-config resolve(A) ≠ resolve(B)；A1 团队覆盖写入后 resolve(A1) 立即变化而 A2/B1 不变、全局偏好逐字节不变 |
| 3 fail-closed | 未知键/业务形键/坏值/空补丁/非对象全部拒绝；canary 值在任何错误消息零出现 |
| 4 读取只返回合法条目 | 投毒存储文档（defaultModel/apiKey=sk-canary/networkPolicy/theme/遗留键）→ 读取输出恰为 UserPreferences 全局键，canary 零出现 |

## 变异计划（≥4，捕获后还原）

- MUT1 readGlobalPreferences 去过滤（原样返回存储）→ 验收 4 组 fail
- MUT2 parseGlobalPreferencePatch 放行未知键 → 验收 3 组 fail
- MUT3 digest 输入丢掉 scoped 段（清单可核对性破坏）→ 验收 1 digest 组 fail
- MUT4 全局清单多收录一个业务键（分类漂移）→ 验收 1 同步组 + 验收 4 fail

## 验证门槛

聚焦 0 skip；全量 = 577 基线 + 新增；typecheck 0；biome 触及文件 0 新增；
prereq 67 项收尾复扫仅报告披露项（预期为零改动）。

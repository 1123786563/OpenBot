<!-- openbot-plugin-packages:ROOT:v1 -->
## 目标与状态

依据用户“设计详细方案并拆解具体 Issue”的请求建立本 Epic 和正式子 Issue。本轮授权为方案与建单，尚未开始生产代码实施；不包含提交、推送、合并、生产迁移或部署授权。

采用版本化插件包装配现有 Skill、专家模板和受管连接器；先交付当前可信公司/团队范围。完整 Personal Space、缺执行范围的逻辑私有 Bot、外部格式离线导入和任意可执行插件是后续范围，不作为 V1 已支持能力。

以下快照完整嵌入方案，避免依赖尚未提交的本地文档。旧有 #6/#194/#74/#75/#76/#137/#177 的正文与状态保持原状；本 Epic 不代替原多租户总体上线门禁。

## 正式子 Issue 与依赖

contains 仅表示聚合；blocked-by 才表示执行依赖。GitHub 原生关系是最终核验依据。子 Issue 标签 ready-for-agent 表示需求/验收已写清，不表示前置已完成或本轮已获实施授权。

| ID | 可独立验收的业务切片 | Blocked by |
| --- | --- | --- |
| [PKG01](https://github.com/1123786563/OpenBot/issues/460) | 浏览经过校验的受信插件包目录 | 无 |
| [PKG02](https://github.com/1123786563/OpenBot/issues/461) | 在当前团队预览并幂等安装 Skill 插件包 | https://github.com/1123786563/OpenBot/issues/460, https://github.com/1123786563/OpenBot/issues/74 |
| [PKG03](https://github.com/1123786563/OpenBot/issues/462) | 授权范围内 Bot 使用已安装 Skill 的固定版本 | https://github.com/1123786563/OpenBot/issues/461 |
| [PKG04](https://github.com/1123786563/OpenBot/issues/463) | 从插件包幂等创建当前范围的专家 Bot | https://github.com/1123786563/OpenBot/issues/462 |
| [PKG05](https://github.com/1123786563/OpenBot/issues/464) | 使用本人连接执行插件包声明的受管工具 | https://github.com/1123786563/OpenBot/issues/462, https://github.com/1123786563/OpenBot/issues/75 |
| [PKG06](https://github.com/1123786563/OpenBot/issues/465) | 预览权限差异并升级或回滚插件包版本 | https://github.com/1123786563/OpenBot/issues/464 |
| [PKG07](https://github.com/1123786563/OpenBot/issues/466) | 停用、卸载和重装插件包并保留用户资产 | https://github.com/1123786563/OpenBot/issues/463, https://github.com/1123786563/OpenBot/issues/464 |
| [PKG08](https://github.com/1123786563/OpenBot/issues/467) | 部署侧下架或安全撤回指定插件包版本 | https://github.com/1123786563/OpenBot/issues/464 |
| [PKG09](https://github.com/1123786563/OpenBot/issues/468) | 在审批恢复和后台入口保持包运行的原范围 | https://github.com/1123786563/OpenBot/issues/464 |
| [PKG10](https://github.com/1123786563/OpenBot/issues/469) | 核对外部效果未知的包调用并安全恢复 | https://github.com/1123786563/OpenBot/issues/468 |
| [PKG11](https://github.com/1123786563/OpenBot/issues/470) | 迁移存量专家和 Skill 并灰度启用包市场 | https://github.com/1123786563/OpenBot/issues/463, https://github.com/1123786563/OpenBot/issues/465, https://github.com/1123786563/OpenBot/issues/466, https://github.com/1123786563/OpenBot/issues/467, https://github.com/1123786563/OpenBot/issues/469 |
| [PKG12](https://github.com/1123786563/OpenBot/issues/471) | 完成插件包首发闭环验收与交付证据 | https://github.com/1123786563/OpenBot/issues/470 |

## 与已有工作的关系

- #74：已有关联目录、连接器安装与连接归属；复用既有实现，关闭状态不能代替当前工作区验证。
- #75：当前用户连接与 Bot 授权实时重验，作为包工具执行的原生外部依赖；本 Epic 只增加包来源关联及 Run pin，不重做通用连接治理。
- #76/#137：旧 Skill/组件发布和旧页面范围接线为相关工作；新包只新增不可变包资源和插件包视图，不能覆盖原票范围或擅自更改其依赖。
- #177：旧多租户插件/知识闭环证据继续由原票管理；本 Epic 验收只证明新增包闭环。

## 执行与验收

业务 Issue 采用纵向切片；后端、前端、迁移、验证在同一票内按接口拆成 Superpowers Task，不再拆水平 Issue。默认沿依赖串行实施；前置已验证并集成后才能领取下游。父 Issue 聚合 A01–A12，不重复实现子 Issue。

实施遵循仓库 Issue 流程：摄取树与 DAG → writing-plans → SDD → 独立 Review → OCR → 必要修复及复审。真实数据库使用受限角色；测试遵守 ADR 0008 的 e2e native/driven；skip、缺环境、空报告不能计为通过。审批和外部效果未知不能用普通重试绕过。

## 完整详细方案快照

# OpenBot 插件包与市场技术方案

状态：**详细评审稿 v0.2；用户已要求细化方案，尚未批准生产代码实施**。
日期：2026-10-19。代码核对基线：`295c0b89fc29e1f1745f0ccf484c51f49a04a1ea`，另核对当前工作区；并行工作可能继续改变代码，实施前须重做接口核对。

## 1. 目标、交付和设计依据

用户可以把一组 Skill、专家模板和受管连接器作为一个明确版本的插件包安装、配置并授予 Bot 使用。管理员能从一次调用追溯包版本、安装范围、操作者、Bot、连接账号、授权、审批和实际结果。

本次形成两份交付物：本文冻结推荐技术选择；实施计划（本地工作区计划；远端以本父 Issue 的完整快照为依据）规定任务、接口、文件归属、顺序和验证。文档中的“冻结”指本方案内部选定一种做法，审批状态仍为评审稿。

依据：根 `CONTEXT.md`；已接受 [ADR 0004](https://github.com/1123786563/OpenBot/blob/main/docs/adr/0004-company-team-tenancy.md)、[ADR 0006](https://github.com/1123786563/OpenBot/blob/main/docs/adr/0006-logical-private-bot-scoped-execution.md)、[ADR 0008](https://github.com/1123786563/OpenBot/blob/main/docs/adr/0008-test-runner-tester-army-e2e.md)；[企业平台规划 §8](https://github.com/1123786563/OpenBot/blob/main/docs/superpowers/specs/2026-10-09-enterprise-ai-platform-design.md)；[个人与小企业产品规格](https://github.com/1123786563/OpenBot/blob/main/docs/specs/2026-10-16-enterprise-personal-agent-product-permissions-spec.md)。后两份中的提议不因本稿自动获批。[ADR 0007](https://github.com/1123786563/OpenBot/blob/main/docs/adr/0007-personal-space-business-scope-and-payer.md)仍为 proposed。

外部参考于本次会话读取：[Cursor 插件 Schema](https://github.com/cursor/plugins/blob/main/schemas/plugin.schema.json)、[市场 Schema](https://github.com/cursor/plugins/blob/main/schemas/marketplace.schema.json)、[OpenAI 插件格式说明](https://github.com/openai/plugins/blob/main/.agents/skills/plugin-creator/references/plugin-json-spec.md)、[OpenAI 市场](https://github.com/openai/plugins/blob/main/.agents/plugins/marketplace.json)。借鉴两层清单和能力组合，不据此承诺两种格式的完整运行时兼容。

## 2. 当前代码与必须纠正的假设

| 现有模块 | 已有事实 | 本次处理 |
| --- | --- | --- |
| `server/src/marketplace/{catalogue,routes,store}.ts` | 代码常量目录；安装专家创建私人 Bot；安装凭证在 `expert_installs` | 保持兼容入口，增加新包目录，旧安装做显式映射 |
| `server/src/plugins/store.ts` | `PluginKind = mcp/skill/bot`；`listForAgent(agentId)` 与 `callTool`；grant、策略、连接和审计 | 复用工具执行与策略；新增必验范围的包调用分支 |
| `server/src/db/schema/plugins.ts` | Skill slug 全部署唯一；`plugin_grants` 按 Bot ID | 不用 slug 表达包资源或范围授权，不把旧 grant 当跨范围授权 |
| `server/src/enterprise/tenancy/plugin-catalog.ts` | 企业连接器目录、范围安装、连接绑定和判定已存在 | 继续作为连接器安装权威，不再建平行连接安装表 |
| `server/src/db/schema/enterprise-plugins.ts` | `enterprise_plugin_catalog/installs/connections`、复合外键与 RLS | 为包引用补 revision/generation 和精确外键；保留已存在语义 |
| `server/src/enterprise/tenancy/{store,scope-gate,workspace-admin}.ts` | 可信 PlatformScope、成员重验、公司管理员上下文及受限事务 | HTTP、后台和管理写均复用这些入口 |
| `server/src/enterprise/{experts/version-catalog,runs/*}.ts` | 专家版本及 Run/attempt/generation 已有治理接口 | 增加包版本 pin，复用 Run 和审批，不另建任务系统 |
| `server/src/index.ts` | 企业插件模块已有装配；无验证通过的写通道时 admin 为 null | 对包能力采用同样的“不可用”装配结果，不提升数据库权限 |

存在数据表或单模块测试，不代表 Web、移动、桌面、后台与供应商调用已经全部接线。实施必须用入口级验收证明。

## 3. 范围和实施顺序

V1 可独立交付：部署随包发布的受信目录、清单校验、团队范围安装、Skill/专家模板、受管连接器引用、显式 Bot 授权、Web 市场、升级/停用/卸载/撤回、旧目录适配和运行证据。V1 包内资源可同时包含三个种类；MCP 只是连接器 transport。

V1 使用当前已存在的公司/团队 PlatformScope。个人完整业务模式依赖 ADR 0007 对 Personal Space 的确认和对应可信范围解析、存储隔离、连接及付款接口实现。它作为后续接入阶段，**不把缺 tenant、默认公司或全局 owner 伪装成 Personal Space**。现有私人市场保留 legacy 合同；V1 完成说明必须明确这项差别。

V2 在同一包内核上接入真实 Personal Space 与组织私有制品发布。V3 才评审第三方可执行代码、UI 扩展、商业购买与结算。V1 不运行安装脚本，也不动态加载包内 JavaScript 到控制平面。

选用“插件包装配既有领域”方案。继续维护几套独立目录难以锁定组合版本；插件自带服务端模块又会显著扩大执行与部署接口。新包安装是组合资产的记录，既有连接器安装仍只由连接领域持有。

## 4. 领域身份与生命周期

- **插件包**：发布者发布的一组有稳定资源身份的能力；规范身份为 `publisher/name`。
- **包版本**：`publisher/name@X.Y.Z` 对应不可变清单和制品摘要，同版本不同摘要拒绝发布。
- **包安装**：一个业务范围选用一个包版本的事实；V1 唯一键是 `(tenantId, workspaceId, packageKey)`。
- **包授权**：范围内某 Bot 可使用该安装的哪些资源与工具；安装者、可见成员和账号连接者均不自动获得此授权。
- **连接绑定**：包资源引用已有连接器安装及当前用户有权使用的连接；不复制秘密。
- **运行 pin**：Run/attempt 启动时固定的包版本、资源摘要和允许工具集合；当前撤权可缩小它，升级不能扩大它。

包版本分 `published/withdrawn`；公开目录是否展示另用 `listed`，下架不等于安全撤回。安装分 `enabled/disabled/uninstalled`；连接未就绪、无 Bot 授权等为派生 readiness，不写成与连接领域竞争的状态。卸载保留安装 tombstone、版本 pin、审计与调用证据；重装复用安装 ID、增加 generation，旧 grant 不复活。

## 5. 仓库与制品格式

```text
plugins/
  marketplace.json
  packages/openbot/meeting-follow-up/
    openbot.plugin.json
    skills/summarize/SKILL.md
    experts/meeting-assistant.json
    assets/icon.png
    README.md
shared/enterprise/plugin-package-contracts.ts
server/src/plugin-packages/          # 制品解析、验证与发布；不含业务授权
server/src/enterprise/plugin-packages/ # 范围安装、授权、运行 pin 和 HTTP
```

V1 清单如下。工具 ref 必须能在受管连接器目录中解析；示例使用的 calendar 键是样例，首个实际包必须引用仓库真实受支持的键。

```json
{
  "schemaVersion": 1,
  "publisher": "openbot",
  "name": "meeting-follow-up",
  "version": "1.0.0",
  "platformApi": 1,
  "display": { "name": "会议跟进", "summary": "整理会议决定与待办", "icon": "assets/icon.png" },
  "resources": [
    { "kind": "skill", "id": "summarize", "path": "skills/summarize/SKILL.md" },
    { "kind": "expertTemplate", "id": "assistant", "path": "experts/meeting-assistant.json", "skills": ["summarize"] },
    { "kind": "managedConnector", "id": "calendar", "catalogKey": "calendar", "required": false, "tools": [{ "name": "list-events", "effect": "read" }] }
  ],
  "dependencies": []
}
```

清单使用 Zod strict object；未知 schemaVersion/platformApi、重复资源 ID、未知字段和包间非空 dependencies 在 V1 拒绝。publisher/name/资源 ID 使用 `[a-z0-9]+(?:-[a-z0-9]+)*`，各最多 64 字符；版本只接受三个非负整数且无前导零。客户端能力以服务端返回支持列表为准，不猜兼容。

清单上限 64 KiB、256 个资源、每个文本文件 1 MiB、总包 16 MiB/512 个文件；路径使用 POSIX 相对路径，拒绝绝对路径、空段、`.`、`..`、反斜杠、控制字符、符号链接、设备文件及路径大小写折叠冲突。assets 只接受 PNG/WebP。所有文件先 lstat/realpath 校验并读入受限缓冲，再从同一份缓冲计算摘要与持久化，避免校验后换文件。

制品摘要：为每个普通文件计算 SHA-256，按规范相对路径的 UTF-8 字节排序，生成 `[[path,bytes,sha256hex],...]`；对 `openbot:plugin-package:v1\0` 加该数组的紧凑 JSON 进行 SHA-256。清单作为普通文件参与摘要；digest 自身只存市场索引和发布记录。文件名、长度与内容均参与完整性判断。制品存入只读内容寻址目录 `<artifactRoot>/sha256/<hex>/`，临时目录完整写入后原子 rename；不从运行时 Git 分支、可变 tag 或任意 URL 读取。

市场索引 strict v1 含 `packageKey/version/artifactDigest/category/listed`。部署构建阶段执行 `bun scripts/plugin-packages/build.ts --catalog plugins/marketplace.json --out <artifactRoot>`，启动时验证发布元数据与本地制品；制品缺失只将相关包显示为不可用，不宣称安装成功。

## 6. 数据模型与写入权威

公共发布表 `enterprise_package_releases`：`package_key/version` 主键，`artifact_digest`、manifest JSON、文件索引 JSON、`platform_api`、`state`、`listed`、`published_at`。发布审计只含公共元数据。业务数据角色只读；发布和撤回经部署管理命令使用既有 operator 通道。制品字节留在内容寻址存储，数据库保存引用。

以下表都包含 `tenant_id/workspace_id`，复合外键证明团队、安装、资源和 Run 属于同一范围；RLS 使用事务本地 tenant/workspace，并由服务端成员/资源判定限制业务动作：

| 表 | 核心字段与约束 | 唯一写入模块 |
| --- | --- | --- |
| `enterprise_package_installs` | id、package_key、current_version、status、generation、revision、installed_by；范围+package 唯一；保留卸载行 | package install store |
| `enterprise_package_revisions` | install_id、revision、release version/digest、配置摘要、created_by；不可变，pin 可引用旧修订 | package install store |
| `enterprise_package_plans` | id、actor/principal、操作类型、install/revision、target digest、规范输入摘要、预览、expires_at、consumed_at、result；有效期 10 分钟 | package install store |
| `enterprise_package_resource_links` | install_id/revision/resource_id；kind；existing_skill_id 或 connector_install_id 或 expert_template_ref；类型互斥 CHECK | package resource adapters，通过安装事务 |
| `enterprise_package_grants` | install_id/generation/bot_id/resource_id/tool_ref；read/write 上限、granted_by、revision、revoked_at；工具集合逐项记录 | PluginStore 的 package-grants 模块 |
| `enterprise_run_package_pins` | run_id/attempt_generation/install_id/revision；release digest、resource hashes、授权时工具集合、grant revision | Run admission 通过 package runtime 模块 |
| `enterprise_package_dispatches` | operation_id、run/attempt/tool_call_id、pin、args_digest、connection_generation、state、receipt_ref；同 attempt+tool_call 唯一 | package dispatch 模块 |
| `enterprise_package_changes` | change_id、install/revision、操作者、动作、脱敏差异、时间、idempotency_key、request_digest、result_json；非空幂等键按 tenant/workspace/actor 唯一，与领域变更同事务追加 | package install store；供既有审计导出消费 |

新增 grant 表为包来源能力的唯一范围 grant；旧 `plugin_grants` 继续只治理 legacy 来源，不能用两者 OR 放行。资源清单不是 grant。DB CHECK 保证 tool_ref 只能用于连接器资源、generation/revision 为正数、plan 绑定 actor。Skill/模板授权行的 tool_ref 固定为空串，连接器工具授权的 tool_ref 非空，使用 CHECK 区分，避免 SQL NULL 唯一约束造成重复授权；工具授权另存 schema_digest、effect 和 connector_install_id。Run pin 与 dispatch 对 DataDatabase 只开放绑定当前 actor、可信 Run 和范围的最小 INSERT/UPDATE RLS；安装、授权和发布仍走管理写通道。配置仅支持最多 32 个平面非秘密字段；秘密直接由既有连接领域处理，不进入包计划或 revision。

既有 `enterprise_plugin_installs` 增加 `revision`，连接表增加 `generation`；资源链接用 `(tenant,workspace,connector_install_id)` 复合 FK，连接判定重验 bound_by、连接 owner、当前用户/Bot 使用权和真实供应商可用性。旧 envelope 保持连接领域权威，不复制到包表。包停用不自动停用被其他包使用的连接器安装；共享底层连接的停用则会使所有依赖它的包不可用。

业务写通过专门 `PackageMutationStore`，使用当前已验证 OperatorDatabase 和可信 CompanyAdminContext；每次事务内重验 `tenant_admin`、两级成员资格、epoch 与目标 workspace。HTTP 不能直接调用仅接收 tenantId 的现有低层 admin 写方法。所有包管理写按精确路径和方法追加到 `admin-separation.ts` 的 company 管理面分类，复用其显式跨面授权与审计，平台管理员不能默认代入公司。业务读/运行检查用 DataDatabase 与 WorkspaceGate。无 operator 装配时安装/升级/授权返回 503，浏览仍可用；不把 owner 数据库当回退。

## 7. 服务与 HTTP 契约

公共 wire DTO 与 Zod 位于 `shared/enterprise/plugin-package-contracts.ts`；真实 Scope、数据库、制品路径、密文和连接 vendor token 不进入 DTO。包、安装、版本、计划和 pin 的内部 ID 均由服务器生成。

```ts
interface PackageService {
  list(scope: PlatformScope, query: PackageListQuery): Promise<PackagePage>;
  get(scope: PlatformScope, installId: string): Promise<PackageInstallDetailDTO>;
  plan(scope: PlatformScope, input: PackagePlanInput): Promise<PackagePlanDTO>;
  apply(scope: PlatformScope, planId: string, idempotencyKey: string): Promise<PackageInstallDTO>;
  changeStatus(scope: PlatformScope, input: PackageStatusInput): Promise<PackageInstallDTO>;
  setBotGrant(scope: PlatformScope, input: PackageGrantInput): Promise<PackageGrantDTO>;
  instantiateExpert(scope: PlatformScope, input: InstantiateExpertInput): Promise<{ agentId: string }>;
}
```

| HTTP | 输入 | 结果 |
| --- | --- | --- |
| `GET /api/enterprise/plugin-packages` | search/category/cursor/limit，limit 默认 20 最大 100 | 目录、范围安装、readiness 与允许动作；稳定 key 游标 |
| `GET /api/enterprise/plugin-packages/installs/:id` | scope headers | 脱敏安装、资源和版本 |
| `POST /api/enterprise/plugin-packages/plans` | operation=install/upgrade/rollback；packageKey、精确 version、expectedRevision、非秘密 config、现有连接器安装引用 | 10 分钟预览、权限增量、可用性和 planId |
| `POST /api/enterprise/plugin-packages/plans/:id/apply` | `Idempotency-Key`，1–128 ASCII 字符 | 首次 201，重放 200；同键异 payload 409 |
| `PATCH /api/enterprise/plugin-packages/installs/:id/status` | enabled/disabled/uninstalled + expectedRevision | CAS 更新；不直接删行 |
| `PUT /api/enterprise/plugin-packages/installs/:id/bots/:botId/grants` | expectedRevision、明确 resource/tool 子集、连接选择 | 显式授权并增加 grant revision；V1 连接选择只允许调用者本人范围内账号 |
| `POST /api/enterprise/plugin-packages/installs/:id/experts/:resourceId` | name、Idempotency-Key、expectedRevision | 创建当前调用者私有的范围内 Bot；不会默认发布团队公共 Bot |

所有接口从已认证身份及 `x-openbot-tenant/workspace` 解析 Scope。tenant_admin 可安装/升级/停用/撤回范围 grant；普通成员浏览并使用已授权 Bot，不能创建 connector 或扩大 grant。V1 创建专家亦要求 tenant_admin，创建后通过现有 Bot 权限管理使用。前端不能因按钮隐藏而承担授权。

### 7.1 输入与结果类型

以下类型由 T1 的 shared 契约一次定义，HTTP Zod 使用 strict object。scope、actor、principal、密文和 transport 均不允许由这些输入携带。

```ts
type PackageListQuery = { search?: string; category?: string; cursor?: string; limit?: number };
type PackagePlanInput = {
  operation: "install" | "upgrade" | "rollback";
  packageKey: string;
  version: string;
  expectedRevision: number | null; // 首次安装为 null；已有安装必须精确匹配
  config: Record<string, string | number | boolean>;
  connectorInstalls: Record<string, string>; // resourceId -> 原领域 connectorInstallId
};
type PackageStatusInput = {
  installId: string; expectedRevision: number;
  status: "enabled" | "disabled" | "uninstalled";
};
type PackageGrantInput = {
  installId: string; botId: string; expectedRevision: number;
  expectedGrantRevision: number | null;
  resources: Array<{ resourceId: string; toolRefs: string[] }>;
};
type InstantiateExpertInput = {
  installId: string; resourceId: string; expectedRevision: number;
  name: string; idempotencyKey: string;
};
type PackagePlanDTO = {
  planId: string; operation: PackagePlanInput["operation"];
  packageKey: string; version: string; artifactDigest: string;
  expectedRevision: number | null; expiresAt: string;
  resources: Array<{ id: string; kind: "skill" | "expertTemplate" | "managedConnector" }>;
  addedTools: Array<{ ref: string; effect: "read" | "write"; schemaDigest: string }>;
  removedTools: string[];
  blockers: Array<{ code: string; resourceId?: string }>;
};
type PackageInstallDTO = {
  installId: string; packageKey: string; version: string; artifactDigest: string;
  revision: number; generation: number;
  status: "enabled" | "disabled" | "uninstalled";
  readiness: "ready" | "needs_connection" | "needs_grant" | "unavailable";
  blockers: Array<{ code: string; resourceId?: string }>;
  allowedActions: Array<"plan" | "apply" | "grant" | "createExpert" | "disable" | "enable" | "uninstall">;
};
type PackageInstallDetailDTO = PackageInstallDTO & {
  resources: Array<{ id: string; kind: "skill" | "expertTemplate" | "managedConnector"; available: boolean }>;
};
type PackageGrantDTO = {
  installId: string; botId: string; revision: number;
  resources: PackageGrantInput["resources"];
};
type PackagePage = {
  items: Array<{
    packageKey: string; version: string; displayName: string; summary: string;
    category: string; install: PackageInstallDTO | null; installable: boolean;
  }>;
  nextCursor: string | null;
};
```

字段 name 最长 120 字符、search 最长 200 字符、cursor 最长 2048 字符；HTTP JSON body 最大 128 KiB。所有 revision/generation 使用正安全整数，null 只允许表示当前无安装/无授权修订。blockers.code 使用 shared 中封闭枚举，不能透传供应商异常；readiness 按 unavailable → needs_connection → needs_grant → ready 优先取值，另保留完整 blockers，ready 表示当前请求人有至少一条明确可用的包资源，具体工具仍逐次检查。disabled/uninstalled 均为 unavailable。

### 7.2 内部运行契约

`PreparePackageRunInput` 包含 botId、runId、attemptGeneration 和服务器从该 Bot/任务配置解析的 installIds；`PackageRunSnapshot` 包含 runId/attemptGeneration 和每个 pin 的 installId、installGeneration、revision、artifactDigest、resourceDigests、grantRevision、allowedToolRefs。`RunWriteTx` 是当前 Run 数据写事务，不另借连接。

`BeginPackageDispatchInput` 包含 runId、attemptGeneration、toolCallId、bindingId 和规范参数对象；bindingId 只能解析到该 Run snapshot 中的工具。`DispatchResult` 是 succeeded/failed/unknown 的带标签结果，含既有工具 receiptRef 与 effectStatus（none/confirmed/unknown）；failed 不能暗示外部效果必为 none。`DispatchPermit` 只在进程内签发，completeDispatch 即使发生撤权也允许按原 operation 写回真实结果，不能以已撤权为由丢失已发生效果。

错误：401 AUTH_REQUIRED；400 INPUT_INVALID/SCOPE_REQUIRED；403 已确认当前范围内的管理权不足；404 RESOURCE_NOT_FOUND 对不存在、跨租户、跨团队同形；409 REVISION_CONFLICT/PLAN_CHANGED/IDEMPOTENCY_CONFLICT；410 已有权计划过期；422 PACKAGE_UNSUPPORTED/INVALID；503 PACKAGE_STORAGE_UNAVAILABLE/ADMIN_CHANNEL_UNAVAILABLE。未知安装的错误不得泄露其真实状态。详细 readiness 仅在安装可见后返回。

## 8. 安装事务与专家资源装配

plan 阶段只读、无外部效果：检查包已发布、制品存在、资源合法、范围资格、输入配置、connector 引用、权限增量，保存规范输入及 digest。连接未就绪可形成安装计划，但 DTO 明确列出阻塞。包要求的 connector 未登记时拒绝计划，管理员先经原连接管理流程启用。

apply 阶段：先在事务外验证本地不可变制品，再进入管理写事务；按既有成员锁序、包 release 锁、范围 package key、install ID 的固定顺序加锁；重验操作者、计划未过期、包未撤回、current revision 和输入摘要。锁住同一个 plan 及 actor 的幂等键；先查 changes 的幂等回执，再判断计划有效期。同键同规范请求返回已提交 result（即使计划之后过期），同键异请求拒绝。已消费 plan 以其他键重放时返回其原结果，不重建资源，并将新键作为独立幂等回执记录。写 install/revision、资源映射和 change event，最后标 consumed，同一事务提交。事务里不请求 MCP、OAuth 或下载 Git。两个不同 plan 并发安装同一包，唯一键下只生成一份安装；配置不同返回冲突而非覆盖。

新增锁按统一优先级排列：沿用 tenant → principal → membership → workspace-membership 后，再取 release(packageKey/version) → packageKey(tenant/workspace/package) → install → grant(bot/resource) → connector-install → connection → operation；同类多个 ID 按 UTF-8 排序。只涉及后几级的操作无需补取前面未用的资源锁，但不得反向加锁。幂等键锁在资源操作前、成员锁之后统一取得；所有路径使用同一辅助函数，锁超时 2 秒、语句超时 5 秒，不在持锁期间进行供应商网络等待。

Skill 的包内容作为不可变版本资源读取，不把每个版本写入全局 slug 表；用户选择“复制编辑”才由既有 Skill 写入方生成私人 Skill。`resource_links.existing_skill_id` 仅用于 legacy 迁移，包资源引用优先使用 release+resourceId。`/` 别名按当前范围和 Bot 显式设置，冲突要求选名；不得覆盖他人全局 slug。

专家模板 strict JSON 只含 name/summary/systemPrompt/包内 Skill refs。创建专家是安装后的独立动作；它也以 changes 的 actor+幂等键锁定，在同事务存请求摘要和结果 agentId，重放不重新创建。为 `AgentProfileStore` 提取受限 `createWithin(executor, actor, input, { agentId, mode: "built_in" })`，既有 create 委托它；固定服务端 agentId 与 operation key。新增 Bot 的 profile、企业 Bot ownership、模板来源和初始 Skill 包 grant 必须在同一管理事务写入；ownership 模块提供 `createBotWithin`。强制 built_in，不能因部署 managedConfiguration 把模板悄悄变为 remote Bot。包自身没有 endpoint/auth 字段。连接器工具 grant 仍需单独明确选择。

agents/profile 的受限写固定采用新函数 `openbot_create_package_expert`：只允许创建 built_in 和当前 actor 拥有的 private profile，拒绝 endpoint/auth；在同一事务重验 app.* 绑定的公司/团队、tenant_admin 与有效成员资格。函数由受控迁移建立，固定 search_path=pg_catalog、全限定表名、无动态 SQL，PUBLIC 零 EXECUTE，仅 ob_ent_operator 获 EXECUTE；不授予它对全局 agents/profile 的任意 INSERT/UPDATE。createWithin 调用该函数，ownership 与来源/grant 由各自模块在同一事务继续写入。需真实角色和伪造归属参数测试；禁止用默认 Database 绕过管理事务。

## 9. 运行时接入与撤权语义

新增 `PackageRuntime.prepareWithin(tx, scope, {botId, runId, attemptGeneration}) -> PackageRunSnapshot`，由 Run 写入方在同一个受限数据事务内创建 Run、pin 和待执行 outbox，提交前不能启动模型；重试同 attempt 返回相同 pin，新 attempt 沿用原任务允许的包版本，不静默升级。DTO 给模型只含已授权资源摘要，完整 Skill 按需加载前再检查 pin 与权限；连接 token 永不进入模型。

`grantedTools` 和 `grantedSkills` 接受服务端签发的包上下文；`PluginStore.callTool` 通过带标签的内部执行上下文区分 legacy/package。package 分支必须依次核对 Run/attempt lease、原范围、Bot ownership、pin、包是否撤回、install enabled/generation、范围 grant、工具 schema/effect、连接 generation、账号实际权限、ActionPolicy 与审批。不能退回 legacy decide，也不能回退部署凭据或 Bot 发布者账号。

当前 enterprise_bot_ownership 对底层 agent_id 全局唯一，不能据此声称同一个逻辑私有 Bot 已支持多范围执行。V1 可绑定有可信业务归属的专家 Bot；逻辑私有 Bot 只有在 ADR 0006 的实际执行范围解析已接线时才能绑定，否则返回 PACKAGE_BOT_SCOPE_UNAVAILABLE，不能复制其身份来绕开约束。V1 包调用只选择当前调用者本人在原范围授权的连接；团队共享账号需接入既有受控共享使用合同后另行开放，不能借用管理员或模板发布者账号。连接 transport 由 `resolveManagedAccess(scope, {connectorInstallId, connectionId, botId, toolRef})` 生成仅在进程内可用的访问对象，复用现有受管端点、vault 和 transport 适配器；不能把包中的 URL 当目标，也不能仅传旧 `credentialActorId` 代替范围检查。CLI/后台从服务器持久 Run 归属重建可信 Scope；客户端 callback 必须携带绑定 Run/attempt 的既有认证，提交 installId 本身不授予权限。

所有进入包执行链的路径都要接入：`plugins/tools.ts`、`plugins/routes.ts` call、`app.ts` 内部 call、审批恢复、定时/责任任务、memory ingestion。任务将逐个记录“支持包执行”或“明确拒绝”的接线状态。尚无受管 Run 的 ingestion/后台入口返回 PACKAGE_RUN_REQUIRED，不为兼容而伪造 Run；其原 legacy 能力仍按原合同处理。未携带包上下文的调用只可走明确 legacy 业务路径；多租户包资源一律拒绝。外部黑盒 Bot 没有服务端受管工具回调时显示该包不支持该 Bot。

为解决检查与撤权竞态，调用创建 `package_dispatches`：`prepared → dispatched → succeeded/failed/unknown`，也可在派发前变为 cancelled。`dispatched` 的 CAS 事务是允许发送的线性化点，使用与停用/撤回相同的锁序，重验所有 generation 和授权；事务提交后才交 transport，网络等待不持 DB 锁。停用只保证此后未 dispatched 的调用不再发送；已 dispatched 调用可能已经产生外部效果，保留结果并显示核对状态。进程在派发记录后崩溃、或写动作超时均为 unknown，不自动重发；供应商有已验证幂等协议时才按原 operation ID 核对/重试。既有审批执行器仍决定是否可执行，本表只记录包调用与 pin 的派发关联。

## 10. 升级、回滚、卸载与全局撤回

升级采用精确目标版本，不在请求里解析 latest。plan 比较资源、工具、effect、连接要求与配置；apply 成功后 CAS 切 current revision。旧 Run 保留旧 revision；已撤销/移除的工具立即不可调用，新工具仅对重新授权的新执行可用，权限取“pin 的允许集合 ∩ 当前有效 grant”。相同工具名的 schema hash/effect 增强同样视为能力改变。

回滚复用 upgrade plan，目标必须仍 published 且本地存在；新建 revision，revision/generation 永不减小。包配置 V1 无自动迁移脚本，Schema 不兼容时管理员提供完整目标配置后重作计划。旧 Run 的只读配置从旧 revision 读取，账号与凭据始终重验当前可用性。

停用/卸载增加 generation 并撤销当前 grant；重新启用/安装要求重新确认 grant，旧审批不会恢复。卸载不删除用户已编辑 Skill、创建的 Bot、任务结果、连接账号或共享 connector install；这些资源由各自领域操作。UI 给出明确影响和关联资源链接。

全局撤回以 release 锁与 dispatch 事务串行化；撤回后所有安装与旧 Run 都不能新派发此版本。目录下架仅影响发现，不改变已安装版本运行资格。制品 GC 至少保留所有被安装 revision、Run pin、unknown 操作及审计保留策略引用的版本；V1 无自动 GC，防止误删恢复依据。

## 11. Web 交互与客户端缓存

复用现有 `/admin/market` 市场入口，增加“插件包”和“本范围已安装”视图，保持专家/Skill 旧分类兼容。安装流程为详情 → 范围与能力预览 → 确认安装 → 显示未就绪连接与 Bot 授权下一步。设置页继续完成真实账号连接；不在包对话框收集供应商 token。

新查询 key 包含 tenantId/workspaceId/principalId；详情还含 installId/revision，安装预览以 planId 标识。切换范围取消旧请求，清空待确认计划；迟到响应只能写回旧范围 key。UI 依赖后端 allowedActions/readiness，未装配能力显示原因。所有新增文案提供 zh-CN/en；键盘可完成预览、确认、错误恢复，pending 禁止重复提交但服务端仍保证幂等。

移动/桌面只消费 shared DTO，V1 显示只读能力与真实状态；没有管理实现时不宣称可安装。完整个人模式接入前，新企业页面不把 legacy 私人安装显示成某个团队已安装。

## 12. 迁移、部署与回退

采用 expand → shadow-read → pilot → cutover。迁移编号由实施时最新 Drizzle journal 分配，不占用当前并行会话编号；受限角色 DDL 与测试迁移任务按仓库 multitenancy 迁移工具同步维护，生产仍由现有正式迁移入口执行，不用测试工具写生产库。

1. 导出现有目录、expert_installs、Skill 内容、grants、企业 connector installs 的 ID/哈希清单。dry-run 只生成映射及不可判归属报告。
2. 现有 CATALOGUE_* 导出为内置包；保留旧 slug 映射。只有内容哈希完全匹配且范围归属有权威证据时建立 legacy resource link；私人编辑不覆盖，缺范围保持 legacy。禁止从同一个 Bot owner 猜公司/团队。
3. 新旧读取影子比较，仅比较相同范围内的可见集；记录差异，无双写。新包安装由新模块独占，旧路由不能同时写同一 package install。
4. 部署开关 `OPENBOT_PACKAGE_MARKETPLACE_ENABLED=false` 默认关闭；`OPENBOT_PACKAGE_PILOT_WORKSPACES` 为 JSON 数组，元素仅含 tenantId/workspaceId，默认空数组，不接受通配符；不在名单内的新包安装入口不可用。已有 pin 的治理与回执不受此入口开关关闭影响。开启前检查制品库、数据库角色、迁移、范围解析、连接与 Run 接线及测试。首批只对明确团队启用。
5. 回退关新安装/升级入口，保留新表和调用治理；已开始的包 Run 仍按原 pin 跑或安全暂停。不能将包 Run 降级为 legacy 调用；不执行删表回退。

## 13. 适配外部插件格式

V1 的规范运行格式为 openbot.plugin.json。V2 可增加离线 Cursor/Codex 导入器：固定仓库 commit，读取清单、skills 与展示资源，输出候选 OpenBot 包和转换报告，再走同一审核发布流程。rules/agents/commands/hooks、stdio MCP、App connector ID、任意网络配置均须逐项标为 unsupported 并拒绝发布，不能静默忽略后声称完整兼容。受管 MCP 仅在其端点与本部署已审核目录匹配时转换为引用。最终运行身份是生成的 OpenBot 包版本和摘要。

## 14. 验收与可观测性

| ID | 必须观察到的结果 |
| --- | --- |
| A01 | 相同版本相同内容摘要稳定；同版本异内容、路径逃逸、symlink、超限包、未知格式拒绝 |
| A02 | 两个团队/两家公司安装同一包互不继承配置、连接、grant；跨范围 ID 与不存在同形 |
| A03 | 并发/重复 apply 只建一份安装；同幂等键异输入、过期计划、修订变更均正确拒绝 |
| A04 | Skill 声明工具、仅安装、仅连接账号均不能越过 Bot grant；秘密不出现在预览/日志/模型 |
| A05 | 通过全部实际入口撤权后不再有新 dispatch；撤权前已 dispatch 的效果有回执或 unknown |
| A06 | 升级新增工具/schema/effect 需重新授权；旧 Run 不装载新 Skill；回滚不复活旧 grant |
| A07 | 审批期间改参、切范围、断连接、换代次后旧提案不能执行 |
| A08 | 卸载保留 Bot/私人编辑/运行证据；共享 connector 不被另一包卸载破坏 |
| A09 | 旧安装迁移不丢私人改动，不猜范围；回退不把包 Run 变成 legacy |
| A10 | 创建专家幂等且 profile/ownership/包 Skill grant 原子一致；禁止远端 endpoint 注入 |
| A11 | Scope 快速切换与迟到响应不污染新范围缓存；中文英文、键盘与失败重试正常 |
| A12 | 缺制品、operator、测试数据库或受限角色时明确不可用/blocked，不以 skip 或空报告当通过 |

记录 packageKey/version/digest、scope IDs、install/revision/generation、Run/attempt、operation、grant revision 和脱敏 error code。成功率、安装冲突率、readiness 阻塞、撤回拒绝和 unknown 数量可聚合；不记录参数正文、token 或原始供应商错误。指标是派生观测，安装与调用事实分别以对应表和既有领域回执为准。

## 15. 完成判据

实施计划（本地工作区计划；远端以本父 Issue 的完整快照为依据）中 V1 所有任务 verified；A01–A12 有同一交付版本上的证据；受限角色真实 DB 测试和入口行为通过；独立 Spec/质量 Review 与完整范围 OCR 无有效 critical/high/medium；最终 diff 范围明确。个人模式、外部导入和开放发行分别记录后续范围，不计入 V1 已支持能力。

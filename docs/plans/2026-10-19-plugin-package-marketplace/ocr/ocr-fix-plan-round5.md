# OCR round4 编号修复计划 — round5

依据：`ocr/round4.json`（exit=0，status=partial：51 项中 36 完成、15 项 provider 429 未审；30 findings = 0 critical / 0 high / 8 medium / 22 low）。
R4 修复面在已审 36 项中零复发；未审 15 项（含 install-service/use-package-scope/contracts 等修复目标文件）由 round5 全量重审覆盖。
范围口径不变：`--exclude 'docs/plans/**,plugins/.artifacts/**'`。

## 修复项

| # | 严重度 | 位置 | 内容 | 角色 |
|---|---|---|---|---|
| R5-1 | medium·security | `server/src/enterprise/plugin-packages/routes.ts:229` | 手写 `text.length`（UTF-16 码元）近似 128KiB 字节上限，绕过仓库统一防线（其余 15+ 路由模块用 `hono/body-limit`）。改用 `hono/body-limit` 中间件（128*1024 字节精确口径），保留既有 content-length 预检兼容；测试补多字节请求体按字节口径拒绝 | backend |
| R5-2 | medium·documentation | `server/src/enterprise/tenancy/admin-separation.ts:497` | `authorizeAndRecordCompanyManagementAction` 生产零调用（grep 实证）。**裁决：文档披露，不接线**——插件包写通道按 Spec 走 `CompanyAdminContext`（assert+resolve），域内审计=同事务 `enterprise_package_changes` 回执（PKG03/04 已测）；组合入口是跨面管理动作（MT019 族）的既定 seam，当前无生产消费方。头注释/模块注释如实写明：意图消费方、当前集成状态、plugin-packages 为何不经它。零行为变更 | backend |
| R5-3 | medium·bug | `scripts/plugin-packages/build.ts:56` | 同一 packageKey 多版本目录条目共享单一源目录：1.0.0/1.1.0 摘要不同而源只有 1.1.0 内容，构建必败；且缺 manifest↔索引身份校验。**裁决**：仅构建与源 manifest version 匹配的条目（摘要必须相符，保持既有失败语义）；同 packageKey 历史版本条目不参与构建：artifact store 中存在则校验摘要并报 `verified-historical`，缺失则显式 warn（数据完整性提示，不判构建失败——历史不可变制品本就不由当前源重建） | backend |
| R5-4 | medium·security | `server/scripts/multitenancy/migrate-test.ts:2498` | PKG02 package_hardening 三个递归秘密载体 CHECK（revision.config / plans.canonical_input / changes.diff）`like_regex` 缺 `flag "i"`：`"Token"`/`"API_KEY"` 变体可穿透 DB 级防线（PKG04 强化函数已带 i，同一漏洞家族）。**追加新步骤**重建三 CHECK 加 `flag "i"`（既有行不受影响，CHECK 仅约束写入）；核对镜像/parity 是否触及 | backend |
| R5-5 | medium·bug | `app/src/components/market/package-grants.tsx:84` | useEffect 以 `detail.data` 对象引用为依赖：revoke/grant 成功后 invalidate→refetch 新引用→重置正在输入的勾选（round3 parked low 升级）。改为以安装的身份字段（grantRevision/generation）为再播种依据，对象引用变化不再清空进行中选择。测试：对 Bot A revoke 期间 Bot B 勾选保留 | frontend |
| R5-6 | medium·maint | `app/src/components/market/package-experts.tsx:167` | 原生 `<a href={/bots/${agentId}}` 整页刷新绕过 SPA 路由（round3 parked low 升级）。改 TanStack `Link to="/bots/$agentId" params={{agentId}}`（对齐 agent-card.tsx 既有模式） | frontend |
| R5-7 | medium·bug | `app/src/components/market/package-experts.tsx:99` | 向导把安装的"全部 skill 资源"当"本次将授予"展示，服务端实际只授模板声明 skills（`PackageExpertTemplateSchema.skills` ⊆ 修订全部；`PackageExpertCreatedDTO.resources` 为实际集）。展示改为模板声明的 skills 并注明与修订全集的关系；测试覆盖子集场景 | frontend |
| R5-8 | medium·bug | `app/src/components/market/package-detail.tsx:302` | 事实块读列表行传入的 install prop，而 grant/revoke/expert-create 只 invalidate `installDetail`：同对话框内变更后下方区域读陈旧列表缓存。修复按 openbot-data-access 精确失效纪律：变更同时失效 scoped list 键，或详情框改读 `installDetail` 查询（实现者按技能规则择一，保持单一来源）。测试：grant 后同对话框事实即时一致 | frontend |

## Parked（round4 22 low 不扩面；沿 round3/4 纪律，attempt JSON 留痕）

round4 的 22 low 与 round3 已 park 项高度重叠（i18n 孤儿键、RunWriteTx 重复、operator 降级静默、N+1、jsonbDocument 拷贝、测试支撑类等），维持 park；其中已升级为 medium 的 4 条（R5-1/R5-5/R5-6/R5-4 对应项）本轮修复。

## 流程

backend（R5-1..4）/ frontend（R5-5..8）并行 → 主控 fresh 复核 → 独立 reviewer 只读复审 → cp23 → OCR round5 全量（必须覆盖 round4 的 15 个 429 未审文件）→ 有效 critical/high/medium 归零后收口 final-report。

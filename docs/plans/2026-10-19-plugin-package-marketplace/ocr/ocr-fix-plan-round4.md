# OCR round3（attempt4）编号修复计划 — round4

依据：`ocr/final-round3-attempt4.json`（exit=0，status=partial：51 项中 40 完成、11 项因 provider 429 未审；37 findings = 1 high / 10 medium / 26 low / 0 critical）。
范围口径：`--exclude 'docs/plans/**,plugins/.artifacts/**'`（= cp21 检查点既有规则：派生证据不入评审；交付源码全覆盖）。
11 个未审文件（grants/store/plans/experts/manifest/artifact/catalogue/build + 插件夹具 + marketplace.json）与本次修复面重叠，round4 全量重审覆盖。

## 修复项（全部进入本轮）

| # | 严重度 | 位置 | 内容 | 角色 |
|---|---|---|---|---|
| R4-1 | high·maint | `server/src/db/schema/enterprise-plugin-packages.ts:112-116` | 镜像补 `enterprise_package_install_scope_id_uq`（installs (tenant,workspace,id) 唯一索引） | backend |
| R4-2 | medium·maint | 同上 `:451-460` + `server/scripts/multitenancy/migrate-test.ts:2563` | grants 权威 DDL 与镜像的 PK 均缺 `tool_ref`，与活跃唯一索引及其注释（one row per tool）矛盾。以**追加步骤**重建 PK 为 6 列（含 tool_ref）；既有行 tool_ref 全为 ''，对存量等价、唯一性放宽（expand-compatible）；镜像同步；parity 测试更新 | backend |
| R4-3 | medium·bug | `server/src/enterprise/plugin-packages/install-service.ts:640-643` | apply() 写 linkRows 前未在事务内复验 `canonical.connectorInstalls` 映射的 connector install 仍存在（plan→apply 最长 10 分钟窗口，FK restrict 会以裸 FK 错误暴露）。事务内复验，缺失返回品牌化 packageError；新增驱动层测试（plan 后删 connector → apply 拒绝且零 link 行） | backend |
| R4-4 | medium·security | `server/scripts/multitenancy/migrate-test.ts:2760` | `openbot_create_package_expert` 敏感键防线仅顶层 `?|` 且大小写敏感：嵌套 `{"remote":{"endpoint":…}}`、`"Token"` 变体可穿透进 default_config。改为递归 + 大小写不敏感扫描（对齐 package_hardening 既有递归 CHECK 风格并加 `i` 语义）；新增驱动层直调（operator 角色）测试 | backend |
| R4-5 | medium·bug | `server/src/index.ts:1149-1152` | marketplace 索引路径硬编码无环境覆盖（对照 `config.pluginArtifactRoot` 已有 env 先例，config.ts ~:2947）。config 增加 `pluginMarketplaceIndexPath`（env `OPENBOT_PLUGIN_MARKETPLACE_INDEX`，默认保持现解析不变）并接线；Docker 镜像未 COPY plugins/ 的部署缺口记录归 PKG11（受阻票，不在本轮） | backend |
| R4-6 | medium·maint | `server/src/db/schema/enterprise-plugin-packages.ts:785-788`、`:29`、`server/drizzle.config.ts:40` | 镜像 changes.action CHECK 对齐权威（已含 'createExpert'）；头注释表数/编号与实际八表对齐；drizzle.config 与镜像头注释的"generate source"定位矛盾按 F1 既定裁决改写（parity 守卫下的受控 generate 源） | backend（随 R4-1 同文件） |
| R4-7 | medium·bug | `app/src/lib/plugin-packages/use-package-scope.ts:38-43` | 吊销判定只查 company 层，漏 team 层（selection.ts `findSelection` L185-203 要求 company+team 均在 listing）。对齐双层级判定 | frontend |
| R4-8 | medium·bug | `app/src/components/market/packages-page.tsx:13-14`（及 market.tsx、package-pane.tsx） | `listingPending`/`listingError` 已由 usePackageScope 返回但未被消费：列表失败时误报"未选择团队"。解构并透传 PackagePane，区分加载中/失败/未选择三态 | frontend |
| R4-9 | medium·maint | `app/src/components/market/package-install-dialog.tsx:67-69` + `shared/enterprise/plugin-package-contracts.ts:288` | SECRET_LOOKING_CONFIG_KEY 正则逐字复制未导出（对照 PACKAGE_CONFIG_LIMITS 的导出先例与注释理由）：从契约导出并改为导入 | frontend |

## Parked（low，26 条，裁决记录）

- 孤儿 i18n 键 `search.packages`（en/zh）：无害，留待 PKG06 版本选择 UI 复用或删除；不属本轮。
- `<a href>` 绕过 SPA 路由（package-experts.tsx:167）：交互等价，记 follow-up。
- grants mutation 失效键不含列表项 readiness（package-grants.tsx:105）：列表下次刷新收敛，行为正确性无碍；PKG05 readiness 语义扩展时一并处理。
- role 字面量比较无编译期保护（use-package-scope.ts:55）：R4-7 触碰同文件，若顺手可收敛类型，不强制。
- 其余 low（PACKAGE_ROOT 重复、RunWriteTx 重复、operator 降级静默、uniqueViolation 结构化字段、128KiB 码元近似、readPinnedSkills N+1、jsonbDocument 第 6 份拷贝、noNestedSecretCarriers sql.raw 引号、测试支撑位次映射/命名空间过滤/遮蔽/import 位置/未读字段/EXPLICIT_GROUPS 静默过滤、like_regex 大小写、UPDATE 全列授权、actorSubjectOf undefined、嵌套三元、工具函数三处重复、allowed_resource_ids 元素类型）：逐条已在 attempt4 JSON 留痕，均非阻断；与既往两轮 park 纪律一致，不在本轮扩面。

## 流程

1. backend（R4-1..R4-6）与 frontend（R4-7..R4-9）实现者并行（文件不相交）。
2. 主控 fresh 验证：native + driven（真实受限角色）+ typecheck + biome；R4-2/R4-4 的 DDL 变更需对测试库重放（journal 追加步骤）后全绿。
3. 独立 reviewer（只读）分别出 SPEC/QUALITY 结论。
4. cp22 检查点绑定；OCR round4 全量重审（同 exclude 口径）；有效 critical/high/medium 归零后收口 final-report §4a。

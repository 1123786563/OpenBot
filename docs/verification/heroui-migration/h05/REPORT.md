# H05 (#448) — 模型目录、网关与凭据管理（admin 域）迁移报告

状态：implemented（workspace 增量，无 commit）；BASE `203d0f0244b2`，分支 `feat/heroui-v3-migration`。
工作区：`/Users/wuyongjun/trea/OpenBot/.worktrees/heroui-migration`。
检查点产物：`POST-CHECKPOINT.sha256`（本域 4 个改动文件）；全量 native 证据 `native/`；域内定向 native 证据 `native-domain/`；命令日志 `evidence/`。

## 域起点事实（决定本轮 delta 形态）

四个路由与 `model-billing-paths.tsx` 在 BASE 即已直接消费 `@/components/ui/*`（H03 后已是 HeroUI v3 适配层，导出面冻结）：无 `@base-ui`/`@radix-ui` 残留（grep 全域 0 命中）、无裸 `<button>/<select>/<input>` 表单元素、无 `bg-muted` 遗留 token（本轮全仓 token 更名面 `bg-muted→bg-ob-muted-surface` 在本域 0 处）。链接面：本域无链接控件（grep `href|ButtonLink|Link` 0 命中），不涉及 ButtonLink 迁移。

因此本轮 H05 是**验证 + 调用端修正**：修正 Select 空值合同违规（AC3），其余为 biome 机械格式化。不涉及共享文件、不涉及 ui/*。

## 变更清单

| 文件 | 变更 | 要点 |
| --- | --- | --- |
| `app/src/routes/_authed/admin/bot-services.tsx` | Select 空值守卫 + biome 格式 | 注册对话框 kind Select 删除 `value as "builtin" \| "external"` 强转：`onValueChange` 收到 `null`（Select 的"无选择"）时直接丢弃，保持表单原答案，不再把空值铸成 kind（AC3；与已迁移调用端 `tenant/selection.tsx`、`bot-profile/sharing.tsx` 的 null 守卫约定一致）。带 why-comment。 |
| `app/src/routes/_authed/admin/credentials.tsx` | 同上 | 新增凭据对话框 kind Select 删除 `value as "model" \| "connector"` 强转，同 null 守卫（AC3）。 |
| `app/src/routes/_authed/admin/gateway.tsx` | 无行为变更 | biome organize-imports + 行宽格式化（`GATEWAY_REASON_CODES`、Button props 换行）。 |
| `app/src/routes/_authed/admin/model-catalog.tsx` | 无行为变更 | biome organize-imports + 行宽格式化。 |
| `app/src/components/admin/model-billing-paths.tsx` | 无变更 | biome 已 clean；native 测试 2/2 绿（`native/report.json`）。终态 sha256 `52762cd45d1faab273700464c78deb3dcf7d4b1f4c69f9c3c1b5b05898b4b900`。 |

不改动（越权清单均未触碰）：`ui/*`、`package.json`/`bun.lock`、`main.tsx`/`__root.tsx`、`styles/*`、`lib/theme.ts`、settings/plugins/memory/passwords/delivery 域。

## AC 状态

### AC1 模型开放/停用、供应商配置、已登记 Bot 增改查 — PASS（组件/单元级）

- 模型开放/停用：`model-catalog.tsx` 列表动作走 `setScope` mutation（open/closed + 必填 reason 弹窗，`:236-278`），同步按钮 `runCatalogSync`（`:151-159`）；价格未知模型的 open 按钮 `disabled={model.priceStatus === "unknown"}`（`:221`，v3 Button `disabled→isDisabled` 映射，禁用样式 `disabled:opacity-50 disabled:pointer-events-none`）。admin-catalog-sync-ui 4/4（driven 层）。
- 供应商/网关配置：`gateway.tsx` endpoint/rate/credential/probe 四条 mutation 路径全保留；admin-gateway-readiness 4/4（driven 层）。
- 已登记 Bot 增改查：`bot-services.tsx` register/edit/status 三 mutation + 两对话框；router.test.ts（driven 层）"protected credential administration route" 等路由合同 6/6。
- 网关/Key 协议与服务端合同零改动（只动调用端 UI）。

### AC2 凭据新增/更新/删除/撤销；遮罩、不读回、取消清理 — PASS（保留现能力）

- 遮罩：plaintext `type="password"` + `autoComplete="off"`（credentials.tsx `:238,:245`）；gateway 管理密钥 `type="password"` + `autoComplete="new-password"`（gateway.tsx `:349-353`），成功后 `setAdminKey("")` 清空、页面只回显 fingerprint（`:370-376`），无明文回读路径。
- 不读回：列表只渲染 provider/kind/keyId/revoked 状态（credentials.tsx `:329-337`）；`CredentialStatus` 查询类型不含明文字段。
- 取消清理：对话框受控关闭（`setAdding(false)`），与 BASE 行为一致（表单在页面级、`form.reset()` 仅成功后调用，行为未变）；gateway 明文字段成功即清空、失败保留可重试。
- 撤销：已撤销项按钮禁用（`Boolean(credential.revokedAt) || revokeCredential.isPending`，`:343`）。撤销无确认弹窗为 BASE 现状，AC 原文"按当前能力验收"，未新增 UI。
- 危险操作确认与焦点返回：model-catalog 开放/关闭的状态变更确认弹窗保留（必填 reason）；焦点返回由 dialog.tsx 适配层受控路径 restoreRef 承担（H03 交付，本域全部对话框均受控 `open`+`onOpenChange`）。

### AC3 模型选择 null/数字/字符串 ID 区分；失效/禁用项明确 — PASS（本轮修正点）

- 空值语义：两处 `value as <union>` 强转删除，null 不再被铸成合法 kind（见变更清单）。本域 Select 值均为字符串领域值；数字/null ID 的 `keyForValue/valueForKey` 区分由 ui/select.tsx 适配层承担（H03 冻结面），本域不越层处理。
- 禁用项明确：price-unknown 模型 open 禁用（`:221`）；Select 禁用项 `disabled→isDisabled→data-disabled:opacity-50`（适配层）。

### AC4 权限不足/验证失败/网络失败/提交中状态；一次点击一次提交 — PASS

- 权限/网络失败：四路由均有 mutation `.error` 渲染 `role="alert"`（credentials `:278-282`、gateway 各 section、model-catalog 经 refusalKey 归化的 `problem`、bot-services `:407-411`）；列表加载失败有 `loadError` 行。
- 验证失败：TanStack validators + `FieldError`（credentials/bot-services），gateway 本地 `baseUrlProblem`/rate/credential problem 全保留。
- 提交中：全部提交按钮 `disabled={…isPending}` + pending 文案（credentials `:301`、bot-services `:430,:581`、model-catalog `:151,:274`、gateway 四处）；一次点击一次提交由 pending 禁用承担（与 BASE 同一机制，未引入回归）。

## 验证（命令 + 真实 exit code）

| 项 | 命令（仓库根，除注明） | 结果 | 证据 |
| --- | --- | --- | --- |
| typecheck（本改动后首轮） | `cd app && bun run typecheck` | **修正（W3A 复审 F1）**：原记 EXIT 0 与所引日志矛盾——该日志含 2 个 H04 草稿文件 TS 错误且未记录 exit code，不能佐证 EXIT 0。本域文件 0 TS 错误的结论由 W3A 复审独立复跑佐证（typecheck EXIT 0，见 `../reviews/REVIEW-W3A-2026-10-20.md` Deliverable 3 独立复跑） | `evidence/typecheck-post-edit-exit0.log`（含 H04-transient 错误）+ W3A 复审复跑 |
| typecheck（收尾复跑） | 同上 | **EXIT 2** — 11 个错误跨 6 个文件（修正 W3A F2：原记 5 个/3 文件低估；含 h04-preload-b.ts、h04-probe-a/b.test.tsx、h04-probe-c/d.test.tsx、h04-probe2.test.tsx），为并行 H04 实施者当前工作文件（TDD RED 进行中），与本域 0 文件交集；本域无 TS 错误 | `evidence/typecheck-final-h04-transient.log` |
| build | `cd app && bun run build` | **EXIT 0**（`✓ built in 7.26s`） | 会话输出 |
| native 全量 app 域 | `E2E_UNIT_SCOPE=app E2E_UNIT_OUTPUT=docs/verification/heroui-migration/h05/native bunx e2e run --config e2e.unit.config.ts`（仓库根；在 app/ 内跑=空集） | **EXIT 1**：997 执行 = 984 pass / 13 fail / 0 skip；13 失败全部不在本域（见下节归因）；本域可收集文件（model-billing-paths 2、credential-form 1）全绿 | `native/report.json` |
| 域内定向 native（改动后复跑） | `…E2E_UNIT_OUTPUT=…/h05/native-domain bunx e2e run --config e2e.unit.config.ts app/tests/model-billing-paths.test.tsx app/tests/credential-form.test.ts` | **EXIT 0**，3/3 pass | `native-domain/report.json`（已裁剪为域内条目） |
| driven 层（e2e-bun-suites 清单内，按 ADR 0008 由 Bun 执行） | `bun test app/tests/admin-catalog-sync-ui.test.tsx app/tests/admin-gateway-readiness.test.tsx` | **EXIT 0**，8 pass / 0 fail | `evidence/driven-admin-tests.log` |
| 路由合同（driven 层） | `bun test app/tests/router.test.ts` | **EXIT 0**，6 pass / 0 fail | `evidence/router-driven.log` |
| biome | `bunx biome check <本域 5 文件>` | **EXIT 0**（`--write` 修复 2 文件后 clean） | 会话输出 |

## native 13 失败归因（单变量：均非本任务引入）

| 文件 | 数 | 归因 |
| --- | --- | --- |
| `app/tests/zz-probe-context-menu.test.tsx` | 8 | Ledger 2026-10-20 全量 native 已记录的既有真回归（H02 域），本轮前已存在 |
| `app/tests/approval-team-settings.test.tsx` | 1 | Ledger 同轮记录的 H02 域组件红 |
| `app/tests/gallery-components.test.tsx` | 1 | Ledger 同轮记录的 H02 域表单红 |
| `app/tests/heroui-spike.test.tsx` | 1 | Ledger 同轮记录的 spike TextArea 红 |
| `app/tests/user-preferences.test.tsx` | 1 | Ledger 同轮记录的上下文菜单红 |
| `app/tests/h04-probe.test.tsx` | 1 | H04 域探针（model-access combobox disabled 断言），并行 H04 实施者的活动文件 |

本域四路由与 model-billing-paths 相关断言零失败；Ledger 当轮 app 域 15 红对本轮 13 红：`bots-nav-badge` 已不在失败清单（前轮修复生效），`h04-probe` 为新增且属并行 H04 文件。非本域红按 Brief"如实记录不追"。

## 遗留 / Interface 变更申请

- **无共享 Interface 变更申请**：本域未发现 ui/* 27 primitives 的能力缺口。
- `server/scripts/bootstrap-local-gateway.ts` 的 2 个 TS 错误（`GatewayProbeRun.result`）为 server 域 pre-existing（Ledger 2026-10-20 有记录），不在本任务修复，仅按 Brief 提及。
- `app/tests/h04-*` transient 红/TS 错误归并行 H04 实施者收口，本报告只记录不代改。
- 浏览器级证据（Dialog 内 Select 弹层定位、ESC 分层、焦点返回、外点关闭、scroll lock）按分工留待 frontend_validator；代码侧不阻塞：本域对话框/Select 组合与 H03 已实测的 account-mode/shared-grant dialog 业务形态同构，ESC 守卫与焦点返回逻辑在 dialog.tsx 冻结面内。

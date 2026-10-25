# PKG11 运维说明：包市场启用前检查单与回退（#470 / Spec §12）

> 面向部署者的操作手册。方案与证据入口见本 Run（`.archive/runs/2026-10-24-issue-459/`）；本文只写"怎么做、怎么验、怎么退"。
> 命令默认在仓库根执行；`plugins/` 指随镜像发布的制品库（`marketplace.json` + `.artifacts/sha256/`）。

## 0. 灰度开关语义（先读这个）

| 变量 | 默认 | 语义 |
| --- | --- | --- |
| `OPENBOT_PACKAGE_MARKETPLACE_ENABLED` | `false` | 只有字面 `true` 打开。关闭时：安装/升级计划（`POST /plans`，含 install/upgrade/rollback）、确认（`POST /plans/:id/apply`）、新建 Bot 授权（`PUT …/grants`）一律 503 `MARKETPLACE_ENTRY_DISABLED`；浏览、安装详情、派发台账、unknown 核对、撤权（`DELETE …/grants`）、停用/卸载（`PATCH …/status`）、专家实例化**照常**。既有包 Run 的 pin 治理与回执不受影响。 |
| `OPENBOT_PACKAGE_PILOT_WORKSPACES` | `[]` | JSON 数组，元素仅含 `tenantId`/`workspaceId` 精确元组。**拒绝通配符**（任何 `*`）、多余/缺失字段、空串、重复元组、非 JSON——非法值**启动即报错**（拒绝猜测名单）。开关打开但名单为空 = 没有任何团队可写。 |

矩阵证据：`server/tests/package-gating-matrix.test.ts`（3 姿态 × 11 路由面）；治理不受影响的直接证据在同套件"revoke/lifecycle/台账/核对照常"各行。

## 1. 启用前检查单（逐项通过才打开开关）

1. **制品库**
   - `bun scripts/plugin-packages/build.ts --catalog plugins/marketplace.json --out plugins/.artifacts`：每个 release 输出 verified/verified-historical，退出码 0（内置包 `openbot/legacy-catalogue@1.0.0` 应为 verified）。
   - 镜像携带：根 `Dockerfile` 与 `server/Dockerfile` 的 runtime 阶段有 `COPY plugins plugins`（含隐藏目录 `.artifacts`）。构建后抽查 `docker run --rm <image> ls /plugins/.artifacts/sha256`。
   - 缺制品的部署按真实不可用处理：目录面显示 blocker，计划/apply 拒绝，不答空目录。
2. **数据库角色**
   - `ENTERPRISE_DIRECTORY_DATABASE_URL` / `ENTERPRISE_DATA_DATABASE_URL` / `ENTERPRISE_OPERATOR_DATABASE_URL` 三个受限角色可达且通过能力校验（缺任一：写面 503，浏览仍可，启动日志 `plugin-package-operator-unavailable` 带 reason）。
   - 包表迁移已在正式迁移入口落地（`enterprise_package_*` 存在；受限角色 DDL 与测试迁移按 multitenancy 迁移工具同维护）。
3. **迁移（存量市场→包）**
   - 导出内置包：`bun scripts/plugin-packages/export-builtin.ts`（确定性；重复执行幂等；改目录常量后须 `--version` 升版本）。
   - 预演：`bun scripts/plugin-packages/migrate-legacy.ts dry-run --out /tmp/manifest.json`——只读，产出源 ID/内容哈希、映射建议、unresolved 报告（私人编辑=PRIVATE_EDIT、范围不可证=SCOPE_UNPROVEN、连接器=NO_DECLARING_PACKAGE 均**保持 legacy，不迁不覆盖**）。
   - 演练（测试库）：`apply --manifest /tmp/manifest.json --digest <manifestDigest> --tenant T --workspace W --actor <userId>`；写前 CAS 重验，源一变即整体拒绝（SOURCE_CHANGED）。同一 manifest 重放幂等。
   - 影子读取：`shadow-read --tenant T --workspace W`——同范围新旧可见集对比，只记录差异（matched/legacyOnly/packageOnly），零写入。
   - 库里已有 legacy 安装写入的全局 `skills` 行（slug 全局唯一）时迁移照常安全：apply 只建 install/provenance/grant（legacy resource link），从不写或改全局 slug，同名 Skill 不抢 slug（Spec §8）；legacy 安装与迁移**不互斥**，先后或并行均可，存量行的持有者不变。`package-migration` 演练对 held slug 幂等（F-T12-1 修复，2026-10-25）。
   - 生产执行属运维授权外：本仓库只交付工具与测试库演练（#470 边界）。
4. **范围解析**：pilot 名单里的 (tenantId, workspaceId) 必须真实存在且拟操作者为其 `tenant_admin`（apply 走生产 authorizer，非管理员即拒）。
5. **连接与 Run 接线**：受管连接器按包声明走 `enterprise_plugin_installs`（MT031 权威）；包工具仅在受管 Run 内经 pin+逐次授权执行（PKG05/09/10 各自验收），本开关不改动这些链路。
6. **测试**：native `server/tests/package-gating*.test.ts` 全绿；driven `server/tests/multitenancy/package-migration`（真实受限角色库）全绿；回归链（package chain、dispatch-call、entrypoints、unknown）全绿。

## 2. 开启

```sh
OPENBOT_PACKAGE_MARKETPLACE_ENABLED=true \
OPENBOT_PACKAGE_PILOT_WORKSPACES='[{"tenantId":"<t>","workspaceId":"<w>"}]' \
# 重启服务；启动日志应有 plugin-package-marketplace-entry { enabled: true, pilotWorkspaces: [...] }
```

试点期新装/升级/授权只对名单内团队开放；其余团队得到与关闭相同的 503（同一封闭错误体）。

## 3. 回退（关新入口）

1. 去掉（或置 `false`）`OPENBOT_PACKAGE_MARKETPLACE_ENABLED`，重启。写入口回到 503；未确认的 pending plan 一并失效。
2. **既有包 Run 不动**：继续按原 pin 治理或安全暂停（停用/撤权仍可用）；**绝不降级为 legacy 调用**——legacy 与包两套授权从不 OR 放行（PKG01–05 语义，本票不改）。
3. **不删表回退**：保留 `enterprise_package_*` 全部表与回执；不需要也不提供任何 DROP。
4. 演练证据：`server/tests/multitenancy/package-migration.test.ts` 末节（gate 关：读/撤权 200，plan 503）+ `package-gating-matrix.test.ts` 全矩阵。

## 4. 已知边界（V1）

- 连接器安装只导出清单，映射留待声明它的包出现（NO_DECLARING_PACKAGE 保持 legacy；卸载任何包都不会破坏共享连接器——link 是引用不是搬运）。
- 迁移 apply 的清单绑定是文件摘要级：换一个 manifest（哪怕同内容不同 generatedAt 之外的差异）需要重新 dry-run + 绑定新摘要。
- `plugins/marketplace.json` 由 `publish.ts`/`export-builtin.ts` 等工具在锁下原子写；演示条目随本票首次具名 `state: "published"`（语义与缺省一致）。

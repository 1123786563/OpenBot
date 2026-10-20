# OpenBot 上线方案（OpenMuse Mobile 接入交付）

> 历史方案：完整能力迁移、OpenBot 独占后端和 Git submodule 布局以 [2026-10-12 设计](2026-10-12-openmuse-frontend-openbot-backend-design.md) 为准。本文保留作迁移参考。

> 版本：v1.0
> 编写日期：2026-10-11
> 代码基线：`main` @ `fa4b67f`（移动端 BFF + EXPO_APP_SCHEME）；迁移分支 `feat/openmuse-mobile-migration` @ `8dda8a0`
> 配套设计：`docs/specs/superpowers/OpenMuse-Mobile-OpenBot-Backend-Architecture.md`
> 范围：OpenBot 后端服务 + OpenMuse Mobile 客户端的部署、CI/CD、灰度与回滚、上线检查

---

## 1. 环境划分

| 环境 | 用途 | 形态 | 数据 |
| --- | --- | --- | --- |
| **local** | 开发联调 | `bun run dev`（根脚本，app+server 并行）+ `apps/openmuse-mobile` 的 `pnpm web/start` | 本地/容器 PostgreSQL（docker-compose 的 `postgres` 服务），可 `OPENBOT_SINGLE_USER=true` |
| **staging** | 集成验收（M1/M2 里程碑真机联调） | 单容器镜像（根 `Dockerfile`）+ 托管 PostgreSQL；或 docker-compose 精简栈 | 独立库；真实 OAuth Provider 的测试租户 |
| **production** | 生产 | Helm chart（`charts/openbot`）或单容器 | 托管 PostgreSQL（含备份/PITR）；真实 IdP |

**环境不变式**：
1. 生产**禁止** `OPENBOT_SINGLE_USER=true`（集成方案 §5.3；该模式所有人共享管理员）。
2. 每环境独立 `BETTER_AUTH_SECRET`、`KEY_ENCRYPTION_KEY`（32 字节 base64，`openssl rand -base64 32`）。
3. 生产 `EXPO_PROJECT_ID` + `EXPO_APP_SCHEME=openmuse` 必须设置，否则移动端 OAuth 回跳被拒（见架构文档 R3）。
4. `TRUSTED_ORIGINS` 只加 Web 应用来源；移动端 scheme 走 `EXPO_APP_SCHEME`，不要把 `openmuse://` 写进 TRUSTED_ORIGINS（会被 CORS 段过滤，白配）。

## 2. 本地一键启动

```sh
# 1) 后端（仓库根）
cp .env.example .env          # 按需填 DATABASE_URL / OAuth / OPENBOT_SINGLE_USER=true（本地可）
bun install
bun run dev                   # Vite(app :3010) + server(:3001) 并行，--watch

# 2) 数据库（若本地无 PostgreSQL）
docker compose up -d postgres migrate

# 3) 移动端（独立 pnpm 域，见 apps/openmuse-mobile/MIGRATION.md）
cd apps/openmuse-mobile
pnpm install                  # .npmrc 已配好 package-manager-strict=false
EXPO_PUBLIC_API_URL=http://localhost:3001 pnpm web    # Web 预览 :8081
EXPO_PUBLIC_API_URL=http://10.0.2.2:3001 pnpm start   # Android 模拟器 dev build
```

**移动端所需服务端环境变量**（新增/关键项，其余见 `.env.example`）：

| 变量 | 必须 | 说明 |
| --- | --- | --- |
| `DATABASE_URL` | ✅ | PostgreSQL 连接串 |
| `BETTER_AUTH_SECRET` | ✅ | 会话签名 |
| `KEY_ENCRYPTION_KEY` | ✅ | 凭据加密 |
| `TRUSTED_ORIGINS` | Web 必须 | Web 应用 origin（逗号分隔） |
| `EXPO_PROJECT_ID` | 移动端 ✅ | EAS 项目 UUID；同时开启服务端 expo 插件与推送 |
| `EXPO_APP_SCHEME` | OpenMuse ✅ | 设 `openmuse`（默认 openbotmobile 仅供自带 mobile/ 参考端） |
| `EXPO_ACCESS_TOKEN` | 推送可选 | Expo push service bearer |
| `INTELLIGENCE_API_URL/GATEWAY_WS_URL/API_KEY` | ✅ | CopilotKit Intelligence 契约三件套 |
| `AGENT_COMPUTER_URL` + `COMPUTER_TOKEN` | Computer 功能 ✅ | 沙箱浏览器集群 |
| OAuth 四选一（`GOOGLE_OAUTH_*` 等） | 多用户 ✅ | 至少一个身份提供方 |

## 3. CI/CD

### 3.1 现有流水线（`.github/workflows/ci.yml`，直接沿用）

| Job | 内容 | 移动端接入后的增量 |
| --- | --- | --- |
| `static` | format/lint/typecheck（含 enterprise tsconfig、chart appVersion 一致性） | 无 |
| `deployables` | agent-computer / supervisor 独立 typecheck | 无 |
| `mobile` | 自带 `mobile/` 的 npm ci + typecheck | **新增同构 job `openmuse-mobile`**：`pnpm install --frozen-lockfile` + `pnpm typecheck`（见 3.2） |
| `computer-browser` | 真实 Chromium 集成 | 无 |
| 其余 | smoke / 完整 `bun test` / release | 无 |

### 3.2 需新增的 CI 配置（合入迁移分支时一并提交）

```yaml
  openmuse-mobile:
    name: openmuse mobile types
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<pin> # 与其他 job 同 pin 策略
        with: { persist-credentials: false }
      - uses: pnpm/action-setup@<pin>
        with: { version: 11.19.0 }
      - uses: actions/setup-node@<pin>
        with:
          node-version: '22'
          cache: pnpm
          cache-dependency-path: apps/openmuse-mobile/pnpm-lock.yaml
      - run: pnpm install --frozen-lockline
        working-directory: apps/openmuse-mobile
      - run: pnpm typecheck
        working-directory: apps/openmuse-mobile
```

> 注：上游 apps/mobile 未随 subtree 携带 `pnpm-lock.yaml`（锁文件在源仓根）。合入时二选一：(a) 从源仓复制该文件进本目录并固化；(b) CI 用 `pnpm install --no-frozen-lockfile`。**推荐 (a)**，保证可复现。发布工作流（`release.yml`/`publish-release.yml`）不涉及移动端打包，EAS 构建走 Expo 官方流水线（`eas.json` 已有 development/production 两 profile）。

### 3.3 镜像与发布

- **单容器镜像**：根 `Dockerfile`（app+API+浏览器一体，端口一条）；`publish-release.yml` 已有构建与推送流程，chart `appVersion` 与 `package.json` 版本联动（CI 有防漂移检查）。
- **Helm**：`charts/openbot`（含 migrate job、loki/tempo/prometheus/grafana 全套观测）；移动端接入**不需要 chart 改动**——新增的只有环境变量（`EXPO_APP_SCHEME` 等），走 values 注入。
- **移动端 App 分发**：EAS Build（development 内测 / production 商店），版本节奏独立于服务端；服务端 BFF 端点只增不改，保证旧客户端兼容。

## 4. 部署配置要点（staging/production 差异）

| 项 | staging | production |
| --- | --- | --- |
| 副本 | 1 | ≥2（server 无状态，session/活动分发均在 PG；Computer stream 代理需 ingress 会话粘性或单副本网关段） |
| 数据库 | 基础实例 | 高可用 + PITR + 每日快照 |
| `LOG_LEVEL` | debug | info（JSON 输出接 alloy→loki） |
| 观测 | compose 自带 loki/tempo/grafana | chart 同套；告警接 Grafana（`reference/observability.md`） |
| Computer | 单实例 supervisor 或共享 browser | per-Bot 沙箱（`AGENT_SANDBOX_*`）按合规要求 |
| 移动端 API 地址 | `EXPO_PUBLIC_API_URL=https://staging.example` | 生产域名 |

## 5. 灰度与回滚策略

**发布单元**：服务端镜像（chart）/ 移动端 App（EAS/商店）独立发布，**服务端先行**（BFF 与 scheme 配置向后兼容，老 App 不受影响）。

**灰度（服务端）**：
1. staging 全量回归（M1 清单 §7 + 移动端真机闭环）。
2. 生产先发 **1 副本替换**（chart `helm upgrade --set image.tag=<new> --replicaCount 保持`），观察 15 分钟核心指标：`/health`、5xx 率、`/api/mobile/*` P95、delivery 202→history 完成率。
3. 逐步放大到全量副本；任何指标越界 → 回滚。

**灰度（移动端）**：EAS internal distribution → TestFlight/内测包 → 分阶段商店发布（Expo updates OTA 只用于 JS 层热修，原生模块变更必须走整包）。

**回滚**：
- 服务端：`helm rollback <release> <revision>`（或 `--set image.tag=<prev>` 重部署）；数据库**零迁移风险**——本次交付无 schema 变更（架构文档 C.3），回滚不涉及数据。
- 移动端：商店"暂停发布 + 回退到上一版本"；服务端保持 N-1 兼容至少一个 App 版本周期。
- 配置类回滚（EXPO_APP_SCHEME 误配）：环境变量级回退即时生效，无镜像重建。

## 6. 上线前检查清单（Go/No-Go）

**安全**
- [ ] `OPENBOT_SINGLE_USER` 未在生产设置
- [ ] `BETTER_AUTH_SECRET`/`KEY_ENCRYPTION_KEY` 为独立随机值（非 .env.example 示例值——启动日志会告警示例 key）
- [ ] `EXPO_APP_SCHEME=openmuse` 且 `EXPO_PROJECT_ID` 已设；回跳 `openmuse://` 实测可达
- [ ] 越权矩阵抽测：A 用户 token 访问 B 的 channel/computer → 401/403/404（集成方案 §12）
- [ ] `TRUSTED_ORIGINS` 不含通配；CORS 仅白名单 origin

**功能（M1 验收路径，集成方案 §14）**
- [ ] 真机 OAuth 登录 → `GET /api/me` 200
- [ ] `GET /api/mobile/workspace` 返回 bots+channels
- [ ] `POST /api/mobile/conversations` 返回三标识；重复调用返回**同一** channel（direct 语义）
- [ ] Delivery 发消息 202 → history 见回复；**同 externalId 重试不重复**
- [ ] `/api/copilotkit` 流式（TEXT/TOOL_CALL 事件）；Stop/Reconnect 无重复执行
- [ ] Computer status/screenshot/stream 三件套；接管→Bot 写操作被拒（409）→归还恢复
- [ ] Web 端与移动端打开同一 channel，历史一致

**工程**
- [ ] CI 全绿（含新增 openmuse-mobile job）
- [ ] staging 数据库迁移幂等（`db:migrate` 重跑无变化）
- [ ] 观测三件套（日志/trace/指标）在本版本流量上可见
- [ ] 回滚演练：staging 执行一次 `helm rollback` 计时 < 5 分钟

## 7. 已知风险与遗留

| # | 风险 | 等级 | 缓解 |
| --- | --- | --- | --- |
| 1 | RN WebSocket 携带 cookie 的平台差异（iOS ATS/Android cleartext）可能影响 channels/events 与 computer stream | 中 | M1 联调首日优先验证；不达标则在 BFF 增加 ticket 换取（架构文档 H5 预案） |
| 2 | 并行计费线正在改 `server/src/billing/*` 与 drizzle 0065（迁移快照未配对导致 migration-journal 测试红） | 中 | 合并窗口协调：本交付无 schema 变更，冲突面小；提醒计费线补 0065 snapshot |
| 3 | `apps/openmuse-mobile` 缺 `pnpm-lock.yaml`（锁文件在源仓根未随 subtree 迁移） | 低 | 合入时从源仓复制并固化（§3.2） |
| 4 | vendored `packages/domain` 副本与上游漂移 | 低 | MIGRATION.md 已列入上游跟进清单；或转 shared 包（长期） |
| 5 | 仓库既有测试失败（缺 DB/API key 环境、guards.test.ts 的 singleUser 期望未更新——既有问题 b624ce3 引入） | 低 | 与本交付无关；建议单独 issue 修复 guards 期望与 sandboxed-save-fields 的 DB 依赖标注 |

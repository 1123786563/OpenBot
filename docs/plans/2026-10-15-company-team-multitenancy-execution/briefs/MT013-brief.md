# MT013 / Issue #57 — 实现轮 Task Brief（多租户模式显式开关与启动校验）

角色：`backend_implementer`；完成后由全新独立 Pi Reviewer 复审。前置已集成（先复算 `checkpoints/prereq-manifest.txt`，不符即 worker_done --outcome failed）。

## 目标

运维可以用一个显式开关进入多租户模式；该模式下启动会校验入口覆盖清单是否完整、是否仍存在单用户/开发绕过、数据库角色是否安全，任何一项不满足都拒绝启动而不是带着缺口上线。

## 验收标准（逐条 TDD 留证）

1. 显式开关（建议 env，如 `OPENBOT_MULTITENANCY=on`；命名与现有 config 习惯对齐，勘察后定）默认关闭；关闭时行为与现状逐字一致（回归）。
2. 开启时启动校验三项，任何一项失败 → 拒绝启动（进程退出非 0 + 明确错误，不是警告继续）：
   a. 入口覆盖清单完整（消费 MT001 inventory 输出格式：无 uncovered 入口——允许显式豁免清单但要留痕）；
   b. 无单用户/开发绕过残留（勘察现有 dev bypass 面并枚举检查）；
   c. 数据库角色安全（受限角色存在且权限面符合预期——勘察 enterprise-test-db.ts 的 ob_ent_* 形态在生产 config 下的对应物）。
3. 开关状态与校验结果在启动日志中可审计（一条结构化记录）。
4. 关闭模式（现状）不受任何影响（既有测试全绿零回退）。

## 落点与约束

- 勘察后落点建议：`server/src/config.ts` 新开关 + 新文件（如 `enterprise/tenancy/startup-checks.ts`）+ `server/src/index.ts` **启动序列段**追加校验调用（MT006 并行票拥有路由注册段——勿动对方区域）。
- 校验是只读探测（连库查询/配置读取），不写任何数据、不做迁移。
- expand-only；MT001-MT005 交付文件只读；index.ts 仅启动段追加。
- 校验逻辑必须有单元级测试（注入假 inventory/bypass/角色状态测三拒绝路径 + 通过路径），不要求真实启动整个 server 进程做集成（如可轻量做也可）。
- 专用 pgvector/pgvector:pg16（端口 55462）+ 受限角色做角色安全校验的真实库测试；缺 env 显式 skip。
- 无提交/推送/合并/部署授权；未提交检查点 + SHA-256 清单（review-package 与 manifest 同源）。

## 验证命令（全部记录退出码）

1. 新套件四条验收逐条
2. 全量 `bun test tests/multitenancy/`（148 基线 + 新增，0 fail 0 skip，env 同 MT006）
3. `cd server && bun run typecheck`；`bunx biome check` 触及文件（存量比对披露）
4. 清理容器与凭据

## 产出

- `reports/MT013.md` + `checkpoints/MT013/`（同 MT006 惯例 + mutation ≥3 覆盖三拒绝路径）
- worker_done --outcome succeeded|failed，附 --report-path --files-modified

## 接管说明（coordinator，2026-10-16）

前任实现者（ctx_1fbada6b1783）被平台强制终止（stop_unverified，非任务失败）；磁盘核对无任何实现增量（仅 prereq 快照），从 brief 第一步完整重做。专用库容器 `openbot-i6-mt013-pg`（127.0.0.1:55462）仍在运行，可直接复用（如状态脏可 `docker rm -f` 后重启）。

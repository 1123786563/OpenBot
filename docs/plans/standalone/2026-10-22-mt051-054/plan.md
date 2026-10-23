# MT 域 C类 #94/#95/#96/#97（MT051–MT054）实施计划

- 工作区：mt27 worktree（分支 `1123786563/mt27`，基线 `bcf51633f` + #144–#186 未提交前置全链）
- 票面：gh api 只读取回（GitHub 状态 closed，按票号实施，与 mt17–mt26 同型判例）
- 约束：GitHub 只读；零 commit 零 push；专用测试库 `openbot_enterprise_mt27`（容器 orca-w3-mt-pg@5565）；已知基线红勿修不报；ADR 0008 两层制；不改 `.archive/`、`server/src/mastra/**`

## DAG

```
#94 MT051 执行上界/审批/脱敏回归（独立；基线已先行建立）
#95 MT052 公共 Bot profile/工作区隔离（独立；零 schema）
#96 MT053 Craft 会话作用域（MT053 迁移：enterprise_craft_scopes）
  └─ #97 MT054 Craft 计划任务/子任务/应用连接归属（MT054 迁移：enterprise_craft_schedule_scopes；复用 MT041/MT042/MT029 既有 seam）
```

## 数据库配方（fresh 收敛）

enterprise-test-db migrate → TASKS 注册表语句级重放（容忍 42P07/42710/42701/42P16/42704，跳 INSERT，表已存在仅提取内联 CHECK）→ journal 合成 66 → **partial index 重建**（job_config_snapshots_creation_unique WHERE purpose='creation'，mt22 配方坑 3）→ MT060 后置 apply 3 steps → legacy-anchor 先行 21/21 → 收敛判据 pg_policies 与 mt26 收敛库 264/264 逐字节一致（已验证）。

## 实施形状

### #94 MT051 execution-guarantees.test.ts（回归为主，零产品代码）

- AC1 基线：既有套件真跑（execution-artifacts 19、native-runtime 14、job-claim-cancel 16、job-ownership 23、approvals-policy 30、approvals-execute 5、approvals-questions 2、approvals-native 1、approvals-policy.integration 7、approvals-store.integration 2、opik-redaction 96、shared-approvals/telemetry-usage 终验复跑）。
- AC2 脱敏 × 新归属字段：真实 execution-artifacts/cancel/reset 审计行只带 tenant/workspace/bot/principal 标识，绝不带 token/capability/凭据材料；describeExecutionScope/describeAdapterAttribution 文案钉死；approvals 掩码（types.ts 语义）在带归属上下文的 payload 上原样生效。
- AC3 失败注入：注入拒绝（适配器 throw）、部分失败（第一面成功第二面抛）、审计 sink 失败 → 断言跨 scope 零副作用（他 scope 树原封不动、deny 零传播、cull 候选含他 scope 路径时一个不删）。

### #95 MT052 public-bot-profiles.ts（纯新增服务面，零 schema）

- 无状态判定 = 服务端事实派生纯函数 determineProfilePolicy：bot 声明零活跃凭据依赖（enterprise_resource_dependencies kind='credential' 经 data 通道 RLS 现读）→ shared-recycled（复用必须回收）；否则 forced isolated-per-user。客户端声称 stateless 一律响亮拒绝。
- 目录命名扩展 #90 seam：publicBotProfileDir = <root>/tenants/<t>/workspaces/<w>/bots/<bot>/users/<principal>；parse 复用 plain-id 校验——一个 scope 永远命名不出另一 scope 的树。
- 分配/回收：进程内注册表（与 MT046 gateway fleet 同位）+ generation；回收 = 停实例 + 清 profile + 删该 scope 状态目录 + 注销；跨 scope 回收请求在判定处拒绝。
- 输出形状零创建者材料、零他人材料；MT018 admission 组合不改动。

### #96 MT053 craft-sessions.ts + enterprise_craft_scopes（MT053 迁移）

- 一行 = 一个 craft 会话的 (公司, 团队, 主体, user) 归属；FK → craft_sessions cascade + 复合 FK 钉 workspace/membership/users；RLS = MT060 模式（data 租户臂 + restrictive 主体自读；operator 租户+主体 读/插/删；零 UPDATE）。
- pin（create-once、幂等、mismatch 响亮）/ list（成员视图 keyset）/ read（canonical not-found）；turn 与消息经会话继承归属（读经范围门后的权威 store 投影）。
- 快照：craftSnapshotObjectKey(tenant, workspace, session, snapshot) 纯函数 + 下载授权门；跨范围 ID = not-found。
- 团队公共（public_org）承载 MT009 动作矩阵：成员可读不可改（写动作对非属主成员 TEAM_PUBLIC_ACTION_FORBIDDEN，对外部人折叠 not-found）；撤权（epoch）立即不可见。
- 诚实边界：既有个人会话不带归属行（企业面不可见，不猜测回填——回填属后续票）；不接 HTTP 路由。

### #97 MT054 craft-schedules.ts + enterprise_craft_schedule_scopes（MT054 迁移）

- 一行 = 一个计划对象（kind ∈ {scheduled_task, subtask, connection}；subtask 必带 parent_object_id，connection 必带 credential_ref——CHECK 钉死）；RLS 同 MT053 + operator scan_sweep 臂（MT042 触发重建）。
- pin 三入口：任务（MT041 pinJobOwnership kind='task' 先行 + 协会行）、子任务（父任务协会行必须同三元组——跨范围父 = canonical not-found）、连接（固定 credential_ref）。
- 取消：范围门后委托既有 store（softDelete/状态矩阵）；跨范围 = not-found 零副作用。
- 触发（MT042 同构）：机器身份 → scan_sweep 读权威行 → 真实签发入口重建 Scope（hint 不参与）→ 连接凭据经真实 CredentialLeaseService.validate（purpose='connector-call'）→ 撤销/失效 = 触发 failed（errorClass 机器码），绝不静默改用他人凭据。

## 验证（ADR 0008 两层制）

- 票面 Verification：bun test 四个新套件（bun 驱动层）
- 回归：#94 基线套件终验复跑 + `bun --no-env-file test app/tests/multitenancy`（如触及）
- 登记：node scripts/e2e-add-driven.mjs ×4 + node scripts/e2e-coverage-audit.mjs（no gaps）
- 类型检查：bunx tsc --noEmit -p server/tsconfig.json（自有文件 0 错，存量红不动）；Lint：bunx biome check（自有文件）
- 报告：reports/orca-dag-wave3-mt27.md（自有文件完整清单）

# Craft Schema 说明（onyx → OpenBot 移植）

> 产出：`server/src/db/schema/craft.ts`（`craft_sessions` / `craft_messages` / `craft_snapshots`）
> 沙箱表不新建——复用 `sandbox_instances`，见 §4。
> 源头对照：`onyx/backend/onyx/db/models.py`（BuildSession 6375 / BuildMessage 6687 / Snapshot 6658 / Sandbox 6465），DB 访问层 `onyx/backend/onyx/server/features/build/db/build_session.py` / `sandbox.py`。

## 1. 表清单与字段对照

### 1.1 `craft_sessions` ← `build_session`

| onyx 列 | craft.ts 列 | 类型 | 差异理由 |
|---|---|---|---|
| id UUID PK (uuid4) | `id` text PK | text | 项目惯例：应用层生成带前缀 id（建议 store 里 `cs-`/`cm-`/`csn-` + randomBytes(12).hex，同 `newWorkshopId`），无 DB 端默认值 |
| user_id UUID FK nullable CASCADE | `userId` text NOT NULL FK CASCADE | text | onyx 的 nullable 是历史遗留（legacy 行）；OpenBot 无存量数据，沿用 workshop_sessions 的 NOT NULL，删除用户级联删会话 |
| name str? | `name` text NULL | 一致 | |
| status enum `INITIALIZING/ACTIVE/IDLE/FAILED`（存小写值，非 native enum，默认 ACTIVE） | `$type<CraftSessionStatus>` 存小写字面值，**default 'initializing'** | text + check | onyx 列默认 ACTIVE 但代码创建时一律显式写 INITIALIZING（`create_build_session__no_commit`）；schema 默认值与实际出生状态对齐，消除"忘传 status 就得到错的状态"的坑 |
| created_at / last_activity_at timestamptz（后者 ORM onupdate 刷新） | 同名，`defaultNow()` | 一致 | onyx 用 SQLAlchemy `onupdate=func.now()`，Drizzle 无此钩子——由 store 在每次读/写会话时显式 `SET last_activity_at = now()`（对应 `update_session_activity`） |
| nextjs_port int? | `nextjsPort` integer NULL | 一致 | 端口池 [3010, 3100)，配置项随 config 移植 |
| sharing_scope `private/public_org` default private | `$type<CraftSharingScope>` default 'private' | text + check | onyx 是 String 列非 enum，语义一致 |
| origin `INTERACTIVE/SCHEDULED/SLACK`（非 native enum，**存大写**） | `$type<CraftSessionOrigin>` default 'INTERACTIVE'，**保留大写字面值** | text + check | 侧栏过滤 `origin == 'INTERACTIVE'` 是字面量比较；onyx 此处故意用大写成员名，保留原值减少移植期对照成本 |
| opencode_session_id str? | `opencodeSessionId` text NULL | 一致 | 首 turn 懒 mint，404 重铸回写（对应 `on_opencode_session_resolved`） |
| agent_provider / agent_model str? | `agentProvider` / `agentModel` text NULL | 一致 | NULL ⇒ send-message 回落 opencode 启动默认模型 |
| skills_hash / mcp_config_hash str(64)? | `skillsHash` / `mcpConfigHash` text NULL | 一致（不设长度 64 约束，text 即可） | 首期不推 skills/MCP，但 stale 契约（`session_runtime_stale`）属于移植范围，列保留 |

不移植：artifacts/receipts relationship（对应表首期不做，见 §5）。

### 1.2 `craft_messages` ← `build_message`

| onyx 列 | craft.ts 列 | 说明 |
|---|---|---|
| id UUID PK | `id` text PK | 同上 |
| session_id UUID FK CASCADE | `sessionId` text FK CASCADE | 一致 |
| turn_index int | `turnIndex` integer NOT NULL | 0 起用户消息序号，聚合该 turn 全部助手产出 |
| type enum MessageType（非 native，**存大写成员名** "USER"/"ASSISTANT"…） | `type` `$type<CraftMessageType>` **存小写** `"user"/"assistant"/…` + check | ⚠️ 有意差异：onyx 存大写是 SQLAlchemy `native_enum=False` 存成员名的副作用，不是语义。此处是小写 wire 值；store 层按本表写，无存量大写数据需要兼容 |
| message_metadata JSONB NOT NULL | `messageMetadata` jsonb NOT NULL | **必须用项目自定义 `./json` 的 jsonb**（避免 Bun SQL 驱动双重序列化成 string）；内容为 SSE 同构事件包，不截断（与 onyx 行为一致，架构报告风险点 5 已确认） |
| created_at | `createdAt` stamp | 排序键 |

**保留 upsert 依赖**：`upsert_agent_plan` 用 `message_metadata->>'type' = 'agent_plan_update'` 查既有 plan——自定义 jsonb 保证 `->>` 可用，这是选择它的直接原因。

### 1.3 `craft_snapshots` ← `snapshot`

| onyx 列 | craft.ts 列 | 说明 |
|---|---|---|
| id / session_id FK CASCADE / storage_path | 同构 | storage_path 为 FileStore key，首期管道（sleep 前打包）延后，表先落 |
| size_bytes BigInteger default 0 | `sizeBytes` bigint({ mode: "number" }) default 0 | 压缩包体积可超 int4，mode:"number" 保持 API 边界是 JS number（同 enterprise-runs 惯例） |
| created_at | `createdAt` stamp | |

## 2. 索引对照

| onyx 索引 | craft.ts 索引 | 说明 |
|---|---|---|
| `ix_build_session_user_origin_created (user_id, origin, created_at DESC)` | `craft_sessions_user_origin_created_idx` 同列 | 侧栏查询全覆盖：`WHERE user_id = ? AND origin = 'INTERACTIVE' ORDER BY created_at DESC LIMIT n` |
| `ix_build_session_status` | `craft_sessions_status_idx (status)` | idle 标记/修复扫描的工作集 |
| `uq_build_session_nextjs_port UNIQUE (user_id, nextjs_port) WHERE nextjs_port IS NOT NULL` | `craft_sessions_user_port_idx`，`uniqueIndex().on(...).where(sql\`nextjs_port IS NOT NULL\`)` | 端口预留持久保障；Drizzle 部分索引写法与 workshop share-token 索引同款 |
| `ix_build_message_session_turn (session_id, turn_index, created_at)` | `craft_messages_session_turn_idx` 同列 | 消息列表读路径（`get_session_messages` 按 turn, time 排序） |
| `ix_snapshot_session_created (session_id, created_at DESC)` | `craft_snapshots_session_created_idx` 同列 desc | "最新一条快照"是该表唯一读法（`.desc()` 写法参照 core.ts audit 索引） |

## 3. CAS / 并发语义（schema 层承载的部分）

craft 的分布式正确性主要在 Redis（turn 状态机、prompt slot、interrupt fence），DB 层只有两个 CAS 点，均为**条件 UPDATE + rowcount 判定**，schema 只需保证条件列有索引：

1. **会话出生 CAS**（onyx `finalize_session_initialization__no_commit`）：`UPDATE … WHERE id = ? AND status = 'initializing'` → ACTIVE/FAILED；返回 rowcount=1 才写 opencode_session_id/hashes。并发修复时只有一方生效。
2. **端口预留**（onyx `reserve_nextjs_port__no_commit`）：应用层 bind 探测 → savepoint 内写入 → 部分唯一索引兜底，冲突回滚换下一个端口。唯一索引就是并发保障本体。
3. **消息计数**（`count_user_messages`）：`WHERE session_id = ? AND type = 'user'` COUNT——`craft_messages_session_turn_idx` 前缀即 (sessionId, …)，type 过滤走过滤扫描即可，**不为它单独建索引**（onyx 也没有；turn 串行化由 active_turn 锁保证，无并发计数竞争）。

## 4. 沙箱表：复用 `sandbox_instances`，不新建

onyx `sandbox`（每用户一行：container_id/status/last_heartbeat/skills_hash/mcp_config_hash/encrypted_pat/provisioning_attempt_number/provisioning_started_at）与 OpenBot `sandbox_instances` 同构度很高，对照如下：

| onyx sandbox | OpenBot sandbox_instances | 状态 |
|---|---|---|
| user_id UNIQUE | ownerUserId + botId（**按 bot 而非按 user**） | ✅ 模型更细，直接用 |
| status provisioning/running/sleeping/terminated/failed | provisioning/ready/sleeping/terminated/failed | ✅ running→ready 仅命名差异，store 层映射 |
| last_heartbeat | lastHeartbeatAt | ✅ |
| container_id | address | ✅ 语义等价 |
| provisioning_attempt_number（CAS 核心） | attemptNumber int default 0 | ✅ 已有，语义注释都一致 |
| provisioning_started_at（判死取，ATTEMPT_DEADLINE≈240s 可接管） | provisionedAt（语义不同：成功时戳） | ⚠️ **缺** |
| skills_hash / mcp_config_hash | 无 | ⚠️ **缺**（首期不推 skills/MCP，暂不阻塞） |
| encrypted_pat | x-sandbox-token 网关方案 | ✅ 不需要 |
| — | ports jsonb | ✅ 命名端口池，nextjs 端口可入此列 |

**结论与建议**（按硬约束未改 sandbox-instances.ts）：
- 首期 craft 直接用 sandbox_instances 现有列即可跑通（状态机 + attemptNumber CAS 同构，参考其文件头注释——本表就是为此设计的）。
- 若后续做 skills/MCP 推送或接管判死取，建议一个 ALTER 迁移补三列：`provisioning_started_at timestamptz NULL`、`skills_hash text NULL`、`mcp_config_hash text NULL`。届时在 sandbox-instances.ts 加列定义 + `bun run db:generate` 即可，不用动 craft.ts。
- 死取兜底方案（无 provisioning_started_at 时）：用 attemptNumber 不变 + lastHeartbeatAt 陈旧（>240s）联合判断，首期够用。

## 5. 首期不建的表（备查）

`artifact`（主链路已改即时扫描 outputs/）、`action_approval`/`action_receipt`（接 OpenBot 自有 approvals）、`craft_scheduled_task(_run)`（接 workshop schedules/routines）、`external_app`/`external_oauth_token`、`user_library_file`、`skill_file`。

## 6. 迁移命令

```bash
cd server
bun run db:generate   # 生成 drizzle/00XX_*.sql（craft 三表 + 索引 + check；drizzle.config.ts 已加入 craft.ts）
bun run db:migrate    # 应用到 DATABASE_URL（.env）
```

注意：drizzle.config.ts 的 schema 数组**显式列举**每个文件，注释明确要求"加 schema 文件的同一变更里把文件加进来"——craft.ts 已加入，后续新 schema 文件别忘。

## 7. store 层对接提醒（给任务 #3）

- id 生成：`cs-`（session）/`cm-`（message）/`csn-`（snapshot）前缀 + randomBytes(12).hex，参照 `workshop/store.ts newWorkshopId`。
- 每次读/写会话刷 `lastActivityAt`（onyx ORM onupdate 的等价手写）。
- MessageType 用小写值写入；plan upsert 查询用 `messageMetadata->>'type'`。
- 端口预留循环 + 唯一索引冲突重试，照 `reserve_nextjs_port__no_commit` 移植（savepoint ⇒ Drizzle 事务内 catch unique violation 换端口）。

# #619 沙箱 dev-server 端口段单一事实源 + 占用定位 — 实施计划

- 根 Issue: [1123786563/OpenBot#619](https://github.com/1123786563/OpenBot/issues/619)（本轮交付范围）
- Run 证据: `.archive/runs/2026-10-25-issue619-sandbox-port/`（scope.json / dag.json / ledger.md）
- BASE: main `c505b7655`；集成分支 `1123786563/issue-619-integration`

## Global Constraints

- 保留用户与其他 Agent 的改动；`.env` 是用户文件，不修改、不提交。
- 生产/宿主形态不变：只改 dev compose 的发布段与本地工具链；不新增生产拓扑、不改 host 形态启动路径的必需变量。
- 单一事实源 = `.env` 的 `OPENBOT_CRAFT_SANDBOX_NEXTJS_PORT_START/END`；compose 与服务端默认值必须一致（两者都是 3010/3100 时才能保证无 env 时发布段=服务端分配段）。
- 无新增第三方依赖；脚本用仓库现有运行时（bun / bash）。
- 测试遵守 ADR 0008：新测试文件必须被 e2e 收集（e2e-compat 原生或 Bun 驱动清单），`node scripts/e2e-coverage-audit.mjs` 零新增缺口。
- 文档产物归处：方案在本目录，运行证据在 Run 目录；`reference/compose.md` 是 compose 文档唯一事实源。

## 事实与现状

| 事实 | 位置 |
| --- | --- |
| base compose 硬编码发布 `3010-3100`（v4 与 v6 各一条） | `docker-compose.yml` agent-sandbox ports |
| override 用 `!override` 收窄为硬编码 `3011-3098` | `docker-compose.override.yml` |
| 服务端从 `OPENBOT_CRAFT_SANDBOX_NEXTJS_PORT_START/END` 读取，默认 3010/3100 | `server/src/craft/config.ts:372-380` |
| 本机 `.env` 为 3011/3098 | `.env:585-586`（用户文件，不动） |
| `.env.example` 缺该对键 | `.env.example` |
| 服务端按会话预约端口，经沙箱发布段回连（F-E） | `server/src/craft/nextjs-dev.ts` 头注释 |
| Issue 正文的 `docs/compose.md` / `docs/reference/compose.md` 已由 `3f6cf8810` 合并为根 `reference/compose.md` | 文档漂移，随票修正引用 |
| `docker-compose.yml` 13 处 `docs/compose.md` 注释引用为同一漂移 | 随票修正 |

## 目标行为

1. **单一来源**：`agent-sandbox` 发布段改写为
   `${OPENBOT_CRAFT_SANDBOX_NEXTJS_PORT_START:-3010}-${OPENBOT_CRAFT_SANDBOX_NEXTJS_PORT_END:-3100}`（host 侧与 container 侧同一表达式，v4/v6 各一条）；删除 `docker-compose.override.yml`（不再有第二份硬编码/第二份收窄）。改 `.env` 一处，compose 发布段与服务端分配段同步生效。
2. **默认一致性**：compose 回退默认 = 服务端默认（3010/3100），无 env 时两侧一致；`.env.example` 增加该对键 3011/3098 并注明原因与文档入口，新 checkout 默认避开 vite 3010。
3. **占用预检**（可单测）：`scripts/craft-port-range-preflight.ts`
   - 读取同一来源（process env 优先，其次项目 `.env`），校验成对、`START<=END`、范围为合法 TCP 端口；
   - 对段内每个端口探测 `127.0.0.1` 与 `::1` 监听者；占用时输出：端口、地址族、占用者（进程名+pid；若为 Docker 发布端口则容器名/镜像）、以及两条可复跑步骤（改段：改 `.env` 的 START/END 并重启栈；停占用：`lsof -nP -iTCP:<port> -sTCP:LISTEN` / `docker ps --filter publish=<port>` → `kill`/`docker stop`）；
   - 非法配置（只设一端、START>END、越界）明确拒绝并给出修正指引；
   - 依赖注入探测函数，便于单测。
4. **接线**：
   - `scripts/start.sh` 在 `docker compose up` 之前调用预检（失败即退出，带定位信息）；
   - `scripts/craft-preview-acceptance.ts` 的 preflight 增加「配置段 ⊆ 运行中 agent-sandbox 已发布段」核验，不一致时明确报错并给出改段/重启命令（AC3 的“或 preflight 明确报错”）。
5. **文档**：`reference/compose.md`
   - 文件表删除 override 行，说明发布段由 `.env` 驱动；
   - §The sandbox port range 改写：单一来源、默认值、占用时的预检命令与改段/停占用步骤、生产拓扑为何不发布宿主段；
   - `docker-compose.yml` 注释中的 `docs/compose.md` 引用改为 `reference/compose.md`。

## Task DAG

T1 → T2 → T3。T1/T2 由实施 Agent 完成并经独立 Agent 审核；T3 是编排者在真实栈上的验收（不属于 Agent 任务）。

### T1 — compose 端口段单一 env 来源 + 文档同步

- depends_on: 无；owner_role: backend_implementer
- owned_files: `docker-compose.yml`、`docker-compose.override.yml`（删除）、`.env.example`、`reference/compose.md`
- 步骤:
  1. `docker-compose.yml` 的 `agent-sandbox` 发布段改为 env 插值（两侧同表达式；`127.0.0.1` 与 `[::1]` 各一条）。
  2. 删除 `docker-compose.override.yml`；确认仓库内无其它引用需要保留（文档表与注释同步改）。
  3. `.env.example` 增加 `OPENBOT_CRAFT_SANDBOX_NEXTJS_PORT_START=3011` / `..._END=3098`（含注释：与 `reference/compose.md#the-sandbox-port-range` 同源；服务端默认 3010/3100）。
  4. `reference/compose.md` 文件表与 §The sandbox port range 按目标行为 5 改写；`docker-compose.yml` 内 13 处 `docs/compose.md` 改为 `reference/compose.md`。
- 验证:
  - `docker compose config`（默认 .env）→ 发布串为 `3011-3098:3011-3098`（v4/v6）；
  - `OPENBOT_CRAFT_SANDBOX_NEXTJS_PORT_START=4011 ..._END=4040 docker compose config` → 发布串为 `4011-4040:4011-4040`；
  - 无 env 用 `--env-file /dev/null` 或临时项目目录语义核实回退为 3010-3100（与服务端默认一致）；
  - `docker-compose.override.yml` 已删除且 `git grep` 无失效引用；
  - 文档描述与上述实测逐条一致。
- 失败处理: 插值在 compose 中不被支持时，改用 `env_file` + `!override` 的单一 override 方案（仅一份文件），并在文档与报告说明；不得保留两份硬编码。

### T2 — 端口段占用预检 + 接线 + 单测

- depends_on: T1（同一 env 来源与其文档已集成）
- owned_files: `scripts/craft-port-range-preflight.ts`（新增）、`scripts/start.sh`、`scripts/craft-preview-acceptance.ts`、`tests/craft-port-range-preflight.test.ts`（新增）、`reference/compose.md`（仅预检段落）
- 步骤:
  1. 实现预检模块（探测函数可注入；进程侧用 `lsof`，容器侧用 `docker ps` 发布端口查询；`::1` 与 `127.0.0.1` 都查）。
  2. `start.sh` 在 compose up 前调用；输出简洁成功行（段+空闲）或可定位错误。
  3. 验收脚本 preflight 增加已发布段核验（读取运行中 sandbox 容器的发布端口，与配置段比对）。
  4. 单测：占用段→错误含端口+占用者+两条步骤；合法空闲段→通过；只设一端/START>END/越界→拒绝；容器占用分支（mock）。
  5. `reference/compose.md` 补预检用法（一条命令 + 失败示例）。
- 验证:
  - `bun test`（或对应 e2e 收集方式）单测全绿；
  - `node scripts/e2e-coverage-audit.mjs` 零新增缺口（ADR 0008）；
  - 手工：占用一个段内端口 → 预检非零退出并给出定位；释放 → 通过。
- 失败处理: 若本机无 `lsof`（非 macOS/Linux 场景）按 processes.sh 的跨平台先例降级为明确“无法探测”而不是静默通过；记录限制。

### T3 — 真实栈验收（编排者）

- 前置: T1、T2 均已独立审核并合入集成分支；组合树验证通过。
- 步骤（证据写 Run `verification/`）:
  1. `docker compose config` 三态（默认/自定义/无 env）；
  2. 占用演示：宿主进程占段内端口 → `scripts/start.sh`/预检非零退出，输出定位到端口与占用者；释放后通过；
  3. 以自定义段（如 4011-4040）起依赖栈（独立 compose project + 唯一容器名；记录 ID），起 API/app；
  4. `CRAFT_ACCEPTANCE_TOPOLOGY=dev bun run test:craft-preview-e2e`（app :3220 / api :3221 / casdoor :8000 / sandbox :4300），按脚本 header 的前置就位；归档截图与 summary；
  5. 清理本次新建容器（同一 project `down --remove-orphans`，不加 `-v`），核对无残留。
- 失败处理: 环境不可用时如实记录阻塞与复跑命令，不记为通过（AC3 允许“preflight 明确报错”路径，但必须实测该路径）。

## Review Focus

- 单一来源是否真的只有一处（compose 两侧表达式、override 删除、服务端默认一致性）。
- 无 env 时的行为是否与改动前等价或更一致（3011-3098 现行 .env 下逐字节等价）。
- 预检错误是否同时给出端口、占用者、改段与停占用两条路径；是否存在静默通过分支。
- 测试是否按 ADR 0008 被收集，而非零用例/跳过。
- 文档与实测一致；生产/宿主形态未受影响。

# Ticket #380 — 自托管 Hindsight 服务与隐私配置：实施与验证报告

- **工作区**：`/Users/wuyongjun/orca/workspaces/OpenBot/hs03-selfhost-service`（分支 `1123786563/hs03-selfhost-service`，HEAD `f0520524f0faa2b4533b9d2f1aa692c8f907ba71`，tracked diff 干净，全部产出为未跟踪新文件）
- **执行**：前两轮 worker 建成 11 个文件并过单测（429 中断）；本轮（2026-10-15T16:05–16:10Z）完成真实实例验证、修复两处真实 API 不匹配与一处 backup.sh 缺陷、补齐本报告。
- **事实源**：Spec `docs/specs/2026-10-15-hindsight-personal-memory-design.md`、ADR 0005、计划 Task 2、issue-380 快照。

## 交付物（12 个未跟踪文件 + sha256）

| 文件 | sha256 |
| --- | --- |
| deploy/hindsight/docker-compose.yml | 20e53cbfbfb0e424a5a15ce5b5515e92c7bd881c2bbbee2290c97599a04dc813 |
| deploy/hindsight/hindsight.env（本机隔离测试值，git-ignored 实值） | 4eab36c5fa6056ce8ddef244bf57206becd9caf5b50ab4f1975376bd6d803afb |
| deploy/hindsight/hindsight.env.example | 02c9e9966e37c5de69d85c675b6e98da2cbfd193d52549a09a4e6e0957ebce68 |
| deploy/hindsight/README.md | bbe84881fa03f582a338b908aa950715dcc9b5630929a2348ae204238be3c046 |
| deploy/hindsight/backup.sh | 7ea2fc56a550022855dde3553b7a5e1cf6f5701b94c64c7129e4b5707672ba67 |
| deploy/hindsight/.gitignore | ad5f630d7c06efea8149b5c965b4b446417a3f71c8b85b320fcad925d2f5c572 |
| deploy/hindsight/test/gateway-standin.mjs | 9fd4baed307fae0ce10d56f104781c0909a4935839e6ba2019c1ba1537c413cd |
| deploy/hindsight/test/verify-health.ts | dff177095367b7c41ac79ab494bf96abdafd06ae4aff187b37c853b4e7b069a2 |
| server/src/hindsight/config.ts | d10aa3471f28ebb568433b7d903e54308baf85dec30f57709c4da8b33bc3bfab |
| server/src/hindsight/health.ts | 4ca854cef8c1984037d2c2bade72eae238c59959ae16be6a8063c6190626ea07 |
| server/tests/hindsight-config.test.ts | 52700e332279edd4a0bc66c428c400e3de7dcc8f9728eb73fb9c0609f2356d37 |
| server/tests/hindsight-health.test.ts | a84921aa5ec8ab2affe16d94cb0d41cdbe6256f4f0725b9562bb568735ad4ebb |

所有权约束遵守：仅 `deploy/hindsight/**`、`server/src/hindsight/**`、`server/tests/hindsight-*.test.ts`；未触碰 `server/src/memory/**`。无 commit/push/部署；实例仅本机隔离测试。

> **fix1（2026-10-16T02:0x+08:00，task_93e8db38f181）已更新上表 3 个文件（`backup.sh`、`hindsight.env.example`、`README.md`），新 sha256 以文末《附录：fix1》为准；其余 9 个文件与审阅基线逐字节一致。**
>
> **ocr-fix（2026-10-16T03:2x–04:1x+08:00，task_d53a03d1fde5）再更新 3 个文件（`backup.sh`、`docker-compose.yml`、`README.md`），新 sha256 以文末《附录：ocr-fix》为准；其余 9 个文件经哈希复核仍与 fix1/审阅基线逐字节一致。**
>
> **ocr2-fix（2026-10-16T10:2x+08:00，task_6039ed0f9475）更新 3 个文件（`server/src/hindsight/config.ts`、`server/src/hindsight/health.ts`、`server/tests/hindsight-config.test.ts`），新 sha256 以文末《附录：ocr2-fix》为准；其余交付文件本轮未改动，逐字节核对见附录。**
>
> **ocr3-fix（2026-10-16T17:0x+08:00，task_847fd115970f）更新 4 个文件（`server/src/index.ts`、`server/src/hindsight/health.ts`、`server/src/hindsight/config.ts`、`server/tests/hindsight-health.test.ts`），新 sha256 以文末《附录：ocr3-fix》为准。**

## 验收标准逐条证据

### 1. 固定经过真实验证的版本；API/控制台不暴露

- 镜像固定 tag `ghcr.io/vectorize-io/hindsight:1.0.0`，index digest `sha256:a88678c038b0e4340822b02a5efc566c56d8176b5bffa731bc433fd37f978e4c`（`docker images --digests`，2026-10-15T16:10Z）。
- `docker port openbot-hindsight` → 仅 `8888/tcp -> 127.0.0.1:8888`；控制面 9999 无任何发布项（compose 文件无该 ports 条目）。
- 未携带 API key 的请求被拒：`POST /v1/default/banks/default/health/llm`（无 Authorization）→ `HTTP 401 {"detail":"Authentication failed: Invalid API key"}`。
- 版本响应（带 key）：`GET /version` → `{"api_version":"1.0.0","features":{...,"bank_llm_health":true,"audit_log":false,"llm_trace":false,"store_document_text":true}}`，`HTTP 200`。
- 存活探测：`GET /health/live`（无鉴权，仅状态）→ `{"status":"alive","version":"1.0.0","uptime_seconds":751.5}`，`HTTP 200`。

### 2. 模型调用经已批准网关；追踪关闭；载荷 1 天；备份 ≤30 天

**网关路由（运行值，读自容器 env 而非文件）**：

```
HINDSIGHT_API_LLM_PROVIDER=openai
HINDSIGHT_API_LLM_BASE_URL=http://host.docker.internal:9100/v1     ← 唯一 LLM 出口
HINDSIGHT_API_EMBEDDINGS_PROVIDER=openai
HINDSIGHT_API_EMBEDDINGS_OPENAI_BASE_URL=http://host.docker.internal:9100/v1  ← 唯一 embedding 出口
```

standin 网关日志（/tmp/hindsight-gateway-standin.log）证明模型调用确实只走上述端点，无其他出口：

```
{"at":"2026-10-15T16:06:59.120Z","method":"POST","path":"/chat/completions","model":"gpt-4o-mini"}
{"at":"2026-10-15T16:07:20.765Z","method":"POST","path":"/v1/chat/completions","model":"gpt-4o-mini"}
{"at":"2026-10-15T16:07:40.641Z","method":"POST","path":"/v1/chat/completions","model":"gpt-4o-mini"}
```

注：生产应指向 Bifrost 已批准网关；本工作区 bifrost 子模块未部署（bifrost-5 ticket 01.1），故按计划用协议兼容 standin 做隔离验证，README 已声明"Never point production at it"。

**隐私配置（运行值 + 运行时行为双重证据）**：

- `docker exec openbot-hindsight env` 实测：`HINDSIGHT_API_LLM_TRACE_ENABLED=false`、`HINDSIGHT_API_OPERATION_RETENTION_DAYS=1`、`HINDSIGHT_API_OPERATION_CLEANUP_INTERVAL_SECONDS=900`、`HINDSIGHT_API_ENABLE_BANK_LLM_HEALTH=true`。
- 运行时行为：`GET /version` 的 features 报告 `llm_trace:false`；多次 LLM 探测后直查内嵌库 `select count(*) from llm_requests` → **0**（含内容追踪确实关闭，非仅配置声明）；`async_operations`/`documents`/`memory_units` 均 0 行（无任何员工记忆内容留存）。
- OpenBot 侧镜像声明 `HINDSIGHT_PRIVACY_*`（trace=false / retention=1 / backup=30）由 `config.ts` 强制校验，缺失或超限即 `config_noncompliant`。
- 备份 ≤30 天：`backup.sh` 拒绝 `HINDSIGHT_PRIVACY_BACKUP_RETENTION_DAYS=90`（exit 1）；31 天旧副本被 sweep 删除、29 天副本保留（边界实测）；真实 dump 完整性验证：8,026 B gzip / 57,902 B 明文，含标准 `-- PostgreSQL database dump` 头尾。

### 3. 三态健康检查（真实实例实测，命令 `bun run deploy/hindsight/test/verify-health.ts <scenario>`）

| 场景 | 操作 | 输出 | exit |
| --- | --- | --- | --- |
| happy | standin 运行 | `{"state":"service_up","checkedAt":"2026-10-15T16:06:59.081Z","version":"1.0.0"}` | 0 |
| gateway-down | `pkill gateway-standin` | `{"state":"gateway_down","checkedAt":"…16:07:04.103Z","version":"1.0.0"}` | 0 |
| bad-config | `HINDSIGHT_PRIVACY_LLM_TRACE_ENABLED=true` | `{"state":"config_noncompliant","violations":["llm_trace_enabled"],…}` | 0 |
| service-down | `docker compose stop hindsight` | `{"state":"service_down","checkedAt":"…16:07:14.830Z"}` | 0 |
| 恢复 | `docker compose up -d` + 等 healthy | `{"state":"service_up",…,"version":"1.0.0"}` | 0 |

探测语义：`checkHindsightHealth` 先判合规（不联网即可报 noncompliant），再 `GET /health` 判活，再 `POST /v1/default/banks/{bank}/health/llm`（真实发起一次经网关的 provider 调用）判网关。状态对象仅含 `state/checkedAt/version/violations`——单测显式断言不含 token、网关 key、记忆内容。

LLM 探测原始响应（真实实例）：

```json
{"bank_id":"default","operations":[
 {"operation":"retain","ok":true,"status":"connected","latency_ms":22.76},
 {"operation":"consolidation","ok":true,"status":"connected","latency_ms":22.76},
 {"operation":"reflect","ok":true,"status":"connected","latency_ms":22.76}]}
```

## 本轮发现并修复的真实缺陷（真实实例验证的价值所在）

1. **health.ts 与真实 API 形状不符**：1.0.0 实测探测返回 `ok:true,status:"connected"`（非测试假设的 `status:"healthy"`），且 `/version` 返回 `api_version`（非 `version`）。修复：以 `ok` 布尔为准、`healthy/connected` 为回退；版本读 `api_version ?? version`。测试样例同步改为实测形状（含 `ok:false` 变体与旧形状回退用例）。
2. **backup.sh 的 pg_dump 不在容器 PATH**：内嵌 pg0 二进制位于 `~/.pg0/installation/18.1.0/bin/`，默认 PATH 找不到；此前"成功"的备份文件实为 gzip 的 OCI 错误文本。修复：从 `~/.pg0/instances/hindsight/instance.json` 动态解析 pg_dump 路径与凭据（版本升级自动适配），并以真实 dump 头尾 + 字节数验证。
   - 附注：`HINDSIGHT_API_TENANT_API_KEY` 在本报告与本机测试环境为隔离测试值 `localtest-hindsight-key`；生产部署必须换强随机值（hindsight.env.example 已标注 change-me）。

## 测试与类型检查

- `bun test server/tests/hindsight-config.test.ts server/tests/hindsight-health.test.ts` → **21 pass / 0 fail**（50 expect）。
- `bunx tsc --noEmit -p server` → exit 0。
- 单测覆盖：配置解析/合规校验（缺隐私配置、trace 开、载荷>1 天、备份>30 天 → noncompliant；合法样例 → ok；bare-origin 强制、凭据内嵌拒绝）；健康四态与"状态不含密钥/内容"断言。

## 未提交检查点

- HEAD `f0520524f0faa2b4533b9d2f1aa692c8f907ba71`；tracked diff 为空；12 个未跟踪文件哈希见上表。
- 本机运行态（供后续票复用）：`openbot-hindsight` 容器 healthy（8888 loopback）；standin 网关 9100 在跑；`deploy/hindsight/backups/` 含真实 dump（git-ignored）。
- 无 commit/push/merge/部署动作。

## 遗留与边界（按票面 non-goals，不阻塞本票）

- 本票不证明租户隔离与记忆召回（Wave 2+ 的 #381/#382 等）；`store_document_text:true`（保留原文持久化）为当前默认，Spec 允许后续评估关闭。
- "受控副本清除完成"标记需任务实际清理 + 备份过期 + 恢复重放证据（删除链票据范围，ADR 0005 分阶段要求）；本票交付其配置与 sweep 机制。
- 生产切换清单：hindsight.env 全量换真实值（Bifrost 网关 URL/key、强随机 API key）、9999 保持不发布、backup.sh 挂 cron。

## 附录：fix1（审阅 findings F1/F3 处置，task_93e8db38f181，2026-10-16T02:07–02:12 CST）

响应 `ticket-380-review.md` F1（备份边界语义）与 F3（example 网关 URL 容器内不可达提示），裁决 5 指派修复。仅改动 `deploy/hindsight/` 下 3 个文件，无 commit/push。

### F1：sweep 阈值改为严格 30 整天（backup.sh）

- 改动：`find -mtime "+$RETENTION_DAYS"` → `find -mtime "+$((RETENTION_DAYS - 1))"`。
- 语义（已写入脚本头注 + sweep 注释 + README）：`find -mtime +N` 匹配"按整 24 小时周期计龄（丢弃小数部分）严格大于 N 天"的文件，即 `+30` 只删**满 31 整天**的副本（30.5 天龄的副本存活，尾巴 ~31 天，日 cron 最坏 ~32 天）。改为传 N−1 后，副本一旦存在满 `RETENTION_DAYS` 整天，**下一次运行即被删除**：每次 sweep 结束后不存在 ≥30 整天龄的存活副本；两次运行之间最多再多存活一个调度间隔（默认 30 天窗口 + 日 cron ⇒ 最坏 ~31 天，比改前缩短整整 1 天，且堵住了精确 30.0–30.99 天龄原本必存活的洞）。

**边界实测（宿主机 find，2026-10-15T18:07Z；BSD find，POSIX `+n` 语义与 GNU find 一致；/tmp 临时目录未触仓库）**——按任务要求覆盖 29/30/31 三点边界，含精确 30 天：

| 副本龄 | 改前 `-mtime +30` | 改后 `-mtime +29` |
| --- | --- | --- |
| 29.0 天 | 保留 | 保留 |
| 29.5 天 | 保留 | 保留 |
| **30.0 天（精确边界）** | **保留（缺陷所在）** | **删除** |
| 30.5 天 | 保留 | 删除 |
| 31.0 天 | 删除 | 删除 |

### F3：example 网关 URL 默认值改 host.docker.internal（hindsight.env.example + README）

- `HINDSIGHT_API_LLM_BASE_URL` 与 `HINDSIGHT_API_EMBEDDINGS_OPENAI_BASE_URL` 默认值 `http://127.0.0.1:9100/v1` → `http://host.docker.internal:9100/v1`，并加注释：容器内 `127.0.0.1` 指容器自身，宿主网关必须经 `host.docker.internal` 访问；仅非容器直跑宿主机时用 `127.0.0.1:9100`（与运行态 `hindsight.env` 的实测可用值一致，git-ignored 实值未动）。
- README Layout 节 `hindsight.env.example` 条目同步一句同样的 host-gateway 说明；`backup.sh` 条目与 Privacy 表行同步精确保留语义。

### fix1 后 sha256（3 个改动文件；其余 9 个交付文件与审阅基线逐字节一致）

| 文件 | 改前（审阅基线） | 改后（fix1） |
| --- | --- | --- |
| deploy/hindsight/backup.sh | 7ea2fc56a550022855dde3553b7a5e1cf6f5701b94c64c7129e4b5707672ba67 | 99564e0db2534ac21a2592ea509d3aca61a5473b54c723dd590277f8e1c123b1 |
| deploy/hindsight/hindsight.env.example | 02c9e9966e37c5de69d85c675b6e98da2cbfd193d52549a09a4e6e0957ebce68 | d109e9f7cb1b8e692bff050f0f534ff2622d5ed58f0431ffc99f1bbc80597735 |
| deploy/hindsight/README.md | bbe84881fa03f582a338b908aa950715dcc9b5630929a2348ae204238be3c046 | 62ede8254fe8cc6597be8f8e5aecdbca4c069eb2018b88e4d87ed643b42ef0bc |

未改动核对（与审阅基线一致）：`docker-compose.yml` 20e53cbf…、`.gitignore` ad5f630d…、`hindsight.env` 4eab36c5…、`test/gateway-standin.mjs` 9fd4baed…、`test/verify-health.ts` dff17709…、`config.ts` d10aa347…、`health.ts` 4ca854ce…、两个测试文件 52700e33…/a84921aa…。

### fix1 验证证据

- `bun test server/tests/hindsight-config.test.ts server/tests/hindsight-health.test.ts` → **21 pass / 0 fail（50 expect）**，21-pass 基线不回退。
- `cd server && bunx tsc --noEmit` → exit 0。
- `bash -n deploy/hindsight/backup.sh` → 语法通过。
- 容器内备份复跑（脚本改动后）：`./backup.sh` → exit 0，`backup written: …/backups/hindsight-20261015T180936Z.sql.gz (retention 30d)`；真实 dump 校验 `gunzip -t` 通过，8,021 B gzip / **57,902 B 明文**，含 `-- PostgreSQL database dump` 头与 `\unrestrict …` 尾；同目录 3 个 ~10 小时龄旧副本全部正确保留（未满 30 整天）。
- HEAD 仍为 `f0520524`，无 commit/push；改动范围 = `deploy/hindsight/{backup.sh,hindsight.env.example,README.md}` + 本报告。

## 附录：ocr-fix（OCR session c782f4b2 findings R1/R2/R3/R4/R8/R12 处置，task_d53a03d1fde5，2026-10-16T03:2x–04:1x+08:00）

响应 coordinator 裁决的 6 条 OCR findings。改动仅 `deploy/hindsight/{backup.sh,docker-compose.yml,README.md}` + 本报告；无 commit/push；容器未重建。

### R1（口令不经任何 argv）—— backup.sh

- 改动：`docker compose exec -e PGPASSWORD=… hindsight "$PG_DUMP_BIN" …`（口令进宿主 docker 进程 argv，`ps` 可见）→ `printf '%s\n' "$DB_PASSWORD" | docker compose exec -T hindsight sh -c 'IFS= read -r PGPASSWORD || exit 3; export PGPASSWORD; exec "$1" --username "$2" --dbname "$3" --no-owner --no-privileges </dev/null' pg-dump "$PG_DUMP_BIN" "$DB_USER" "$DB_NAME" | gzip`。口令只经 stdin 进入容器 shell 的环境；宿主与容器任何 argv 均不含口令。
- 证据：
  - **探针 A（哨兵值）**：同形管道 + 假二进制 `/bin/echo`，实测 exec 命令收到的 argv 恰为 3 个（`argv-count=3`，argv0=pg-dump，argv=bin/user/db），哨兵经 stdin→env `MATCH`。
  - **探针 D（真实复跑 + 容器内 `/proc` 高频轮询）**：真实 pg_dump 完整 cmdline = `/home/hindsight/.pg0/installation/18.1.0/bin/pg_dump --username hindsight --dbname hindsight --no-owner --no-privileges`（无口令、无 `-e`）；4 个采样点 `/proc/<pid>/environ` 含 `PGPASSWORD=`（env 送达实测）。
  - 宿主侧 8s 窗口 `ps` 快照：docker compose exec argv = 脚本文本 + `pg-dump <bin> <user> <db>`，无 `PGPASSWORD=`、无 `-e PGPASSWORD`（自动断言 0 命中）。
  - 真实复跑 4 次（主目录 ×2 + R8 harness ×2）全部 exit 0、dump 完整（见文末证据汇总）。
- 方法论备注（诚实记录）：第一版 argv 探针误把 `$PW-marker-user` 当标记参数传入 exec argv（bash 展开 `<口令>-marker-user`），其 ps "命中"系自注入污染，**已废弃不作证据**；上列 A/D 为修正后探针。

### R2（RETENTION_DAYS=0）—— 二选一裁决：**显式拒绝**

- 裁决与理由：拒绝而非钳 0→1。sweep 本质上无法兑现"0 天窗口"（每次运行先写入新副本）；钳制会静默把保留期放宽到 ~1–2 天，**超过声明的 0 天窗口**，而 OpenBot 侧 `config.ts` 合规校验把 0 视为 ≤30 合规、不会报警——宁可大声失败。拒绝信息含指引（"to keep no backups, do not schedule this job"）；头注与校验注释写明 1..30 域。
- 随附闭环：校验改为 `[-lt 1] || [-gt 30]` 拒绝 ⇒ find 参数恒在 `+0..+29`，`-mtime -1` 退化情形**不可能再发生**（sweep 注释已注明）。
- 实测：`=0`、`=31`（宿主 env 压过 env-file 的 30）、`=abc` 均 exit 1 且未产生任何文件；`RETENTION_DAYS=1` ⇒ `-mtime +0` 合法且行为正确（1.0d 删 / 0.5d 留）。

### R8（宿主 env 未设置时从 hindsight.env 取值）

- 解析顺序 = compose 语义：宿主 env → 脚本同目录 `hindsight.env` 的 `HINDSIGHT_PRIVACY_BACKUP_RETENTION_DAYS=`（`sed` 锚定 KEY= 精确匹配、最后一行生效；容忍一层成对引号与 CR 行尾；其余键含密钥不读不回显）→ 默认 30。
- 实测（全部真跑完整备份）：宿主 env 未设 + 主目录 hindsight.env(=30) → `retention 30d`；脚本+compose 复制到**无 hindsight.env** 的 /tmp 目录 → 默认 `30d`；hindsight.env 写 `"30"`（带引号 + 干扰键）→ `30d`；宿主 env=31 → 拒绝（证明 env 优先于文件）。

### R3（加固：umask / EXIT trap / 完整性校验）

- `umask 077`：4 次真跑产物均为 `0600`（ls 实证；改动前的旧副本 0644 保留作对照）。
- 写入改为隐藏部分文件 `.hindsight-<stamp>.sql.gz.part`（不匹配 sweep 的 `hindsight-*.sql.gz` 正式名匹配），`gzip -t` 通过后才 `mv` 出正式名；EXIT trap `rm -f` 部分文件。
- 失败路径实测：R8 harness 首跑因 compose project 不匹配致 dump 管道失败（exit 1），backups/ 目录 `ls -la` 为空——无 `.part` 残留，trap 生效。

### R12（cron 示例先建目录）

- 头注 cron 行改为：`0 3 * * * mkdir -p /path/to/deploy/hindsight/backups && /path/to/deploy/hindsight/backup.sh >> /path/to/deploy/hindsight/backups/backup.log 2>&1`，注明 cron 重定向先于脚本执行、目录必须已存在。

### R4（Linux host.docker.internal）

- `docker-compose.yml` hindsight 服务新增 `extra_hosts: ["host.docker.internal:host-gateway"]`（注释注明 Docker Engine ≥ 20.10 与 Docker Desktop 原生提供的差异）；`docker compose config` 渲染确认 `host.docker.internal=host-gateway`。
- README Operating 节新增 Linux 说明：映射语义、旧引擎/特殊网络的回退（改用容器可达的宿主地址如 docker0 桥 IP）、映射在容器 (re)create 时生效。本机为 macOS/Docker Desktop（原生提供该名字），容器未重建、运行态不受影响。

### ocr-fix 后 sha256（3 个改动文件）

| 文件 | 改前（fix1 / 审阅基线） | 改后（ocr-fix） |
| --- | --- | --- |
| deploy/hindsight/backup.sh | 99564e0db2534ac21a2592ea509d3aca61a5473b54c723dd590277f8e1c123b1 | 538d0fc4ae55708ac784b01c086f5aa49b70cb288c199f5f1399a450515455a6 |
| deploy/hindsight/docker-compose.yml | 20e53cbfbfb0e424a5a15ce5b5515e92c7bd881c2bbbee2290c97599a04dc813 | 656efbb0869ffebf664fe6d5c68f8362ff5dc214b67cbb8c9dd8723d2285108a |
| deploy/hindsight/README.md | 62ede8254fe8cc6597be8f8e5aecdbca4c069eb2018b88e4d87ed643b42ef0bc | e4e8ac871071d5bc3c18fec0a6d46183aadf83e034d701ce7f86a5e57321fb8f |

未改动核对（哈希复核与 fix1/审阅基线一致）：`hindsight.env` 4eab36c5…、`hindsight.env.example` d109e9f7…、`.gitignore` ad5f630d…、`test/gateway-standin.mjs` 9fd4baed…、`test/verify-health.ts` dff17709…、`config.ts` d10aa347…、`health.ts` 4ca854ce…、`server/tests/hindsight-config.test.ts` 52700e33…、`server/tests/hindsight-health.test.ts` a84921aa…。

### ocr-fix 验证证据汇总

- 容器 `openbot-hindsight` 全程 `Up (healthy)`。
- 真实备份复跑（主目录，脚本改动后）：`hindsight-20261015T193158Z.sql.gz`，exit 0，`-rw-------`（0600），**8,024 B gzip / 57,902 B 明文**，含 `-- PostgreSQL database dump` 头与 `\unrestrict …` 尾，`gzip -t` 通过；~10h 龄旧副本全部正确保留（未满 30 整天）。
- find 边界复测（宿主 find，/tmp 临时目录，与 fix1 同法同语义）：29.0d、29.5d **保留**；精确 30.0d、30.5d、31.0d **删除**——不回退。
- `bash -n deploy/hindsight/backup.sh` 通过；`shellcheck -S warning backup.sh` 0 findings。
- `bun test server/tests/hindsight-config.test.ts server/tests/hindsight-health.test.ts` → **21 pass / 0 fail（50 expect）**，基线不回退。
- `cd server && bunx tsc --noEmit` → exit 0。
- `git status`：相关路径全部仍为未跟踪（untracked），无 commit/push/merge/部署动作；HEAD 仍为 `f0520524`。

## 附录：ocr2-fix（OCR 轮 2 findings M1/M2/M3 + low×3 处置，task_6039ed0f9475，2026-10-16T10:1x–10:3x+08:00）

在 `/Users/wuyongjun/trea/OpenBot-hindsight-exec` 执行。改动仅 `server/src/hindsight/{config.ts,health.ts}` + `server/tests/hindsight-config.test.ts` + 本报告；无 commit/push。`deploy/hindsight/**` 本轮零改动。

### M1：探针 URL 租户段常量化（health.ts）

- 新增模块级常量 `const HINDSIGHT_TENANT_SEGMENT = "default"`，探针 URL 构造改为 `${config.apiUrl}/v1/${HINDSIGHT_TENANT_SEGMENT}/banks/${encodeURIComponent(config.bankId)}/health/llm`；文件头注的路径记法同步改为 `POST /v1/{tenant}/banks/{bank}/health/llm`。
- 对称性（常量 doc 注释已写明）：租户段随单租户部署固定为模块常量；bank id 仍是每部署配置（`HINDSIGHT_BANK_ID`），因探针测的是所配置 bank 而非固定 bank。
- 测试断言的路由 `/v1/default/banks/default/health/llm` 不变（URL 实际值未变，仅构造方式去硬编码）。

### M2：`loadHindsightConfig` 注释如实化（config.ts）

- 原注释声称「misconfigured deployment fails loudly at startup」——不实：当前无任何 server 运行时调用方，调用者仅测试套件与手工脚本 `deploy/hindsight/test/verify-health.ts`。
- 改为如实陈述：本模块（含健康检查）当前供部署验证与测试使用；接入 server 启动/巡检属后续票（#393 管理员视图）范围；在那之前本模块本身不构成 server 启动期保证。抛错行为描述（带违规变量名）保留。

### M3：backupRetentionDays 下界 ≥1，与 backup.sh 0 拒绝对齐（config.ts + 单测）

- 新增 `export const MIN_BACKUP_RETENTION_DAYS = 1`（doc 注释写明理由：备份作业无法兑现 0 天窗口——每次运行先写新副本才谈得上 sweep，故 0 判 noncompliant 而非读作「无备份」，与 `deploy/hindsight/backup.sh` 拒绝 0 的 1..30 域完全一致）。
- `validateHindsightPrivacy` 的 backup 分支补 `privacy.backupRetentionDays < MIN_BACKUP_RETENTION_DAYS` 判违规；模块头注与 `HindsightPrivacy.backupRetentionDays` 字段注释同步为「At least 1, at most 30」。
- 边界语义不变项：`operationRetentionDays = 0` 仍合规（0 天载荷保留=不落载荷，既有用例继续通过）；仅 backup 引入下界。
- 新增单测：`"zero-day backup retention is noncompliant, matching backup.sh's 0 refusal"`（`HINDSIGHT_PRIVACY_BACKUP_RETENTION_DAYS="0"` → `compliant:false`，violations 含 `backup_retention_days`）。

### Low×3（health.ts）

- 删除 `LlmProbeResponse` 中未读取的 `bank_id?: string` 声明（代码从不读该字段；响应实际含 bank_id 不代表类型需声明）。
- 文件头标题 `Three-state health check` → `Four-state health check`（与 `HindsightHealthState` 的四态一致；正文「三个 spec 条件 + 诚实的第四态」表述保持）。
- `service_down` 判定分支的裸 `catch` 改为带 `log.info`（`hindsight-health-service-probe-failed`：error 名 + message + timestamp），与 gateway 探针 catch 的日志契约对称；状态对象仍只报状态，错误细节只进日志。

### ocr2-fix 后 sha256（3 个改动文件）

| 文件 | 改前（ocr2 基线） | 改后（ocr2-fix） |
| --- | --- | --- |
| server/src/hindsight/config.ts | d10aa3471f28ebb568433b7d903e54308baf85dec30f57709c4da8b33bc3bfab | 59c72eac54304ba3808e46710495e6124d42b819458b5b9daeaca686320db956 |
| server/src/hindsight/health.ts | 4ca854cef8c1984037d2c2bade72eae238c59959ae16be6a8063c6190626ea07 | e619eebfe3fc12d8498bab804a64566eb3e83b1d3f3982d54f434f28d06c8ff6 |
| server/tests/hindsight-config.test.ts | 52700e332279edd4a0bc66c428c400e3de7dcc8f9728eb73fb9c0609f2356d37 | 783c9542b378ebd767caa7ca94da48c85f5ced36bacae07d7d80437f97ad87eb |

未改动核对（哈希复核与 ocr-fix 后记录逐字节一致）：`deploy/hindsight/docker-compose.yml` 656efbb0…、`backup.sh` 538d0fc4…、`README.md` e4e8ac87…、`hindsight.env.example` d109e9f7…、`.gitignore` ad5f630d…、`test/gateway-standin.mjs` 9fd4baed…、`test/verify-health.ts` dff17709…。两点说明：① `hindsight.env` 为 git-ignored 本机运行态文件，本执行工作区不存在（非删除，系工作区不同）；② `server/tests/hindsight-health.test.ts` 本轮未改动（mtime 03:34，早于本轮），本轮开始前哈希即为 f6fc21d6f2adce4264b6bf21eae9a959accdd853f3da5ad5a1e0388d51626229（含前轮加入的 "(ocr fix)" 未定义依赖回退用例）；此前附录核对表所记 a84921aa… 为过期记录，特此更正。

### ocr2-fix 验证证据

- `cd server && bunx tsc --noEmit` → exit 0。
- `bun test ./tests/hindsight-config.test.ts ./tests/hindsight-health.test.ts` → **23 pass / 0 fail（55 expect）**：基线 22 + 新增 1，不回退（config 14 + health 9）。
- `bunx biome check src/hindsight/health.ts src/hindsight/config.ts tests/hindsight-config.test.ts` → 0 问题。
- `git status`：`server/src/hindsight/**`、`server/tests/hindsight-*.test.ts`、`deploy/**` 仍全部 untracked；无 commit/push/merge/部署动作。

## 附录：ocr3-fix（OCR 轮 3 medium×2 + low×1 处置，task_847fd115970f，2026-10-16T16:5x–17:1x+08:00）

在 `/Users/wuyongjun/trea/OpenBot-hindsight-exec` 执行（coordinator 裁决批次）。改动 `server/src/index.ts` + `server/src/hindsight/{config.ts,health.ts}` + `server/tests/hindsight-health.test.ts` + 本报告；无 commit/push。`deploy/hindsight/**` 零改动。

### medium-1：sweepStep 统一 memorySweep 三段（index.ts:1677 区域）

- 提取 `sweepStep(operation, fn)` 小 helper：syncDue / mirrorPending / expireStaleCandidates 三段收敛为三次 `await sweepStep(...)`，统一 try/catch。
- 日志契约对齐 health.ts 形态：`log.error` 载荷补 `detail`（error message），连同既有 `error`（name）、`context.operation`、`timestamp`；顺带消除 mirrorPending 的 `console.error(JSON.stringify(...))` 分叉。
- 行为不变：单段失败仍吞掉、后续段照常执行、下一次 sweep 重试（12 文件套件 101 pass 改前后一致，见验证证据）。
- biome 附带收益：`console.error` 分叉删除后 index.ts 一条 lint 错误消失（基线 6 errors/1 warning → 5/1；剩余 noNonNullAssertion@4545 与 organizeImports 为改动区域外存量问题，经 stash 复核基线确认与本轮无关）。

### medium-2：声明×运行值交叉核对（health.ts + config.ts；三轮复现，本轮修复）

- `PrivacyViolationId` 扩展 `"runtime_llm_trace_enabled"`（doc 注释写明：非声明规则，仅由健康检查运行值交叉核对上报——服务自身证伪部署声明时的运行证据）。
- `readVersion` 改回 `{ version?, llmTrace? }`：从 `/version` 的 `features.llm_trace`（布尔）读运行值；缺失/不可读即「无证据」，既不判合规也不判违规。
- service_up 路径交叉核对：声明 `llmTraceEnabled=false` 而运行 `features.llm_trace=true` → 升级 `config_noncompliant` + `violations=["runtime_llm_trace_enabled"]`（附 version）；一致 → 照常 `service_up`。gateway_down 路径不交叉核对（照旧）。
- 如实注释：retention/backup 运行值 API 不可读，仍靠部署对账（#391 清理证据票继续）；文件头补交叉核对一段，`readVersion` 注释写明「不可读=无证据，绝非违规」。
- 新增单测 3：正例（声明 false+运行 true → noncompliant + violations + version）、反例（一致 → service_up、violations undefined）、诚实边界（运行 flag 缺失 → 无证据 → service_up）。

### low：gateway_down 语义文档化（health.ts 网关探针 catch 注释）

- 写明：所有非 2xx（4xx/5xx）经 `requestJson` 抛出走同一 catch、统一归 `gateway_down`；#393 接线后 apiToken 配错会以上报为「网关不可用」形态出现——状态含义是「探针路径未经批准网关走通」，不作故障定位诊断。

### 真实实例交叉核对复测（openbot-hindsight 8888，key localtest-hindsight-key）

- 反例（真实部署原样）：声明 false + 运行 `llm_trace:false` → `service_up`（version 1.0.0，`verify-health.ts happy` exit 0）。
- 正例（一次性容器，不触碰部署）：`docker commit` 真实容器快照 + `HINDSIGHT_API_LLM_TRACE_ENABLED=true`（`HF_HUB_OFFLINE=1` 复用已缓存模型）起 127.0.0.1:8890 一次性实例，其 `/version` 如实回报 `llm_trace:true`，`checkHindsightHealth` 返回 `{"state":"config_noncompliant","violations":["runtime_llm_trace_enabled"],"version":"1.0.0"}`。
- 复测后清理：一次性容器/镜像/含 key 的临时 env 文件已删；真实容器未动（healthy 17h+，`llm_trace:false` 复核）。注：standin 网关 9100 本轮开始时未运行，已从本工作区 `deploy/hindsight/test/gateway-standin.mjs` 重启（对齐本报告记录的本机运行态，进程存续）。

### ocr3-fix 后 sha256（4 个改动文件）

| 文件 | 改前（ocr2-fix 后） | 改后（ocr3-fix） |
| --- | --- | --- |
| server/src/index.ts | ceb5e58134fbfa898da936bfc023c3ef03c8fb2c9ff659f34b27db4636266a42 | 21f9fd8c007796904456303c99fb76297910b3b4890e8a4dd674c4060884a116 |
| server/src/hindsight/health.ts | e619eebfe3fc12d8498bab804a64566eb3e83b1d3f3982d54f434f28d06c8ff6 | ffa9d47758bec4861951f8079c74e49e8a6a80c7fa9cfaa9e22cdff08ed5a563 |
| server/src/hindsight/config.ts | 59c72eac54304ba3808e46710495e6124d42b819458b5b9daeaca686320db956 | 6ce1b396a0e0476778b8fae76b09a73bf2628e86ea5ff97b793554ee1f69931c |
| server/tests/hindsight-health.test.ts | f6fc21d6f2adce4264b6bf21eae9a959accdd853f3da5ad5a1e0388d51626229 | 1d85e90438beaf7c3d06aad95535a103f5ff00783c268a834e476bfce75199e8 |

### ocr3-fix 验证证据

- `cd server && TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5573/openbot_hs01_378_test bun test`（12 文件：memory-defaults 14、memory-intelligence 11、memory-runtime 9、memory-store 20、proactive-store 6、memory-expiry 3、memory-sensitivity 7、intelligence-memory 5、memory-default-source-tool 7、memory-shared-source 3、memory 8、proactive 8）→ **101 pass / 0 fail（385 expect）**，与本轮开始实测基线逐文件一致（sweepStep 行为不变）。说明：任务简报记基线为 104，本轮开工实测基线即 101/0 fail、收工仍 101/0 fail，无任何失败用例；差异系计数口径，如实记录备查。
- `bun test ./tests/hindsight-config.test.ts ./tests/hindsight-health.test.ts` → **26 pass / 0 fail（61 expect）**：基线 23 + 新增 3，不回退（config 14 + health 12）。
- `bunx tsc --noEmit` → exit 0。
- `bunx biome check src/hindsight/health.ts src/hindsight/config.ts tests/hindsight-health.test.ts` → exit 0、0 问题；`src/index.ts` 仅存量 findings（见 medium-1 说明，非本轮引入）。
- `git status`：全部改动仍未提交（index.ts 为 tracked 未暂存，hindsight 三文件 untracked/未暂存）；无 commit/push/merge/部署动作。

## 附录：wave-2（backup.sh 先行 rework 补记，task_448975ce2ad6 处置轮 2 复审 F-B2 + 轮 4 复审 F-C2，2026-10-16T22:3x+08:00）

补记对象是**本轮（ocr4-fix）之前已落盘的 backup.sh rework**：`538d0fc4ae55708ac784b01c086f5aa49b70cb288c199f5f1399a450515455a6`（ocr-fix 后记录值）→ `b7270f9d54b2c2a3a7b669f88aea457007535cb047d737773ebceb45e6dc8cbf`（wave-2 改动本体，mtime 2026-10-16 10:58；本附录落笔前重算哈希复核一致）。该 rework 当时未在本文档登记，致使检查点链出现覆盖缺口（F-B2/F-C2 两条 info 的标的）；此处补记后缺口闭合。本轮 ocr4-fix 另有其后的一次改动（见下附录），不与本节混淆。

### 改动描述（按 ocr2-fix-review §2b/§3 的全文归属）

- **轮 1 既有要素全部保留**（即任务简报所列 rework 要点）：口令仅经 stdin 进入容器（`printf '%s\n' | docker compose exec -T sh -c 'IFS= read -r PGPASSWORD …'`，任何 argv 均不含口令）；写入走隐藏 `.hindsight-<stamp>.sql.gz.part` 临时文件，`gzip -t` 通过后才 `mv` 正式名，EXIT trap 清理残留；sweep 阈值 `-mtime +$((RETENTION_DAYS - 1))`（满 30 整天即删，含精确 30 天边界）；另有 `umask 077`、retention 三级解析与 1..30 校验（0 显式拒绝）。
- **wave-2 新增**：① M4——容器 manifest（instance.json）输出恰 4 行非空的形状校验，且在任何使用之前、拒绝文案零泄漏（口令不回显）；② M5——`RETENTION_DAYS=$((10#$RETENTION_DAYS))` 十进制重基（消除 08/09 八进制崩溃与 030→24 静默提前 sweep）；③ flock + 无 flock 主机的 noclobber 独占创建 + PID 戳回退锁（stale 偷锁、LOCK_STYLE 区分清理）；④ 两条 `docker compose` 调用带 `-f "$HERE/docker-compose.yml"` 显式锚定（F-B3：归属不可溯源，语义良性）。

### 验证证据引用（均系该 rework 落盘后的独立复测，非本轮新跑）

- `reports/ocr2-fix-review.md` §3：M4/M5/flock 逐项解决判定与锁行为探针 ①–④（正常跑零残留、存活 PID 拒绝、死 PID 偷锁、PID 1 误判边界 F-B1）。
- `reports/ocr2-fix-review.md` §4：真实容器复跑 exit 0（0600、8,026 B gzip / 57,902 B 明文、dump 头尾完整、`.part`/锁文件零残留）；ticket-378 §2 规范 12 文件套件 104/0；hindsight 2 文件 23/0；`bash -n`、`shellcheck -S warning` 0 findings。
- 脚本内 sweep 注释自带的边界复测记录（2026-10-15 首测 + 2026-10-16 rework 后复测，29.0d/29.5d 保留、30.0d/30.5d/31d 删除）。

## 附录：ocr4-fix（OCR 轮 4 medium×2 处置 + F-C1/F-C2 文档 findings，task_448975ce2ad6，2026-10-16T22:1x–22:3x+08:00）

在 `/Users/wuyongjun/trea/OpenBot-hindsight-exec` 执行。改动仅 `deploy/hindsight/backup.sh` + `deploy/hindsight/test/verify-health.ts` + 本报告（只追加）；无 commit/push；真实容器未触碰（全程 `Up (healthy)`，9999 保持不发布）。轮 4 的 11 条 low 明确不修（Wave 2 记录）。

### medium-1：sweep 移至 dump 链之前（backup.sh）

- 改动：retention sweep 块（注释 + `find … -mtime "+$((RETENTION_DAYS - 1))" -delete`）从脚本末尾（`gzip -t`/`mv` 之后）移到**锁获取之后、容器 manifest 读取之前**——该块仅依赖宿主侧已校验的 `BACKUP_DIR` 与 `RETENTION_DAYS`，不依赖容器。`set -euo pipefail` 下 dump 链路任何一步失败（容器不在、manifest 变动、compose 漂移）此后都不再阻止过期副本删除。
- `+$((RETENTION_DAYS - 1))` 边界语义与既有边界注释（`-mtime +N` 语义、`+0..+29` 域、两轮边界实测记录）逐字保留；头注的 sweep 位置指引（"at the bottom"）同步更新。
- 新增取舍注释：≤30 天窗口是硬性隐私上限，dump 失败不得延长已过期副本的存活（cron 仅写 backup.log、健康检查无备份证据、#391 跟踪对账）；sweep 先于 dump 也不可能误删本次将写入的新副本（尚不存在）。

### medium-2：verify-health.ts 崩溃路径治理

- 改动：`loadHindsightConfig(env)` 与 `await checkHindsightHealth(config)` 整体 try/catch；catch 内 `console.error` 一行简明诊断（`<scenario>: <error.message 首行>`，不打印堆栈）后 `process.exit(1)`。成功路径的"每场景一行 JSON + 退出码"契约不变；文件头注补一行崩溃路径说明。

### ocr4-fix 后 sha256

| 文件 | 改前 | 改后 |
| --- | --- | --- |
| deploy/hindsight/backup.sh | b7270f9d54b2c2a3a7b669f88aea457007535cb047d737773ebceb45e6dc8cbf（wave-2 值） | 19beb92f960d09ac3ef0f02e579e02a1bd05443d7467f8e0b61c202220f95abb |
| deploy/hindsight/test/verify-health.ts | dff177095367b7c41ac79ab494bf96abdafd06ae4aff187b37c853b4e7b069a2（轮 1 基线） | 590ffddf075b1f47549c709e2bca1c383e395e9bba8a01d7fb19a6789dcefa5b |

其余交付文件本轮零改动。

### ocr4-fix 验证证据（全部本轮亲自跑）

- `bash -n deploy/hindsight/backup.sh` → 通过。
- **失败演练（/tmp/ocr4-drill/，未触仓库）**：复制改后 backup.sh 至 /tmp 目录（无 hindsight.env → 默认 30d），`touch -t` 造 31 天龄（2026-09-15 12:00）与 29 天龄（2026-09-17 12:00）副本各一，PATH 前置一个 `exit 1` 的 docker stub 使 dump 链在 manifest 读取处失败 → 脚本 **exit 1**（stderr 仅 stub 报错行），且 **31 天副本已被删除、29 天副本保留**；目录内零 `.part`/锁文件/新产物残留。证明 sweep 不再依赖 dump 成功。
- **四场景 verify-health（真实实例 openbot-hindsight 8888，key localtest-hindsight-key；standin 网关临时拉起于 9100，`--log /tmp/hindsight-gateway-standin-ocr4.log`，用后 pkill 并确认 9100 监听归零）**：

  | 场景 | 输出（单行 JSON，契约不变） | exit |
  | --- | --- | --- |
  | happy（standin up） | `{"scenario":"happy","expected":"service_up","state":"service_up","checkedAt":"2026-10-16T14:23:43.197Z","version":"1.0.0"}` | 0 |
  | gateway-down（pkill 后） | `{…"state":"gateway_down","checkedAt":"…14:23:50.254Z","version":"1.0.0"}` | 0 |
  | bad-config（`HINDSIGHT_PRIVACY_LLM_TRACE_ENABLED=true`） | `{…"state":"config_noncompliant","violations":["llm_trace_enabled"]}` | 0 |
  | service-down（`HINDSIGHT_API_URL=http://127.0.0.1:59999` 覆写，容器未动） | `{…"state":"service_down","checkedAt":"…14:23:51.853Z"}` | 0 |

- **新增手工场景（env 清空）**：`env -u` 全部 HINDSIGHT_* 后 `bun deploy/hindsight/test/verify-health.ts happy` → 仅一行简明错误 `happy: HINDSIGHT_API_URL is required and is not configured.`，**exit 1，无堆栈**。
- **规范 12 文件套件**（逐字引用 ticket-378 §2 清单，未替换任何文件）：`cd server && TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5573/openbot_hs01_378_test bun test ./tests/memory-sensitivity.test.ts ./tests/memory-expiry.test.ts ./tests/memory-store.integration.test.ts ./tests/memory-runtime.test.ts ./tests/memory.test.ts ./tests/memory-intelligence.integration.test.ts ./tests/memory-shared-source.test.ts ./tests/memory-defaults.integration.test.ts ./tests/memory-default-source-tool.test.ts ./tests/proactive-store.integration.test.ts ./tests/intelligence-memory.test.ts ./tests/bot-lifecycle.integration.test.ts` → **104 pass / 0 fail（408 expect）/ 12 files**。
- **hindsight 两文件**：`bun test ./tests/hindsight-config.test.ts ./tests/hindsight-health.test.ts` → **26 pass / 0 fail（61 expect）**。
- **类型检查**：`cd server && bunx tsc --noEmit` → 0 错误（exit 0）。
- `git status`：`deploy/` 与本报告仍全部 untracked；HEAD 仍为 `f0520524`；无 commit/push/merge/部署动作；9100 复核 0 监听。

## 附录：ocr5-fix（OCR 轮 5 findings 处置：1 medium + 4 顺手 low，task_c11c6036bc85，2026-10-16T23:0x+08:00）

OCR 轮 5（`/tmp/ocr-result-r5.json`，session ff591092，partial：12 选 3 败于 429）共 7 comments（1 medium / 6 low）。本轮处置 5 项：medium 全部（env 默认值 + stand-in 硬护栏）；low 顺手 3 项（参数解析、请求流 error、backup.sh 注释失实）。未修 2 条 low（stand-in 近死代码 `path.startsWith` 简化、日志写入 try/catch + EADDRINUSE 'error'）与 verify-health.ts `process.exit` 截断 1 条 low，留待 Wave 2 记录。改动仅 `deploy/hindsight/hindsight.env.example`、`deploy/hindsight/test/gateway-standin.mjs`、`deploy/hindsight/README.md`、`deploy/hindsight/backup.sh`（仅注释）+ 本报告（只追加）；无 commit/push；真实容器未触碰；`iostat -c` 未运行。

### medium：env 默认 9100 URL 改 change-me 占位符 + stand-in 非回环硬护栏

- **hindsight.env.example**：`HINDSIGHT_API_LLM_BASE_URL` 与 `HINDSIGHT_API_EMBEDDINGS_OPENAI_BASE_URL` 两处默认值 `http://host.docker.internal:9100/v1` → `change-me-gateway-base-url`（与文件内 `change-me-*` key 占位符惯例一致）。实测该占位符连 URL 都不是，照抄不改会被 config.ts `bareOrigin` 校验 fail-loud 拒绝（旧默认带 `/v1` 路径同样过不了裸 origin 校验，但形似可用、易被误当生产值）。`host.docker.internal:9100` 指引降级为纯注释，显式标注**仅限隔离本地验证（针对 stand-in）、绝不用于生产**；生产填 approved gateway URL 的指引保留。
- **gateway-standin.mjs 硬护栏**：`--host` 为非回环值（127.0.0.1/::1/localhost 之外）且未同时传 `--allow-non-loopback` 时，在绑定任何端口之前打印 5 行简明拒绝（未鉴权测试替身、载荷含个人记忆内容、仅限隔离本地验证、绝不指向生产）并 **exit 2**。默认回环绑定行为不变。文件头 Usage 同步说明。
- **README 同步**：`hindsight.env.example` 布局条目改为"change-me 占位符 + 填 approved gateway /v1 根 + host 地址仅限隔离本地验证"；`test/gateway-standin.mjs` 布局条目补充非回环绑定需 `--allow-non-loopback` 的护栏说明。README 内不存在裸 `--host 0.0.0.0` 用法（grep 复核，唯一出现处即护栏说明本身）。

### 顺手 low（同文件/注释）

- **gateway-standin.mjs 参数解析**：`--port/--host/--log` 缺参（旗标为最后一个参数）或 `--port` 非整数/越界（有效域 1..65535）时输出可读报错并 exit 2，不再 NaN/undefined 裸崩；`--port` 值误接下一旗标（`--port --host`）同样可读拒绝。
- **gateway-standin.mjs 请求流 error 处理器**：为 `req`/`res` 挂 `error` 监听（记录 `request-error`/`response-error` 后继续服务）。客户端请求体传输中途断连（探针超时中止）不再以未捕获 ECONNRESET 崩掉整个替身进程——否则后续验证场景会把替身已死误读成 gateway_down。
- **backup.sh 注释（55-62 区域）**：原文声称 OpenBot 合规检查"接受 0 在 ≤30 上限内仍报 compliant"与 `config.ts` 实现相反（`MIN_BACKUP_RETENTION_DAYS = 1`，`validateHindsightPrivacy` 对 <1 报 `backup_retention_days` 违规）。改为如实描述：服务端以同 1..30 域拒绝 0，越界声明**两侧**都 fail-loud。

### ocr5-fix 后 sha256

| 文件 | 改前 | 改后 |
| --- | --- | --- |
| deploy/hindsight/hindsight.env.example | d109e9f7cb1b8e692bff050f0f534ff2622d5ed58f0431ffc99f1bbc80597735 | 8e3d247e68b97bff1148795298835665fa7ceef153e1a62a4e14b274fd576be0 |
| deploy/hindsight/test/gateway-standin.mjs | 9fd4baed307fae0ce10d56f104781c0909a4935839e6ba2019c1ba1537c413cd | 85852251eed0eac3bb5163f514e800c8b45cbbd9e2b140efb09033b17103a7a8 |
| deploy/hindsight/README.md | e4e8ac871071d5bc3c18fec0a6d46183aadf83e034d701ce7f86a5e57321fb8f | ddf476b04c4ae14ffaad30059a5ae4da6e966c5069ae2a729015ed7fb3d792eb |
| deploy/hindsight/backup.sh | 19beb92f960d09ac3ef0f02e579e02a1bd05443d7467f8e0b61c202220f95abb（ocr4-fix 后值，本轮仅注释） | d7237dfda0acdac5645f29b7cf57a3db687b24e1acf81a8d8c284467659dec59 |

其余交付文件本轮零改动；本报告 sha256 改前 fcfd587f8f1f03e8bb84c9995250248d8f805831215b45786296dd8876afdea8。

### ocr5-fix 验证证据（全部本轮亲自跑）

- `bash -n deploy/hindsight/backup.sh` → 通过；`node --check deploy/hindsight/test/gateway-standin.mjs` → 通过。
- **stand-in 行为矩阵**（探针端口 19102–19107，日志全部入 /tmp 并已清理）：
  - 默认绑定：127.0.0.1:19104 LISTEN，`POST /v1/chat/completions` 往返返回 stand-in chat.completion JSON。
  - `--host 0.0.0.0`（无旗标）：5 行拒绝文案，**exit 2**，lsof 复核 **0 监听**。
  - `--host 0.0.0.0 --allow-non-loopback --port 19105`：绑定 `*:19105`，`/v1/chat/completions` 与 `/models` 往返均 200；kill 后复核 **0 监听**。
  - 中途断连（修复 4）：`--limit-rate 10k --max-time 1` 上传 2MB 请求体强制中途 abort（curl exit 28）→ 替身日志记 `{"kind":"request-error","error":"Error: aborted"}`，**进程存活**，后续 `/v1/chat/completions` 往返仍 200；验证完 kill 并复核 19107 **0 监听**。
  - 参数报错：`--port`（缺参）、`--port abc`、`--port 70000`、`--host`（缺参）→ 各一行可读报错，**exit 2**。
- **example 复核**：`grep -E '^[^#].*9100'` → 0 行；两处 `*_BASE_URL=` 均为 `change-me-gateway-base-url`。
- **README 复核**：`grep -- '--host 0.0.0.0'` 仅命中护栏说明条目（含 `--allow-non-loopback`），无裸用法残留。
- **规范 12 文件套件**（逐字引用 ticket-378 §2 清单，未替换任何文件）：`cd server && TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5573/openbot_hs01_378_test bun test ./tests/memory-sensitivity.test.ts ./tests/memory-expiry.test.ts ./tests/memory-store.integration.test.ts ./tests/memory-runtime.test.ts ./tests/memory.test.ts ./tests/memory-intelligence.integration.test.ts ./tests/memory-shared-source.test.ts ./tests/memory-defaults.integration.test.ts ./tests/memory-default-source-tool.test.ts ./tests/proactive-store.integration.test.ts ./tests/intelligence-memory.test.ts ./tests/bot-lifecycle.integration.test.ts` → **104 pass / 0 fail（408 expect）/ 12 files**。
- **hindsight 两文件**：`bun test ./tests/hindsight-config.test.ts ./tests/hindsight-health.test.ts` → **26 pass / 0 fail（61 expect）**。
- **类型检查**：`cd server && bunx tsc --noEmit` → 0 错误（exit 0）。
- **清理（F-D1 教训）**：/tmp 探针产物（3 份 stand-in 日志、stdout 转储、2MB 大请求体）全部删除，复核 0 残留；无残留替身进程；19102–19107 全部归零。
- HEAD 仍为 `f0520524`，全部改动保持未提交。

## 附录：ocr6-fix（OCR 轮 6 findings 处置：3 medium 全修，task_2eab9fbc6546，2026-10-16T23:45+08:00）

OCR 轮 6（`/tmp/ocr-result-r6.json`，session acb760bd，partial：12 选 5 败于 429）共 10 comments（3 medium / 7 low）。本轮处置 medium 全部 3 项；7 条 low 明确不修，留待 Wave 2（清单见文末）。改动仅 `server/src/hindsight/health.ts`、`deploy/hindsight/backup.sh`、`server/tests/hindsight-health.test.ts` + 本报告（只追加）；无 commit/push；真实容器配置未触碰；`iostat -c` 未运行；本轮 /tmp 探针产物（2 个演练目录 + 4 个输出重定向文件）用后已全部删除，复核 0 残留（`/tmp` 下另有 `ocr6-app-tests.log` 等 4 份他物，非本轮产物，未触碰）。

### medium-D：两处探测失败日志 info → warn（health.ts）

`hindsight-health-service-probe-failed` 与 `hindsight-health-gateway-probe-failed` 两处 `log.info` 升为 `log.warn`，与仓库后台巡检/探测失败既有惯例对齐（`server/src/index.ts` "[handoff] a sweep could not run"、`routines/sweep.ts`、`work/culler.ts:217` 等）。日志字段结构（type/error/detail/timestamp）不变；状态对象仍只报状态与规则名。

### medium-E：backup.sh retention 缺失声明响亮失败

两层解析（进程 env → hindsight.env 锚定 KEY= 匹配，末次出现优先、引号/CR 剥离、10# 重基）之后 `RETENTION_DAYS` 仍为空时，删除原 `RETENTION_DAYS="${RETENTION_DAYS:-30}"` 静默默认，改为 stderr 单行说明（必须显式声明 `HINDSIGHT_PRIVACY_BACKUP_RETENTION_DAYS=1..30` 于环境或 hindsight.env；OpenBot 隐私健康检查把缺失声明判为 noncompliant，隐式默认会使两组件失同步）并 **exit 1**。1..30 域校验、10# 前导零重基、sweep 前置于 dump 的语义全部不变。同步修正 4 处注释：头注 retention 段（删除两处 "default 30" 表述、写明"无隐式默认、缺失即响亮失败"的原因）、fallback 注释（"missing key leaves RETENTION_DAYS empty for the default" → "…fails loudly right after this block"）、r5 写的 "An out-of-domain declaration therefore fails loudly on BOTH sides" → "A **missing or out-of-domain** declaration…"（使其对缺失声明也为真）、sweep 边界注释 "default 30-day window" → "a 30-day window"。

### medium-F：service 探测粗粒度映射注释 + gateway 注释失实修正 + /health 401 回归测试（health.ts + 测试）

- service 探测 catch 注释写明粗粒度映射：service_down 涵盖"连接失败/超时"与"服务应答但被拒"两类——`/health` 在 ApiKeyTenantExtension 开启时同样要求 Bearer token，apiToken 配错/轮换失误时 401 也落此态；四态无鉴权裁决，日志 detail 中的 HTTP status（"request failed with status 401"）是两类失败的分隔符（= 修 token，不是重启容器）。
- gateway 探测 catch 注释修正失实表述：原文 "an apiToken misconfigured for Hindsight surfaces as 'gateway unavailable'" 不成立——token 错在 `/health` 即 401 落 service_down，根本到不了网关路径；改为如实描述：本 catch 仅在 `/health` 已成功（token 被接受）后可达，此处落的是探测自身的 4xx/5xx（如 bank 改名/删除后的 404）与连接类失败。
- `server/tests/hindsight-health.test.ts`：fetchDouble 支持处理器直接返回原始 `Response`（钉住非 2xx 答复；其余路径保持恒 200 包装不变）；新增回归测试 "service answers but rejects the token (/health 401) -> service_down (ocr6)"——healthyService 全套路由 + `/health` 覆写为 401，断言 `state === "service_down"`（若实现漏放 401 过服务探测，该测试会以 service_up 失败，区分度明确）。

### ocr6-fix 前后 sha256

| 文件 | 改前 | 改后 |
| --- | --- | --- |
| server/src/hindsight/health.ts | ffa9d47758bec4861951f8079c74e49e8a6a80c7fa9cfaa9e22cdff08ed5a563 | 36d0c67d5a76ab575b222c2bfa6e7cb2c29dd9049659de2537d8b5d9b3c3c86f |
| deploy/hindsight/backup.sh | d7237dfda0acdac5645f29b7cf57a3db687b24e1acf81a8d8c284467659dec59 | 75f9aa392778e02241077fb789856b392343a49326658bfb87df1a86ed734456 |
| server/tests/hindsight-health.test.ts | 1d85e90438beaf7c3d06aad95535a103f5ff00783c268a834e476bfce75199e8 | 2f78d83d4f953b0cfe036329de85a48170c1621a37887f196447f3a32d0346d4 |

其余交付文件本轮零改动；本报告 sha256 改前 6a2a4e1362b335205be1b57c592385cc09d397fae82e4c8b6529f5915a4cb0dc（追加本附录即得终态，与 ocr5 附录同惯例不内嵌含自身的改后值）；HEAD 仍为 `f0520524`，全部改动保持未提交。

### ocr6-fix 验证证据（全部本轮亲自跑）

- `bash -n deploy/hindsight/backup.sh` → 通过。
- **无任何 RETENTION 声明演练（/tmp/ocr6-drill-noret/，已清理）**：脚本副本置于无 hindsight.env 的 /tmp 目录、`env -u` 清掉环境变量后运行 → **exit 1**，stdout 0 字节，stderr 恰 **1 行**：`refusing to run: HINDSIGHT_PRIVACY_BACKUP_RETENTION_DAYS must be declared explicitly (1..30) in the environment or in hindsight.env; OpenBot's privacy health check judges a missing declaration noncompliant, so an implicit default would desync the two components`。
- **显式 env=30 + docker stub 失败链路（/tmp/ocr6-drill-sweep/，已清理，ocr4 同法）**：`touch -t` 造 31 天龄（2026-09-15 23:43）与 29 天龄（2026-09-17 23:43）副本各一，PATH 前置 `exit 1` 的 docker stub → 脚本 **exit 1**（stderr 仅 stub 报错行），且 **31 天副本已被删除、29 天副本保留**；零 `.part`/锁文件残留（sweep 前置于 dump 语义不变）。
- **边界变体三连（同目录）**：hindsight.env 存在但无该键 → 同一缺失声明报错 exit 1；声明 45 → 原域校验报错（"must be a whole number between 1 and 30 (got \"45\"…)"）exit 1；声明 `"30"`（引号 + CRLF）→ 两层解析照常剥引号/CR，通过校验进入 dump 链后在 stub 处 exit 1（解析语义不变实证）。
- **规范 12 文件套件**（逐字引用 ticket-378 §2 清单，未替换任何文件）：`cd server && TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5573/openbot_hs01_378_test bun test ./tests/memory-sensitivity.test.ts ./tests/memory-expiry.test.ts ./tests/memory-store.integration.test.ts ./tests/memory-runtime.test.ts ./tests/memory.test.ts ./tests/memory-intelligence.integration.test.ts ./tests/memory-shared-source.test.ts ./tests/memory-defaults.integration.test.ts ./tests/memory-default-source-tool.test.ts ./tests/proactive-store.integration.test.ts ./tests/intelligence-memory.test.ts ./tests/bot-lifecycle.integration.test.ts` → **104 pass / 0 fail（408 expect）/ 12 files**（容器 openbot-hs01-378-pg @5573，与 #378/#380 前轮同一专用库）。
- **hindsight 两文件**：`bun test ./tests/hindsight-config.test.ts ./tests/hindsight-health.test.ts` → **27 pass / 0 fail（62 expect）**（基线 26 + ocr6 新用例 1）。
- **类型检查**：`cd server && bunx tsc --noEmit` → 0 错误（exit 0）。
- 改动后仅触碰上表 3 文件 + 本报告；`git status` 无新增改动路径；无 commit/push/部署动作。

### 规范清单口径

规范 12 文件 = ticket-378 §2 报告第 317 行命令中的逐字文件清单（#377 全套 + #378），本轮未增删替换任何文件；hindsight 两文件为 `hindsight-config.test.ts` + `hindsight-health.test.ts`。基线数字：12 文件改前即为 104/0/408（本轮改动不触及其覆盖面，改后同数）；hindsight 两文件改前 26/0（61 expect），改后 27/0（62 expect），增量即本轮 1 条回归测试。

### Wave 2 记录（OCR 轮 6 未修的 7 条 low，全部保留原样）

1. `server/src/hindsight/health.ts:190` — 租户段 `"default"` 模块常量，建议收敛进 HindsightConfig 与 HINDSIGHT_BANK_ID 同源管理（MT039 前收敛）。
2. `server/src/index.ts:1687` — sweepStep 日志丢调用栈，建议补 stack（或 `{ err }` 交给 pino）。
3. `server/src/memory/sensitivity.ts:120` — 分类器 try/catch 为不可达防御分支（typeof 守卫已提前返回），可简化。
4. `deploy/hindsight/backup.sh:66` — 脚本核心逻辑（域校验/引号剥离/10# 重基/N-1 偏移/双模锁）无自动化测试，仅注释人工测量，建议补 bats/集成测试。
5. `deploy/hindsight/test/gateway-standin.mjs:77` — log() 同步 appendFileSync 无异常保护，日志文件不可写时 uncaughtException 崩掉替身。
6. `deploy/hindsight/test/gateway-standin.mjs:156` — 路由清单与 payload 分支链重复维护，`path.startsWith("/")` 恒真属冗余条件。
7. `deploy/hindsight/test/verify-health.ts:36` — 手工复制/过滤 env 的循环冗余，可直接 `loadHindsightConfig()`。

## 附录：ocr7-fix（OCR 轮 7 修复批次：deploy 侧 2 medium + low 三连，task_1c35abc15ee0，2026-10-17T00:2x+08:00）

OCR 轮 7（`/tmp/ocr-result-r7.json`）共 11 comments（4 medium / 7 low）。本轮修 4 medium 中的 deploy 侧 2 条 + verify-health.ts low 三连（exit 截断 / usage 措辞 / Three-state 头注，3 条同文件一并复现故同批修）；sensitivity 侧 1 条 medium 入 ticket-378 附录。未修 low 记 Wave 2。改动仅 `deploy/hindsight/backup.sh`、`deploy/hindsight/test/verify-health.ts` + 本报告（只追加）；无 commit/push；真实容器未触碰（全程 `Up`，`/health/live` 200，9999 保持不发布）；`iostat -c` 未运行。

### 变更内容

1. **medium（清扫面收敛，backup.sh）**：保留期清扫 find 加 `-maxdepth 1`（BSD find 要求 -maxdepth 位于其他 primary 之前，按 `find "$BACKUP_DIR" -maxdepth 1 -name …` 书写，实测 macOS BSD find 生效）。注释写明理由：本脚本产物只写 BACKUP_DIR 顶层（从不建子目录），限深不损失自身覆盖面，而操作者误传共享目录时不再递归删除他系统同名超龄文件。
2. **medium（.part 兜底清扫，backup.sh）**：新增 `find "$BACKUP_DIR" -maxdepth 1 -name '.hindsight-*.sql.gz.part' -type f -delete`。**无 -mtime 限制**，注释写明：EXIT trap 不覆盖 SIGKILL（OOM killer / kill -9 / 断电），被杀 run 的隐藏半成品（整库 gzip）会永久滞留、绕过 ≤30 天隐私上限；锁串行化保证清扫时刻可见的 .part 必属被杀的先前运行（本次运行的 .part 在清扫之后才创建），故无需时限、即刻回收。
3. **medium（bad-config 场景自足化，verify-health.ts）**：scenario 为 bad-config 时在 env 拷贝上注入 `HINDSIGHT_PRIVACY_LLM_TRACE_ENABLED=true`（validateHindsightPrivacy 在任何网络调用前判定 → 确定性 config_noncompliant），runner 不再依赖运维带外改坏 env。注释说明其余三态不注入的理由：gateway-down 本质依赖停 standin、service-down 依赖死 URL，属环境性场景。输出单行 JSON 与退出码契约不变。
4. **low 三连（verify-health.ts）**：成功路径与 catch 路径的 `process.exit` 改 `process.exitCode` 赋值自然退出（注释一句：强制退出可能截断管道缓冲的 stdout，如重定向进验证报告时）；头注 Three-state → **Four-state**（与被测 health.ts 口径一致）；usage 提示统一为 `bun run verify-health.ts`（与头注一致）。

### ocr7-fix 前后 sha256

| 文件 | 改前 | 改后 |
| --- | --- | --- |
| deploy/hindsight/backup.sh | 75f9aa392778e02241077fb789856b392343a49326658bfb87df1a86ed734456 | c6993e6bcf301d58d2e00e635e942dbe59e77c5d850cc65e17f3eb40a41f2d73 |
| deploy/hindsight/test/verify-health.ts | 590ffddf075b1f47549c709e2bca1c383e395e9bba8a01d7fb19a6789dcefa5b | 5a94cfdf0127c3667b3f7895ab1cd792941d2296a3421917c252feaa579e812a |

其余交付文件本轮零改动；本报告 sha256 改前 68f7d1b168aecb33842f24553c3a6f565683bd5df0e085553953e91fb6f29daa（追加本附录即得终态，同 ocr5/ocr6 惯例）；HEAD 仍为 `f0520524`，全部改动保持未提交。

### ocr7-fix 验证证据（全部本轮亲自跑）

- `bash -n deploy/hindsight/backup.sh` → 通过（改后复跑亦通过）。
- **无声明拒绝演练（/tmp/ocr7-drill-noret/，已清理）**：副本置于无 hindsight.env 的 /tmp、`env -u` 清变量 → **exit 1**，stdout 0 字节，stderr 恰 1 行缺失声明报错（文案不变）。
- **保留期 + maxdepth + .part 演练（/tmp/ocr7-drill-sweep/，已清理）**：声明 env=30；`touch -t` 造顶层 31 天龄（2026-09-15 00:30，实际 31.99d）与 29 天龄（2026-09-17 12:00，实际 29.52d）副本、`subdir/` 内同名超龄副本、顶层伪造 `.hindsight-x.sql.gz.part`；PATH 前置静默 `exit 1` docker stub → 脚本 **exit 1**（dump 链处失败，sweep 先行），**31 天副本已删、29 天副本保留、subdir 同名超龄文件未被删（-maxdepth 1 生效）、伪造 .part 已被新清扫删除**；零 .part/锁文件残留。
- **verify-health bad-config（关键断言，无带外 env）**：仅内联合规 env（8888/localtest-hindsight-key/9100/privacy 三键合规）直跑 `bun run deploy/hindsight/test/verify-health.ts bad-config` → `{"scenario":"bad-config","expected":"config_noncompliant","state":"config_noncompliant","checkedAt":"2026-10-16T16:27:32.580Z","violations":["llm_trace_enabled"]}`，**exit 0**（注入由 runner 自身完成）。
- **happy / service-down 照常**：临时拉起本工作区 standin（9100，`--log /tmp/hindsight-gateway-standin-ocr7.log`）→ happy → `{"…","state":"service_up",…,"version":"1.0.0"}` exit 0；`HINDSIGHT_API_URL=http://127.0.0.1:59999` 覆写 → service-down → `{"…","state":"service_down",…}` exit 0。用后 pkill 并确认 9100 监听归零，临时日志已删。
- **规范 12 文件套件**（逐字引用 ticket-378 §2 清单，未替换任何文件）：`cd server && TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5573/openbot_hs01_378_test bun test …` → **104 pass / 0 fail（420 expect）/ 12 files**（容器 openbot-hs01-378-pg @5573；基线 104/0/408，+12 expect 即 sensitivity 侧本轮新断言；一次因数据库连接瞬时错误失败，立即复跑两次均绿）。
- **hindsight 两文件**：`bun test ./tests/hindsight-config.test.ts ./tests/hindsight-health.test.ts` → **27 pass / 0 fail（62 expect）**（与 ocr6 后基线一致，本批不涉单测覆盖面）。
- **类型检查**：`cd server && bunx tsc --noEmit` → 0 错误（exit 0）。
- **biome**：`bunx biome check`（backup.sh 为 shell 不适用；verify-health.ts / sensitivity.ts / memory-sensitivity.test.ts）→ 0 问题（本轮新增行 2 处折行已当场 `--write` 修复后复核通过）。
- `git status`：仅既有 untracked 路径，无新增改动文件；无 commit/push/merge/部署动作。

### Wave 2 记录（OCR 轮 7 deploy 侧未修的 2 条 low，全部保留原样）

1. `deploy/hindsight/test/gateway-standin.mjs:156` — 路由清单 if/else 分发链与 includes 数组两份硬编码，建议抽取单一路由表同源派生。
2. `deploy/hindsight/test/gateway-standin.mjs:162` — server.listen 缺 `error` 处理器（EADDRINUSE/EACCES 时带原始堆栈崩溃），建议补一行简明输出后退出。

## 附录：ocr8-fix（OCR 轮 8 修复批次：deploy 侧 2 medium，task_41ca275b05dc，2026-10-17T01:5x+08:00）

OCR 轮 8（`/tmp/ocr-result-r8.json`）共 11 comments（3 medium / 8 low）。本轮修 3 medium 中的 deploy 侧 2 条（backup.sh 无 flock 回退 stale 判定的 EPERM 误判；缺声明拒绝文案的双层误导）；sensitivity 侧 1 条 medium 入 ticket-378 附录。8 low 记 Wave 2。改动仅 `deploy/hindsight/backup.sh` + 本报告（只追加）；无 commit/push；真实容器未触碰（`openbot-hs01-378-pg` 全程 `Up` 26h+，合规配置零改动）；`iostat -c` 未运行；`/tmp` 探针（`/tmp/ocr8-drill/`）用后已清理。

### 变更内容

1. **medium（stale 判定 EPERM 误判，无 flock 回退锁）**：`kill -0` 失败不再直接判 stale——POSIX 下对**其他用户**的存活进程 `kill -0` 返回 EPERM（非 0），与真死的 ESRCH 不可区分；在受支持的共享 BACKUP_DIR 模式（cron 以用户 A 持锁、操作员以用户 B 手动运行）下，B 会误判 A 的活锁为 stale，rm 掉活锁并偷取，两 run 并发，B 的无时限 partial 清扫会删掉 A 正在写入的 `.hindsight-*.sql.gz.part`，该次备份丢失。修法：`kill -0` 失败时以 `ps -p "$LOCK_HOLDER" -o pid=` 复核（ps 列他用户 pid 不受信号权限限制，Linux/macOS 皆可用），ps 仍可见（EPERM 情形）按存活处理照常拒绝运行——宁误拒、不可误偷；ps 也不可见（ESRCH，真死）才判 stale 偷锁。分支处新增注释写明 EPERM/ESRCH 语义与 ps 复核理由；上方锁总注释同步补一句指向该分支。
2. **medium（缺声明拒绝文案如实化）**：原文案 "must be declared explicitly (1..30) in the environment or in hindsight.env" 的二选一等价只对脚本自身成立——OpenBot 侧 `server/src/hindsight/config.ts` 的 `loadHindsightConfig` 只读 OpenBot 服务进程 env，不解析 hindsight.env。文案与三处相关注释（头注两组件声明层段、No implicit default 块、validation 块）改为如实表述：脚本侧接受进程 env 或脚本旁 hindsight.env 显式声明；OpenBot 侧隐私健康检查读取的是 **OpenBot 部署环境**的 `HINDSIGHT_PRIVACY_*`（config.ts），仅 hindsight.env 声明时本脚本可跑但健康检查仍报 `backup_retention_days` noncompliant；两侧对齐属部署对账（**#391 跟踪**），头注明确"declare the same number in both layers"。OCR r8 c2 建议的契约守护测试（断言 backup.sh 与 config.ts 键名及 1..30 域字面量一致，防单侧漂移）涉及 `server/tests/hindsight-config.test.ts`，不在本轮授权读写文件清单内，未实施——记 Wave 2 待授权后补。

### ocr8-fix 前后 sha256

| 文件 | 改前 | 改后 |
| --- | --- | --- |
| deploy/hindsight/backup.sh | c6993e6bcf301d58d2e00e635e942dbe59e77c5d850cc65e17f3eb40a41f2d73 | ab12dc1ae301edfd2c8bd1c7a9c438f956c6b745c3b4921be5deb6d455bc165e |

其余交付文件本轮零改动；本报告 sha256 改前 cbf210a330d3f88d08fe282d0749ef12399dfcc1e402c931430f74060752ae5a（追加本附录即得终态，同 ocr5/ocr6/ocr7 惯例）；HEAD 仍为 `f0520524`，全部改动保持未提交。

### ocr8-fix 验证证据（全部本轮亲自跑）

- `bash -n deploy/hindsight/backup.sh` → 通过（改后复跑亦通过）。
- **stale 判定演练（/tmp/ocr8-drill/，副本 + docker stub（标记到达 dump 链后静默 exit 1）+ 声明 env=30，已清理）**：本机为 stock macOS、无 flock，无 flock 回退即真实路径。
  - **死 PID 锁 → 偷锁重建**：锁文件写入 99998（预先 `ps -p` / `kill -0` 双重复核确死）→ 脚本运行 1s 后锁文件内容为 62560（脚本自身存活 PID，旧死锁已被 rm 重建）、run 抵达 dump 链（marker 文件存在）、stderr 零字节无拒绝文案、exit 1（stub 处）、EXIT trap 清锁无残留——stale 偷锁路径按预期工作。
  - **存活 PID 锁 → 拒绝运行（kill -0 成功路径）**：锁文件写入驱动 shell `$$`（存活）→ **exit 1**，stderr 恰一行 `refusing to run: another backup (pid 62780) is holding …`，锁文件内容原样未动，未抵达 dump 链。
  - **EPERM 分支无法本机伪造**：需要另一用户的存活进程，本机不具备条件——以逻辑静态核对为准（`kill -0` 失败 → `ps -p … -o pid=` 复核 → 可见即走拒绝分支、不可见才偷锁）+ ps 语法本机实测（`ps -p <存活pid> -o pid=` 退出 0 并打印 pid；`ps -p <死pid>` 退出非 0），如实说明，不留未验证的断言。
  - **缺声明演练**：`env -u HINDSIGHT_PRIVACY_BACKUP_RETENTION_DAYS`、副本目录无 hindsight.env → **exit 1**，stdout 0 字节，stderr 恰 1 行新三层文案（进程 env / 脚本旁 hindsight.env + OpenBot 部署环境 only + 仅 hindsight.env 声明仍报 noncompliant + #391）。
- **规范 12 文件套件**（ticket-378 §2 第 42 行清单逐字，含 TEST_DATABASE_URL 前缀）：`cd server && TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5573/openbot_hs01_378_test bun test …` → **104 pass / 0 fail / 436 expect / 12 files**（容器 openbot-hs01-378-pg @5573；基线 104/0/420，+16 expect 即 sensitivity 侧本轮新断言；一次通过无重跑）。
- **hindsight 两文件**：`bun test ./tests/hindsight-config.test.ts ./tests/hindsight-health.test.ts` → **27 pass / 0 fail（62 expect）**（与 ocr6/ocr7 后基线一致，本批不涉单测覆盖面）。
- **类型检查**：`cd server && bunx tsc --noEmit` → 0 错误（exit 0）。
- **biome**：`bunx biome check`（backup.sh 为 shell 不适用；sensitivity.ts / memory-sensitivity.test.ts）→ 0 问题（本轮新增行 1 处折行当场 `--write` 修复后复核通过）。
- `git status`：仅既有 untracked/modified 路径（21 项与本轮开工时一致），无新增改动路径；无 commit/push/merge/部署动作。

### Wave 2 记录（OCR 轮 8 deploy 侧未修 low ×4，保留原样）

1. `deploy/hindsight/backup.sh:224` — 清理逻辑只挂 EXIT trap：非交互 bash 被 SIGINT/SIGTERM/SIGHUP 终止时默认不执行 EXIT trap，本次运行的 `.hindsight-*.sql.gz.part`（整库 gzip）会滞留。
2. `deploy/hindsight/test/gateway-standin.mjs:145` — 路由清单双份维护（if 分发链与字面量数组），且 `req.url` 未剥离 query string。
3. `deploy/hindsight/test/gateway-standin.mjs:162` — server.listen 缺 `error` 处理器（EADDRINUSE 等带原始堆栈崩溃）。
4. `deploy/hindsight/test/gateway-standin.mjs:56` — 默认日志落在 `/tmp` 可预测路径且 appendFileSync 跟随符号链接，多用户主机有预放风险。
5. （跨侧待授权）backup.sh ↔ config.ts 键名/1..30 域字面量契约守护测试（OCR r8 c2 建议），需 `server/tests/hindsight-config.test.ts` 写权限。

## 附录：ocr9-fix（OCR 轮 9 修复批次：deploy 侧 1 medium + server 侧 1 medium，Hindsight Wave 1 收敛前最后一批，2026-10-17T02:4x+08:00）

OCR 轮 9（`/tmp/ocr-result-r9.json`）共 8 comments（3 medium / 5 low）。coordinator 裁决：standin 主机名绑定那条（c5，`test/gateway-standin.mjs:63`）为**误报不修**——非集合主机名在 `--host` 字符串集合匹配处本就被拒（`LOOPBACK_HOSTS` 只含 127.0.0.1/::1/localhost，无解析环节，非集合值根本到不了 listen），不存在绕过面；本批修 2 条有效 medium：c3（backup.sh 无 flock 回退锁 PID 复用，deploy 侧）与 c7（store.completeSync 内层敏感静默丢弃，server 侧，入 ticket-378 附录）；5 low 记 Wave 2。改动仅 `deploy/hindsight/backup.sh` + 本报告（只追加）；无 commit/push；真实容器未触碰（docker 经 PATH stub 隔离，真实 docker 二进制未执行）；`iostat -c` 未运行；`/tmp` 探针（`/tmp/ocr9-drill/`）用后已清理。

### 变更内容（c3，medium/bug：无 flock 回退锁的 PID 复用死锁）

锁文件从单字段（PID）改为两字段（**PID + 持有者进程启动时间** `ps -o lstart=`）：创建时写 `"$PID $(ps -p $PID -o lstart=)"`（lstart 不可得时回退旧单字段形式并在注释注明，避免被误读为损坏）；stale 判活保持 kill-0/ps 判存活，**存活后再比对当前 `ps -o lstart=`（两侧规整前后空白后比较）与锁内记录——不匹配即 PID 已被复用，按 stale 偷锁；匹配才拒绝运行**。修复场景：原备份被 SIGKILL（EXIT trap 不运行、本机无 flock）后，其锁在 PID-only 检查下会被任何拿到复用 PID 的长驻进程永久判活——后续所有备份运行直接拒绝退出，备份链静默停摆，仅 stderr 进 cron 日志可见。锁总注释与 holder 分支注释同步更新：PID 复用场景、lstart 比对理由（活 PID ≠ 原持有者的证明；拒绝运行需要启动时间匹配）、lstart 输出带前后空白需规整后再存/比；无记录启动时间（旧单字段锁或 lstart 不可得）或当前 lstart 不可读时，复用无法证明，**降级为拒绝、绝不偷锁**。空读重试逻辑（首字段不可读 → 重试 10 次 → 大声拒绝）与 flock 路径（含 `echo "$$" >&9`）不变；死 PID 分支（kill-0/ps 均不可见 → 偷锁）不变，兼容旧格式。

### ocr9-fix 前后 sha256（deploy 侧）

| 文件 | 改前 | 改后 |
| --- | --- | --- |
| deploy/hindsight/backup.sh | ab12dc1ae301edfd2c8bd1c7a9c438f956c6b745c3b4921be5deb6d455bc165e | c5205a2f44c26adf85b563d74e7fcf8d9892440b9afa64dd962892e76b03a104 |

其余交付文件本轮零改动；本报告 sha256 改前 bcff89ed2aae5c6d7ba063eebf649759bda0852077220eff9090eecf1d47fc6e（追加本附录即得终态，同 ocr5–ocr8 惯例）；HEAD 仍为 `f0520524`，全部改动保持未提交。

### ocr9-fix 验证证据（全部本轮亲自跑，2026-10-17）

- `bash -n deploy/hindsight/backup.sh` → 通过（改后复跑亦通过；首轮编辑曾漏一 `fi` 即被 bash -n 拦下，修复后通过）。
- **锁演练（/tmp/ocr9-drill/，改后脚本副本 + PATH docker stub（打印 DRILL-DUMP-REACHED 到 stderr 后 exit 1，真实 docker 未执行）+ 声明 env=7，已清理）**：本机 stock macOS、无 flock，无 flock 回退即真实路径。持有者探针 `sleep 300`（存活 PID 46105，实测 lstart `Sat Oct 17 02:43:04 2026`）、死探针 `sleep 0` 已退出（kill -0/ps 双复核确死，PID 46109）：
  - **死 PID + 任意 lstart → 偷锁**：锁写 `46109 Wed Dec 25 00:00:00 2019` → 零拒绝文案、抵达 dump 链（marker=1）、exit 1（stub 处）、EXIT trap 清锁无残留、无 partial 遗留。
  - **存活 PID + 伪造 lstart（复用形态）→ 偷锁**：锁写 `46105 Wed Dec 25 00:00:00 2019`（PID 活、lstart 与当前不符）→ 零拒绝文案、marker=1、偷锁成立——本轮修复的目标场景。
  - **真存活（PID + lstart 均当前值）→ 拒绝**：锁写 `46105 Sat Oct 17 02:43:04 2026` → **exit 1**，stderr 恰一行 `refusing to run: another backup (pid 46105) is holding …`，锁文件逐字节未动，未抵达 dump 链（marker=0）。
  - **死 PID 无 lstart 字段（旧格式兼容）→ 仍按死偷锁**：锁写裸 `46109` → 零拒绝文案、marker=1。
  - （加测）**存活 PID 无 lstart 字段（旧格式）→ 拒绝**：锁写裸 `46105` → exit 1 拒绝、锁未动——复用无法证明时降级为拒绝，验证"绝不偷锁"承诺。
- **规范 12 文件套件**（ticket-378 §2 第 42 行清单逐字，含 TEST_DATABASE_URL 前缀）：`cd server && TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5573/openbot_hs01_378_test bun test …` → **105 pass / 0 fail / 439 expect / 12 files**（基线 104/0/436 + server 侧本轮新增 inner-drop 测试 1 个、断言 3 条；一次通过无重跑；容器 openbot-hs01-378-pg @5573）。
- **hindsight 两文件**：`bun test ./tests/hindsight-config.test.ts ./tests/hindsight-health.test.ts` → **27 pass / 0 fail / 62 expect**（与 ocr6–ocr8 后基线一致，deploy 侧本批不涉单测）。
- **类型检查**：`cd server && bunx tsc --noEmit` → 0 错误（exit 0）。
- **biome**：backup.sh 为 shell 不适用；server 侧改动文件结果见 ticket-378 附录（store.ts 唯一 finding 为 HEAD 预存在 noConsole，与本批无关）。
- `git status`：21 项路径与本轮开工时一致，无新增改动路径；无 commit/push/merge/部署动作。

### Wave 2 记录（OCR 轮 9 deploy 侧未修项，保留原样）

1. `deploy/hindsight/backup.sh:85`（c4，low）— 保留期正则 `^[0-9]+$` 不限位数，>64 位纯数字串溢出 `[ -lt/-gt ]`，统一友好拒绝分支被绕过后在 `$((10#…))` 处晦涩中断；建议 `{1,9}` 位数上限。
2. （裁决误报，不修）`deploy/hindsight/test/gateway-standin.mjs:63`（c5）— coordinator 裁定：非集合主机名本就被字符串集合守卫拒绝（无 DNS 解析环节），不存在"解析后静默绑定非回环"的路径，无需旗标。
3. `deploy/hindsight/test/gateway-standin.mjs:156`（c6，low）— 路由清单 if 分发链与 status 数组双份维护，建议单一 ROUTES 常量。

## 附录：ocr10-fix（OCR 轮 10 修复批次：deploy 侧 2 medium，冻结前最后一批，2026-10-17T12:5x+08:00）

OCR 轮 10（`/tmp/ocr-result-r10.json`）共 12 comments（2 medium / 10 low）。本轮修 2 medium：c3（backup.sh flock 分支与创建式锁互盲，`backup.sh:142-146`）与 c9（docker-compose.yml 头注与 r8 修正后的三层真相矛盾，`docker-compose.yml:10-11`）；10 low 已记 Wave 2 不修（见本附录末尾）。改动仅 `deploy/hindsight/backup.sh`、`deploy/hindsight/docker-compose.yml` + 本报告（只追加）；无 commit/push；真实容器未触碰（drill 全程 PATH stub 隔离，真实 docker 二进制仅以 `docker compose version` / `config -q` 只读形式在 /tmp 沙箱运行，零容器操作）；`iostat -c` 未运行；`/tmp` 探针（`/tmp/ocr10-drill/`、`/tmp/ocr10-compose-check/`）用后已清理。

### 变更内容

1. **medium-α（c3，medium/bug：flock 分支与创建式锁互盲）**：原 flock 分支 `exec 9>"$LOCK_FILE"` 打开即截断（抹掉创建式锁持有者的 PID/lstart 指纹），`echo "$$>&9"` 单字段写入亦与新两字段格式不一致，混用两种锁风格时互斥失效——无 flock 方持锁期间，有 flock 方会截断锁文件并直接执行 dump/sweep/.part 清扫，且截断后残留被拒运行死 PID、诱发后续无 flock 运行误偷锁与原持有者并发。修法（保持单主机语义）：① 打开改 `exec 9>>"$LOCK_FILE"`（追加打开不截断，flock 语义不变）；② 取 flock 前先读文件现有内容——可解析为存活持有者指纹（PID[+lstart]，kill -0 + `ps -p` 复核判活、lstart 比对规则与创建式路径一致，含 PID 复用豁免）则大声拒绝（`mixed lock styles detected` 文案，含手工清陈锁提示）；死/空/杂乱（首字段非数字）内容继续；③ `flock -n 9` 成功后，在持有锁状态下把文件重写为本运行两字段指纹（`printf '%s %s\n' PID lstart > "$LOCK_FILE"`，与创建式同格式；lstart 不可得回退单字段，同创建式降级）。注释新增三点：flock 仅在 flock 用户间提供内核级互斥；内容检查覆盖 flock×创建式单主机混用（同一备份目录、不同供给的运行）；跨主机共享目录时 PID/lstart 检查是主机本地的、无法验证他机持有者，跨主机互斥依赖共享文件系统上的 flock。EXIT trap 语义不变（flock 式运行锁文件有意保留）。

2. **medium-β（c9，medium/documentation：compose 头注三层真相矛盾）**：原句 "the value is declared in hindsight.env so OpenBot's compliance check and the backup job agree" 与 r8 修正后的三层真相矛盾（`server/src/hindsight/config.ts` 只读 OpenBot 部署 env、绝不读 hindsight.env）。改为如实三层表述：backup.sh 接受进程 env 或脚本旁 hindsight.env 的显式声明；OpenBot 隐私健康检查只读 OpenBot 部署环境的 `HINDSIGHT_PRIVACY_*`（绝不读 hindsight.env）；仅在 hindsight.env 声明时备份任务照跑而健康检查仍报 noncompliant，两侧对齐属部署对账任务（#391）。

### ocr10-fix 前后 sha256（deploy 侧）

| 文件 | 改前 | 改后 |
| --- | --- | --- |
| deploy/hindsight/backup.sh | c5205a2f44c26adf85b563d74e7fcf8d9892440b9afa64dd962892e76b03a104 | f98b0b8fba1a2cba62a262a8257ec428702689005b2d73aee3d0b5cc3c1fa4d3 |
| deploy/hindsight/docker-compose.yml | 656efbb0869ffebf664fe6d5c68f8362ff5dc214b67cbb8c9dd8723d2285108a | 26bbfe2810a1ddba7b22fb2dc924c8e523cabe98c9011cbfbc5d519f6fb968fa |

其余交付文件本轮零改动；本报告 sha256 改前 dc0097e753ca1de3d4f124858634db683a2666f8083adb13109334b43204bb17（追加本附录即得终态，同 ocr5–ocr9 惯例）；HEAD 仍为 `f0520524`，全部改动保持未提交。

### ocr10-fix 验证证据（全部本轮亲自跑，2026-10-17）

- `bash -n deploy/hindsight/backup.sh` → 通过；`shellcheck -S warning` → 0 findings。
- **flock 分支演练（/tmp/ocr10-drill/，改后脚本副本 + PATH 前置 flock shim（占位实现：`flock -n 9` 恒成功、调用写入 FLOCK_SHIM_LOG 留痕）+ docker stub（打印 DRILL-DUMP-REACHED 到 stderr 后 exit 1，真实 docker 未执行）+ 声明 env=30）**：
  - **活指纹 → 拒绝**：锁写存活探针 `sleep 300`（PID 13743）+ 其实测 lstart `Sat Oct 17 12:37:59 2026` → **exit 1**，stderr 恰一行 `refusing to run: mixed lock styles detected — … (pid 13743) …`，锁文件逐字节未动（cmp 通过），未抵达 dump 链，shim 留痕为空——拒绝发生在 flock 之前。
  - **死 PID 指纹 → 放行 + 锁重写**：探针先取真实 lstart 再终止（kill -0/ps 双复核确死），锁写两字段 → 零拒绝文案、抵达 dump 链（marker=1）、exit 1（stub 处）、shim 恰调用一次、锁文件重写为本运行两字段指纹 `14215 Sat Oct 17 12:38:14 2026`——与创建式 `printf '%s %s\n' PID lstart` 输出逐字节同形（对照 cmp 通过）、单行、首字段数字异于死 PID。
  - **空内容 / 杂乱内容（首字段非数字）→ 均继续**：抵达 dump 链、无拒绝、锁被重写为数字 PID 指纹（规格 ②"死/空/杂乱内容则继续"全分支覆盖）。
- **创建式路径三态复跑（无 shim 的 stubs-noflock PATH；本机 stock macOS 无真实 flock，创建式即真实路径）**：
  - **真活拒绝**（PID + 当前 lstart 均当前值）→ exit 1、`refusing to run: another backup (pid …) is holding …`、锁逐字节未动、未抵达 dump 链。
  - **复用偷锁**（活 PID + 伪造 `Wed Dec 25 00:00:00 2019`）→ 零拒绝、抵达 dump 链、EXIT trap 清锁无残留。
  - **旧格式死 PID 偷锁**（裸 PID 单字段）→ 零拒绝、抵达 dump 链、锁清除。
  - 三态结论与 ocr9 基线一致，行为不变。
- （加测）**反向混用**：flock 式运行写下的两字段活指纹被无 flock 运行读到 → 走既有拒绝路径（宁误拒）exit 1、`another backup (pid …) is holding`、锁未动——两种风格在同一活指纹上双向互斥闭合。
- **docker-compose.yml 语法校验**：/tmp 沙箱（compose 副本 + `hindsight.env.example` 具名为 hindsight.env）`docker compose -f … config -q` → exit 0（Docker Compose v5.5.0）；仓库目录内未运行任何 compose 命令。
- **grep 确认**：`grep -n "agree" deploy/hindsight/docker-compose.yml` → 无命中（旧说法已除）；新三层真相文案位于头注 10–16 行（含 `never reads hindsight.env` / `still reports noncompliant` / `#391`）。
- **脚手架勘误（如实记录）**：首轮创建式三态演练 FAIL 系测试脚手架自身缺陷——PATH 同时前置了 flock shim，`command -v flock` 命中 shim 致脚本走 flock 分支而非创建式路径（其表现恰与 flock 分支规格一致：真活拒绝/复用放行重写/flock 式锁保留）；拆分 `stubs/`（flock shim + docker stub）与 `stubs-noflock/`（仅 docker stub）后复跑三态全 PASS。另首轮 flock 演练 env 键误写 `RETENTION_DAYS`，被缺声明大声拒绝路径正确拦下（意外验证该路径），改用 `HINDSIGHT_PRIVACY_BACKUP_RETENTION_DAYS` 后通过。

### Wave 2 记录（OCR 轮 10 未修项：10 low，保留原样）

1. `server/src/hindsight/config.ts:122-127`（low）— operationRetentionDays=0 可过校验而 backupRetentionDays=0 被拒，write-then-prune 结构相同、0 无说法；建议对称引入 MIN_OPERATION_RETENTION_DAYS 或注释写明（server 侧，按惯例属 ticket-378 追踪）。
2. `server/src/memory/sensitivity.ts:155-157`（low）— catch 兜底返回 "normal" 与凭据类 fail-closed 相悖且分支实际不可达；建议移除或兜底 "credential"（server 侧，同上）。
3. `server/src/memory/store.ts:53`（low）— CANDIDATE_TTL_MS=30 天硬编码；建议部署可配置、默认 30、上限钳 30（server 侧，同上）。
4. `deploy/hindsight/test/gateway-standin.mjs:146`（low）— 路由匹配未剥查询串、路由表 if 链与 status 数组双份维护、`path.startsWith("/")` 恒真冗余。
5. `deploy/hindsight/test/verify-health.ts:30-31`（low）— `scenario in expected` 命中原型链继承键（toString 等）绕过 usage 守卫；建议 `Object.hasOwn`。
6. `server/src/hindsight/health.ts:245-253`（low）— 两处探测失败 log.warn 载荷构造同构，可仿 index.ts 的 sweepStep 抽公共（server 侧，同上）。
7. `server/src/memory/store.ts:337-340`（low）— “confirmed/edited 才可召回/镜像”规则第三份字面副本，注释与片段同步维护成本（server 侧，同上）。
8. `server/src/memory/store.ts:619-621`（low）— expireStaleCandidates 只做本地 tombstone 不触发 mirror，镜像退休失败残留的 intelligenceMemoryId 边界（server 侧，同上）。
9. `deploy/hindsight/test/gateway-standin.mjs:162-166`（low）— server 缺 `error` 事件处理（EADDRINUSE/EACCES 带裸堆栈崩溃）。
10. `deploy/hindsight/backup.sh:85-88`（low）— 本脚本删除性操作/锁协议/多层解析无自动化用例，仅注释人工测量；建议 bats/集成测试（与 ocr6 c4、ocr9 Wave 2 第 5 条同源，跨侧待授权）。

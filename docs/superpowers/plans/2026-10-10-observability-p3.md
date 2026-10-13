# 可观测性 P3（observability 起栈 + 崩溃链路验证）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `docker compose --profile observability up -d` 一键起 Grafana+Loki+Tempo+Prometheus+Alloy+GlitchTip；容器与宿主机日志进 Loki、trace 进 Tempo（补 P2 的 Tempo 验收）、Grafana 开箱即用、GlitchTip 能收 Sentry 协议测试事件。

**Architecture:** 新 compose profile `observability`（沿用 `lago` profile 模式，默认不启动）。配置文件按仓库惯例放 `docker/observability/`，只读 bind mount。日志路径：容器 stdout → Alloy（docker socket 只读发现）→ Loki；宿主机 `.logs/*.log` → Alloy tail → Loki。traces：应用直发 Tempo（宿主进程 `http://127.0.0.1:4318`，容器内 `http://tempo:4318`）。GlitchTip 带独立小 Postgres，不碰主库。

**Tech Stack:** docker compose profiles、Loki 3.x、Tempo 2.x、Prometheus 3.x、Grafana 11.x、Alloy 1.x（River）、GlitchTip latest（digest/版本钉定）、curl 验证。

**Spec:** `docs/superpowers/specs/2026-10-10-observability-design.md` §3.4、§3.5、§3.6、§5-P3、§6-P3；补 P2 遗留的 Tempo 视觉验证。

## Global Constraints

- **端口修正**：spec 原定 Loki 3100 已被 open-connector 占用（compose:665-666 硬编码）——**Loki 用 3102**。终版端口：Grafana 3003、Loki 3102、Tempo 3200（OTLP 4318）、Prometheus 9090、GlitchTip 8001、Alloy 不出宿主。
- 镜像 tag 钉具体版本（对齐仓库钉版本惯例；不追 latest）。
- compose 改动只加 profile 服务与 network 成员；**不改任何现有服务的定义**。compose 里新增服务的网络归属：观测组件进 `default`；Alloy 要访问所有容器日志（docker socket 发现）不要求入 `data`。
- GlitchTip 的 Postgres 是独立容器 + named volume，**严禁**挂主 postgres（lago 用独立库的先例证明主库隔离是仓库红线）。
- 工作树有并行会话活跃脏文件（docker-compose.yml 当前就是脏的！）：**派单前必查 `git status --short docker-compose.yml`**；若脏——对 compose 的修改同样用选择性暂存（P2 验证过的方法），并在提交后 `git show HEAD -- docker-compose.yml` 自证纯净。
- 验证命令：`docker compose config`（语法）、`docker compose --profile observability up -d`、curl 各健康端点；已知基线失败（tenancy 测试 DB、market 会话遗留 lint 警告）不算新增。
- `.env.example` / `docs/observability.md` 若与并行脏文件重叠，用选择性暂存。

---

### Task 1: docker/observability/ 配置目录 + compose 服务（LGTM + Alloy）

**Files:**
- Create: `docker/observability/loki-config.yaml`、`tempo-config.yaml`、`prometheus.yml`、`alloy-config.alloy`、`provisioning/datasources/observability.yaml`、`provisioning/dashboards/provider.yaml`、`provisioning/dashboards/openbot-starter.json`
- Modify: `docker-compose.yml`（追加 5 个服务 + network 成员）
- Modify: `.env.example`（观测栈端口与开关样例；若并行脏则选择性暂存）

**Interfaces:**
- Produces: 端口契约（后续任务与文档依赖）：Grafana `127.0.0.1:3003`、Loki `127.0.0.1:3102`、Tempo `127.0.0.1:3200` + OTLP `127.0.0.1:4318`、Prometheus `127.0.0.1:9090`。Alloy 以 `alloy` 服务名入 `default` 网络；容器内应用经 `http://loki:3102`、`http://tempo:4318` 访问。

- [ ] **Step 1: 写配置文件**（全部实际内容，无占位）

`docker/observability/loki-config.yaml`（单二进制、文件系统后端、7 天留存）：

```yaml
auth_enabled: false
server:
  http_listen_port: 3100
  grpc_listen_port: 9096
common:
  instance_addr: 127.0.0.1
  path_prefix: /loki
  storage:
    filesystem:
      chunks_directory: /loki/chunks
      rules_directory: /loki/rules
  replication_factor: 1
  ring:
    kvstore:
      store: inmemory
schema_config:
  configs:
    - from: "2024-01-01"
      store: tsdb
      object_store: filesystem
      schema: v13
      index:
        prefix: index_
        period: 24h
limits_config:
  retention_period: 168h
  reject_old_samples: false
ruler:
  storage:
    filesystem:
      directory: /loki/rules
```

`docker/observability/tempo-config.yaml`（单机、文件存储、OTLP 接收 4318）：

```yaml
server:
  http_listen_port: 3200
distributor:
  receivers:
    otlp:
      protocols:
        http:
          endpoint: 0.0.0.0:4318
        grpc:
          endpoint: 0.0.0.0:4317
storage:
  trace:
    backend: local
    local:
      path: /tempo/blocks
    wal:
      path: /tempo/wal
compactor:
  compaction:
    block_retention: 168h
```

`docker/observability/prometheus.yml`（抓自身；应用目标 P4 再加）：

```yaml
global:
  scrape_interval: 15s
scrape_configs:
  - job_name: prometheus
    static_configs:
      - targets: ["localhost:9090"]
```

`docker/observability/alloy-config.alloy`（River：docker 发现 + .logs tail → Loki）：

```river
discovery.docker "containers" {
  host = "unix:///var/run/docker.sock"
  refresh_interval = "5s"
}

discovery.relabel "containers" {
  targets = discovery.docker.containers.targets
  rule {
    source_labels = ["__meta_docker_container_name"]
    regex        = "/(.*)"
    target_label = "container"
  }
}

loki.source.docker "containers" {
  host       = "unix:///var/run/docker.sock"
  targets    = discovery.relabel.containers.output
  forward_to = [loki.write.default.receiver]
  labels     = { source = "docker" }
}

local.file_match "host_logs" {
  path_targets = [
    {
      __path__  = "/hostlogs/*.log",
      job       = "host-process",
      "service" = "host",
    },
  ]
}

loki.source.file "host_logs" {
  targets               = local.file_match.host_logs.targets
  forward_to            = [loki.write.default.receiver]
  tail_from_end         = false
}

loki.write "default" {
  endpoint { url = "http://loki:3102/loki/api/v1/push" }
}
```

`docker/observability/provisioning/datasources/observability.yaml`：

```yaml
apiVersion: 1
datasources:
  - name: Loki
    type: loki
    access: proxy
    url: http://loki:3102
    isDefault: true
    jsonData:
      derivedFields:
        - name: trace_id
          matcherRegex: "trace_id\":\"(\\w+)\""
          url: "$${__value.raw}"
          datasourceUid: tempo
  - name: Tempo
    type: tempo
    access: proxy
    url: http://tempo:3200
    uid: tempo
  - name: Prometheus
    type: prometheus
    access: proxy
    url: http://prometheus:9090
```

`docker/observability/provisioning/dashboards/provider.yaml`：

```yaml
apiVersion: 1
providers:
  - name: openbot
    folder: OpenBot
    type: file
    options:
      path: /var/lib/grafana/dashboards
```

`docker/observability/provisioning/dashboards/openbot-starter.json`：一张 dashboard（uid `openbot-starter`），三面板：① Loki 日志量按 service（`sum by (service) (rate({job=~".+"}[$__rate_interval]))`，timeseries）；② error 级日志表（`{level="error"}` 或 `{service=~".+"} |= "error"`，logs 面板）；③ 最近 traces 列表（Tempo 查询类型）。JSON 结构按 Grafana 11 schema 导出格式手写最小化版本。

- [ ] **Step 2: compose 追加服务**（docker-compose.yml 末尾、networks/volumes 定义之前；每个服务 `profiles: ["observability"]`；镜像建议 `grafana/loki:3.5.0`、`grafana/tempo:2.7.0`、`prom/prometheus:v3.4.1`、`grafana/grafana:11.6.0`、`grafana/alloy:1.10.0`——以安装时能拉到的版本为准并记录）：loki（3102:3100，卷 loki-data:/loki，挂 loki-config.yaml:ro，command `-config.file=/etc/loki/config.yaml`）、tempo（3200:3200 + 4318:4318 + 4317:4317，卷 tempo-data:/tempo，挂 tempo-config.yaml:ro）、prometheus（9090:9090，卷 prometheus-data:/prometheus，挂 prometheus.yml:ro）、alloy（挂 /var/run/docker.sock:ro + `..` 的 `.logs` 目录 `/hostlogs`（相对仓库根：`../../.logs:/hostlogs` 视 compose 文件位置写对相对路径——compose 文件在仓库根，即 `./.logs:/hostlogs`）+ alloy-config.alloy:ro，command `run /etc/alloy/config.alloy`，`user: root` 或组对齐 docker.sock）、grafana（3003:3000，卷 grafana-data:/var/lib/grafana + provisioning 两个目录 :ro）。healthcheck 各配（loki `wget -qO- http://localhost:3100/ready`、tempo `wget -qO- http://localhost:3200/status`、prometheus `wget -qO- http://localhost:9090/-/healthy`、grafana `wget -qO- http://localhost:3000/api/health`；镜像无 wget 的用 curl 或去掉）。named volumes 追加：loki-data、tempo-data、prometheus-data、grafana-data。服务不设互相 depends_on（Alloy 对 Loki 用 write 重试即可；Grafana provisioning 对数据源无启动顺序依赖）。

- [ ] **Step 3: 语法与起栈验证**

```bash
docker compose config --profiles   # 列出 profiles 应含 observability
docker compose --profile observability up -d loki tempo prometheus grafana alloy
sleep 20
curl -s http://127.0.0.1:3102/ready | grep -i ready
curl -s http://127.0.0.1:3200/status | head -c 200
curl -s http://127.0.0.1:9090/-/healthy
curl -s http://127.0.0.1:3003/api/health
# 日志链路验证：随便起过的容器日志应已进 Loki
curl -s "http://127.0.0.1:3102/loki/api/v1/query_range" --data-urlencode 'query={source="docker"}' --data-urlencode "start=$(date -v-10M +%s)000000000" --data-urlencode "end=$(date +%s)000000000" | head -c 500
```

若 `docker compose config` 报错（脏 compose 与新段冲突），修到语法通过为止；`.logs` 目录不存在时先 `mkdir -p .logs`（alloy 起不来最常见原因）。

- [ ] **Step 4: .env.example 增补**（OTEL 区附近）：观测栈端口清单注释块 + `# OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318`（注释掉的样例，注明"起 observability 栈后取消注释并重启 server"）。若 .env.example 并行脏 → 选择性暂存并自证（`git show HEAD -- .env.example` 只含本任务行）。

- [ ] **Step 5: Commit**

```bash
git add docker/observability docker-compose.yml .env.example
git commit -m "feat(observability): LGTM+Alloy stack as the observability compose profile"
```

（compose/.env.example 若用了选择性暂存，提交后 `git show HEAD -- <file>` 自证纯净并写入报告。）

---

### Task 2: Tempo 视觉验证（补 P2 验收）+ traces 入栈验证

**Files:**
- Modify: `docs/observability.md`（Tempo 段从待办转正文：查询方式、P2 验收补记）

**Interfaces:**
- Consumes: Task 1 的 4318；P2 的 `initProcessTracing`（server 已接，`OPENBOT_TRACES`/endpoint 未配时无导出）。
- Produces: 一条可复现的验证记录（写入报告与 docs），trace 在 Tempo API 可查。

- [ ] **Step 1: 起 server 发 trace**

```bash
# 在根 .env 追加（不动 .env.example）：OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
grep -q OTEL_EXPORTER_OTLP_ENDPOINT .env || echo 'OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318' >> .env
# 若 server 已在跑（3001），重启它使 env 生效——用 start.sh 的既有重启守卫或 kill 后重跑脚本
bash scripts/start.sh   # 幂等，已在跑则跳过
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3001/api/capabilities
```

- [ ] **Step 2: Tempo 查询验证**

```bash
sleep 5   # BatchSpanProcessor 周期导出
curl -s "http://127.0.0.1:3200/api/search" --data-urlencode "serviceName=server" | head -c 800
# 期望：返回含 trace 的 JSON（spans 计录 POST/GET 请求）；取一个 traceID 再查：
curl -s "http://127.0.0.1:3200/api/traces/<traceID>" | head -c 300
```

期望：serviceName=server 有结果；单 trace 可取回。把两次响应摘要写入报告。**浏览器视觉验证（Grafana 3003 → Tempo 数据源 → trace 瀑布图）留给用户手动确认，报告给出确切的点击路径。**

- [ ] **Step 3: docs/observability.md 更新**（Tracing 节加"本地 Tempo"小节：endpoint、查询命令、Grafana 路径；"Later phases" 移除 Tempo 项）→ **Step 4: Commit**

```bash
git add docs/observability.md
git commit -m "docs(observability): local tempo verification path for traces"
```

---

### Task 3: GlitchTip + 崩溃链路协议验证

**Files:**
- Modify: `docker-compose.yml`（glitchtip + glitchtip-postgres，profile observability）
- Create: `docker/observability/glitchtip-init-db.sql`
- Modify: `docs/observability.md`（GlitchTip 小节：初始化步骤、DSN 配置、测试事件命令）

**Interfaces:**
- Produces: GlitchTip `127.0.0.1:8001`；DSN 形如 `http://<key>@127.0.0.1:8001/<project>`（HTTP 本地栈）。

- [ ] **Step 1: compose 服务**（镜像 `glitchtip/glitchtip:v5.0`（或可拉取的最新 tag，记录）；依赖独立 postgres `glitchtip-postgres`（镜像 postgres:17-alpine、named volume glitchtip-db、挂 `docker/observability/glitchtip-init-db.sql:ro` 建库 glitchtip）+ `glitchtip-redis`（redis:7-alpine，celery 队列用——GlitchTip v4+ 起简化部署仍建议带 redis；若验证单进程模式可行则去掉并在报告记录）。glitchtip 服务 env：`DATABASE_URL=postgres://glitchtip:glitchtip@glitchtip-postgres:5432/glitchtip`、`REDIS_URL=redis://glitchtip-redis:6379/0`、`SECRET_KEY=${GLITCHTIP_SECRET_KEY:?set in .env}`、`GLITCHTIP_DOMAIN=http://127.0.0.1:8001`。healthcheck：curl 8001 的 health 端点（`/health` 或 `/`，以镜像实际为准）。depends_on：glitchtip-postgres healthy + glitchtip-redis started。）

- [ ] **Step 2: 初始化与 DSN 获取**（GlitchTip 首启需建管理员与项目；用环境变量免交互：`GLITCHTIP_INITIAL_ADMIN_EMAIL/PASSWORD`（若镜像不支持则文档化手动步骤：浏览器开 8001 → 注册 → 建组织 openbot → 建项目 → Copy DSN；报告如实记录实际支持程度）。DSN 写入根 `.env`（`SENTRY_DSN_WEB=...` 等三个样例加 .env.example 注释态）。）

- [ ] **Step 3: 协议测试事件**

```bash
DSN="http://<key>@127.0.0.1:8001/<project>"
# 解析 DSN → envelope 端点
curl -s -X POST "${DSN%/*}/api/${DSN##*/}/envelope/" \
  -H "Content-Type: application/x-sentry-envelope" -H "X-Sentry-Auth: Sentry sentry_version=7, sentry_key=${DSN#http://}, sentry_client=openbot-test/1.0" \
  --data-binary $'{"event_id":"'"$(python3 -c 'import uuid;print(uuid.uuid4())')"'","sent_at":"2026-10-10T00:00:00Z"}\n{"type":"event"}\n{"level":"error","platform":"other","logger":"smoke","message":"openbot P3 envelope smoke test"}'
# 验证：curl GlitchTip API（需登录 token）或浏览器确认事件入库；报告记录事件指纹
```

（若 sentry_key 解析写法在实际 DSN 上不顺手，报告里给出可直接复制的修正版命令。）

- [ ] **Step 4: docs 更新 + Commit**

```bash
git add docker-compose.yml docker/observability/glitchtip-init-db.sql docs/observability.md .env.example
git commit -m "feat(observability): glitchtip for crash reporting in the observability profile"
```

---

### Task 4: 起栈一键化与文档收尾

**Files:**
- Modify: `docs/observability.md`（"本地观测栈"节：一条起栈命令、URL 表、停栈命令、数据留存说明、崩溃测试事件命令）
- Modify: `scripts/start.sh`？**否**——start.sh 管业务栈；观测栈独立用 compose profile，文档写命令即可（YAGNI）。
- Modify: `.env.example`（若 Task 1/3 有遗漏的样例合并进来）

**Interfaces:**
- Consumes: Task 1–3 全部产物。
- Produces: 用户视角的完整使用说明。

- [ ] **Step 1: 文档**（内容要点：`docker compose --profile observability up -d`；URL 表 Grafana 3003 / Loki 3102 / Tempo 3200 / Prometheus 9090 / GlitchTip 8001；`.logs` tail 与 docker 双路的说明； traces 打开方式；GlitchTip 初始化与 DSN 配置；`docker compose --profile observability down`（加不加 `-v` 的取舍说明——down 默认留数据，-v 清库）；留存 7 天。）
- [ ] **Step 2: 全链门禁**（`docker compose config`；`curl` 四健康端点；`bun test server/tests/trace.test.ts server/tests/trace-middleware.test.ts server/tests/trace-outbound.test.ts` 不回归；`cd runtime-go && go build ./...`）
- [ ] **Step 3: Commit**

```bash
git add docs/observability.md .env.example
git commit -m "docs(observability): observability profile usage guide"
```

---

## 验收对照（spec §6-P3）

| 验收项 | 落点 |
|---|---|
| `--profile observability up` 后数秒内日志出现在 Loki | Task 1 Step 3（curl query_range 断言） |
| Grafana 从日志跳转 Tempo | Task 1 datasources derivedFields（trace_id 链接）+ Task 2 视觉路径说明 |
| 三端测试崩溃事件出现在 GlitchTip 带版本号 | Task 3 Step 3（协议级 envelope 验证；三端真 SDK 接入在 P5，spec §5-P5） |
| P2 遗留：trace 在 Tempo 呈现 | Task 2 Step 2（API 检索 + 视觉路径） |

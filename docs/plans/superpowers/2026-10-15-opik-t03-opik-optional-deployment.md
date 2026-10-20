# Opik T03 Opik 可选部署与版本锁定清单 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让平台运维能用一条命令启动一个真实自托管 Opik 实例，并且服务与 SDK 版本被锁定为**实际验证过**的具体值；集成关闭时仓库现有行为零变化。

**Architecture:** 沿用仓库既有的可选栈约定：独立文件放 `docker/compose/`，用 `docker compose --project-directory . -f docker/compose/<stack>.yml up -d` 从仓库根启动，`name: openbot`，端口一律 loopback（`127.0.0.1:${VAR:-default}:internal` + `[::1]:…`），带 healthcheck，文件头注释写清运行命令与文档指针（见 `docker/compose/observability.yml`、`docker/compose/services.yml`）。compose 内容以上游 `deployment/docker-compose/docker-compose.yaml` 在**固定 tag** 下的实际内容为蓝本裁剪，而不是手写猜测。

**Tech Stack:** Docker Compose、Bun（`bun:test` 做静态约束校验）、上游 Opik `2.2.x`（ghcr.io/comet-ml/opik/*）。

**Spec:** `docs/specs/2026-10-14-opik-integration-design.md`（Implementation Decision 17「Deployment and verification」）；Ticket：https://github.com/1123786563/OpenBot/issues/9 ；父 Spec：https://github.com/1123786563/OpenBot/issues/4 的 A1。

## Global Constraints

- 覆盖父 Spec 验收：**A1**（关闭时现有执行与 tracing 仍成立；启用时真实实例能收到有效安全记录——本 Ticket 只交付“能启动真实实例且版本锁定”，实际收发验证在 #10 / T04）。
- 只允许改：`docker/compose/opik.yml`、`docker/opik/versions.json`、`reference/opik.md`、`.env.example`、`docker-compose.yml`（仅头部注释一行）、`server/tests/opik-deployment.test.ts`。**共 6 个文件**（manifest 原记 4 个，多出的 2 个是发现的可发现性注释与静态约束测试，已按 O1 记录）。
- **禁止任何浮动 tag**。上游 compose 的默认值是 `${OPIK_VERSION:-latest}`、`clickhouse-init: alpine:latest`、`jaegertracing/all-in-one:latest`，全部必须显式钉死；`versions.json` 里出现 `latest` 即视为未完成。
- **端口冲突必须解决**：上游 `otel-collector` 发布 `4317/4318`，而本仓库既有可观测栈已经占用它们——`docker/compose/observability.yml` 里 Tempo 发布 `127.0.0.1:${TEMPO_OTLP_HTTP_PORT:-4318}:4318` 与 `${TEMPO_OTLP_GRPC_PORT:-4317}:4317`。因此 Opik 侧的 OTLP 宿主端口必须重映射到不冲突的默认值（本计划用 `5418`/`5417`），且仍然只绑 loopback。
- 所有发布端口只绑 `127.0.0.1` 与 `[::1]`，不得出现 `0.0.0.0` 或裸 `HOST:CONTAINER`。
- 不启用不需要的上游服务：`jaeger`（本仓库已有 Tempo/Grafana）、`demo-data-generator`（会写入示例数据，污染真实验收）、`guardrails-backend*`（本 Ticket 不涉及）。用 compose profile 或直接不纳入。
- 集成默认关闭：`.env.example` 中所有 Opik 变量都以 `#` 注释给出，缺省即不启用。
- 凭据不得写入 compose 或 docs；用 `${VAR:?}`/`${VAR:-}` 引用仓库根 `.env`。
- 本 Ticket **不做** 上游 API 契约验证（#10 / T04）、**不做** 采集入口认证与控制台保护（#38 / T32）。

## File Structure

| 文件 | 责任 |
| --- | --- |
| `docker/compose/opik.yml` | 可选栈：裁剪后的上游服务集，版本钉死，端口 loopback 且避开 4317/4318 |
| `docker/opik/versions.json` | 唯一版本事实源：每个镜像的 tag 与 digest、Opik SDK 精确版本、对应上游 commit、验证时间 |
| `reference/opik.md` | 启动/停止/健康检查/故障排查/保留策略指针；不给凭据 |
| `.env.example` | 注释形态的 Opik 变量（端口、版本、开关、API 地址） |
| `docker-compose.yml` | 头部注释追加一行，把 `opik.yml` 列入可选栈 |
| `server/tests/opik-deployment.test.ts` | 静态约束测试：无浮动 tag、无非 loopback 端口、无 4317/4318 冲突、versions.json 与 compose 一致 |

---

### Task 1: 版本事实源 `docker/opik/versions.json`

**Files:**
- Create: `docker/opik/versions.json`
- Test: `server/tests/opik-deployment.test.ts`

**Interfaces:**
- Consumes: 无。
- Produces:
  - `versions.json` 结构（下游 #10 / T04 的 `VerifiedOpikContract` manifest 会引用它）：
    ```
    { "opik": { "version", "upstreamCommit", "verifiedAt", "images": { <name>: { "tag", "digest" } } },
      "sdk": { "typescript": <精确版本>, "python": <精确版本或 null> },
      "compatibility": { "verifiedBy": <"#10" 直到 T04 完成前为 "unverified">, "status": "unverified" | "verified" } }
    ```
  - `compatibility.status` 初始必须是 `"unverified"`——**不得**在 T04 跑通前写成 `verified`。

- [ ] **Step 1: 取上游固定 tag 的真实镜像清单**

Run（确定候选版本与其 compose 内容；不要在计划里假定版本）:
```bash
gh api repos/comet-ml/opik/releases/latest --jq '.tag_name'
gh api repos/comet-ml/opik/contents/deployment/docker-compose/docker-compose.yaml?ref=<tag> --jq '.content' | base64 -d > /tmp/opik-compose.yaml
grep -nE "image:" /tmp/opik-compose.yaml
gh api repos/comet-ml/opik/commits/<tag> --jq '.sha'
```
Expected: 得到形如 `2.2.100` 的 tag、上游 commit sha，以及各服务的实际镜像与 tag（本仓库探明时的实况：`mysql:8.4.2`、`redis:7.2.4-alpine3.19`、`clickhouse/clickhouse-server:26.3.16.16-alpine`、`zookeeper:3.9.4`、`docker.io/cloudpirates/image-minio:RELEASE.2025-10-15T17-29-55Z-hardened`、`otel/opentelemetry-collector-contrib:0.139.0`，Opik 自身四个镜像用 `${OPIK_VERSION:-latest}`）。

- [ ] **Step 2: 拉取并记录 digest（digest 才是不可漂移的锁定值）**

Run:
```bash
V=<tag>
for i in opik-backend opik-frontend opik-python-backend; do
  docker pull -q ghcr.io/comet-ml/opik/$i:$V
  echo "$i $(docker image inspect ghcr.io/comet-ml/opik/$i:$V --format '{{index .RepoDigests 0}}')"
done
for i in mysql:8.4.2 redis:7.2.4-alpine3.19 clickhouse/clickhouse-server:26.3.16.16-alpine zookeeper:3.9.4 otel/opentelemetry-collector-contrib:0.139.0; do
  docker pull -q "$i" >/dev/null; echo "$i $(docker image inspect "$i" --format '{{index .RepoDigests 0}}')"
done
```
Expected: 每个镜像一行 `name ...@sha256:<64 hex>`

- [ ] **Step 3: 写失败测试**

创建 `server/tests/opik-deployment.test.ts`：

```ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import versions from "../../docker/opik/versions.json";

const repoRoot = join(import.meta.dir, "..", "..");
const compose = readFileSync(join(repoRoot, "docker/compose/opik.yml"), "utf8");

const FLOATING = ["latest", "stable", "edge", "main", "master", "dev"];

describe("docker/opik/versions.json", () => {
  test("no image is pinned to a floating tag", () => {
    for (const [name, image] of Object.entries(versions.opik.images)) {
      for (const floating of FLOATING) {
        expect(image.tag.toLowerCase(), `${name} tag`).not.toBe(floating);
        expect(image.tag.toLowerCase(), `${name} tag contains`).not.toContain(`:${floating}`);
      }
      expect(image.digest, `${name} digest`).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
  });

  test("the Opik version and upstream commit are exact, not a range", () => {
    expect(versions.opik.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(versions.opik.upstreamCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(versions.opik.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("the SDK version is exact", () => {
    expect(versions.sdk.typescript).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("compatibility stays unverified until ticket #10 proves it", () => {
    // Flipping this to "verified" is T04's job, with real ingest/query/delete evidence.
    expect(versions.compatibility.status).toBe("unverified");
    expect(versions.compatibility.verifiedBy).toBe("#10");
  });
});
```

- [ ] **Step 4: 运行测试确认失败**

Run: `bun test server/tests/opik-deployment.test.ts`
Expected: FAIL — 找不到 `docker/opik/versions.json` 或 `docker/compose/opik.yml`

- [ ] **Step 5: 写 `docker/opik/versions.json`（用 Step 1/2 的真实值替换尖括号）**

```json
{
  "opik": {
    "version": "<tag, e.g. 2.2.100>",
    "upstreamCommit": "<40-hex sha of that tag>",
    "verifiedAt": "<ISO8601 of the pull, e.g. 2026-10-15T02:00:00Z>",
    "images": {
      "backend": {
        "repository": "ghcr.io/comet-ml/opik/opik-backend",
        "tag": "<tag>",
        "digest": "sha256:<64 hex>"
      },
      "frontend": {
        "repository": "ghcr.io/comet-ml/opik/opik-frontend",
        "tag": "<tag>",
        "digest": "sha256:<64 hex>"
      },
      "python-backend": {
        "repository": "ghcr.io/comet-ml/opik/opik-python-backend",
        "tag": "<tag>",
        "digest": "sha256:<64 hex>"
      },
      "mysql": { "repository": "mysql", "tag": "8.4.2", "digest": "sha256:<64 hex>" },
      "redis": { "repository": "redis", "tag": "7.2.4-alpine3.19", "digest": "sha256:<64 hex>" },
      "clickhouse": {
        "repository": "clickhouse/clickhouse-server",
        "tag": "26.3.16.16-alpine",
        "digest": "sha256:<64 hex>"
      },
      "zookeeper": { "repository": "zookeeper", "tag": "3.9.4", "digest": "sha256:<64 hex>" },
      "minio": {
        "repository": "docker.io/cloudpirates/image-minio",
        "tag": "RELEASE.2025-10-15T17-29-55Z-hardened",
        "digest": "sha256:<64 hex>"
      },
      "otel-collector": {
        "repository": "otel/opentelemetry-collector-contrib",
        "tag": "0.139.0",
        "digest": "sha256:<64 hex>"
      }
    }
  },
  "sdk": {
    "typescript": "<exact opik-sdk typescript version, no ^ or ~>",
    "python": null
  },
  "compatibility": {
    "status": "unverified",
    "verifiedBy": "#10",
    "note": "T03 pins and deploys. T04 (#10) proves ingest, query, evaluation, id mapping and deletion against a real instance and is the only ticket allowed to flip status to verified."
  }
}
```

> `sdk.typescript` 取实际要装的精确版本（`bun pm ls | grep opik` 或 npm registry 的具体版本号），**不要**写 `^x.y.z`。若本 Ticket 尚未安装 SDK，写 `#10` 将要安装的版本并在 note 里说明；不得留空字符串。

- [ ] **Step 6: 提交**

```bash
git add docker/opik/versions.json server/tests/opik-deployment.test.ts
git commit -m "feat(opik): pin the self-hosted Opik image and SDK versions as the single source of truth"
```

---

### Task 2: 可选栈 `docker/compose/opik.yml`

**Files:**
- Create: `docker/compose/opik.yml`
- Create: `docker/opik/otel-collector-config.yaml`（仅当需要覆盖上游 collector 配置以改端口时；否则不改端口而只在 compose 里重映射宿主端口）
- Test: `server/tests/opik-deployment.test.ts`（追加）

**Interfaces:**
- Consumes: `docker/opik/versions.json` 的 tag（compose 用 `${OPIK_VERSION}` 传入，`.env` 提供，默认值必须与 versions.json 一致而不是 `latest`）。
- Produces:
  - 启动命令：`docker compose --project-directory . -f docker/compose/opik.yml up -d`
  - 宿主端口约定：前端 `${OPIK_PORT:-5174}`、OTLP HTTP `${OPIK_OTLP_HTTP_PORT:-5418}`、OTLP gRPC `${OPIK_OTLP_GRPC_PORT:-5417}`、后端 API 不对外发布（只经前端 nginx 反代，`OPIK_REVERSE_PROXY_URL` 指向 `http://frontend:${NGINX_PORT:-5173}/api`）
  - 健康检查：前端 `wget -qO- http://localhost:5173/ || exit 1`，后端 `curl -f http://localhost:8080/health-check`

- [ ] **Step 1: 追加失败测试**

在 `server/tests/opik-deployment.test.ts` 末尾追加：

```ts
const PUBLISHED = /^\s*-\s*["']?([^\s"']+:\d+:\d+|\d+:\d+)/gm;

function publishedPorts(text: string): string[] {
  return [...text.matchAll(PUBLISHED)].map((m) => m[1]);
}

describe("docker/compose/opik.yml", () => {
  test("every published port is loopback-only", () => {
    for (const mapping of publishedPorts(compose)) {
      const host = mapping.split(":")[0];
      expect(["127.0.0.1", "[::1]"], `${mapping} must bind loopback`).toContain(host);
    }
  });

  test("no floating image tag anywhere in the stack", () => {
    for (const line of compose.split("\n")) {
      const image = /^\s*image:\s*(\S+)/.exec(line)?.[1];
      if (!image) continue;
      for (const floating of FLOATING) {
        expect(image, `${image} must not float`).not.toMatch(new RegExp(`:${floating}\\s*$`));
      }
      expect(image, `${image} must not default to latest`).not.toContain(":-latest}");
    }
  });

  test("the OTLP host ports do not collide with the existing Tempo stack", () => {
    // docker/compose/observability.yml already publishes 4318/4317 on loopback for Tempo.
    const hosts = publishedPorts(compose).map((m) => m.split(":")[1]);
    for (const taken of ["4317", "4318", "3200", "3102", "3003"]) {
      expect(hosts, `host port ${taken} belongs to the LGTM stack`).not.toContain(taken);
    }
  });

  test("the demo data generator and jaeger are not part of the stack", () => {
    expect(compose).not.toMatch(/^\s{2}demo-data-generator:/m);
    expect(compose).not.toMatch(/^\s{2}jaeger:/m);
  });

  test("the compose file names the openbot project like every other optional stack", () => {
    expect(compose).toMatch(/^name:\s*openbot$/m);
  });

  test("the default OPIK_VERSION matches the pinned versions.json", () => {
    const fallback = /\$\{OPIK_VERSION:-([^}]+)\}/.exec(compose)?.[1];
    expect(fallback, "compose must not default to a floating tag").toBeDefined();
    expect(fallback).toBe(versions.opik.version);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test server/tests/opik-deployment.test.ts`
Expected: FAIL — 新 describe 块读取不到 compose 内容或断言失败

- [ ] **Step 3: 写 `docker/compose/opik.yml`**

以上游 `deployment/docker-compose/docker-compose.yaml` 在固定 tag 的内容为蓝本裁剪。头部注释与 loopback 约定照抄 `docker/compose/observability.yml` 的写法：

```yaml
# Opik: self-hosted AI observability and evaluation, optional. Start the main stack first —
# OpenBot reaches it over loopback and the integration stays off until OPIK_* is configured,
# so a missing Opik never changes Agent execution. reference/opik.md is the guide; the pinned
# image tags and digests live in docker/opik/versions.json and must not float.
#
# OTLP host ports are 5418/5417, NOT the upstream 4318/4317: the LGTM stack in
# docker/compose/observability.yml already publishes those on loopback for Tempo, and two
# stacks claiming one port fails in a way that looks like an Opik bug.
#
# Run from the repository root — --project-directory . is what makes the root .env and the
# ./docker/opik paths resolve:
#   docker compose --project-directory . -f docker/compose/opik.yml up -d
name: openbot

x-opik-version: &opik-version "${OPIK_VERSION:-<tag from versions.json>}"

services:
  mysql:
    image: mysql:8.4.2
    restart: unless-stopped
    environment:
      MYSQL_DATABASE: opik
      MYSQL_USER: opik
      MYSQL_PASSWORD: ${OPIK_MYSQL_PASSWORD:?set OPIK_MYSQL_PASSWORD in the root .env}
      MYSQL_ROOT_PASSWORD: ${OPIK_MYSQL_ROOT_PASSWORD:?set OPIK_MYSQL_ROOT_PASSWORD in the root .env}
    volumes:
      - opik-mysql-data:/var/lib/mysql
    healthcheck:
      test: ["CMD", "mysqladmin", "ping", "-h", "127.0.0.1"]
      interval: 10s
      timeout: 5s
      retries: 12
      start_period: 30s

  redis:
    image: redis:7.2.4-alpine3.19
    restart: unless-stopped
    volumes:
      - opik-redis-data:/data

  zookeeper:
    image: zookeeper:3.9.4
    restart: unless-stopped
    volumes:
      - opik-zookeeper-data:/data
      - opik-zookeeper-logs:/datalog

  clickhouse:
    image: clickhouse/clickhouse-server:26.3.16.16-alpine
    restart: unless-stopped
    depends_on:
      zookeeper: { condition: service_started }
      mysql: { condition: service_healthy }
    volumes:
      - opik-clickhouse-data:/var/lib/clickhouse
      - ./docker/opik/clickhouse-config:/etc/clickhouse-server/config.d:ro
    environment:
      CLICKHOUSE_DB: opik
      CLICKHOUSE_USER: opik
      CLICKHOUSE_PASSWORD: ${OPIK_CLICKHOUSE_PASSWORD:?set OPIK_CLICKHOUSE_PASSWORD in the root .env}

  minio:
    image: docker.io/cloudpirates/image-minio:RELEASE.2025-10-15T17-29-55Z-hardened
    restart: unless-stopped
    volumes:
      - opik-minio-data:/data

  backend:
    image: ghcr.io/comet-ml/opik/opik-backend@sha256:<digest from versions.json>
    restart: unless-stopped
    depends_on:
      mysql: { condition: service_healthy }
      clickhouse: { condition: service_started }
      redis: { condition: service_started }
      minio: { condition: service_started }
    environment:
      OPIK_VERSION: *opik-version
    expose:
      - "8080"
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8080/health-check"]
      interval: 15s
      timeout: 5s
      retries: 12
      start_period: 60s

  python-backend:
    image: ghcr.io/comet-ml/opik/opik-python-backend@sha256:<digest from versions.json>
    restart: unless-stopped
    environment:
      OPIK_VERSION: *opik-version
      PYTHON_CODE_EXECUTOR_IMAGE_TAG: *opik-version
      OPIK_REVERSE_PROXY_URL: "http://frontend:${NGINX_PORT:-5173}/api"

  frontend:
    image: ghcr.io/comet-ml/opik/opik-frontend@sha256:<digest from versions.json>
    restart: unless-stopped
    depends_on:
      backend: { condition: service_healthy }
    ports:
      # Loopback, like every other port in these files. 5174, not the upstream 5173 default:
      # keep it off the vite dev port so both can run at once.
      - "127.0.0.1:${OPIK_PORT:-5174}:${NGINX_PORT:-5173}"
      - "[::1]:${OPIK_PORT:-5174}:${NGINX_PORT:-5173}"
    environment:
      OPIK_VERSION: *opik-version
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- http://localhost:${NGINX_PORT:-5173}/ || exit 1"]
      interval: 15s
      timeout: 5s
      retries: 12
      start_period: 30s

  otel-collector:
    image: otel/opentelemetry-collector-contrib:0.139.0
    restart: unless-stopped
    command: ["--config=/etc/otelcol-contrib/config.yaml"]
    volumes:
      - ./docker/opik/otel-collector-config.yaml:/etc/otelcol-contrib/config.yaml:ro
    ports:
      # 5418/5417 on the host, 4318/4317 inside: Tempo already owns the host pair.
      - "127.0.0.1:${OPIK_OTLP_HTTP_PORT:-5418}:4318"
      - "[::1]:${OPIK_OTLP_HTTP_PORT:-5418}:4318"
      - "127.0.0.1:${OPIK_OTLP_GRPC_PORT:-5417}:4317"
      - "[::1]:${OPIK_OTLP_GRPC_PORT:-5417}:4317"

volumes:
  opik-mysql-data:
  opik-redis-data:
  opik-zookeeper-data:
  opik-zookeeper-logs:
  opik-clickhouse-data:
  opik-minio-data:
```

> 逐服务对照上游裁剪后的实际内容（`environment`、`depends_on`、`volumes`、健康检查）必须以上游固定 tag 的 `docker-compose.yaml` 为准；上面给的是结构与端口/版本纪律。若上游某服务需要额外环境变量才能启动，照抄上游值并把任何 secret 改成 `${VAR:?...}` 引用。**不要**保留 `demo-data-generator`（写示例数据会污染 #43 的真实验收）与 `jaeger`（本仓库已有 Tempo）。

- [ ] **Step 4: 校验 compose 语法**

Run: `docker compose --project-directory . -f docker/compose/opik.yml config --quiet`
Expected: 退出码 0（需要 `.env` 里存在三个 `:?` 必填密码，否则 compose 会明确报缺变量——这正是期望行为）

- [ ] **Step 5: 运行测试确认通过**

Run: `bun test server/tests/opik-deployment.test.ts`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add docker/compose/opik.yml docker/opik/ server/tests/opik-deployment.test.ts
git commit -m "feat(opik): optional self-hosted stack with pinned digests and loopback-only ports"
```

---

### Task 3: 配置样例、文档与可发现性

**Files:**
- Modify: `.env.example`
- Create: `reference/opik.md`
- Modify: `docker-compose.yml`（仅头部注释）
- Test: `server/tests/opik-deployment.test.ts`（追加）

**Interfaces:**
- Consumes: Task 1/2 的端口与版本约定。
- Produces: 环境变量名（下游 #15 / T09 的 `config.ts` 会消费这些名字，必须逐字一致）：
  `OPIK_ENABLED`、`OPIK_BASE_URL`、`OPIK_API_KEY`、`OPIK_WORKSPACE_NAME`、`OPIK_PORT`、`OPIK_OTLP_HTTP_PORT`、`OPIK_OTLP_GRPC_PORT`、`OPIK_MYSQL_PASSWORD`、`OPIK_MYSQL_ROOT_PASSWORD`、`OPIK_CLICKHOUSE_PASSWORD`、`OPIK_MINIO_*`（按上游实际需要的补齐）

- [ ] **Step 1: 追加失败测试**

在 `server/tests/opik-deployment.test.ts` 末尾追加：

```ts
import { readFileSync as read } from "node:fs";

const envExample = read(join(repoRoot, ".env.example"), "utf8");
const opikDocs = read(join(repoRoot, "reference/opik.md"), "utf8");
const rootCompose = read(join(repoRoot, "docker-compose.yml"), "utf8");

/** The exact variable names T09 (#15) will read from config.ts. */
const CONTRACT_VARS = [
  "OPIK_ENABLED",
  "OPIK_BASE_URL",
  "OPIK_API_KEY",
  "OPIK_WORKSPACE_NAME",
  "OPIK_PORT",
  "OPIK_OTLP_HTTP_PORT",
  "OPIK_OTLP_GRPC_PORT",
];

describe("configuration surface", () => {
  test("every contract variable is documented in .env.example", () => {
    for (const name of CONTRACT_VARS) {
      expect(envExample, `${name} must appear in .env.example`).toContain(name);
    }
  });

  test("the integration is off by default: every OPIK_ line in .env.example is commented out", () => {
    const lines = envExample.split("\n").filter((l) => /^\s*[^#\s].*OPIK_/.test(l));
    expect(lines, `uncommented OPIK_ defaults: ${lines.join(", ")}`).toEqual([]);
  });

  test("no secret value is written into .env.example or the docs", () => {
    for (const text of [envExample, opikDocs, compose]) {
      expect(text).not.toMatch(/OPIK_API_KEY\s*=\s*["']?[A-Za-z0-9]{16,}/);
      expect(text).not.toMatch(/OPIK_(MYSQL|CLICKHOUSE)_\w*PASSWORD\s*=\s*["']?[^\s"'$]{6,}/);
    }
  });

  test("reference/opik.md gives the run command, the health check and the port rationale", () => {
    expect(opikDocs).toContain("docker compose --project-directory . -f docker/compose/opik.yml up -d");
    expect(opikDocs).toContain("health-check");
    expect(opikDocs).toContain("4318");
    expect(opikDocs).toContain("5418");
    expect(opikDocs).toContain("versions.json");
  });

  test("the optional stack is listed where the other optional stacks are listed", () => {
    expect(rootCompose).toContain("opik.yml");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test server/tests/opik-deployment.test.ts`
Expected: FAIL — `reference/opik.md` 不存在

- [ ] **Step 3: 在 `.env.example` 的可观测性段落之后追加**

在 `#TEMPO_OTLP_GRPC_PORT=4317`（≈813 行）之后插入：

```bash

# ---------------------------------------------------------------------------------------------
# Opik — self-hosted AI observability and evaluation. OPTIONAL and OFF by default.
#
# The stack lives in docker/compose/opik.yml and the pinned image tags and digests live in
# docker/opik/versions.json. Start it from the repository root:
#   docker compose --project-directory . -f docker/compose/opik.yml up -d
# Guide: reference/opik.md.
#
# OTLP is published on 5418/5417, not the upstream 4318/4317, because the LGTM stack in
# docker/compose/observability.yml already owns those on loopback for Tempo.
#
# Leaving OPIK_ENABLED unset or off must not change Agent execution or existing tracing.
# ---------------------------------------------------------------------------------------------
#OPIK_ENABLED=off
#OPIK_BASE_URL=http://127.0.0.1:5174/api
#OPIK_API_KEY=
#OPIK_WORKSPACE_NAME=default
#OPIK_PORT=5174
#OPIK_OTLP_HTTP_PORT=5418
#OPIK_OTLP_GRPC_PORT=5417
# The stack's own datastore passwords. Required by the compose file (`:?`), so set them in
# .env before `up`; never commit real values.
#OPIK_MYSQL_PASSWORD=change-me
#OPIK_MYSQL_ROOT_PASSWORD=change-me
#OPIK_CLICKHOUSE_PASSWORD=change-me
```

- [ ] **Step 4: 写 `reference/opik.md`**

必须包含以下小节（内容据实填写，不给凭据）：

```markdown
# Opik（可选自托管）

Opik 提供 AI 运行追踪与评测。它是**可选**的：不配置 `OPIK_*` 时 OpenBot 的 Agent 执行与既有
OpenTelemetry/Tempo/Grafana 追踪行为完全不变。

## 版本

版本事实源是 [`docker/opik/versions.json`](../../../docker/opik/versions.json)：每个镜像的 tag 与
digest、Opik SDK 精确版本、对应上游 commit 与验证时间。该文件里不允许出现 `latest` 或任何浮动
tag。`compatibility.status` 只有 #10（契约冒烟）拿到真实 ingest / query / evaluation / id 映射 /
删除证据后才能是 `verified`；在那之前它是 `unverified`，任何页面都不得声称已验证兼容。

上游：<https://github.com/comet-ml/opik>（本栈裁剪自 `deployment/docker-compose/docker-compose.yaml`）。

## 启动

​```bash
# 1. 在仓库根 .env 里设置三个 datastore 密码（compose 用 `:?` 强制要求）
#    OPIK_MYSQL_PASSWORD / OPIK_MYSQL_ROOT_PASSWORD / OPIK_CLICKHOUSE_PASSWORD
# 2. 从仓库根启动
docker compose --project-directory . -f docker/compose/opik.yml up -d
​```

`--project-directory .` 是必需的：它让根 `.env` 与 `./docker/opik/...` 路径按预期解析。

## 端口

| 用途 | 宿主端口 | 容器端口 | 变量 |
| --- | --- | --- | --- |
| 前端与 API 反代 | 5174 | 5173 | `OPIK_PORT` |
| OTLP HTTP | **5418** | 4318 | `OPIK_OTLP_HTTP_PORT` |
| OTLP gRPC | **5417** | 4317 | `OPIK_OTLP_GRPC_PORT` |

OTLP 宿主端口不是上游默认的 4318/4317：`docker/compose/observability.yml` 里的 Tempo 已经在
loopback 上占用了这两个端口。两个栈抢一个端口的表现很像 Opik 自身故障，所以在这里一次性避开。
后端 API（8080）不对外发布，只经前端 nginx 反代（`http://frontend:5173/api`）。所有发布端口只绑
`127.0.0.1` 与 `[::1]`。

## 健康检查

​```bash
docker compose --project-directory . -f docker/compose/opik.yml ps
curl -fsS http://127.0.0.1:5174/api/health-check     # 经前端反代
​```

后端容器自身的 healthcheck 是 `curl -f http://localhost:8080/health-check`。**HTTP 200 不等于集成
就绪**：就绪条件由 #15（配置与健康）统一判定，缺必需能力时即使健康也是未就绪。

## 停止与数据

​```bash
docker compose --project-directory . -f docker/compose/opik.yml down          # 保留数据卷
docker compose --project-directory . -f docker/compose/opik.yml down -v       # 删除数据卷
​```

保留期与真实删除的语义见 #41（T35）：隐藏一行不等于删除内容，删除必须在上游确证查不到之后才报完成。

## 未纳入的服务

上游 compose 里的 `demo-data-generator`（会写入示例数据，污染真实验收）与 `jaeger`（本仓库已有
Tempo/Grafana）不在本栈内；`guardrails-backend*` 也不在内。

## 控制面访问

Opik 控制台与私有 API 的保护属于 #38（T32）。在它完成之前，这个实例只应在 loopback 上运行，
不得暴露到网络，也不得被当作已受保护的控制面。
```

- [ ] **Step 5: 在 `docker-compose.yml` 头部注释追加一项**

把第 1–2 行的可选栈清单（`kb.yml, services.yml, …`）补上 `opik.yml`，并在合适位置加一行说明：

```yaml
# opik.yml — optional self-hosted AI observability and evaluation; see reference/opik.md. Its OTLP
# host ports are 5418/5417 because observability.yml already owns 4318/4317 for Tempo.
```

- [ ] **Step 6: 运行测试确认通过**

Run: `bun test server/tests/opik-deployment.test.ts`
Expected: PASS（全部 describe 块）

- [ ] **Step 7: 真实启动验证（不得跳过，也不得在缺环境时记为通过）**

Run:
```bash
docker compose --project-directory . -f docker/compose/opik.yml up -d
docker compose --project-directory . -f docker/compose/opik.yml ps
curl -fsS http://127.0.0.1:5174/api/health-check
docker compose --project-directory . -f docker/compose/opik.yml down
```
Expected: 所有服务 healthy；health-check 返回 200；`down` 干净退出。
若本机无 Docker 或拉取受限：把 `docker/opik/versions.json` 的 `compatibility.status` 保持 `"unverified"`，在 `docs/plans/evidence/2026-10-14-opik/t03/` 记录精确阻塞，**不得**声称验证通过。

- [ ] **Step 8: 提交**

```bash
git add .env.example reference/opik.md docker-compose.yml server/tests/opik-deployment.test.ts
git commit -m "docs(opik): optional stack guide, off-by-default config, and the 5418/5417 port rationale"
```

---

## Self-Review

**Spec coverage（Ticket #9 的 4 条验收标准）**
1. 「可选部署能启动真实自托管实例；未部署或未启用时现有 Agent 执行与 tracing 行为完全不变」→ Task 2 的 compose + Task 3 Step 7 的真实启动；off-by-default 由 “every OPIK_ line in .env.example is commented out” 测试锁定。
2. 「服务镜像与 SDK 版本锁定为实际验证过的具体值（tag/digest），不使用浮动标签」→ Task 1 的 versions.json + “no image is pinned to a floating tag” / “no floating image tag anywhere in the stack” / “default OPIK_VERSION matches versions.json” 三条测试。
3. 「运维文档给出启动、关闭、健康检查与故障排查步骤，且不泄露凭据」→ Task 3 Step 4 的 reference/opik.md + “no secret value is written” 测试。
4. 「相关配置进入环境变量样例，缺省时集成保持关闭」→ Task 3 Step 3 + “every contract variable is documented” 测试。

**Placeholder scan**：`versions.json` 与 compose 里的 `<tag>` / `<digest>` / `<64 hex>` 是**必须在执行时填入真实值的槽位**，每个都紧跟给出取得该值的确切命令（Task 1 Step 1/2），不是 TBD。docs 模板中的 `​```bash` 用了零宽字符转义，写入文件时必须还原为普通三反引号。

**Type consistency**：`versions.opik.images.<name>.{repository,tag,digest}` 与测试里的 `image.tag` / `image.digest` 一致；`compatibility.status` 的合法值只有 `"unverified" | "verified"`，测试断言初始为 `"unverified"`；`CONTRACT_VARS` 里的 7 个变量名与 `.env.example`、compose 的 `${VAR:-default}` 逐字一致，是 #15（T09）`config.ts` 将消费的确切名字。

**未覆盖但已显式移交**：真实 ingest/query/delete 契约 → #10（T04）；采集入口认证与控制台保护 → #38（T32）；就绪判定 → #15（T09）。

## Execution Handoff

Plan complete and saved to `docs/plans/superpowers/2026-10-15-opik-t03-opik-optional-deployment.md`. Two execution options:

1. **Subagent-Driven (recommended)** — 每个 Task 派发新的 subagent，Task 之间 review。
2. **Inline Execution** — 本会话内按 executing-plans 批量执行并设检查点。

完成后把提交哈希、`versions.json` 的实际 tag/digest 与启动验证输出填入 `docs/plans/tickets/opik-4/manifest.json` 的 `T03.handoff.checkpoint`，并在 GitHub #9 勾选验收标准。缺 Docker 环境时按 Task 3 Step 7 记录阻塞，不得记为通过。

# [hs-H1] 批次报告：#380、#398（Hindsight 域）

HEAD：3ca32d49（分支 1123786563/hs001）。改动均未提交（无提交授权）。
测试库：TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5560/hs001（容器 orca-all-hs001-pg，pgvector，保留）。

---

## #380 [Hindsight 03] 自托管 Hindsight 服务与隐私配置 —— SATISFIED（零改动）

等价实现已在 main：`2ce901b8 feat(hindsight): #380 自托管 Hindsight 服务、隐私配置与四态健康检查`（本 worktree HEAD 可达）。本票零产品/测试改动，全部 AC 以真实自托管实例实证。

### 演练环境（真实实例）

- 镜像：`ghcr.io/vectorize-io/hindsight:1.0.0`，本地 digest `sha256:a88678c038b0e4340822b02a5efc566c56d8176b5bffa731bc433fd37f978e4c`，与 deploy/hindsight/README.md《Verified image》记录一致。
- 环境：`deploy/hindsight/hindsight.env`（git-ignored，由 example 生成，网关指向本机 stand-in `http://host.docker.internal:9100/v1`，仅隔离验证用）；stand-in `node deploy/hindsight/test/gateway-standin.mjs --host 0.0.0.0 --port 9100 --allow-non-loopback --log /tmp/hs001-gateway-standin.log` 在跑。
- 本工作区容器到 huggingface.co 无网络（Errno 101），reranker 模型经 `/tmp/hs001-hf-override.yml` 注入 `HF_ENDPOINT=https://hf-mirror.com` 下载（仓库 compose 未动）。容器 `openbot-hindsight` 以默认 compose project 运行，health/live 200，保留不删。

### AC 逐条实证

- AC1（固定版本 + 不直接暴露）：
  - compose 钉 `ghcr.io/vectorize-io/hindsight:1.0.0`（非 latest），digest 复核一致（见上）。
  - `docker port openbot-hindsight` → 仅 `8888/tcp -> 127.0.0.1:8888`；控制面 9999 无发布条目（compose 无该 ports）。
  - 数据 API 强制鉴权：无 token `GET /v1/default/banks` → 401；带 token → 200。`/health`、`/version` 为免鉴权运维端点（返回状态/版本，无记忆内容），仅 loopback 可达，与归档证据（archive/plans/hindsight-personal-memory/reports/ticket-380.md）一致。
- AC2（网关 + 追踪关闭 + 保留期）：
  - 模型调用仅走已配置网关端点：stand-in 日志全程只有 `/v1/chat/completions`（gpt-4o-mini）请求，容器日志 `Verifying connection: openai/gpt-4o-mini` → `Connection verified`（经 stand-in）；reranker 为本地 in-process，无其他出口。
  - `hindsight.env.example` 声明 `HINDSIGHT_API_LLM_TRACE_ENABLED=false`、`HINDSIGHT_API_OPERATION_RETENTION_DAYS=1`、`HINDSIGHT_PRIVACY_BACKUP_RETENTION_DAYS=30`，OpenBot 侧镜像键由 config.ts 校验（`server/tests/hindsight-config.test.ts` 14/14 pass，原生层）。
  - 真实备份：`./backup.sh /tmp/hs001-backup-drill` → `backup written: hindsight-20261019T090421Z.sql.gz (retention 30d)`，exit 0，文件 0600，gzip 完整性检查通过。
- AC3（四态健康检查、不含记忆内容）：
  - `bun run deploy/hindsight/test/verify-health.ts <scenario>`（真实实例 + 真实 fetch）：
    - happy → `{"state":"service_up","version":"1.0.0"}` exit 0
    - bad-config → `{"state":"config_noncompliant","violations":["llm_trace_enabled"]}` exit 0
    - gateway-down（杀 stand-in）→ `{"state":"gateway_down","version":"1.0.0"}` exit 0
    - service-down（docker stop）→ `{"state":"service_down"}` exit 0
  - 单元/集成：`bunx e2e run --config e2e.unit.config.ts server/tests/hindsight-health.test.ts server/tests/hindsight-config.test.ts` → 29 pass（15+14）；状态对象仅 state/checkedAt/version/violations（测试断言无 token/网关密钥/记忆内容）。
  - （#398 修复后复跑 happy 仍 service_up，见下节回归。）

### 改动文件

无（仅 git-ignored hindsight.env、/tmp override 与日志、docker 卷 hindsight_hindsight-data、/tmp/hs001-backup-drill 备份产物）。

### 遗留

- /health、/version 免鉴权为 pinned 1.0.0 行为，loopback-only 下不构成暴露缺口；多租户隔离与召回为显式非目标（README《Explicit non-goals》）。
- 本工作区需 HF_ENDPOINT 镜像才能起 reranker——环境事实，非产品缺口。

---

## #398 [Hindsight 20] Wave 1 质量尾款 —— IMPLEMENTED（medium×4 就地修复，未提交）

核验：三个涉事文件自引入提交（2ce901b8 / a891698f）后无任何后续修复提交，medium×4 在 main/本工作区均未修。按批次分级（已验收 Wave 的遗留质量项，产品侧修复计 IMPLEMENTED；本批唯一一张产品侧 IMPLEMENTED，产品代码净增/改 ~14 行 ≤ 20，文件集清晰：backup.sh + sensitivity.ts + health.ts）。

### medium 逐项修复与实证

1. `deploy/hindsight/backup.sh:184`（现 ~192）flock 分支文案：拒绝消息不再断言持有者 "from the create-style lock path"（flock 运行取锁后会重写同一指纹，flock-vs-flock 争用会被误标 mixed styles）。新文案声明持有者可为任一锁风格。演练（macOS 无 flock(1)，用 PATH stub 走进 flock 分支 + 活进程指纹）：输出 `refusing to run: a live backup run holds the fingerprint in … (pid 37828) … the holder may use either lock style, because a flock run rewrites the same fingerprint …`，exit 1。注释同步改口径。
2. `deploy/hindsight/backup.sh:378`（现 ~386）bash -x 口令泄漏盲区：新增前置守卫 `[[ $- == *x* ]] → 拒跑`。演练：`bash -x backup.sh` → exit 1，stderr 首行即拒跑消息，trace 中 `DB_PASSWORD`/`pg-dump` 出现 0 次（未及读取任何机密即退出）。
3. `server/src/memory/sensitivity.ts:100` `diagnos\w*` 误伤：改为 `/\bdiagnos(?:is|e[sd]?|ing)\b/i`（保留 diagnosis/diagnose(s)(d)/diagnosing，排除 -tics/-tic 技术语义）。测试：新增 "Works on the diagnostics team at the bank" → normal、"Diagnostic logs go to the observability bucket" → normal；既有 "Diagnosed with type 2 diabetes last spring" → medical 不回归（7 pass / 102 expects，Bun 层）。
4. `server/src/hindsight/health.ts:220` 运行时 llm_trace 违规被 gateway_down 掩盖：交叉核对块整体前移到网关探针之前（readVersion 之后、try 之前），纯移动无逻辑新增；docstring 同步（"on the service_up path" → "before the gateway probe … never masked by gateway_down"）。新增 2 测试：探针 ok:false + 运行时 llm_trace:true → config_noncompliant；探针不可达 + 违规 → config_noncompliant。真实实例回归：happy → service_up（stand-in 日志 09:07:02 有探针 LLM 调用）。

### Verification 要求逐条

- medium 1-4 各补测试或演练证据：见上（1/2 演练，3/4 测试）。
- 规范 12 文件套件（ticket-378 §2 第 317 行清单，两层制）：
  - Bun 层 7 文件：`TEST_DATABASE_URL=…5560/hs001 bun test ./tests/memory-sensitivity.test.ts ./tests/memory-expiry.test.ts ./tests/memory-store.integration.test.ts ./tests/memory-intelligence.integration.test.ts ./tests/memory-defaults.integration.test.ts ./tests/proactive-store.integration.test.ts ./tests/bot-lifecycle.integration.test.ts`（server/ 下）→ 73 pass / 0 fail。
  - 原生层 5 文件：`bunx e2e run --config e2e.unit.config.ts server/tests/memory-runtime.test.ts server/tests/memory.test.ts server/tests/memory-shared-source.test.ts server/tests/memory-default-source-tool.test.ts server/tests/intelligence-memory.test.ts` → 32 pass / 0 fail。
  - 注：12 文件一次性 `bun test` 会因 registerHooks（ADR 0008 分层原因）挂掉其中 5 个原生层文件，非缺陷；两层各跑全绿，0 skip。
- hindsight 2 文件：`bunx e2e run --config e2e.unit.config.ts server/tests/hindsight-health.test.ts server/tests/hindsight-config.test.ts` → 29 pass（15+14，基线 27 + 新增 2）。
- `cd server && bun run typecheck`（tsc --noEmit）→ exit 0。
- `bunx biome check`（4 个 TS 改动文件）→ 0 问题。

### 改动文件（未提交）

| 文件 | 内容 |
| --- | --- |
| deploy/hindsight/backup.sh | m1 消息+注释口径；m2 xtrace 拒跑守卫（+8 行） |
| server/src/memory/sensitivity.ts | m3 正则收窄 +2 行注释 |
| server/src/hindsight/health.ts | m4 交叉核对前移（纯移动+docstring 措辞） |
| server/tests/hindsight-health.test.ts | m4 新增 2 用例（+41 行） |
| server/tests/memory-sensitivity.test.ts | m3 新增 2 反例断言（+14 行，含 biome 归位） |

### 遗留（票面"复现 lows"，核验均未修，未在本批处理——属 Wave 2 首批/专项范围）

- standin（gateway-standin.mjs）：路由清单双份维护（if/else 与 status 行数组）；`path.startsWith("/")` 死条件；查询串未剥离（req.url 含 ?query → 404）；listen 无 error 处理。
- verify-health.ts:31 `scenario in expected` 原型链继承键。
- health.ts readVersion 空 catch 无日志；两处 probe 日志构造可抽 helper。
- backup.sh：保留期数字位数不限；SIGINT/SIGHUP 无 trap；无自动化测试。
- store.ts 各项归属 #384 裁决；sensitivity.ts:120 不可达 try/catch。

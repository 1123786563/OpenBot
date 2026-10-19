# ORCA-REPORT — craft-C1 批次：#436 / #437 / #433 / #404 / #408（Craft Preview 域）

- 分支：`1123786563/craft410`（HEAD `3ca32d49`，基线晚于票面 `44754feb`）
- DB：`postgres://postgres:postgres@127.0.0.1:5564/craft`（容器 `orca-all-craft-pg`，保留未删）；fresh 库 `craft436` 同实例
- 测试两层制（docs/adr/0008）：原生层 `bunx e2e run --config e2e.unit.config.ts server/tests/<file>`；`bun test` 直接跑 server/tests 会因 `registerHooks`（node:module）加载失败，不是套件本身的问题
- 总结论：**#404 SATISFIED（零改动）；#436 / #437 / #433 / #408 均 BLOCKED-GAP（缺口超 20 行或多文件，留专项派发）**。本批零代码改动，唯一产物为本报告

---

## #436 — main 迁移集建不出可启动 schema（fresh DB 42703）→ **BLOCKED-GAP（与 F1 同根）**

**AC 逐条实证：**

- AC1（全新库 migrate → 启动无 42703）✗ **仍在复现**
  - 复现链（HEAD `3ca32d49`）：`docker exec orca-all-craft-pg psql -U postgres -c "create database craft436"` → 先应用 `server/ops/enterprise/roles.sql`（migrate.ts 的 enterprise-role 前置检查要求 ob_ent_* 四角色）→ `cd server && DATABASE_URL=…/craft436 bun scripts/migrate.ts` → `{"type":"migrations-applied","status":"ok"}`
  - migrate 后 `skills` 实表 11 列：`category created_at id installed_by instructions origin owner_user_id slug summary title updated_at`——**无 `icon`**
  - 最小 env 启动（`DATABASE_URL + KEY_ENCRYPTION_KEY + OPENBOT_SINGLE_USER + INTELLIGENCE_* dummy`）`bun src/index.ts` → 崩于 `PostgresError: column "icon" of relation "skills" does not exist, code 42703, routine checkInsertTargets`，正是票面的 marketplace skills 启动插入路径；psql `insert into skills (icon) values (1)` 同样 42703
- AC2（差异扫描门禁）**半存在、结构性盲**
  - CI 已有 drift probe（`.github/workflows/ci.yml:594-624`：`bunx drizzle-kit generate --name=ci_drift_probe` 后 `git status --porcelain drizzle` 非空即 error）——形式上就是票面要求的门禁
  - 但双盲：(a) `server/drizzle.config.ts` 的显式 schema 清单缺 **19 个文件**（enterprise-bot-ownership / enterprise-credentials / enterprise-credential-lease / enterprise-governance-policy / enterprise-oauth-state / enterprise-personal-bot / enterprise-plugins / enterprise-runtime-config / enterprise-shared-approvals / enterprise-sso-scim / job-ownership / openmuse-task-tenancy / payer-accounts / personal-shares / vendor-billing / call-attributions / company-finance 等；config 注释自己写明 "Files missing from this list are invisible to generate"）；(b) probe 只比 schema↔snapshot，而 `0160_snapshot.json` 的 `public.skills` **已含 icon**（0073 起就有）却无任何一条 sql 建它（`grep icon drizzle/*.sql` = 0）——snapshot/sql 不自洽时门禁必绿
- AC3（补齐全部漏列）✗
  - 实测（schema `getTableColumns` 全量导出 vs craft436 实库 information_schema）：**声明有、实库无 = 291 列 / 39 张表**（`skills.icon` 是其一；最大头 enterprise_shared_use_requests 15 列、enterprise_oauth_states 13、job_leases 12……）。反向（实库有、声明无）也存在（expert_installs 整表、enterprise_conversations 等）
- AC4（CI fresh-db boot job）✗：workflows 里无任何「建临时库 → migrate → boot」job（ci.yml:432 的 "fresh" 是 enterprise preflight 角色检查模式，不是 boot）

**F1 关联（批次说明要求确认）：同根确认。** F1 的「迁移链缺 38 张表」与本次实测「漏列 291 列/39 表 + snapshot/sql 不自洽 + config 清单盲区」是同一复合根因：迁移链、drizzle snapshot、drizzle.config schema 清单三方互相漂移，无一致性门禁兜底。修复 = 补一条迁移（产品侧）+ 补 config 清单 19 文件 + CI fresh-db boot job + snapshot/sql 对账，量级远超本批 ≤20 行 IMPLEMENTED 限额 → **BLOCKED-GAP**。

**命令与输出摘要：**
```
create database craft436; 应用 ops/enterprise/roles.sql → ob_ent_* 4 roles OK
DATABASE_URL=…/craft436 bun scripts/migrate.ts → {"type":"migrations-applied","status":"ok"}
skills 实表列 = 11（无 icon）；public 表数 = 178
bun src/index.ts（KEY_ENCRYPTION_KEY/OPENBOT_SINGLE_USER/INTELLIGENCE_* dummy）→ 42703 checkInsertTargets（skills 启动插入 research-public-web）
schema vs 实库：comm -23 → 291 行 / 39 表；drizzle/*.sql 含 "icon" 的文件数 = 0
drizzle.config.ts schema 清单 54 项 vs 实际 schema 文件 73 个 → 19 个未列入（generate 盲区）
```

**改动文件：** 无（craft436 库保留在 orca-all-craft-pg 供复用）。
**遗留（给专项派发）：** ① `bun db:generate` 补迁移并人工审阅只 ADD/CREATE；② drizzle.config.ts 补 19 个 schema 文件；③ snapshot↔sql 对账（0160 快照含 icon 无对应 sql 的不自洽要能被门禁抓到）；④ CI fresh-db boot job；⑤ 反向漂移（实库有/声明无的表）是否清退需裁定。

---

## #437 — 新会话 start 脚本未注入 /<label> mount → **BLOCKED-GAP**

**当前 HEAD 状态（对照 AC）：**

- 已落地的半（与 #433 交叠，checkpoint `2b2fd724` 合入）：`readWebappGeneration` 加了空内容容错——`appBody.trim() === "" → "current"`（webapp-generation.ts:139-145，注释明说这是对「gateway 对缺失路径返回 200 {"content":""}」的防御）；webapp-info 的 `.webapp-mount` 交叉校验抑制地址；mint 对 legacy 拒绝出票（409）
- AC1/AC2/AC3（真机浏览器端到端）**无法在本环境实证**：需要 Casdoor 登录 + Intelligence key + agent-sandbox 容器 + 模型调用（本环境容器不在、INTELLIGENCE_API_KEY 无真实值）；且 AC5 的修复入口缺失时，真机跑出的仍是抑制态（webapp_url:null + closedReason），不可能满足 AC1
- AC4（降级路径测试）**部分满足**：`craft-webapp-generation.test.ts` 32/32 过（含 fix-ocr28 #10 sync injections degrade to null、unknown degrade 等分支）；但票面要求「不得留下 current+根挂载+标签地址的**永久**不一致」——当前形态是「fileApi null → 门控保守 null → 脚本根挂载 + webapp-info 抑制地址」，不一致没有标签 404（好），但也**没有恢复路径**（见 AC5）
- AC5（skills/reload 或 repair 强制重写）✗：`reloadSessionSkills` 保留 non-stale 短路（manager.ts:546-552，`sessionRuntimeStale` 为 false 直接 `return false`，注释明说 "onyx's non-stale short-circuit is restored"）；routes.ts 无独立 repair 端点；mount 不符不构成重写触发条件——「用户照提示修不好，只能重建会话」仍在
- AC6（文案改正）✗：`WEBAPP_MOUNT_STALE_REASON`（webapp-proxy.ts:118-120）仍是 "The web app was started by an older start script…"——对这个「服务端未注入」的成因仍是事实错误文案
- 附带发现（抑制态 preview-ticket 仍出票）✗：mint 只挡 `legacy`（409）与 `unknown`（503），`generation === "current"` + mount 不符时直接 issuePreviewTicket（webapp-proxy.ts:644-680）——抑制态仍能拿到 origin

**命令与输出摘要：**
```
bunx e2e run --config e2e.unit.config.ts server/tests/craft-webapp-generation.test.ts → 32 pass
bunx e2e run --config e2e.unit.config.ts server/tests/craft-webapp-proxy.test.ts server/tests/craft-preview-ticket.test.ts → 109 pass
```
（109 全绿本身佐证书面判断：现有测试对「抑制态出票」「文案错误」「无恢复入口」零覆盖。）

**改动文件：** 无。
**分级理由：** 缺口 = repair 强制重写入口（manager/routes）+ 文案 + mint 抑制态联动 + 测试，跨 3+ 文件超 20 行，且与 #433 同根因链纠缠 → BLOCKED-GAP。

---

## #433 — sandbox /file/content 丢失 absent→404 契约 → **BLOCKED-GAP**

**AC 逐条实证（以代码路径为准；本环境无 agent-sandbox 容器，无法打真实 4300）：**

- AC1（/file/content absent→404）✗：`agent-sandbox/src/proxy.ts` 的 ALLOWED 白名单放行 `GET /file/content` 后走通用上游转发（525-530 行探活 + fetch 透传），**没有** stat 级 absence 分支——上游 opencode-serve 200 空内容的回归原样穿透。GET /file 有先例（291-314 行代理自答 404），/file/content 未复制该模式
- AC2（GET /file：absent→404 ✓ / 目录→200 ✓ / 存在文件→200 内容 ✗）：absent→404 与目录列表已由代理保证；**存在文件仍 fall through 转发上游**（proxy.ts:314 注释 "Exists (file or directory): fall through to the upstream forward below"）——票面实测的「文件路径 500 UnknownError」路径未摘除
- AC3（代理契约测试四类形状）✗：`agent-sandbox/tests/proxy.test.ts` 对 /file/content 仅 1 个 413 上游响应上限测试；无 absent/existing/目录/越界四类契约测试
- AC4（集成：新会话预配含 ONYX_WEBAPP_BASE_PATH）——本环境无法端到端；server 侧 generation 判定已有 sentinel 空内容容错（#437 节），对 D10 误判这一具体后果是缓解，但网关契约本身未修
- AC5（readWebappGeneration 经真实网关答 current）——同上，无法真实网关实证
- AC6（server 侧语义不回退）✓ 现状即满足：`sandbox-gateway.ts` readFile/readFileBytes 判读未动（404→null、非 ok→throw，176-240 行）

**命令与输出摘要：**
```
grep -n "file/content" agent-sandbox/src/proxy.ts → 仅白名单一行（44），无独立处理分支
grep -n "file/content" agent-sandbox/tests/proxy.test.ts → 仅 413 一处（154）
docker ps | grep sandbox → 无容器（真实栈实证不可得，如实标注）
```

**改动文件：** 无。
**分级理由：** 修复 = proxy.ts 两处分支（/file/content stat + GET /file 文件直读）+ 四类契约测试，约 60-80 行 → 超限 BLOCKED-GAP。

---

## #404 — 主站 host 落模板基座被吞 → **SATISFIED（零改动）**

**AC 逐条实证：**

- AC1-AC4（4 个 admission case）：`server/tests/craft-preview-origin.test.ts:894-955` 的 `#404` describe 块，`test.each` 恰好四条：`app.example.com + {session}.example.com → closed`、`example.com + {session}.example.com → closed`、`app.example.com + {session}.preview.example.com → open`、`example.com + {session}.preview.example.com → open`——全过
- 实现齐备：`preview-origin.ts` `mainSiteHostOf()`（436 行起，注释标 #404）+ `claimsPreviewHost` 同一 claim 判重叠（admission / handlesRequest / claimsOrigin 三面共享，模块头注释明说）；closed reason 含 base、被吞 host、`OPENBOT_APP_URL` 修复指引；closed 时 `originFor` throw / `resolvePreviewRequest` 503 readable reason（fail-closed 也有测试）
- 注入齐备：`server/src/index.ts:5452-5461` 把 `config.appUrl`（OPENBOT_APP_URL → first TRUSTED_ORIGINS → OPENBOT_PUBLIC_URL）注入 preview origin 装配，注释标 #404
- AC5（现有 host 路由测试不回归）：整套 `craft-preview-origin.test.ts` **111/111 pass**（含 fix-ocr16 点号 FQDN、notexample.com 后缀陷阱等边界）

**命令与输出摘要：**
```
bunx e2e run --config e2e.unit.config.ts server/tests/craft-preview-origin.test.ts → 111 pass / 0 fail
```

**改动文件：** 无。
**遗留：** ACME sidecar 读 OPENBOT_APP_URL 的同校验未做（票面「改动范围」可选项，**AC 无对应条目**；仓库未检索到独立 sidecar 代码目录）——不阻塞本票结论。

---

## #408 — 生产空模板/缺 preview 域名时显式关闭（AC6）→ **BLOCKED-GAP**

**AC 逐条实证：**

- AC1-AC3 ✗：`preview-origin.ts` `admission()`（678-721 行）对空模板（`template.kind === "dev"`）**除 devPort 无效外一律 `{ok:true}`**——无任何部署形态判定；dev form 的 `originFor` 照常铸 `http://127.0.0.1:<port>/<label>`，`previewOriginClosedReason` 不会出现，`preview-ticket` 也不会 503
- AC4 ✗：`craft/config.ts` 只有 `previewOriginEnabled`（boolEnv）+ `previewOriginTemplate`（stringEnv，注释 "Empty = the D5 dev form"）——**不存在**显式 DEV 开关或部署上下文（grep `#408`/`CRAFT_PREVIEW_ORIGIN_DEV` 全仓零命中）
- AC5（非空合法模板原行为不变）：现状即原行为（host form 分支未动），满足
- AC6（现有 preview 测试全过）：`craft-preview-origin.test.ts` 111 过 + `craft-webapp-proxy.test.ts`/`craft-preview-ticket.test.ts` 109 过——注意这是「不实施也不回归」的绿，非 AC 实证

**命令与输出摘要：**
```
grep -rn "#408" server/src server/tests → 零命中
admission()（preview-origin.ts:678-721）dev 分支仅 devPort.invalid 会关闭
bunx e2e run … craft-preview-origin.test.ts → 111 pass；craft-webapp-proxy + craft-preview-ticket → 109 pass
```

**改动文件：** 无。
**分级理由：** 缺口 = config 开关 + admission 分支 + index 注入 + webapp-proxy 联动 + .env.example/docs，跨 5+ 文件 → BLOCKED-GAP。

---

## 批次汇总

| 票 | 结论 | 一句话 |
|---|---|---|
| #436 | BLOCKED-GAP | fresh DB 仍 42703 实锤；291 列/39 表漂移 + config 清单 19 盲区 + snapshot/sql 不自洽，与 F1 同根 |
| #437 | BLOCKED-GAP | 空内容容错那半已修；repair 强制重写、文案、抑制态出票三缺口在 |
| #433 | BLOCKED-GAP | /file/content 无 stat 分支、GET /file 文件直读未做、契约测试缺 |
| #404 | SATISFIED | 实现+注入+4 case 测试全在，111 全过 |
| #408 | BLOCKED-GAP | admission 对空模板+生产恒 ok，无 dev 开关，六条 AC 全未实施 |

- 本批产品侧 IMPLEMENTED：0（无缺口落在 ≤20 行单票文件集内）
- 改动文件：仅本报告（`ORCA-REPORT.md`，覆盖了上一批 #410 的旧报告）
- 容器 `orca-all-craft-pg` 与 `craft436` 库按要求保留

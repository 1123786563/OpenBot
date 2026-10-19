# [craft-C4] 批次核验报告 — #406 #407 #417 #418 #419

工作区：`craft410`（HEAD `3ca32d49`；origin/main 仅领先 5 个 docs/test/ci 提交，经逐条核对不含 craft 产品代码，无主线漂移）。
DB：本批全部执行套件均用注入 fakes，未触库；`postgres://postgres:postgres@127.0.0.1:5564/craft`（容器 orca-all-craft-pg）按要求保留未删、未使用。
跑法：原生层 `bunx e2e run --config e2e.unit.config.ts <file>`，Bun 层 `bun test ./<file>`（ADR 0008 两层制）。
工作区并存上一批 #415 未提交增量（lib.sh / tls-pipeline.test.ts / preview-origin.ts / craft-preview-origin.test.ts / craft-webapp-template.test.ts），本批未回退、未混淆——下文改动文件均按会话拆分标注。

---

## #406 票据响应 no-store / Referrer-Policy 与日志脱敏 — **IMPLEMENTED**（本批唯一产品侧 IMPLEMENTED）

**核验**：三层缺口在 HEAD 实证——
1. 签票响应（webapp-proxy.ts `POST /sessions/:id/preview-ticket` 的 `context.json({ticket,…})`）无任何响应头：craft 面仅有 write-origin-guard / requireUser / enabled 三层中间件，均不设头；
2. 兑换 302（preview-origin.ts）已有 `cache-control: no-store`（但无测试 pin），`referrer-policy` 全域缺失（grep `server/src` 仅 workshop/public-routes.ts 有）；
3. 部署文档无任何反向代理对 `?ticket=` 的访问日志脱敏要求（grep 全 docs 仅 craft-preview-origin.md:58 有应用侧"不出现在日志"句）。

**修复（TDD RED→GREEN，全实证）**：
- RED：craft-webapp-proxy.test.ts 新增 `#406: the mint answers no-store and no-referrer`（2 断言）+ craft-preview-origin.test.ts 新增 `#406: the redemption 302 answers no-store and no-referrer`（2 断言，含把 302 既有 no-store 首次钉住）→ 两套件 2 failed / 197 passed。
- GREEN：mint 改 `context.json(…, 200, {"cache-control":"no-store","referrer-policy":"no-referrer"})`；302 headers 增 `"referrer-policy": "no-referrer"` → 同两套件 199/199。
- 文档：docs/craft-preview-origin.md 进入流程节补 5 行——签发/302 头契约 + 部署注意段（反代访问日志按原样记 query，须用 `$uri` 或 map 掩码 `?ticket=`）。

**AC 逐条**：
- [x] 签票响应和 302 响应带 no-store / no-referrer：两测试实证（199/199 中的新增 2 例）。
- [x] 测试不读取、不记录票据值：两测试文件无 console/日志输出（grep 实证）；票据值仅用于构造兑换 URL（必要输入），无持久化。
- [x] 文档明确访问日志风险：craft-preview-origin.md 新增"部署注意（#406）"段。

**改动文件**（本会话）：`server/src/craft/webapp-proxy.ts`（产品 +9，其中头 2 行）、`server/src/craft/preview-origin.ts`（产品 +5，其中头 1 行；该文件另含上批 #415 未提交 +10）、`server/tests/craft-webapp-proxy.test.ts`（+17）、`server/tests/craft-preview-origin.test.ts`（+19；另含上批增量）、`docs/craft-preview-origin.md`（+5）。

**遗留**：无。

---

## #407 TLS 测试超时与 CI 稳定性 — **SATISFIED+FIX**（测试侧小修，18 行）

**核验**：票面背景（默认 5s 三败）的修法已由 CI 基建落地——
- CI 链：`bun run test:ci`（ci.yml:459）→ `scripts/test-ci.ts` → e2e 收集 `tests/bun-suites.test.ts`（e2e.unit.config.ts:29-47 排除 Bun 层文件本体、保留 driver）→ driver `runBun` 以 `bun test <files> --reporter=junit --timeout=120000` 驱动 tls-pipeline（tests/bun-suites.test.ts:156），即"CI 命令显式使用合适 timeout"；
- 等价验证：`bun test ./scripts/tls-pipeline.test.ts --timeout=120000` → **117 pass / 0 fail**（95.31s，395 expects）。票面时点 99 例，#415 增至 117——覆盖未降反增；
- 超时 vs 产品失败的区分已有两层：run 级 840s kill 输出 "gave no verdict within 840s; killed…"（:165-171）；单测级 junit `failure type="TimeoutError" message="test timed out"`（探针实证，与 `AssertionError` 属性可分）。

**小修（补齐第三层：driver 摘要把该区分带出来）**：junit 的 TimeoutError 判词只写进 failure 标签属性、body 为空，driver 的 `failed[]` 摘要按 body 文本提取 → 超时项打印成 `"name: "`（空判词）；且 testcase 名提取的正则 `[^>]*name=` 贪婪回溯进 `classname=""`（bun 恒写空 classname），**失败行连测试名都恒空**。修：`tests/bun-suites.test.ts` readJunit —— 名字正则改 `[^>]*?\bname=`（+`\b`+惰性，2 行）；body 为空时回退取 failure 标签的 `type`/`message` 属性并解码 `&#NN;`（+14 行）。
**实证**：探针 junit（含 1 超时 + 1 断言失败）过新提取逻辑 → `probe.test.ts slow probe: TimeoutError: test timed out` / `fail probe: AssertionError: expect(received)…`，名字与类型俱在；`bun build --target=bun` 语法过。driver 全量跑（24 组、含 tls 95s）未在本批执行——改动为纯提取函数、无副作用，留 CI 首跑复核。

**AC 逐条**：
- [x] 默认 CI 命令稳定 117 pass：CI 等价命令实证（99→117 因 #415 扩例）。
- [x] 失败信息能区分产品失败与超时：run 级 kill 句 + junit type 属性 + 修复后 driver 摘要三层可分（探针实证）。
- [x] 不降低测试覆盖：117 例全跑、零 skip。

**改动文件**（本会话）：`tests/bun-suites.test.ts`（+18/-2，测试基建）。
**遗留**：driver 全量链路（`bun run test:ci` 整跑）留给 CI。

---

## #417 legacy 手工装配/根挂载消除静默 404 — **SATISFIED**（零改动）

**核验**：票面四项均已由 fix-ocr27 #3 / fix-ocr28 #4 / review-367 H 线落地（HEAD 实证）：
- webapp-info legacy 分支（webapp-proxy.ts:814-889）ready 门内做 `.webapp-mount` 交叉检查：记录非空且 === 派生 label 挂载 → **手工装配中间态治愈**（按 current 形态发 preview 地址）；非空且 ≠ → `WEBAPP_MOUNT_STALE_REASON`（可展示修复句）；空/缺/不可读 → 真 legacy 旧同源路径（byte-for-byte 原样）。
- preview-ticket legacy-heal 镜像（webapp-proxy.ts:650-672，fix-ocr28 #4 单一 `readMountRecord` 共享读）：记录证明挂载才铸票，否则 409 `PREVIEW_TICKET_LEGACY_ERROR`。
- 根挂载在 current 分支同样接住：记录空 ≠ dev 期望 `/<label>` → STALE 句；host 形态期望即根、空记录匹配 → 诚实发址。
- 测试面：craft-webapp-proxy.test.ts 一族实证（本批实跑通过）——`:1418` legacy 无 marker 得旧路径、`:1535` 空记录=真 legacy 回归 pin、`:1491` 手工装配治愈、`:1516` 他挂载→修复句、`:1663/:1692` current+空记录→显式原因、`:1834` host 根挂载匹配、`:2303/:2326` 铸票镜像两态。

**AC 逐条**：
- [x] 标准 legacy app 旧路径可用：`:1418`/`:1535` pin（旧路径 + 诚实 down 态 `:1462`）。
- [x] 手工/根挂载不再无提示 404：`:1491`（治愈不发 404）/`:1516`/`:1663`（显式 reason，非 404）。
- [x] 用户可见提示与文档一致：`WEBAPP_MOUNT_STALE_REASON` 句与 docs/craft-preview-origin.md:239-240（"失配由 webapp-info 的 .webapp-mount 交叉检查接住（可修复的显式原因）"）一致。
- [x] 不改变 D10 不迁移策略：legacy 分支空记录仍走旧路径、D10 段（docs:225）未动。

**形态差异（记录，非缺口）**：票面字面分支（空记录 + dev → STALE）未照抄——空记录折叠"从未写"与"根挂载"两群（fix-ocr29 #3），对真 legacy 会误伤 AC1；实现改为只对**非空失配**记录出 STALE、空记录保旧路径，手工装配由非空精确匹配治愈。另"真实 e2e"一项：验收脚本明确将 legacy 流程划出范围（scripts/craft-preview-acceptance.ts:2178-2181 注释），由单元/集成套件钉住——已记录的偏差，不阻 AC。
**改动文件**：无。

---

## #418 多副本 ticket/label 状态共享或单副本契约 — **IMPLEMENTED**（docs-only，不占产品侧名额）

**核验**：
- 选 A 未做：无 `preview_label` 列（grep server/ 零命中）、票据仍进程内 Map（preview-ticket.ts:77）——符合票面"或"关系，非缺口。
- 选 B 的行为半边已在：M-2 已文档化（docs/craft-preview-origin.md "为什么不落库"段：单进程 registry 接受、重启恢复=一次重进、多副本为迁移触发条件）；preview-origin.ts:685-687 ponytail 注释同义；不静默 404——pane 探活 `preview-origin-live` 对 registry 缺失答 503 "re-enter" 句（fix-ocr13），旧地址请求落主站路由而非 404（docs:36）。
- **缺口**：部署文档面无契约——docs/deployment.md Replicas 段只说"Run more than one if the platform wants it"、Helm README 称"Everything that has to survive a replica is in PostgreSQL"，与 preview 状态进程内的事实直接矛盾（幸 chart 未接 craft，矛盾是潜伏的）。

**补**：docs/deployment.md Replicas 段 +7 行——craft preview origin 的 label registry 与票据在进程内存，签票/兑换须同副本；保持单副本或把 `*.preview` 主机名钉到单实例，直至状态落 Postgres；重启恢复路径（主站重进一次）即第二副本会引导用户走的同一条路。

**AC 逐条**：
- [ ]（A）未选，不适用。
- [x]（B）部署文档明确限制：deployment.md Replicas 段新增约束；"不会多副本静默 404"由既有行为背书（503 re-enter 句 + 旧地址落主站，代码/文档指针见上）。
- [x] 不引入与现有 Redis/DB 迁移冲突：零代码、零迁移。

**改动文件**（本会话）：`docs/deployment.md`（+7）。
**遗留**：A 路线（`craft_sessions.preview_label` + Redis 票据 + 双实例测试）为真痛点出现后的专项，票面已预留该出口。

---

## #419 Issue/文档证据收口与 #358 验收汇总 — **SATISFIED**（零改动；证据收口型）

**核验**：repo 侧收口已由 `215b3f15`（docs(craft): 收口 #419 文档漂移并记录 #358 验收证据）完成，该提交经 `git merge-base --is-ancestor` 实证在 HEAD 与 origin/main。逐项对票：
- cookie 门"任一匹配"更正：craft-preview-origin.md:91 现行文"遍历 Cookie 头里全部同名候选，任一验签通过"（fix-ocr20 #3 口径）✅；
- HMR #363 已落地：craft-preview-origin.md:195 小节"### HMR（#363，代码已落地）"+ :267 对照表行（运行时热更新仍待实测、受 #437 阻塞——如实分级）✅；
- tls-certs.md server 消费描述改真实拓扑：:49-51 "server/src never opens these files… that proxy is the certificate consumer"、:142 "The server does **not** read it"、:233 reload 指向 TLS 终结者 ✅；
- `.env.example` preview/TLS 变量：:551-579 craft preview origin 块（含与 KEY_ENCRYPTION_KEY 的签名关系）+ TLS 块 ✅；
- `docs/agents/domain.md`：存在（20 行，单一领域上下文分工说明）✅；
- 证据记录：`docs/plans/2026-10-18-craft-preview-issue-419-evidence-closeout.md`——含 #358 九条 AC 按证据档位的验收矩阵（AC1/AC9 verified@44754feb、AC4 降级 partial、AC3 unknown、AC2/AC5 blocked、AC6/AC7 verified_partial、AC8 partial；"#358 不能宣布验收完成"）✅。
- GitHub 侧（#358 正文 [x]、#359 Parent 自引用、#360/#361 过时评论、原生 sub-issue 关系）：按收口文档记录的用户裁决"GitHub 状态与关系写入一律未执行"保持原样；本会话 gh 实读补充现状——**#359–#367 九张现已全部 CLOSED**（晚于收口文档时点），#358 仍 OPEN（母票，与验收矩阵"未完成"一致）；#358 原生 sub-issues 为 #403–#433（30 张，含本批 5 票），#359–#367 为文本关系；#359 正文 Parent 仍自引用。批次说明已划界：#358 正文 D6 旧文为票主处理，不在本批范围。

**AC 逐条**：
- [x] #358–#367 状态、AC、证据一致：验收矩阵 + GitHub 现状（九子票 CLOSED、母票 OPEN）自洽；#358 正文 [x] 与矩阵的出入属票主范围（D6 旧文，批次说明划出）。
- [x] 新旧 Issue 关联可追溯：#403–#433 原生关系 + #359–#367 文本关系（Parent 字段）+ 收口文档记录。
- [x] 未完成项保持 OPEN/blocked：#358 OPEN、#436/#437 等 P0 依矩阵 blocked 记录。
- [x] 不以文档勾选替代测试/部署证据：矩阵按证据档位降级（AC4 partial 等），未折算。

**改动文件**：无。

---

## 本批回归总账（全部实跑）

- 原生层 craft 家族 6 套件（origin/rejection/ticket/pass/webapp-proxy/template）：**279/279**（含本批新增 2 例）。
- Bun 层：craft-preview-socket + craft-webapp-hmr **53/53**；tls-pipeline `--timeout=120000` **117/117**（95.31s）。
- server `tsc --noEmit` exit 0；`tests/bun-suites.test.ts` `bun build --target=bun` 语法过。
- biome：本会话改动区域零新增发现（format-diff 落点全在本会话未触碰行：550/773/803/835/1489 为上批 #415 未提交增量、46-49/1320 与 organizeImports 为 HEAD 既有）；发现总数与改动前同构。
- 未跑：`bun run test:ci` 全量（分钟级大跑）、driver 全组链路——留 CI；本批无产品逻辑依赖它们。

## 本批改动文件清单（未提交区，按会话）

- 本批（#406/#407/#418）：`server/src/craft/webapp-proxy.ts`、`server/src/craft/preview-origin.ts`（叠加段）、`server/tests/craft-webapp-proxy.test.ts`、`server/tests/craft-preview-origin.test.ts`（叠加段）、`tests/bun-suites.test.ts`、`docs/craft-preview-origin.md`、`docs/deployment.md`。
- 上批遗留（#415，勿回退）：`docker/compose/certs/lib.sh`、`scripts/tls-pipeline.test.ts`、`server/src/craft/preview-origin.ts`（#415 段）、`server/tests/craft-preview-origin.test.ts`（#415 段）、`server/tests/craft-webapp-template.test.ts`。

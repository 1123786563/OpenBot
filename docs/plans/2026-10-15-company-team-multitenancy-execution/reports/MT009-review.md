# MT009 / Issue #52 独立复审报告 —— 团队公共资源动作规则（两任实现终态）

- 复审者：MT009 独立复审（全新 Pi 会话，Orca task_cd056c9acf8c / dispatch ctx_ffef911f5ec7，工作树 `i7-review-mt009`，BASE `f0520524`）
- 审阅对象：本树 = EXE 43 项前置 + MT009 六方增量（新 3：`team-public-rules.ts` / `team-public-rules.test.ts` / `support/team-public-rules.ts`；编辑 3：`src/index.ts` / `migrate-test.ts` / `migration-tool.test.ts`），即两任实现的交付树终态（第 1 任实现 + 第 2 任零代码收尾 + coordinator 三方合并装配）
- 方法：只读被审文件；唯一新建为本报告；六项裁决 A–F 逐条独立取证；全部复跑亲自执行并记录退出码；专用容器 `mt009-review-pg`（55492）与凭据文件（0600 随机口令）用后已删
- 结论先行：**MT009 通过复审**。六项裁决全部有证据支撑；三方合并未改变 MT009 增量语义（逐字节核验）；36/433/typecheck/biome/七任务迁移链全部亲自复现且精确命中预期；第 2 任对 verification/01 瞬态失败的排除法结论**予以采信**。发现 2 项 trivial 备忘，均不阻塞。

---

## 1. 独立复跑结果（全部亲自执行，退出码逐一记录）

| # | 步骤 | 结果 | 退出码 |
|---|---|---|---|
| 1 | `lsof -i :55492` 端口预检（空闲）→ `docker run` mt009-review-pg（pgvector/pgvector:pg16，trust，仅绑 127.0.0.1）→ 容器内 psql 探针 | **PostgreSQL 16.15** | 0 |
| 2 | 双库创建（`openbot_enterprise_mt009rv` + `..._assigned`）+ 五变量 + `MT003_ASSIGNED_TEST_DATABASE_URL` env 文件（随机口令，`chmod 600`，用后已删） | OK | 0 |
| 3 | base migrate：`bun --no-env-file scripts/enterprise-test-db.ts migrate` | `{"type":"migrations-applied","status":"ok"}` | 0 |
| 4 | 按依赖序 apply **MT004→MT008→MT112→MT012→MT014→MT010→MT009**（每任务 dry-run → manifest → apply） | **21/21 命令全部 exit 0**；journal 实录 MT004(2)/MT008(2)/MT112(4)/MT012(2)/MT014(2)/MT010(2)/**MT009(2)** | 0 |
| 5 | 聚焦 `bun --no-env-file test tests/multitenancy/team-public-rules.test.ts --timeout 30000` | **36 pass / 0 fail / 0 skip，167 expect** | 0 |
| 6 | 全量 `bun --no-env-file test tests/multitenancy/ --timeout 30000` | **433 pass / 0 fail / 0 skip，8845 expect，15 文件**（= 397 + 36，精确命中 brief 预期；输出中仅有的 2 处 "skip" 字样为用例名，非真实 skip） | 0 |
| 7 | `bun run typecheck`（tsc --noEmit） | clean | 0 |
| 8 | `bunx biome check` 触及 5 文件（模块/测试/support/migrate-test/migration-tool.test） | **0 诊断** | 0 |
| 9 | `bunx biome check src/index.ts` | 6 errors + 1 warning：1 organizeImports + 4 noConsole + 1 noNonNullAssertion + 1 format——lint 六项与第 2 任 verification/06 逐规则一致；**format 项经 after-snapshot（`95652fbe`）对照实验证实为存量欠账**（三处长 import 行在 MT009 交付时即存在），MT009 增量零新增 | 与披露一致 |
| 10 | 活库抽查：`pg_policies` 恰 3 条（data SELECT / operator SELECT+INSERT，**无任何 UPDATE/DELETE**）；`relrowsecurity=t, relforcerowsecurity=t`；`role_table_grants`（data 仅 SELECT、operator INSERT+SELECT）；3 条 CHECK（kind/status/ref_present）；复合 PK + 复合 FK；journal 7 任务全记账 | 全部符合票面 | — |
| 11 | 活库行为探针：受限 data 角色 + 外来 `app.tenant_id` 查 `enterprise_resource_dependencies` → **0 行**（RLS 真实过滤）；级联探针（插资源 + 插依赖 + 删资源）→ **依赖行 0 剩余**（ON DELETE cascade 生效） | 全部通过 | — |
| 12 | 清理：`docker rm -f mt009-review-pg`、env 文件与全部 /tmp 中间产物删除 | 完成（已验证容器不存在、文件不存在） | — |

环境备注：`MT003_ASSIGNED_TEST_DATABASE_URL` 为第 6 个必需变量（migration-tool 的 MT000 真实 apply 集成用例依赖）；本树 server/node_modules 已预装，无需 bun install。

## 2. 六项裁决逐项复审

**A. 五条验收映射真实性 — 通过（逐用例清点 + 全绿复跑）。**
36 用例逐 describe 清点与报告映射表完全一致：验收 1（成员 read+run 放行 / 配置编辑、删除、分享、管理、上传逐动作拒 / suspended 失去 run 路径 + seam 拒绝重发 scope + 恢复后路径恢复）= 3；验收 2（检索放行 / 上传、删除、范围变更及其余管理逐动作拒 + run 非知识库动作）= 2；验收 3（private bot 显式 read 授权仅 read / 遗留未标记 bot 同 / 团队公共 document read 走团队公共路径而 run 仍拒 / grants 表 CHECK 23514 只认 'read'）= 4；验收 4（全有效放行 / model、credential 失效各指明 kind+ref / 知识范围指向已删、不存在资源各指明 / 无依赖放行 / 本 bot 坏依赖不受他人依赖行影响 / 失效不泄露给非成员 / 管理动作不咨询依赖）= 9；验收 5（跨公司、同公司跨团队逐字节等同不存在 / 公司 admin 连 scope 都拿不到）= 3。另版本门 4 + 纯门 4 + 迁移 4 + 信任边界 3 = 36。**"逐字节等同不存在"由 `verdictJson`（JSON 序列化字符串相等）真实断言，非口号**；本人复跑 36/36 全绿为最终证据。

**B. 纯门与判定事务 — 通过。**
`decideTeamPublicActionWithoutDependencies` 与数据库完全解耦（registry 注入、伪造事实层测试 4 例，跨租户防线独立于 RLS 钉死）。主判定经受限 data 角色 + 真实 RLS（用例断言 `dataCurrentUser() === "ob_ent_data"`；本人活库探针证实 RLS 真过滤）；判定事务形状与 MT008 `policyReadTransaction` 逐行同族（read committed、lock 2s/statement 5s、事务本地 `app.*` set_config、advisory 共享锁同键序同键形：tenant → principal → membership → workspace-membership → resource）。拒绝形状唯一 `RESOURCE_NOT_FOUND`，对真实资源与不存在资源逐字节不可区分（跨公司与跨团队两组用例）。版本门三态真实：workspace-v1 可见 / tenancy-v1 隐藏（默认解析与显式覆盖都测）/ 未注册版本 `POLICY_REVISION_UNSUPPORTED` 响亮抛出——该抛出只依赖调用方/租户供给的版本参数，不依赖资源事实，**无存在性泄露**。

**C. run 依赖校验语义 — 通过。**
仅 bot 可 run（kb/document 的 run → `TEAM_PUBLIC_ACTION_FORBIDDEN`；read 放行绝不派生 run：grant 路径 run → NOT_FOUND、团队公共 document run → forbidden，双路钉死）。`DEPENDENCY_INVALID` 指明第一个失效依赖的 kind+ref（`order by dependency_kind, dependency_ref` 确定性排序）；解释只发给已过可见性门的成员（独立用例：非成员仍 RESOURCE_NOT_FOUND）；管理动作判定不咨询依赖（坏依赖 bot 的 delete → forbidden）。诚实边界（不做传递授权重判）在模块头注释钉死，判定类型本身只承载「声明的依赖是否存活」语义（kind+ref），与边界声明自洽。知识范围引用必须在**同租户内**解析到 active 资源行（RLS 使跨租户引用不可见＝无效，软删除同判）。

**D. 落库合规 — 通过（代码 + 活库双核验）。**
DDL 与活库目录一致：复合主键 `(tenant_id, resource_id, dependency_kind, dependency_ref)`；CHECK kind ∈ model/credential/knowledge、status ∈ active/invalid、ref 非空；复合 FK `(tenant_id, resource_id) → enterprise_resources(tenant_id, id)` ON DELETE cascade（**本人级联探针实证**）；REVOKE PUBLIC + 四角色、ENABLE+FORCE RLS、最小授权矩阵（data 只读 / operator 读+插，**全库无 UPDATE/DELETE 授权**——依赖失效以新状态行表达）。expand-only：测试以语句首词动词锚定逐语句断言（DROP/DELETE/UPDATE/TRUNCATE 全禁、仅允许新表自身的 FK/RLS/策略/授权），活库 `pg_policies`/`role_table_grants`/CHECK/PK/FK 全部吻合；既有对象零改动。

**E. 瞬态失败调查采信 — 采信（推理链独立复验成立）。**
第 2 任对 verification/01（340/1 fail，8431 expect）的排除法链条，本人逐环核验：
1. **排除「GREEN-2 已修」**：mtime 链证实 GREEN-2（22:38:29）早于 01（22:40:29），01 是最后一次绿色运行之后的新失败——该解释确实不成立；
2. **排除「树内缺陷」**：本人三方哈希复算证实交付树 = 第 1 任 GREEN-2 态（3 个新文件工作树哈希 = manifest = after 快照逐位一致：`8475b21a…`/`7087b61b…`/`78d4aa4e…`；3 个编辑文件的 before 快照 = manifest：`addc265c…`/`8d1d6ab6…`/`4ede3c5f…`）——产生 01 的代码与复跑代码逐字节相同，若 1 fail 是代码缺陷，复跑必然复现，而复跑全绿；
3. **中止签名自洽**：01 记录 8431 expect，同树全绿运行 8436（+5）——某用例未跑完自己的 expect 即被中止，与瞬时中止（超时/资源竞争）相容；
4. **复现实验**：第 2 任 9 次全绿（含 10 核 `yes` 饱和负载）存档于 verification/04（341/0/8436 ×5 + 饱和 26.50s）；
5. **本人复跑（主证据）**：本装配树全量 **433/0/0skip exit 0**（15 文件）、聚焦 36/0/0skip exit 0、typecheck exit 0——同一代码在全量、聚焦、本机空闲三条件下确定性全绿。
结论：01 的 1 fail 为一次性瞬时运行时失败（环境/负载类），非未修缺陷。失败用例身份不可考（第 1 任只存 5 行摘要）已由 D1 诚实披露；排除法推理与全部证据自洽，无矛盾点。verification/02 为坏调用产物（`bun <file>` 缺 `test` 子命令）属实，原样保留、以 03–07 替代职能的处置正确。

**F. TDD 链、披露处置与装配接管 — 通过。**
- **TDD 链完整**：RED-1（模块缺失 0 pass/1 fail）→ GREEN-1（32/0/155 expect，已核计数）→ RED-2（纯门导出缺失 0/1，测试先行）→ GREEN-2（36/0/167）→ MUT1–6 **6/6 捕获**，fail 计数逐一核对：MUT1=2、MUT2=3、MUT3=3、MUT4=5、MUT5=1、MUT6=3，与报告 §5 表完全一致，无存活变异。
- **D1–D6 逐条属实**：D1（失败身份不可考）✓；D2（02 坏产物）✓；D3（依赖表 raw SQL 读取，因 `enterprise-tenancy.ts` 在禁改清单——本人核对该文件哈希与 prereq-manifest 一致，禁改纪律成立）✓；D4（诚实边界钉死）✓；D5（第 2 任零生产代码改动——3 个新文件与 after 快照逐位一致即为实证）✓；D6（MT012/MT013 报告文件不在本仓——非本票交付物，如实披露即可）。
- **装配与接管无越权**：见 §3。

## 3. 装配核对（coordinator 三方合并独立性核验）— 通过

brief 披露「index.ts hunk patch 干净应用；migrate-test.ts/migration-tool.test.ts 因与 MT014/MT010 增量重叠按语义位插入」。本人独立核验方法：工作树 ↔ checkpoint after/ 快照 ↔ manifest 三方比对 + 全文件 diff 定位每一处差异归属：

1. **三个新文件逐字节等于第 1 任交付**：`team-public-rules.ts`、`team-public-rules.test.ts`、`support/team-public-rules.ts` 工作树 sha256 与 after 快照及 manifest 三方一致（`8475b21a…`/`7087b61b…`/`78d4aa4e…`）。
2. **index.ts**：当前树 = after 快照 + MT010 增量（personal-share-rules import 块 + 22 行装配段，均在本票 hunk 之外）。MT009 自身两个 hunk **逐字节原样**：+4 import 行（现 283–286 行，与快照同语义位：store 之后、host-access 之前）+ 15 行装配段（现 5936–5949 行，与快照段逐字符相同：共享已验证 enterprise data channel、channel 缺失为 null 绝不伪造、装配一次导出待消费）。未动 MT013 启动段与 MT006 路由段。
3. **migrate-test.ts**：当前树 = after 快照 + MT014（RUNTIME_CONFIG_TASK）+ MT010（PERSONAL_SHARE_TASK）增量。MT009 增量（RESOURCE_DEPENDENCY_TASK 整段 + 注册行）**不在任何 diff hunk 中**＝逐字节未动。
4. **migration-tool.test.ts**：当前树 = after 快照 + MT010 断言条目与注释。MT009 增量（3 行裁决注释 + allowlist `"MT009"` 条目）文本逐字节相同，仅注释块内位置因 MT010 注释插入而顺延——语义位等价（MT008 → MT010 → MT009 → MT012 → 裁决#5 说明），穷举断言与 TASKS 注册表（8 条目含 MT009）自洽。
5. **只读消费面禁改纪律**：resource-policy / resource-visibility / store / scope-gate / workspace-admin（及 personal-share-rules / runtime-config / revocation / connections / 四个 schema 文件）工作树哈希与 prereq-manifest **13/13 逐项一致**。

**结论：三方合并未改变 MT009 增量的任何语义，位置调整均为语义等价重排。**

## 4. 发现（均不阻塞）

**4.1〔trivial · 注释笔误〕** `migrate-test.ts` RESOURCE_DEPENDENCY_TASK 文档注释「CHECK **兑**底取值域与非空引用」应为「**兜**底」。不影响任何行为。

**4.2〔trivial · 披露清单缺一项〕** 第 2 任 verification/06 的 biome 记录只列了 6 项 lint 欠账，未列 src/index.ts 的 1 项 `format` 警告。经 after-snapshot 对照实验，该 format 项在 MT009 交付时即存在（三处长 import 行），属存量欠账而非 MT009/MT010 增量引入，且 MT010 复审已如实记录（"6 errors + 1 warning …, format"）。仅记录清单不完整，无实质影响；本树 biome 对 src/index.ts 的完整现态 = 6 lint errors + 1 format warning，零新增。

## 5. 结论

MT009（Issue #52 团队公共资源动作规则，两任实现终态）在独立复审下全部成立：五条验收逐用例有真实证据（A）、纯门与判定事务同族同键且拒绝形状唯一不泄露（B）、run 依赖校验可解释且解释面正确（C）、落库 expand-only 最小 RLS 经代码与活库双核验（D）、verification/01 瞬态失败的排除法结论经独立复验予以采信且本人复跑 36/433 全绿为主证据（E）、TDD 链 6/6 变异捕获且六条披露逐条属实、三方合并经逐字节核验未动 MT009 增量（F）。聚焦 36/0/0skip、全量 433/0/0skip（15 文件）、typecheck、biome（触及文件 0 诊断、index.ts 零新增）、七任务迁移（21/21 exit 0 + journal 实录）、活库 RLS/级联探针全部亲自复现。放行建议：**MT009 本票通过**；§4 两项 trivial 备忘不阻塞，可在后续消费面票据顺手处理。

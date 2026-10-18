# MT029 独立复审报告 — 凭据取用 lease：固定用途、作用域且可撤销（Issue #72）

角色：独立复审者（只读复审 + 复跑 + 变异抽验；变异注入与复原除外，全程零 git 提交）。
复审树：r15-mt029 = BASE f0520524 + 272 前置（未提交工作树）+ MT029 增量 8。Orca task_6978f329a15a / dispatch ctx_f32474145350。
方法：不采信实现存档，全部门槛在复审自建环境亲测复现；变异抽验 4/4，其中 MUT-3b 与 MUT-12 两个 mandated 项均经**真实变异库 apply**（新建库、真实跑链、psql 亲读确认变异生效，用后 DROP）。本报告写入计划目录 `reports/`（工作树根 `reports/MT029-review.md` 存在前一复审 task_16dc21386eb0 的同题未跟踪档案，本报告同步覆写该位置以免双版本歧义）。

## 结论

**PASS with findings（无 critical/high；3 条 low，均为档案/口径注记，非代码缺陷）。**

四条 AC 在复审自建专用容器（`mt029-review-pg`，pgvector/pgvector:pg16 @ 127.0.0.1:55587，仅回环，随机口令）+ 受限角色 + 真实 RLS 上全部亲测复现：聚焦 **27 pass / 0 fail / 227 expect**、全量 **1151 pass / 0 fail / 44 文件**（两个 expect 分支 13036/13033 均亲测并定位）、typecheck **0**、biome 触及 8 文件仅 BASE 先在 5 处存量（4×noConsole + 1×noNonNullAssertion，内容命中 BASE）、负向 env 移除 = **0 pass / 29 skip（27 用例 + 2 describe 包装）/ 0 fail**、活库 FORCE RLS×2 / 7 策略 / 最小授权矩阵 / 6 命名 CHECK / 4 复合外键（全内嵌 tenant_id、全 CASCADE）与交付声明一致、迁移链 **20 任务 / 38 步**全落账、MT029 planDigest `4d0b7967de76…` 与 checkpoint 存档一致且生成 SQL **逐字节相同**（diff 为空）、冻结面 **264 项零漂移 + 4 授权扩展点 + 4 新文件，8/8 == after-hashes**、变异抽验 **4/4 KILLED**、清理真实执行（容器删除回显、两个变异库 DROP 回显、临时 env/口令/冻结副本全删）。HEAD 复核仍为 f0520524，零提交。

## 复审门槛逐项证据（全部亲测）

| # | 门槛 | 复审结果 |
|---|---|---|
| 1 | `bun install` | ✓ 1445 installs / 1589 packages（frozen-lockfile，无变更） |
| 2 | 三步配方 provision | 端口 55587 预检空闲；容器 `mt029-review-pg`（pgvector/pgvector:pg16，仅 127.0.0.1，随机口令）；psql 逐条建库/建角色（ON_ERROR_STOP）：`openbot_enterprise_w14int`（**对齐主库**）+ `openbot_enterprise_r15b_test`（配方名族照建）+ `openbot_enterprise_r15b_test_assigned`（MT003）+ `openbot_kb_r15b_test`（属主 `ent_r15b_kb` LOGIN NOSUPERUSER NOBYPASSRLS **先于建库**，ALTER OWNER）；七变量 env 0600（三角色登录 `ent_r15b_{directory,data,operator}` 由 provision 授予恰一能力角色，亲核 `pg_auth_members` 各恰一 membership）；用后全删 |
| 3 | 环境对齐（复刻实现者 §0 选项 A） | `entry-context.test.ts:191` 冻结断言 `identity.database === "openbot_enterprise_w14int"` 亲读确认；主库命名 w14int 后全量门完全达成（0 fail）——**采纳选项 A 与实现一致**；r15b 家族库同容器在位，链的名无关性另由 mut3/mut12 两个变异库真实 apply 佐证（库名仅 `openbot_enterprise_*` 形校验，无功能依赖） |
| 4 | 迁移链复现 | base migrate ok → MT004→MT008→MT112→MT012→MT014→MT010→MT009→MT077→MT026→MT076→MT069→MT016→MT041→MT027→MT028→MT070→MT031→MT042→MT059 逐任务 generate+`--apply` 全落账 → MT029 最后；journal **20 任务 / 38 步**与实现声明一致；MT029 planDigest `4d0b7967de76d3c336c62ce346602f8d7cef177d906056199ff2e605bf82b247` == checkpoint 存档 manifest；生成的 0001（10 语句）/0002（17 语句）SQL 与 `checkpoints/MT029/migration-gen/` **diff 为空** |
| 5 | 聚焦 / 全量 | 聚焦 **27 pass / 0 fail / 227 expect**（复跑多次全同）；全量 **1151 pass / 0 fail / 44 文件 / 13036 expect**（全新 `_assigned` 库首跑，MT003 real-apply 用例走 applied 分支），`_assigned` 被套件应用后复跑 **1151/0/44 / 13033**（up-to-date 分支）——两分支均亲测、差 3 为 MT003 用例分支内条件断言（MT028 复审已定位的同族良性差异）；1151 = 1124（基线 43 文件）+ 27（本票）精确闭合 |
| 6 | typecheck / biome | `tsc --noEmit` exit 0；本票 7 触及/新文件 + 1 存量（共 8 文件）biome 检查：仅 `src/index.ts` 5 处（行 847/875/909/1976 的 noConsole + 行 4841 的 noNonNullAssertion），经 `git show f0520524:server/src/index.ts` 内容命中核验（BASE 行 769/794/812/1696/4541 同内容）为 **BASE 先在存量，零新增** |
| 7 | 活库核对（psql） | 两表 `relrowsecurity=t, relforcerowsecurity=t`；7 条策略逐一读回（lease data SELECT/INSERT、operator SELECT/UPDATE、audit data INSERT、operator SELECT/INSERT；**directory 零策略**）；授权矩阵亲读：lease → data=SELECT,INSERT / operator=SELECT,UPDATE，audit → data=INSERT / operator=SELECT,INSERT，**directory 两表零授权、三角色均无 DELETE、audit 三角色均无 UPDATE**；6 命名 CHECK（purpose/status/window/row_shape/action/detail_shape）+ 4 外键（三条复合内嵌 tenant_id → credentials/memberships/workspaces，全 `confdeltype=c`；audit 仅 tenant 外键）与迁移语句一致 |
| 8 | 冻结面核对 | before-hashes 268 项逐一复算：**264 项零漂移、0 missing**，唯一 4 个 DIFF 恰为授权扩展点（schema barrel / migrate-test.ts / src/index.ts / migration-tool.test.ts），且 8 个文件现值 == after-hashes 终态（模块 `5e03b038…`、schema `f6a6eaec…`、测试 `330d33d3…`、support `1a2f2da1…`；扩展点后像 4 项逐一相符）；扩展点追加区读回核实：barrel 单行、CREDENTIAL_LEASE_TASK 两步 10+17 语句 + TASKS 注册（行 1921）、allowlist 追加 "MT029" + ruling #5 第 19 次裁决注释、credentialLease 装配块（行 1086–1104，fail-closed= null，缺通道不服务流量） |
| 9 | 负向 skip 语义 | 移除全部 7 个 env 后聚焦 = **0 pass / 29 skip / 0 fail**（27 个用例 skip 名称内嵌缺失变量清单与 no-dev-fallback 理由 + 2 个 describe 包装 skip；**skip 不计通过**）✓ |
| 10 | 清理 | `docker rm -f mt029-review-pg` 真实执行（回显容器名；`docker ps -a` 残留 0）；`openbot_enterprise_w14int_mut3` / `_mut12` 两变异库均 `DROP DATABASE` 回显、`pg_database` 残留计数 0；env ×3 / 口令 / 冻结副本 / plan 目录 / 变异脚本全删（ls 确认不存在）；HEAD 仍为 f0520524、`git status` 条目数与开工前一致（80）、两个被变异文件 sha256 逐位复原（`5e03b038…` / `5f8493de…`） |

## 变异抽验 4/4 KILLED（含两个 mandated 真实变异库）

每轮循环完整执行：注入 → 聚焦捕获（亲见 fail 名单）→ 字节复原（sha256 逐位复核）→ 复绿 27/0/227。

| MUT | 注入面 | 复审注入方式 | 聚焦结果 | 杀灭用例（亲见 fail 名单） |
|---|---|---|---|---|
| 1 | decideLease purpose 比对短路（`false &&`） | 模块注入 | 25p/**2f** | AC1「改用途拒绝且零改写」+ AC4「deny 零副作用」——与清单点名完全一致 |
| 8 | useAuthorityHolds personal 分支恒 true（原属主比对变死分支） | 模块注入 | **23p/4f** | AC3 同团队他人 / 双团队成员 / 兼任管理员签发 + 零副作用——数字与名单均与清单一致 |
| **3b** | principal 三层全移（RLS data_read 策略 pin + 读取谓词 pin + decideLease 比对） | **真实变异库** `openbot_enterprise_w14int_mut3`：变异 migrate-test.ts 的 data_read 策略语句 → 新建库 → base migrate + 19 任务链 + **变异 MT029 真实 apply**（工具先以 digest 守门拒绝旧 manifest——完整性设计生效——按提示重新 generate 后应用）→ psql 亲读 `pg_policy` 确认策略仅剩 tenant pin → 模块两层同步移除 → env 切换聚焦 | **26p/1f** | 「another principal cannot ride someone else's lease from the same team」（ride 用例）——全栈不变量被套件真实持有；复原后 `DROP DATABASE` 回显、残留 0 |
| **12** | 迁移注入 `GRANT SELECT ON audit TO ob_ent_directory` | **真实变异库** `openbot_enterprise_w14int_mut12`：同配方真实 apply（psql 亲读 `role_table_grants` 确认 `ob_ent_directory\|SELECT` 已在授权矩阵）→ 模块保持 pristine（hash 亲核） | **26p/1f** | 存储栅栏·授权矩阵（directory blind）——复原后 `DROP DATABASE` 回显、残留 0 |

## 专项核对（brief 六条逐项回应）

- **AC1 用途/作用域固定**：改用途（对 `bot-run` lease validate `connector-call`）与改范围（双团队成员以 team-a2 scope 取 team-a1 签发的 lease）两类**被拒用例均存在且亲测通过**；deny 后原取用仍 allow、行读回 purpose/status 不变（claimed 只比对、永不改写——代码面核实写路径仅 issue 的 input.purpose）；伪造 scope 在判定入口 UNVERIFIED_SCOPE 拒绝；跨公司 deny 与「不存在」逐字节同形。
- **AC2「下一校验点失效，不是立即中断」（票面最细一条）**：实现为**纯 checkpoint 语义**——validate 每次开新事务实时读行（status='active'、expires_at>now() 谓词内嵌）+ decideLease 现读公司/团队成员资格（epoch 匹配）与 MT027 use 权威，**无缓存、无推送中断通道**：撤销落库后已放行的取用不被追溯打断，下一次 validate 立即 deny——与票面逐字吻合。用例亲测：lease 撤销→下一次校验点 deny（幂等 revoked:false/未知 false）；ttl=1 过期→deny 且行仍 active（过期≠撤销，行不改写，取证清晰）；MT027 凭据撤销→在途 lease deny + 新签发 deny；公司停用→deny、恢复后旧 epoch scope deny + 新 scope 放行；团队停用→deny、恢复即放行；无 epoch-bump 停用同样 deny（判定层自读 status）。并发注记：revoke（operator 原子臂）与 validate 无共享 advisory 锁，竞态窗口内可能对即刻被撤销的 lease 放行一次——属 checkpoint 语义的定义内行为（放行是时点授权事实），非缺陷。
- **AC3**：同团队他人、双团队成员、兼任团队管理员（materialized）签发个人凭据一律 canonical deny；跨公司 deny 与「不存在」**逐字节同形**（确定性序列化断言）；属主正控 allow；deny 零 lease 行零审计行（前后计数钉死）；无 use 授权的团队成员签发团队凭据 deny。结构面核实：issue 与 validate 共用 `useAuthorityHolds`——「签发权威 = 取用权威」单份实现，不写两套规则。
- **AC4**：issued/validated/revoked 三事件与操作同事务各恰一行，生命周期顺序 pinned（issued→validated→validated→revoked，逐行逐键断言 detail 闭形）；detail 闭形 DB 层 CHECK 禁秘密载体键（活库亲读）；canary 明文全审计零出现；deny 零审计零副作用（两条 deny 前后计数不变）。**凭据值零回显**成立：模块类型/结构上无 envelope/plaintext 位，validate allow 仅返回授权事实（键集断言钉死七键无秘密位），密封材料唯一出口为 MT027 authorizeUse allow 分支。
- **D2 三层冗余与 MUT-3b 闭环**：三层 = RLS data_read 策略 pin + 读取谓词 pin + decideLease 比对。复审以**真实变异库全栈三层同移**复现证明链闭环：三层同移后 ride 用例必 fail（26p/1f）——套件持有的不变量是全栈级「跨主体取用不可用」，不依赖任何单层；单/双层移除构造上不可观测属纵深防御的预期性质（MT028 D6 同族），实现者披露如实。冗余判定为刻意构造、非冗余代码。
- **D4 deny 不审计口径**：票面「每次签发、使用与撤销留审计」枚举的是三个**生命周期动作**；deny 时该动作未发生（零状态变更），按成功操作口径计审计与「零副作用」纪律自洽——若按「每次尝试」口径反需为 deny 落审计，将与 MT027 disclose 先例（denied 披露既不 open 信封也不写审计）及本票反侦察纪律冲突。复审判定**语义自洽**；并确认安全事件面（enterprise_security_events）确不在本票范围（实现披露如实，属下游 HTTP 接线票语义）。

## Findings

### F1（low，环境契约/未决事项）——库名对齐歧义仍未有协调者裁决，复审沿用选项 A
实现者报告 §0 的 `orca orchestration ask` 升级（msg_9adf8abcfaaf，A/B/C 选项）至本轮 worker_done 仍 pending。复审独立确认：冻结面内 `entry-context.test.ts:191` 硬断言 `openbot_enterprise_w14int`，主库以此命名后全量门（0 fail）完全达成；迁移链与全部业务测试对库名无功能依赖（仅 `openbot_enterprise_*` 形校验，mut3/mut12 两个变异库真实 apply 为名无关性的直接证据）。**建议**：协调者以「集成库名令牌滚动」小票裁决（A=环境随断言更名 / B=改冻结断言 / C=参数化令牌），消除每波次重复建对齐库的隐性成本。本轮复审未改动任何冻结文件。

### F2（low，档案卫生）——mutation/MANIFEST 部分计数摄于 26 用例时点，与终态 27 用例套件相差 1 pass
MUT-1 清单记 24p/2f；复审在终态 27 用例套件下实测 **25p/2f**（GREEN-2 时点 26 用例 → 终态前补 2 个变异驱动用例后 27）。差异全部在 pass 侧，fail 名单与清单点名完全一致，杀灭结论不受影响。MUT-8/3b/12 数字与清单精确一致（23p/4f、26p/1f、26p/1f）。属存档时点注记，非测试或模块缺陷。

### F3（low，证据注记）——全量 expect 计数存在良性的双分支值
实现终态档案记 13033 expects；复审首跑全新 `_assigned` 库实测 **13036**（MT003 real-apply 用例走 applied 分支的 3 条件断言），`_assigned` 应用后复跑得 **13033**。两分支均亲测、均可解释，与 MT028 复审 F4 注记同族（首次全新库的方向相反、机理相同）。非漂移；建议后续票报告注明该分支语义以免误读。

### 流程注记（非本票实现 findings）——前一复审档案的位置与处置
工作树根 `reports/MT029-review.md` 存在前一复审派工（task_16dc21386eb0）的同题报告（未跟踪文件），而本执行计划的复审报告惯例位置为计划目录 `reports/`。本报告已写入计划目录，并同步覆写根位置档案以免双版本歧义；两版复核数字互不矛盾（其 F1/F2/F3 与本复审独立观察一致）。

## 交付物与授权面核对清单

新文件 4：`server/src/db/schema/enterprise-credential-lease.ts`、`server/src/enterprise/tenancy/credential-lease.ts`、`server/tests/multitenancy/credential-lease.test.ts`（27 用例 = AC1 9 + AC2 5 + AC3 6 + AC4 2 + 存储栅栏 5；环境契约经模块级 itDb 探针表达，缺 env 整套显式 skip）、`server/tests/multitenancy/support/credential-lease.ts`。授权扩展 4：schema barrel 追加 1 行（排序位正确）；migrate-test.ts 第二十任务（0001 建表 10 语句 + 0002 RLS/授权 17 语句，与 manifest 一致）；migration-tool.test.ts allowlist 追加 "MT029"（ruling #5 第 19 次沿用，带裁决注释）；src/index.ts credentialLease fail-closed 装配（缺通道 = null，仅供 MT046+ 执行链接线，本装配不服务流量）。8/8 文件 sha256 == after-hashes.txt；before-hashes 其余 264 项零漂移。

## 遗留给 coordinator

1. F1：库名对齐歧义的裁决（建议列入波次 15 收尾或波次 16 前置）。
2. F2/F3：档案计数时点注记是否要求实现方补 MANIFEST/报告说明（均可不改代码）。

复审者未修改任何被审文件（两处变异均逐位复原并哈希复核）、未做任何修复、零 git 提交；复审容器与全部临时凭据已销毁。本报告 + 根目录同步副本为本次复审全部产出。

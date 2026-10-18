# MT073 独立复审报告 — 账务可见性：付款人订单、公司财务授权与团队用量视图（Issue #116）

- 复审者：独立 Reviewer（Pi，Orca Task `task_a79ca8699a34` / Dispatch `ctx_4cddf128473f`，全新会话，未参与实现）。只读被审文件；唯一新建 = 本报告；无 git 提交。
- 日期：2026-10-18。被审树：`r15-mt073`（工作树，BASE `f0520524` + prereq + 本票增量 8，零提交态）。
- 方法：被审文件逐字审读 + checkpoint 证据独立复算 + **独立环境全量复跑**（三步配方从零：容器 `mt073-review-pg` = pgvector/pgvector:pg16 @127.0.0.1:55588 仅回环、随机口令、七变量 env 0600 用后已删）+ **变异重放**（只读例外的唯一写操作，注入→捕获→逐字节还原）。
- **总结论：四条验收（AC1–AC4）全部通过且断言真实钉死；聚焦 16/0/90 与全量 1140/0/44 独立复跑精确达标；变异抽验 4/4（含必含的 M04 锚点修正版）杀伤结果与披露逐字吻合、还原逐位一致；冻结面 8/8 字节一致；一任「死于注入前」双证（哈希+行为）复核成立；三 bug 修正披露与执行版脚本逐项一致。未发现阻塞项；2 条非阻塞观察（§6）。**

---

## 0. 必做四项逐条裁决

### 0.1 三步配方独立复跑（r15c 环境，55588）——通过

| 步 | 内容 | 结果 |
| --- | --- | --- |
| 1 | `bun install`（本树无 node_modules，实测确认缺失后安装） | 1415 packages installed |
| 2 | 容器 `mt073-review-pg`（`-p 127.0.0.1:55588:5432`，随机口令，`docker port` 回显仅回环）+ 三库 psql 逐条 `-c`：`openbot_enterprise_w15e_test`（主库，**令牌按 w15e 环境对齐**——`entry-context.test.ts:192` 断言钉死该库令牌，见 §0.5）/ `openbot_enterprise_r15c_test_assigned`（MT003 专属库）/ `openbot_kb_r15c_test`（KB 属主角色 `ent_r15c_kb` **先于建库**创建） | 三库齐全；七变量 env（TEST + SETUP + DIRECTORY/DATA/OPERATOR 带受控登录 `ent_r15c_{dir,data,opr}` + `options=-c role=ob_ent_*` + MT003_ASSIGNED + KB）写入 `/tmp/mt073-review-env.sh`，`ls -la` 实测 0600 |
| 3 | `enterprise-test-db.ts migrate`（base 迁移 + 运行时登录角色供给）→ **前置十九任务链**逐任务 generate→apply（MT004→MT008→MT112→MT012→MT014→MT010→MT009→MT077→MT026→MT076→MT069→MT016→MT041→MT027→MT028→MT070→MT031→MT042→MT059）→ **MT073 最后** | 全链 20 任务 generate+apply 全部 ok；活库 `mt_task_migration_journal` 亲查 **20 任务全落账**（19 前置 + MT073 1 步；步数 2/2/4/2/2/2/2/2/2/1/1/2/2/2/2/1/2/1/2/1 与实现 journal 存证逐任务一致；MT000 3 步按先例落 assigned 库） |

活库结构抽查：`billing_company_finance_grants` = PK `(tenant_id, principal_id)` + tenant 索引 + **3 条 FK**（tenant → enterprise_tenants；granted_by 与 principal_id 两条**复合 FK → enterprise_memberships**），与 design.md/报告披露逐项一致。

### 0.2 聚焦 + 全量复跑——通过（精确达标）

| 套件 | 票门槛 | 本复审独立复跑 | 判定 |
| --- | --- | --- | --- |
| 聚焦 `billing-visibility.test.ts` | 16 pass / 0 fail / 90 expect | **16 / 0 / 90**，exit 0，0 skip（四组 describe 全部实跑真实 PostgreSQL） | ✅ 精确一致（变异轮后复跑再证 16/0/90） |
| 全量 `tests/multitenancy` | 1140 / 0 / 44 | **1140 pass / 0 fail / 44 文件**，exit 0（12893 expect，见 §6 观察 2） | ✅ |
| typecheck（server `tsc --noEmit`） | 0 | exit 0 | ✅ |
| biome（8 触及文件逐一 check） | 0/0 | Checked 8 files, No fixes applied | ✅ |

### 0.3 变异抽验 ≥3（必含 M04 锚点修正版）——通过（4/4 复现）

本复审**自备重放脚本**（不经执行版脚本，注入前断言 pristine 哈希 = `51c5aa04…`，还原后即时 SHA-256 复验），逐字采用 `run-mutations-2nd.sh` 披露的锚点（含 python 内 `\n` 解码），独立复现：

| 变异 | 披露结果 | 复现结果 | 杀伤用例比对 |
| --- | --- | --- | --- |
| **M01** 判定门移除（`if (false && (!row \|\| !memberActive))`） | 8 pass / 8 fail | **8 / 8** | 失败用例名单与 `M01-evidence.txt` **逐条一致**（4 形状拒绝矩阵、跨公司不继承、撤销幂等、停用闭簿、重复授权、AC3 两口径、AC4 回归）✅ |
| **M02** 活跃成员资格活查移除（`membership !== undefined`） | 13 pass / 3 fail | **13 / 3** | 3 个杀伤者逐条一致（停用闭簿、局外人/停用拒绝、团队用量汇总）✅ |
| **M03** 撤销退化为 no-op（`sql\`false\`` 恒假删行） | 15 pass / 1 fail | **15 / 1** | 「撤销立即终结授权且幂等」✅ |
| **M04**（**brief 必含**：锚点排版修正后的账户侧总额失去客户过滤变体，`where(sql\`true or …\`)`） | 15 pass / 1 fail | **15 / 1** | **「个人 Bifrost 直连消费绝不进公司账簿」（AC3 排除断言）唯一捕获**，与 `M04-evidence.txt` 一致 ✅ |

每次还原后与终局 SHA-256 均为 `51c5aa04…`（与 after-hashes.txt 逐位一致）；还原后聚焦复跑 16/0/90 再证绿态。M04 的多行 biome 排版锚点在真实文件上 **count=1 精确命中**——「锚点排版修正」的有效性由本复审独立注入行为证实。

### 0.4 冻结面核对（after-hashes 8 文件基准）——通过

8 文件（migrate-test.ts / migration-tool.test.ts / schema index / company-finance.ts / **company-finance-visibility.ts** / billing-visibility.test.ts / support/billing-visibility.ts / entry-context.test.ts）当前 SHA-256 与 `after-hashes.txt` **8/8 逐字节一致**；且在**变异重放全部结束后**复测仍 8/8 一致——重放未留任何残留。窄缝三触点在位：migrate-test 注册表 `id: "MT073"`（迁移链第二十任务）、migration-tool 断言数组含 `"MT073"`、schema barrel `export * from "./company-finance"`（1 行追加）。

### 0.5 令牌对齐说明（环境差异披露）

`entry-context.test.ts:192` 断言 `identity.database` **钉死为 `openbot_enterprise_w15e_test`**（本票交付的 w15e 版，一任 w14int→w15e RECTIFIED 微修）。因此复审环境的**主库令牌按 w15e 对齐**（库名 `openbot_enterprise_w15e_test`，承载于复审自有容器/端口 55588），assigned 库与 KB 库使用 r15c 令牌（`openbot_enterprise_r15c_test_assigned` / `openbot_kb_r15c_test`，两者无任何测试钉死库名，实测全绿）。双哈希存证复核：`05-token-fix-before-hash.txt` = `d7e4d400…`（w14int 版）→ after = `3572597c…`（= 当前树与 after-hashes 条目一致），微修范围仅为断言字面令牌、语义不变——与本复审行为证据吻合（该用例在 w15e 令牌库上 pass）。

---

## 1. 专项逐条裁决（验收 → 测试证据独立审读）

### AC1 普通成员看不到他人订单/支付资料（共用公司余额也不行）——通过

3 用例全在真实 PaymentStore 创建人过滤面上（`describe "MT073 AC1: sharing a company balance does not open colleagues' orders"`）：mate 自读得 2 单（正向回归）；他人 `readOrder → null`（**支付资料 `checkoutPayload` 随单不可达**，断言只回显创建者自己的 payload）；list/count 互不相交（reader 1 单、count=1；mate count=2）；`readLatestLiveOrder` 隔离（mate 的在途单对 reader 不可见，reader 自身 live=null）。夹具以 setup/owner 通道真实种单（含部署级 pending 单槽约束下的 live 单）。「共用余额」前提由夹具本身成立（同公司映射同一计费 Customer/余额），可见性仍按创建人隔离。

### AC2 财务管理授权主体可见性 + 无授权不可见（授权矩阵用例）——通过

8 用例构成完整授权矩阵：**显式授权→可读**（books 五要素断言：tenant/customer/account/balance/authorization trail）；**拒绝矩阵**——无授权成员 / 无授权 tenant_admin / 非成员 / 未知公司四形状 `Promise.allSettled` 并发后断言**同一哨兵同一句子**（`new Set(messages).size === 1`，不泄露存在性）；**授权是公司事实**（同主体在 B 公司不继承 A 授权）；**撤销立即失效且幂等**（`{revoked:true}`→拒→`{revoked:false}`→重授权 trail 记新 grantedBy）；**停用闭簿**（授权行完好、成员资格 suspended 即拒）；**重复授权显式拒绝**（FINANCE_GRANT_EXISTS，原行 grantedBy/createdAt 不被静默刷新）；**grantee/grantor 双侧资格预检**（局外人、停用成员 FINANCE_GRANT_INVALID）；**受限角色反证**（4×ob_ent_* + public × 4 特权 = 20 项 `has_table_privilege` 全 false）。M01/M02/M03/M05/M06/M07 六变异从反面钉死该矩阵（其中 M01 杀伤 8 用例为最重打击面）。

### AC3 团队用量汇总=公司总额一致性（**不含个人直连消费**排除断言）——通过

- **一致性**：两笔公司预扣（250 held / 300 held）+ 一笔按 150 结算后，`byTeam` 两行逐字段 `toEqual`（甲队 charged 150/held 0，乙队 held 300/charged 0），`companyTotal = {held:300, charged:150}`；**byTeam 求和与 byUser 求和各自 `toEqual(companyTotal)`**——且 `companyTotal` 是**账户侧独立口径**（credit_reservations WHERE 公司映射客户，不经归属行），两口径一致即「归属覆盖」不变量的真实对账，非同源重复计算。
- **排除断言**：「personal Bifrost direct spend never enters the company books」——个人账户 grant + 999 预扣（ADR 0002/0003 路径，无公司归属行）后，公司账簿 `companyTotal`/`byTeam`/`byUser`/`balanceUnits` **四项与事前逐项相等**，账簿客户仍是公司映射；同时反证个人余额确实动了（`50_000-999`）——预扣真实发生而绝不进公司账簿。**M04 正是打这条断言**（本复审复现捕获）。
- 无映射公司（C）→ 诚实空账簿（customer/account null、余额 0、三级用量全空）。

### AC4 旧创建人限制未被放宽（回归用例存在性）——通过

2 用例存在且语义正确：① **财务授权存在且生效**（显式核对 `financeReadersOf` 含 reader）后，grantee 仍只见自己订单（mate 两单含在途单逐单 `readOrder → null`）；② **store 面无全公司读**：连 tenant_admin 的 scope 也按创建人过滤（adminList 仅自己 1 单、mate 订单对 admin 逐单 null）——C3「旧 created_by 限制不被共用余额或管理角色替换」正反两面均钉死。实现面核对：`payments/store` 零修改（不在 8 文件交付面），财务授权类型上不产订单 scope。

---

## 2. 三 bug 修正披露与执行版脚本一致性——通过

逐字比对计划版 `run-mutations.sh` 与执行版 `run-mutations-2nd.sh` + 独立实证：

| # | 报告披露的 bug | 独立核实 |
| --- | --- | --- |
| 1 | `cd …/../../../../../server` 少一层（计划版 5 层，需 6 层） | **实证**：自 mutation/ 上溯 5 层 = `docs/`，`docs/server` 不存在 → 计划版脚本必然 `exit 1`，从未跑通的说法成立；执行版 6 层正确 |
| 2 | M03/M04 多行锚点以字面 `\n` 写在 bash 双引号里 → python `count` 按原样比较 → ANCHOR-FAIL | 计划版锚点确含字面 `\n` 且 python 侧无解码；执行版 python 内 `replace("\\n","\n")` 解码，本复审重放即用该解码路径，锚点精确命中 |
| 3 | M04 锚点假设 `eq(…)` 单行排版，真实文件为 biome 三行排版 → count=0 | 计划版锚点确为单行假设；执行版对齐真实三行字节序列，语义不变（WHERE 恒真）。**本复审以修正后锚点独立注入成功并捕获**（§0.3 M04 行） |

执行版相对计划版的**增强**也与脚本实况一致：每变异独立 `M0x-evidence.txt`（注入 diff + 聚焦输出 + 失败用例名）、每次还原后即时 SHA-256 校验（计划版仅末位一次）、注入前 pristine 哈希前置断言。`results.txt` 头部披露与脚本头注释同文。

## 3. 首步自证双证复核（一任「死于注入前」结论）——成立

1. **哈希证**：`after-hashes.txt` 8 文件与接管时、本复审接管时、本复审变异重放后**三次**比对全部逐字节一致——若一任曾注入而死于还原前，`company-finance-visibility.ts` 哈希不可能仍等于 pristine `51c5aa04…`。
2. **行为证**：`mutation/00-selfcheck-focused-green.txt` = 16 pass / 0 fail / 90 expect，与本复审**从零全新环境**的聚焦复跑 16/0/90 逐字一致——工作树无活体变异的行为佐证。
3. 佐证链自洽：`verification/06`（接管全量 1140/0/44）→ `07/08`（变异后聚焦/全量）→ `11`（RESTORE 终证 8/8 ALL-BYTE-IDENTICAL）与本复审独立复跑值全部吻合。

## 4. 证据文件完整性与数字复算

- `mutation/results.txt`（2026-10-18 11:42:58）：7/7 捕获，计数 8/3/1/1/1/1/1 fail 与各 `M0x-evidence.txt` 逐条一致，末行 RESTORE-VERIFIED（pristine 哈希在位）。
- `verification/00–11`：基线 1124/0/43（12799 expect）→ 全量 1140/0/44（12890 expect，06/08 两次）→ typecheck/biome/哈希终证，全部实测在案；一任证据（red-green、narrow-edits.diff、04-prereq-chain-journal 20 任务）与本复审活库 journal 亲查吻合。
- 交付面=8 文件（4 新：finance-visibility / schema company-finance / billing-visibility.test / support；4 触及：migrate-test 注册、migration-tool 断言、schema barrel 1 行、entry-context 令牌微修）——与 brief「增量 8」精确一致，无未披露文件进入哈希面。

## 5. 清理核验

复审容器 `docker rm -f mt073-review-pg` 真实执行（回显容器名）；随后 `docker ps -a | grep -c mt073-review` = **0**；`/tmp/mt073-review-{env.sh,pgpw.txt,mutations.sh,pristine.ts}`、`/tmp/mt073-review-gen/`、chain 日志全部删除，`ls` 复验均 No such file。实现票机器面（env 已删、`mt073-impl-pg` 已 rm）不在本票清理范围且本复审未复用。

## 6. 观察项（全部非阻塞）

1. **【环境命名】主库令牌与 brief 字面 `openbot_enterprise_r15c_*` 的张力**：brief 要求库名 r15c + 「令牌按 w15e 环境对齐」；因 `entry-context.test.ts:192` 钉死 `openbot_enterprise_w15e_test`，两者不可兼得。本复审取「钉死处 w15e、其余 r15c」（§0.5）并以全绿复跑证实为唯一可行解。建议 coordinator 在后续票的 review brief 中把该豁免写成显式规则（「主库令牌跟随 entry-context 断言」），避免下任复审者自行仲裁。
2. **【计数口径】全量 expect() 复跑值 12893 vs 实现存证 12890（Δ+3）**：pass/fail/文件数（1140/0/44）两轮精确一致；expect() 为运行时计数，存在数据相关分支的合法浮动，非门槛项。记录在此仅供后续比对基线。
3. 授权管理（谁可 grant/revoke）的 HTTP 接线仍未接线（实现报告诚实披露的下游票边界）——本票验收四条均不触及，不算缺口。

## 7. 判定汇总

| 项 | 判定 |
| --- | --- |
| 必做 1 三步配方（r15c/55588/令牌对齐） | ✅（§0.1/§0.5） |
| 必做 2 聚焦 16/0/90 + 全量 1140/0/44 | ✅ 精确达标（§0.2） |
| 必做 3 变异抽验 ≥3 含 M04 修正版 | ✅ 4/4 复现、还原逐位一致（§0.3） |
| 必做 4 冻结面 8 文件基准 | ✅ 三次比对一致（§0.4） |
| 专项 AC1 / AC2 / AC3 / AC4 | ✅✅✅✅（§1） |
| 三 bug 修正披露一致性 | ✅（§2） |
| 首步自证双证 | ✅ 成立（§3） |
| 阻塞发现 | **无** |

**复审结论：MT073 实现通过独立复审，可进入集成。**

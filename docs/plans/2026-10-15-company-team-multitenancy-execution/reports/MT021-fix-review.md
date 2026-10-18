# MT021 修复轮独立复审报告（F1 high / F2 / F3 修复正确性验证）

复审者：独立 Pi 会话（coordinator 下发 brief：`briefs/MT021-fix-review-brief.md`；未参与实现与修复轮）。
复审树：`i12-review-mt021`（BASE `f0520524` + 213 项前置 + MT021 交付 + 修复轮终态）。授权边界：只读被审文件；唯一新建 = 本报告；未修复、未提交/推送/合并。

## 结论

**PASS with findings** —— F1（high）/ F2 / F3 三项修复全部独立验证关闭：门槛全部在本复审专用环境亲测复跑通过（聚焦 **29 pass / 0 fail / 0 skip（143 expect）**、全量 **799 pass / 0 fail / 30 文件 / 10801 expect**、typecheck exit 0、触及 3 文件 biome 0 错误、MUT3 重放 **恰 6 fail / 23 pass** 且还原哈希 == pristine == 交付终态后复绿 29/0/0）。全树范围纪律实证成立（代码树自前任复审终态以来仅 3 交付文件变化；10 冻结只读面 13 项哈希逐一复验零漂移）。

新发现 **2 项 low（均在游标鲁棒性面，无当前暴露）**，不影响修复轮三项关闭的裁决；建议随路由接线票处理（见 §5）。

## 1. 复审环境（全部亲测，不采信存档）

1. 端口预检：55542 空闲（lsof 无监听）→ 专用容器 **`mt021-fixrv-pg`**（pgvector/pgvector:pg16，仅绑 127.0.0.1，一次性随机口令）。**容器占用 +1 披露**：复审期间本机多运行一个 PG 容器，测毕 `docker rm -f` 真实执行（§6）。
2. 三库：`openbot_enterprise_mt021_fixrv_test` + `openbot_enterprise_mt021_fixrv_assigned`（migration-tool 真实 apply 通道）+ `openbot_kb_mt021_fixrv`（第 7 变量，属主为受限登录 `ent_fixrv_kb`）。
3. 七变量 env 单文件 **0600**（/tmp，用后删）：`TEST_DATABASE_URL`、`MT003_ASSIGNED_TEST_DATABASE_URL`、`ENTERPRISE_TEST_SETUP_DATABASE_URL`（postgres 超户）、`ENTERPRISE_TEST_{DIRECTORY,DATA,OPERATOR}_DATABASE_URL`（`ent_fixrv_{dir,data,opr}` 经 `enterprise-test-db.ts migrate` 守卫 provision；pg_roles 实查 4 登录角色均非 super/bypassrls，`ob_ent_{data,directory,identity_operator,operator}` 4 能力角色均 NOLOGIN）。
4. `bun --no-env-file scripts/enterprise-test-db.ts migrate` → `{"type":"migrations-applied","status":"ok"}`。
5. 十四任务链逐任务 generate --out + `migrate --apply --manifest`：MT004→MT008→MT112→MT012→MT014→MT010→MT009→MT077→MT026→MT076→MT069→MT016→MT041→MT027 **全部 applied**；`mt_task_migration_journal` 实查 **14 任务 28 步**（MT112=4、MT069/MT076=1、其余各 2），与修复轮附记声明逐项一致。本票仍无迁移任务。

## 2. 门槛复跑（本复审独立环境实测）

| 门槛 | 复审实测 | 与修复轮声明 |
|---|---|---|
| 聚焦 | `bun --no-env-file test tests/multitenancy/conversations-list.test.ts --timeout 60000` → **29 pass / 0 fail / 0 skip（143 expect）** | 一致（29/0/0、143 expect） |
| 全量 | `bun --no-env-file test tests/multitenancy/ --timeout 60000` → **799 pass / 0 fail / 30 文件（10801 expect）** | 一致（799/0/30）＝实现轮 796 + 3 新用例 |
| typecheck | `bun run typecheck`（tsc --noEmit）→ **exit 0** | 一致 |
| biome | 触及 3 交付文件 `bunx biome check` → **Checked 3 files, 0 错误** | 一致 |
| MUT3 重放 | `at: rows[limit-1]…` → `rows[limit]…` 注入后聚焦 **恰 6 fail / 23 pass（131 expect）**；还原后 sha256 == `a7d5820b…` == pristine == 交付终态，聚焦复绿 **29/0/0（143 expect）** | 一致（实现轮 4 → 修复轮 6，两条 F1 新用例均被捕获） |

MUT3 捕获面逐例与存档 `checkpoints/MT021-fix/mutation/MUT3-replay.txt` 一致：验收 1 页并集、验收 4 三例（交错全链/中途改名/中途删除）、修复轮 F1 两例（微秒全链 + at 微秒精度）。**游标键源改为 SQL 文本后防线不弱化、反而增强，成立。**

## 3. 审计重点逐项裁决

### 重点 1：F1 修复面读码 —— **成立**

- **代码事实**（交付终态 `a7d5820b…`）：`listVisibleConversations` 的 select 增加计算列 `createdAtText = sql\`${createdAt}::text\`.as("created_at_text")`；游标 `at` 存 `rows[limit-1].createdAtText`（PG 文本形态）；下一页谓词保持 `(created_at, id) > (at::timestamptz, id)` 不变。模块头键纪律描述同步更新。
- **与 MT016 `bots-ownership.ts` 逐行同形**：同款计算列（`sql\`…::text\`.as("created_at_text")`）、同款谓词形状（`(createdAt, agentId) > (${cursor.at}::timestamptz, ${cursor.id})`）、同款边界取值（`row.createdAtText`）。F2 方向 MT021 反而**强于**先例：MT016 `decodeCursor` 无时间戳形状校验，MT021 新增 `CURSOR_TIMESTAMP_PATTERN`。
- **微秒无损机理（本复审容器 psql 实测）**：
  - `now()::text` → `2026-10-17 01:08:42.79788+00`（生产写路径 defaultNow() 形态确实带微秒）；
  - `'2026-01-01 00:20:00.123456+00'::timestamptz::text` → 逐字返回（**PG 文本→timestamptz 往返无损**）；
  - `('…00:20:00.123456+00','x') > ('…00:20:00.123456+00','x')` = **false**——全精度 `at` 下边界行自身不重入（修复核心机理）；
  - 对照组：`('…00:20:00.123456+00','x') > ('…00:20:00.123000+00','x')` = **true**——毫秒截断形态确实重入（即修复前 F1 的触发条件）；
  - `SHOW DateStyle` = `ISO, MDY`——`timestamptz::text` 产生空格分隔 + 数字时区偏移形态，为 `CURSOR_TIMESTAMP_PATTERN` 覆盖的主形态。

### 重点 2：F1 四步实证独立重放 —— **成立**

- 前任复审的四步实证在**本复审自己的容器与种子**上以两种方式重放：
  1. **套件内**：修复轮新增 F1 describe（夹具新增 `createdAtText` 显式 `::timestamptz` 字面量种子通道，`.123456/.123999/.654321` 微秒行 + 同键微秒隐藏行）在本复审环境 **2 用例全绿**——limit=1 全页链收敛（页并集==精确可见序列、无重复、末页 null、守卫有余量）+ 钉在微秒边界行的游标 `at` 必含 `.123456` 且能真实续读收敛。RED 存档（`red-green/RED-1.txt`）完整保留修复前失败形态：页链每页重复 m1 直至耗尽守卫、`at` 为 `…123Z` 毫秒截断——与本复审机理推演一致。
  2. **服务外探针**（/tmp 脚本，用后删）：经真实 fixture + 真实服务注入微秒行后，页链 early→micro 两页收敛、`nextCursor=null` 结束、边界行无重复；用交付自发 PG 文本游标续读 0 行且边界行不重入。
- 补充通道真实性核验：夹具 `seedConversation` 的微秒通道经受限 data 角色 `::timestamptz` 字面量注入（非 superuser 旁路），与 D2 披露一致。

### 重点 3：F2 —— **成立（附 1 项 low 残余，见 §5-L1）**

- **brief 点名用例**：`{"v":1,"at":"garbage","id":<uuid>}` → 本复审环境实测拒绝体为 `CONVERSATIONS_CURSOR_INVALID`（聚焦套件新用例 + /tmp 探针双路实测一致），不再出现裸驱动错误。RED 存档完整保留修复前失败形态（`Failed query: …` 与前任复审 F2 描述逐字一致）。
- **合法两形态放行**：PG 文本形态（`2026-01-01 00:20:00.123456+00`）实测通过 decode 并正确续读；ISO-8601 形态（`2026-01-01T00:20:00.123Z`）实测放行（其边界语义见 §5-L2）。
- **正则面独立穷举**：8 个应接受形态（PG 文本 ±小数位/±偏移格式 `+00`、`+05:30`、`+0530`、`+05`；ISO `Z`/偏移）全部 ACCEPT，10 个应拒绝形态（garbage/纯日期/纯时间/缺秒/单位数月日/7 位小数/`UTC` 后缀/空格偏移/空白）全部 reject——接受面与模块头声明精确一致。

### 重点 4：F3 —— **成立**

- 证据链闭合：`checkpoints/MT021-fix/mutation/pristine-sha256.txt` = `a7d5820b…`；本复审 MUT3 重放还原后实测 sha256 = `a7d5820b…`；交付树实测 = `a7d5820b…`——**pristine == 还原后实测 == 交付终态**三点一位。实现轮的 pre-biome pristine（`5b6ed95f…`）已被取代且原文件按披露保留。前任复审 F3 关闭。

### 重点 5：门槛复跑 —— **全部通过**（见 §2）

### 重点 6：范围纪律 —— **成立**

- **哈希链**：3 交付文件现值 == `checkpoints/MT021-fix/after-hashes.txt`（`a7d5820b…`/`64c0688c…`/`a490a04f…`）；fix-round `before-hashes` 前 3 项 == 实现轮 `sha256-manifest`/`review-package.json` 的复审终态（`38fb0267…`/`5a89bbb2…`/`a028f792…`）——**修复轮起点 == 前任复审终态**成立。
- **10 冻结只读面**：not-found-semantics、enterprise-conversations schema、store、connections、scope-gate、contracts、scenarios、migrate-test、migration-tool.test、schema barrel——现值与 fix-round `sha256-manifest.txt` 逐项一致，且与实现轮 `after-hashes.txt` 逐项相同——**零漂移复验成立**。
- **全树扫描**：对 server/src、server/tests、app/src、shared、scripts 及全树（排除 node_modules/.git/checkpoints）做 mtime > 复审终态（07:30）扫描，代码文件命中**恰为 3 交付文件**；docs 侧仅 MT021.md 附记追加与两份修复轮 brief（coordinator 产物）。fix.diff（257 行）内容与本复审读码逐行吻合，无 diff 之外的改动。

### 重点 7：容器 / env 卫生 —— **成立**（见 §6 实录）

## 4. 修复轮声明与实测差异核对

| 修复轮声明 | 本复审实测 | 差异 |
|---|---|---|
| 聚焦 29/0/0（143 expect） | 29/0/0（143 expect） | 无 |
| 全量 799/0/30（10801 expect） | 799/0/30（10801 expect） | 无 |
| typecheck exit 0 | exit 0 | 无 |
| biome 触及 3 文件 0 错误 | 0 错误 | 无 |
| MUT3 注入后 6 fail / 23 pass | 6 fail / 23 pass | 无 |
| 还原哈希 == pristine == 交付终态 | 三点一致（`a7d5820b…`） | 无 |
| journal 14 任务 28 步 | 14 任务 28 步 | 无 |
| 范围：仅 3 交付文件变化 | mtime + 哈希双路证实 | 无 |

**无虚报。**

## 5. 发现（按严重级）

### L1（low）`at` 形状合法但数值越界的时间戳仍可逃出既定拒绝码

`CURSOR_TIMESTAMP_PATTERN` 是形状校验，不校验数值范围：`{"v":1,"at":"9999-99-99 99:99:99+00","id":<uuid>}` 通过 decode（正则 ACCEPT）后在 SQL `::timestamptz` 处抛裸驱动错误（`Failed query: …`，本复审容器实测），而非 `CONVERSATIONS_CURSOR_INVALID`。这是对前任复审 F2 的**收窄而非全域消除**：任意非时间戳字符串类（原 F2 用例）已全部在 decode 层拦截，残余暴露面只剩「形似时间戳但数值非法」的手工伪造令牌。缓解事实不变：服务只消费自发令牌（全精度 PG 文本，恒合法）、未接路由（D5d）无暴露面；且同失败类在 MT016 `bots-ownership.ts` 完整存在（该先例连形状校验都没有），本修复已严格强于先例。**建议**：路由接线票若要补齐，可在 decode 追加一次 `new Date(at)` 有限值校验（ISO 形态）或按 fix-brief 备选方案把 PG 22007 归一为既定拒绝码；不阻塞本修复轮关闭。

### L2（low）ISO 形态放行 + 毫秒截断组合可复活边界重入（客户端伪造面）

`CURSOR_TIMESTAMP_PATTERN` 放行 ISO-8601（含毫秒截断形态 `…T00:20:00.123Z`）。本复审探针实测：把该形态钉在微秒边界行 id 上构造游标，下一页谓词 `(.123456) > (.123000)` = true，**边界行重新入页（重复可见项）**——即 F1 的机理可经「手工构造的毫秒截断 ISO 游标」复活。修复轮披露「两形态均安全」的措辞偏乐观：安全的前提是**游标只使用服务自发令牌**（全精度 PG 文本）。真实风险在下游接线票：视图 `createdAt` 恰是 ISO 毫秒字符串，若前端自行从视图字段拼装游标（而非透传 `nextCursor`）将精确复现 F1。**建议**：接线票把 `nextCursor` 作为唯一合法游标来源（opaque 契约已在模块头声明，落为路由层纪律即可）；或本服务收窄为只接受自发 PG 文本形态。不阻塞本修复轮关闭。

### 非 P0 备注

- `checkpoints/MT021-fix/PLAN.md` 末两项清单框未勾选（docker rm 回显存档、报告附记），但对应证据均已存在（`verification/07-container-teardown.txt`、MT021.md 附记）——属勾选遗漏，非证据缺失。
- 修复轮 RED/GREEN/MUT3 存档的执行路径为 `i12-mt021` 工作树（修复轮实施树），交付经 coordinator 核对落至本复审树（哈希三点核对成立），符合 brief 交付描述。

## 6. 清理核验（真实执行并回显）

```
2026-10-17T01:12:24Z
$ docker rm -f mt021-fixrv-pg
mt021-fixrv-pg
deletion check: docker ps -a | grep mt021-fixrv → exit 1（无残留容器）
lsof -i :55542 -sTCP:LISTEN → exit 1（无监听）
```

- env 文件（0600）、口令文件、3 个探针脚本、迁移临时目录、pristine 副本全部删除，`ls /tmp/fixrv* /tmp/mt021-fixrv*` 逐项确认不存在。
- 被审树零残留：清理后 3 交付文件哈希复验 == `a7d5820b…`/`64c0688c…`/`a490a04f…`；仓库内唯一新建 = 本报告。

## 7. 裁决汇总

| 项 | 裁决 |
|---|---|
| F1（high）游标微秒精度 | **已关闭**——SQL 侧 `::text` 键源 + 全精度 at + 原谓词；psql 实证无损往返与边界不重入；微秒种子端到端翻页收敛/不跳不重/at 含微秒，全部本环境独立复现 |
| F2（low）at 非时间戳游标 | **已关闭**（附 L1 残余收窄项）——garbage 类在 decode 层受控拒绝；合法两形态放行 |
| F3（low）pristine 哈希证据卫生 | **已关闭**——pristine == 还原实测 == 交付终态三点一位（本复审重放独立闭合） |
| 门槛（聚焦/全量/typecheck/biome/MUT3/迁移链/范围/清理） | 全部亲测通过；修复轮声明数字逐项与实测一致，无虚报 |
| 先例同形（MT016） | 计算列/谓词/边界取值逐行同形；F2 形状校验强于先例 |

**总体：PASS with findings（F1/F2/F3 全部关闭；2 项 low 残余均属游标鲁棒性面、无当前暴露，建议随路由接线票处理）。修复轮交付终态（`a7d5820b…`/`64c0688c…`/`a490a04f…`）可被下游接线票安全消费——接线票须遵守 §5-L2 的 opaque 游标纪律。**

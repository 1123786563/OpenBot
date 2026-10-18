# MT015 / Issue #58 独立复审报告 —— 归属感知缓存键 + 配置版本

- 复审者：独立 Pi 会话（Orca Task `task_1df929c3cbf6` / Dispatch `ctx_7060921ae58f`）。只读被审文件；唯一新建文件为本报告；不修复；无提交/推送/合并。
- 日期：2026-10-17。被审对象：本树 MT015 三项新交付（`server/src/enterprise/tenancy/scoped-keys.ts`、`server/tests/multitenancy/cache-keys.test.ts`、`server/tests/multitenancy/support/cache-keys.ts`）+ `checkpoints/MT015/` 证据链 + `reports/MT015.md`。
- 方法：先逐字审阅三交付源码与 checkpoint 全部存档，再在**自建专用环境**（容器 `mt015-review-pg` @ 127.0.0.1:**55496**，pgvector/pgvector:pg16 trust，PostgreSQL 16.15 aarch64；五变量 + `MT003_ASSIGNED_TEST_DATABASE_URL`，`ent_mt015rev_{dir,data,opr}` 随机口令 0600 文件、用后即删）独立复跑全部验证。**所有哈希、计数、退出码均为复审者亲手重算/重跑**，非转抄实现者存档。
- 结论速览：**四项裁决 A–D 中 A/B/C 通过；D 发现 1 项证据缺口（MUT5，非 Blocker）**。聚焦实测 **30 pass / 0 fail / 0 skip（117 expect）**，全量实测 **488 pass / 0 fail / 0 skip（17 文件，9186 expect）**，typecheck / biome 全绿。prereq 零改动声明 **49/49 独立复算成立**。环境自备注：首次聚焦跑因本工作树 `node_modules` 缺失失败（`Cannot find package 'eventsource'`），`bun install` 后重跑，与被审代码无关。

---

## 1. 四项裁决

### 裁决 A — Issue #58 四条验收：**通过**

- **① 同一逻辑键跨公司/团队互不命中**：纯面 6 用例（A/A1、A/A2、B/B1 三作用域 × 四种键 pairwise `Set.size===3`；keyed-cache `put(A1)`→`get/has` 跨范围全 miss；对象前缀 `startsWith` 分区；事件通道同名不撞；确定性逐字节；kind 分离 + 共享键 5 串互异）。**DB 面真实性核实**：4 例经 MT014 既有夹具（零改动 prereq，哈希在案）——真实 `provisionDeployment` 布点、真实 `createRuntimeConfigService` 解析；`connections.ts` 的 `verifyDataDatabase`/`verifyOperatorDatabase` 校验 `current_user` **恰为** `ob_ent_data`/`ob_ent_operator` 能力角色（NOLOGIN 登录 + 单一成员资格守卫）；写路径（`writeCompanyConfig`/`writeTeamOverride`）走受限 operator 通道 + 事务本地 `app.tenant_id`/`app.workspace_id`；套件收尾用例断言**每一条**受限调用 `current_user` 以 `ob_ent_` 开头（复审复跑中该用例 pass，无 skip）。postgres 超管仅用于 base migrate，不在套件路径上。
- **② 配置版本变化后旧条目不再使用**：版本进键为公司 revision + 团队覆盖 revision 双面（`readablePrefix` 的 `c=/o=` 段 + 向量命名空间摘要输入）；revision 3→4、覆盖 null→2→3 全 kind 键变；旧 revision 条目「只在自己旧地址、现版本查找永不可达」语义由测试注释钉死。DB 面真实 upsert bump：A 公司 revision 3→4 → A 键变、B 公司键**逐字节稳定**、bump 前条目 bump 后不可达；团队覆盖写入只动 A1 键（A2/B1 稳定）。MUT2（版本冻结 `c=0/o=-`）存档 8 fail 与声称一致（见裁决 D）。
- **③ 键无明文凭据/可反推秘密**：canary（`sk-…` 与 PEM 头）测试**真实性核实**——同一 canary 走两个方向：作为合法逻辑键入摘要后断言四种键均不含明文（正向），作为非法输入成分（tenant 含斜杠、域大写/含斜杠、4097 越界逻辑键、`Pool_<canary>`）断言拒绝消息不含 canary（负向）；实现侧 `requireSelector`/`requireDomain` 等只拼代码 + 规则文本（代码审阅与测试双向印证），无任何值回显路径。摘要固定 40 hex 截断（`digestOf`，`JSON.stringify([logical])` 对字符串单射——JSON 转义保证）；整键形状由测试正则钉死为「归属原样寻址 + 版本 + 域 + 40hex，此外什么都没有」；源码级断言 + 环境污染不变性双证「零环境读取」（复审者 grep `process.env|Bun.env|import.meta.env` 于 `scoped-keys.ts` = 0）。
- **④ 共享基础设施不被误加归属**：`sharedInfrastructureKey(domain)` 单参数函数——**类型上就不接受归属**；`shared/v1/connection-pool` 精确断言 + 无 `/t= /w= /c= /o=` 段；三域互异且确定；与同域四种作用域键永不碰撞；域标签与作用域同码拒绝（`SCOPED_KEY_INVALID_DOMAIN`）。实现侧零改动全局复用面（index.ts/config.ts 等 49 项 prereq 哈希一致，见裁决 C）。

### 裁决 B — 键构造语义：**通过（附 2 条非阻塞观察）**

- **tenant/workspace null/缺省形态**：无默认、无静默归一化——`null`/`undefined`/空白/坏形一律响亮拒绝（`TENANT_REQUIRED`/`WORKSPACE_REQUIRED` 与 MT005/MT014 同码；`SCOPED_KEY_INVALID_TENANT_ID` 等 10 种坏形测试在案：斜杠、`.`/`..`、控制字符、空格、等号、129 长度、非 ASCII、前后导空白）。这是「键对身份单射」的正确取向：归一化等于折叠身份。
- **版本 0/负数/非整数**：`isPositiveInteger` 拒绝 `0/-1/2.5/NaN/"3"` 与坏 override（`0/-1/1.5`），`null` override 合法有正例；适配器入口与直构入口同校验（测试在案）。
- **摘要截断与碰撞面声明**：SHA-256 截 40 hex（160 bit）在模块头注与测试双侧钉死；kind 前缀互异（`scoped-cache/event-channel/object-prefix/vn-`）+ 共享键形不相交 → 跨 kind 无碰撞；readable 段语法互斥（ID 无 `/`/`=`、域 kebab、版本数字）→ 键结构无解析歧义、对身份单射。
- **观察 O1（非阻塞，理论边角）**：`isPositiveInteger` 接受 ≥2^53 的整数，而 `readablePrefix` 用 `String()` 渲染——极端值（如 `1e21`）会产出科学计数法形态 `c=1e+21`（含 `+`），偏离测试声明语法 `[1-9][0-9]*`。单射性不受影响（`String()` 对不同数值单射）；现实 revision 来自 DB integer 列（≤2^31-1）且 MT014 上游透传，实际不可达。可留待 v2 用 `Number.isSafeInteger` 收紧，不构成本票缺陷。
- **观察 O2（非阻塞，备忘）**：向量命名空间摘要输入以常量标签 `"vector-namespace/v1"` 承担 kind 分层——与读形键的 kind 前缀等效防碰撞，MUT4（去归属）3 fail 存档印证。无缺陷，仅记录该等效性依据。

### 裁决 C — prereq 零改动声明独立核验 + D1–D8 披露处置：**通过**

- **49/49 亲手复算（本树）**：`tail -n +2 prereq-manifest.txt | shasum -a 256 -c -` → **49 OK / 0 drift**（含 `runtime-config.ts`、`index.ts`、`config.ts` 等全部既有面）。
- **快照同源性**：`before-hashes.txt`（去 BASE 行）与执行级 `checkpoints/prereq-manifest.txt` **逐字节一致**（diff 为空）——实现者开工快照与本复审树同源。
- **git HEAD 关系澄清（非漂移）**：HEAD = `f0520524` = manifest BASE 行，但 49 文件的 HEAD blob 哈希与 manifest 不同——因为**整个 EXE 执行（前序各票）均未提交**，manifest 记录的是 MT015 开工时工作树快照而非 git HEAD。`git status` 的 8 个 tracked 修改文件（app.ts/config.ts/schema×2/runs×2/store.ts/index.ts）恰为 `changes.diff` 注释列出的 EXE 前序状态；49/49 复算证明 MT015 未在其上叠加任何改动。声明按其口径（相对开工快照）**成立**。
- **产物链自洽**：当前 `scoped-keys.ts` SHA-256 = `7a0867cb…` = `pristine-sha256.txt`（五次变异均已还原）；三交付哈希与 `sha256-manifest.txt` 逐项一致；`sha256-manifest.txt` 自校验（除 BASE 元数据行）全 OK；`changes.diff` 注释与 git status 实测吻合。
- **D1–D8 处置**：D1（不装配 index.ts）与复审 brief「本树 = EXE 49 前置 + 本票 3 新交付」的授权范围一致，键 seam 冻结留待业务票装配——接受（现键模块生产侧零调用方，属披露过的范围决策而非遗漏）；D2（改名对齐 #58 验证命令）文件名实测吻合；**D3（fresh-DB 首跑 19 个迁移竞态一次性失败）**：复审者自建 fresh 库**首跑**全量即 488/0/0 全绿，证明该竞态为间歇性，与「一次性现象 + 复跑全绿」的口径相容，基线取绿跑成立；D4/D5 与 mutation/RED-GREEN 存档互证（D5 详见裁决 D 的 MUT5 缺口）；D6（共享键无部署纪元）属声明过的 v2 扩展位；D7（摘要不可反查运维取舍）已在头注钉死；D8（keyed-cache 仅测试脚手架）属实——`support/cache-keys.ts` 无生产导入方。

### 裁决 D — TDD 链与变异：**1 项证据缺口（非 Blocker，需补证或改口径）**

- **RED-1** ✓：`Cannot find module '../../src/enterprise/tenancy/scoped-keys'`，exit 1——功能缺失型 RED，非笔误。
- **GREEN-1 诚实性** ✓：28 pass / 2 fail；两处测试侧缺陷描述与当前测试文件逐处吻合——`slice(-DIGEST.length)`（模式串长 12）已改为字面量 `slice(-40)`；「canary 单独作 tenant 是合法 ID、正确地不抛错」已移出拒绝组（现拒绝组用 `tenant/${CANARY}` 带斜杠的**真**坏形）。实现侧零改动声明无法回溯验证，但与 GREEN-2 30/0 及 pristine 链自洽。
- **变异计数核对（存档日志逐份亲读）**：MUT1 16 pass/**14 fail** ✓（失败集 = 验收1 跨范围纯+DB、验收2 全部、键形语法、输入卫生——与声称一致）；MUT2 22/**8** ✓（验收2 全部 + 两个 DB 版本用例 + 语法 + configVersion 校验）；MUT3 26/**4** ✓×2（canary、不透明性、语法、拒绝组；终字节复核同数）；MUT4 27/**3** ✓（命名空间互异 + 版本）。
- **MUT5 证据缺口（本报告唯一发现）**：归档 `mutation/MUT5-domain-validation-removed-TEST-FAILS.log` **全文只有 30 pass / 0 fail**——即 README 自认的那次假跑（runner 先还原后运行）；`reports/MT015.md` §5、`review-package.json`、`mutation/README.md` 三处声称的「MUT5 重跑捕获 **2 fail**」**在归档中没有对应产物**。复审者静态追踪：删去 `sharedInfrastructureKey` 的域校验后恰有 2 用例失败（验收4 标签规则：`sharedInfrastructureKey("")` 不再抛 → `message=""` 使 `toContain` 失败；验收3 拒绝组：`Pool_<canary>` 不再抛 → `not.toBe("")` 失败）——**声称的 2 fail 静态上成立、靶向正确**，但「已捕获」目前是不可复核的口头声明，且三处口径与唯一归档（0 fail 假跑）直接矛盾。复审未授权修改产品/测试文件，故不代跑变异。**处置建议**：实现者补一次带「突变与 pristine 有 diff」哈希守卫的 MUT5 真跑并归档日志；或将三处口径降级为「MUT5 捕获 = 静态推断 + 假跑已披露」。
- 附注：`mutation/README.md` 首行 pristine `8249a979…` 与 `pristine-sha256.txt` `7a0867cb…` 的差异为改名/票号修正前后的两个 pristine，README 内文已自行说明，非矛盾。

---

## 2. 独立复跑记录（全部复审者亲手执行）

1. 端口预检：55496 空闲（`lsof` 无监听、无残留容器）。容器 `mt015-review-pg`（`pgvector/pgvector:pg16`，trust，`POSTGRES_DB=openbot_enterprise_mt015_review_test`）→ PostgreSQL 16.15；另建 `openbot_enterprise_mt015_review_assigned`。
2. 凭据：三个 `ent_mt015rev_{dir,data,opr}` 登录 URL + `MT003_ASSIGNED_TEST_DATABASE_URL`，随机口令（`openssl rand -hex 16`）写入 0600 临时 env 文件，用后删除（已验证文件不存在）。
3. base migrate：`bun --no-env-file scripts/enterprise-test-db.ts migrate` → `{"type":"migrations-applied","status":"ok"}`，exit 0。迁移链 MT004→MT008→MT112→MT012→MT014→MT010→MT009 由套件 beforeAll 经 MT003 工具真实 dry-run → manifest-gated apply。
4. 聚焦：`bun --no-env-file test tests/multitenancy/cache-keys.test.ts --timeout 60000` → **30 pass / 0 fail / 0 skip，117 expect，exit 0**（4 个 DB 面用例真实执行，无 skip——「skipped 不算通过」满足）。
5. 全量：`bun --no-env-file test tests/multitenancy/ --timeout 60000` → **488 pass / 0 fail / 0 skip，17 文件，9186 expect，exit 0**（= 458 基线 + 30 新增；文件数算术 17 = 16 + 1 实测吻合）。
6. `cd server && bun run typecheck` → exit 0；`bunx biome check src/enterprise/tenancy/scoped-keys.ts tests/multitenancy/cache-keys.test.ts tests/multitenancy/support/cache-keys.ts` → exit 0（Checked 3 files, No fixes applied）。
7. 清理：`docker rm -f mt015-review-pg`；0600 env 文件删除；端口复查无监听。

---

## 3. 结论

- **A 通过 / B 通过（2 条非阻塞观察）/ C 通过 / D 通过但带 1 项证据缺口**（MUT5 捕获无归档、口径与存档矛盾；静态追踪支持其 2 fail 声称的成立方向）。
- 验收四条全部有真实测试证据且 DB 面经真实受限角色；键单射性、单向摘要、零回显、零环境读取、共享显式入口均被代码与测试双向钉死；prereq 零改动 49/49 独立复算成立。
- 独立复跑全绿：30/0/0（聚焦）、488/0/0（全量，17 文件）、typecheck/biome exit 0。
- 无 Blocker。建议事项仅 1 条：补归档 MUT5 真跑日志或修正三处声称口径；另 2 条非阻塞观察（O1 大版本号科学计数法边角、O2 命名空间 kind 标签等效性备忘）可随 v2 键形扩展处理。

# MT022 独立复审报告 —— 会话消息域（conversation-actions，Issue #65）

- 复审者：独立 Reviewer（Orca Task `task_0ff7df9f8631` / Dispatch `ctx_c6e3cf1332e7`，Pi）。
- 日期：2026-10-18。对象树：r14-mt022（BASE `f0520524` + 240 prereq + 本票增量 3 文件）。
- 性质：**只读复审**（除 brief 明示的变异重放注入/复原外未改任何文件；零 git commit）。
- 输入：`briefs/MT022-review-brief.md`（本次任务权威）、`briefs/MT022-brief.md`、`reports/MT022.md`、`checkpoints/MT022/` 全套、生产/测试/夹具三文件全文。

---

## Verdict：**PASS**

票面四条验收（AC1–AC4）在全新独立环境（不同端口/库名）下全部复现；变异抽验 4/4 按映射捕获且字节复原闭环；240 prereq 与 16 冻结面逐位一致；D8 顺序依赖定性成立且方向为 fail-loud（不掩盖缺陷）；D6 保守裁定方向安全（拒绝/不持久化侧）；RED→GREEN 链真红真绿。未发现 critical/high/medium 缺陷；3 条 low 级 findings 见 §7。

---

## 1. 环境从零 provision（复审独立环境，非复用实现者环境）

按 brief 三步配方重建，**库名 `openbot_enterprise_r14a_*`、端口 55571**（与实现者的 55563/w14a 完全隔离）：

| 步骤 | 结果 |
| --- | --- |
| 容器 `mt022-review-pg`（pgvector/pgvector:pg16）@127.0.0.1:55571（预检空闲） | ✓ |
| KB 登录角色 `ent_r14a_kb` **先建**；三库 `openbot_enterprise_r14a_test` + `_assigned` + `openbot_kb_r14a_test`（OWNER=KB 角色） | ✓ |
| 七变量 env 0600 临时文件（TEST_DATABASE_URL、ENTERPRISE_TEST_SETUP_DATABASE_URL、ENTERPRISE_TEST_{DIRECTORY,DATA,OPERATOR}_DATABASE_URL、MT003_ASSIGNED_TEST_DATABASE_URL、KB_TEST_DATABASE_URL） | ✓（测毕删除） |
| ① `enterprise-test-db.ts migrate` exit 0（自动配给 `ent_r14a_{directory,data,operator}`，四角色在册 rolcanlogin=t） | ✓ `{"type":"migrations-applied","status":"ok"}` |
| ② 十六链 generate+migrate --apply（MT004→MT008→MT112→MT012→MT014→MT010→MT009→MT077→MT026→MT076→MT069→MT016→MT041→MT027→MT028→MT070） | ✓ 16/16 exit 0；journal **31 行**，与实现者证据一致 |
| ③ `bun test`（见 §2） | ✓ |

环境备注（非缺陷）：r14-mt022 为全新 worktree，server/ 无 node_modules，配方第③步前需 `bun install`（1415 packages）——三步配方隐含此前置，建议未来 provision 清单显式写入（L3，§7）。

## 2. 复跑结果（全部亲测，非采信实现者声明）

| 套件 | 实现者声明 | 复审复跑 | 一致 |
| --- | --- | --- | --- |
| 聚焦 `conversation-messages.test.ts` | 35/0/0，139 expect，exit 0 | **35 pass / 0 fail / 139 expect，exit 0** | ✓ |
| 全量 `bun test tests/multitenancy/` | 1025/0/0/39 文件，exit 0 | **1025 pass / 0 fail / 39 文件，exit 0**（12226 expect） | ✓ |
| `tsc --noEmit` | exit 0 | **exit 0** | ✓ |
| biome 触及 3 文件 | 0 错 0 警 | **clean（无错误无警告）** | ✓ |

expect 计数 12226 vs 实现者 12223 差 3——pass/fail 完全一致，属条件断言的运行间波动，无影响（L2 记录，§7）。基线算术闭合：全量 1025 = 基线 990（实现者 `02-baseline-rebuild.txt`：990 pass / 1 fail / 1 error / 39 文件，含 RED 套件的模块缺失型失败）+ 新增 35。

## 3. 变异抽验（4/8 重放，≥3 达标；全部注入→聚焦捕获→字节复原→复绿）

靶文件 pristine `0c2d917d904ab183…`，重放前后 `sha256` 逐位一致闭环；每次复原后聚焦复绿 **35/0/0**。

| 变异 | 注入（复审亲手执行） | 捕获（复审实跑） | 与实现者映射一致 |
| --- | --- | --- | --- |
| **MUT1** 公司谓词整体移除 | `companyActive: true` | **5 fail**：AC4 撤权链 4 例 + AC2「read allow does not derive write」 | ✓ |
| **MUT4** epoch 臂移除 | `companyActive: company?.status === "active"` | **恰 1 fail**：`MT007 restore: the old scope stays denied (epoch arm)` | ✓ |
| **MUT5** status 臂移除 | `companyActive: company?.epoch === scope.memberEpoch` | **恰 1 fail**：`no epoch-bump dependency: suspended status alone denies` | ✓ |
| **MUT7** backend 门失效 | 三处 `storageBackend !== "platform"` 改 `if (false)` | **恰 1 fail**：`backend gate: platform-only message plane…` | ✓ |

D4 分解钉死声明验证成立：MUT4/MUT5 各被**恰好一个**独立用例族捕获（restore-epoch 臂 / 等-epoch-status 臂），互不遮蔽。

## 4. 冻结面核对

- **240 prereq**：`prereq-manifest.txt` 逐文件重算 sha256 → **240/240 逐位一致，0 缺失**。
- **16 冻结面文件**（conversations-list.ts `a7d5820b…` 等）：当前树重算 → **16/16 与 before-hashes.txt 一致，0 漂移**。
- **3 交付文件**：当前树 sha256 == `mutation/pristine-sha256.txt` 逐字节一致。
- `sha256-manifest.txt` 自校验声明 62 OK：其内存有前任 worktree（i14-mt022）绝对路径，本树无法机械复跑；但其中 3 交付 + 16 冻结面条目已由上两项独立等价复核（见 §7 L2 措辞备注）。

## 5. 专项核对

### 5.1 D8 顺序依赖披露 —— **定性成立，方向 fail-loud，不掩盖缺陷**

- **哪两用例**：AC2 末例 `read allow does not derive write: after revocation a prior read grants nothing`（断言后 reinstat a1-doomed）与 AC4 首例 `control: the doomed scope works before suspension`（`scopeAs("a1-doomed",…)` 须过真实资格门）。与报告披露一致。
- **什么依赖**：AC4 control 的 scope 铸造要求 a1-doomed 处于 active；该状态由 AC2 末例的收尾 reinstat 保证（bun 按文件序真实顺序执行）。
- **是否成立**：成立。撤权期断言（rename/archive canonical 拒绝）全部先于 reinstat 执行，断言强度未被削弱。
- **是否掩盖缺陷**：不能。失败方向是**放大噪声而非静默通过**——若服务缺陷使 AC2 末例在 reinstat 前失败，a1-doomed 停在 suspended，AC4 control 以 TENANT_FORBIDDEN 级联失败（响亮）；单独过滤运行 AC4 也通过（a1-doomed 从 provisioning 起即 active）。不存在「依赖使本应失败的断言通过」的路径。
- 跨套件无依赖的声明与证据相符：夹具前缀随机（`mt022-<uuid8>`）、行级隔离、dispose 清扫；本复审全量 39 文件两次独立通过。

### 5.2 D6 保守裁定 —— **方向安全（拒绝/不持久化侧），披露充分**

- **Q1（套件文件名）**：保守裁定取 Issue #65 Verification 字面 `conversation-messages.test.ts`。仓库冲突规则 Spec > brief（brief 自述「新文件**建议**」）；纯命名、零语义影响、可逆成本≈0。**安全**。
- **Q2（归档持久化）**：保守裁定方案B（归档=授权判定面、allow/deny、零持久化），因方案A 需改 migrate-test.ts / migration-tool.test.ts / enterprise-conversations.ts 三个 verified 冻结文件，brief 明令「如必须改停下 escalate」且 escalation（msg_29bd4895c6e6 前任 30min / msg_07115b60fe13 本任 20min）未答。
- **方向安全性**：保守方向落在「拒绝/不动持久状态」一侧——非成员一律 canonical not-found（拒绝），owner allow 侧不产生任何持久写入（无未授权 schema 变更、无破坏性状态翻转）；AC2 字面（分别授权、可读不派生可改）由判定面完整满足。allow 侧无持久化的消费风险被三重披露（报告 D1、代码注释、PLAN Ruling），且 D5-d 明示本票不接路由——今日无消费者可被误导。若协调者后续选 A，属增量迁移票（与 PLAN 预案一致）。**安全**。
- AC4 的语义保守性同向验证：status 臂 suspended 即拒（拒绝侧），setup 通道构造的「等-epoch 挂起态」被披露为测试缝隙且服务侧从不产生（MUT5 变异抽验实证该臂独立可捕获）。

### 5.3 RED→GREEN 链完整性 —— **真红真绿**

| 阶段 | 证据 | 判定 |
| --- | --- | --- |
| RED-0（语法修复） | 前任 RED 文件 `await` 位于同步箭头内（L759/760）从未解析；修复为 `async () =>`，`bun build` PARSE OK 留档 | ✓ 修复前置且只此一处 |
| RED-1（真功能红） | `Cannot find module '../../src/enterprise/tenancy/conversation-actions'`，0 pass / 1 fail / 1 error | ✓ 模块缺失型真红 |
| GREEN-1 | **30/35**：实现缺陷（rows 未翻转）+ 4 个测试缺陷，失败形态与 FIX-NOTES/D2 逐一吻合 | ✓ 中间态留档 |
| GREEN-2 | **32/35**：`nextBeforeSeq` 钉错端 + 夹具 operationId 幂等去重（D3） | ✓ |
| GREEN-3/5 | **35/0/0（139 expect）exit 0**；GREEN-4 为 biome 复跑 | ✓ 终态绿 |
| 夹具修复（D3） | `suspendMembership` 按 operationId 幂等（provision.ts 事件回放），唯一化 revocationSeq 修复；夹具为本票新文件 | ✓ 非既有面改动 |

链叙事、失败形态、披露 D2/D3 与三份原始日志互证一致；当前三文件哈希 == pristine 终态。

## 6. 实现面安全抽查（独立评审，非复述）

- 每动作独立事务：assertScopeContext → assertTrustedScope → read committed + lock/statement timeout → `set_config('app.*', true)` → advisory 共享锁链（tenant→principal→membership→workspace-membership）→ 成员事实重验 → 归属比对（RLS 租户臂 + workspace + principal 双防线）→ 执行或 `notFoundVerdict()`。与 MT008/MT011/MT016/MT021 判定纪律同形。
- **写路径竞态安全**：sendMessage 在幂等existing检查与 `lastSeq+1` 预订**之前**取 conversation 排他锁（键族 `["conversation", tenantId, threadId]`）——同键并发发送被串行化，read committed 下第二写者可见第一写者提交行，幂等语义无竞态窗口。
- deny 零写入：一切拒绝（含 `message_conflict` 409 形状）发生在任何 INSERT/UPDATE 之前；套件 raw 计数不变量钉死。
- `role` 硬编码 `"user"`：防冒充 assistant（安全方向）；assistant/tool 消息仍归既有 run/append 路径，属下游接线票职责。
- backend 门在授权之后：非成员对 mastra 会话 canonical not-found，不泄露存在性（MUT7 + 用例双钉）。
- replay 独立输入校验/事务/重验，不委托 readMessages（AC1 绕过面消除，MUT3 捕获族含 replay 用例）。

## 7. Findings（分级）

**Critical / High / Medium：无。**

- **L1（low，证据表述）**：`mutation/results.md` 的「fail 数」列是 bun 日志行数（每个失败用例在日志中出现两次），为实际失败用例数的 2×：MUT1「10」=5 用例、MUT2/4/5/7/8「2」=1 用例、MUT3「22」=11、MUT6「18」=9；报告 §4 沿用了同一口径（如「MUT1 10 fail」）。捕获映射本身经复审 4 条重放证实**准确**，仅计数口径易误读，建议后续报告以「失败用例数」计。
- **L2（low，措辞/可复现性）**：报告冻结面表述「`before-hashes.txt == after-hashes.txt`」为松措辞——after-hashes.txt 实为 3 交付文件哈希 + 一行文字断言，并非 before 的逐字节副本；底层声明（16 文件 before==after）为真且已被本复审独立重验。另 `sha256-manifest.txt` 内嵌前任 worktree（i14-mt022）绝对路径，跨树无法机械 `sha256sum -c` 复跑。
- **L3（low，配方完备性，非本票缺陷）**：全新 worktree 无 node_modules，三步配方第③步前必须 `bun install`；建议未来 provision 配方/检查单显式包含该前置（本复审 1415 packages 安装后全部通过）。
- **备注（非 finding）**：全量 expect 计数 12226 vs 12223（差 3，条件断言波动）；MUT7 复审注入翻转全部三处判定而捕获仍为同一用例——与实现者单处注入的日志形态兼容。

## 8. 结论与收尾

- 复审范围内全部必做项通过：独立环境三步配方从零重建 ✓、聚焦 35/0 ✓、全量 1025/0/39 ✓、变异抽验 4/4 捕获+复原闭环 ✓、240 prereq + 16 冻结面哈希逐位一致 ✓、D8/D6/RED→GREEN 三专项核对通过 ✓。
- **Verdict：PASS**（3 low findings，均不阻塞验收；L1/L2 建议在报告口径上改进，L3 建议进配方清单）。
- 复审全程未修改任何生产/测试代码（变异注入均已字节复原）；未执行任何 git commit。
- 收尾：复审容器 `mt022-review-pg` 已 `docker rm -f` 销毁；七变量 env 临时文件已删除。

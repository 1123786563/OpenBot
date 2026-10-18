# MT017 复审报告 —— Bot 发布受众与旧 public 语义（Issue #60）

- 复审者：独立 Pi 复审（全新会话，未参与实现）。
- 日期：2026-10-17。复审树：`i12-review-mt017`，BASE `f0520524f0faa2b4533b9d2f1aa692c8f907ba71`（与 checkpoints/prereq-manifest.txt 首行一致）。
- 输入：`briefs/MT017-review-brief.md` + `gh issue view 60` 实取 + `reports/MT017.md` + `checkpoints/MT017/`。
- 本报告为复审树内唯一新建文件；被审文件全部只读，未做任何修复。

## 结论

**PASS with findings**（finding 1 项，级别 low；无 critical/high/medium）。

Issue #60 四条验收全部有真实 PostgreSQL + 受限 `ob_ent_*` 角色 + 真实 RLS 下的亲测证据；实现报告的门槛数字全部复现一致；D3 缺口经代码核实为「结构保证成立、测试覆盖缺口」，与实现报告披露相符。

---

## 1. 复审门槛逐项（全部亲测，不采信存档）

| # | 门槛 | 实测结果 | 证据（本报告内联） |
| --- | --- | --- | --- |
| 1 | `bun install --frozen-lockfile` | **1415 packages installed**，exit 0 | 本节 |
| 2 | 端口预检 + 专用容器 + 三库 + 七变量 env 0600 | **55532 空闲**（lsof 无监听；55533=mt070-review-pg 为并行复审占用，无冲突、无 +1）；`docker run -d --name mt017-review-pg -p 127.0.0.1:55532:5432 pgvector/pgvector:pg16`（随机 POSTGRES_PASSWORD，仅回环发布）；建库 `openbot_enterprise_mt017r` / `openbot_enterprise_mt017r_assigned` / `openbot_kb_mt017r`；七变量 env 写入 `/tmp/mt017-review-env.sh` **chmod 0600 实测 `-rw-------`**；缺 env skip 语义未触发（七变量齐备） | `pg_isready` accepting；本节 |
| 3 | base migrate + 十四任务链 | `bun --no-env-file scripts/enterprise-test-db.ts migrate` → `{"type":"migrations-applied","status":"ok"}`；十四任务逐任务 `generate --out`（/tmp）+ `migrate --apply --manifest` 全部 applied；**活库 journal 实查 14 行**：MT004=2, MT008=2, MT009=2, MT010=2, MT012=2, MT014=2, MT016=2, MT026=2, MT027=2, MT041=2, MT069=1, MT076=1, MT077=2, MT112=4（步数与 generated SQL 文件数逐项一致，与 checkpoints 存档逐字节同构） | 本节 |
| 4 | 聚焦 0 skip + 全量 | 聚焦 `bun --no-env-file test tests/multitenancy/bot-publish.test.ts` → **34 pass / 0 fail / 0 skip（129 expect）**；全量 `bun --no-env-file test tests/multitenancy/ --timeout 60000` → **804 pass / 0 fail / 0 skip，30 文件（10787 expect）** ＝ 基线 770 + 新增 34，与实现声明一致 | 本节 |
| 5 | typecheck + biome | `tsc --noEmit` **exit 0**；`bunx biome check`（触及 3 文件：bot-publish.ts / bot-publish.test.ts / support/bot-publish.ts）→ **Checked 3 files, No fixes applied（0 错误 0 警告）** | 本节 |
| 6 | 活库抽查 | `enterprise_resources`：**relrowsecurity=t**；策略 4 条（operator INSERT/SELECT/UPDATE + data SELECT，roles 逐条核对）；CHECK `enterprise_resource_visibility = (visibility IS NULL OR visibility IN ('private','workspace'))`；**列级 UPDATE(visibility) 授予 ob_ent_operator**（另 INSERT/SELECT）；复合外键 `FOREIGN KEY (tenant_id, workspace_id) REFERENCES enterprise_workspaces(tenant_id, id)` —— 与交付声明（MT008 授权、纵深防御）逐项一致 | 本节 |
| 7 | 变异重放 ≥3 | **3/3 重放，3/3 捕获，计数与实现者存档逐项一致**（详见 §3） | §3 |
| 8 | 边界核对 | **after-hashes 15/15 逐项 == 实测哈希**（3 NEW + 12 untouched）；**prereq-manifest 213/213 逐项 == 实测哈希**（工作树 = BASE + 前置移交态 + 本票 3 新文件，零漂移）；`changes.diff` 仅 3 个 `/dev/null → 新文件`，对既有文件零改动；git modified（14 文件 vs BASE）全部在 prereq-manifest 内且哈希一致 = 前置移交态 | §4 |
| 9 | 清理 | `docker rm -f mt017-review-pg` → 输出 `mt017-review-pg`、exit 0；删除检查 `docker ps -a | grep -c mt017-review-pg` → **0**；`/tmp/mt017-review-env.sh` 与 `/tmp/mt017-review-gen/` 已删（`ls` 复核 No such file） | 本节 |

全量 804/0/30 中的 30 文件与聚焦 1 文件均在七变量齐备下运行，**全程 0 skip**——skip 不算通过的门槛以「无 skip 发生」满足。

## 2. 专项审计四点

### 2.1 D3：private→workspace 翻转路径无测试 —— 结构保证成立（finding 1，low）

- **代码核实**：`publishBot` 对已存在注册行只有两个可见性分支——`visibility === "workspace"`（幂等 no-op）与其余值共用的同一条 UPDATE（`set visibility='workspace' where status='active'`，**无 visibility 谓词**）。NULL 与 'private' 走**逐字节相同的 SQL 路径**，报告中「结构保证成立」的说法属实。
- **可达性核实**：活库 CHECK 允许 `'private'`；且 `'private'` 并非理论态——`personal-share-rules.ts` 以 `visibility='private'` 为 MT010「个人」标记，MT008 清单迁移显式保留 private（`privateKept`）。因此「被标为个人的 Bot 经属主显式发布翻转为 workspace」是**真实可达且被 D3 披露为有意**的语义（与 MT008 批量迁移「绝不翻转 private」主体不同，不冲突）。
- **裁定**：行为本身经代码 + 活库双重核实为正确；缺口纯粹是**测试覆盖**——这条跨越 MT010「个人」语义边界的翻转没有任何用例钉死，未来回归（如有人镜像 MT008 加 refuse-to-flip 守卫）将无测试报警。**级别 low**（无行为缺陷、路径与已测 NULL 路径零分支差异、实现者已诚实披露为「已知最小缺口」）。**建议修复轮补**：夹具 `seedResourceRow` 加 `visibility` 参数 + 1 个用例（private 行 → owner publish allow → 注册行变 'workspace'，并断言与 NULL 路径回显同形）。

### 2.2 D2：取消发布后 MT016 归属可见性对照用例 —— 真实钉死 ✓

用例「MT016 归属可见性不受发布/取消影响（对照钉死：两表面语义披露）」经**真实 MT016 服务**（`fixture.ownership.getBot`，非重写/桩）断言两个方向：取消发布后同团队成员 detail 仍 `allow`（归属面不受使用权关闭影响）；非成员（a2）detail canonical not-found。与验收 2 的 read/run not-found 用例合成完整两表面对照。**无 finding**。

### 2.3 无迁移声明 —— 零改动属实、与票面口径相容 ✓

- `server/scripts/multitenancy/migrate-test.ts` 与 `server/tests/multitenancy/migration-tool.test.ts`：实测哈希 `03b1da57…` / `a962bd06…` **与 before-hashes、sha256-manifest [unchanged]、prereq-manifest 三方逐字节一致**——「零改动」属实。
- 相容性：票注「迁移动作复用 MT003 工具的 manifest 机制」以两层满足——(a) 环境链十四任务全部经 `migrate-test.ts generate → migrate --apply --manifest` 真实执行（journal 14 行活库在案）；(b) 验收 3 对照测试直接调用冻结的 MT008 `migrateLegacyResourcesToWorkspaceVisibility` 真实入口（报告 migrated/updatesExecuted=1 断言）。发布模型无新 schema 对象 → 不注册第十五任务是正确推论。**无 finding**。

### 2.4 MUT5 中止签名 —— 如实、有效 ✓

`mutation/MUT5.result.txt` 原文：**`14 pass / 3 fail / 41 expect() calls / Ran 17 tests across 1 file`**——与实现报告 D4 披露（throw 从 beforeAll 逃逸 → 套件在 17/34 处中止、发布落库用例全灭）一致，档案未粉饰；mutated-hash `eee3241b…` 与 restored-hash `9bb87d5d…`（== pristine 冻结值）双存档在案。中止签名成立 = INSERT 路径被变异后 beforeAll 即失败，捕获有效。**无 finding**。

## 3. 变异重放（门槛 7 详录）

从实现者清单中选 3 个安全语义关键项，本人重注入 → 聚焦 → 记录 → 恢复 → 哈希复验 → 聚焦复绿：

| 变异 | 注入方式 | 实测结果 | 实现者存档 | 恢复后哈希 | 复绿 |
| --- | --- | --- | --- | --- | --- |
| MUT3 跨公司受众拒绝移除 | 删除 `PUBLISH_AUDIENCE_CROSS_COMPANY` 分支 | **33 pass / 1 fail**（fail=「跨公司受众 deny…」用例） | 33 pass / 1 fail | `9bb87d5d…` == 冻结值 | 34/0 ✓ |
| MUT2 owner 门移除（仅 publishBot） | 删除 publish 侧 `PUBLISH_FORBIDDEN` 守卫 | **33 pass / 1 fail**（fail=「同团队非 owner 发布/取消 = PUBLISH_FORBIDDEN」） | 33 pass / 1 fail | `9bb87d5d…` == 冻结值 | 34/0 ✓ |
| MUT4 取消发布写路径移除 | 删除 unpublish 的 UPDATE（保留 no-op allow） | **30 pass / 4 fail**（fail=visibility 回 NULL / 取消后立即 not-found / stale scope / grant 独立） | 30 pass / 4 fail | `9bb87d5d…` == 冻结值 | 34/0 ✓ |

方法学披露：MUT2 首次尝试以「条件取反（`!==`→`===`）」注入得 11 pass/6 fail——与实现者「移除」语义不符，**该次结果作废**，按原语义删除重注入后与存档逐项一致。三轮恢复后 pristine 备份即删，未残留。

## 4. 边界核对（门槛 8 详录）

- **after-hashes 15/15**：`NEW 9bb87d5d…bot-publish.ts`、`NEW 544c2f3b…bot-publish.test.ts`、`NEW 171603c8…support/bot-publish.ts` 及 12 项 untouched 全部与实测一致。
- **prereq-manifest 213/213**：逐项 sha256 复算全部匹配（含 `store.ts` 等 14 个 vs BASE 的 M 条目 = 前置移交冻结态；`migrate-test.ts` / `migration-tool.test.ts` 在列，见 §2.3）。
- **changes.diff**：恰为 3 个 `/dev/null →` 新文件 diff，无既有文件条目。
- 授权编辑点之外：零改动。变异注入的临时改动已全部恢复并哈希验证。

## 5. Findings 汇总

| # | 级别 | 内容 | 建议 |
| --- | --- | --- | --- |
| 1 | **low** | private→workspace 显式发布翻转路径无测试（D3 披露的「已知最小缺口」）：代码与活库核实结构保证成立、行为正确，但该跨越 MT010「个人」标记语义边界的转换无用例钉死 | 修复轮为 `seedResourceRow` 增加 visibility 入参并补 1 用例；同时可顺带断言「flip 后 unpublish 回 NULL 不回滚为 private」的既定语义 |

无 critical / high / medium finding。

## 6. 清理证据（门槛 9 详录）

```
$ docker rm -f mt017-review-pg
mt017-review-pg            （exit 0）
$ docker ps -a --format '{{.Names}}' | grep -c mt017-review-pg
0                          （deletion check = 0）
$ rm /tmp/mt017-review-env.sh && rm -rf /tmp/mt017-review-gen
$ ls /tmp/mt017-review-env.sh
ls: /tmp/mt017-review-env.sh: No such file or directory
```

## 7. 复审者声明

- 全部门槛数字为本机亲测（bun 1.4.2；容器 `pgvector/pgvector:pg16` @ 127.0.0.1:55532，已销毁）；未采信任何存档数字，存档仅用于交叉比对且逐项一致。
- 只读被审文件；本报告为复审树内唯一新建文件；变异注入均已恢复并哈希复验。
- 未做任何修复；finding 1 交 coordinator 裁定修复轮。

# MT011 / Issue #54 — 无权对象按不可见处理:核验报告

## 结论

**零改动收尾。** 票面给的核验条件成立:该工作**已在 main**,只是文件名与票面路径不同——

- 票面路径 `server/tests/multitenancy/invisible-semantics.test.ts`:**不存在**(git log --all 亦无历史)。
- 实际落地:`server/tests/multitenancy/not-found-semantics.test.ts`(693 行),文件头第 2 行明确标注 "MT011(Issue #54):集中式 not-found 不可见语义 + 列表/游标/批量面"。
- 源模块:`server/src/enterprise/tenancy/not-found-semantics.ts`(626 行)+ 夹具 `server/tests/multitenancy/support/not-found-semantics.ts`(289 行)。
- 两者均在 origin/main:`git log origin/main -- server/tests/multitenancy/not-found-semantics.test.ts` → `06e3c9bc`(另 `253bf7e5` checkpoint);`git ls-tree origin-main` 确认源模块在 main tree。
- worktree HEAD(3ca32d49)包含 origin/main(`git merge-base --is-ancestor` 通过),worktree 与 HEAD 零差异。

**实测 19 pass / 0 fail,无 skip**(数据库面 16 用例 + 离线纯函数面 3 用例)。

## 逐条 AC 实证

测试文件头注释逐条声明了票面四条 AC 与 describe 的对应关系,实测全部通过:

| AC | 测试位置(describe/test) | 实证内容 |
|---|---|---|
| 1. 无权=不存在,响应无可区分信号 | `shared not-found invariants across the three frozen decision loops`(4 个 test) | missing/forbidden/deleted/cross-team/cross-company 五种拒绝的 verdict 序列化逐字节等于 `{"outcome":"deny","code":"RESOURCE_NOT_FOUND"}`,HTTP 面统一 404 + `{"error":"RESOURCE_NOT_FOUND"}`;missing vs forbidden 的 **SQL 语句数相等**(时延的结构性代理,`statementCount` 断言) |
| 2. 列表/计数不含无权对象,游标不偏移 | `list / count / cursor surface`(7 个 test) | `countVisibleResources` 只计可见(7);keyset 分页 4 页精确走完可见流,`i1..i4` 不出现、不消耗页位、不产生末页游标;批中途软删除不移位不报错;非法 cursor/limit 大声失败 |
| 3. 批量接口不泄露存在性 | `batch surface`(5 个 test) | 混合批逐 id 结果顺序与输入一致、一切拒绝逐字节同形;批量与单个 `decide` 判定一致;**全缺批 vs 全禁批 SQL 语句数相等**;无聚合部分计数;重复 id 结果恒等 |
| 4. 语义集中实现,各闭环复用 | 上述全部 + `MT011 canonical not-found semantics (offline unit face)`(3 个 test) | canonical verdict/序列化/HTTP 面只在 `not-found-semantics.ts` 定义一处(冻结对象);共享不变量套件 `expectCanonicalNotFound` 逐例跑过三个闭环(resource-policy MT008 / team-public MT009 / personal-share MT010);`serializeNotFoundVerdict` 拒绝任何非 canonical 形状(含多带 `reason` 字段的泄露形状) |

测试自身声明的边界(诚实披露,写在其头注释):三个判定模块按票面**只读消费**(哈希冻结,不重构);各闭环对新表面的接线属下游票。

## 复现命令与输出摘要

### 1. 一次性数据库(保留未删)

```sh
docker run -d --name orca-all-mt011-pg \
  -e POSTGRES_USER=enterprise_setup -e POSTGRES_PASSWORD=enterprise-setup-only \
  -e POSTGRES_DB=openbot_enterprise_mt011 -p 5562:5432 pgvector/pgvector:pg17
```

**对票面命令的两处必要偏离**(票面命令本身跑不通):
- `postgres:16` → `pgvector/pgvector:pg17`:迁移含 `CREATE EXTENSION vector`(server/drizzle/0000_schema.sql:10),普通 postgres 镜像无该扩展,CI 同款镜像(.github/workflows/ci.yml:373)。
- `POSTGRES_DB=mt011` → `openbot_enterprise_mt011`:`server/tests/support/enterprise-database.ts:188` 强制库名匹配 `/^openbot_enterprise_/`,否则环境探针整套 skip。容器名与端口照票面。

### 2. 迁移(两步)

```sh
# ① 主链 + 三受限角色 login 预配(one-shot,CI 同款)
cd server && ENTERPRISE_TEST_SETUP_DATABASE_URL=... \
  ENTERPRISE_TEST_{DIRECTORY,DATA,OPERATOR}_DATABASE_URL=postgres://ent_mt011_{role}_login:...?options=-c%20role%3Dob_ent_{role} \
  bun scripts/enterprise-test-db.ts migrate
# → {"type":"migrations-applied","status":"ok"}

# ② 任务迁移 MT004/MT008/MT009/MT010(经 /tmp/mt011-bootstrap.ts 调 runMigrateTest --apply)
# → 四个任务全部 {"kind":"applied",...}
```

**发现的环境事实(非缺陷,值得协调器知晓)**:`not-found-semantics.test.ts` 自身**不**apply 任何任务迁移(不同于 resource-policy.test.ts 自 apply MT008、personal-share-rules.test.ts 自 apply MT010 的模式)。它在 CI 里能跑,是因为同组 `server/tests/multitenancy part 1` 字母序在前的套件(bot-publish / cache-keys / fixtures / kb-ownership / rls-core 等)先把 MT004/008/009/010 应用进了共享 MT 库。单文件独立运行(如本票 Observable 命令)在空库上会 fail——这是既有设计(共享库顺序耦合),不是本次改动引入,零改动收尾原则下不动它。

### 3. 测试(仓库根)

```sh
bun test ./server/tests/multitenancy/not-found-semantics.test.ts   # 实际文件名;票面的 invisible-semantics.test.ts 不存在
# → 19 pass / 0 fail / 0 skip,Ran 19 tests across 1 file. [1490.00ms]
```

## 改动文件

**无。** `git status --short` 为空,worktree 与 HEAD 一致。临时引导脚本在 /tmp/mt011-bootstrap.ts,不入库。

## 遗留

- 无代码遗留。容器 `orca-all-mt011-pg`(端口 5562)按票面纪律保留未删。
- (信息项,供协调器裁量)上述"单文件独立运行依赖共享库已迁移"的顺序耦合,若未来要票面 Observable 命令独立可跑,需在测试 beforeAll 里自 apply 依赖任务迁移——属行为变更,超出本票"已含则零改动收尾"的范围。

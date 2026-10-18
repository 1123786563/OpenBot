# MT006 变异测试记录（关键判定逻辑 5 个变异，全部被新套件捕获）

基线：`bun test tests/multitenancy/workspace-scope.test.ts` 34 pass / 0 fail。
变异对象：`server/src/enterprise/tenancy/workspace-admin.ts`（唯一生产判定文件）。
每个变异：python 精确替换应用 → 跑新套件 → 记录失败用例 → 从
`/tmp` pristine 副本恢复 → sha256 比对 `0776715…80ee30`（pre-mutation-hash.txt）一致。
（注：新增文件不受 git 跟踪，恢复以字节副本 + 哈希为证。）

| 变异 | 改动 | 捕获用例（失败） | 记录 |
|---|---|---|---|
| MUT1 | lister 团队查询删除 `status='active'` 过滤 | criterion 1「suspended team membership disappears from the listing」+ criterion 3「the admin suspends a member…」共 2 例 | MUT1-lister-drops-active-filter.txt |
| MUT2 | 空列表时注入 default-company/default-team（被禁止的回退） | criterion 1「explicit empty listing, not a default」+ criterion 2「TENANT_FORBIDDEN (empty state has no hidden default)」共 2 例 | MUT2-empty-state-default-fallback.txt |
| MUT3 | revalidateAdmin 删除 tenant_admin 角色检查 + epoch 等值检查 | criterion 3「stale admin context…」+「admin demoted to plain member…」共 2 例 | MUT3-admin-role-and-epoch-checks-dropped.txt |
| MUT4 | 仅删除 epoch 等值检查 | criterion 3「stale admin context…」1 例 | MUT4-epoch-equality-dropped.txt |
| MUT5 | addTeamMember 删除目标公司成员资格检查 | criterion 3「adding a principal who is not an active company member…」1 例 | MUT5-target-company-check-dropped.txt |

诚实记录：
- MUT3 首轮（新增 demoted-admin 用例之前）仅 stale-context 1 例失败——角色半边被
  authorizer 签发侧的同名检查遮蔽。为独立钉住事务内角色重验，按 MT005 M4 先例
  补写「demoted admin（role 改变、epoch 不变）→ SCOPE_REVOKED」用例（该用例钉的
  是既有行为，立即通过；其杀伤力由 MUT3/MUT3 角色半边变异证明），MUT3 重跑后
  2 例失败。角色变更经 setup 通道执行（operator 角色的 UPDATE 列授权仅
  status/epoch，无生产角色变更写路径），已在 reports/MT006.md 披露。
- 全部变异后生产文件哈希复原并与 pre-mutation-hash.txt 一致。

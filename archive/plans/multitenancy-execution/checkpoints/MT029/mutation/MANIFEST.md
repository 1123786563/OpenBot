# MT029 变异清单（12/12 KILLED，零存活）

被变异文件：`server/src/enterprise/tenancy/credential-lease.ts`（pristine sha256
`5e03b03804d62dd3f8fe97fb102ed1a5a2881881ac46bbae386537f305d21f00`）与
`server/scripts/multitenancy/migrate-test.ts`（pristine sha256
`5f8493de1e19eed2b187c2c64c7f234911f1fc4f3cd71214c8ec81f870db78de`）。
每次注入 → 聚焦套件捕获 → 字节复原（sha256 逐位复核）→ 复绿（27/0）。

| MUT | 注入面 | 注入内容 | 聚焦结果 | 杀灭用例 |
|-----|--------|----------|----------|----------|
| 1 | decideLease | purpose 比对短路（false &&） | 24p/2f | AC1 用途不符拒绝 + AC4 deny 零副作用 |
| 2 | 读取谓词 + decideLease（复合） | workspace pin + workspace 比对双移除 | 25p/1f | AC1 跨团队上下文取用拒绝 |
| 3 | 读取谓词 + decideLease + RLS data_read（全栈，MUT-3b） | principal 三层全移（变异库 openbot_enterprise_w14int_mut3 真实 apply） | 26p/1f | AC1 跨主体 ride 拒绝（全栈不变量） |
| 4 | 读取谓词 + decideLease（复合） | status 谓词 + status 比对双移除 | 25p/1f | AC2 撤销下一次校验点失效 |
| 5 | 读取谓词 | expires_at > now() 移除 | 25p/1f | AC2 过期失效且行不撤销 |
| 6 | decideLease | epoch 匹配移除 | 25p/1f | AC2 停用后旧 scope 拒绝/新 scope 放行 |
| 7 | decideLease | companyMembership status 检查移除 | 17p/10f | AC2 无 epoch-bump 停用拒绝（+连带） |
| 8 | useAuthorityHolds | personal 分支恒 true（属主检查移除） | 23p/4f | AC3 同团队他人/双团队/管理员签发拒绝 + 零副作用 |
| 9 | useAuthorityHolds | team 分支恒 true（成员资格+use 行检查移除） | 26p/1f | AC1 无 use 授权成员签发拒绝 |
| 10 | validate | validated 审计 INSERT 短路 | 25p/2f | AC4 生命周期逐操作恰一行 + deny 计数 |
| 11 | revoke | 原子臂丢 status='active' 条件 | 26p/1f | AC2 撤销幂等/未知 revoked:false |
| 12 | MT029 迁移（变异库 openbot_enterprise_w14int_mut12 真实 apply） | GRANT SELECT ON audit TO ob_ent_directory | 26p/1f | 存储栅栏·授权矩阵（directory 盲） |

注（MUT-3 → MUT-3b 的诚实记录）：principal 三重冗余（RLS data_read pin + 读取
谓词 pin + decideLease 比对）。先做模块双移除：行为不变量仍被 RLS 持有（27/0，
单层变异对纵深防御构造上不可观测，MT028 D6 同族）——为消除存活疑问，补
MUT-3b 全栈变异：迁移策略 pin + 模块谓词 + decide 三层全移（变异库
w14int_mut3 真实 apply），ride 用例捕获（26p/1f）。principal facet 的可观察
不变量由 ride 用例经全栈钉死。MUT-2/4 的复合注入证明同类双层 facet 的可捕获性。

变异库处置：openbot_enterprise_w14int_mut12（MUT-12）与
openbot_enterprise_w14int_mut3（MUT-3b）均于复原后 DROP（已回显）。

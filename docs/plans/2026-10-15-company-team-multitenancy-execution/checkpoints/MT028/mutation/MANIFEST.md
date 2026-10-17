# MT028 变异清单（8/8 KILLED，零存活）

基线哈希：module c9114fa90b744ad2c36e879a06040c9c27cb5495e9bcd1258de0bb84d2f867d8
（src/enterprise/tenancy/oauth-state.ts）；migrate-test 9767c9c50a8344c9dbf3cbfe0eee4a4615d143e63d4ea726d453512ea9085523。
每次注入 → 聚焦 26 用例 → 恢复 → sha256 校验闭环；恢复后 sanity 全绿（POST-MUT-SANITY.txt）。

| ID | 注入点 | 变异内容 | 被杀测试 | 结果 |
| --- | --- | --- | --- | --- |
| MUT-1 | consume 原子消费臂 | 丢 `status='pending'` 条件（TOCTOU：并发双消费可双 allow） | 并发双消费恰一 allow（双 operator 连接真实重叠） | 1 fail KILLED |
| MUT-2 | consume 过期预检 | 删除 EXPIRED 分支 | 过期拒绝 STATE_EXPIRED 用例 | 1 fail KILLED |
| MUT-3 | consume 跨范围比对 | crossScope 恒 false（claimed 不比对） | 三个跨范围拒绝 + 安全事件用例 | 4 fail KILLED |
| MUT-4 | consume 归属来源 | claimed 租户比对移除 + binding.tenantId 改用 claimed（回调选择生效） | 「跨范围不烧 state + 归属恒为持久行」用例 | 4 fail KILLED |
| MUT-5 | recordStateRejectionEvent | 事件 INSERT 短路（拒绝不留痕） | 全部安全事件读回用例 | 14 fail KILLED |
| MUT-6 | fail 终态臂 | 丢 `status in ('pending','consumed')`（failed 行可重复失败） | fail 幂等性用例 | 1 fail KILLED |
| MUT-7 | 发起人存活重验 | liveness 条件恒 false（失格仍消费） | 停用/撤权后消费拒绝用例 | 10 fail KILLED |
| MUT-8 | MT028 迁移步骤2 | 注入 `GRANT SELECT ... TO ob_ent_data`（RLS 授权扩权）；专用变异库 openbot_enterprise_mt028_mut8 真实 apply | 存储栅栏 data 角色零授权断言 | 1 fail KILLED（变异库已 DROP） |

注：MUT-1 为并发不变量（MT027 D8 同类），由本套件新增的双连接并发用例钉死；
单线程用例观测不到该防线（消费预检与原子臂互为纵深）。

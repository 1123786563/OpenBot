# MT027 变异重杀清单（第 2 任，2026-10-17，对准最终 38 测试文件）

第 1 任 MUT-1..8 存档保留不删；其中 MUT-2..8 落盘时间（03:44:17-03:44:30Z）早于
测试文件最后修改（03:46:23Z，新增第 38 个测试），无法证明对准最终文件。第 2 任
全部 8 个变异对当前最终态重杀，存档 -2nd.log。每个变异注入→聚焦测试→记录→
恢复→sha256 校验（MUT-1..3/5-8 变异 credential-ownership.ts，规范哈希
9aca25433525132bdc37da25116196fb96cef5af8614c288c3dd637dbe30df31；MUT-4 变异
migrate-test.ts，规范哈希 ba725403e26fc981d7e25061d67a4e5d608d56f08c60a906f9ef2b3e1174c21b，
在专用新库 openbot_enterprise_mt027_test_mut4 上应用变异后迁移，测毕删库）。

| ID | 变异对象 | 外科手术式变异 | 命中的防线 | 结果（-2nd.log） |
| --- | --- | --- | --- | --- |
| MUT-1 | decideCredential | 删除 companyMembership.status!=='active' 检查（只信 epoch 纪律） | 成员资格状态防线 | 37/1 fail — killed |
| MUT-2 | decideCredential | personal isOwner 恒 true | 个人凭据属主防线 | 32/6 fail — killed |
| MUT-3 | decideCredential | company 分支 grants.use || grants[action]（use 顺带 disclose） | 明文独立授权防线 | 37/1 fail — killed |
| MUT-4 | migrate-test.ts MT027 step0002 | 追加 GRANT UPDATE,DELETE ON audit TO ob_ent_data | 审计 append-only 授权防线 | 37/1 fail — killed（42501 断言失败） |
| MUT-5 | decideCredential | 删除 credential.status!=='active' 检查 | revoked 一票否决防线 | 37/1 fail — killed |
| MUT-6 | decideCredential | 删除 workspaceMembershipStatus 检查 | 团队成员资格防线 | 36/2 fail — killed |
| MUT-7 | redactedView | 视图注入 envelope 字段 | 脱敏形状 + canary 扫描防线 | 34/4 fail — killed |
| MUT-8 | readFacts discloseGrant 子查询 | gd.action='disclose' → ='use'（use 行冒充 disclose 行） | 动作行独立事实防线 | 34/4 fail — killed |

全部 8/8 killed，零存活变异。变异后恢复 sanity：聚焦 38 pass / 0 fail（2026-10-17 实测）。

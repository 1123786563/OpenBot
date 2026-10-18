# MT099 环境令牌整改（波次 14 集成整改 §2 同款先例）

日期：2026-10-18（MT099 执行者，wave 15）
对象：`server/tests/multitenancy/entry-context.test.ts`（268 项 prereq 转移清单内文件）
动作：MT122 交付的库名钉死断言 `openbot_enterprise_w14int` → `openbot_enterprise_w15c_test`
依据：本票 brief 环境配方钉定库名 `openbot_enterprise_w15c_test`；票内钉死 w14int 与 brief
钉定 w15c 在本树不相交成立（与 wave14 整改说明 §2 完全同构：票面令牌与集成库名冲突）。
断言语义不变：专库 + 受限 ob_ent_data 角色 + 绝不回退开发库，仅环境令牌随本票 brief 更新。
基线影响：不改则 1124 基线必然 1 fail（实测：1123/1），整改后聚焦 21/0，全量复跑见
00-baseline.txt。

| 状态 | sha256 |
|---|---|
| before（prereq-manifest 转移值） | d7e4d400a5e6d270efe4eb006f7252f7cc2ae695c459f3105eb1d2b2cda1e948 |
| after（本票整改后，工作树现值） | 3667a2e352b72bda208a8a07217b1f4f6a2791b846b11695792fbe23e8191d9b |

若 coordinator 事后另裁，恢复 manifest 哈希 d7e4d400… 一行即可回退并复跑聚焦+全量。

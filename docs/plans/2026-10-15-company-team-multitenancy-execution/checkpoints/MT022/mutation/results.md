# MT022 变异注入自证（8/8 捕获；pristine sha256 0c2d917d… 闭环）

靶模块：`server/src/enterprise/tenancy/conversation-actions.ts`（GREEN 终态，含 biome 格式化）。
流程 per 变异：注入 → `bun test tests/multitenancy/conversation-messages.test.ts` 聚焦 fail →
还原（cp pristine 副本）→ sha256 == pristine `0c2d917d904ab183…` 逐位一致 → 复绿 35/0/0。

| 变异 | 判定分支 | 注入 | 捕获用例（fail 数） | 证据 |
| --- | --- | --- | --- | --- |
| MUT1 | 公司成员谓词整体移除（status+epoch→true） | readMembershipFacts companyActive:=true | AC4 撤权链 10 例（control/suspension/restore/no-epoch-bump/AC2 revoke 面） | MUT1-injected.txt / MUT1-restore-sha.txt / MUT1-RESTORE-green.txt |
| MUT2 | 团队谓词移除（teamActive→true） | readMembershipFacts teamActive:=true | team-level MT007 suspension denies…; restore re-allows（2 fail，含五动作 denies 循环展开） | MUT2-* |
| MUT3 | 归属谓词 principal 臂移除（thread 面授权切片） | authorizeByThread 比对仅剩 workspaceId | AC1 同团队读写 22 例（same-team send/read/replay、byte-set、幂等、分页等） | MUT3-* |
| MUT4 | epoch 臂移除（仅留 status） | companyActive:=status==='active' | MT007 restore: old scope stays denied (epoch arm)（2 fail——restore 后旧 scope 复活被钉死） | MUT4-* |
| MUT5 | status 臂移除（仅留 epoch） | companyActive:=epoch===scope.memberEpoch | no epoch-bump dependency: suspended status alone denies…（2 fail——等 epoch 挂起态复活被钉死） | MUT5-* |
| MUT6 | canonical 码漂移（sendMessage deny 码改写） | notFoundVerdict() → {code:"CONVERSATION_NOT_FOUND"} | 单元素字节集断言族 18 例（cross-company/cross-team/ghost/same-team、canonical serialization describe） | MUT6-* |
| MUT7 | backend 门移除（platform-only 判定失效） | 条件改为永假 | backend gate: platform-only message plane…（2 fail——mastra 读写不再响亮拒绝） | MUT7-* |
| MUT8 | 幂等冲突臂移除（digest 比对失效） | existing.digest!==digest → false | same key with different content is message_conflict（2 fail——409 形状 + 零写入被钉死） | MUT8-* |

每个新判定分支 ≥1 变异：公司成员事实（MUT1/4/5 三臂分解）、团队事实（MUT2）、
归属谓词（MUT3）、backend 门（MUT7）、幂等冲突臂（MUT8）、canonical 不可见语义（MUT6）。
8 次还原后 pristine sha256 全部逐位一致；8 次复绿全部 35 pass / 0 fail / exit 0。

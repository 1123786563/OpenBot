# MT031 变异清单 — 变异自证（2026-10-17）

变异对象：`server/src/enterprise/tenancy/plugin-catalog.ts`（判定/写面的每道防线做外科手术式单点变异）。
流程：注入（单处替换）→ 聚焦套件复跑（`bun test tests/multitenancy/plugin-install.test.ts --timeout 60000`）→ 恢复 → sha256 校验与变异前逐字节一致。
运行器：`mutate-mt031.py`（已删，注入/恢复/校验闭环脚本；日志 `MUT-all-final.log`）。
聚焦套件终态：35 pass / 0 fail（变异轮后的 sanity 已单跑存档）。

| ID | 防线 | 变异 | 结果 | 证据（杀死用例组） |
| --- | --- | --- | --- | --- |
| MUT-1 | 团队成员资格防线 | decideInstall 团队成员检查改为恒真 | **KILLED** | 33/2 — 挂起团队成员用例 + 列表过滤用例 |
| MUT-2 | 公司成员资格状态防线 | decideInstall 公司成员 status 检查删除 | **KILLED** | 33/2 — 无 epoch bump 的停用变体（status 自身被判定层强制，不信任上游 epoch 纪律） |
| MUT-3 | epoch 对 scope 防线 | decideInstall epoch 比对删除 | **KILLED** | 34/1 — 停用后恢复 + stale scope 仍拒 |
| MUT-4 | 停用调用闸门 | invoke 的 status==='active' 闸门删除 | **KILLED** | 34/1 — AC3 停用后调用被拒 |
| MUT-5 | 卸载租户定界（模块 WHERE 层） | uninstall 的 WHERE 去掉 tenant_id | **SURVIVED（被 RLS 掩蔽，如实披露）** | 35/0 — FORCE RLS 的租户臂 DELETE 策略是同一防线的第二道独立实现：经模块（必须走受限 operator 通道）观测时两层行为逐字节相同，第二层结构性不可从公共 seam 单独杀死。两层均保留（纵深防御，credential-ownership revoke 同款）；模块 WHERE 层的语义由 AC3 跨公司卸载 no-op 用例与 RLS 层共同钉死 |
| MUT-6 | 供应商探针观测面 | notifyVendorCall 移到 deny 路径也触发 | **KILLED** | 21/14 — 全部 deny 后探针计数不变断言 |
| MUT-7 | 脱敏视图结构防线 | RedactedInstallView 注入 envelope 字段 | **KILLED** | 31/4 — assertRedactedShape 全路径行走 + canary 扫描 |
| MUT-8 | config 闭形模块防线 | 秘密载体键拒绝改为永不触发 | **KILLED** | 34/1 — 模块边界拒绝码断言（存储 CHECK 是独立的第二层，由 23514 用例单独钉死） |

零未被解释的存活变异。MUT-5 的存活属纵深防御两层的相互掩蔽（与 MT027 D8「advisory 锁序与并发不变量不变异」同类的诚实披露），非测试缺口：两层各自的存在分别由 AC3 行为用例（模块层）与 FORCE RLS/授权矩阵用例（存储层）独立钉死。

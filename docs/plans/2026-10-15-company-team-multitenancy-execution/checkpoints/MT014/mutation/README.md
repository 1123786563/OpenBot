# MT014 变异检查（4/4 被捕获）

靶向文件：`server/src/enterprise/tenancy/runtime-config.ts`。
Pristine SHA-256：`0a8bc3cd7863eda9f952fa5bfb96ffbffd854f9e0ebe98c11d87256544270f3d`
（`pristine-sha256.txt`）；每次变异前从 pristine 副本恢复，变异后同法恢复并复跑
（`RESTORE-sha256.txt` 与 pristine 一致，`RESTORE-green.txt` 29 pass / 0 fail / exit 0）。

| 变异 | 内容（对 pristine 的唯一改动） | 结果 | 被谁捕获 |
| --- | --- | --- | --- |
| MUT1 | 删除团队 allowlist 覆盖的公司子集校验（`OVERRIDE_WIDENS_POLICY` allowedModels 分支） | **捕获**（28 pass / 1 fail / exit 1） | 验收 2「an override adding a model outside the company allowlist is refused as policy widening」 |
| MUT2 | 删除个人凭据升级防线（`PERSONAL_CREDENTIAL_NOT_UPGRADABLE` 分支） | **捕获**（exit 1，2 例失败） | 验收 2「an override referencing a personal-access credential is refused…」+ 验收 3 canary 用例 |
| MUT3 | `deepFreeze` 移除冻结（只返回原值） | **捕获**（exit 1） | 验收 4「resolution never mutates its inputs…」中的 `Object.isFrozen` 断言 |
| MUT4 | 删除服务读取路径的事务本地 `app.tenant_id` 上下文行 | **捕获**（exit 1） | FORCE RLS 下公司配置行不可见 → 验收 1 全部解析用例失败（含跨公司 RLS 用例） |

诚实披露：

- MUT2 首次运行因执行脚本漏 `source` 测试库 env 产生一次全 skip 假跑
  （skip ≠ 通过；该次产物已被带 env 的有效捕获运行覆盖，文件内 exit=1 为准）。
  与 MT112 报告 §7.5 披露的同款操作事故，留档以示非掩盖。
- MUT4 的失败形态是「合法公司也读不到」（fail-closed 方向）：证明的是该行
  是 RLS 上下文的唯一来源，删除即不可用——这正确反映「读取路径必须经受限
  角色 + 事务本地上下文」是功能需求而非可选优化。

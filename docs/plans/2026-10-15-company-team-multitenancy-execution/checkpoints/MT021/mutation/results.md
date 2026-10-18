# MT021 变异测试结果（全部捕获；每次注入后跑聚焦套件，随后 pristine 逐字节还原）

pristine sha256: 5b6ed95fc5252ffce3e6cd667b5345f1ec08453eaf7b7d63c61f67495f790aed
还原复验：每次还原后 sha256 与 pristine 一致（各 MUT 日志末尾由运行脚本回显）。

| 变异 | 外科手术式替换 | 结果 | 捕获用例 |
|---|---|---|---|
| MUT1 | list+count 的 workspace 谓词移除（团队臂消失） | 捕获（exit 1，2 fail） | 验收 3：a1a2 双团队 scope 钉死 ×2 |
| MUT2 | list+count 的 principal 谓词移除（个人臂消失） | 捕获（exit 1，13 fail） | 验收 1 精确列表/计数/页并集、验收 3 撤权+切团队、验收 4 全链 |
| MUT3 | 游标钉 rows[limit]（第 limit+1 行）而非最后可见项——跳过下一行 | 捕获（exit 1，4 fail） | 验收 1 页并集收敛、验收 4 全页链×3 |
| MUT4 | companyActive 的 epoch 比对移除（仅 status） | 捕获（exit 1，1 fail） | 验收 3：暂停→恢复后旧 scope 仍被拒（epoch 独立防线，MT016 D4 先例） |
| MUT5 | 详情拒绝码漂移 RESOURCE_NOT_FOUND→RESOURCE_MISSING | 捕获（exit 1，2 fail） | 验收 2：canonical 逐字节同形 + 单元素字节集 |
| MUT6 | list 撤权 fail-closed 早退移除 | 捕获（exit 1，2 fail） | 验收 3：真实撤权后列表空页 + 恢复后旧 scope 空页 |

结论：6/6 捕获，0 存活。个人臂/团队臂/游标钉可见项/epoch 重验/canonical 语义/撤权 fail-closed
六条防线全部有独立可观察的测试证据。

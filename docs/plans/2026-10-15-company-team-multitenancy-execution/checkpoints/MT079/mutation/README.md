# MT079 变异检查（4/4 捕获 + MUT3 终字节复核）

pristine：`pristine-preferences.ts`（SHA-256 `6a8f2e25043d66a35ec142a6fba62451766ae26295ab29375ea7b255095edd4b`，见 `pristine-sha256.txt`）。
每次变异：perl 精准替换 → `diff -q` 确认与 pristine 有差异（未应用即中止，防假跑）→ 跑聚焦套件 → 还原 → SHA-256 与 pristine 逐字节比对。环境始终带专用库五变量（防 MT014 D5 / MT015 D4 式 skip 假跑）。

| 变异 | 靶向 | 结果 |
| --- | --- | --- |
| MUT1 `MUT1-read-filter-removed.txt` | `readGlobalPreferences` 去过滤（原样返回存储文档） | **捕获**：exit 1，17 pass / **6 fail**（验收 4 投毒读回、完整形状、非对象、__proto__、冻结确定性 + 数据库面投毒读回） |
| MUT2 `MUT2-unclassified-accepted.txt` | `parseGlobalPreferencePatch` 放行未分类键（fail-closed 拆除） | **捕获**：exit 1，21 pass / **2 fail**（未知键拒绝组、混合补丁全有或全无） |
| MUT3 `MUT3-digest-drops-scoped.txt` | 摘要输入丢掉 scoped 段（清单可核对性破坏） | **捕获**：exit 1，22 pass / **1 fail**（摘要重算一致性）；终字节复核（digest hex 钉死加入后）仍捕获：`MUT3-recheck-final-bytes.txt` 22/1 exit 1 |
| MUT4 `MUT4-business-key-in-global-list.txt` | 分类漂移：业务键 `defaultModel` 混进全局清单 | **捕获**：exit 1，18 pass / **5 fail**（键集结构同步、封闭值形枚举、classify 分类回答、digest 精确 hex 失配、摘要重算失配） |

还原后：`RESTORE-green.txt` 聚焦 23 pass / 0 fail，exit 0；`pristine-sha256.txt` 比对一致。

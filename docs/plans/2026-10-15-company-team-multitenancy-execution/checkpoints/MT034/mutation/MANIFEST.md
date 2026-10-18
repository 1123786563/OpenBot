# MT034 变异清单 — 8 KILLED + 3 单点掩蔽披露（同一防线的双臂已分别钉死）

模块：`server/src/enterprise/tenancy/shared-approvals.ts`（pristine sha256
b7786e0e74767e27c451c241dd105bb95716477e152d303867ed4c5e78bf011f，注入前存档
/tmp/mt034-module-pristine.ts；每次注入 → 聚焦捕获 → 字节复原 → sha256 -c 校验
→ 复绿 24/0）。聚焦套件终态 24 pass / 0 fail。

| ID | 变异点 | 结果 | 杀手（聚焦套件内） |
|---|---|---|---|
| MUT-1 | decideApproval 公司成员 status 防线移除 | **KILLED**（21 pass/1 fail） | 无 epoch bump 撤权用例（status 独立于 epoch 拦截；使用门 authorizeUse 断言） |
| MUT-2 | decideApproval epoch 防线移除 | **KILLED**（23/1） | 撤权→复权后旧 scope 用例（status 已 active、epoch 已漂移；复权不复活旧 scope） |
| MUT-3 | decideApproval paramsDigest 比对恒真 | 存活 → 掩蔽披露（见 D-1） | — |
| MUT-3b | 批准行查询 paramsDigest pin 移除 | **KILLED**（23/1） | AC1 参数漂移用例（旧批准行对漂移摘要不可见） |
| MUT-4 | 批准行查询 workspace pin 移除 | 存活 → 掩蔽披露（见 D-2） | — |
| MUT-5 | sharedApprovalParamsDigest 丢弃 members 维度 | **KILLED**（21/1） | digest 维度用例（members 翻转摘要） |
| MUT-6 | withdraw UPDATE 臂 status='pending' 移除 | 存活 → 掩蔽披露（见 D-3） | — |
| MUT-7 | decide 事务内 tenant_admin/epoch 重验移除 | **KILLED**（21/1） | 停用公司管理员后决定用例（SCOPE_REVOKED） |
| MUT-8 | request 对象归属 install workspace 检查移除 | **KILLED**（23/1） | 混搭对用例（本团队 Bot + 另一团队安装；Bot 臂放行时安装臂独立拦截） |
| MUT-9 | authorizeUse lease 判定 deny 臂移除 | **KILLED**（21/1） | 用途漂移 lease 用例（MT029 seam 用途臂拒绝必须传导为 canonical deny） |

## 掩蔽披露（设计性相互掩蔽，MT031 D6 同款；非测试缺口）

- **D-1（MUT-3 ↔ MUT-3b）**：参数摘要锁定由两道同义臂执行——批准行查询的
  `params_digest` 等值 pin 与判定核心 `decideApproval` 的逐字比对。任一单点
  变异被另一臂掩蔽（行为从公共 seam 观测逐字节相同）。两臂均保留（纵深防御）；
  查询臂被 MUT-3b 杀死证明其独立有效，判定臂的存在由该掩蔽运行本身证明
  （移除查询臂时判定臂独立拒绝）。
- **D-2（MUT-4）**：批准行查询的 `workspace_id` pin 与判定核心的
  `facts.bot.workspaceId !== scope.workspaceId` 模块检查互为掩蔽（AC2 双臂）。
  两臂均保留；掩蔽运行证明模块臂独立拦截团队切换。
- **D-3（MUT-6）**：withdraw 的模块 `status='pending'` 臂被 FORCE RLS 的
  `enterprise_shared_use_request_data_withdraw` 策略臂（USING 含同谓词）掩蔽
  ——经受限 data 通道观测两层行为逐字节相同，第二层结构性不可从公共 seam
  单独杀死。RLS 臂的存在与形状由 pg_policies 策略文本断言独立钉死
  （"the RLS policy arms carry the second defense line" 用例）。

## 未变异项（诚实披露）

- advisory 锁序与事务隔离（并发不变量，单线程观测不到；MT008/MT026/MT027/
  MT029 同不变异）。
- 复合外键的 23503 结构拒绝由超户探针行为用例直接钉死（structural probe），
  非行为分支变异。
- digest 的 sha256 算法本体（规范序列化的确定性由顺序无关用例与 64 位十六
  进制 CHECK 双重钉死）。

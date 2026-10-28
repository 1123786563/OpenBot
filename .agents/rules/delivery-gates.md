# 目标交付、条件核验与 GitHub 写入

推送/合并交付代码、关闭 Issue、添加或纠正验收标签时读取。本文件是这些动作的共同门禁；不新增任何提交、推送、合并、标签、重新打开或关闭授权。

## 目标与证据版本

- 摄取时登记原 Issue 的交付契约：规范仓库、远程身份、目标 ref、验收交付物和关闭授权依据。未约定时，OpenBot 的代码交付目标为 `1123786563/OpenBot` 的 `origin/main`；功能分支上的通过不能给 main 尚未交付的票贴标或关票。明确另约定 PR/分支为交付物时引用有权批准者的决定；回溯审计和每日审计采用同一含义。有权批准依据只能是当前用户覆盖该范围的明确决定，或已批准 Spec/ADR 中可核实且覆盖该范围的决策角色授权；GitHub 身份、维护者标签、Agent 自述或角色名称本身不构成批准。
- requirements_fingerprint 采用 requirements-v3，按 [指纹合同](fingerprints.md) 的精确输入 schema、规范身份、集合排序和 RFC 8785 JCS 的 UTF-8 字节计算 SHA-256。缺页或批准权限未核实时不能生成有效完整指纹；保留规范输入和来源，不只存哈希。v1/v2 仅作历史，完整 rescan 后重建 v3。敏感输入存已有授权的受保护位置，不能以脱敏文本、裸秘密哈希或无授权外部副本替代原需求。

- 将状态/关闭原因/资格标签另存为 `eligibility`，目标 ref 的完整 SHA、递归 gitlink 和交付树 manifest 另存为 `target`。本次预期改变的标签/状态在写入意图中列为允许差异，正文、关系、权限证据和代码不在允许差异内。
- 目标 SHA 上的 Required Checks/标准 CI 按 [testing.md](testing.md)核验。交付树、目标 SHA 或需求指纹变化后重新冻结并执行相关验收、完整独立终审及完整 OCR；旧报告只作历史或辅助证据，不能替代新树的完整终审/OCR。报告范围按 [review.md](review.md)对账。

## 推送/合并前的新鲜度

1. 持有 [共享协调声明](coordination-state.md)，核对目标远程 ref 当前 SHA 等于本轮预期值。在最新目标上构造实际待写入结果（含子模块），固定最终 tree、manifest 和可预知的写入标识，完成该 tree 的组合验证、完整终审、完整 OCR 和适用 CI。写后检查不能替代这些写前门禁。
2. 使用可核实的条件写机制，保证实际写入的 base、最终 tree 和交付内容与已审结果一致。普通 PR merge 的 head SHA 检查只保护 PR head，不证明 base 未前移；本地锁不约束其他写入者。没有等价条件写保证时不能用一次 fetch 后直接 merge/push 冒充门禁，也不得擅自强推或修改分支保护。

   merge queue 的入队与目标分支写入分开处理：已有入队授权时，允许先入队生成候选 merge group，再固定其 base、完整 SHA/tree 和 manifest，完成该候选的组合验证、完整终审、完整 OCR 及适用 CI。启用前须核实这些门禁能作为合入前的必需检查执行，并按 [testing.md](testing.md)核实 `merge_group` 调度；缺少门禁不得入队触发可能的自动合入。队列重建、成员/base 或候选 SHA/tree 变化时旧放行失效，重新审核实际候选。只有同一候选的全部门禁通过，队列才可写入目标；入队回执不表示 delivered，不授权关闭或贴标。其他批量合入机制也须在目标写入前审核其实际最终树；无法保证时保持 `integration_pending`。写前意图绑定实际候选，自动关闭仍须另满足下节要求。
3. 写后回读目标 ref、合并提交/树和检查状态，核对实际交付结果与写前意图。交付动作的 delivery_intent/delivery_action 和回执按 [协调格式](coordination-format.md)保存；写前 delivery_pending，意图匹配后 applied_valid，结果不明保持 pending。实际 tree 偏离已审 tree 属于交付门禁失效，动作记 stale：保存证据、将当前验证置为 `revalidating` 并禁止关闭/贴标；若代码已进入目标，delivery 可如实记 `delivered`，但不得伪装成尚未交付或验证通过。后续修复或回退仍须另有授权，不能把写后重验描述成原门禁已满足。

## 关闭/标签的写入意图与对账

1. 写前完成完整 rescan，在 Run 的 receipts 中持久保存唯一 `intent_id`：Issue、动作、操作者/授权引用、`requirements_fingerprint`、`target`、当前和预期 `eligibility`、验收/CI/终审/OCR/共享证据索引及哈希、逐资源 token/generation、创建时间。保存成功后才发出写入；仅在同一有效版本重试同一意图。已有标签也走同一有效性核验。
2. 尽量使用 API 条件写；API 不支持对需求和目标 SHA 的联合条件写时，写后必须再次完整 rescan 并读取实际标签、状态和关闭原因。除意图允许差异外，需求/批准权限、关系、目标 SHA、资格及 CI 必须与意图相符，才记 `applied_valid`。不得只凭标签存在或 closed 回读成功确认有效。
3. 失配立即将本动作记 `label_action=stale` 或 `close_action=stale`，撤销本次放行并保存前后差异；当前验证结论按 [协调格式](coordination-format.md)转为 `revalidating`，需求读取不完整时转 `intake_incomplete`，旧 verified 仅留历史。开始纠正后即使改记 `label_correction_pending` / `close_correction_pending`，也不得恢复旧 verified。唯一例外是失配仅由已核实的 `not_required` 或人审 approved/rejected 终态引起：动作仍 stale 并撤销放行，但保留与其需求/目标指纹相符的 Agent 验证结论，不制造重验循环；需求或目标本身失配不属于例外。按现有授权移除本动作产生的过期标签，或重新打开由本动作错误关闭且未被后续有权决定接管的票，随后同样对账。纠正必须核对归属及最新人工决定，不能覆盖后续授权操作；缺授权、API 失败或无法判定时明确远端可能仍有错误状态，不能报告成功。
4. 超时或回读不全先记 `label_pending` / `close_pending`，恢复时对账意图与远端，不盲目重复写入。每轮最多三次“读取稳定版本→写入/纠正→复核”；持续变化时保留 pending 和恢复条件。回读只能证明截至记录时的有效性，不保证未来不变化；后续由标签对账集合及恢复 Ledger 再核验。

## 自动关闭和人审证据

需要合并后验收的原票及新修复票统一使用 `Refs #…`，通过目标分支验收后按上述协议显式关闭。仅当有权批准者明确约定“合并即完成”、已有自动关闭授权，且合并机制能在写入前固定不可变的最终 SHA/tree、完成其全部验收与审查并持久保存自动关闭意图时，才使用 `Fixes`。merge queue 将产生尚未完成门禁的新 tree/SHA、无法预知自动关闭所绑定的最终写入标识、或交付契约需要合并后验收时，一律使用 `Refs`，不能先自动关闭再补证据。记录例外及相同的写后对账/纠正责任。

添加待人审标签前，维护者必须能通过已授权渠道读取脱敏验收矩阵、目标 SHA、命令/结果、终审/OCR 和 finding 裁决。先以接收方权限验证证据入口和哈希，按 [artifacts.md](artifacts.md)登记保留责任；仅存在本机 `.archive/` 时保持 `label_pending`（reason=`evidence_not_shared`）。

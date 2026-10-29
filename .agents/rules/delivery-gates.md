# 目标交付、条件核验与 GitHub 写入

推送/合并代码、关闭 Issue、添加/纠正验收标签时读取；不新增提交、推送、合并、标签、重开或关闭授权。

## 普通交付与机器协调的边界

普通单 Agent 沿用 [execution.md](execution.md)档位，一份交付记录保存需求来源/版本、授权动作、预期/实际目标SHA/tree、验证/审核及写前意图/写后回读即可，无须专门Run、v3指纹或调度状态机。共享资源、Orca、关闭票审计/每日自动化另执行机器字段与协调合同。

所有路径均保留新鲜度、条件写、目标CI、写后核对和不误关票；审核/OCR及补审按 [review.md](review.md)，交付本身不升档。

## 目标与证据版本

- 摄取登记规范仓库/远程、目标ref、交付物和关闭授权。默认 `1123786563/OpenBot` 的 `origin/main`；功能分支通过不证明main已交付。改约PR/分支交付须有 [design.md](design.md)认可的有权决定，审计也按原契约，不以GitHub身份/角色名推定批准。
- 机器需求指纹按 [fingerprints.md](fingerprints.md)生成requirements-v3，存规范输入/来源；旧版须完整rescan后重建，缺页/权限未核不能生成有效完整指纹。敏感输入按 [artifacts.md](artifacts.md)受控保护。
- 状态/关闭原因/资格标签存eligibility，完整SHA/递归gitlink/交付树manifest存target。意图只允许本次预期标签/状态差异，不允许正文、关系、权限证据或代码变化。
- 目标CI按 [testing.md](testing.md)；需求/目标变化按Review核影响、承接/补验，影响不明完整重验。专用完整终审/OCR继续适用，报告覆盖可对账。

## 推送/合并前的新鲜度

1. 共享/编排路径先持有 [协调声明](coordination-state.md)，普通隔离路径核写入归属。核远程ref当前SHA等于预期，在最新目标构造实际最终结果（含子模块），固定tree/manifest/可预知写入标识，完成适用组合验证、审核/OCR和CI；写后检查不替代写前门禁。
2. 用可核实条件写保护base、最终tree和交付内容。PR head检查不保护base，本地锁不约束外部写者；一次fetch后直接merge/push不构成保证，也不授权强推/改保护。无等价机制保持integration_pending。

   merge queue已有入队授权且确认合入前必需门禁/merge_group调度可用时，可入队生成候选；随后固定其base/SHA/tree/manifest并完成候选全部适用门禁。重建、成员/base/SHA/tree变化先撤旧放行，再按Review补审/补验；同一候选全通过才可写目标。缺门禁不得入队触发自动合入，入队不等于delivered或关闭/贴标授权。其他批量合入也先审核实际最终树；意图绑定候选，自动关闭另遵下节。
3. 写后回读ref、提交/tree及checks，与意图对账。机器用 [coordination-format.md](coordination-format.md) 的delivery_intent/action/回执，普通记录同等信息：写前delivery_pending，匹配applied_valid，不明保持pending。实际tree偏离则动作stale、验证revalidating、禁关闭/贴标；已进入目标仍如实记delivered。回退/修复另核授权，写后补验不能冒充原门禁满足。

## 关闭/标签的写入意图与对账

1. 写前按 [issue-delivery.md](issue-delivery.md)完整rescan。普通路径记录同等意图/失效/待纠正结果，无须加载机器Schema；机器在Run receipts持久保存唯一intent_id、Issue/动作、操作者/授权、需求指纹/target、当前/预期eligibility、验收/CI/审核/OCR/共享证据索引与哈希、逐资源token/generation、时间。落盘后才写，同一意图仅在同一有效版本重试；已有标签也核验。
2. 优先API条件写；不支持需求/目标联合条件写时，写后再次完整rescan并读取实际标签/状态/关闭原因。除允许差异外，需求/批准权限、关系、目标、资格、CI全部匹配才applied_valid，标签存在/closed回读不单独证明有效。
3. 失配将label/close动作stale、撤放行、存前后差异，验证转revalidating，摄取缺失转intake_incomplete。开始纠正后不复活旧verified。**仅label/close因已核实not_required或人审approved/rejected终态失配、且需求/目标指纹仍匹配时，保留原Agent验证结论以避免重验循环；delivery动作stale及需求/目标失配均不适用。**
4. 按已有授权移除本动作的过期标签，或重开本动作错误关闭且未被后续有权决定接管的票，再对账；核归属和最新人工决定，不覆盖后续授权操作。缺授权/API失败/无法判定，保留对应correction_pending并说明远端可能错误。超时/回读不全保留label_pending/close_pending，恢复先对账，不盲重写。

每轮最多三次“读取稳定版本→写入/纠正→复核”；持续变化保留pending/恢复条件。回读仅证明截至该时点，后续由标签对账集合/恢复Ledger继续核验。

## 自动关闭和人审证据

需合并后验收的原票/新修复票用 `Refs #…`，目标验收后显式关闭。仅有权约定“合并即完成”、已授权自动关闭，且写前能固定最终SHA/tree、完成全部验收/审查并持久保存自动关闭意图时，才用Fixes。队列产生尚未验候选、最终写入标识不可预知或契约要求合并后验收时仍用Refs；例外同样写后对账/纠正。

待人审标签前，以接收方权限核脱敏验收矩阵、目标SHA、命令/结果、适用审核/OCR、finding裁决的入口/哈希，按产物规则登记owner/保留期。仅在本机归档时保持label_pending（evidence_not_shared）。

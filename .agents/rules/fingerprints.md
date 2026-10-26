# 指纹 v3 输入合同

需求冻结、每日恢复及写入意图使用本合同；入口为 [交付门禁](delivery-gates.md) 与 [协调格式](coordination-format.md)。精确字段、类型及可空范围以本地 [输入 schema](fingerprints.schema.json) 为准，拒绝未知字段；[固定向量](fingerprints-vectors.json) 提供合成输入、规范字节及 SHA-256。它不证明测试样例具备真实批准权限。

## 规范化和身份

1. Issue identity 统一为已核实的小写 host/owner/repo#十进制编号，无前导零；别名解析按协调格式。ref 为完整 refs/heads/...；SHA 小写完整值。先将所有字符串 CRLF 转 LF，保留其他字符，尤其不做 Unicode NFC/NFKC 或空白裁剪。
2. 语义集合去重并按以下键的 UTF-8 字节序升序排列：issues/dependencies 按 identity；sources/decisions/evidence 按 id；contains/depends_on/supersedes 按元素；authorization 按 kind、reference、scope；conditions 按 kind、subject。相同键不同内容拒绝，完全重复合并；同一条件需要多个判断时使用不同 subject。issue 字段中的 decisions 同样按 id 排序。
3. 必填数组无元素使用 []；仅 schema 明确允许时使用 null，缺字段与 null 不可混用。输入经 schema 和语义核验后以 RFC 8785 JCS 编码、UTF-8 无 BOM、无结尾换行计算 SHA-256。普通 JSON sort_keys 不作为通用 JCS 实现，数字编码及字符串键排序必须符合 JCS；适配器须用标准及项目向量验收其实现。

## requirements-v3

issues 包含 root 及全部 contains 递归子项，不把外部依赖误作本轮实施范围。title/body 为原版本内容；acceptance 保存该版本验收原文，无法确定验收边界时保持摄取缺口。decisions 保存有效决定的稳定 ID、作者、范围、针对版本指纹、时间、approval_ref 和权限依据；authority.reference 指向可核实的当前用户决定或未失效的委托批准事实，content_sha256 绑定该依据完整版本。状态为 approved 本身不足以生成 authority。

sources 为所有有效 Spec/ADR/CONTEXT 及 approval 来源的版本指纹、批准与替代链；被部分替代的条款以稳定条款 ID 登记 supersedes。approval 来源可为受控的 Issue/PR 决定或当前用户批准记录，按稳定 ID 和完整版本指纹登记；其 approval_ref/authority 可为 null，但使用它的 decision/source 必须具备可核实 authority，不递归要求对批准记录本身再批准。context 可无批准元数据（approval_ref/authority=null），Spec/ADR 必须核实批准及完整替代链，关联的批准来源也进入来源清单。dependencies 保存全部相关外部依赖状态与接口证据指纹；无接口时 interface_sha256 对具名“无接口依赖”证据对象求值，不填写假零。policy_sha256 为 Run 实际适用策略 manifest 的内容哈希。缺页、未核实权限、关系或来源版本冲突时不生成有效完整 requirements 指纹。

## daily-input-v3

保存规范 Issue、需求/策略指纹、有效授权及范围、目标仓库/ref/SHA、依赖状态/接口指纹、脱敏环境配置指纹、证据可访问性与条件观测值。target.ref 必须为完整 ref；repository 为协调格式的规范身份。尚未摄取完成时，requirements_sha256、target 各项或 environment_sha256 可为 null，表示等待输入，不能承认为 verified。conditions.source_ref 指向含观测来源和完整性哈希的不可变回执；非条件数据的时钟、心跳、updated_at、随机 Run ID 不进入输入。目标 SHA 是当前审计 epoch/交付契约的实际目标，不用无关新 main SHA 替换它；是否仍能对当前 main 放行另走交付门禁。

敏感原输入按产物规范存受保护位置；外部只给受控引用，不能把脱敏对象的哈希当原指纹，也不能外露可猜测秘密的裸哈希。v1/v2 输入不靠换算法名称升级，必须重新摄取并生成满足本合同的 v3 对象。适配器上线验收至少覆盖固定向量、空集合、CRLF、非 ASCII、null、数字边界、集合乱序、重复身份、跨仓库关系和受保护来源；相同有效输入必须生成相同字节/指纹。

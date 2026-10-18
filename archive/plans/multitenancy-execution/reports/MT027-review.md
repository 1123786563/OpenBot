# MT027 独立复审报告 — 连接凭据与站点登录归属（Issue #70）

- 复审者：独立 Pi 会话（Orca task_2e783f63583a / dispatch ctx_3b73c1d07b3d），全新上下文，未参与两任实现
- 复审对象：`checkpoints/MT027/sha256-manifest-2nd.txt` 划界的 8 个代码文件 + 全部存档
- 复审性质：**语义 + 等价性**（coordinator 已在复审前将 MT027 随波次 11 集成进基线，共享文件存在后续漂移，见 §2）
- 结论先行：**PASS（附 1 条不影响判定的口径备注，见 §7）**——MT027 可转 verified

## 0. 复审环境与独立复跑（全部亲测，非采信存档）

| 项 | 结果 |
| --- | --- |
| `bun install --frozen-lockfile` | 1415 包安装成功 |
| 端口预检 55526 | 空闲 |
| 容器 | `mt027-review-pg`（pgvector/pgvector:pg16，127.0.0.1:55526，trust），测毕 `docker rm -f` 回显 `mt027-review-pg`、deletion check=0（coordinator 可亲验） |
| env | 七变量（TEST_DATABASE_URL、ENTERPRISE_TEST_SETUP_DATABASE_URL、ENTERPRISE_TEST_{DIRECTORY,DATA,OPERATOR}_DATABASE_URL、MT003_ASSIGNED_TEST_DATABASE_URL、KB_TEST_DATABASE_URL）0600 用后已删 |
| base migrate | `enterprise-test-db.ts migrate` → `{"type":"migrations-applied","status":"ok"}` |
| 依赖链 | MT004→MT008→MT112→MT012→MT014→MT010→MT009→MT077→MT026→MT076→MT069→MT016→MT041→MT027 全部 applied；journal 14 任务，MT027=2 步 |
| 聚焦 `credentials-ownership.test.ts` | **38 pass / 0 fail / 0 skip** ✓ |
| 全量 `tests/multitenancy/` | **770 pass / 0 fail / 29 文件 / 0 skip**（含 kb-ownership 套件 27 用例真实在跑，单独复跑 27/0/0 确认非 skip）✓ 与 brief 预期逐位一致 |
| typecheck（server，tsc --noEmit） | 0 错误 ✓ |
| biome 2.5.10 触及 8 文件 | 新 7 文件全 clean；唯一残留 = src/index.ts 4×noConsole(@837/862/882/1871) + 1×noNonNullAssertion(@4736)，行号与第 2 任 08-biome-final-2nd.txt 逐一吻合，均为 BASE 既有欠账（D4 核实成立），零新增 ✓ |
| 活库抽查（psql 直查） | 三表 relrowsecurity=t 且 relforcerowsecurity=t；table_privileges 恰 10 行与设计矩阵逐格一致（directory 零授权、data: SELECT/SELECT/INSERT、operator: S+I+U / S+I+D / S）；pg_policies 恰 10 条与 0002 一一对应 ✓ |
| 清理 | 容器销毁回显 + deletion check=0；env/临时脚本全删 ✓ |

## 1. 边界核对：manifest vs 本树哈希

- **新 4 文件哈希逐一复算，与 manifest 完全一致**：enterprise-credentials.ts `b14a0683…`、credential-ownership.ts `9aca2543…`、credentials-ownership.test.ts `121445b2…`、support/credentials-ownership.ts `3a8252b1…` ✓
- **src/index.ts 与 manifest 一致**（`9c31684d…`）——装配文件自第 2 任收尾后未被任何波次再动 ✓
- 共享 3 文件漂移，逐一定性见 §2（漂移均为后续波次纯追加，MT027 交付语义完好）：
  - schema/index.ts：本树 `bf2fe972…` ≠ manifest `1b0c6434…`
  - migrate-test.ts：本树 `03b1da57…` ≠ manifest `ba725403…`
  - migration-tool.test.ts：本树 `a962bd06…` ≠ manifest `1a531771…`

## 2. 共享文件漂移定性（等价性核验）

1. **schema/index.ts**：从 git 不可达对象中找回 MT027 收尾像（sha256 复验=`1b0c6434…`），与本树 diff = 仅两行纯追加 `export * from "./enterprise-bot-ownership"`（MT016）与 `export * from "./job-ownership"`（MT041），均落排序位；MT027 的 `./enterprise-credentials` 行原样未动，排序位正确（enterprise-conversations 与 enterprise-expert-versions 之间，第 19 行）✓
2. **migrate-test.ts**：用工具自身算法对本树代码复算 MT027 planDigest = `ab50bf11598984c806755dab61129e0bbe0d1d8598a5e1450a85d51c425bfbc1`，与 manifest.json 逐字节一致；两步骤 statementDigest（`679f0e54…`/`ab723159…`）亦一致——**MT027 任务块（11+25 语句）在漂移文件中逐字节未变**（漂移 = TASKS 表后续任务注册，纯追加）✓
3. **migration-tool.test.ts**：allowlist 现含 15 条含 "MT027"，MT027 条目 + ruling #5 第 12 次裁决注释原样在位；漂移 = 后续 MT016/MT041 波次的同类预授权追加 ✓

## 3. 重点裁决 A——四条验收逐条（38 用例构成实测核对）

用例计数（聚焦套件实测 + 逐用例读源）：AC1=8、AC2=13、AC3=5、AC4=4、存储契约=8，合计 **38** ✓

- **AC1（个人凭据仅本人）**：两 kind（site-login/connection）各自钉死属主放行；同团队他人、跨团队同事、双团队成员、（兼任 A1 团队成员的）公司管理员四个负向全部 canonical `RESOURCE_NOT_FOUND`，且测试断言 deny 与 randomUUID 幽灵 ID **逐字节同形**（`toEqual(DENY_NOT_FOUND)` + 幽灵/跨司互等）✓
- **AC2（按动作授权 + 明文独立授权 + 审计）**：成员资格必要不充分、'use' 行绝不蕴含 disclose（use 放行后 disclose 仍 deny）、'disclose' 行独立开启且恰好 +1 行审计、撤销行立即失效、团队/公司成员停用立即关闭（含 **无 epoch bump 变体**——纵深防御不依赖上游纪律）、revoked 对所有人生效 ✓
- **AC3（跨公司不可见 + 零供应商调用）**：公司 B scope 对 A 的个人/团队/公司三类凭据 use+disclose 全 deny 且 `not.toHaveProperty("envelope")`（deny 结构上无可执行物）；vendorProbe 只在 allow 分支 `execute()`，跨公司尝试后计数不变（=0 断言）；跨公司披露零审计行；跨公司归属行直插被复合 FK 判 **23503**（真实 SQL 注入用例）；幽灵 ID 与跨公司 ID 判定互等 ✓
- **AC4（零泄露）**：`RedactedCredentialView` 类型上无 envelope/plaintext 字段，`assertRedactedShape` 全路径行走 SECRET_CARRIER_KEYS；MemoryVault 信封**逐字包含明文**（`v1:<plaintext>`）——任何信封泄漏必被抓，canary 全输出路径（列表/详情/幽灵 deny/非法注册/非法动作）零命中；列表计数对照断言（a2 只见 t2+c1、b1 只见自己）不泄露跨范围存在性；披露结果键集合钉死为 `["auditId","outcome","plaintext"]` ✓

## 4. 重点裁决 B——双通道事务形状

- admin=`assertOperatorDatabase(operator)`（register/revoke/grantAction/revokeAction），decisions=`assertDataDatabase(data)`（authorizeUse/disclosePlaintext/listVisible/describeCredential），构造时即拒绝未验证通道（有专项用例）✓
- 事务形状与 resource-policy.ts **逐行同形**（亲 diff 对照）：`read committed` → `lock_timeout='2s'` → `statement_timeout='5s'` → 事务本地 `set_config` 四变量 → advisory 共享锁键序 tenant→principal→membership→workspace-membership→credential（credential 键在 readFacts 内、于前四键之后获取，全局键序保持）✓
- 真实 RLS 读事实：跨公司凭据行对本事务不可见即"不存在"，应用层租户/成员比对为第二道防线 ✓
- 装配（index.ts）：decisions=data 通道；admin=operator 通道，缺 `enterpriseOperatorDatabaseUrl` 或 verify 失败 `.catch(() => null)` → `admin=null` **fail-closed**（与 MT010 personalShareRules 同款纪律），decisions 不受影响 ✓

## 5. 重点裁决 C/D——三表 DDL、迁移与 vault 接线

- 行形 CHECK `(classification='team')=(workspace_id is not null) and (classification='personal')=(owner_principal_id is not null)`：三态互斥自洽，有 4 个 23514 直插负向用例 ✓
- 复合 FK 内嵌 tenant（workspace/owner/actions.principal/actions.granted_by），跨公司归属结构性不可能 ✓
- 0001=11 语句、0002=25 语句逐条 expand-only（我按语句逐一数过并比对 checkpoint SQL：CREATE×3、FK×6、INDEX×2；REVOKE/ENABLE/FORCE/POLICY×10/GRANT×6），audit 对任何角色无 UPDATE/DELETE（append-only 有 42501 用例）✓
- planDigest `ab50bf11…` 本树复算一致（§2）✓
- vault 代码级核实：`seal=encryptSecret(config.keyEncryptionKey,…)`、`open=decryptSecret(…)`，二者为 credentials.ts 既有 AES-GCM envelope（crypto.subtle，iv+ciphertext JSON 信封）；明文只在 `disclosePlaintext` 的 allow 路径 `vault.open`，且与审计写入同一数据事务；vault 失败抛 `CREDENTIAL_SECRET_UNAVAILABLE`、不回显信封 ✓

## 6. 重点裁决 E/F——TDD 链、变异重放与 import 重排

**E. TDD 链与变异**
- RED-1（模块缺失型，0 pass/1 fail `Cannot find module`）、GREEN-1/2（第 1 任 37 用例）、GREEN-3/4（第 2 任 38 用例）存档链完整；+1 用例（接管处置 D2）与全量 675→676 自洽 ✓
- D1 属实：02-baseline.txt 实测 638/0/0/**25 文件**并对 brief 的"23 文件"口径差异如实披露 ✓
- D3 属实：第 1 任 biome 存档过期（support 文件其后仍有 format 违规）被第 2 任发现并修复——我本次 biome 复跑 support 文件 clean，为最终态证据 ✓
- **变异独立重放 3/3 全部 KILLED，pass/fail 计数与 -2nd 存档逐一吻合**：
  - MUT-2（personal isOwner 恒 true）→ **32 pass/6 fail**（存档 32/6）✓
  - MUT-5（删除 revoked 一票否决）→ **37 pass/1 fail**（存档 37/1）✓
  - MUT-8（readFacts disclose 子查询被 `='use'` 冒充）→ **34 pass/4 fail**（存档 34/4）✓
  - 每次注入→聚焦→恢复均以规范哈希 `9aca2543…` 校验闭环，恢复后 sanity 聚焦 38/0/0 ✓
- MUT-4 特殊性（D7，变异对象为迁移声明、在专用 mut4 库验证 42501）与 D8（并发不变量不单线程变异）处置合理 ✓

**F. index.ts 27 hunk 等价性——机械证明**
- 从 git 不可达对象找回 **bac27c45 前像**（MT027 before-hashes 逐字节复验一致），实测 before→after diff **恰好 27 hunks**（与 brief 数字吻合）
- 对前像执行 `biome check --write`（format+import 排序），所得文件与本树的 diff **仅剩 3 处 = MT027 的三点真实新增**：①`./credentials` import 追加 `decryptSecret, encryptSecret` 两 specifier；②新增 credential-ownership import 块（排序位正确）；③追加 credentialOwnership 装配段
- 即：**全部 27 hunk = 24 个 biome 规范化 hunk（纯排序/换行，零手工改动）+ 3 处新增**。"重排零语义变化"成立，且存量 lint 6+1→4+1 的成因（organize-imports 修复 2 处）与残留 4+1 的 BASE 归属均核实 ✓

## 7. 备注（不阻塞判定）

- **N-1（口径）**：brief"重点裁决 D"称 planDigest `ab50bf11` 需复算——已复算一致；但 brief 亦提示的" prereq 213 项"基线集成不在本票 manifest 边界内，本复审以 manifest+before-hashes 划界完成，基线集成质量由 coordinator 的批终验（770/0/0/29，我已独立复现同数）覆盖，无冲突。
- 复审期间除本报告外未新建/修改任何仓库文件；变异注入均在受控恢复闭环内完成，8 个边界文件终态哈希与复审前逐一一致。

## 8. 判定

**PASS。** 四条验收全部有真实 RLS/受限角色下的测试钉死且全绿（38/0/0）；双通道 fail-closed、事务形状与先例同形、三表 DDL/FORCE RLS/最小授权矩阵经活库独立抽查证实；TDD 链与变异证据经独立重放核实（3/3 killed 计数吻合）；index.ts 重排经前像重建 + biome 规范化对照完成零语义机械证明。MT027 建议转 **verified**。

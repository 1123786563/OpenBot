# MOD04 实施计划（#624：封装现有身份发现与对象动作准入 Interface）

冻结于 2026-10-24，编排者依据 Issue #624 正文 + 架构四分册（module-catalog §2/§3、interface-contracts C01/C02）+ 集成 HEAD `26787bfce` 代码事实。原则：**只移动文件/只封装现有行为，需要适配时才写代码**。

## 0. 代码事实（@26787bfce 实测）

- 检查器 moduleRoots **已预置目标分组**：`server/src/auth|identity|people → M01 business`；`server/src/enterprise/authz|tenancy|contracts.ts|wire-schema.ts → M02 business`。新文件落目录自动归属，组内 import 零例外。
- 依赖规则（module-catalog §1）：M02→M01 允许；**M01 不静态引用 M02**（跨模块事实经装配注入）。
- 现判定链内件（本票全部**零改动**、仅被委托）：
  - `enterprise/tenancy/store.ts`（614 行）：`createScopeResolver`（有效公司+团队成员资格验证后签发受信 Scope）、`assertTrustedScope`、`requireAuthenticatedIdentity`、`createResourceReader`；
  - `enterprise/tenancy/scope-gate.ts`（148 行）：`createWorkspaceGate` → `WorkspaceGate.transaction`（事务内重验两级成员资格，撤权后下一事务即拒，advisory 锁序 tenant→principal→membership→workspace-membership→resource）；
  - `enterprise/authz/service.ts`（57 行）：`createAuthz().check`（本地确定性 read 判定，tenancy-v1）；
  - `enterprise/tenancy/resource-policy.ts`（398 行）：ResourcePolicy registry（tenancy-v1/workspace-v1）与 DecisionService；
  - M01 侧：`auth/index.ts`（775）、`identity/store.ts`（605）、`people/`。
- 迁移链路选定：**openmuse-tasks 家族**——`enterprise/tenancy/openmuse-task-tenancy.ts`（1017 行）以注入 `gate: WorkspaceGate`（:462）消费内件（`gate.transaction` :943），装配于 runtime.ts :5104 一带；是真实在产链路（/api/mobile/openmuse-tasks 路由族）且有存量测试。
- 反例矩阵存量：`server/tests/multitenancy/` 有 scope-gate/revocation/resource-policy/entry-context/openmuse-private-bot/openmuse-tasks 等 100+ 套件（撤权交错、同团队私有对象、伪造组织既有覆盖）。

## 1. owned_files（冻结）

| 文件 | 权限 |
| --- | --- |
| `server/src/auth/public.ts` | 新增全权（M01 门面） |
| `server/src/enterprise/authz/public.ts` | 新增全权（M02 门面） |
| `server/src/enterprise/tenancy/openmuse-task-tenancy.ts` | 迁移链路改接（WorkspaceGate 依赖 → Access 门面） |
| `server/src/assembly/runtime.ts` | 仅必要接线调整（链路装配点） |
| `server/tests/multitenancy/identity-access-public.test.ts` | 新增全权 |
| `tests/config/module-imports.json` | 预期零 delta；如有必须逐条论证 |

**零改动预期**（除非适配必须且先报告）：scope-gate.ts、tenancy/store.ts、authz/service.ts、resource-policy.ts、auth/* 与 identity/* 与 people/* 既有文件、enterprise/contracts.ts。全仓其余只读。

## 2. 目标形态

### M01 门面 `server/src/auth/public.ts`

- 能力名沿用 interface-contracts 候选名（**不取代现有签名**）：
  - `currentIdentity(input)`：当前身份事实（稳定 ID/当前事实；登录不要求公司资格）——委托 identity/people 现有读取；
  - `discoverMemberships(input)`：本人资格发现（公司/团队成员事实）——**只输出事实，不输出"可读全部内容"推论；选择器不直接赋权**。
- 约束：只 import M01 组内文件（auth/identity/people）；需要的企业目录事实经**构造注入**（deps 参数），无 M01→M02 静态 import；零缓存、零新判定逻辑、零写入。

### M02 门面 `server/src/enterprise/authz/public.ts`

- 能力名：
  - `resolveContext(input)`：解析可信业务上下文——委托 `createScopeResolver` 签发半边；
  - `authorizeAction(input)`：对象动作核验——委托 `createAuthz().check`/ResourcePolicy DecisionService 现判定；
  - `runInScope(scope, operation)`：事务重验——**封装现有 `WorkspaceGate.transaction`**（C01 明示：迁移期先封装、不替换事务协议；锁序/advisory 键/set_config 语义逐字节不动）。
- 约束：M02 组内 import 自由，可 import M01；门面 = 薄委托层，零新策略逻辑；`changeGrant` 能力**不在本票**（只迁读取/准入链路）。

### 迁移链路

openmuse-task-tenancy.ts 的 `gate: WorkspaceGate` 依赖改为消费 M02 门面（`runInScope`），装配点（runtime.ts）相应改为构造/注入门面。链路行为逐字节等价（门面内委托到原函数）。

## 3. 测试（`server/tests/multitenancy/identity-access-public.test.ts`，e2e-compat 根入口；DB 需求最小化）

1. **委托等价**：门面方法与直调内件结果逐项相等（M01 事实读取、M02 resolve/authorize/gate 各至少正例+反例）。
2. **验收 1 形状钉**：currentIdentity/discoverMemberships 返回类型不含授权语义字段；选择器不赋权（结构断言）。
3. **验收 2 反例**（无 DB 可达部分）：同团队私有对象拒绝、伪造 scope 拒绝——经门面走通原判定；DB 交错类（撤权后新动作、scope 切换迟到）**复用存量套件证据**（scope-gate/revocation/resource-policy/openmuse-private-bot 复跑绿 + 引用），不重复造库。
4. **验收 3**：runInScope 路径 = 原 WorkspaceGate.transaction（同锁序；引用存量 scope-gate 测试 + 委托等价）。
5. **验收 4**：门面零写入面断言（无 insert/update 调用点——结构/grep 级）。
6. openmuse-tasks 存量套件复跑绿（链路迁移后行为不变）。

## 4. 验证门

checker（预期零例外 delta；新文件 M01/M02 组内自动归属）、typecheck（恰 3 条存量）、覆盖审计（26 缺口零新增、新文件 native 计入）、§3 全绿、存量抽检（scope-gate/revocation/resource-policy/openmuse-tasks/openmuse-private-bot）。

## 5. 边界与风险

- 若发现迁移链路接线需触及冻结零改动文件 → 停下报告，不静默扩权。
- 若 M01 门面确需企业目录事实而注入面过大 → 报告并给出最小注入设计，不引入静态跨模块 import。
- 存量红/审计 26 缺口/typecheck 3 条维持不修不扩。

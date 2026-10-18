# MT099 改动逐项披露（工作树态；零 git 提交）

## 本票新增（1 文件）

| 文件 | sha256 | 内容 |
|---|---|---|
| `desktop/src-tauri/src/credential_namespace.rs` | 063ae9c05bcdb2d0390529317f4ef547ed288bb3775f2f930aa4ca43f81c0b97 | 组织凭据命名空间域：派生名 `OPENBOT_ORGANIZATION.<sha256(authority)>.<CREDENTIAL>`；`is_personal_credential` 个人闭集；`organization_vault_name`（authority 归一 + 凭据名 `[A-Za-z0-9_]{1,64}` + 个人名拒绝）；`org_remember/org_recall/org_forget`；`org_credentials` 枚举；`forget_organization`（只清目标组织 + 匹配指针退役）；`set_current_organization`/`current_organization`（平铺标识指针，非秘密）；测试 ns1–ns16 |

## 本票修改（4 文件；before 哈希 = MT098 报告值 / prereq 转移值）

### 1. `desktop/src-tauri/src/lib.rs`（b75f3e6f → 902fa8a3）
- 纯追加一行 `pub mod credential_namespace;`（字母序插入）。无其它改动。

### 2. `desktop/src-tauri/src/organization_auth.rs`（25042fca → 3214bab3）
- `SavedSession`：derive 增加 `Clone, Debug, PartialEq, Eq`（测试钉归属用；行为零变化）。
- `saved(root, expected)`：函数体改为一行委托 `recall_session`（签名/语义不变）。
- 新增 `pub(crate) fn recall_session(root, expected)`：命名空间槽位优先
  （`org_recall(expected, SESSION)`）；miss 时读 legacy 平铺 `SAVED_COOKIE`，authority
  逐字匹配才迁移入命名空间（org_remember + set-if-absent 指针 + forget legacy）；不匹配
  原样 None、legacy 条目不动。
- 新增 `pub(crate) fn store_session(root, authority, session)`：序列化后写发起 authority
  的命名空间槽位 + 落「当前组织」指针。
- `finish()`：写入点由 `vault::remember(root, SAVED_COOKIE, …)` 改为
  `store_session(root, &run_authority, &session)`（仍受既有「pending 仍是本 run」守卫约束；
  `run_authority` 改为 clone 进 session 以便借用）。
- 测试模块追加 5 例（`credential_namespace_*` 前缀 + `saved_session`/`encoded_session`
  fixture helper）。既有 10 例测试零改动。

### 3. `desktop/src-tauri/src/org_context.rs`（8ec7e2cd → bf24c03c）
- `VerifiedConnection`：derive 增加 `Debug`；文档行更新。
- `VerifiedConnection::recall(root)`：读法由「平铺 `SAVED_COOKIE` 直读」改为「当前组织指针
  → 该组织的命名空间会话（`auth::recall_session`）」；指针缺失返回 None（与 MT098 无会话
  语义一致）；损坏条目 fail-closed（Organization 连接错误，绝不回退）。
- 测试模块追加 1 例 `t33_recall_reads_the_session_of_the_organization_the_installation_
  actually_stored`（含损坏 fail-closed 断言）。既有 t1–t32 零改动。

### 4. `desktop/src-tauri/src/main.rs`（f515e24a → f515e24a）
- **零字节改动**（命令层签名的消费面未变；before=after 哈希一致，见 before/after-hashes）。

## 环境令牌整改（披露，wave14 整改 §2 同款先例；详见 verification/06）

| 文件 | before（prereq-manifest） | after（工作树） |
|---|---|---|
| `server/tests/multitenancy/entry-context.test.ts` | d7e4d400a5e6d270efe4eb006f7252f7cc2ae695c459f3105eb1d2b2cda1e948 | 3667a2e352b72bda208a8a07217b1f4f6a2791b846b11695792fbe23e8191d9b |

- 唯一改动：库名钉死断言 `openbot_enterprise_w14int` → `openbot_enterprise_w15c_test`
  （本票 brief 钉定库名；断言语义不变——专库+受限 data 角色+绝不回退开发库）。
- 冻结面复核：268 项 prereq 中 267 项 sha256 逐位一致，唯一差异即上表（已披露）。

## 窄缝授权说明（migrate-test.ts / migration-tool.test.ts / schema index）

- **零改动**：本票无服务端迁移任务注册（范围裁定见 design.md §0，ask 升级无应答后按票面
  自身范围执行 A；若 coordinator 另裁 B 再补）。迁移链 = 19 前置任务，journal 34 步与
  wave14 集成基线一致。

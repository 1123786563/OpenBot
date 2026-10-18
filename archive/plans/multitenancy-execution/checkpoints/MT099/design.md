# MT099 design — 桌面凭据组织命名空间域（Issue #142）

角色：backend_implementer（wave 15）。BASE f0520524 + 268 项 prereq（复算 0 mismatch）。
TDD RED→GREEN→REFACTOR；零 git 提交；交付未提交工作树 + checkpoints/MT099/ + reports/MT099.md。

## 0. 范围裁定（披露）

- 票面 Verification = `cargo test --manifest-path desktop/src-tauri/Cargo.toml credential_namespace`；
  Scope boundary = 「凭据命名空间隔离、个人 provider 连接与 OAuth state 绑定 authority；不含上下文门控实现」；
  交付面 = 「桌面凭据组织命名空间域」。三处一致指向**纯桌面 Rust 面**（MT098 桌面票先例）。
- brief 迁移配方「本票任务最后」一行按字面需要有服务端迁移任务，与上述三处矛盾。已按
  交付纪律 `orca orchestration ask`（msg_c50bbdbbf6bf）升级，两次 resume 等待共 12 分钟
  无应答。按票面自身范围执行 A（纯桌面）：**不注册 MT099 服务端迁移任务**（无服务端存储
  面，迁移链到 MT059 为止，journal 34 步与 wave14 一致）；bun 基线 1124/0/43 复现并保持
  全绿（回归=基线，无新增 bun 测试）。若 coordinator 事后裁定 B，再补服务端面。
- AC2 的「公司付款方」语义在桌面面落地为：org 命名空间结构性没有个人 provider 凭据槽位
  （org_remember/org_recall 对个人凭据名闭集一律拒绝）——个人连接既进不了公司业务凭据
  空间，也永不被公司侧解析。服务端「公司调用只落公司付款账户」已由 MT069（显式类型 +
  映射派生）+ MT070（无客户输入通道 PAYER_ACCOUNT_FIXED）钉死并在 bun 基线内全绿。

## 1. 现状（MT098 转移基线）

- 桌面凭据库 = vault（`desktop/src-tauri/src/vault.rs`）：`<root>/.secrets/<NAME>.secret`
  （macOS/Linux owner-only 0600 文件；Windows DPAPI `<NAME>.dpapi`）。API：
  `remember/recall/forget(root, name[, value])`，名字是唯一寻址。
- 个人 provider 凭据 = 平铺 vault 名闭集：`vault::is_secret`（INTELLIGENCE_API_KEY、
  OPENAI_API_KEY、ANTHROPIC_API_KEY、CLAUDE_CODE_OAUTH_TOKEN、各服务令牌…）+ 
  `saved_intent::COMPATIBLE_CREDENTIAL`（OPENAI_COMPATIBLE_CREDENTIAL）。Start/Ask 流按
  显式键名列表读写，从不触及组织条目。
- 组织会话（MT098）= 平铺 vault 名 `OPENBOT_ORGANIZATION_SESSION`（单槽：换 authority 即
  不可见但旧值仍在/被覆盖）；组织上下文 = 平铺名 `OPENBOT_ORGANIZATION_CONTEXT`（只含
  标识符，T25 金丝测试钉死无秘密字段）。
- OAuth state（MT098）= `organization_auth::Pending{authority, state, verifier,…}` 单槽，
  回调 state 逐字核对、finish 只向发起 authority 兑换；「换 sign-in 即取消旧 pending」。

## 2. 票面验收 → 实现面

| # | 验收 | 实现面 |
|---|---|---|
| AC1 | 组织凭据与个人 provider 凭据分命名空间存储，互不可读 | 新模块 `credential_namespace.rs`：组织命名空间 = 由归一 authority 派生的 vault 名前缀 `OPENBOT_ORGANIZATION.<sha256(authority) urlsafe>.<CREDENTIAL>`。个人面 = 既有平铺闭集（零改动）。互不可读是结构性的：个人键名列表永远构造不出组织名；`org_recall` 对个人闭集名直接拒绝；同 CREDENTIAL 名在两个 authority 下互不可见 |
| AC2 | 个人连接不会被当作公司付款方或公司业务凭据使用 | `org_remember/org_recall` 拒绝 `is_personal_credential` 闭集名（INTELLIGENCE/OPENAI/ANTHROPIC/CLAUDE_CODE_OAUTH_TOKEN/COMPATIBLE_CREDENTIAL）：组织命名空间不存在任何个人 provider 槽位——公司业务凭据必须是组织专名（如 COMPANY_*），既不能由个人凭据冒名，也不能覆写个人凭据。付款方面见 §0 披露 |
| AC3 | OAuth state 与恢复绑定发起 authority；回调期间切换组织不改变归属 | `organization_auth.rs`：会话存储改经组织命名空间（credential 名 `SESSION`）。`finish` 把完成的会话写入 **pending 的发起 authority** 槽位（`store_session`）；`saved(root, expected)` 只恢复 expected 自己的槽位（`recall_session`），legacy 平铺条目仅在 authority 逐字匹配时读出并迁移入命名空间。回调 state 核对（既有）+ 单槽 pending 替换取消（既有）保证回调期间的切换不改写归属；新测试以「A 完成、B 在位」矩阵钉死 A/B 互不覆写 |
| AC4 | 命名空间清理只影响目标组织（与切换清理 Ticket 一致） | `forget_organization(root, authority)` 只枚举并删除目标 authority 前缀的 vault 条目；反向测试钉死其他组织条目与全部个人凭据逐字幸存。MT100（切换清理）消费本入口 |

## 3. 新文件与改动面

**新文件（1）**
- `desktop/src-tauri/src/credential_namespace.rs` — 组织命名空间域：
  - `SESSION_CREDENTIAL = "SESSION"`（组织会话在本域的专名，organization_auth 消费）。
  - `is_personal_credential(&str) -> bool`：个人 provider 凭据名闭集（vault::is_secret ∪ COMPATIBLE_CREDENTIAL）。
  - `organization_vault_name(authority, credential) -> Result<String, Problem>`：确定性派生名（`organization_auth::authority` 归一；credential 名 1..=64 且 `[A-Za-z0-9_]`；拒绝个人闭集名）。
  - `org_remember / org_recall / org_forget(root, authority, credential[, value])`。
  - `org_credentials(root, authority) -> Result<Vec<String>, Problem>`：本 authority 的条目名（字典序）。
  - `forget_organization(root, authority) -> Result<Vec<String>, Problem>`：只清目标组织，返回被删条目名。
- 测试同文件 `mod tests`（路径含 `credential_namespace`，票面过滤可选中）。

**改动文件（2，均为本票消费面，diff 逐项披露）**
- `desktop/src-tauri/src/lib.rs` — 纯追加一行 `pub mod credential_namespace;`。
- `desktop/src-tauri/src/organization_auth.rs` — 会话存取三点换到组织命名空间：
  `saved()` → `recall_session(root, expected)`（命名空间优先，legacy 平铺条目 authority 匹配时迁移）；`finish()` 写入点 → `store_session(root, run_authority, &session)`（写入前保留既有「pending 仍是本 run」守卫）。新增 `credential_namespace_*` 前缀测试（AC3 钉死）。

**明确不改**
- `org_context.rs`（逐字节不动）：冻结上下文是**非秘密标识记录**（T25 金丝钉死无秘密字段），
  是「本安装当前冻结在哪个组织」的指針，不是凭据；继续按 MT098 平铺持久。
- `main.rs` / `vault.rs`（逐字节不动）：命令层签名与 vault 机制零改动。
- 服务端全部文件（除 §4 一处环境令牌整改披露）与迁移链：零改动、零新迁移任务。

## 4. 环境令牌整改（披露，wave14 同款先例）

`server/tests/multitenancy/entry-context.test.ts` 库名钉死 `openbot_enterprise_w14int` →
`openbot_enterprise_w15c_test`（brief 钉定本波库名；票面钉死他波令牌与本树不相交，与
wave14 整改说明 §2 同构）。断言语义不变。before/after 哈希见 verification/06。

## 5. 验证门槛

- bun 基线：1124/0/43（已复现，verification/00）；票后全量回归 = 1124/0/43（无新增）。
- cargo：基线 719/0（verification/07）；票后 `cargo test` 全绿；票面过滤
  `cargo test credential_namespace` 全绿 0 skip。
- typecheck：bunx tsc --noEmit = 0；biome 触及文件 0（本票未触及 ts/ts 文件——除 §4 整改
  一处，照样跑 biome 复核）。
- 变异自证：≥4（MUT-1 个人名拒绝移除；MUT-2 派生名去 authority 哈希；MUT-3 清理越界
  （清掉全部组织前缀）；MUT-4 恢复不核对 authority），注入→聚焦捕获→字节复原→复绿，
  results 落 mutation/。
- 收尾：docker rm w15c-pg 并回显；/tmp/w15c-env.sh 删除并回显；after-hashes 复核
  （268 项中仅 §4 披露一项 + 本票两个 rust 面 + 新文件）。

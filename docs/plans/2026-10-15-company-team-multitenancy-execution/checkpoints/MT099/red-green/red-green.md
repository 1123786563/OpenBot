# MT099 RED→GREEN 全程（cargo 面）

命令基线：`cargo test --manifest-path desktop/src-tauri/Cargo.toml`（聚焦则加过滤器）。

## Round 1 — credential_namespace 域（AC1/AC2/AC4 + 校验边界）

- **RED-1**（`red-green/RED-1-credential_namespace.txt`）：新文件
  `desktop/src-tauri/src/credential_namespace.rs` 测试先行（ns1–ns14 共 14 例），函数体
  `todo!()`。聚焦运行 **0 passed / 14 failed**，全部 `not yet implemented: MT099 RED-1`
  ——失败原因是能力缺失，非编译错误/笔误。
- **GREEN-1**（`GREEN-1-credential_namespace.txt`）：实现派生名（`OPENBOT_ORGANIZATION.
  <sha256(authority)>.<CREDENTIAL>`）、org_remember/recall/forget、枚举、清理、个人名
  闭集拒绝、authority 归一校验。聚焦 **14 passed / 0 failed**。

## Round 2 — organization_auth 会话命名空间缝（AC3）

- **RED-2**（`RED-2-session-seam.txt`）：organization_auth 测试新增 4 例
  （`credential_namespace_*` 前缀，票面过滤可选中），引用尚不存在的
  `store_session`/`recall_session`。编译失败 **E0425 ×10**（7×recall_session、3×
  store_session）——缝缺失的编译期红（MT069 RED-2 同款口径）。
- **GREEN-2**：实现 `recall_session`（命名空间优先；legacy 平铺条目 authority 逐字匹配
  才迁移）与 `store_session`（写发起 authority 的命名空间槽位）；`finish()` 写入点改为
  `store_session(root, &run_authority, &session)`；`saved()` 委托 `recall_session`。
  聚焦 **18 passed / 0 failed**（14+4）。

## Round 3 — 当前组织指针 + 生产连接存储面（AC3 恢复/切换一致性）

- **RED-3**（`RED-3-current-org-pointer.txt`）：ns15/ns16（指针往返归一 / 清理只退本组织
  指针）+ organization_auth `credential_namespace_a_stored_session_makes_its_authority_…`。
  编译失败 E0425 ×8；指针实现后行为红 1 例（store_session 未落指针，FAILED）。
- **GREEN-3**：`set_current_organization`/`current_organization`（平铺标识指针，非秘密）；
  `store_session` 落指针；legacy 迁移 set-if-absent；org_context `VerifiedConnection::
  recall` 改经指针→命名空间会话（t33 钉死，含损坏条目 fail-closed 断言）。
  聚焦 **21 passed / 0 failed**（credential_namespace 过滤）。

## 收敛

- 全量 cargo：**741 passed / 0 failed**（基线 719 + 本票 22 = 16 namespace + 5
  organization_auth + 1 org_context t33）。
- 票面命令：`cargo test … credential_namespace` → **21 passed / 0 failed / 0 skipped**。
- 全量 bun 回归：**1124 pass / 0 fail / 43 文件**（=基线，本票零新增 bun 测试）。

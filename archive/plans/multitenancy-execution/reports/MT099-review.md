# MT099 独立复审报告（只读复审 + 独立复跑 + rust 变异抽验）

角色：独立复审者。树=r15-mt099（BASE f0520524 + 272 项冻结面 [268 prereq + rust 四文件基线
b75f3e6f/f515e24a/25042fca/8ec7e2cd] + 增量 5）。复审对象：reports/MT099.md +
checkpoints/MT099/。复审者全程零 git 提交；工作树 entry/exit 哈希逐位一致；变异重放为唯一
源码触点（字节复原，见 §4）。

## 0. 结论

**通过（PASS，带 3 条记录级备注，无阻塞项）。**

- 票面四条 AC 全部在结构面与行为面独立确认，测试独立复现全绿。
- 环境独立复现：bun 基线 **1124/0/43**、票面 cargo **21/0（579 filtered）**、全量 cargo
  **741/0**——三组数字与实现者报告逐字一致（含 12799 expect() 计数）。
- 变异抽验 3/3 KILLED（含指定的 MUT-5/MUT-4），字节复原后聚焦复绿。
- 冻结面 272 项独立复算：差异恰为披露的 4 项（3 rust 修改 + entry-context 令牌）。
- diff 范围核对升级为**密码学级**：MT098 基线内容从本仓库 git 检查点提交 d5c169e3 完整取回
  （四文件哈希与 MT098 报告值逐位一致），三修改文件的精确 diff 与 changes.md 披露逐 hunk
  一致，**无夹带**（证据 checkpoints/MT099/review/exact-diff-*.patch）。

## 1. 环境与验证门槛独立复现（三步配方）

复审环境：容器 mt099-review-pg（pgvector/pgvector:pg16 @ 127.0.0.1:55590 loopback-only）、
bun 1.4.2 / cargo 1.97.1、`bun install`（1415 packages）；两套库名各跑独立迁移链
（enterprise-test-db.ts migrate + 19 任务 generate+apply，journal 均 19 任务/**36 步**，
与实现者 chain-journal.txt 逐任务步数一致）；七变量 env 0600 用后删。

| 门槛 | 实现者票面 | 复审复现 | 判定 |
|---|---|---|---|
| bun 基线（w15c_* 名，Run B） | 1124/0/43，12799 expect() | **1124/0/43，12799 expect()** | 一致 |
| Run A（复审 brief 配方 r15e_* 名） | — | 1123/1，唯一 fail=entry-context 环境令牌钉死 | 与整改说明预测一致（见 §5） |
| 票面 cargo 过滤 credential_namespace | 21/0，579 filtered | **21/0，579 filtered**（bin 目标 0/150 filtered 同） | 一致 |
| 全量 cargo | 741/0（基线 719+22） | **592+149=741 passed / 0 failed**（lib 600 中 8 ignored、bin 150 中 1 ignored） | 一致 |
| typecheck / biome | 0 / 0 | bunx tsc --noEmit exit 0；biome 触及文件 exit 0 | 一致 |

新/旧测试计数口径核对：增量 22 = ns1–ns16（16）+ organization_auth credential_namespace_*
（5）+ org_context t33（1）；基线 741−22=719 与 verification/07 一致。

## 2. diff 范围核对（无夹带——密码学级证据）

检查点提交 d5c169e3（及同内容 6c4c34f8/f7e8513c）包含四 rust 文件的 MT098 基线，哈希与
before-hashes.txt/MT098 报告值逐位一致；据此取回基线全文做精确 diff：

| 文件 | 基线→现值 | 精确 diff 内容 | 与 changes.md 披露 |
|---|---|---|---|
| lib.rs | b75f3e6f→902fa8a3 | 仅 +1 行 `pub mod credential_namespace;`（changes-lib.diff 中另一行 +org_context 为 MT098 自身增量，含于基线） | 一致 |
| organization_auth.rs | 25042fca→3214bab3 | derive+MT099 注释、saved() 一行委托、recall_session/store_session 新增、finish() 写入点改 store_session（run_authority.clone()），测试模块 +2 helper+5 测试 | 逐 hunk 一致 |
| org_context.rs | 8ec7e2cd→bf24c03c | VerifiedConnection 文档行+Debug derive、recall() 改指针→命名空间、+t33 | 逐 hunk 一致 |
| main.rs | f515e24a→f515e24a | `diff -q` 零差异（git status 的 M 为 stat 假阳性，内容逐位同） | 一致 |
| credential_namespace.rs | （新）063ae9c0 | 单模块+ns1–ns16，路径含票面过滤词 | 一致 |

既有测试零改动：organization_auth 基线 6 例、org_context t1–t32（32 例）在精确 diff 中零
触碰。

## 3. 专项核对（AC1–AC4 + 披露）

- **AC1 互不可读（结构+行为双层）**：结构层=组织条目存 `OPENBOT_ORGANIZATION.<sha256(authority
  urlsafe)>.<CREDENTIAL>` 派生名，个人面=平铺闭集（vault::is_secret ∪ COMPATIBLE_CREDENTIAL），
  ns5 钉死两集合名字空间不相交、个人读取列表构造不出组织名；行为层=ns2（跨 authority 互不可
  见+第三方全盲）、ns3（个人读取面解析不到组织条目，唯一地址=派生名）、ns8（组织写入后个人凭
  据逐字节不变）。聚焦复绿中全部通过。✔
- **AC2 无个人 provider 槽位（闭集拒绝+零值回显）**：`organization_vault_name` 在任何 vault
  写入前拒绝 `is_personal_credential` 闭集名；拒绝句为静态文案（ns6 注入 "impersonal" 断言拒
  绝句不含该值、personal 名与派生名双无落盘；ns7 断言 org_recall 拒绝句不回显 secret 且个人
  凭据原值幸存）。✔
- **AC3 OAuth state 绑定发起 authority**：归属由两道既有守卫+新存储面共同钉死——token 兑换
  携 pending 的 state/verifier 且仅发往 `run_authority`；verify 后终检
  `run.state == run_state && run.root == root`（被替换的 sign-in 在此被拒，落盘前拦截）；
  `store_session` 只写 pending 自身 authority 的命名空间槽位（A 完成后 B 完成不覆写 A 槽位，
  指针随完成移动而 A 会话原地幸存——completion matrix 两例+MUT-5 指针承重）；恢复
  `recall_session(expected)` 只读 expected 槽位，legacy 平铺条目 authority 逐字匹配才迁移
  （MUT-4 钉死不匹配绝不采纳）。**时序用例真实性备注**：B-在-A-存储时完成的用例在存储缝直接
  调 store_session 模拟交错，未驱动两条真实 finish() 线程；回调期间切换的拦截本体是**未改动**
  的 MT098 pending 守卫（其自身测试仍在且全绿），新增测试如实标注「the storage face of that
  pinning is this write」。判定：披露诚实、结构成立，不构成缺陷。✔
- **AC4 清理只影响目标组织**：`forget_organization` 按 `ORGANIZATION_PREFIX+hash(authority).`
  前缀枚举删除，仅当指针==目标归一 authority 时退役；ns9（B 槽位+全部个人凭据幸存）、ns10
  （幂等）、ns11（org_context 记录+legacy SAVED_COOKIE 逐字幸存）、ns16（指针范围双向）；
  MUT-2 证明哈希范围即隔离边界。✔
- **changes.md 逐项披露**：见 §2，四文件全部一致；entry-context 令牌整改见 §5。

## 4. 变异抽验（3/3 KILLED；含指定 MUT-5/MUT-4）

流程每例：源文件备份→注入→聚焦 cargo→字节复原（sha256 逐位核对）→聚焦复绿 21/0。
复审前哈希=实现者 after-hashes 值；收尾三文件哈希逐位复原（3214bab3/063ae9c0/bf24c03c）。

| # | 注入 | 聚焦捕获 | 结果 |
|---|---|---|---|
| MUT-5 | store_session 不落「当前组织」指针（改 `Ok(())`） | credential_namespace_a_stored_session_makes_its_authority_the_installations_current | KILLED（20/1） |
| MUT-4 | recall_session legacy 恢复不核对 authority（`if false &&`） | credential_namespace_a_legacy_session_of_another_authority_is_never_adopted | KILLED（killer 与实现者所指完全一致） |
| MUT-2 | namespace_hash 常量化（跨组织隔离失效） | ns2/ns4 等 | KILLED（15/6） |

## 5. 冻结面核对（272 项）

268 项 prereq-manifest 逐项复算：**267 项逐位一致，唯一差异=entry-context.test.ts**
（d7e4d400→3667a2e3，与 after-hashes 一致）；rust 四文件基线 3 改 1 同（§2）。合计 272 项
中 4 项差异，全部在披露清单内。

**令牌整改（已披露）的复核与残留边界**：before 内容（d7e4d400）不可恢复（全 git 历史无该
文件内容，MT122 交付为未提交工作树），故该文件无法做字节级 diff 核对。缓解链：(a) 库名链有
两段独立文档先例——wave14-integration.md §3-2 与其 manifest.txt 记录同文件 w14e→w14int
「1 处断言+注释」整改，MT099 为同款第三段（→w15c_test）；(b) 现内容全树仅 1 处令牌钉死
（line 191，断言+相邻注释），断言语义=专库+ob_ent_data 受限角色；(c) 行为证明——Run A
（r15e 名）恰 1 fail、Run B（w15c 名）全绿，文件表现与纯库名钉死完全一致。残留风险≈注释措
辞级，不构成行为夹带。**Run A 同时证明该整改是承重墙**：不整改则基线必 1 fail，与整改说明
「1123/1」预测一致。

## 6. 记录级备注（不阻塞）

1. **prose 数字两处失准**（证据文件本身正确，报告/changes 行文有误）：(a) changes.md 称
   organization_auth「既有 10 例测试零改动」——基线实际 **6** 例（精确 diff 证实 6 例零触
   碰，结论不受影响）；(b) reports/MT099.md、changes.md、design.md 称 journal「34 步」——
   实现者自己的 chain-journal.txt 与复审两套独立链均为 **36 步**（19 任务）。
2. **expect() 计数波动**：Run B 首跑 12802、复跑 12799（=实现者值）；环境条件分支所致，测
   试数/文件数不变， informational。
3. **AC3 时序用例为存储缝模拟**（§3，披露诚实，建议后续票如触及回调面可补双 finish() 交错
   集成例；非本票义务）。

## 7. 证据索引

checkpoints/MT099/review/：README.md（证据说明）、bun-runA-r15e.txt、bun-runB-w15c.txt、
cargo-full.txt、pre-mutation-hashes.txt、exact-diff-{lib,organization_auth,org_context}.patch、
typecheck.txt、biome.txt。实现者证据 checkpoints/MT099/ 未被复审改动。

环境收尾：容器 mt099-review-pg 已删除；/tmp/mt099-review/env.sh（0600）与源文件变异备份已删；
工作树零残留、零 git 提交。

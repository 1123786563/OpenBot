# MT042 变异检查（mutation checks）——诚实披露

目的：按 design §6 变异计划（MUT1–MUT12），对 `server/src/enterprise/runs/scan-executor.ts`
的每条安全语义分支做真实变异，要求每分支 ≥1 条用例变红；全部 12 条均被捕获。
检测口径：`bun test tests/multitenancy/scan-executor.test.ts`（15 用例，未过滤全文件）。

执行方式：每条变异以最小 diff 打在生产文件上 → 跑聚焦套件 → 存档输出 →
`git checkout` 字节复原 → sha256 复核（原哈希
`27d675b619b3c16355702e2982d90bd75acc1c95c32043f0866558b36e20f57d`，即 checkpoint
提交 `3ee2c549` 的 HEAD 内容哈希）。**每轮复原后哈希逐一比对全部相等**；全部
12 轮结束后终态哈希再比对其乐一致（见 verification/17–20 与 reports/MT042.md）。

## 变异 → 检测（全部存档于本目录）

| 变异（打在 scan-executor.ts） | 语义（design §6） | 实测 | 存档 |
| --- | --- | --- | --- |
| MUT1：认领 RETURNING/条目加入 payload | AC1 扫描面泄漏载荷 | **exit 1，2 fail**（AC1 元数据断言 + AC2 canary） | MUT1-payload-leak-TEST-FAILS.txt |
| MUT2：pin 缺失改为捏造 facts 继续 | AC2 重建=权威行 | **exit 1，1 fail**（AC2 ghost 期望 SCAN_RECORD_MISSING） | MUT2-rebuild-without-pin-TEST-FAILS.txt |
| MUT3：`assertTrustedMachineIdentity` 移除 | AC3/AC4 机器信任门 | **exit 1，2 fail**（AC3 用户身份驱动 + AC4 clone 驱动） | MUT3-trust-gate-removed-TEST-FAILS.txt |
| MUT4：`dev-local-user` 拒绝移除 | AC3 机器≠用户登录 | **exit 1，1 fail**（AC3 is-not-a-user-login） | MUT4-dev-local-user-allowed-TEST-FAILS.txt |
| MUT5：`app.scan_sweep` 上下文不设 | 策略臂悬空=跨公司不可见 | **exit 1，8 fail**（AC1/AC2/租约/撤权全红） | MUT5-sweep-context-unset-TEST-FAILS.txt |
| MUT6：成功不 `finishJobLease` | 租约纪律（完结） | **exit 1，3 fail** | MUT6-no-finish-lease-TEST-FAILS.txt |
| MUT7：失败不 `releaseJobLease` | 租约纪律（释放） | **exit 1，1 fail**（lease-retry 的 claimedBy 断言） | MUT7-no-release-lease-TEST-FAILS.txt |
| MUT8：gate 事务移除（回调 tx=undefined） | MT005 门是执行前提 | **exit 1，5 fail** | MUT8-gate-removed-TEST-FAILS.txt |
| MUT9：他人活租约不跳过（继续执行） | 双重执行防护 | **exit 1，1 fail**（lease-held 跳过用例） | MUT9-held-lease-executed-TEST-FAILS.txt |
| MUT10：签发拒绝被无视（手造 untrusted scope 继续执行） | 撤权成员仍被拒 | **exit 1，2 fail**（公司级+团队级撤权用例） | MUT10-issuance-bypass-TEST-FAILS.txt |
| MUT11：jobKind 封闭词表校验移除 | key 解析卫生 | **exit 1，1 fail**（malformed 用例，2→1 条拒绝） | MUT11-kind-vocab-unchecked-TEST-FAILS.txt |
| MUT12：拒绝结局回显原始队列 key | 零回显 | **exit 1，1 fail**（malformed 用例 JSON 回显断言） | MUT12-refusal-echoes-key-TEST-FAILS.txt |

## 披露（非缺陷，但必须记录）

1. **MUT7 第一次尝试无效已重写**：首版把 `try {` 误替换成 `if (false) {`，产生语法
   错误（模块加载失败，0 pass / 1 error）——那是「编译失败」不是「语义捕获」，已废弃。
   存档中的 MUT7 文件是重写后的有效变异（空 try 体）跑出的真实捕获。
2. **MUT11 依赖本轮的测试增强**：既有 malformed 用例的无 colon key 不会走到 jobKind
   词表校验（在 `separator <= 0` 处提前返回），MUT11 在原套件下**不会**被捕获。本轮在
   该用例中追加一条「语法合法但 jobKind 越词表」的 offer（`widget:<id>`），使封闭词表
   语义被钉住后 MUT11 才被捕获。该增强在**未变异**的基线套件上为绿（15/0）。
3. **聚焦套件在变异前的基线是本轮亲跑的 15 pass / 0 fail**（见
   verification/13、18），而不是 red-green 存档里的历史数字——原因见 reports/MT042.md
   「与存档链的偏差」（AC1 用例在 checkpoint 提交中带参数错位缺陷，历史 15/0 无法在
   提交态复现；本轮已修复该测试缺陷并全量重跑）。

## 还原与终态

- 每轮变异后 `git checkout` + sha256 逐一比对 = `27d675b6…`（12/12 全部相等）。
- **还原的权威证据 = 全量未过滤套件**：verification/17-restore-full-regression.txt
  **1005 pass / 0 fail，39 文件，exit 0**；verification/18-restore-focused-green.txt
  **15 pass / 0 fail，exit 0**。
- typecheck exit 0（verification/19）、biome exit 0（verification/20）。
- 冻结面 5 文件哈希与 after-hashes.txt 逐一相等（无变异残留）；生产文件工作树字节
  与 `git show HEAD:…` 一致。

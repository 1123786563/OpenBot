# Task Brief S01：无 hostname 的无登录配置拒绝启动

- **Task/AC**: S01 / A01。正式 Issue：[#490](https://github.com/1123786563/OpenBot/issues/490)（本地票 `docs/tickets/upstream-openbot-update/issues/up01.md`）。
- **owner_role**: backend_implementer（你）。validator/reviewer 由主控另行派发，不由你担任。
- **工作区**: `/Users/wuyongjun/trea/OpenBot/.worktrees/upstream-openbot-update`，分支 `upstream-openbot-update`，BASE `3b4a7c68`。所有命令在此目录执行；不得 cd 到主 checkout。
- **依赖检查点**: S00 已完成（ledger.md §5）。before 快照已存 `evidence/s01/before-status.txt`、`before-tracked.diff`（当前生产区干净）。

## 事实源（最小集）

1. Spec 行为：`docs/specs/2026-10-20-upstream-openbot-adoption-design.md` §2 第 1 条——"single-user 地址分类先解析并归一 hostname；hostname 为空视为不可接受的公开/未知地址，不能按无点单标签名识别成私网"。
2. 票据验收：`issues/up01.md` criteria（真实配置加载入口验证；错误可读不带凭据；合法 localhost/loopback/私网继续启动；已配置认证 provider 保持原优先级）。
3. 上游参考（只读，不整文件复制）：`docs/plans/2026-10-20-upstream-openbot-refactor/evidence/upstream-sources/server/src/config.ts` 的 `reachOf`（约 :555）——上游修复为归一化后 `if (!bare) return "public";`。本地与上游文件已大幅分叉（本地有 Casdoor/billing/multitenancy 等），**只移植该行为，不重写文件**。
4. 本地现状：`server/src/config.ts:698` `reachOf`；空 hostname 会落入文件末尾"无点单标签名按 LAN 名"分支被判 private。相关既有测试块在 `server/tests/config.test.ts` :578 起（"a public URL" / "an address that is not a URL at all" / "a home LAN address" 等）。

## owned_files（只允许改这些）

- `server/src/config.ts`
- `server/tests/config.test.ts`

`server/tests/single-user.test.ts` 只作回归运行，**不得修改**；若认为必须改，停下写进报告由主控裁决。

## 要求（RED→GREEN→REFACTOR）

1. **RED**：在 config.test.ts 现有 base fixture/参数化块上扩展，分别对 `OPENBOT_PUBLIC_URL`、`OPENBOT_APP_URL`、`TRUSTED_ORIGINS` 提供 hostless 输入并断言 single-user 模式拒绝启动。至少覆盖：`example.com:3010`、`localhost:3010`、可解析但 hostname 为空的 scheme 形态（如自定义 scheme）。先运行命令证明新用例真实失败。
2. **边界（必须通过）**：`http://localhost:3010`、`http://127.0.0.1:3010`、既有合法私网 URL（192.168/10.x 等）继续允许；已配置 OAuth provider 时保持原优先级（provider wins）；普通带 host 的公网 URL 拒绝行为不变。
3. **GREEN**：最小修复——hostname 归一后为空字符串时按 public/不可接受处理；`loadConfig` 及 `reachOf` 签名不变；不重写 IP 分类、不动认证 provider 优先级。拒绝错误信息可读、不含凭据。
4. 运行验证（ADR 0008 native 层）：
   `E2E_UNIT_SCOPE=server bunx e2e run --config e2e.unit.config.ts server/tests/config.test.ts server/tests/single-user.test.ts`
   记录实际执行的用例数与结果；不得只跑内部函数单测代替配置加载入口验证。

## 禁止范围

- 不修改 `server/src/config.ts` 中与本行为无关的段落；不迁移/重命名任何导出。
- 不 git commit / stash / push；不修改 docs、ledger、其他任务文件。
- 不把 fixture 写成真实凭据（本任务无秘密）。

## 报告

写 `docs/plans/2026-10-20-upstream-openbot-refactor/evidence/s01/implementer-report.md`：改动摘要（文件+行数）、RED 失败证据（命令+输出摘录）、GREEN 通过证据（命令+用例数）、自查清单（对照本 brief 逐条）、任何偏差与理由。完成后回信摘要。

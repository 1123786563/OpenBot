# S01 Implementer Report：无 hostname 的无登录配置拒绝启动

- 执行角色：backend_implementer；日期 2026-10-20。
- 工作区：`.worktrees/upstream-openbot-update`（分支 `upstream-openbot-update`，BASE `3b4a7c68`）。
- Git 绑定：改动时 HEAD = `3b4a7c68`（Add orca-dag-wave3 issue DAG orchestration plan and dispatch state）；工作区仅 `server/src/config.ts`、`server/tests/config.test.ts` 两个 tracked 文件被修改（`git status --short` 仅有这两个 `M`，其余 `??` 为本计划预先存在的未跟踪 docs）。未 commit、未 stash、未 push。

## 改动摘要

| 文件 | 改动 |
| --- | --- |
| `server/src/config.ts` | +5/-1 行（`reachOf` 归一化后新增 `if (!bare) return "public";` 一行修复 + 对应文档注释扩写 4 行） |
| `server/tests/config.test.ts` | +21 行（refuse 参数化表新增 4 个 hostless 用例；still-runs 表新增 1 个带 host 的移动 scheme 边界用例） |

修复与上游 `evidence/upstream-sources/server/src/config.ts` 的 `reachOf` 逐字一致：归一化（去括号/尾点）后 hostname 为空即按 `public` 处理，不再落入文件末尾"无点单标签名按 LAN 名"分支被判 `private`。`reachOf` / `loadConfig` 签名未变；IP 分类、认证 provider 优先级、其余段落未动。

## RED（先失败）

新增用例（全部走 `loadConfig` 真实配置加载入口，非内部函数直测）：

- `deployment configuration > refuses no sign-in combined with a public URL typed without its scheme`（`OPENBOT_PUBLIC_URL: "example.com:3010"`）
- `… an app URL typed without its scheme`（`OPENBOT_APP_URL: "localhost:3010"`）
- `… a trusted origin that is only a scheme`（`TRUSTED_ORIGINS: "myapp://"`）
- `… a URL whose hostname normalises away`（`OPENBOT_PUBLIC_URL: "http://."`）

命令（与验证命令相同）：

```
E2E_UNIT_SCOPE=server bunx e2e run --config e2e.unit.config.ts server/tests/config.test.ts server/tests/single-user.test.ts
```

RED 输出摘录：

```
FAIL |node| server/tests/config.test.ts > deployment configuration > refuses no sign-in combined with a public URL typed without its scheme
ERROR: expect(...).toThrow failed: nothing was thrown
FAIL |node| server/tests/config.test.ts > deployment configuration > refuses no sign-in combined with an app URL typed without its scheme
FAIL |node| server/tests/config.test.ts > deployment configuration > refuses no sign-in combined with a trusted origin that is only a scheme
FAIL |node| server/tests/config.test.ts > deployment configuration > refuses no sign-in combined with a URL whose hostname normalises away
Test Files  1 failed | 1 passed (2)
     Tests  4 failed | 165 passed (169)
```

仅新增 4 用例失败（配置被当作 private 放行、未抛错），既有 165 用例保持绿——证明失败确由 hostless 行为缺口引起，非环境噪声。

## GREEN（最小实现转绿）

应用 `if (!bare) return "public";` 后同一命令：

```
 ✓ |node| server/tests/single-user.test.ts (6 tests) 24ms
 ✓ |node| server/tests/config.test.ts (163 tests) 74ms
 Test Files  2 passed (2)
      Tests  169 passed (169)
   Duration  3.30s
```

169 = 基线 164（evidence/s01/baseline-run.txt）+ 新增 5。0 failed, 0 skipped。

## 自查清单（对照 brief）

- [x] RED：在既有 base fixture（`withoutSignIn` + `OPEN`）与既有 `test.each` 参数化块上扩展；对 `OPENBOT_PUBLIC_URL`、`OPENBOT_APP_URL`、`TRUSTED_ORIGINS` 分别覆盖 hostless 输入；覆盖 `example.com:3010`、`localhost:3010`、可解析但 hostname 为空的自定义 scheme（`myapp://`）；先运行证明真实失败。
- [x] 边界：`http://localhost:3010`、`http://127.0.0.1:3010`、192.168/10.x/172.16/Tailscale/ULA IPv6/mDNS/单标签 LAN 名既有 still-runs 用例继续通过；新增 `myapp://handset:3010`（带 host 的移动 scheme 是 auth 层真实配置）继续 private/放行；provider wins 由 `single-user.test.ts`（未修改）"a configured provider always wins, whatever else is set" 守住并通过；普通带 host 公网 URL（含 127. 前缀名、nip.io 通配名、172.32/100.128 近似值）拒绝行为不变。
- [x] GREEN 最小修复：归一化后空 hostname 按 public/不可接受处理；`loadConfig`、`reachOf` 签名不变；未重写 IP 分类；未动 provider 优先级；未迁移/重命名任何导出。
- [x] 验证走 ADR 0008 native 层指定命令，断言发生在真实 `loadConfig` 入口抛错上（`reachOf` 未导出，也无法被绕过入口直测）。
- [x] owned_files 之外零改动；`single-user.test.ts` 未修改，仅回归运行（6 tests passed）。
- [x] 拒绝错误信息可读、不含凭据：复用既有消息，只回显地址值与环境变量名（如 `… cannot be combined with an address the public internet reaches: localhost:3010. Configure GOOGLE_OAUTH_*…`），无任何 secret。
- [x] `bunx biome lint --error-on-warnings`（两文件）0 告警；新增行 Biome format 无意见。config.ts 第 1510-1520、2042-2066 行存在 BASE 即有的格式漂移（billing/lago 段），按"不改无关段落"未触碰（已用 `git show HEAD:` 版本复证漂移先于本次改动存在）。

## 偏差与备注

1. **无 scope 偏差**。改动仅 owned_files，两处均为 brief 预期形态（测试表扩展 + 单行行为移植）。
2. **备注（非偏差）**：既有拒绝消息对 hostless 输入的字面表述是 "an address the public internet reaches"，对"未知地址"语义略欠精确；上游修复未改该文案，本任务按最小移植同样未改（测试也只锚定 `OPENBOT_SINGLE_USER`）。若 Review 认为需要区分 "public or unknown" 措辞，属独立文案改动，建议另行裁决。
3. Spec/票据事实源与代码无冲突；brief 第 3 条所指上游 `reachOf` 行号（约 :555）与实际位置（`evidence/upstream-sources` 文件内 `function reachOf` 处）一致，逐行比对确认上游在归一化后即有 `if (!bare) return "public";`。

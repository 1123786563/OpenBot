# S01 Validator Report：无 hostname 的无登录配置拒绝启动（AC A01，Issue #490）

- 执行角色：backend_validator（只读验收）；日期 2026-10-20。
- 工作区：`.worktrees/upstream-openbot-update`，分支 `upstream-openbot-update`，HEAD = `3b4a7c68`。
- 对象：`evidence/s01/implementer-report.md` + `evidence/s01/after-tracked.diff`。

## 结论：PASS（5/5 项全部通过，无 Blocker / Major）

## 验收命令与亲测结果

```
E2E_UNIT_SCOPE=server bunx e2e run --config e2e.unit.config.ts server/tests/config.test.ts server/tests/single-user.test.ts
```

亲测输出（validator 原始运行，2026-10-20 15:14）：

```
 ✓ |node| server/tests/config.test.ts (163 tests) 73ms
 Test Files  2 passed (2)
      Tests  169 passed (169)
   Duration  1.45s
```

0 failed, 0 skipped。169 = baseline 164（`baseline-run.txt`）+ 新增 5（4 refuse + 1 still-runs）。

## 逐项验收

### 1. 行为：hostless 输入经真实 loadConfig 入口拒绝启动 — PASS

- 4 个新用例断言全部落在 `loadConfig({ ...withoutSignIn, ...OPEN, ...published })` 的抛错上（`server/tests/config.test.ts` refuse 参数化块）；`reachOf` 未导出，无法绕过入口直测。
- 覆盖输入：`OPENBOT_PUBLIC_URL: "example.com:3010"`、`OPENBOT_APP_URL: "localhost:3010"`、`TRUSTED_ORIGINS: "myapp://"`、`OPENBOT_PUBLIC_URL: "http://."`，均断言 `.toThrow("OPENBOT_SINGLE_USER")`。
- 亲测 169/169 通过，其中含上述 4 例。

### 2. 边界：合法形态继续启动、provider 优先 — PASS

- loopback 块（未改动）覆盖 `http://localhost:3010`、`http://127.0.0.1:3010`、`http://[::1]:3010`、`http://127.0.0.1:3001`；still-runs 块覆盖 192.168.1.10 / 10.0.0.5 / 172.20.1.4 / Tailscale 100.x / `[fd00::1]` / mDNS `.local` / 单标签 `nas`。亲测全部通过。
- 新增 `myapp://handset:3010`（带 host 的自定义 scheme）：`new URL(...).hostname === "handset"` → 单标签 → private → 放行，与"单标签 LAN 名"读法一致。
- `git diff --quiet HEAD -- server/tests/single-user.test.ts` 确认该文件零改动；"a configured provider always wins, whatever else is set" 在 169 通过内（single-user.test.ts 6 tests）。
- 近似值负例（172.32.0.1 / 100.128.0.1 拒绝）与普通带 host 公网 URL 拒绝行为不变。

### 3. 范围：改动面、签名、上游一致性 — PASS

- `git diff --name-only` = 恰好 `server/src/config.ts`、`server/tests/config.test.ts` 两个 tracked 文件；无 staged 改动；untracked 全为本计划预先存在的 docs（与 `before-status.txt` 一致，`before-tracked.diff` 为空证明起始生产区干净）。
- 测试 diff 0 删行（纯 +21 追加，既有断言无削弱/删除）；config.ts +5/-1，唯一删行是被扩写的文档注释行，非代码断言。
- `reachOf(raw: string): Reach` 与 `loadConfig(environment?: Environment): DeploymentConfig` 签名与 HEAD 及上游一致，未变。
- 修复行 `if (!bare) return "public";`（工作区 `server/src/config.ts:709`）与上游参考 `evidence/upstream-sources/server/src/config.ts` 的 `function reachOf`（:555 起）逐字一致，位置一致：归一化（去括号/尾点）之后、loopback 判定之前。
- 工作区实际 diff 与 `evidence/s01/after-tracked.diff` 逐字节一致（`git diff > tmp && diff` 为空）。

### 4. 质量：错误信息与测试命名 — PASS

- 拒绝消息（`singleUserAllowed`）：`OPENBOT_SINGLE_USER admits every request as one administrator with no sign-in, so it cannot be combined with an address the public internet reaches: ${published.join(", ")}. Configure GOOGLE_OAUTH_*, MICROSOFT_OAUTH_* or OKTA_OAUTH_* with BETTER_AUTH_SECRET and BETTER_AUTH_URL, or serve it somewhere only you reach.`——点名 flag、列出违规地址、给出修复路径，可读；只回显地址值与环境变量名，不含任何凭据。
- 新用例名均为行为描述："a public URL typed without its scheme"、"an app URL typed without its scheme"、"a trusted origin that is only a scheme"、"a URL whose hostname normalises away"、"a mobile scheme origin with a host"；注释解释的是用户可感知的形态（漏写 scheme 的 .env），非内部实现。

### 5. RED 真实性 — PASS

- validator 以旧版 `reachOf`（去掉 `if (!bare)` 行）内联复刻实证：`example.com:3010`、`localhost:3010`、`myapp://`、`http://.` 四个输入的旧分类均为 `private` → `singleUserAllowed` 放行不抛错 → `.toThrow` 报 "nothing was thrown"，与 implementer-report 的 RED 摘录（4 failed: nothing was thrown）逐条吻合。
- 算术对账：baseline 164（config 158 + single-user 6）；RED 状态下 4 个新 refuse 用例失败、新增 still-runs 用例（`myapp://handset:3010`，host 非空，不受该修复行影响，旧行为本就通过）通过 → 165 passed，与摘录 `4 failed | 165 passed (169)` 一致。
- 修复行仅在 hostname 归一后为空串时生效；非空输入新旧分类逐一对照无差异（含 host 的 scheme、loopback、私网、公网均实证不变）。失败由 hostless 缺口单一因素引起，不存在人为破坏通路——生产代码唯一 diff 即该行。
- `before-status.txt` / `before-tracked.diff`（空）与 `baseline-run.txt`（164 绿）构成干净起点证据。

## 附加核查

- `bunx biome lint --error-on-warnings server/src/config.ts server/tests/config.test.ts`：0 告警。
- `bunx biome format`：config.ts :1510-1520、:2042-2053（billing/lago 段）存在格式漂移；已用 `git show HEAD:` 版本独立复证该漂移在 BASE 即存在、与本次新增行（:709 / :601 / :625）无交集，按最小范围未触碰是正确决策。

## 发现的问题分级

- Blocker：无。
- Major：无。
- Minor：无。
- Observation（非阻塞，1 条）：既有拒绝消息字面为 "an address the public internet reaches"，对 hostless（语义上是"未知地址"而非"公网可达"）略欠精确；上游修复同样未改该文案，测试锚点也只取 `OPENBOT_SINGLE_USER`。如需区分措辞（如 "public or unknown"），属独立文案改动，建议另行裁决，不影响本任务验收。

## 验收结论

**S01 验收通过。** 修复与上游参考逐字一致、最小且范围正确；RED→GREEN 证据链完整且经 validator 独立复现；边界与 provider 优先级回归全绿（169/169）。

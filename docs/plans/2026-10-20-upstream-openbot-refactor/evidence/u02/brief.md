# Task Brief U02：服务端连接提示共享合约

- **Task/AC**: U02 / A06（服务端半部）。正式 Issue：[#495](https://github.com/1123786563/OpenBot/issues/495)（本地票 `docs/tickets/upstream-openbot-update/issues/up06.md`）。
- **owner_role**: backend_implementer（你）。
- **工作区**: `/Users/wuyongjun/trea/OpenBot/.worktrees/upstream-openbot-update`。不得 cd 主 checkout、不得 git stash/commit/push、不派发子 Agent。

## 事实源

1. Spec §4（对话连接闭环）前两条 + 票据 up06 criteria 前两条。
2. 实施计划 I2 合约（implementation-plan.md §2 I2）——**以计划为准，严于上游**。
3. 上游参考（只读）：`evidence/upstream-sources/shared/connect-prompt.ts`——marker 概念与双端单声明理由；注意其解析用 `indexOf("}")`，会被 title 内的 `}` 截断——**本地实现不得复制该缺陷**（计划明文：解析 JSON 字符串内的 `}` 不能简单取第一个花括号）。
4. 本地现状：`server/src/plugins/tools.ts:36` `REFUSAL_MARKER = "Refused."` 外层信封必须保留（marker 拒绝文本作为 refusal 内容随行）；`PluginRefusedError` 已存在；`server/src/plugins/store.ts` 有个人连接/共享部署账户/管理员配置等分支（grep 到 personalAlias/deploymentAlias 等）。个人可自助连接的判定以本地现有账户模型为准。

## I2 合约（严格遵守；比上游更严的部分是本任务要求）

```ts
const CONNECT_APP_MARKER = '[connect-app]';
type ConnectPrompt = { serverId: string; title: string; message: string };
connectAppRefusal(prompt: ConnectPrompt): string;
readConnectPrompt(text: string | undefined | null): ConnectPrompt | null;
```

- 字段与长度校验：serverId 1–256 字符、title 1–200 字符、message ≤4,000 字符、marker payload ≤8,192 字符；违规/截断/字段类型错误/非对象一律返回 null（fail closed，绝不由半读拒绝画卡片）。
- roundtrip 必须支持 title 含 `}` 与引号；解析不得简单取第一个 `}`。
- codec 只产生展示数据：解析结果不构成授权依据；普通 tool 结果文本不得被升级为权限信号。

## owned_files

- `shared/connect-prompt.ts`（新建）、`shared/connect-prompt.test.ts`（新建）
- `server/src/plugins/store.ts`
- `server/tests/plugin-user-credential.integration.test.ts`、`server/tests/plugin-connect-route.test.ts`

## 要求（RED→GREEN→REFACTOR）

1. **RED（codec）**：roundtrip（title 含 `}` 和引号）、截断 JSON、错误字段、超大内容 → null；普通文本/null/undefined → null。
2. **RED（store 集成）**：只在对**个人可自助连接**的"无账户/已断开/已撤销"分支产生 marker 拒绝；**缺 Bot grant、管理员共享账户配置缺失、Shared app 部署账户问题保持各自原有拒绝原因**（不改为"请个人连接"）。别人/另一公司的连接不能使本人请求通过；存在 revoked row 仍提示需连接；直接 connect endpoint 再次校验 actor。
3. **GREEN**：最小实现；`PluginRefusedError`/审计路径不变；无需 DB migration。
4. **验证**：按两 suite 实际 import 层归 native/driven（读 `docs/verification/e2e-bun-suites.json` 与 ADR 0008 判断）；native 用 `E2E_UNIT_SCOPE=server bunx e2e run --config e2e.unit.config.ts <file>`，driven 用 `bun test ./<file>`；DB 集成用独立 fixture 库（docker 已有 :5433/:5435）。新增 `shared/connect-prompt.test.ts` 归属与登记先查清单规则再登记，登记后与实际执行对账。codec suite 若 native 可跑则 native。
5. 无需真实 OAuth provider 的 case 使用现有 fake broker/fixtures；不为测试放松服务端校验。

## 禁止

- 不改工具执行/副作用路径；不建第二套 OAuth；不扩大账户归属（ADR 0004/0006/0007 边界）；不修改 U03/U04 的前端文件；不改 `tools.ts` 的 REFUSAL_MARKER 信封结构（只在其内容里携带 marker）。

## 报告

`evidence/u02/implementer-report.md`：改动摘要、分支映射表（哪些拒绝分支产生 marker、哪些保持原样及理由）、RED/GREEN 证据、suite 归层与登记对账、自查、偏差。

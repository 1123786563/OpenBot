# Task Brief L01：Computer 私有验证码 endpoint 与 gateway

- **Task/AC**: L01 / A08（基础协议）。正式 Issue：[#496](https://github.com/1123786563/OpenBot/issues/496)（本地票 `docs/tickets/upstream-openbot-update/issues/up08.md`）。
- **owner_role**: backend_implementer（你）。
- **工作区**: `/Users/wuyongjun/trea/OpenBot/.worktrees/upstream-openbot-update`。不得 cd 主 checkout、不得 git stash/commit/push、不派发子 Agent。**本任务不改 web 表单（L03 的事）、不改 passwords service/DB（L02 的事）。**

## 事实源

1. Spec §5 前 5 条 + up08 criteria 第 1、3 条；实施计划 I3 合约（L01 生产 Computer/gateway 半部）。
2. 上游参考（只读）：`evidence/upstream-sources/agent-computer/src/sign-in.ts`（365 行，含 `parseSignInCode`/`fillSignInCode`/codeRequested 语义）、`agent-computer/src/index.ts`（/sign-in/code 路由）、`agent-computer/src/authorisation.ts`、`server/src/computer/schema.ts`、`server/src/computer/gateway.ts`。
3. 本地现状：`agent-computer/src/sign-in.ts` 的 `SignInFillInput` 含可选 `code`（随密码同发，:249 起输入）；`agent-computer/src/index.ts:974` 有 `POST /sign-in/fill`；`server/src/computer/gateway.ts:267/:1067` 有 `signIn(botId, input, signal?)`。上游与本地文件已分叉，**按行为对齐，不整文件复制**。

## I3 合约（L01 范围）

- `SignInFillInput` 的 `code` 在新客户端不再发送；`fillSignIn` 初次密码提交**忽略**输入的 code（不提前输入）；兼容旧客户端时服务端/Computer 侧都不因携带 code 报错。
- `SignInFillResult` 兼容扩展 `codeRequested?: boolean`——仅当**实际检测到可见 one-time-code 字段**才为 true；输入值从不回传。
- 新增 `SignInCodeInput = { origin: string; code: string }`、`SignInCodeResult = { submitted: boolean; codeFieldVisible: boolean; passwordFieldVisible: boolean; url: string; error?: string }`；独立 `parseSignInCode` 与 `fillSignInCode`——code 字段只在**已验证 origin 的当前页面**定位；跳到不同 origin 明确拒绝，不跨 origin 猜字段。
- Computer 新路由 `POST /sign-in/code`：与 `/sign-in/fill` 同等的服务认证、Bot 范围、人工控制屏障（读 index.ts 现有 fill 路由的守卫并复用）；**不得**注册为模型可填秘密的通用工具。
- `server/src/computer/gateway.ts` 增加 `signInCode(botId, input, signal?): Promise<SignInCodeResult>`（与 signIn 同一私有登录授权与审计边界）；schema.ts 增对应类型。字段上限 64、JSON 校验风格沿用现有 parse*。

## owned_files

- `agent-computer/src/sign-in.ts`、`agent-computer/src/index.ts`、`agent-computer/src/authorisation.ts`
- `server/src/computer/schema.ts`、`server/src/computer/gateway.ts`
- `agent-computer/tests/sign-in.test.ts`（扩展）、`server/tests/computer-sign-in-code.test.ts`（新建）
- `docs/verification/e2e-bun-suites.json`（新 suite 登记与对账）

## 要求（RED→GREEN→REFACTOR）

1. **RED**：扩展 `agent-computer/tests/sign-in.test.ts`——密码提交后出现可见 one-time-code 字段 → `codeRequested: true`；无字段 → 不报告；旧客户端 code 被忽略（初次提交不输入）；code 字段跨 origin → 明确拒绝；错误 code / 回密码页的 `SignInCodeResult` 形状。先跑证明失败。
2. **GREEN**：实现 I3；Playwright 本地静态测试页覆盖正确 code、错误 code、回密码页、DOM 消失、超时、导航（沿用套件现有 fixture 风格）。
3. **gateway fixture**：依赖 fake gateway 的现有测试 fixture 显式补 `signInCode`（实现合理 fake），不得用类型断言掩盖缺方法；grep 所有 `ComputerGateway` fake。
4. **验证**：`E2E_UNIT_SCOPE=agent-computer bunx e2e run --config e2e.unit.config.ts agent-computer/tests/sign-in.test.ts`（native）；`server/tests/computer-sign-in-code.test.ts` 按实际 import 归层（e2e-compat→native / bun→driven）执行并登记对账；`bun run --filter server typecheck`（bootstrap-local-gateway.ts BASE 红不计入）+ agent-computer 相关 typecheck；`bunx biome format` 每改动文件真实 exit 0（新增行）。

## 禁止

- 不改 `server/src/passwords/**`、DB、web UI；不把 code 存任何持久层；不注册模型工具；秘密不入日志（沿用现有 secret 处理先例）；不改 U 系列文件。

## 报告

`evidence/l01/implementer-report.md`：改动摘要、I3 对照表、RED/GREEN 证据、fixture 更新清单、归层对账、format/typecheck、偏差。

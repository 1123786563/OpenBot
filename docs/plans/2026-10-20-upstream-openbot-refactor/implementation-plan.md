# OpenBot 上游更新详细改造 Implementation Plan

**采用与发布更新（2026-10-20）：** 用户已采用详细设计、测试边界和 12 张业务票拆分，父 Spec [#489](https://github.com/1123786563/OpenBot/issues/489) 及子票已创建；正式设计依据为 `docs/specs/2026-10-20-upstream-openbot-adoption-design.md`。下文是已采用范围的文件级 Task；代码实施仍未启动。发布关系见 tickets manifest，核验结果已归档到 `.archive/runs/legacy-plans/tickets/upstream-openbot-update/`。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将已确认缺失的上游安全修复、对话交互、分步登录和网页研究能力，以可单独审查、验收及回滚的业务切片接入现有 OpenMuse/OpenBot。

**Architecture:** 沿本地 config、plugins、Computer gateway、passwords service 与 transcript 接口增量改造。共享协议先落地，消费者随后适配；保留 OpenBot 身份、权限、审批、副作用和计费权威。不上移整套上游 server，也不将 toolkit 设为本次新依赖。

**Tech Stack:** Bun/TypeScript、React/TanStack Query、Hono、PostgreSQL/Drizzle、Playwright；沿用当前本地工具链，不附带升级框架。当前 Bun packageManager 为 `bun@1.4.3`。

**Spec:** 用户当前“详细改造计划”请求、[范围方案](../2026-10-20-upstream-openbot-update-plan.md)、本文件 §1 验收映射。范围方案和比较表不视为已批准的产品 Spec。约束事实源：根 `CONTEXT.md`、ADR 0002–0010、`docs/specs/2026-10-14-company-team-multitenancy-design.md`、`docs/specs/2026-10-15-hindsight-personal-memory-design.md`、`docs/specs/2026-10-19-mastra-agent-execution-migration-design.md`。本文件为已采用范围的实施计划；当前已授权并执行 Issue 发布，未启动代码实施。

## Global Constraints

1. 规划本地 SHA：`3b4a7c68132c3507300408346a44fb9d56f3c14c`；上游固定 SHA：`e8bb27368ff436958b614292ae91283e51d5a813`。实施重建 BASE，发现漂移则记录，不重复派发已完成工作。
2. 公司、团队和用户范围取自服务端可信上下文；客户端选择头不构成授权。新查询不能复用旧组织的缓存响应。沿用已批准的全局身份/个人账户例外；不为全局账户擅自新增 tenant 列或改变作用域，组织相关 Bot 访问仍须检查当前授权。
3. 新工具继续走现有授权/审批/预算/Payer/结算，不直接从 UI 或模型绕过 gateway 调供应商。
4. Hindsight/个人审核边界、已删除 KB 域、Mastra 执行方向分别遵守 ADR 0005/0009/0010。已有记忆镜像、Learning、身份绑定、审计导出只回归。
5. 上游源码使用本地 Git 固定对象读取；不将分支名 main 当作永久证据。上游测试需适配 ADR 0008 两层运行器。
6. 默认串行实施；跨端切片依次派发专业实现角色。不因共享文件方便而用 default 替代前后端角色。
7. 无本地提交授权则建立未提交检查点；无推送、合并、发布授权。文档/测试证据与哈希绑定，后续改动重新验证相关范围。
8. UI 沿用本地组件与 en/zh-CN 文案。OAuth URL、模型 key、密码、验证码不得写入聊天内容、通用日志或计划证据。
9. 数据库迁移采用本地 journal 的下一个可用编号。规划时最新为 0164，但实施可能变化，因此迁移的语义名称固定、数字编号由实施工作区分配并写入 ledger，不预占他人编号。
10. 所有任务执行 RED→GREEN→REFACTOR 和独立 Review；若前提已实现，证明当前行为后记为 no-change verified，不能修改测试制造失败。

## Review Focus

- 延迟响应/组织切换：旧连接列表和旧 Computer 事件不能把新范围显示成已连接或开屏；由 U01/U03 验证。
- tool 结果伪造：网页/连接器返回的类似 marker 文本只作展示，不能成为授权、自动连接或工具重放依据；由 U02/U03 验证。
- 外部动作状态不明：密码/code 已发送后超时，不自动重发，不承诺外部 exactly-once；用户需明确重新操作或接管；由 L02/L03 验证。
- 能力开关与新 provider：隐藏被禁工具、保留政策拒绝，不以切供应商绕过预算或撤权；由 U01/R02 验证。
- 回滚新 schema：不得把有 code_required/在途 filling 的系统直接交给不认识这些状态的旧应用；由 L03/V01 验证。

## 1. 范围与可观察验收

| AC | 需求/验收 | Tasks | 本轮边界 |
|---|---|---|---|
| A01 | 无 hostname 的 single-user 地址拒绝启动；合法本地 URL 不误拒 | S01 | 配置修复 |
| A02 | 指定 shell 参数中的秘密在 OTLP 导出中不可见；无关命令结构保留 | S02 | 脱敏修复，不追溯历史 |
| A03 | 邮件按 MIME part charset 解码，HTML 引用只解一层 | S03 | SES/SNS trigger 正文；不改 OpenMuse 邮件 BFF |
| A04 | 重复分钟文案去重，不改变调度结果 | S04 | 文案修复 |
| A05 | 只有浏览器显示动作开屏，明确拒绝只撤销对应自动开屏，用户手动操作优先 | U01 | 保留现有活动 epoch；不引入新 Run 权威 |
| A06 | 对话显示连接卡片，连接状态以本人服务端账户为准，授权后不自动重放写操作 | U02/U03 | 复用已存在 connect endpoint |
| A07 | 相邻工具调用聚合，审批/连接要求独立展示，原始参数结果可展开 | U04 | 不重写消息存储 |
| A08 | 密码后发现 code 字段才询问；错误 code 可明确重试；任何秘密不进入模型/日志 | L01/L02/L03 | 跨 Computer/API/web 状态机 |
| A09 | 启动诊断有界、非阻断，未使用的可选服务不被探测 | D01 | 不成为授权事实源 |
| A10 | Parallel/Exa/Firecrawl 可按角色授予；未知高风险工具不被判为 read；原 Parallel 配置兼容 | R01/R02/R03 | 不默认打开新服务/后台研究 |
| A11 | 全部新增行为通过企业范围、预算、审批、记忆和 Craft 不回退验收 | V01 | 独立 Review + 完整 OCR |
| A12 | harness/mobile/toolkit 差距有证据及采用/延期结论 | E01 | 只评估，不添加第二套客户端/引擎 |

未包含：全量上游合并、依赖大升级、Antigravity 实装、根 mobile/ 复制、toolkit 拆包、重新建立 KB、默认开启后台研究或记忆来源。若需要这些，输出独立后续计划，不伪装成本轮小改动。

**来源索引（固定 upstream SHA 下）：** #795 `e8bb2736`；#764 `916ea9a1`；#787 `cf426553`；#807 `06be0f97`；#803 `aa932104`；#798 `1b1c80e4`；#780 `bb62c653`；#790 `8c9ad4c8`；#771 `82fc128b`；#782 `cae4b6bd`。PR 号是来源，不是执行依赖；本批已创建正式父/子 Issue，发布回读不替代执行开工时完整 Issue 树、讨论和状态快照。

## 2. 文件边界与共享协议

| 单元 | 主要路径 | 改造责任 |
|---|---|---|
| 配置/导出 | `server/src/config.ts`, `server/src/telemetry/scrub.ts` | 保持导出签名和现有审计流水线 |
| 邮件/调度 | `server/src/responsibilities/email.ts`, `server/src/routines/schedule.ts` | 只修改正文解码和描述 |
| 屏幕事件 | `app/src/lib/copilot/computer-activity.ts`, `app/src/lib/computers/call.ts`, `app/src/routes/_authed/_app/channel/$channelId.tsx` | 事件生产、撤回与路由开关同时改 |
| 连接提示 | 新 `shared/connect-prompt.ts`, `server/src/plugins/store.ts`, `app/src/components/channels/connect-app-card.tsx` | 共享 marker codec；后端提示，前端复用连接 API |
| 工具摘要 | 新 `app/src/components/channels/tool-activity.tsx`, 现有 `chat-messages.ts`, `chat-transcript.tsx`, `browser-activity.tsx` | 纯分组函数与展示分离，沿用原 renderer |
| 登录 | `agent-computer/src/sign-in.ts`, `server/src/computer/{schema,gateway}.ts`, `server/src/passwords/{types,store,service,routes,resume}.ts`, `server/src/db/schema/passwords.ts` | Computer 协议、service 状态机、持久化、continuation |
| 登录 UI | `app/src/components/passwords/sign-in-form.tsx`, `app/src/lib/passwords/{queries,mutations}.ts`, `app/src/lib/copilot/sign-in-tool.tsx` | 分步表单、状态轮询、秘密清理 |
| 研究 | 新 `shared/research.ts`, `server/src/plugins/{catalogue,mcp,tools,store,selection}.ts`, `app/src/lib/plugins/tool-name.ts` | provider 角色/认证/read 分类/skill ref/标签 |
| 测试调度 | `tests/config/e2e-bun-suites.json`, `scripts/lib/e2e-manifest.mjs` | 每任务新增 suite 立即登记，串行修改 |
| 词条 | `app/src/locales/{en,zh-CN}/{channels,computer,settings}.json` | 归任务所有，禁止复制上游英文硬编码 |

### I1：Computer 活动事件（U01 生产并使用）

```ts
type Activity = { botId: string; epoch: number; announcement: number };
type Withdrawal = { botId: string; announcement: number };
reportComputerActivity(botId: string): number;
withdrawComputerActivity(botId: string, announcement: number): void;
onComputerActivity(listener: (event: Activity) => void): () => void;
onComputerActivityWithdrawn(listener: (event: Withdrawal) => void): () => void;
```

兼容现有调用者忽略返回值。保留当前 10 秒静默分 epoch 的行为，不把该 epoch 命名为精确服务器 runId。开屏 hook 以 `announcement` 撤回自身打开的面板；组件更换 Bot/卸载时取消订阅并重置引用。未知网络结果不等同于“动作没有发生”。

### I2：连接提示（U02 生产，U03/U04 消费）

```ts
const CONNECT_APP_MARKER = '[connect-app]';
type ConnectPrompt = { serverId: string; title: string; message: string };
connectAppRefusal(prompt: ConnectPrompt): string;
readConnectPrompt(text: string | undefined | null): ConnectPrompt | null;
```

沿用现有 `Refused.` 外层与文本工具结果。codec 对字段、最大长度、对象结构做检查（serverId 1–256 字符、title 1–200 字符、message 不超过 4,000 字符、marker payload 不超过 8,192 字符）；解析 JSON 字符串内的 `}` 不能简单取第一个花括号。codec 只产生展示数据。卡片使用既有 `connectAccountMutationOptions(): Promise<string|null>` 与 `connectionsQueryOptions()`，服务端再次验证账户/组织权限。旧客户端仍显示可读的 message。

### I3：私有登录协议（L01/L02 生产，L03 消费）

- `SignInFillInput` 的 `code` 在新客户端不再发送；兼容旧客户端时服务端忽略初次密码提交携带的 code，不能提前输入。
- `SignInFillResult` 兼容扩展 `codeRequested?: boolean`；为 `true` 且密码表单已离开时才能进入 code_required。
- 新增 `SignInCodeInput = { origin: string; code: string }` 与 `SignInCodeResult = { submitted: boolean; codeFieldVisible: boolean; passwordFieldVisible: boolean; url: string; error?: string }`。
- Computer `POST /sign-in/code`；OpenBot `POST /api/sign-in-requests/:id/code`，body `{code:string}`。沿用现有 JSON 字段上限 64、owner 校验、同源/请求校验和终态拒绝约定。
- `ComputerGateway.signInCode(botId: string, input: SignInCodeInput, signal?: AbortSignal): Promise<SignInCodeResult>`；gateway 使用与 signIn 相同的私有登录授权与审计边界。
- `SignInService.submitCode(ownerUserId: string, id: string, input: {code:string}): Promise<SignInRequestView>`。
- 增加 `code_required` 非终态；pending 查询包含它，FINAL_SIGN_IN 不包含它。验证码不持久化，密码只在用户明确保存时进现有加密 vault。

### I4：研究角色（R01 生产，R02/R03 消费）

```ts
type ResearchRole = 'search' | 'fetch';
type ResearchTools = { search: string; fetch: string; notes?: readonly string[] };
const RESEARCH_TOOLS: Readonly<Record<string, ResearchTools>>;
researchRoleOfTool(server: string, tool: string): ResearchRole | null;
researchRoleOf(ref: string): ResearchRole | null;
```

键为 catalogue key：`parallel`, `parallel-authenticated`, `exa`, `exa-authenticated`, `firecrawl`, `firecrawl-authenticated`。工具名分别为 `web_search/web_fetch`、`web_search_exa/web_fetch_exa`、`firecrawl_search/firecrawl_scrape`。逻辑 ref 为 `@research/search`、`@research/fetch`；只扩展已授权实际工具，不凭逻辑角色自动授予任何 provider。

### I5：启动诊断（D01）

新增 `checkModelAvailability(options)` 与 `reportIntelligenceEntitlement(options)`；参数注入配置、只读 fetch/entitlement reader 与日志函数，返回分类结果，不抛到启动主流程。新建共享的安全诊断结果类型放在 model-availability-check.ts，不把供应商原始响应直接记录：

```ts
type StartupCheckResult = {
  kind: 'available' | 'skipped' | 'warning';
  code?: 'unconfigured' | 'unsupported' | 'credential-rejected'
    | 'model-unavailable' | 'entitlement-unavailable' | 'timeout' | 'unreadable';
  message?: string;
};
checkModelAvailability(options: {
  enabled: boolean;
  model: string;
  lookup?: (signal: AbortSignal) => Promise<{status: number}>;
  log: (result: StartupCheckResult) => void;
}): Promise<StartupCheckResult>;
reportIntelligenceEntitlement(options: {
  enabled: boolean;
  read?: (signal: AbortSignal) => Promise<{active: boolean}>;
  log: (result: StartupCheckResult) => void;
}): Promise<StartupCheckResult>;
```

只有实际官方 lookup 或已批准的网关 metadata adapter 可以提供 lookup；兼容供应商不支持时不传，不从任意 URL 推断其语义。统一单次探测预算 3,000ms，不做后台无限重试。供应商元数据探测不经过按 token 结算的推理入口，不生成计费调用；如网关无合法元数据探测接口则 skipped。

## 3. DAG 与执行纪律

完整节点字段与依赖见同目录 `dag.json`。含有 S00→所有变更任务、U02→U03→U04、L01→L02→L03、R01→R02→R03、全部交付→V01 的真实前置。DAG 不把串行偏好当业务依赖。

建议调度序列：`S00 → S01 → S02 → S03 → S04 → U01 → U02 → U03 → U04 → L01 → L02 → L03 → D01 → R01 → R02 → R03 → E01 → V01`。默认全程单流；共享 `chat-transcript.tsx`、catalogue、locales、测试清单逐次集成。

任务状态：pending / ready / running / blocked / verified。只有前置 verified 且检查点已集成当前工作区才能开始下游。被前置等待的任务保持 pending；外部环境确实不足才标 blocked。

每个实现 Task 的最后步骤统一为：自查→检查点哈希→专业 validator→独立 reviewer（Spec + quality 两结论）→必要修复与受影响复验→主控集成并更新 ledger。没有提交授权不执行 git commit，用检查点替代。

## 4. 可派发任务

### Task S00：规划输入、工作区和执行账本

**角色：** 主控；只读探索可由 researcher。**依赖：** 无。**Files：** 本目录文档、原比较表。生产文件无写权限。

**Consumes/Produces：** 固定 SHA/ADR → 当前 BASE、patch manifest、共享接口快照、ledger 与每任务 brief。

- [ ] 实施开始调用 using-git-worktrees 建立或核验隔离工作区；将未提交计划显式复制，核对 SHA-256。计划阶段留在当前文档工作区。
- [ ] 记录 HEAD、tracked staged/unstaged diff 和本任务相关 untracked 的完整内容/哈希。其他用户改动列为基线。
- [ ] 对照当前 HEAD 逐项确认 A01–A12；已实现项目用文件/行为证据消项，不重新改造。
- [ ] 从本地固定 upstream SHA 读取 source diff，保存上游来源与本地适配清单；修正比较表错误路径和已有能力误判。
- [ ] 创建 `ledger.md`，字段为 task、status、before/after checkpoint、实际文件、验证报告、review 状态、ruling、下一任务；创建单任务 brief。
- [ ] 通过 DAG 唯一性/引用/无环与 AC 覆盖检查，交 reviewer 只读复核。

**验收：** 所有变更任务均能从 brief 找到事实源、所有权、I1–I5 及测试归属。**失败处理：** 基线漂移只更新证据；实质 ADR 冲突阻塞对应 Task，不静默修改 Spec。

### Task S01：无 hostname 配置拒绝启动

**角色：** backend_implementer / backend_validator。**依赖：** S00。
**Files：** Modify `server/src/config.ts`, `server/tests/config.test.ts`。现有 `single-user.test.ts` 是布尔启用测试，作回归，不把地址分类只测在它里面。
**接口：** `loadConfig`/内部 reachOf 签名保持；hostname 归一后空字符串为 public/refused。

- [ ] RED：扩展 config 的现有 base fixture，分别把 `OPENBOT_PUBLIC_URL`、`OPENBOT_APP_URL`、`TRUSTED_ORIGINS` 设为 hostless 输入；断言 single-user 模式拒绝。
- [ ] 边界输入：`example.com:3010`、`localhost:3010`、不含 host 的 scheme；允许 `http://localhost:3010`、`http://127.0.0.1:3010` 和既有合法私网 URL；普通带 OAuth 配置仍按原规则。
- [ ] 运行 V-N 的 config suite，确认缺陷输入真实失败；最小增加空 host 拒绝，避免重写 IP 分类。
- [ ] GREEN：config 与 single-user 两 suite 均通过；审查没有改变认证 provider 优先级。

**预计：** 0.25–0.5 工程日。**回滚：** 应用补丁；无迁移。**完成证据：** A01 输入输出、运行数量与 checkpoint。

### Task S02：命令参数凭据脱敏与 OTLP 证明

**角色：** backend_implementer / backend_validator。**依赖：** S00。
**Files：** `server/src/telemetry/scrub.ts`, `server/tests/enterprise-controls.test.ts`, `server/tests/otel-export-scrubbing.test.ts`。
**接口：** `scrubCommand(command:string):string` 保持；不执行/解析为真实 shell。

- [ ] RED：增加 docker `login -p secret`、sshpass `-p secret`、redis-cli `-a secret/-asecret/--pass secret`、mysql 附着 `-psecret`、curl `--proxy-user user:pass`、引号秘密。
- [ ] 负例：`mysql -p database` 不把 database 当密码；`docker -p 8080` 不能通用当秘密；裸 flag 不吞后续 flag；既有 --password、token、JSON body 和 URL 脱敏继续有效。
- [ ] V-N 跑 enterprise-controls，V-B 跑真实本地 collector 测试；仅补 missing 规则，不复制上游整份 audit/OTel。
- [ ] GREEN：使用不符合已知 token 前缀的 fixture 值，断言实际收到的 OTLP body 不含秘密；保留事件类型/调用关联字段。

**预计：** 0.5–1 日。**回滚：** 应用补丁；历史日志不自动改写。**验收：** A02，同时列出本次覆盖的命令形态，避免声称所有 shell 语法皆可净化。

### Task S03：MIME charset 与 HTML 引用

**角色：** backend_implementer / backend_validator。**依赖：** S00。
**Files：** `server/src/responsibilities/email.ts`, `server/tests/responsibility-triggers.test.ts`。
**接口：** `extractEmailText(raw:string, depth?:number):string` 保持；内部 decodeBody 增加当前 part charset 输入。

- [ ] RED：每 part 独立 utf-8/iso-8859-1，覆盖 base64、quoted-printable、multipart plain 优先和未知 charset 回落 utf-8。
- [ ] RED：HTML-only `AT&amp;T`、`we&#8217;re`、hex 引用、nbsp 正确输出；`&amp;lt;` 结果是 `&lt;`；plain text 的 `&amp;` 不改写。
- [ ] 先 transfer decoding 为 bytes，再按 charset 解码。HTML 先过滤现有不显示内容/标签，再只解码一轮字符引用；保留 depth 限制与空正文行为。
- [ ] V-N 跑责任触发 suite；SNS 签名/topic/过滤/正文大小相关断言必须仍通过。

**预计：** 0.5–1 日。**回滚：** 应用补丁。**验收：** A03，不涉及 `server/src/openmuse-mail/` 的主动发信。

### Task S04：重复分钟描述去重

**角色：** mechanical_worker / backend_validator。**依赖：** S00。
**Files：** 仅 `server/src/routines/schedule.ts`, `server/tests/routine-schedule.test.ts`。
**接口：** `describeCron(cron:string):string` 保持。

- [ ] RED：断言 `describeCron('0,30,0 9 * * *') === 'Every day at 09:00 and 09:30'`；`0,0` 只描述一次。
- [ ] 最小用 Set 去重数字，再按现有顺序排序格式化。不得修改 nextOccurrence。
- [ ] V-N 跑该 suite，保留 DST、间隔限制和星期别名测试。

**预计：** 0.25 日。**回滚：** 应用补丁。**验收：** A04。

### Task U01：Computer 活动分类、撤回和屏幕 hook

**角色：** frontend_implementer / frontend_validator。**依赖：** S00。
**Files：** I1 三个现有入口、新 `app/src/components/computer/use-auto-watch-screen.ts`；Test 新 `app/tests/auto-watch-screen.test.tsx`, `app/tests/computer-screen-announcement.test.ts`，回归 `app/tests/computer-activity.test.ts`。
**Consumes/Produces：** 当前 ToolOutcome/callComputer → I1；callComputer 签名兼容保持。

- [ ] RED：文件 read/write/list/download、run command 不产生开屏 announcement；navigate/click/type/key/scroll 等实际显示动作产生 announcement。按本地现有 path 建立显式 allowlist，未知 path 不猜测为显示动作。
- [ ] 为每次调用分配 announcement；403/refused 等“明确未执行”的结果撤回该 token；网络断连/500/abort 等无法证明未执行的结果不虚假撤回。
- [ ] hook 记住自己打开的 token，匹配撤回才关闭；人工面板、较早有效动作、设置/Workshop 面板均不被抢占。
- [ ] RED/GREEN：同 epoch 用户主动关闭后不再自动开；Bot 切换/路由卸载清理订阅；旧 Bot 响应无效；保留当前 epoch 启发式语义。
- [ ] V-B 跑新增 UI suite；验证窄屏、手动开关及键盘关闭；只在确需修复生产返回语义时另立后端 brief，不让前端 Agent 改 gateway 权限。

**预计：** 1–1.5 日。**验收：** A05。**回滚：** 移除自动 hook 接入可恢复原手动入口；活动数据不进持久化。

### Task U02：服务端连接提示共享合约

**角色：** backend_implementer / backend_validator。**依赖：** S00。
**Files：** Create `shared/connect-prompt.ts`, `shared/connect-prompt.test.ts`；Modify `server/src/plugins/store.ts`, `server/tests/plugin-user-credential.integration.test.ts`, `server/tests/plugin-connect-route.test.ts`；现有 `plugins/tools.ts` 外层 Refused envelope 必须保留。
**Consumes/Produces：** 本地连接拒绝与个人账户规则 → I2 codec 和对应 tool refusal。

- [ ] RED：codec roundtrip（title 包含 `}` 和引号）、截断 JSON/错误字段/超大内容返回 null；普通 tool 结果不升级为权限信号。
- [ ] 只在个人可自助连接的“无账户/已断开/已撤销”分支产生连接 marker；没有 Bot grant、部署共享账户、管理员设置缺失仍保持不同拒绝原因。
- [ ] 集成用例：别人/另一公司连接不使本人的请求通过；存在 revoked row 仍提示需连接；直接 connect endpoint 再次校验 actor。
- [ ] V-N/V-B 按 suite 实际 import 层验证；无需真实 OAuth provider 的 case 使用现有 fake broker/fixtures。
- [ ] 独立审查合约后再放行 U03；不改变工具执行/副作用路径。

**预计：** 0.5–1 日。**验收：** A06 服务端半部；无需 DB migration。

### Task U03：对话内连接卡片

**角色：** frontend_implementer / frontend_validator。**依赖：** U02。
**Files：** Create `app/src/components/channels/connect-app-card.tsx`, `app/tests/connect-app-card.test.tsx`；Modify `chat-transcript.tsx`, `app/src/locales/{en,zh-CN}/channels.json`；复用现有 plugins queries/mutations，不另建 connect API。
**Consumes/Produces：** I2、既有 `personalConnections`、`Promise<string|null>` mutation → 对话卡片。

- [ ] RED：点击同步预占空 tab、响应后 replace 并断 opener；popup blocked 时有新标签链接；null 授权 URL 时转现有 key 页面，不导航到 null。
- [ ] 轮询 2,000ms，仅等待时运行，最多等待 5 分钟后转明确重试；成功只接受 personalConnections 中 serverId 匹配且 revoked !== true 的记录。
- [ ] 成功后精准 invalidation 当前插件/授予查询，提示再次发起；不自动再次调用先前工具。
- [ ] 测试失败、关闭弹窗、组件卸载、切 Bot/组织后的旧响应；查询结果必须绑定当前有效范围，旧请求返回不能更新新卡片。
- [ ] en/zh-CN、键盘按钮、status live region；V-B 跑 UI suite，记录窄屏可用性证据。

**预计：** 1–1.5 日。**验收：** A06。**回滚：** 不渲染 marker 卡片时保留可读拒绝与原设置入口。

### Task U04：工具活动分组与摘要

**角色：** frontend_implementer / frontend_validator。**依赖：** U03。
**Files：** Create `app/src/components/channels/tool-activity.tsx`, `app/tests/tool-activity.test.tsx`；Modify `chat-transcript.tsx`, `browser-activity.tsx`, `app/src/locales/{en,zh-CN}/channels.json`。
**接口：** `groupToolSteps(items:readonly VisibleChatItem[]):TranscriptItem[]`，ToolGroup `{kind:'tools',id:string,steps:ToolItem[]}`；只改变视图投影，不写回消息。

- [ ] RED：多个相邻 mcp/browser 工具折为一组；单 connector 保持单行；文本消息打断分组；id 使用首步骤 id 以免流中重挂载。
- [ ] 连接要求、Team Bot consent、审批、人机接管和自定义组件工具不隐藏在折叠中。可显示的 result 始终先走现有 asText/forDisplay/refusal 处理。
- [ ] pending→success/blocked/failed 的计数随最终结果更新；完整参数/结果仍可逐项展开；不截去唯一错误信息。
- [ ] 分类先支持 generic connector/browser；R03 后再接入 research 角色标签，避免 U04 依赖尚未建立的 R01。
- [ ] V-B 验证流式更新不闪烁、展开状态稳定、键盘操作和中英文。

**预计：** 1–1.5 日。**验收：** A07。**回滚：** 恢复原 transcript projection，历史消息不需迁移。

### Task L01：Computer 私有验证码 endpoint 与 gateway

**角色：** backend_implementer / backend_validator。**依赖：** S00。
**Files：** `agent-computer/src/{sign-in,index,authorisation}.ts`, `server/src/computer/{schema,gateway}.ts`；Test `agent-computer/tests/sign-in.test.ts`, 新 `server/tests/computer-sign-in-code.test.ts`。
**Consumes/Produces：** 现有 signIn 授权路径 → I3 Computer/gateway；此时暂不修改 web 表单。

- [ ] RED：密码提交后出现可见 one-time-code 字段报告 codeRequested；无字段不报告；输入值从不返回。
- [ ] 实现独立 parseSignInCode 与 fillSignInCode；code 字段只在已验证 origin 的当前页面定位，跳到不同 origin 明确拒绝，不跨 origin 猜字段。
- [ ] `/sign-in/code` 与已有私有 sign-in 路径使用同等服务认证、Bot 范围和人工控制屏障；不能将其注册为模型可填秘密的通用工具。
- [ ] gateway 类型和 post 路径兼容扩展；依赖 fake gateway 的测试 fixture 显式更新，不能用类型断言掩盖缺方法。
- [ ] 用 Playwright 本地静态测试页验证正确 code、错误 code、回密码页、DOM 消失、超时与导航；V-N 跑 agent suite，server 新测试按实际 Bun 依赖归层。

**预计：** 1–2 日。**验收：** A08 基础协议。**回滚：** server 新入口关闭后可退 Computer；旧密码 endpoint 保留。

### Task L02：验证码持久状态、请求租约与恢复

**角色：** backend_implementer / backend_validator。**依赖：** L01。
**Files：** `server/src/passwords/{types,store,service,routes,resume}.ts`, `server/src/db/schema/passwords.ts`, `server/src/audit.ts`（验证码事件类型与脱敏载荷）, `server/drizzle/<next>_sign_in_code_step.sql`, `server/drizzle/meta/_journal.json`；Tests `server/tests/passwords-sign-in.test.ts`, `server/tests/passwords-store.integration.test.ts`。
**Consumes/Produces：** I3 gateway → I3 status、submitCode、私有 route；保持现有 RequestView 的秘密排除。

| 当前状态/事件 | 下个状态 | 操作 |
|---|---|---|
| pending 提交密码 | filling | CAS 领取，保留 120 秒 lease |
| filling，网站要求 code | code_required | 清空 fillingUntil，不恢复 agent |
| code_required 显式提交 code | filling | CAS 领取，调用独立 code endpoint |
| filling，code 明确错误且字段仍在 | code_required | 保留请求，允许用户明确重试 |
| filling，回密码页 | pending | 明确要求重新登录 |
| filling，确认完成 | signed_in | 执行现有终态恢复机制 |
| 请求取消/到期 | cancelled/expired | 不再接受输入，不自动重放 |
| 已发送后结果不明/lease 到期 | failed | outcome 明确“无法确认是否完成”；不自动重发、不报告成功。用户可接管检查，或知情后新建请求 |

- [ ] RED：新状态能存取、pending 列表含 code_required、终态不含它；两并发 code 提交仅一个 CAS 成功，另一个返回 409。已取消/已到期请求的迟到响应不得覆盖终态、保存密码或重新恢复 agent；所有写回使用预期状态与有效 lease 的条件更新。
- [ ] 新 migration 只扩充 check constraint；不改现存 migration，不新增保存 code 的列，fresh install 与已有数据升级均检查。
- [ ] 实现 submitCode；沿用 owner/request/Bot 授权，拒绝错误用户、过期、终态、未到 code_required 的请求。
- [ ] 初次 submit/use-saved 收到 code 字段只忽略，不输入；所有错误/日志经已有秘密清理，审计仅 request/site/method/category。
- [ ] 网络不确定不自动重发或声称成功；到期 lease 从 filling 以 CAS 进入 failed 并写入不含秘密的“结果无法确认”说明，禁止现有过期 filling 自动回 pending 导致误重放；service 重启只恢复状态，不重新调用 gateway。明确密码/code 失败且可证明未完成的分支按状态表返回 pending/code_required。
- [ ] 验证 code_required 不触发 onResolved、不恢复 headless continuation；signed_in 才走现有终态机制；复用现有防重复恢复边界，不新建第二套 queue。
- [ ] V-N 服务测试 + V-B DB 集成 + migration 演练；记录数据库版本和新增编号。

**预计：** 1.5–2.5 日。**验收：** A08。**回滚：** 新请求入口先停，排空/取消 code_required 与 filling，再回滚 API；保留扩充 schema。

### Task L03：分步登录表单与客户端兼容

**角色：** frontend_implementer / frontend_validator。**依赖：** L02。
**Files：** `app/src/components/passwords/sign-in-form.tsx`, `app/src/lib/passwords/{queries,mutations}.ts`, `app/src/lib/copilot/sign-in-tool.tsx`, `app/src/locales/{en,zh-CN}/settings.json`；Tests `app/tests/sign-in-card.test.tsx`, 新 `app/tests/sign-in-code-step.test.tsx`。
**接口：** 增加 `submitSignInCodeMutationOptions(queryClient)`，variables `{id:string,code:string}`；SignInStatus 增 code_required，FINAL_SIGN_IN 保持四终态。

- [ ] RED：pending 只显示用户名/密码，不提前询问 code；code_required 只显示 code 与必要说明；初次 UI 不再发送 code。
- [ ] submit/use-saved 保持现有保存密码选择；验证码字段从不进入密码 vault；提交/取消/卸载清空秘密，避免 TanStack mutation 完成后长期保留包含 code 的 variables。
- [ ] wrong code→可重试、filling→禁重复点击、expired/cancelled→无可提交控件；独立 `/sign-in/$requestId` 页面与聊天 dialog 共用相同状态。
- [ ] sign-in tool 保持等待 code_required，不提前返回成功；用户导航/组织变化关闭旧 request 绑定并清理旧查询结果。
- [ ] V-B 验证 keyboard/autoComplete/status、15 分钟现有等待窗口和两语言；旧 client 的上游 code 字段在服务端不会提前执行。

**预计：** 1–1.5 日。**验收：** A08 端到端。**回滚：** 必须与 L02 状态排空步骤联动，不单独替换成旧表单处理新状态。

### Task D01：非阻断的启动诊断适配

**角色：** backend_implementer / backend_validator。**依赖：** S00。
**Files：** 新 `server/src/model-availability-check.ts`, `server/src/intelligence-entitlement-check.ts` 及同名 tests；Modify `server/src/index.ts`。
**Consumes/Produces：** I5；配置沿用本地 model-access/Bifrost 与 Learning 依赖是否启用的真实条件。

- [ ] RED：缺 key、无 Intelligence/learning 关闭→skipped；供应商 401/403→credential-rejected，官方 model API 404→model-unavailable，兼容 endpoint 不提供 lookup→skipped/unknown。
- [ ] 3 秒 deadline，同时用 AbortSignal 取消支持的网络请求；只用 Promise.race 超时但让请求永久悬挂不算完成。
- [ ] 已有网关 readiness/目录能够证明相同行为则复用；没有安全 provider 元数据通道则跳过，不旁路用户虚拟 key 去调第三方。
- [ ] entitlement 只诊断实际启用的可选学习依赖，不让 Hindsight/普通聊天被 Intelligence 失败阻塞。
- [ ] 注入 fake fetch/logger 验证分类、超时、无秘密；启动装配验证错误只记录一次，服务器仍正常启动。

**预计：** 0.5–1 日。**验收：** A09。**回滚：** 去掉诊断装配，不动配置/业务请求。

### Task R01：共享研究角色与 provider catalogue

**角色：** backend_implementer / backend_validator。**依赖：** S00。
**Files：** Create `shared/research.ts`, `shared/research.test.ts`；Modify `server/src/plugins/catalogue.ts`, `server/tests/plugin-catalogue.test.ts`。
**Consumes/Produces：** I4、CatalogueAuth 的兼容 `header?:string` 和 `tokenHeaderFor(entry):string`（默认 Authorization）。

- [ ] RED：I4 六 key 与 catalogue 一致，logical role 错拼/多斜线→null；继承原 Parallel ID，旧 grants 不失效。
- [ ] 从固定上游 catalogue 提取 reviewed HTTPS host/path/认证 header/readTools，写入本地 allowlist；不让管理员任填 header 名或 credential URL。
- [ ] Exa 只读 allowlist 包括 search/fetch/advanced_search 的上游明确工具；Firecrawl crawl/agent/interact/feedback 不归 read，未知工具 fail closed。read 表示权限类别，不表示免费。
- [ ] catalogueEntry/resolveServerUrl/classifyTool 原有签名兼容；新类型扩展不改变现有 provider 默认认证行为。
- [ ] V-N 测试正常与子域伪装、路径变种、重复 catalogue key、未知工具分类。

**预计：** 0.5–1 日。**验收：** A10 静态角色/目录。

### Task R02：MCP 认证、skill ref 和治理执行

**角色：** backend_implementer / backend_validator。**依赖：** R01。
**Files：** `server/src/plugins/{mcp,tools,store,selection}.ts`（只修改实际使用到的入口）、`server/tests/parallel-research.test.ts`、新 `server/tests/web-research.test.ts`、现有 plugin selection/MCP authorization tests；文档 `.env.example`, `docs/web-research.md`。
**Consumes/Produces：** I4 角色、reviewed header → 已授予工具的研究提示和正常 MCP 调用。

- [ ] RED：tokenHeaderFor 正确发送供应商指定 header；无 key 不发送请求；旧 Parallel 使用原认证行为；日志/审计无 header token。
- [ ] `@research/search|fetch` 展开时与实际已授权 tool refs 求交；不因 skill 宣告角色授予新 connector。旧 `parallel/web_search` 和 `parallel/web_fetch` refs 继续可用。
- [ ] 引导语不再固定为 Parallel；只在实际 search/fetch 能力完整时说明具备完整研究，供应商专用 notes 分开注入。
- [ ] mock MCP 验证超时、认证失败、撤权、SSRF、写工具拒绝、不自动换供应商；保留实际 provider/server/tool 身份进入现有审计。
- [ ] 检查模型 token 账单与外部 MCP 供应商费用边界：不凭空给 provider API credits 创建 token 账单；本地已有收费规则照常，真实调用和原有计量不重复。
- [ ] V-N/V-B 验证研究合约与预算/Payer/组织隔离；用真实 provider key 的 smoke 单列环境要求，未联调不能标线上通过。

**预计：** 1–2 日。**验收：** A10 后端。**回滚：** 禁用新 provider、恢复原 skill refs；原有 Parallel 账户/grant 和 audit 不删除。

### Task R03：研究工具标签与 skill 选择 UI

**角色：** frontend_implementer / frontend_validator。**依赖：** R02、U04。
**Files：** `app/src/lib/plugins/tool-name.ts`, `app/src/components/channels/tool-activity.tsx`，`app/src/components/skills/skill-tools.tsx`, `app/src/lib/skills/form.ts`、`app/src/locales/{en,zh-CN}/{channels,settings,skills}.json`；Tests `app/tests/tool-name.test.ts`, `app/tests/tool-activity.test.tsx`。
**Consumes/Produces：** I4 逻辑角色和实际 tool refs → provider 无关标签与正确授权选择。

- [ ] RED：三 provider search/fetch 对应“搜索网页/读取网页”；未知 tool 显示原名，不误标成功/只读。
- [ ] 聚合摘要按真实步骤统计查询/页面数，错误时保留 provider 原因和原始来源链接；没有返回页面数时不编造数量。
- [ ] 在现有 SkillTools 增加逻辑研究角色选项；form 的 undeclaredElsewhere 不把合法角色当作失效工具；兼容旧实际 ref，声明不等于授权的说明保留。
- [ ] V-B 验证两语言、展开结果、单 provider 配置和部分授权。

**预计：** 0.5–1 日。**验收：** A10 前端。

### Task E01：后续架构与客户端差距评估

**角色：** architect / reviewer，只读生产代码。**依赖：** S00。
**Files：** 新同目录 `adoption-decisions.md`；只读 `apps/openmuse/apps/mobile/`, 本地 harness、Mastra Spec、固定上游 mobile/toolkit/harnesses。
**输出：** 每项 `现有入口/行为差距/约束/复用方案/后续验收/采用或延期结论/证据路径`。

- [ ] 固定子模块 commit；分别登记移动端有页面、有 API、已实测，避免把目录不存在等同业务缺失。
- [ ] 比较 Antigravity Gemini key 与现有逐用户网关授权，不能支持就明确不接入；评估 shared harness catalogue 保留本地 trpc/sandbox 等差异的方式。
- [ ] toolkit 中 lock/lease/settle/cancel 映射到 Mastra 已批准任务，复用行为要求，不增加第二套执行权威。
- [ ] 对已具备记忆镜像/Learning/身份绑定/CSV 导出记录现有实现；不重复创建实现任务。
- [ ] 输出独立后续范围与工作量前提，不将评估通过宣称为功能上线。

**预计：** 1–2 日。**验收：** A12。

### Task V01：集成验收、回滚演练与最终审查

**角色：** 主控；backend_validator/frontend_validator/reviewer 分别只读验收。**依赖：** 所有选定变更任务及 E01。
**Files：** 本目录 `verification-summary.md`, `rulings.md`, `ocr-round-N.*`, ledger；不由验证者修改业务和测试源。

- [ ] 按 §1 对 A01–A12 逐项绑定检查点/命令/实际执行数/报告；缺结果保持 pending/blocked，不用“局部已过”代替整项通过。
- [ ] 企业回归：两公司、同公司两团队、个人与公司 Payer、权限撤销、同 Bot 并发、停止/恢复；普通聊天、审批、Craft 预览、未审核记忆不可召回保持原规则。
- [ ] fresh DB/既有 DB 升级，以及 B 批次 UI/API/Computer 新旧组合；关闭新入口、排空 code 状态后回滚，确认不重发外部动作。
- [ ] 跑 V-ALL，Rust/Python 只有受影响时运行其包既有检查；发现环境不足附具体连接/服务证据，不自称产品已通过。
- [ ] 独立 Spec + quality Review；主控通过 open-code-review Skill 执行全范围 OCR，`--audience agent`，按实际支持语法与 provider 配置，不假定 Codex 别名可用于 OCR。
- [ ] 未提交交付用 workspace 模式；若同时有授权提交，则另查原始 BASE→HEAD。每轮单独保存范围、SHA/哈希、退出码、警告、失败/跳过文件及 findings。
- [ ] 有效 critical/high/medium 进入有编号修复 DAG/计划，经 SDD 修复、补验证与独立复审，再跑完整 OCR；两轮同问题无进展升级 systematic-debugging。
- [ ] 所有证据持久化后才清理工作区；按 finishing-a-development-branch 收尾。实际部署仍由明确发布授权控制。

**预计：** 2–4 日，额外环境排障单列。**验收：** A11 与完整交付范围无未解决阻塞问题。

## 5. 验证命令清单

这些命令是计划中的执行入口，当前未运行。V-N 用于 import e2e-compat 的 native suite；V-B 用于 import bun-test-compat 或真实 Bun API 的 driven suite。不得因为同是 `.test.ts` 就假定同一层。

**V-N：已核验 native 的定向命令**（分别在各任务运行）：

```bash
E2E_UNIT_SCOPE=server bunx e2e run --config e2e.unit.config.ts server/tests/config.test.ts server/tests/single-user.test.ts
E2E_UNIT_SCOPE=server bunx e2e run --config e2e.unit.config.ts server/tests/enterprise-controls.test.ts
E2E_UNIT_SCOPE=server bunx e2e run --config e2e.unit.config.ts server/tests/responsibility-triggers.test.ts
E2E_UNIT_SCOPE=server bunx e2e run --config e2e.unit.config.ts server/tests/routine-schedule.test.ts
E2E_UNIT_SCOPE=agent-computer bunx e2e run --config e2e.unit.config.ts agent-computer/tests/sign-in.test.ts
E2E_UNIT_SCOPE=server bunx e2e run --config e2e.unit.config.ts server/tests/passwords-sign-in.test.ts
```

**V-B：定向 Bun 与统一驱动证据**：

```bash
bun test ./server/tests/otel-export-scrubbing.test.ts
bun test ./app/tests/auto-watch-screen.test.tsx
bun test ./app/tests/connect-app-card.test.tsx
bun test ./app/tests/tool-activity.test.tsx
bun test ./app/tests/sign-in-code-step.test.tsx
# 每个新增 suite 明确 import 和归属后登记；以下命令只用于已归 driven 的对应文件
E2E_BUN_ONLY=app/tests bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts
```

`E2E_BUN_ONLY` 匹配的是驱动 group.name 子串（例如 app/tests），不是单个文件路径；必须核对选中 group 及实际执行文件。上面的 driven 命令会运行 app/tests 对应组，不能声称只执行一个文件。

新 server tests 若只能在 Bun/DB 层运行，按 driven 单文件执行并补统一驱动证据；如可 native，优先 e2e-compat。DB tests 使用独立 fixture 数据库，不重用其他执行流的库。

**V-ALL：集成守门**：

```bash
node scripts/e2e-coverage-audit.mjs
E2E_UNIT_OUTPUT=.e2e/upstream-refactor bun run test:ci
bun run typecheck
bun run lint
bun run build
```

以上命令预期退出码 0、相关 suite 实际执行且无非预期 skip、报告路径与命令环境一致。若基线已有红，S00 先登记同版本基线；本次不能新增红，且影响本次验收的已有红须解决后才可完成。不能通过降低最低用例数、删除 suite、改已有预期或把 RLS 拒绝标为没库取得通过。

## 6. 执行检查点与 brief 模板

每 Task 的 brief 固定包含：Task/AC、事实源路径、工作区与 BASE、依赖检查点、owner_role、owned_files、Consumes/Produces、允许的测试/报告写路径、禁止范围、提交策略、失败升级条件、报告路径。子 Agent 不继承整个父会话、不再派发 Agent。

无提交授权时，before/after 都保存 tracked staged/unstaged patch、任务内 untracked 文件完整内容与 SHA-256 清单。Review Package 必须是 before→after 增量，包含新增/删除文件；不能拿空 BASE..HEAD 通过 Review。验证证据绑定 after 哈希，生产或测试内容变化后失效项须重做。

实施者报告交付内容和自查；验证者仅补缺失行为/验收证据，不改源代码“修绿”；reviewer 给出 Spec compliance 与 quality 两结论。每任务修复最多按 SDD 规定轮次处理；外层 OCR finding 形成新的编号修复计划，不重派原已完成任务。

## 7. 发布批次与兼容矩阵

| 批次 | Tasks | 可发布结果 | 放行要求 |
|---|---|---|---|
| A | S01–S04 | 安全/解析/调度修复 | 无 schema 变更；定向测试、独立 Review、该批全范围 OCR |
| B1 | U01–U04 | 自动看屏、连接卡片、活动摘要 | 原手动入口可用、旧结果可读、OAuth 完成后不重放 |
| B2 | L01–L03 | 密码/code 分步 | migration→兼容 Computer→API→UI 顺序；新入口最后启用 |
| C | D01、R01–R03 | 有界诊断、可选研究 provider | 原部署配置不变可启动、缺 provider key 明确不可用 |
| D | E01、V01 | 后续决策和完整交付证据 | 无推迟的 blocker、最终原始 BASE 全范围 OCR |

| 登录组件组合 | 预期 | 限制/验证 |
|---|---|---|
| 旧 API + 新 Computer | 旧密码功能可用 | codeRequested 是附加字段，不要求旧 API 识别新步骤 |
| 新 API + 旧 Computer | 普通密码路径可用 | 新验证码功能暂不可用，不能把缺 endpoint 说成验证码错误 |
| 新 API + 旧 UI | 初始旧 code 忽略 | 若需要验证码提示用户刷新/使用新页面；不得提前输入旧字段 |
| 新 UI + 旧 API | 不作为发布支持组合 | 部署 UI 在 API 之后；禁止让新 UI 接口缺失静默成功 |
| 完整新栈→旧栈 | 先停新请求并处理在途状态 | code_required/filling 清空或终态化后，留新 schema 回滚应用 |

此处是兼容目标，L01–L03 需用真实组合验证。不可支持的组合列为发布约束，不声称任意滚动升级安全。部署开关优先复用现有配置；无开关时用版本化批次发布，不为方便评审引入无治理的全局开关。

## 8. 工期、优先级和计划自查

18 个 Task（含工作区准备、评估、最终验收），建议单流约 **13–23 工程日**，另给现有基线失败/第三方环境准备留独立排障项；不是完成日期承诺。先 A 后 B1，B2 需要协调 Computer/API/数据库，C 可在 B 批次验收后推进。E01 评估产出的 Antigravity、移动端补全与拆包实施均不计入。

- [x] 每条 AC 都映射任务，真实接口前置与调度次序分开。
- [x] 每个实现 Task 指定文件、角色、接口、RED/GREEN、验收及回滚/失败处理。
- [x] I1–I5 的生产者与消费者命名一致，新增类型不依赖未计划引入的 toolkit。
- [x] 当前已验证路径用于具体任务；动态迁移编号明确由 journal 分配并持久记录。
- [x] Review Focus 逐项进入任务用例，未给外部副作用作无法保证的 exactly-once 承诺。
- [x] 初稿只交付计划；2026-10-20 用户采用后已发布正式 Issues，未测试、未启动实施。

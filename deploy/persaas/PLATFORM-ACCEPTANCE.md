# OpenBot 平台功能验收

验收日期：2026-11-28。结论：**核心文字聊天可用，全平台尚未通过验收**。本次使用真实浏览器经 Casdoor 登录 OpenBot，并验证业务写入、执行、持久化和中间件读回；容器健康和页面打开不等同于功能通过。

## 实际结果

| 功能 | 结果 | 实际操作和证据 |
| --- | --- | --- |
| Casdoor 登录 | 通过 | 点击主站 Okta 入口，实际跳转 Casdoor，使用现有管理员账号登录；完成首次引导，再退出并重新登录 |
| Bot | 通过创建与配置读回 | 新建私有 Bot「平台功能验收 20261128」，设置指令，重新打开设置可读回；未测所有分享、委派组合 |
| 文字聊天 | 通过 | 新建会话，返回 `UI-WAF-FIX-20261128-OK`；同会话后续消息返回 `FOLLOWUP-20261128-OK`，刷新后第一轮回复仍在 |
| 例行任务 | 通过手动执行 | 页面创建「平台验收临时例行任务 20261128」，Run now 经 Worker 执行并返回 `ROUTINE-20261128-OK`；随后关闭定时开关，未等待真实日历触发 |
| 技能 | 通过 | 页面保存 `platform-check-20261128`，在 Bot 的 Skills and access 中开启；新会话 `/` 菜单选中执行，返回 `SKILL-20261128-OK` |
| 记忆 | 通过基础管理 | 页面新增临时事实、读回、暂停，再确认 Forget 删除；未测跨会话自动提取与模型召回 |
| 设置 | 通过外观往返 | 打开设置，切换深色主题后恢复；未修改用户名称和全局指令 |
| 审计 | 通过业务事件查看 | 管理员 Audit 页面可见创建任务、运行任务、开关任务、保存技能及修改设置事件；OpenObserve 同时读到真实 audit 数据 |
| Opik | 通过自动追踪 | 主站追踪状态从 pending 变为 complete；使用 Opik API 独立读回聊天、例行任务和后续消息的真实 Trace |
| OpenObserve | 通过自动采集与权限 | 采集到真实 Worker 运行事件及审计事件；运行日志 30 天、审计副本 90 天；两个写入身份跨流 403、查询 401 |
| Lago | 通过零费率客户端核对 | UTC 专用客户、microcredit sum 指标、零费率订阅；实际 Worker 客户端 `verifyDestination()` 通过，事件首次与重放读回均 matched，金额 0 |
| 附件问答 | **失败** | 44 字节文本附件可选中并显示，但发送返回 HTTP 400 `A text message is required.`；未到模型读取阶段 |
| 目标 | **创建通过、执行失败** | 对话工具创建非周期目标，Goals 页面读回；Run now 返回 `The backend is not configured.`；测试后已结束目标 |
| 新会话历史／语音归档 | **存在异常提示** | 技能新会话出现无法加载早先消息／语音归档提示；同一会话手动调用消息接口返回 200、4 条记录。文字回复可用，但该提示尚未修复 |
| 目标详情交互 | **存在布局问题** | 部分操作被表单覆盖，普通点击完成目标超时；清理时通过页面 DOM 触发按钮并确认完成，不能算普通点击验收通过 |
| Apps | 待接账号 | Connections 目录可见，但没有启用外部应用；不能证明任何第三方业务调用成功 |
| Credits／预算／充值／扣费 | **未配置完整** | 页面显示 Billing Account unavailable、No model route yet、无 Test Credits；未创建真实收费套餐、未充值、未扣款 |
| CubeSandbox | **缺现有 API Key** | 健康接口可访问，模板和沙箱接口 401；浏览器/电脑功能不可用。未修改 43.136.78.18 |
| Flexprice | 公网 HTTPS 已验、业务未接 | 原生登录、环境列表、环境内客户 API 与浏览器登录页通过，见文末更新。OpenBot 仍使用 Lago 用量适配器，尚未切换到 Flexprice |
| Redis | 当前方案已确认 | 2026-11-28 用户确认先保留共享单实例、按应用分 DB，后续升级 Sentinel；不再作为本阶段阻塞项。当前无自动故障切换 |
| 语音、转录、共享与高级管理策略 | 未全面验收 | 未提供语音服务、第三方账号等依赖；只检查了部分管理页面，不将未测项记为通过 |

## 本轮部署修复

1. 新增应用节点 OTel Collector，API 与 Worker 从 Infisical 读取日志导出配置。OpenObserve 入口使用分流写入令牌，运行身份不持有管理员密码。
2. 配置 Lago 专用 UTC 零费率用量核对订阅，并将 exporter 参数写入 Runtime/worker。这是用量核对，不是商业收款接入。
3. 修复原生聊天的 1Panel WAF 误拦截。只有严格匹配 `/api/copilotkit/agent/<id>/(connect|run)` 的 POST 跳过继承的 WAF access handler；后端登录、归属、来源检查继续执行，其余路由保持 WAF。含代码示例的匿名探针由 HTML 403 恢复为应用 JSON 401，完整已登录原请求恢复为 SSE 200，随后真实 UI 聊天通过。
4. 修复 Opik / ClickHouse 26.11 的压缩兼容问题：仅 Opik 专用用户 profile 配置 `network_compression_method=LZ4`。直接 Java 驱动读取从 `Invalid LZ4 magic byte: '-112'` 变为连续 15 次成功；拓扑、ClickHouse、MySQL、Redis 等 12 项内部检查均 healthy。降低 Docker 检查频率至 30 秒，检查请求有超时；数据库检查预算改为 10 秒。

压缩问题及用户 profile 兼容设置见 [ClickHouse Java 上游记录](https://github.com/ClickHouse/clickhouse-java/issues/3105)。保留共享 ClickHouse，未降级数据库或新增实例。

## 复现与维护

脚本均针对本仓库记录的两台服务器，不是通用安装器。以下配置脚本在数据节点以 root 执行，读取本机私密凭据；请先备份。新增脚本已复制到 `/opt/persaas/`。

```sh
python3 /opt/persaas/configure-observability.py
python3 /opt/persaas/configure-lago-usage.py
python3 /opt/persaas/configure-chat-proxy.py
python3 /opt/persaas/configure-opik-health.py
python3 /opt/persaas/archive-panel-config.py
```

Collector 配置来源为 `deploy/openobserve/otel-collector.yaml`，应用节点放置在 `/opt/persaas/otel-collector.yaml`；`collector.env` 从数据节点的私密生成文件安全复制，权限 600，并创建 `runtime-logs` 目录。应用节点使用本目录 `apps.yml`；更新 Runtime 参数后重建 openbot、worker，启动 otel-collector。

配置归档位于 Infisical 的独立 Infrastructure 项目；归档不会自动热更新 1Panel 应用。`entry-proxy` 保存聊天代理配置，`collector` 保存采集器私密环境，`openobserve` 保存写入令牌及入口配置。运行身份没有 Infrastructure 项目读取权。

在开发机执行回归探针：

```sh
python3 deploy/persaas/probe-copilot.py
```

预期：携带合法代码示例的匿名聊天请求到达应用并返回 JSON 401。该探针只证明网关和匿名拒绝行为；真实聊天证据见 [浏览器截图](evidence/chat-browser.png)。

## 业务证据标识

- 私有验收 Bot：`agent_b928edde-f223-4578-a566-fd7b3117cbbc`。
- 文字会话：`channel_82c70f8766be65fecddd45c38f5c35c0`。
- 例行任务会话：`channel_01071960-0da4-42f1-be22-eed779e45700`；run `routine_run_4f9e6303-abd9-49dc-a61f-9945b0ab4504`。
- 技能会话：`channel_f0aa9d6d0d8261dcc36e2e6033b999c5`。
- Opik 聊天 Trace：`01a21e8a-06b9-7ed6-897e-9a9613aaa070`，duration 19138ms。
- Opik 例行任务 Trace：`01a21e91-d380-7805-8afc-26315d1c5c82`，duration 18103ms。
- Opik 后续消息 Trace：`01a21e98-bb8f-7398-8c66-b1dd325838d7`，duration 15344ms。
- Lago 零额事件：`d24ab840-1718-44d3-a010-afb37b5cce1c`。

Trace 仅含状态、时间和 duration 等元数据；此轮没有为测试上传聊天正文到 Opik。验收 Bot、技能和会话保留便于复查，临时记忆已删除、定时任务已禁用、目标已结束；它们不代表已配置真实客户的业务。

## 待修复代码与配置缺口

- 附件：前端 `toMessageContent` 生成分段内容，但 `server/src/channels/direct-chat.ts` 的 `promptMessage` 只接受字符串。需要完整解决持久化、重放和附件授权，不能简单丢弃附件改成纯文本后宣称通过。
- 目标：`server/src/responsibilities/wiring.ts` 的执行仍依赖 Intelligence runner；当前部署为 OpenBot 原生运行模式。需要接入原生后台执行后再测。语音归档和历史提示也需要在该模式下排查。
- 商业计费：尚需账户、费率、预算、Test Credits、用量出站全链路和支付策略；Lago 测试事件不能代替真实业务结算验证。
- 补齐 CubeSandbox 现有 API Key、第三方服务凭据后才能完成对应功能验收。Flexprice DNS 与 HTTPS 已在后续更新中完成。不得为绕过缺失密钥修改 CubeSandbox 主机。
- Sentinel 已按用户决定列为后续升级项。对象存储/ClickHouse/Kafka/Redis 完整备份及自动异机复制仍待完成。

## 复验与备份

- 本轮再次执行 `acceptance-middleware.py`，16 项全部通过。
- Python 脚本语法、Shell 语法、Git 空白检查及原生聊天匿名回归通过。
- 新归档 `/opt/persaas/backups/postgres-20261127T200120Z.tar.gz`，SHA-256 `6edf54f543b9bbe95a6947542589afcb342d6615859ec799e91f65c8b05a9880`。
- 7 个共享 PostgreSQL 库、Lago 独立 PostgreSQL、Opik MySQL 共 9 个库逐个恢复到临时库成功，随后删除临时库。
- 归档已复制到应用节点 `/opt/persaas/backups/platform-backup-20261128.tar.gz`，SHA 一致；增加了采集器环境和两个代理配置的恢复覆盖。它仍不包含 ClickHouse 业务数据和 RustFS 对象。

本轮临时部署公钥已从两台主机删除，本机临时私钥和备份中转文件已移除；专用服务隧道密钥保留。主站退出后 `/api/me` 返回 401；浏览器验收标签已关闭。1Panel 临时密码文件与本轮会话缓存已删除。

## Flexprice public HTTPS update — 2026-11-28

DNS on the entry host resolves `flexprice.persaas.cn` to `129.28.39.52`. The certificate expires on 2027-02-26. HTTPS returns 200 with successful certificate validation; HTTP redirects with 301. Native login, environments and environment-scoped customers return 200 through the public origin. Anonymous API access returns 401 and public signup returns 403. The browser displays the login page without resource HTTP errors; browser form login and billing operations were not tested in this update.

Endpoint and proxy files remain on the server under 1Panel management. The old Infisical `/flexprice-admin` archive was removed when vault scope was narrowed to container env files. The domain is managed in 1Panel Websites (proxy site ID 54, Running); HTTPS and HTTP redirect were verified after migration. The panel owns its WAF registration. This update does not switch OpenBot billing to Flexprice.

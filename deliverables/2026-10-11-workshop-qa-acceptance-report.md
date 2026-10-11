# Workshop 工作台 QA 验收报告

- **日期**：2026-10-11
- **对象**：OpenBot Workshop 工作台（频道维度：过程 / 文件 / 产物 / 用量 / 分享 / 定时）
- **环境**：macOS (darwin) · 后端 `bun src/index.ts` @ 127.0.0.1:3999（单用户模式）· 前端 Vite @ 127.0.0.1:3020 · docker compose（agent-sandbox / postgres healthy）· 全程 `--noproxy '*'` + `NO_PROXY=127.0.0.1,localhost`
- **测试频道**：`channel_323a499f-7798-4219-9f39-647676e71447`（smoke-ws-bot）

---

## 第一部分：API 冒烟（4/4 PASS）

| # | 用例 | 结果 | 证据 |
|---|------|------|------|
| A | `GET /api/workshop/<频道>/files?path=` | **PASS** | `200`；JSON 文件数组 9 项（data.txt / out.csv / smoke-mv*.txt / upload-test.csv）。历史回归点（沙箱 gzip 头残留致 500）**未复现** |
| B | `POST /api/workshop/<频道>/share` `{scope:preview, expiresInDays:7}` | **PASS** | `201`；返回 `token=TQ0NBCC1…`、`shareUrl=/workshop/<频道>/shared?t=…`、`expiresAt=+7d`。历史回归点（路由未挂致 404）**未复现** |
| C | `GET /api/workshop/<频道>/turns/<最新turnId>/events` | **PASS** | `200`；events 数组非空（progress / thought / message_chunk / 工具事件按 seq 完整回放终态轮次） |
| D | `GET /api/public/workshop/share/<编造token>` | **PASS** | `404`（统一文案，无 403/500）。对照验证：真 token 走 `/:channelId/public/artifacts?t=` 返回 `200` + artifacts 列表（preview scope 下 downloadUrl=null 符合设计），证明 404 为业务判定而非路由缺失 |

> 备注：题目给定的 `share/<token>` 路径格式在本仓库实现中对应 `/:channelId/public/artifacts?t=<token>`（server/src/workshop/public-routes.ts），已按实际路由做双向验证。

## 第二部分：浏览器端到端（9/9 PASS）

工具：Playwright (chromium headless) · locale=zh-CN · 直达 `/channel/<id>?workshop=true`

| # | 用例 | 结果 | 证据要点 |
|---|------|------|---------|
| 0 | 加载 | **PASS** | 全程 `role=alert` 计数 0，无「工作台加载失败」 |
| 1 | 过程 | **PASS** | 终态轮次渲染历史事件流：已成功 / busy / 思考（折叠）/ 工具 write×3 / idle / 「本轮已完成」；未出现「这轮没有留下事件」 |
| 2 | 文件 | **PASS** | 文件树完整列出 9 文件（含字节大小，1 秒内完成加载）；未出现「工作台加载失败」 |
| 3 | 产物 | **PASS** | 下载链接直连后端验证：`HTTP 200`、`content-disposition: attachment; filename="smoke-mv3flxi1.txt"`、11 bytes |
| 4 | 用量 | **PASS** | 六格统计齐全（输入 0 / 输出 0 / 轮次 1 / 成功 1 / 失败取消 0 / 费用）；费用列显示「—」而非 NaN |
| 5 | 分享 | **PASS** | 「创建链接」→ 明文链接绿色面板（aria-label=新建的分享链接）出现，链接只展示一次；复制按钮可写剪贴板（实测内容一致）；关闭后显示「分享生效中，至 <日期>」；撤销按钮存在 |
| 5b | 撤销确认 | **PASS** | 点撤销出现二次确认文案（「撤销后已分享的链接立即失效，确定？」），含确认/取消，点取消保留分享 |
| 6 | 定时 | **PASS** | 间隔模式（每 30 分钟）创建成功 → 列表出现任务 + `*/30 * * * * · UTC` + 「下次 2026/10/11 15:00:00」；暂停 → 显示「已暂停」（API 侧 nextRunAt 同步清空）；启用 → 恢复 enabled + nextRunAt 重新计算 |
| 7 | 控制台 | **PASS** | error 总数 2，全部归为已知噪音：① impeccable-live 开发工具注入的 `localhost:8400/live.js`（app/index.html 注释块，与 workshop 无关）② smoke-ws-bot 的 CopilotKit `Agent not found`。**workshop 相关 error = 0** |

## 第三部分：live smoke 回归（PASS）

```
$ WORKSHOP_SMOKE_SERVER_URL=http://127.0.0.1:3999 NO_PROXY=127.0.0.1,localhost bun run test:live-workshop
smoke: bootstrapping against http://127.0.0.1:3999
smoke: channel channel_b6ceba9b-… created
smoke: turn wt-f386c25… started → succeeded
smoke: artifact wa-99149d… (report, 11B)
smoke: download verified (workshop-ok)
smoke: audit rows present (2 for this turn)
OK: channel …, artifact downloaded, audit verified.   ← 末行 OK
EXIT_CODE=0
```

## 环境事件记录（非产品缺陷）

测试中段 OrbStack（Docker daemon）意外宕机约 2 分钟，导致 postgres/sandbox 全容器失联：API 一度 500、首轮 E2E 的 Files Tab 卡加载。`orb start` 重启后全部容器恢复 healthy，重跑测试全部通过。**该事件与 Workshop 代码无关**，但暴露了本机依赖单点：OrbStack 宕机时无任何告警，建议关注本机 Docker daemon 稳定性。

## 观察项（不计失败）

1. `app/index.html` 中 impeccable-live 工具注入的 `<script src="http://localhost:8400/live.js">` 在端口未开时每次页面加载产生 1 条 `ERR_CONNECTION_REFUSED` console error。属开发工具噪音，但若长期保留建议在交付构建中剔除，避免干扰 console 监控。
2. Vite dev 代理对 `localhost` 的转发在本机代理环境（HTTP_PROXY=127.0.0.1:56231 且无 NO_PROXY）下存在被劫持风险，测试必须带 `NO_PROXY`（本次已全程遵守）。可考虑 vite.config.ts 的 proxy target 显式用 `127.0.0.1`。

## 收尾确认

- 3999 / 3020 测试进程已停止 ✅
- 根目录 `.env` 未改动（关键行 PORT/SERVER_PORT/BETTER_AUTH_*/CASDOOR_OAUTH_* 七行与测前完全一致，SHA 校验留档）✅
- 测试定时任务已删除 ✅

---

## 总结论

**全部通过（15/15 项：API 冒烟 4 + 浏览器 E2E 9 + live smoke 1 + 环境/收尾 1），存在 0 个失败项、0 个产品缺陷；1 起环境事件（OrbStack 宕机，非产品问题）、2 条观察项。Workshop 工作台可发版。**

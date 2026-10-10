# opencode SSE 事件样本（实采冻结）

来源：opencode **1.18.7** 的 `GET /event`，2026-10-10 实采于运行中的 agent-sandbox（会话驱动方式见下）。本文件是 S2/B8/B9/F5 依赖的**事件 schema 事实源**；`../src/events.ts` 的类型与分类从此而来。

## 采集方法

```sh
# 1) 经代理（4300）建 session，驱动 per-bot opencode serve（首个 bot 落 4400 端口）
curl -X POST http://127.0.0.1:4300/session \
  -H "x-sandbox-token: $SANDBOX_TOKEN" -H "x-openbot-bot-id: spike-bot-a" \
  -H "content-type: application/json" -d '{"title":"sse spike"}'
# 2) 容器内直连 opencode serve 的 /event（S2 的 /events 代理转发尚未存在，spike 直取）
docker exec openbot-agent-sandbox-1 \
  curl -s -N http://127.0.0.1:4400/event > /tmp/sse-capture.txt &
# 3) 经代理发一个"写文件 + 回答"任务，录满后停止
```

任务提示词要求模型 ①用 python 写 `out.csv` ②用一句话回答 2+2。一次完整回合录得 **309 条事件 / 81KB**。以下样本已脱敏：session/message/part/event id 换形、bot 工作目录简写、时间戳取整。**结构与字段名未动。**

## 事件类型普查（按出现次数）

| 次数 | 类型 | 产品侧归类（`familyOf`） |
|---:|---|---|
| 179 | `message.part.delta` | message_chunk（field="text" 时） |
| 45 | `plugin.added` | other |
| 29 | `message.part.updated` | thought（part.type="reasoning"）/ tool_call（part.type="tool"） |
| 18 | `message.updated` | other（会话装配事实） |
| 10 | `session.status` | progress |
| 8 | `session.updated` | other |
| 7 | `server.heartbeat` | other |
| 5 | `session.diff` | other |
| 2 | `catalog.updated` | other |
| 1 | `server.connected` | other |
| 1 | `reference.updated` | other |
| 1 | `integration.updated` | other |
| 1 | `file.edited` | other（B4 产物索引起点） |
| 1 | `file.watcher.updated` | other |
| 1 | `session.idle` | prompt_response |

## 与计划五类划分的偏差（以实采为准）

计划 v1 设想的 `message_chunk / thought / tool_call / progress / prompt_response` 是**产品侧族名**，opencode **不按这五个名字发事件**。实采结论：五类全部可由原生类型**推导**，无一缺失，映射固定在 `events.ts` 的 `familyOf`：

1. **message_chunk** = `message.part.delta`（`field:"text"`，`delta` 是逐字增量——179 条就是答案的逐字流）
2. **thought** = `message.part.updated`（`part.type:"reasoning"`，正文在 `part.text`，整段更新而非增量）
3. **tool_call** = `message.part.updated`（`part.type:"tool"`，`part.tool` 是工具名、`part.state.status` 走 `pending → running → completed|error`，一次工具调用发多条）
4. **progress** = `session.status`（`status.type:"busy"` / `"idle"`，会话粒度的进度）
5. **prompt_response** = `session.idle`（活动后的 idle 即"这轮答完了"，流式消费方在此收尾）
6. **subagent**：本次捕获**未出现**（任务未触发子代理）。类型已在 `SandboxEvent` 留位（`unknown` 兜底 + `familyOf` 归 other），等真实样本出现再精化——不编造。

`step-start` / `step-finish` / `text` 是 `message.part.updated` 的**part.type 取值**而非事件类型，随 part 载荷走。

## 样本原文（每类一条，已脱敏）

### server.connected（连接建立，第一条）
```json
{"id":"evt_serverconnected01","type":"server.connected","properties":{}}
```

### server.heartbeat（保活，无载荷）
```json
{"id":"evt_serverheartbeat01","type":"server.heartbeat","properties":{}}
```

### message.part.delta —— message_chunk 的载体
```json
{"id":"evt_partdelta01","type":"message.part.delta","properties":{"sessionID":"ses_SAMPLE","messageID":"msg_SAMPLE","partID":"prt_SAMPLE","field":"text","delta":"2+2 等于 4。"}}
```

### message.part.updated —— part.type="step-start"（步骤边界）
```json
{"id":"evt_partupdated01","type":"message.part.updated","properties":{"sessionID":"ses_SAMPLE","part":{"id":"prt_SAMPLE2","messageID":"msg_SAMPLE","sessionID":"ses_SAMPLE","type":"step-start"},"time":1791658187844}}
```

### message.part.updated —— part.type="tool"（tool_call 的载体）
```json
{"id":"evt_partupdated02","type":"message.part.updated","properties":{"sessionID":"ses_SAMPLE","part":{"id":"prt_SAMPLE3","messageID":"msg_SAMPLE","sessionID":"ses_SAMPLE","type":"tool","tool":"bash","callID":"call_SAMPLE","state":{"status":"pending","input":{},"raw":""}},"time":1791658188945}}
```
`state.status` 后续同一 `partID` 的 `message.part.updated` 里变为 `running`、再变 `completed`（`output` 载荷随完成态到达）。

### message.updated（消息装配事实，user/assistant 双向都有）
```json
{"id":"evt_messageupdated01","type":"message.updated","properties":{"sessionID":"ses_SAMPLE","info":{"id":"msg_SAMPLE2","role":"user","sessionID":"ses_SAMPLE","time":{"created":1791658183753},"agent":"build","model":{"providerID":"openbot","modelID":"GLM-5.3"}}}}
```

### session.status —— progress 的载体
```json
{"id":"evt_sessionstatus01","type":"session.status","properties":{"sessionID":"ses_SAMPLE","status":{"type":"busy"}}}
```

### session.idle —— prompt_response 的载体（一轮的收尾）
```json
{"id":"evt_sessionidle01","type":"session.idle","properties":{"sessionID":"ses_SAMPLE"}}
```

### session.updated（会话元数据）
```json
{"id":"evt_sessionupdated01","type":"session.updated","properties":{"sessionID":"ses_SAMPLE","info":{"id":"ses_SAMPLE","slug":"shiny-otter","projectID":"global","directory":"/workspace/bots/<botId>","path":"workspace/bots/<botId>","title":"New session","agent":"build","model":{"id":"GLM-5.3","providerID":"openbot","variant":"default"},"version":"1.18.7","cost":0,"tokens":{"input":0,"output":0,"reasoning":0,"cache":{"read":0,"write":0}},"time":{"created":1791658150774}}}}
```

### session.diff（工作区差异，B4/W4 快照流的近亲）
```json
{"id":"evt_sessiondiff01","type":"session.diff","properties":{"sessionID":"ses_SAMPLE","diff":[]}}
```

### file.edited（文件被写——产物索引起点）
```json
{"id":"evt_fileedited01","type":"file.edited","properties":{"file":"/workspace/bots/<botId>/write_csv.py"}}
```

### file.watcher.updated（文件监视器增删）
```json
{"id":"evt_filewatcher01","type":"file.watcher.updated","properties":{"file":"/workspace/bots/<botId>/write_csv.py","event":"add"}}
```

### plugin.added（噪声：插件清单装载）
```json
{"id":"evt_pluginadded01","type":"plugin.added","properties":{"id":"xai"}}
```

### catalog.updated / reference.updated / integration.updated（噪声，各 1 条，空 properties 或极简）
```json
{"id":"evt_catalog01","type":"catalog.updated","properties":{}}
{"id":"evt_reference01","type":"reference.updated","properties":{}}
{"id":"evt_integration01","type":"integration.updated","properties":{}}
```

## 对下游的硬性结论

1. **答案正文在 `message.part.delta`，逐字增量**——B8 的流式翻译层直接透传 delta 拼接，无需回读消息。
2. **thought 不走 delta**：`message.part.updated{part.type:"reasoning"}` 是整段覆盖更新，翻译层按 partID 去重取最新。
3. **一轮的收尾信号是 `session.idle`**（`session.status{idle}` 伴随出现）——B3 的心跳/完成判定、B9 的 SSE 收尾、F5 的"停止等待"都可挂在它上面。
4. **`plugin.added` 占 45/309（15%）**：S2 的转发若不过滤，前端会收到大量噪声；`familyOf` 归 other，B9 翻译层应丢弃 other 族的持久化（或仅计 metrics）。
5. **`subagent` 未实测**：相关类型留 unknown 兜底，等样本。

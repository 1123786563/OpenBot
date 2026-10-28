# MOD24 计划（#644：让语音听写媒体链路复用模型费用与当前资格，第五批客户端）

状态：冻结（2026-10-27）。实施基点=派发时集成分支 HEAD（届时 MOD20/21 已并入）。载体制裁=Orca 终端会话优先。

## 0. 侦察事实（编排者已核实 @ `592512b6b`，含只读普查代理报告+三项补查）

- **VOICE=已注册 business 模块**（server/src/voice+dictation、app/src/lib/voice+dictation 四根）。server 侧 voice 6 文件 1133 行+dictation 3 文件 218 行。
- **三绕过面实测（票面核心靶）**：B1 voice/provider.ts 双上游直连（openai realtime calls :248-249、xai client_secrets :135-136 + wss :167，Bearer env key）；B2 dictation/provider.ts:23-24 openai-compatible 直连；B3 voice/summary.ts PlanModel 直构造（:42-57）+resolveApiKey 兜底 fetch（:69-103）。grep grant|entitlement|budget|reserve|settle 于 voice/+dictation/ **零命中**。
- **Bifrost 四门建成但装配零消费**：createRealtimeSessionService（realtime-session.ts:324，四类拒绝+payer 服务端解析 grant.userId）、createRealtimeUnitService、createAudioPathAdmission、realtime-usage（唯一被装配=计费面板读路径）。
- **MOD09 受管缝系 run-scoped**（计划关键定性）：`createGovernedMastraModel`（mastra/model.ts:435）要求 GovernedModelContext={scope 三元组+runId+attemptId+generation+modelRouteRef}；voice 摘要系异步会话后辅助调用**无 run 身份**——接门须定义「非 run 辅助调用」预算身份=产品设计缺口（登记，不伪造）。
- **验收②现状**：OpenBot 侧零账务=无可破坏；断流/取消事实已有钉（voice-routes.test.ts:203 槽释放、dictation abort 504、abort 不发上游）；Bifrost 门内尾部结算钉在案（realtime-tail-settlement.integration :290-394）。
- **验收③现状**：app 侧 MOD19 已覆盖（use-voice-call.ts:64-71 scope-key 变化即 session.end()；webrtc/websocket 建立请求带范围对 SCOPE_STREAM_ALLOWED_PATHS 含 /api/voice/calls）；DictationSession 代次卫兵（session.ts:51-105）；**服务端 /api/voice/calls 与 /api/audio/transcriptions 不消费范围对**（缺口登记）；SCOPE_HEADER_ALLOWED_PATHS 不含 /api/voice、/api/audio。
- **验收④边界**：供应商封闭枚举（openai-realtime/xai-realtime/openai-compatible）；gpt-4o-mini-transcribe 硬编码；Bifrost /v1/realtime HTTP 面不存在（不补做）。
- **checker**：VOICE 域 6 例外（1 条 MOD24 名下=app label.ts→voice/cut.ts，exit=VOICE 建出口+M04 改道；5 条反向 ticket=MOD04/MOD06）。基线届时以派发时为准（当前 646/环 52，MOD21 后预期 630）。

## 1. 目标形态

### A. VOICE 出口（checker 主目标）
- `app/src/lib/voice/public.ts` 新建：恰 M04 消费所需 re-export（cut.ts 导出面，实施普查冻结）；`app/src/lib/channels/label.ts` import 改道 → MOD24 例外 exit 兑现（−1）。
- 反向 5 条（MOD04/MOD06 名下 voice→stream-scope/queries 边）择形：MOD19 面已交付则改道 consequential 清除；缺能力则 defer 登记。

### B. B3 摘要链受管化择形（复认裁决）
- 复认是否存在**非 run 身份**可用的受管模型缝：存在→改道（行为变化限=预算拒绝时摘要 failed 可重试，披露）；不存在（预期，run-scoped 证据在案）→**登记设计缺口**（非 run 辅助调用预算身份未定义；B3 现状钉：PlanModel 直构造+兜底 fetch 两路径防扩散钉，新增第三条直取即红）。

### C. 验收钉套件（D）
1. D1 出口等价钉（恰符号+同绑定）
2. D2 验收①钉：免费路径身份资格现状（requireUser+归属检查+频控三件套源级钉；身份=actor.id 钉）
3. D3 验收②钉：断流/取消合同（槽释放+504+abort 不上游源级钉；OpenBot 侧零账务源扫钉 grant|reserve|settle 零命中防回流）；Bifrost 门内结算事实登记
4. D4 验收③钉：scope-key 切换即 session.end() 钉；代次卫兵钉；服务端不消费范围对=现状钉（防误认为已绑定）
5. D5 验收④钉：供应商封闭枚举钉（三处字面源扫）；/v1/realtime 网关面零命中钉
6. D6 存量族两侧对照（voice/dictation/realtime/audio 全族；MT066 缺 env 自跳过两侧同形）

### D. 登记节（报告必含）
B1/B2/B3 接门产品语义缺口（grant/payer/run-identity 三定义）；Bifrost 四门装配零消费；voice_sessions 表无 payer/grant 列；服务端范围对不消费；realtime-usage 唯一已装配面；三绕过面未来接门的最小缝建议（证据附）。

## 2. owned_files（冻结——与普查交叉核对后）

- **全权新增**：`app/src/lib/voice/public.ts`；D 套件（`server/tests/multitenancy/voice-billing-seam.test.ts`）。
- **受限**：`app/src/lib/channels/label.ts`（1 行改道）；反向 5 条择形涉及文件（改道时）；`server/src/voice/summary.ts`（B 择形改道时）；`tests/config/module-imports.json`（簿记）。
- **只读（硬边界）**：billing/**、gateway/**、mastra/**（consume only）、server/src/voice/{provider,routes,sessions,session-routes,config}.ts、dictation/**、app/src/lib/voice/** 除 public.ts、stream-scope.ts、assembly/**。事实不符→停下上报。

## 3. 验证门

checker 期望 −1（+择形 consequential 如实登记）；server tsc 0；app tsc 基线比对（存量水位法）；D 全部根入口；voice/dictation/realtime 族两侧对照；biome 我方零新增；审计两侧对照（committed manifest 零 hunk 为门）；台账 NEW 列逐件。

## 4. 验收映射

①→D2+B（接门缺口如实登记）；②→D3；③→D4；④→D5+硬边界。

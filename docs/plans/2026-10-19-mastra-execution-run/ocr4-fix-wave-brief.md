# OCR Fix Wave 4 — ME04+ME05 delivery-close round 4（findings R4-1..R4-22，ME03 三个文件）

Workspace: `/Users/wuyongjun/orca/workspaces/OpenBot/mastra-exec`（未提交树，BASE `bf64d0f2`）。OCR 报告：`docs/plans/2026-10-19-mastra-execution-run/ocr-me04-me05-r4.txt`（先读）。不 commit/push；只改 `server/src/mastra/conversation-runtime.ts`、`server/src/mastra/message-parts.ts`、`server/src/mastra/stream-events.ts`（及其测试）。

基线：绿波 13 文件 133 pass / 0 fail / 614 expects；typecheck 恰 3 基线错误；biome 干净。`openbot-test-pg`@:5433 运行中。

## 修复项（R4-11 最高优先）

1. **R4-11 [bug·HIGH]** `stream-events.ts:316-318`：tool-call-approval 分支显式 `this.suspendedByToolCalls = false`（真实审批挂起优先于早前 tool-calls 步末标记；否则 end() 误判为 ME04 循环截断发 RUN_ERROR、ME05 挂起保存被跳过）。TDD：新增测试——step1 finish(tool-calls) 后 step2 审批暂停 → outcome 为 suspended、suspendedToolCallId 正确、无 RUN_ERROR。
2. **R4-19 [bug·M]** `stream-events.ts:480-482`：`onError`（及 finish reason "error"、tool-error 分支）对齐 finish 分支的 `if (this.outcome === "aborted") return;`——abort 后的拆除期 AbortError 不得把 aborted 翻成 errored。测试：abort 后跟 error chunk → outcome 保持 aborted、terminal-less。
3. **R4-17 [bug·M]** `stream-events.ts:174-176`：text-start 查重（openTextIds.has → UnknownMastraChunkError 具名拒绝）。测试：重复 text-start → 拒绝。
4. **R4-18 [bug·M]** `stream-events.ts:231-234`：streaming 工具帧生命周期可删除集合（start 时 has 即 REJECT；streaming-end 时 delete，delete 失败即 REJECT；tool-result 以合成 messageId 查重）。测试：重发 streaming-start / streaming-end / tool-result → 拒绝或去重，不得重复发帧。
5. **R4-13 [bug·M]** `stream-events.ts:492-499`：emitRunError/emitRunFinished 前收拢未闭合生命周期（openTextIds 补 TEXT_MESSAGE_END；announced 未闭合调用补 TOOL_CALL_END）。测试：text-start→text-delta→error → 客户端收到闭合的 TEXT_MESSAGE_END + RUN_ERROR。
6. **R4-12 [bug·M]** `stream-events.ts:296-300`：TOOL_CALL_ARGS/TOOL_CALL_RESULT 的 `JSON.stringify(payload.args ?? {})` / `(payload.result ?? null)` 改用 jsonText 防护。测试：循环引用 args → 帧仍发出（fallback 文案），不抛裸 TypeError。
7. **R4-21 [bug·L]** `stream-events.ts:156-158`：unknown-chunk 诊断的 `JSON.stringify(chunk)` 改 `jsonText(chunk).slice(0, 200)`。测试：循环引用 chunk → UnknownMastraChunkError 正常抛出。
8. **R4-20 [bug·L]** `stream-events.ts:412-414`：result 的 `suspendedToolCallId` 仅在 `outcome === "suspended" && !suspendedByToolCalls` 时携带。测试：approval 后跟 error → result 无 suspendedToolCallId。
9. **R4-15 [maint·L]** jsonText 增加 fallback 参数（去"model stream error"措辞）；UnknownMastraChunkError 区分 `MASTRA_STREAM_MALFORMED_CHUNK`（已知 chunk 载荷畸形）与 `MASTRA_STREAM_UNKNOWN_CHUNK`（未知类型）——同步更新既有测试的期望前缀。
10. **R4-14 [maint·M]** `stream-events.ts` 13 处 `as unknown as BaseEvent`：按 @ag-ui/client 具体事件类型直接构造（`const start: TextMessageStartEvent = {...}`），让字段错误编译期暴露。
11. **R4-16 [maint·L]** `stream-events.ts:391-393`：end() 在 streaming 模式下同样清空缓冲（与 push 一致），或在 result 文档注明流式模式下 events 无意义——选实现更小者并在报告说明。
12. **R4-2 [bug·M]** `conversation-runtime.ts:601-603`：TOOL_CALL_RESULT 后重置宿主锚点（lastResultLanded 机制或等价）：静默工具轮的新调用经 `assistant-call-${toolCallId}` 开自己的宿主，不追加到已关闭的上一轮 assistant。测试：R1 结果后无文本直接新调用 → 持久化为新宿主消息，因果顺序正确。
13. **R4-3 [perf·L]** `conversation-runtime.ts:558-561`：callFor 改 Map 索引（TOOL_CALL_START 注册，ARGS O(1)）。
14. **R4-4 [maint·L]** `conversation-runtime.ts:430`：`UUID_STRING_LENGTH = 36` 常量 + `MAX_CLIENT_MESSAGE_KEY_LENGTH = 200` 导出（service 侧一并消费，消除两侧裸字面量）；删除模块加载期 randomUUID() 调用。
15. **R4-5 [maint·L]** `conversation-runtime.ts:649-651`：snapshot() 返回 structuredClone 拷贝（快照与后续事件结构隔离）。注意性能可接受性（消息量级小）。
16. **R4-6 [bug·M]** `message-parts.ts:329-333`：tool 结果 content 为字符串时无条件产出 tool-result part（允许空串）；数组分支拼接后同样无条件；无法识别的形状抛具名 `MASTRA_PERSIST_TOOL_CONTENT_UNSUPPORTED`（沿用本模块 Unsupported 错误风格）。测试：空串 content → part 存在（dangling call 保住）；畸形 content → 具名拒绝。
17. **R4-7 [bug·M]** `message-parts.ts:483-491`：activity 不对称——选 finding 的方案：assistant envelope 全部 parts 为 activity 时按 activity 语义重建（返回 role activity 消息，让调用方 role 过滤生效）；同步处理 `full.role === "activity"` 分支的 content 硬编码问题（activityType/payload 恢复以最小正确为准）。测试：纯 activity envelope 重建 → 被过滤器拦住，不产生空 assistant 进模型上下文。
18. **R4-9 [bug·L]** `message-parts.ts:129-130`：isError 非 undefined 且非 boolean → Corrupt 具名错误。
19. **R4-1 [maint·L]** `message-parts.ts:467-474`：提取 filePartFor(attachmentId)（含占位 mime 注释）；attachmentUrlFor 纯转发删除、直调 attachmentUrl。
20. **R4-8 [maint·L]** `message-parts.ts:423-424`：textParts 计算下沉 legacy 分支；join 一次存 const。
21. **R4-10 [doc·L]** `message-parts.ts:509-517`：storedMetadataOf 注释修正（仅 user 行保留 identity metadata；engine 输出行引擎 id 已在 message.id）。
22. **R4-22/R4-23（若报告尾部另有小项，按同标准处置）**。

## 完成标准

1. 全量绿波 13 文件 0 fail 0 skip（计数如实记录）。
2. typecheck 恰 3 基线；biome 三文件干净。
3. 报告写 `docs/plans/2026-10-19-mastra-execution-run/ocr4-fix-wave-report.md`：每项 disposition、RED→GREEN 证据（R4-11/R4-2/R4-6/R4-7/R4-17/R4-18/R4-19 必须 RED 先行）、命令与真实计数。
4. 改动最小化；ME03 冻结的 fixtures（事件样本）若因 R4-15 前缀区分需要更新，同步再生存档并记录。

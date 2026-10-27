# 方案 — #4 Opik 收尾 Run·增量 OCR 修复批（R8-FIX，2026-10-27）

## 依据

增量终审 OCR（17 触面文件 @7b48a9b72，session f04ba0e5 + resume 在跑）26 findings（0C/0H/7M/19L）经 T-J 独立核验（reviews/ocr-delta-triage-j.md）：**4 CONFIRMED / 0R / 2 DOWNGRADED / 1 DUPLICATE**。另核出协调者派发缺口：首轮 66 候选的 **#10–#13（4 条 docs/plans 面）从未被分配核验**（T-G brief 漏列）——并入本批 H 流补裁。

## 修复项与分流

### FIX-E — copilot.ts wire runId 派生链合并（T-J #2，low-medium）
owned：`server/src/copilot.ts` 及其测试（copilot-observation-decoupling.test.ts 等）
- 派生域改用服务端签发的 attempt 身份（与预算 eventId 同源的 per-subscription nonce 或 attemptId），wire runId 降为展示字段；同一 attempt 内真实重拨幂等保持（nonce 按 attempt 稳定）。
- remote/builtin 两路径 runId 卫生（typeof/trim）拉齐（:4876 vs :4738/:4748）。
- docblock :4324-4327「同 runId 重执行同链」语义同步改写（跨订阅确定性正是被威胁模型否定的部分）。
- 受影响既有断言（R4-01 同链钉）随语义更新；RED/GREEN：复用 runId 的两个独立 run 不再共享 trace 树。

### FIX-F — tool-steps id-link 三态判定（T-J #7，medium）
owned：`server/src/ai-observability/tool-steps.ts`、`server/tests/opik-trace-chain.test.ts`（及 opik-tool-steps.test.ts 如需）
- :674 横杆从 `span.opik` 改「显式覆盖或派生一致」三态：writeSpans ok 后 span.opik 缺席时，`binding.opikTraceId !== null && runUpstreamIdentity(span.traceId).opikTraceId === binding.opikTraceId` 成立则以 `spanUpstreamId(span.traceId, span.spanId)` 落链接（镜像端口完成路径 ef88717ac 同一派生规则）。
- opik-trace-chain.test.ts:389-397「无覆盖→无链接」钉随新语义更新为「无覆盖但派生一致→链接；不一致→拒绝」。

### FIX-G — ingest 重提恢复语义（T-J #4，medium；联动 T-J #3 已降级项）
owned：`server/scripts/opik-e2e-ingest.ts`、`server/scripts/opik-e2e-ingest-gate-check.ts`
- 择形 (b)：按轮差值判定——每轮开始前快照 stats，writesEstablished 按**最后一轮增量**（本轮无新增 refused/failed 且本轮完成写入达标）判定；:187-190 注释与 :371-377 对齐（重提恢复真实可达，判定反映末轮净态）。
- gate-check.ts:36-48 两用例同步改写为按轮增量形状（瞬时 refusal → 恢复后 PASS；末轮仍失败 → FAIL）；与 (a) 注释对齐方案二选一，worker 择一并保证两者同波一致。
- 集成后主控复跑真实栈（ingest-rerun-r8）。

### FIX-H — 文档账差 + 4 条漏裁候选（T-J #1 medium + 派发缺口）
owned：`docs/plans/opik/2026-10-27-opik-issue4-ocr-final-fix-wave.md`（账差行；曾误写 r2-fix-wave.md，H 流交付披露更正）；另有权裁决 #10–#13
- 行 5 分流账从三份 triage JSON 重算（6R/28D/10dup/6moot），并使 12+6+28+10+6+4(补裁)=66 闭合。
- **补裁 #10–#13**（final-hm-candidates.md 的 4 条 docs/plans 面 medium：r2-fix-wave.md:9-11、ocrfix-r5-plan.md:24、r2-fix-wave.md:4、ocrfix-r5-plan.md:13）：逐条独立裁决 CONFIRMED/DOWNGRADED/REFUTED，证据进报告；若 CONFIRMED 非文档可即改项，上报主控另立。
- 注意 #16（ocrfix-r5-plan.md:24 HIGH）T-G 已裁 DOWNGRADED——#11 若同址则 DUPLICATE。

## 执行序与门禁

1. E/F/G 三流并行（owned 零交集）+ H 独立（文档）；每流 RED/GREEN 复现 + focused fresh-DB 复跑 + tsc 基线差=0。
2. 每流独立审核 r1 → 串行集成 → 组合复验（对照 1288 基线对账）。
3. G 集成后真实栈复跑（ingest-rerun-r8）。
4. 终轮微增量 OCR：E/F/G 改动文件 @最终 HEAD（H 文档面免 OCR，其验证=审核）。新 H/M 同纪律 triage。
5. FREV R8（12+4 项总闭环终审）→ 合本地 main → 清理 → 终稿。

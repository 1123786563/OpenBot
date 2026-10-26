# F09 修复波方案（R9-C6 终裁派生）

依据：`/Users/wuyongjun/trea/OpenBot/.archive/runs/2026-10-23-issue489-orchestration/ocr/r9-adjudication.md`（2026-10-24 R9 终裁：F9-8 有效 bug·medium、F9-9 有效 bug·low 并包；其余 9 条 low/降级项记 transfers 延期，不入本波）。

## T17：密码验证码计数门语义修复 + 孤儿条目竞态（F9-8+F9-9）

**位置**：`server/src/passwords/service.ts`（enterCode 计数门 :473 一带；`resolved` 计数删除 :276 一带）+ 对应测试文件（passwords 套件族）。

**修复语义（设计裁决）**：

1. 计数门由 `if (result !== undefined)` 改为仅计「站点页面实际收到过完整提交」的尝试——即 `result.submitted === true`（OCR 建议形 `result?.submitted`）。理由：上限是防猜测界；猜测只有经一次**完成的提交**才送达站点校验。fillSignInCode 三种 `{submitted:false}` 形态（浏览器不在 origin、无验证码框、typing/submit 抛错）一律不计——前两种站点零接触，第三种无完成提交、部分键入不构成一次猜测。紧邻注释的论证句（「the site's page saw the code and turned it away」）同步改写为准确描述新门（只计 submitted；transport 未达仍不计，uncertain 路径不变）。
2. F9-9：在封顶关闭 `transition` 返回 `closed === null`（请求已终态）分支、及重开 `reopened === null` 分支，同步 `wrongCodes.delete(id)`——终态请求的计数随终态消亡，杜绝慢到拒绝写回孤儿条目。
3. 不得改动：uncertain/landUnknown 路径、submitted:true 各失败文案与 back 语义、MAX_CODE_ATTEMPTS 数值、audit 行形状。

**RED→GREEN**：

- RED A：连续 5 次「不在 origin」错误回答 → 请求**不**以 TOO_MANY_CODE_ATTEMPTS 强关（现树会关——RED 恰失败于此断言）。
- RED B：连续 5 次「无验证码框」错误回答 → 同上。
- 钉死新语义：typing 抛错 ×5 不封顶；submitted:true 拒绝计数到 5 仍封顶（既有用例族不得回退）。
- 竞态钉死：尝试在请求终态后落地确定拒绝，不再遗留 wrongCodes 孤儿条目（暴露方式由实施自选，审核裁决充分性）。

**门（全部 GREEN 方为交付）**：passwords 套件全绿（基线含 F04 后既有数）；`E2E_UNIT_SCOPE=server bunx e2e run --config e2e.unit.config.ts enterprise-controls` 96/96；otel wire `bun test server/tests/otel-export-scrubbing.test.ts` 4/4；`cd server && bunx tsc --noEmit` 恰 3 条 BASE；biome owned 净。

**owned_files**：service.ts + passwords 测试文件，恰两 M，无其他。

**检查点**：`/Users/wuyongjun/trea/OpenBot/.archive/runs/2026-10-23-issue489-orchestration/checkpoints/t17-after-all.diff`、`t17-increment.diff`（`# T17` 头行+after-all 正文）、`t17-status-after.txt`、逐文件 sha256。实施前 brief 全绝对路径+禁提问。

## 流程

实施（Claude）→ 检查点冻结 → 独立审核 R1（Claude 双轴）→ 集成（剥头 apply+字节核验+门）→ 收官门复跑 → Codex 完整终审（f01-r9）→ OCR R10 全量（scrub.ts 必达，缺则 resume 重试）→ R10 终裁（收敛判据：净增 0 有效 medium）→ V03 → C01。

# F11 修复波方案（R11 终裁 v2 派生）

依据：`/Users/wuyongjun/trea/OpenBot/.archive/runs/2026-10-23-issue489-orchestration/ocr/r11-adjudication.md` 附「R11 终裁 v2」（F11-1 bug·high 有效；F11-2..7 low 延期 transfers）。原生报告：`…/ocr/r11-chunkC-resume.md`（tools.ts:127 段）。

## T21：直连 OpenAI 形态下点分工具名的挂载期拒绝（F11-1 最小兜底）

**缺陷事实（已核验）**：`VALID_TOOL_NAME` 放行点号；四处 enforcement 位点（mastra/tools.ts:228/:424、frontend-tools.ts:81、plugins/store.ts:5211）同步放行；挂载名经 `mastra/execution.ts:314` 随带工具请求序列化；未配置 `OPENAI_BASE_URL` 时 `routing/model.ts:99-107` 与 `index.ts:7154-7161` 的中性默认即直连 `https://api.openai.com`——OpenAI 服务端函数名字符集 `^[a-zA-Z0-9_-]{1,64}$` 拒收点分名 ⇒ **整单 400**（非单工具失败）。全仓无别名/清洗层。

**修复（设计裁决=原生建议的最小兜底，非别名层）**：

在挂载→wire 边界（即同时可得「生效 base URL」与「挂载工具名」的 seam，预计 `mastra/execution.ts` 请求组装处或 `mastra/tools.ts` 挂载处；实施按代码事实落位并申报）加最小兜底：**生效 base URL 指向直连 `api.openai.com`（含 `/v1` 变体）且工具名含点号 ⇒ 拒绝该工具挂载**，以既有 refusal/错误机制抛出可操作提示（如 `MASTRA_TOOL_NAME_INVALID: <name> cannot be mounted on a direct-OpenAI provider (its function-name charset admits no dot)`）。网关/自定义 base（名称会被网关洗写）与其他 provider 不受影响；不实现别名映射（provider 感知别名层留 transfers 设计项）。

**RED→GREEN**：新用例 ≥3——①直连 base+点分名 → 拒绝（现树会挂载=RED，失败文本即 400 风险的行为面）；②网关 base+点分名 → 正常挂载；③直连 base+合法名 → 正常挂载。既有套件零回退。

**门**：受影响套件（mastra/plugins 相关测试文件全绿）+ `E2E_UNIT_SCOPE=server bunx e2e run --config e2e.unit.config.ts enterprise-controls` 108/108 + otel 4/4 + `cd server && bunx tsc --noEmit` 恰 3 条 BASE + biome owned 净。

**owned_files**：实施 seam 所在源文件 + 对应测试文件（恰两 M；若 seam 跨两文件须申报）。

## 流程

实施（Claude）→ 检查点（t21-* 四件套，全绝对路径）→ 编排者字节核验 → R1（Claude 双轴）→ 集成（剥头 apply+字节核验+门）→ F11 收官门（八门复跑）→ Codex f01-r11（第七轮完整终审，F11-1 闭合专项）→ OCR R12 全量 → R12 终裁（净增 0 有效 high/medium 即收敛）→ V03/C01 重新收口。

# F07：Codex 终审 F01-R6-M1 修复（T13）

来源：Codex F01-R6 集成终审 FAIL——finding **F01-R6-M1（medium，阻断）**（报告 `/Users/wuyongjun/trea/OpenBot/.archive/runs/2026-10-23-issue489-orchestration/reviews/f01-r6-codex-report.md`）：MCP 工具返回约 20 KB 合法深层 JSON（`"[".repeat(10000)+"0"+"]".repeat(10000)`）时，V8 `JSON.parse` 成功但 `forDisplay` 尾部 `JSON.stringify(parsed, null, 2)` 抛 `RangeError: Maximum call stack size exceeded`；`tool-activity.tsx:481` 的 `forDisplay(step.output)` 在 `StepRow` render 期、`ToolRenderBoundary` 挂载前求值，错误越过边界可卸载折叠组与 transcript。A07/A11 因此 FAIL。

## 修复形状裁决

Codex 给出两形状：(a) 把预处理移入 Boundary 真子组件；(b) 对预处理做有界兜底。**取**：在 `app/src/lib/plugins/tool-result.ts` 的 `forDisplay` 内对两处 `JSON.stringify`（:107 `rest` 分支、:120 尾部）加统一 fence 兜底——stringify 抛错（V8 深度递归上限）时回落为原文 `trimmed` 的 json 围栏（有界、如实、长度即服务端所发）。理由：forDisplay 是画非信内容的共享缝（工具结果绘制唯一入口），缝级兜底覆盖全部调用方（tool-activity StepRow 暴露面 + chat-transcript ServerToolLine 未来位），T12b 边界保留为纵深防御而非唯一防线；调用侧再移组件属重复演示且遗留其他裸调用面。不新增用户可见文案。

## owned_files

- `app/src/lib/plugins/tool-result.ts`
- `app/tests/tool-result.test.ts`
- `app/tests/tool-activity.test.tsx`

互斥：不改 `tool-activity.tsx`/`chat-transcript.tsx`/`tool-boundary.tsx` 及其他文件。

## T13 步骤

1. RED（裸基线 + 仅测试增量）：`tool-result.test.ts` 两例——数组深嵌套（10000 层）与对象 markdown 字段 + 深嵌套 `rest`，均断言不抛、返回含原文围栏；`tool-activity.test.tsx` 一例——折叠组步骤 output=深层 JSON 字符串，断言渲染不崩、邻步存活（沿 T12b :433-465 注入式断言风格）。预期 3 failed（前两例 throw RangeError、行为例整树渲染崩）。
2. 修复：forDisplay 内两 stringify 位经统一 `fence` 帮助函数；catch 分支回落 `\`\`\`json\n${trimmed}\n\`\`\``；注释仅述 V8 递归上限与回落语义。既有行为零改动（浅层数据路径逐字节不变）。
3. GREEN + 门：
   - `bun test ./app/tests/tool-result.test.ts ./app/tests/tool-activity.test.tsx` 全绿（tool-activity 28/28 不回退 + 新例）；
   - app tsc：裸基线先、工作树后，62 条 BASE 逐字节一致（沿用 int-t12b 口径）；
   - biome owned 文件净（`bunx biome check` 直取退出码）。
4. 检查点（主归档绝对路径 `/Users/wuyongjun/trea/OpenBot/.archive/runs/2026-10-23-issue489-orchestration/checkpoints/`）：`t13-after-all.diff`/`t13-increment.diff`（increment=after-all+`# T13` 头注释行）/`t13-status-after.txt`/逐文件 SHA-256；报告 `reports/t13-claude-report.md`（RED 证据、GREEN 数字、门退出码、遗留申报）。

## 审核与集成

Claude 独立实例 R1（双轴，冻结检查点字节核验+四门独立复跑）→ 串行集成集成分支（剥头 apply+现树 diff≡after-all 字节核验+组合树门）→ 释放工作树。集成后：Codex 完整终审重派（4f88d9b310..新 HEAD；brief 全绝对路径、禁提问规则）+ OCR R8（A/B 同范围复扫 + C5=4f88d9b310..新 HEAD 全量）。

## 附录（2026-10-24 引擎阈值实测，编排者）

「10000 层」为 Codex 在 node/V8 的复现参数；bun test 跑在 JSC，实测 10k 层不抛（30000 ok / 60000 抛；V8 5000 ok / 8000 抛——生产面 Chrome/Edge 浏览器 8000 层即崩，低于 Codex 例）。**T13 三测试例统一用 100000 层**（~200KB 合法载荷，双引擎均抛，bun 下 RED 真实成立）；行为例 GREEN 断言不变（不崩+邻步存活）。已以 msg_95a2c20ec9a0 同步实施 worker。

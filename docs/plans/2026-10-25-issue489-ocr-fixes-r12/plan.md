# F12 修复波方案（f01-r11 终审派生）

依据：`/Users/wuyongjun/trea/OpenBot/.archive/runs/2026-10-23-issue489-orchestration/reviews/f01-r11-codex-report.md`（F01-R11-M1 bug·medium 阻断）；编排者 bun -e 复现记录：ledger 2026-10-25 07:0x 条。

## T22：直连判定改用与真实拨号同一的 URL 规范化（F01-R11-M1）

**缺陷事实（已复现）**：`OPENAI_BASE_URL=https://api.openai.com:443/v1` 时 `chatCompletionsUrl` 产物含 `:443`；T21 守卫按该字符串（大小写折叠）比对直连常量 ⇒ false；而真实 fetch 的 URL 规范化（`new Request(url).url`）剥 HTTPS 默认端口 ⇒ 实际拨 `https://api.openai.com/v1/chat/completions`——F11-1 的点分名整单 400 在同源端点上重现。

**修复（设计裁决）**：`gateway.ts` 守卫的直连判定改用**与真实拨号相同的规范化原语**——`new Request(chatUrl).url`（与下游 fetch 同一 URL 规范化；resolver 产物必为合法 URL，构造安全）后小写折叠再与直连常量比对；不再裸比对 resolver 字符串。语义不变：直连（含 `:443` 显式默认端口形）⇒ 拒；网关/自定义 base（含显式非 443 端口，如 `https://gateway.example:8443/v1/…`）⇒ 透传不受影响；不得把任何自定义网关判作直连。

**RED→GREEN**：新用例 ≥2——①`https://api.openai.com:443/v1` + 点分名 → 拒绝（现树挂上=RED）；②网关显式端口形（如 `:8443`）+ 点分名 → 透传不受影响。既有 T21 三组用例（未设默认/显式 /v1/尾斜杠/host 大小写、网关、直连合法名）零回退。

**门**：seam 套件（e2e runner）全绿；adapter 29/29（bun）；enterprise-controls 108/108；otel 4/4；server tsc 恰 3 BASE；biome owned 净。

**owned_files**：`server/src/enterprise/models/gateway.ts` + `server/tests/enterprise/model-gateway.test.ts`（恰两 M；预计不再触碰 adapter）。

## 流程

实施（Claude）→ 检查点（t22-* 四件套）→ 编排者字节核验 → R1（Claude 双轴）→ 集成（剥头 apply+字节核验+门）→ F12 收官门（十门复跑）→ **R12 全量 OCR（唯一一次，仅在 T22 集成后的最终 HEAD 上）** → R12 终裁 → f01-r12 Codex 终审（M1 闭合专项）→ 重新 V03/C01 收口。OCR 顺序调整（先 OCR 后 Codex）系利用 Codex 已在 4e57d0a4af 上完成七轮终审的事实——终审仅在最终 HEAD 重做一次。

## 附录：T23/T24（R12 终裁追加，2026-10-25）

R12 全量（r12-adjudication.md）：F12-1 scrub high 经双引擎 10 形状实测**无效**（≤1.3ms 有界）；有效项两 medium——

**T23（F12-2）**：`agent-computer/src/sign-in.ts` fillSignInCode 返回前补与 fillSignIn（T19）对称的跨源守卫：`backToLogin && originOfUrl(page.url()) !== input.origin` ⇒ `answer("The sign-in moved to X. Take over the browser to finish signing in there.", true)`（`{submitted:true, codeFieldVisible:false, passwordFieldVisible:false}`）；同 origin 语义、2s 宽限、既有 30 用例零回退；新真实浏览器用例（提交验证码后跨源+仅密码框→take over 文案/字段全 false）。门：sign-in 30→31（真调度路径）、AC tsc 0、biome、enterprise 108/108 维持。owned=sign-in.ts+sign-in.test.ts。

**T24（F12-3，doc-only）**：`server/src/mastra/tools.ts:116-121` 注释段同步已落地的 F11-1/T22 拨号期守卫（MASTRA_TOOL_NAME_INVALID，直连判定经 URL 规范化）——改写为描述现状+指向守卫位置；不改任何代码行。门：tsc 恰 3 BASE、biome、相关注释处 diff 仅注释。owned=tools.ts。

流程：两任务并行→R1→串行集成→F13 收官门（十二门）→R13 全量（新最终 HEAD 唯一一次）→f01-r12→V03/C01。

## 附录二：F14 波 T25/T26（R13 终裁追加，2026-10-25）

R13（r13-adjudication.md）3 有效 medium：

**T25（F13-2）**：`app/src/components/channels/tool-activity.tsx` 提取 `StepOutput` 子组件——`forDisplay` 移入边界内子组件的 render 期求值（`<ToolRenderBoundary><StepOutput output label/></ToolRenderBoundary>` 结构按 finding 建议形落位），解码期抛错落进边界；与单工具路径真同构；渲染产物零变化（DOM 结构不变）；注释同步兑现「never the whole conversation」。新增用例：解码期抛错（如 markdownComponents.a throw 注入，沿 T13 测试先例）折叠组存活。门：tool-activity 套件全绿（bun，31+新）、app tsc 62 BASE 不增、biome、enterprise 108/108 维持。owned=tool-activity.tsx+其测试。

**T26（F13-1+F13-3，server 双项）**：①`gateway.ts` 守卫覆盖 anthropic 直连——anthropic 臂经 `anthropicMessagesUrl` 同一 resolver 产物 + `new Request(url).url` 规范化比对直连 `https://api.anthropic.com/v1/messages` 常量，命中且点分工具名 ⇒ 400 `MASTRA_TOOL_NAME_INVALID`（同词表同文案族，provider 名适配）；`if (anthropic || !tools) return undefined` 拆为按 provider 分流；tools.ts:110-113 注释补记 anthropic 边缘裁决。②`server/src/computer/schema.ts` SignInCodeResult.url 改可选+注释（与 SignInFillResult 同契约）。测试：anthropic 直连+点分→拒绝、anthropic 网关→透传、openai 原三组零回退。门：seam 套件 49+新 全绿、adapter 29/29、enterprise 108/108、tsc 恰 3 BASE、biome。owned=gateway.ts+model-gateway.test.ts+schema.ts+tools.ts（注释行）。

流程：并行→R1→串行集成→F14 收官门→R14 全量（新最终 HEAD 唯一一次）→f01-r12→V03/C01。

## 附录三：F15 波 T27/T28（R14 终裁追加，2026-10-25）

**T27（F14-1）**：scrub.ts 五规则引号/裸值臂提取共享常量（QUOTE_ARMS/BARE_VALUE 模板插值，沿 SECRET_NAME 的 new RegExp 先例）——**行为零变化重构**：regex 源串插值前后逐条 regex.toString 比对全等；全族零回归（enterprise 108/108、otel 4/4、T9/T14/R2/T18/T20 各对抗族抽验、ReDoS 计时门双引擎）。owned=scrub.ts+enterprise-controls.test.ts（如需补插值等价用例）。

**T28（F14-2）**：fillSignInCode 跨源第二码步——markCodeField 读取与 origin 分离，跨源仍见码框 ⇒ 接管答复（"…to ask for another verification code. Take over…"）；上报 codeFieldVisible origin 收窄；同源语义/2s 宽限/T19/T23 守卫零触碰。新真实浏览器用例（提交码后跨源+仍见码框→接管）。owned=sign-in.ts+sign-in.test.ts。

流程：并行→R1→串行集成→F15 收官门→R15 全量→f01-r12→V03/C01。

## 附录四：F16 波 T29/T30（R15 终裁追加，2026-10-25）

**T29（F15-1+F15-2，app 双项）**：①`tool-activity.tsx` askVerdicts 缓存上限——`ASK_VERDICTS_CACHEABLE_MAX=16_384`，`asksThePerson` 内超长结果计算后直接返回不入缓存（逐帧重算=改动前行为；预筛/T15 语义不变），新用例（超长 Refused. 前缀串两帧计算、Map.size 不增）。②`chat-transcript.tsx` ServerToolLine 改 `refusalBody(result)`（answer 保留供非拒绝 body 与 connectPromptOf；`markerRefusalBody` 别名与 import 清理），等价性钉子用例。owned=tool-activity.tsx+chat-transcript.tsx+两测试（恰 4 M）。门：tool-activity 32+新、app tsc 62 BASE、biome、enterprise 108/108。

**T30（F15-3，test-only）**：新增 `server/tests/scrub-command.test.ts`（或并入既有套件，按 runner 归属）常驻钉住 scrub 对抗边界：ReDoS 探针（`""`×30、`-fa`×30、粗粒度 <2s 断言+输出恒等）、`-p;whoami` 保留 whoami、未闭合引号不吞第二行、`pa\;ss` 整词、o'brien 回退、成对引号段整词、`fixture-pass-` 整词、SSHPASS 首元素放行 `-`。owned=该测试文件（恰 1 M 新增或含 scrub.ts 零改动）。门：新套件全绿、enterprise 108/108、otel 4/4、tsc 3 BASE、biome。

流程：并行→R1→串行集成→F16 收官门→R16 全量→f01-r12→V03/C01。

## 附录五：F17 波 T31/T32（R16 终裁追加，2026-10-25）

**T31（F16-1 部分接受，doc-only）**：scrub.ts QUOTE_ARMS 注释段改写为真话：删除不成立的 shell 论断（"a quote that spans lines is a quote the shell itself would not keep to one command"），如实记录残留窗口（闭合于后续行的引号密钥只脱敏到行界、余段留存；跨行配对与 F10-2 反吞并存在无解张力、该取舍为有意选择；PEM/令牌有 TOKEN_SHAPES 兜底）。零代码行改动。owned=scrub.ts（注释）。

**T32（F16-2）**：`mastra/tools.ts` 新增 `VALID_BRIDGE_TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/`；`frontend-tools.ts` 客户端声明名改用严格集（挂载即丢弃+结构化诊断=改动前 fail-soft 行为；brokered/granted 维持 VALID_TOOL_NAME 点号放行+F11-1 守卫）；注释记录两 charset 的分工。测试：客户端带点名声明→丢弃+诊断+聊天继续（RED：现树挂载/直连形态守卫 400 形）；合法名声明挂载不变；brokered 点分名行为不变（seam 51/51 零回退）。owned=tools.ts+frontend-tools.ts+相关测试。

流程：并行→R1→串行集成→F17 收官门→R17 全量→f01-r12→V03/C01。

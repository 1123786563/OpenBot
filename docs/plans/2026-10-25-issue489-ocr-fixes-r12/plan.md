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

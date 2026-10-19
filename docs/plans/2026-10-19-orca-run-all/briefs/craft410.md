[craft410] Issue #410 [Craft Preview][P0] 主站 cookie 认证写接口拒绝 preview Origin
Target: /api/craft/** 的 cookie 认证非安全方法（POST/PUT/PATCH/DELETE）Origin 校验。
⚠️ 先核验再实施：main 已有提交 82676669「craft 写接口拒绝非受信 Origin，收口 #410 的服务端纵深」与测试 server/tests/craft-preview-origin-guard.test.ts。先读现状（server/src/app.ts、craft 路由装配、craft-preview-origin.ts），逐条 AC 实证；AC 全满足 → 零改动收尾；有缺口只补缺口。
AC：
1. 带 preview Origin 的 credentialed POST → 403
2. 主站自身 Origin → 原行为
3. 无 Origin 的 internal/native 调用 → 原行为
4. 不误伤现有测试与 Server Actions 自身请求
5. 测试覆盖 Origin 缺失/伪造/子域形状
Ownership: 仅 server/src/app.ts 或 craft 路由装配处、server/tests/craft-preview-origin-guard.test.ts；拒绝日志不得含 cookie/ticket。
Observable: bun test ./server/tests/craft-preview-origin-guard.test.ts 全绿（在仓库根跑）。

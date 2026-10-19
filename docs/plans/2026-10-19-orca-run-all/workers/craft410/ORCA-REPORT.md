# ORCA-REPORT — craft410：Issue #410 主站 cookie 认证写接口拒绝 preview Origin

## 结论

**AC 全满足，零改动收尾。** main 已有提交 82676669（`feat: craft 写接口拒绝非受信 Origin，收口 #410 的服务端纵深`）已包含在本分支，实现、装配、测试三层齐备且全绿。Observable `bun test ./server/tests/craft-preview-origin-guard.test.ts` → **26 pass / 0 fail**。

## 现状核验（先读再判）

- `server/src/craft/write-origin-guard.ts` — 门本体：仅非安全方法（POST/PUT/PATCH/DELETE）；无 Origin 放行（CLI/native/内部）；preview 命名空间先判（即便混进受信列表也拒）；其余只放 Host 同源 + `trustedBrowserOrigins`（CORS 同一份列表）；经 `normalizedOriginOf` 归一化（尾点/默认端口不可走私）。响应为一句话、不回显 Origin/Cookie；日志只含 method/path/normalized origin/verdict，无 cookie/ticket。
- `server/src/craft/routes.ts:322` — 装配在两个 sandbox relay（session-tag 认证、不发 Origin）之后、`requireUser` 之前。
- `server/src/index.ts:5541-5543` — `previewOriginClaimsOrigin: craftPreviewOrigin.claimsOrigin`、`previewWriteTrustedOrigins: trustedBrowserOrigins(config)`。
- `server/src/craft/preview-origin.ts` — `claimsOrigin` 是 `claimsPreviewHost` 的 Origin 头一侧（一个认领、两个表面）；dev 形态（label 在 path 上）诚实返回 false，已知缺口记录在案。

## 逐条 AC 实证

| AC | 判定 | 证据 |
|----|------|------|
| 1. preview Origin 的 credentialed POST → 403 | ✅ | `craft-preview-origin-guard.test.ts:126`（带 cookie、403、可展示原因）+ `:403`（装配级：在 requireUser 之前 403 而非 401）；四个非安全方法一律 403（`:133`） |
| 2. 主站自身 Origin → 原行为 | ✅ | `:197`（受信列表 200）、`:202`（Host 同源 200，安装/dev 直连形态）、`:412`（装配级：受信 Origin 仍走原 401 判定） |
| 3. 无 Origin internal/native → 原行为 | ✅ | `:212`（无 Origin 200）、`:420`（装配级：无 Origin 仍走原 401）；sandbox 的 MCP relay 在门之上层（`:428`） |
| 4. 不误伤现有测试与 Server Actions | ✅ | 见下"测试运行"；Server Actions POST 自身页面路由、不经 `/api/craft` 子树；经 app 转发的 `/api` 调用是 Host 同源，有 `:202` 覆盖 |
| 5. 覆盖 Origin 缺失/伪造/子域形状 | ✅ | 缺失 `:212`；伪造 `:171`（`null`、垃圾串、`javascript:`、带 path → 403 不抛）+ `:156`（前缀/后缀/跨域伪装 403）；子域 `:141`（任意深度 + 基座 + http 拼写全 403）+ `:341-376`（claimsOrigin 四形状，含 localhost 形态端口纪律与 dev 形态不认领） |

Ownership 约束（日志不含 cookie/ticket）：`craft-preview-origin-guard.test.ts:233` 断言响应体与日志均不含 cookie 值、ticket 值、也不回显 Origin 本体；实测日志样例 `{"method":"POST","path":"/sessions","origin":"https://abc.preview.example.com","verdict":"preview"}` 无凭证。

## 命令与输出摘要

```
$ bun test ./server/tests/craft-preview-origin-guard.test.ts
 26 pass / 0 fail / 71 expect() calls        ← Observable，全绿

$ bun test <craft 路由相关 12 文件>
 41 pass / 9 fail                            ← 9 fail 全部为同一错误
$ bun run e2e run --config e2e.unit.config.ts <那 9 个文件>
 Test Files 9 passed (9) / Tests 275 passed (275)   ← 正确运行器下全绿
```

9 个 bun 层失败均为 `SyntaxError: Export named 'registerHooks' not found in module 'node:module'`：这些文件 import `tests/support/e2e-compat.ts`，属 ADR 0008 两层制的 **Node/e2e 层**套件，`bun test` 运行器下必然加载失败——是错误运行器的环境噪音，与门无关（在正确的 `e2e run` 下 275/275 全绿即为证）。

## 改动文件

无（零改动）。

```
$ git status --short
（clean）
```

## 遗留

- 无本任务范围遗留。已知记录在案的 dev 形态缺口（空模板时 preview 与主站同 Origin，无法判定，`claimsOrigin` 返回 false）是 write-origin-guard.ts 模块注释与测试 `:358` 明示的诚实限制，非本次缺口。
- 基础设施提醒（非本任务）：CI/本地若有人用 `bun test` 直跑 e2e-compat 系套件会得到假失败，按两层制用 `bun run test`（`e2e run --config e2e.unit.config.ts`）跑。

# orca-dag-wave2-craft — Craft 域批次票 #437 / #433 / #408 处理报告

- 基点：worktree `craft2` @ `bf64d0f2`（父提交 `c80927fa`，即任务声明基线）
- 日期：2026-10-19 ｜ GitHub 只读、未 commit、未 push
- 测试按 ADR 0008 两层制执行，命令一律自仓库根解析

## 逐票结论

| 票 | 结论 | 改动 |
|---|---|---|
| #437 | **SATISFIED**（根因链 main 已修 + 本次补齐 repair 入口与文案；真机浏览器复验为环境受限项，见下） | manager.ts / webapp-proxy.ts / craft-skills-reload.test.ts / docs |
| #433 | **SATISFIED（契约层）**（AC1/AC2/AC3 本次实现+钉死；AC4/AC5 结果由双侧措辞钉死，真容器镜像复验留待镜像重建流程） | agent-sandbox/src/proxy.ts / proxy.test.ts |
| #408 | **SATISFIED**（生产空模板显式关闭 + 测试 + 文档） | preview-origin.ts / craft-preview-origin.test.ts / .env.example / docs×2 |

---

## #437 — 新会话 start 脚本未注入 /<label> mount（P0，AC2/AC5）

### main 已含的等价实现（核验，零改动部分）
- 根因链已在 main 修复：`readWebappGeneration`（server/src/craft/webapp-generation.ts）把
  「200 空内容」读折叠为 absent ⇒ current（fix-ocr17），读抛错 ⇒ unknown（fix-ocr26 #8）；
  新会话首次写脚本即带 mount。测试钉死：server/tests/craft-webapp-generation.test.ts:142/323
  （空内容⇒current）、:213/224/259（flake⇒unknown）。
- webapp-info 的 `.webapp-mount` 交叉校验、地址抑制（fix-ocr27 #3 / fix-ocr4 #8）已在 main。
- 附带发现（抑制态下 preview-ticket 仍出票）：已被 main 的 mint 镜像读（fix-ocr28 #4）解决——
  记录不符时 mint 拒绝（craft-webapp-proxy.test.ts:2320 家族）。

### 本次补齐（main 无等价实现）
1. **可达修复动作**（AC「skills/reload 强制重写」）：`CraftSessionManager.webappScriptStale`
   （server/src/craft/manager.ts）——磁盘上已写出的 start-webapp.sh 与当前派生
   （门控 basePath + 保留端口）字节不等时，reload 不再被 `skills_stale:false` 短路，
   走 regenerate 尾部重写脚本。fail-open 按 KIND：无端口/无派生/无 fileApi/读抛错/脚本未写
   均答 false（webapp-info 交叉校验仍是兜底）。
2. **文案改正**：`WEBAPP_MOUNT_STALE_REASON`（server/src/craft/webapp-proxy.ts:119 一带）不再
   声称 "started by an older start script"（对本成因是事实错误），改为命名真实成因并指向
   skills/reload 重写动作。既有断言 `toContain("start script")` 兼容。
3. **降级路径测试**：server/tests/craft-skills-reload.test.ts 新增 3 例——失配脚本在 up-to-date
   会话上被强制重写并带 `ONYX_WEBAPP_BASE_PATH`/`NEXT_PUBLIC_BASE_PATH`；匹配脚本保持 no-op
   （opencode.json 不落盘）；无保留端口不越界触发。
4. docs/craft-preview-origin.md 两处 staleness-gated 段落更新为含 #437 修复臂的契约。

### 验证
- `E2E_UNIT_OUTPUT=.e2e-tmp/server2 bunx e2e run --config e2e.unit.config.ts server/tests/craft-skills-reload.test.ts server/tests/craft-preview-origin.test.ts server/tests/craft-webapp-proxy.test.ts server/tests/craft-webapp-generation.test.ts` → **exit 0，4 文件 251 用例全过**（含新增 3 例）。
- 加跑 `server/tests/craft-routes-assembly.test.ts server/tests/craft-session-provisioning.test.ts` 同轮通过（6 server 文件 0 失败）。

### 证据受限项（如实声明）
- 真机浏览器 AC2/AC5（POST/PUT/PATCH/DELETE 经预览、HMR）未在本 dispatch 复跑：需要
  Casdoor 登录 + 沙箱容器 + 前端栈。代码链路由上述测试覆盖；票面已将真机验收复跑挂给
  #431 T3。`app/tests/craft-preview-tab.test.tsx` 单跑 66 失败为已知进程偶合
  （记忆 reference_app_ui_solo_vs_scope：独跑红、整组绿），且静态证明本 diff 无 app//tests/
  可达路径；整组取证被 main 既有的 `app/tests/channel-order.test.ts` COLLECTION_ERROR
  （`@/lib` 别名解析，文件自 0f454dae 未动）阻断。

## #433 — sandbox 上游 /file/content 丢失 absent→404 契约（P0）

### 判定：契约层缺失，本次实现
main 侧已有防御折叠（webapp-generation.ts 把空内容读折为 absent），但票面首选方向
（代理自己回答 absence）在 main 上不存在：`/file/content` 无 stat 前置，`GET /file`
存在文件仍转发上游（上游对文件路径答 500）。

### 实现（agent-sandbox/src/proxy.ts）
- **AC1**：`GET /file/content` 转发前 stat；absent → 404；存在 → 转发上游（信封/字节直通
  不变）；无 path 参数 → 保持转发（上游自身对畸形输入的应答，响应上限测试依赖该形状）。
- **AC2**：`GET /file` 存在的常规文件由代理读盘应答 200 原始字节（content-type
  application/octet-stream）；目录继续转发（列表形状保持）；absent → 404（既有）。
- **AC6**：server/src/craft/sandbox-gateway.ts readFile 契约未动（404⇒null、非 200⇒throw）。
- 版本 pin 未动（version.ts 1.18.7）；镜像漂移根因排查不在本次（代理侧修复使上游行为不再
  进契约路径）。

### 测试（agent-sandbox/tests/proxy.test.ts，AC3）
新增 3 例，四类形状钉死且不依赖上游 404 行为（假上游忠实复现回归：任意 /file/content
转发答 300KB）：
- absent → 404；`..` 逃逸与绝对路径 → 400；存在文件 → 转发（本 harness 表现为 413 响应
  上限，证明请求离开代理去了上游而非本分支 404）。
- `GET /file` 存在文件 → 200 + 精确字节内容（"a,b\n1,2\n"）。
- `GET /file` 目录 → 200 经转发（假上游 echo 命名路径），非 500、非文件内容分支。

### 验证
- `bun run test:agent-sandbox`（仓库根）→ **exit 0**：native 6 文件 41 用例 + driven bun 组
  全绿。
- `bun test ./agent-sandbox/tests/proxy.test.ts` → **28 pass / 0 fail**（含新增 3 例）。

### 证据受限项
AC4/AC5 的「真实沙箱栈」集成（容器镜像内行为）未复跑：需要 docker 镜像重建。结果语义已由
双侧措辞钉死（gateway 答 404⇒null 与答 200 空内容⇒折叠 两臂均为 current，main 测试覆盖）。

## #408 — 生产空模板/缺少 preview 域名时显式关闭（AC6）

### 判定：main 无等价实现，本次实现
admission 对 dev 形态仅查 PORT/SERVER_PORT；空模板 + 生产（非 loopback appUrl）时照铸
`http://127.0.0.1:<port>/<label>`。

### 实现（server/src/craft/preview-origin.ts）
- `isNonLoopbackAppUrl`（复用 mainSiteHostOf 的同一解析器）：appUrl 未设/不可解析/loopback
  （localhost、127.0.0.0/8、[::1]）⇒ 本地 dev 形态；否则生产。
- admission：`template.kind==="dev"` 且生产 ⇒ closed，reason 命名
  `OPENBOT_CRAFT_PREVIEW_ORIGIN_TEMPLATE` 与修复动作。closed ⇒ `originFor` 抛错（无任何
  loopback 地址可铸）；webapp-info / preview-ticket 共用同一 admission（index.ts:5404 既有
  接线，未动）⇒ 503 + reason。
- `server/src/craft/config.ts` 零改动：部署上下文 = `config.appUrl`（OPENBOT_APP_URL，
  #404 既有注入缝），票面允许「显式 DEV 开关**或**部署上下文」二选一。
- `.env.example`、docs/craft-preview-origin.md（准入清单新增一条）、docs/deployment.md
  （Replicas 节前新增模板要求段）。

### 测试（server/tests/craft-preview-origin.test.ts 新增 3 例）
- 生产 + 空模板 ⇒ admission closed（reason 含模板变量名）、`originFor` 抛错。
- loopback appUrl + 空模板 ⇒ dev 形态原样（`http://127.0.0.1:3001/<label>`）。
- 生产 + host 模板 ⇒ 不受影响（`https://<label>.preview.example.com`）。

### 验证
同 #437 的 e2e 一轮：craft-preview-origin / craft-webapp-proxy 全绿（票面 Tests 命令的
`bun test tests/...` 形态按 ADR 0008 由 e2e native 层替代执行）。

## 全局验证汇总

| 命令（自仓库根） | 结果 |
|---|---|
| `E2E_UNIT_OUTPUT=<in-tree> bunx e2e run --config e2e.unit.config.ts server/tests/craft-skills-reload.test.ts server/tests/craft-preview-origin.test.ts server/tests/craft-webapp-proxy.test.ts server/tests/craft-webapp-generation.test.ts` | exit 0，251/251 |
| 同上 + `server/tests/craft-routes-assembly.test.ts server/tests/craft-session-provisioning.test.ts app/tests/craft-preview-tab.test.tsx` | exit 1；66 失败全部集中于 app 套件单跑（基线偶合，见 #437 节）；6 个 server 文件 0 失败 |
| `bun run test:agent-sandbox` | exit 0（native 41 + driven bun 组） |
| `bun test ./agent-sandbox/tests/proxy.test.ts` | exit 0，28/28 |
| `(cd server && bunx tsc --noEmit)` | 2 处 error TS，**均为基线**：`scripts/bootstrap-local-gateway.ts`（本 diff 未触碰、不 import 任何改动模块）；HEAD 临时 worktree 复验同样报错（≥2 行） |
| `(cd agent-sandbox && bunx tsc --noEmit)` | 无错误 |
| `bunx biome format <改动文件>` | 我的行全部合规；4 个文件残余漂移在 HEAD 即存在（git show + biome 复验），未纳入本次 diff |

## 改动文件 sha256

```
8f13ef65c38cde4746e68a1a661629a5a9b10f3d59aec63635ea647f7701432f  .env.example
b6ae283370403b7467bce0c2ddb1e3a33d6a6b81e194f18b4fbea6517d4851da  agent-sandbox/src/proxy.ts
506c80ae6e984740b5bff2954af666c07f962e8928e723d6c780e108aa37785c  agent-sandbox/tests/proxy.test.ts
c84540815ef403fea3b3ccdb8eb44a3d9437407990b4191ffa576c8772531e75  docs/craft-preview-origin.md
4ed003b24f3432d5d621fe922440349361049c6918624f84beb265de20af4c46  docs/deployment.md
ca22b935c870d59854b0b06408736253b0c10d0a6020da039b03443e8975397f  server/src/craft/manager.ts
a45a33eba08166c1cddedb245e3242e19962f9cead6aa635f3e0dbbe9c3cbafe  server/src/craft/preview-origin.ts
399de37da62c8f999c3b0f54af05619cf2169c46b24e275e870a1e9773c99474  server/src/craft/webapp-proxy.ts
f5881e665995aaec811ffa869d6fd0f7aa99e9fe5fcfdae46e6a88f050f4443a  server/tests/craft-preview-origin.test.ts
b2b70f0e945c9daeab8dff39946c12f4e963b17da4f1673da0ee9622244e7c3f  server/tests/craft-skills-reload.test.ts
```

## 所有权与边界
- 改动仅限三票票面声明文件与对应测试 + 票面点名的文档；未动 docs/plans/、计费、无关模块。
- TEST_DATABASE_URL（5564/craft2）本轮目标套件均为内存 fake，未触库；容器按任务约束保留原状。
- 未做镜像重建/版本 pin 变更（#433 完成定义的「若动版本 pin」条件不成立）。

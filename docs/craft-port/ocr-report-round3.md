# OCR Review — Round 3(Craft Parity Remediation 修复后第 3 轮)

> 会话 `24c5f9d8-4045-4391-a1cf-bbcf69be1f56`(2026-10-13,cwd=repo)。
> 意见原文:`ocr-comments-round3-raw.txt`(同目录,逐字副本)。

## 覆盖状态:部分 — 41 文件入选 / 31 文件失败(配额),18 条意见(1 high、7 medium、10 low)

- LLM 重试报告:13/89 请求受影响;评审规划与核心评审批次共 13 组全部因 bigmodel 网关
  `429 rate limited` 六连失败(与 round 1/2 相同的账户速率阻断;本轮仍与真实现场回合共享配额)。
- 产出意见的文件:connect-app-routes.ts(3)、connect-app.ts(4)、opencode/serve-client.ts(3)、
  templates/webapp.plugin.ts(3)、templates/connect-app.plugin.ts(1)、webapp-proxy.ts(2)、nextjs-dev.ts(1)。
- 本轮含 1 条 **bug·high**(decide 端点先破坏性 takePending 后鉴权)→ 触发修复轮,处置见下表。

## 意见处置表(逐条)

| # | 级别 | 位置 | 摘要 | 处置 |
|---|---|---|---|---|
| 1 | bug·high | connect-app-routes.ts:70-82 | 破坏性 takePending 先于归属校验;他人 requestId 可远程取消所有者决策;503 分支同样消耗记录 | **已修(本提交)**:loadPending(只读)→ 归属+状态校验 → 才 takePending;并发重放幂等性保持(输者 no-op) |
| 2 | bug·medium | connect-app-routes.ts:115-129 | Branch 4 回补失败仍返回可重试 502;answerPermission 假阴性 → 重 POST 循环 | **已修(本提交)**:回补失败 → 502 `retryable:false`;假阴性循环经实证钉死(opencode 1.18.7 对重答 404 `PermissionNotFoundError`,非 2xx no-op — live 探测 + `packages/core/src/permission.ts` 源码),端点识别该终态 404 → **410 终态、不回补、不审计**,循环就此封顶 |
| 3 | bug·medium | connect-app.ts:141-146 | Redis takePending 把 eval 失败折叠为 null,与"已过期/已答"不可区分 → 假成功 200 | **已修(本提交)**:eval 失败上抛(loadPending 的 get 同步去 catch);路由映射为 502 `retryable:true` |
| 4 | bug·medium | opencode/serve-client.ts:1660-1678 | 超时兜底先删 pendingConnectApp 再验证+拒绝;KV 抖动/应答失败丢条目、拒绝永不发出 | **已修(本提交)**:条目仅在"拒绝已送达 / 记录确认已被 take / 上游已 404 终态"时删除;失败保留条目下轮重试(失败期间 inactivity 下限持续抬高,不会提前掐断) |
| 5 | bug·medium | opencode/serve-client.ts:1666-1675 | 超时兜底 load→answer→clear 与 decide 端点的 takePending 竞态,可能双答 | **已修(本提交)**:兜底改走同一原子 takePending 认领;输者(已被 decide take)干净 no-op;认领后应答失败 → 回补(与 decide Branch 4 同语义);clearPending 往返删除(该 seam 已无调用方,一并移除) |
| 6 | bug·medium | templates/webapp.plugin.ts:283-291 | restart 仅凭 `kill -0` 即 `process.kill(pid)`,缺脚本侧 /proc cwd 身份守卫 | **已修(本提交,有意 onyx 分歧)**:移植脚本守卫(`readlink /proc/<pid>/cwd` = 本会话 outputs/web 才 kill,kill 后删 pid 文件;身份不可建立 → 跳过 kill,脚本自守卫 reconcile)。onyx 同样裸 kill(pinned `webapp.ts:236-244`,fixture F5 §E)— 裁决 **OpenBot wins**,见 onyx-contract §6 #9 |
| 7 | bug·medium | templates/webapp.plugin.ts:129-135 | tailLog 行数无下限;`lines=0` → `slice(-0)` = 全量日志注入 | **已修(本提交)**:handler 端 clamp 下限 1(非有限值回落默认 30)+ tailLog 内 `n<=0 → null` 兜底 |
| 8 | doc·medium | templates/webapp.plugin.ts:217-220 | description "it scaffolds outputs/web" 与脚本行为矛盾 | **接受勘误,不改**:onyx-contract §6 #6 既有裁决(文本逐字节 + 脚本结构等价双锚;AGENTS.md 指引补偿已测) |
| 9 | style·low | connect-app.ts:263-270 | parseConnectAppAsk 嵌套三元 + parseInt 宽松解析 | **deferred low**(解析行为会变,需独立 TDD;本轮不动) |
| 10 | maint·low | templates/connect-app.plugin.ts:113-116 | catch-all 以"用户已拒绝"文案返回基础设施错误 | **deferred low**(onyx 逐字移植;注释补注属可选润色) |
| 11 | style·low | webapp-proxy.ts:241-249 | `session.nextjsPort as number` 冗余断言 | **deferred low**(不在本轮触碰文件) |
| 12 | maint·low | nextjs-dev.ts:51-53 | SESSION_PATH 未加引号内插 | **deferred low**(不在本轮触碰文件;会话 id 构造上当前安全) |
| 13 | bug·low | opencode/serve-client.ts:1780-1790 | deny 三调用点忽略 answerPermission 返回值 | **deferred low**(本轮已将返回值升级为 `{ok, permissionGone}` 供 r3 修复使用;warn 补注留待后续) |
| 14 | bug·low | connect-app-routes.ts:56-58 | JSON null 请求体 → 500 而非 400 | **deferred low**(行为变化,需 TDD) |
| 15 | other·low | connect-app-routes.ts:148-153 | 决策 audit insert 失败仅 warn | **deferred low**(onyx 亦无补偿路径;观测性增强留待后续) |
| 16 | maint·low | connect-app.ts:301-312 | announce 失败 → pending 孤儿至 TTL | **deferred low**(回滚补偿属行为增强) |
| 17 | maint·low | connect-app.ts:219-225 | 内存实现 stash 追加 vs Redis SET 覆盖语义不一致 | **deferred low**(同 requestId 不会异内容重 stash;Branch 4 回补为同值) |
| 18 | maint·low | webapp-proxy.ts:288-290 | 上游 host 表达式两处内联 | **deferred low**(不在本轮触碰文件) |

## 修复验证(本提交)

- TDD:13 个新测试先 RED(route 7 + timeout 3 + webapp 3),修复后全 GREEN;详见
  `.superpowers/sdd/task-6-report.md` "## OCR round-3 fix"。
- 全量 craft 套件 `bun test tests/craft-*.test.ts`:**456 pass / 0 fail / 31 文件**(基线 446 + 净增 10);
  `bun run typecheck` 通过。全仓 `bun test`(468 文件)与 HEAD 基线逐位一致(154 fail / 113 errors
  均为既有环境依赖失败),零新增失败。
- 关键外部证据钉死:opencode 1.18.7(agent-sandbox `SANDBOX_VERSION` 同版本)本地 `opencode serve`
  实测 + 源码(`packages/core/src/permission.ts` reply:首次应答 `pending.delete`,重答
  `NotFoundError` → HTTP 404)→ 证伪"重答为 no-op"假设,据此选择 410 终态封顶而非依赖上游幂等。

# #419 证据收口（2026-10-18）

Issue：`1123786563/OpenBot#419`（[Craft Preview][P2] Issue/文档证据收口与 #358 验收汇总）。
本轮范围由用户裁决为**只做本地文档收口**，GitHub 状态与关系写入一律未执行。

## 基线

- 核验代码基线：`bbea87ba`（本地 `main` == `origin/main`）。
- 唯一归档的浏览器证据轮基线：`44754feb`
  （`archive/verification/craft-preview/2026-10-17T13-45Z/summary.json`）。
- 本轮证据类型：**全部为静态核验**（读源码、读文档、`gh api` 实读票面与评论）+ 两个
  语法解析检查（`sh -n docker/compose/certs/reload.sh`、YAML 解析 `certs.yml`）。
- **本轮没有运行任何测试**。并行会话正把工作区迁移到 e2e 框架（872 个未提交修改），
  `bun test server/tests/config.test.ts` 在采集期即失败
  （`describe() can only be called while a test module is being collected by the e2e
  runner`，因为 `server/tests/config.test.ts:1` 已指向尚未提交的
  `tests/support/e2e-compat`）。该失败与本文件无关，但它意味着本轮不能给任何结论标
  「自动化测试已通过」这一档证据。

## 票面「要做的事」——文档部分：已完成

| 项 | 改成什么 | 依据（静态核验） |
|---|---|---|
| cookie 门「任一匹配」更正 | `reference/craft-preview-origin.md` R-9 小节：删除「服务端取第一个同名值」与「父路径阴影恒排最后」两处断言，改为遍历全部同名候选、任一验签通过即放行；函数名从已删除的 `holdsPreviewSessionPass` 更正为 `verifyPassWith`；补上真实攻击形状（更深路径 `Path=/<labelB>/x` 的合法阴影排在通行证之前） | `server/src/craft/preview-origin.ts:104`（`verifyPassWith`）、`:864-877`（候选收集，注释显式写 `fix-ocr20 #3, superseding fix-ocr5 E's first-match`） |
| HMR #363 已落地 | `reference/craft-preview-origin.md`：小节标题从「#363 的范围」改为「#363，代码已落地」，写明入口 `resolvePreviewWebappHmrUpgrade` 与 HTTP 门共用同一验签、外加 Origin 门（fix-ocr28 #1）；对照表 HMR 行同步；**并写明这只是接线证据，AC5 的运行时热更新没有证据** | `server/src/craft/webapp-proxy.ts:1298`、`server/src/craft/preview-origin.ts:118-131` |
| `reference/tls-certs.md` 的 server 消费描述改为真实拓扑 | 四处：证书消费者改为「终结 preview origin TLS 的进程」并写明 server 从不打开 `cert.pem`/`key.pem`、监听明文 HTTP；准入前置检查项改为「`https` 描述浏览器看到的 scheme，不是 server 的 listener」；`renewal-status.json` 的消费者改为 healthcheck + 告警（server 不读它，故证书故障不会体现在准入门上）；reload 两条机制的接收方由 server 改为 TLS 终结者；私钥属主说明同步 | `grep` 全量 `server/src`：无 `cert.pem`/`key.pem` 读取，无 `renewal-status` 引用；`docker/compose/certs/reload.sh`、`docker/compose/certs.yml` |
| `.env.example` 增加 preview / TLS 变量 | 新增两节：`Craft preview origin (#358)`（`OPENBOT_CRAFT_PREVIEW_ORIGIN_ENABLED`、`OPENBOT_CRAFT_PREVIEW_ORIGIN_TEMPLATE`、与 `KEY_ENCRYPTION_KEY` 的 pass 签名关系与轮换后果）与 `Craft preview TLS (#359)`（`ACME_ACCOUNT_EMAIL`、`ACME_CA`、`OPENBOT_TLS_HOST_DIR/UID/GID/WARN_DAYS/CRIT_DAYS/ALERT_COOLDOWN_SECONDS/ALERT_WEBHOOK/RELOAD_URL/OWNER/RENEW_INTERVAL_SECONDS`）；DNS 凭据按实现留在 `./dns.env` | `server/src/craft/config.ts:480-490`（默认值 `true` / `""`）、`server/src/index.ts:4855`（`secret: config.keyEncryptionKey`）、`server/src/craft/preview-pass.ts:83-93`（MAC 输入含 sessionId+userId）、`docker/compose/certs.yml:26-57`、`docker/compose/certs/entrypoint.sh:155-168`（仅生产 CA 强制 email） |
| `AGENTS.md` 引用的 `docs/agents/domain.md` 缺失 | 新建该文件，说明单一领域上下文在根 `CONTEXT.md`、与 `docs/specs`/`docs/adr`/`docs/plans`/`docs/tickets` 的分工和四条使用规则 | `AGENTS.md:11`；此前 `ls docs/agents/` 仅有 `issue-tracker.md` |

顺带更正（票面未列，但属同一漂移）：`docker/compose/certs.yml` 与 `docker/compose/certs/reload.sh`
的头注释同样假定「preview server 读私钥 / 有 reload 端点」，已改为 TLS 终结者；行为未变。

写 `.env.example` 时发现的一条**真实缺口**，已在注释里点名而非粉饰：
`OPENBOT_CRAFT_PREVIEW_ORIGIN_ENABLED=false` 并不等于「预览已隔离」——legacy 同源代理仍然
注册且无开关可关（D10 的存量载体），这正是 #425 还没做的事。

## 票面「要做的事」——GitHub 部分：一律未执行

以下均为共享可见状态，按裁决保持原样，留待用户单独授权：

- #358 正文「实施 Tickets」9 条仍全是 `[x]`，实际只有 #359 CLOSED（`2026-10-17T16:06:48Z`），
  #360–#367 全 OPEN；
- #358 的 GitHub 原生子票关系共 30 张 = `#403–#433`，**不含 #359–#367**，所以票面的
  「补原生 sub-issue 关系或注明文本关系」仍是空的；
- #359 的 `## Parent` 仍然自引用 `#359`；
- #360 只有一条 2026-10-15 的审阅裁决评论；#361 末条评论（`2026-10-17T09:44:08Z`）写
  「终态 verified……九票 #359–#367 全部交付」，与 #436/#437 两张 P0 至今 OPEN 直接冲突；
- PR #432 的 5 个文件内容已分别随 `e4751f7d`、`37950e89` 进入 `main`，PR 本体已成冗余，
  未关闭。

## #358 验收矩阵（按证据档位，不折算成「通过」）

状态取自归档轮的 `ac_results`，并按 `44754feb → bbea87ba` 之间的 craft 提交重新判定。
`93c450c1` 与 `22b491b3`（签名 pass 取代可伪造的 session-id cookie、HTTP/HMR 共用验签 +
owner 复核）经 PR #435 合入，晚于浏览器证据轮。

| AC | 状态 | 证据类型与 SHA | 缺口 |
|---|---|---|---|
| AC1 隔离 | verified@`44754feb`，HEAD 未复测 | 真实浏览器（预览域内 `fetch('/api/craft/sessions')` 字面 401、`document.cookie` 为空、localStorage 互不可见、跨源打主站被 CSP 拦） | 结论依赖 host 拓扑，签名 pass 改动不动它；但相对 HEAD 只是「静态一致」，不是复测 |
| AC2 自身 API 四动词 + Server Actions | **blocked**（HEAD 已接线，运行时未证实） | 静态：`server/src/index.ts:4948`（`webappBasePathFor`）、`server/assets/craft/web-template/lib/base-path.ts`（`ONYX_WEBAPP_BASE_PATH`）；归档轮明确记 `blocked_in_this_environment` | 需要干净栈实测：#437（mount 注入）与 #436（迁移漂移）都还 OPEN |
| AC3 会话间互不可读 | **unknown** | 归档轮未覆盖 | 无证据，不得写 verified |
| AC4 票据单次使用/过期/他人拒绝 | **partial**，票面不能记 verified | 浏览器 verified@`44754feb`（实测 TTL 30.0s、302 后 URL 不含票） | **该证据对应修复前的明文 cookie 形态**；`93c450c1`/`22b491b3` 换票验签后没有任何浏览器或真实 socket 复测 |
| AC5 附着模型 + HMR | **partial** | 归档轮 `partial`；HMR 代码已落地（`webapp-proxy.ts:1298`） | 真实 dev server 下的 HMR websocket 帧数与「编辑→DOM 热更新」从未测过，被 AC2 同一阻塞 |
| AC6 生产形态显式关闭 | verified_partial@`44754feb` | 归档轮 + 静态（`preview-origin.ts:650-654` 给出可展示原因） | 「无泛域名证书」这一支未覆盖 |
| AC7 存量会话不回归 | verified_partial@`44754feb` | 静态（legacy 提示 `app/src/components/craft/output-panel/preview-tab.tsx:1172`） | 旧会话运行期行为未跑满 |
| AC8 ACME 签发与续期 | **partial**——流水线已实现，生产运行未证实 | 静态 + CI 内 offline 演练（`docker/compose/certs/drill-renewal-failure.sh --offline`、`scripts/tls-pipeline.test.ts`） | 真实 Let's Encrypt 签发、真实续期、真实告警送达、以及证书交到 TLS 终结者手里——四者都没有生产证据 |
| AC9 主机名不泄露会话 | verified@`44754feb` | 浏览器（label 为 20 位小写 hex、每会话不同、不可反查） | 子域名枚举面未做主动尝试 |

一句话口径：**AC1/AC9 可写 verified（SHA 要写 `44754feb`）；AC4 必须降级为 partial；AC3 unknown；
AC2/AC5 blocked；AC6/AC7 verified_partial；AC8 partial。#358 不能宣布验收完成。**

## 下一步（不在本轮范围）

1. 修 #436（干净库 `migrate` 返回 ok 但启动即 `42703 skills.icon`）——它决定「可复现部署」是否成立，
   也决定 AC2/AC5 的实测能否离开被污染的共享开发库。
2. 实测 #437 的修复是否真的把 `/<label>` mount 写进新会话的 `start-webapp.sh`（接线已在 HEAD，
   运行时未证实），随后补一轮真实浏览器证据（AC2/AC4/AC5/AC7）。
3. 拿一轮证据之后再按票面把 #358 正文的 `[x]`、#359–#367 状态、sub-issue 关系、#359 Parent、
   #360/#361 评论一次性对齐；同批处理 PR #432 的冗余关闭。
4. `CP-NN` 依赖引用（#404–#419 每票的 `Dependencies: CP-NN`）目前**无法核对**：原波次计划文档
   从未提交、其路径被覆盖后丢失，映射表不可恢复。要么由原作者会话补出映射，要么把这些字段改成
   指向 Issue 编号，否则它们永远是悬空引用。

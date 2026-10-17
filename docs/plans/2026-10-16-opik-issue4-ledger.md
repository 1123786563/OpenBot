# Opik #4 执行 Ledger — 2026-10-16 会话（续接）

## 续接事实（2026-10-16 重建，来源=文件+Git+旧 Ledger，非模型回忆）

- 摄取：GitHub GraphQL 实读 #4 正文（0 评论）+ 37 子 Issue 正文/评论/blockedBy/blocking（快照：主 repo `.omc/state/opik-issue4/snapshots/all-subissues.json`）。37 节点、89 依赖边、无环。`contains` 与 `depends_on` 分离。
- 事实源：`docs/specs/2026-10-14-opik-integration-design.md`（已批准，A1–A13）；`CONTEXT.md`；ADR 0001–0005（0004 企业租户与本 epic 无冲突：本 epic 仅工作台 adapter+seam 预留）；Git main=`bab7c0b9` clean。
- 冲突/修正：2026-10-15 DAG 的 T19 依赖 "T07,T17" 有误，GitHub 实读 #25 blockedBy=#17(T11),#13(T07)，已在新 DAG 修正。GitHub #4 正文与本地 spec 文件非字节相同（前次已裁定：Issue 为发布验收权威，本地文件保留设计理由；实质一致）。
- 前次会话状态（run_8e2edde379e8，6 dispatch 全部 terminal 失联=unverifiable，仅作历史）：T03 已验证落地 `1123786563/opik-t03`（b1a7334b，7 commits，含真实栈证据）；T01 候选=`1123786563/opik-T01-2`（5 commits clean，末次提交为评审修复）；T02 候选=opik-T02-2 未提交 17 files；T05 候选=opik-T05-2 untracked 3 paths；T06 候选=opik-T06-2 untracked 3 files+`docs/plans/issue-4-ledger/T06.md`（记录移植+复验+评审 F1/F3/F4 修复，36/36 绿）。
- 旧基线（opik-integration worktree @7c25fb4c，未提交 310 文件）含 T01–T09 已验证内容+全套评审证据（`docs/plans/evidence/2026-10-15-issue4/`）；T10 实现检查点未评审；T32 部分产出。**裁定沿用：main bab7c0b9 为唯一集成基线，以上仅为候选证据，须显式移植+复验。**
- 集成策略：integration branch `1123786563/opik-integration-main`（自 bab7c0b9）；按 DAG 顺序逐票 cherry-pick/哈希核对转移；每票门禁复跑；字节一致于已评审包的内容沿用旧评审+新增移植复核，内容有漂移的必须全新独立评审。

## 本会话 Run

- Run ID: `run_ab5804dae285`（2026-10-16 创建）
- Coordinator worktree: `/Users/wuyongjun/orca/workspaces/OpenBot/opik-4-coordinator`
- Integration worktree: `/Users/wuyongjun/orca/workspaces/OpenBot/opik-integration-main`（分支 `1123786563/opik-integration-main`，BASE bab7c0b9）
- 提交政策：实现者在子 worktree 分支提交；coordinator 在 integration-main 上 cherry-pick/应用已评审补丁；不 push/merge/publish。

## 状态

- 已验证节点: T03（旧会话，main 基线分支）
- 运行中 Dispatch: （派发后填）
- 下一波就绪: Wave A = T01 评审、T02 定稿、T05 定稿、T06 定稿、T04 移植+live 复验（T03 集成由 coordinator 执行）
- 阻塞/裁决: 无

## 记账规则（沿用前次，不放松）

- 每任务保留 Review Package（patch+文件哈希）、测试证据（原样输出+退出码）、报告哈希；测试/评审绑定内容哈希，内容变更须受影响复验+复审。
- 空 BASE..HEAD 不算已评审；超时/失联/空结果只是检查点。
- OCR 最终覆盖 BASE→HEAD 与全部未提交内容两个范围。

## 流水（追加）

### 2026-10-16 Wave A 派发（run_ab5804dae285，全部 effective agent=claude，model/effort=null 继承，不声称档位）

| 任务 | Task | Dispatch | worktree 基线 |
|---|---|---|---|
| T01 独立评审（只读） | task_07ca898a2fd8 | ctx_260b5ef3f1db | new-child opik-review-t01-m ← 1123786563/opik-T01-2 |
| T02 定稿 | task_bf58eb97bfa2 | ctx_d2ba272c8f65 | new-child opik-t02-final-w ← 1123786563/opik-t02-final |
| T05 定稿 | task_3ecd22dd8351 | ctx_401ca0fb871f | new-child opik-t05-final-w ← 1123786563/opik-t05-final |
| T06 定稿 | task_a3cf8b24440b | ctx_26f4933c3433 | new-child opik-t06-final-w ← 1123786563/opik-t06-final |
| T04 移植+live 复验 | task_2fd68fa67a85 | ctx_c6d0a9751860 | new-child opik-t04-port-w ← 1123786563/opik-t04-final |

候选分支建立（coordinator 机械转移，全部自 bab7c0b9 或已验证 T03 分支）：
- `1123786563/opik-t02-final` ca48cd0d（17 路径，源 opik-T02-2 未提交）
- `1123786563/opik-t05-final` 77389284（3 文件，源 opik-T05-2 untracked）
- `1123786563/opik-t06-final` cdcf1a6d（3 文件+T06.md，源 opik-T06-2 untracked）
- `1123786563/opik-t04-final` b0dbd027（T03 分支+旧评审补丁 d3c5cf39…，四文件 sha256 与旧 T04-package 完全一致：60724b27/99cbe67c/0e2816f3/60388d47）

### T03 集成检查点（coordinator）

- cherry-pick bab7c0b9..1123786563/opik-t03（7 提交）→ `1123786563/opik-integration-main` HEAD `0e95449e`，与源分支树零差异。
- 门禁复跑（integration-main/server）：`bun test tests/opik-deployment.test.ts` = 18 pass / 0 fail / 162 expects，exit 0。
- 真实栈证据沿用 2026-10-15 验证（opik-issue4-validation 9 容器 healthy，本会话 docker ps 复核仍 healthy）。
- **T03 节点：已验证并集成。**

### Wave A 结算流水

- **T01 评审完成**（task_07ca898a2fd8/ctx_260b5ef3f1db）: Spec PASS / Code APPROVE。四验收全过、typecheck+15 测试绿; biome 12 诊断中 10 基线 2 新增。findings: F1 medium（正向挂载未走真实 createApp）、F2 low（organizeImports）、F3 low（403 vs 不存在语义）。报告 sha256 前缀 78f23265（coordinator 证据副本）。评审终端已释放。→ 派发 polish task_6a1e74270832/ctx_cd9cfa08fbeb（opik-t01-polish-w）。
- **T06 定稿完成**（task_a3cf8b24440b/ctx_26f4933c3433）: 16b21320。修复 2 处 biome import 排序; typecheck 0、36/0/80、biome check 0; 契约抽查全过（企业检查先于 ownership、WeakSet 唯一签发、freeze、HMAC 游标、无 db import、无 tenant 导出）。实现者已释放。
- **T06 独立评审完成**（task_176f27188aff/ctx_5d09b2661525）: Spec PASS / Code APPROVE。46 项对抗探针全过; 四验收满足。R1 low（readCursor 尾部垃圾段宽松）、R2 low（locator 指纹 8 hex）、R3-R5 info。报告 298a7088。评审已释放。→ 派发 polish task_bd11982d328c/ctx_08f484acb3c9。
- **T06 polish 完成**: c7c07e1d。R1 严格两段校验+正反测试、R2 指纹 16 hex+长度钉住; RED(2 fail)→GREEN 38/0/84; 三门禁 0。→ 派发增量复审。
- **T04 移植+live 复验完成**（task_2fd68fa67a85/ctx_c6d0a9751860）: fc86f547。四文件哈希与旧评审包逐一相符、零代码改动; 24/24 单测; 真实实例 11/11（OTLP ingest/ID 映射 derived+explicit/数据集不可变/删除轮询 404/正文上限/canary clean/9 镜像 digest 一致）; 新 manifest sha256 前缀 38322418（47 fixture 于 opik-t04-port-w 证据目录）; 合成资源物理删除+独立 curl 复核; 凭据零泄漏。实现者已释放。→ 派发独立复核 task_fa53d22e9d42/ctx_75feebd23050。遗留: versions.json compatibility.status unverified→verified 翻转（T03 文件+其测试钉住），待 T04 复核通过后派小任务。
- **T05 定稿完成**（task_3ecd22dd8351/ctx_401ca0fb871f）: 94bc0145+935ce9bf。对旧 R05 包逐项核查: 行为全保留; 补回 5 组对抗用例（PEM 位置变体、AWS 大写标签、裸 40 字符、inherited phantom、astral originalBytes）; 58/58 测试、typecheck 0、biome 0。实现者已释放。→ 派发独立评审 task_ebfe9dc57068/ctx_427e9332d515。
- **T06 polish 完成+复审通过**: c7c07e1d（R1 严格两段校验、R2 指纹 16 hex，RED 2 fail→GREEN 38/0/84）; 增量复审 task_a9e879657783 Code APPROVE（全仓无 8 hex 遗留、门禁全绿、T06.md 一致）。
- **T06 集成**: cherry-pick 3 提交（b38068c5/9a1d9553/3101e965）→ integration-main; 复跑 scope+deployment 56 pass / 0 fail / 246 expect。**T06 节点: 已验证并集成。** 释放 polish 实现者与复审者。
- **T02 定稿完成**（task_bf58eb97bfa2/ctx_d2ba272c8f65）: 8bf90a02。修复 routeTree.gen 未重生成、BotSubpage 类型、路由测试依赖; 4 占位路由保留为最小可执行证据; 归属矩阵 docs/plans/issue-4-ledger/T02.md; typecheck 0、9/0 测试、biome 9 文件 0。实现者已释放。→ 派发独立评审 task_71ca70f1fa98/ctx_e49d2f22bd26。
- **T01 polish 完成**（task_6a1e74270832/ctx_cd9cfa08fbeb）: 460a55e6。F1 真实 createApp 正向用例、F2 organizeImports、F3 403→404 'Bot not found.' 对齐 Spec §7; typecheck 0、15/0 测试; biome 剩 10 条基线诊断零新增。附带: ready.test.ts createApp.length-1 偏移在 bab7c0b9 基线已腐烂（0 pass/3 fail），范围外既有缺陷记录未修。实现者已释放。→ 派发增量复审 task_524f097cec8e/ctx_581ecca7f9cb。
- **T07 移植派发**（task_072cdb8ecfa3/ctx_09b3b41c8574）: 基线 integration-main（T03+T06 已入）。迁移重编号 0110→0122（当前 journal 顶 0121）; 集成测试专用 PG opik-t07-pg（127.0.0.1:5547）; 旧评审证据路径已给。
- **T01 polish 复审通过**（task_524f097cec8e）: Code APPROVE。F1 实参精确落 openMuseSeams 第 46 参; F3 404 常量全仓无越界; biome 基线 10→8（净减即 F2 两处）。ready.test.ts 腐烂确认为 bab7c0b9 预存（aa0f90a5 追加 identity 尾参所致）。
- **T01 集成**: cherry-pick 6 提交 → integration-main d5cc9ef8; 复跑 opik-module-skeleton 15/0/22、server typecheck 0。**T01 节点: 已验证并集成。**
- **T05 独立评审完成**（task_ebfe9dc57068）: Spec PARTIAL / Code REQUEST-CHANGES。评审自创 12 组对抗构造发现 7 findings（F1 URL userinfo 3/6 入口泄漏、F2 标签距离窗口、F3 <think> CoT、ReDoS、云元数据、throwing getter、小写 PEM），均为旧 R05 预存非回归。报告 107ab2c9。→ 派发修复 task_59d80cbf473a/ctx_1aca27954fd5（版本 bump /3）。
- **T02 独立评审完成**（task_71ca70f1fa98）: 4/4 验收达成可合并。F1(中) evaluations basic 语义复用、F2(低) tokenUnavailable 缺、F3(信息) datasets 路由说明。报告 c3903e2d。→ polish task_2ebde62a2502 提交 b4e45230（三门禁全绿 9/0/199）→ 增量复审 task_f98c67bef8df Code APPROVE（en/zh key 程序化对称）。
- **T02 集成**: cherry-pick 3 提交 → integration-main cbb98271; 复跑 app typecheck 0、9/0/199。**T02 节点: 已验证并集成。**
- **T07 移植完成**（task_072cdb8ecfa3/ctx_09b3b41c8574）: 4a34a172 于 opik-t07-port-w。bindings/schema/三测试与旧评审实现逐字节同; 迁移 0122 SQL 逐字节同+snapshot 手工合并自 0121（drizzle-kit generate 被预存快照碰撞阻挡，等价性证据在报告）; 单元 48/48; 集成 10/10（专用 PG 5547 openbot_enterprise_t07）; 全链迁移 123 条+幂等; biome 干净; migration-journal 1 fail 预存漂移（干净 HEAD 复现相同集合）。报告 f0cea135。实现者已释放。→ 派发独立评审 task_5656c9d23a6d/ctx_067436ddc2cb。
- **T07 独立评审通过**（task_5656c9d23a6d）: Spec PASS / Code APPROVE，15 项声称逐项实测（snapshot 程序化验证 160→161 表、集成测试真实专用库复跑 10/10、幂等重跑、预存漂移基线复现）。2 low（基线标注措辞、biome meta 措辞）+1 观察，零阻断。
- **T07 集成**: cherry-pick 4a34a172 → 6749f410; 复跑单元 48/0/125; 集成测试首次复跑失败（coordinator 用错凭据+未先 migrate），按测试内指引 DATABASE_URL 指向专用库跑 migrate 后 10/0/48 通过。**T07 节点: 已验证并集成。** 专用库: postgres://opik_t07@127.0.0.1:5547/opik_t07_test（凭据不写入本账本以外文件）。
- **T05 修复+复审闭环**: repair 6ecab088（7 findings 全修，RED 16→GREEN 76/0，/3）→ 复审 Spec PASS/Code APPROVE 但新发现 N1/N3 Low 预存 → polish2 65eb7dca（N1 域名尾点规范化、N3 Proxy ownKeys fail-closed，RED 6→GREEN 83/0，/4; 实现者如实缩小范围: 大小写/IPv4 由 URL 解析器已规范化）→ polish2 复审 APPROVE（26 项双向探针）。残留: O1/O2 crash-not-leak 可用性观察，记入 T08 brief 收口。
- **T05 集成**: cherry-pick 4 提交 → 9b8586c8; 复跑 83/0/214、typecheck 0。**T05 节点: 已验证并集成。**
- **T04 复核 dispatch 故障与重试**: 首次 ctx_75feebd23050 在 worktree_create 阶段失败（资源未物化）——根因是 --base-branch 引用了不存在的 1123786563/opik-t04-final-w（实际为 opik-t04-port-w）; retry ctx_0917b9747ffd 同因失败; 第三次 ctx_012477082e58（正确分支）state ready，worktree opik-review-t04-r3 已建。教训: 派发前必须 git worktree list 核对分支名。

### Wave A/B 结算（续）

- **T04 独立复核通过**（ctx_012477082e58）: 移植完整性 PASS / 证据链 PASS。四文件哈希=旧评审包; manifest sha256 38322418… 复算一致; live 清理 404 与凭据零泄漏独立复现; 24/24+typecheck 绿。3 Info。47 份 fixture 已复制入 coordinator 证据库。
- **T04 翻转微任务**（ctx_32289290b79a）: 58b26544 versions.json compatibility→verified（evidence 指 47-manifest sha256 完整值），deployment 测试守卫翻转。集成后 18/18。**T04 节点: 已验证并集成。**
- **T08 移植**（ctx_2e29d58dc887→6b96dddb）: port/http 与旧三轮最终版 byte-identical、测试 1 行 manifest 路径适配; O1/O2 收口在 redaction.ts（N3 模式，bump /5，RED 2 crash→GREEN 85/85）。独立评审（ctx_cf33d8d20b7a）Spec PASS/Code APPROVE，28/28 hostile 探针。集成时发现 port 测试依赖的 manifest 未随分支携带（评审 Low 项）→ 将 canary-clean 的 47-manifest.json 提交进分支（sha256 38322418ee7a…），复跑 143/0/364 与评审一致。**T08 节点: 已验证并集成。**
- **T09 移植**（ctx_990d6241a1f5→7feb535c）: config/routes/index 挂载与旧评审版 hash 一致; health.ts+测试两处机械偏离（manifest 路径/biome）。82 用例覆盖四验收。独立评审（ctx_fe5ccbfc9957）Spec PASS/Code APPROVE; F-1 note 裁决为集成期事项。集成后 48/0/165。
- **T09 装配微任务**（ctx_6e4043161539→c4e70565）: index.ts 装配 seam 传 port:null 健康服务，端点 HTTP 可达（401→200 capability_missing），路由级测试镜像装配。集成 ae6cffe4 后 34/0/148。**T09 节点: 已验证并集成。**
- **T32 移植定稿**（ctx_59e68a775174→f5c656c4+e8579f12）: 候选（旧 t32 worktree 214 行 control-plane-auth.ts）逐字节移植，补 2 测试（拼接不泄漏、seam 单点），RED 留痕，30/30。→ 评审 ctx_ec4578180015 运行中。
- **T10 移植**（ctx_374ae03c7ab0）: 运行中（旧候选: run-lifecycle+basic-run 路由+36 用例，未评审过——本次将做完整独立评审）。

### 当前已验证并集成节点

T01 T02 T03 T04 T05 T06 T07 T08 T09（9/37）。运行中: T10 移植、T32 评审。下一波就绪（待 T10）: T11（T01+T07+T10）; T14（T05+T10）。

## T15 dispatch（2026-10-15 18:34）
- dispatch ctx_c49612f3748b / task_d56b0e2c3233 / agent claude（回执 effective 确认）/ worktree opik-t15-w / base 1123786563/opik-integration-main（含 T14 8fca4e7b）
- brief 含 T14 评审 4 minor 收口（spanInput 语义注释、spanOutput 线性化、switch 穷举、覆盖缺口）
- 实现者报告路径 docs/plans/evidence/2026-10-16-issue4/T15/implementation-report.md

## T16 dispatch（2026-10-15 18:34）
- dispatch ctx_e4905be07710 / agent claude / worktree opik-t16-w / base 1123786563/opik-integration-main
- 域：agent-langgraph/ 模块 callback 接治理 OTel 路径；detailed 判定实现但标记保持 honest（真实验证留 T37）
- 与 T15 无文件重叠（server/ vs agent-langgraph/）

## T19 实现 worker_done（2026-10-15 18:46）
- ctx_d51b8fcb8cdf succeeded → 分支 1123786563/opik-t19-w 提交 4ea07a09（未 push），12 文件 +21112（大头为 0123 snapshot）
- 要点: 迁移 0123（手工合并 snapshot，含 BEFORE UPDATE 拒绝触发器）、冻结管线 sha256 golden hash、同步状态机 synced 需上游 id DB CHECK、(scope,dataset,content_hash) 幂等版本键
- 门禁（实现者报告）: typecheck 0 / 单测 29 pass / 专用库 openbot_enterprise_t19 集成 10 pass / biome 0; migration-journal 预存 1 fail 与本票无关
- 待复核: redaction.ts 增量无回归（评审重点 2）
- 独立评审派发: ctx_56b64f292357（opik-t19-rev，只读，基线 opik-t19-w）

## T19 评审+集成（2026-10-15 18:55–19:0x）
- 评审 ctx_56b64f292357（opik-t19-rev，报告提交 1eee16c2，已归档 coordinator 证据库）: Spec PASS / Code APPROVE
- findings: 1 Medium（markSyncing/markFailed 读-判-写无守卫，并发 synced 可被降级）+ 3 Low（版本行 DELETE 未拦、listVersions 无 tiebreaker、journal 预存红）→ 不阻塞，Medium+2 Low 并入 T20 brief
- 集成: cherry-pick 4ea07a09 → 04098a63（integration-main）；门禁复跑: typecheck 0、单测 18 pass、专用库 openbot_enterprise_t19_int（新建于 opik-t07-pg@5547）迁移 124 条 ok + 集成 10/0 pass
- 节点状态: T19 已验证并集成（14/37: T01–T11+T14+T19+T32）

## T20/T34 dispatch（2026-10-15 19:1x）
- T20: ctx_c20cabe052f3 / opik-t20-w / base integration-main@04098a63。brief 含 T19 Medium+2 Low 加固（sync 状态守卫/DELETE 拦截/tiebreaker）
- T34: ctx_089ae4cc93d3 / opik-t34-w / base integration-main@04098a63。独占迁移 0124（export_jobs）
- 运行中: T12 ctx_4b35b27860ec、T15 ctx_c49612f3748b、T16 ctx_e4905be07710、T20、T34（5 并行）

## T16 实现 worker_done（2026-10-15 18:57）
- ctx_e4905be07710 succeeded → 1123786563/opik-t16-w 提交 93e12d8f（未 push），10 文件 +1144/-60
- 要点: GovernedCallbackHandler 挂共享治理 OTel 路径（shared/trace.ts + withTraceFetch W3C）; Opik SDK 非依赖（结构性无自动上传，测试钉死）; detailed 判定 FRAMEWORK_STEPS_VERIFIED_ON_REAL_INSTANCE=false 保持 honest; canary+fake-provider e2e
- 门禁（实现者报告）: typecheck 0 / 根 bun test agent-langgraph 53/53 / biome 0
- 改动面注意: shared/trace.ts 与 docker-compose.yml 跨域（评审重点 2/3）
- 独立评审派发: ctx_f34a8990afef（opik-t16-rev，只读）

## T15 实现 worker_done（2026-10-15 19:03）
- ctx_c49612f3748b succeeded → 1123786563/opik-t15-w 提交 081f1c0d（未 push），7 文件 +1952/-186
- 要点: tool-steps.ts 三态枚举（proposed/executed/unobserved; 未知浏览器执行终态 unknown 永不成功）、copilot.ts 观测旁路、retrieval.ts 观测 seam、T14 4 minor 一并修复
- 门禁（实现者报告）: typecheck 0 / 42 pass 0 fail（RED 留痕）/ biome 核心文件 0 新告警
- 风险标注: retrieval.ts 377 行改动、copilot.ts +308——评审重点行为等价
- 独立评审派发: ctx_811ea284be86（opik-t15-rev，只读）

## T16 评审（2026-10-15 19:04）
- ctx_f34a8990afef（opik-t16-rev）: Spec PASS / 质量 REQUEST-CHANGES
- M-1: 非 Error 抛出值经 String() 入 openbot.error.name（governed-tracing.ts:241/:409），字节级实测泄漏; L-1 字节级用例入库; L-2 bun.lock npmmirror 重写
- 评审独立复核: 真 provider+假 OTLP collector 字节级 4 canary 零泄漏; shared/trace.ts 实未触及（前置疑虑解除）
- 修复派发: ctx_6161e5ebfef9（opik-t16-fix，基线 opik-t16-w）

## T16 修复轮 worker_done（2026-10-15 19:11）
- ctx_6161e5ebfef9 succeeded → opik-t16-fix 提交 b833d36a（3 文件 +221/-8: NonErrorThrow 固定标记、governed-export-bytes.test.ts 字节级 canary、fix-report）
- 门禁: typecheck 0 / bun test 54/0 / biome 0; M-1 RED 先行留痕
- 增量复审派发: ctx_c37fb1b0a7f0（opik-t16-rev2，只审 b833d36a）

## T15 评审+集成（2026-10-15 19:12）
- 评审 ctx_811ea284be86（opik-t15-rev）: Spec PASS / Code APPROVE（0 critical-high-medium; 4 low: cell teardown 泄漏、倒序双记录窗口、tap error 无专测、kbIds 重复 + 2 info → 并入 T17 brief）
- 关键确认: retrieval.ts 去缩进机械化 diff 与基线逐行等价（纯观测 seam）; AG-UI 事件语义不变; 三态判定零框架私有 import; T14 4 minor 均真修
- 集成: cherry-pick 081f1c0d → d5173693（integration-main）；门禁复跑: typecheck 0、四文件 96 pass/0 fail
- 节点状态: T15 已验证并集成（15/37: T01–T11+T14+T15+T19+T32）

## T20 实现 worker_done + 0124 冲突记录（2026-10-15 19:13）
- ctx_c20cabe052f3 succeeded → opik-t20-w 提交 7ecd8b2b+8885a8d1（基于 04098a63，10 文件 +21312/-31）
- 要点: case-review 服务+路由（挂载契约留 T33+）、审计行、T19 三项加固落地（条件 UPDATE/DELETE 触发器/tiebreaker）
- 门禁（实现者报告）: typecheck 0 / 单测 36 / 集成 8（专用库 opik_t20_int）/ biome 0 / T19 套件回归 10 pass
- **冲突裁决**: T20 实际使用了迁移 0124，与 T34 brief 的「独占 0124」冲突——裁定 T20 保留 0124，T34 集成时重编号 0125（journal+snapshot+文件名+测试引用机械变换，或派 fix worker）; 记为调度失误（T20 brief 未声明迁移资源）
- 独立评审派发: ctx_2aa191d48fc6（opik-t20-rev，只读）

## T16 复审+集成（2026-10-15 19:14）
- 复审 ctx_c37fb1b0a7f0（opik-t16-rev2）: M-1/L-1/L-2 全 RESOLVED / 质量 APPROVE（独立复现 RED 验证）
- 集成: cherry-pick 93e12d8f+b833d36a → bac712a3+397382a4（integration-main）
- 门禁复跑: agent-langgraph typecheck 0 / bun test 54 pass 0 fail（需在其目录 bun install——独立包非 root workspace，node_modules 物化不改 tracked 文件，git status clean）
- 节点状态: T16 已验证并集成（16/37: T01–T11+T14+T15+T16+T19+T32）

## T17 dispatch（2026-10-15 19:2x）
- ctx_c48277d53643 / opik-t17-w / base integration-main@397382a4。brief 含 T15 4 low 收口; 迁移若需用 0125（0124 已归 T20）

## T12 僵尸处置（2026-10-15 19:2x）
- 原 dispatch ctx_4b35b27860ec: 转录取证显示「探针 3 次未发现工具，继续静默等待」（已知 Orca 子代理零工具故障，见 memory reference_subagent_tool_stripping），worktree opik-t12-w 零产出（git log 停在 4b253c41、无未提交改动）
- 处置: worker-stop ctx_4b35b27860ec（ok）→ --task task_c7ce38990f96 --retry-of 重派 → ctx_b3080a98d7d6（opik-t12-w2，base integration-main@397382a4）
- 运行中: T12retry ctx_b3080a98d7d6、T17 ctx_c48277d53643、T20rev ctx_2aa191d48fc6、T34 ctx_089ae4cc93d3

## T34 实现 worker_done（2026-10-15 19:19）
- ctx_089ae4cc93d3 succeeded → opik-t34-w 提交 970b89e1（基于 04098a63，14 文件 +21520/-2）
- 要点: export_jobs 表（迁移 0124——与 T20 冲突，已裁定重编号 0125 于修复轮）、租约+repeatAfterEach 调度、撤权 seam cancelForActor、reauthorize 重建 scope、产物 DB CHECK、T11 投影
- 门禁（实现者报告）: typecheck 0 / 单元+集成 26 pass（连跑 5 次稳定）/ biome 0 / opik 全族 12 文件 375 pass
- 遗留接线项（routes/boot/reauthorize/purge）待评审判定归属
- 独立评审派发: ctx_5ca072046995（opik-t34-rev，只读）

## T12 裁决（2026-10-15 19:22，msg_7c404e4a923d）
- 问题: T11 RunsListResult/RunSummary 缺 createdAt/行级 capability/syncing/服务端筛选，#18 AC 需要
- 裁决: B-lite——最小扩展 T11 wire（RunSummary+createdAt+capability、可选 timeFrom/timeTo/state 透传筛选、上游不支持 422 显式、syncing 列表级 metadata、游标不变）; T11 文件改动独立提交最小 diff; 不重构 T11; T11 测试保持绿+新字段补测试。理由: A 选项直接缺口 #18 自身 AC

## T20 评审（2026-10-15 19:24）
- ctx_2aa191d48fc6（opik-t20-rev，报告 6f42c7d0）: Spec PARTIAL / 质量 REQUEST-CHANGES
- C-1 Critical: 0124 DELETE 守卫 fail-open（current_setting NULL→IF false 不抛异常，全新连接可删版本行）; H-1: 集成测试依赖池连接残留 set_config 掩盖真洞; 3 Low（canary 口径/死分支/报告归因）
- 满足面: #26 五条主验收+加固 与达标
- 修复派发: ctx_a9ff0e35fae6（opik-t20-fix，C-1 两行修复+全新连接 RED 测试+H-1 会话卫生）

## T34 评审（2026-10-15 19:24）
- ctx_5ca072046995（opik-t34-rev）: Spec PASS / 质量 APPROVE（0 critical/high; 2 medium: enqueue 无数量上限+产物无保留策略、多副本并发为每副本语义 + 4 low）
- 接线遗留裁定: routes/boot/reauthorize/purge 属 T33/T32 接线票范围——**登记为 T33 验收项**（按 T34 报告 §6 兑现）
- 集成前置: 待 T20 修复+集成（保 0124）后，T34 重编号 0125（fix worker 机械变换+验证）再 cherry-pick
- T35 brief 预登记: 并入 T34 2 medium（enqueue 上限、产物保留策略; 多副本语义注记）

## T20 修复轮 worker_done（2026-10-15 19:36）
- ctx_a9ff0e35fae6 succeeded → opik-t20-fix 提交 9aa7adbb（8 文件 +190/-13）
- C-1: IS DISTINCT FROM 'on' 闭合 + 全新连接 RED→GREEN 测试（插桩证假绿机制 '' <> 'on'）; H-1: 两套集成 afterEach RESET 归一; 连带修复 T19 datasets 集成同源假绿（改 flag 事务清理）; L 三项齐
- 门禁: typecheck 0 / migrate ok / 46+10 pass / biome clean
- 增量复审派发: ctx_5ee7bb9a0680（opik-t20-rev2）

## T20 复审+集成（2026-10-15 19:42）
- 复审 ctx_5ee7bb9a0680（opik-t20-rev2）: C-1/H-1/L-1/2/3 全 RESOLVED / 质量 APPROVE（四象限 psql 实测、RED 独立复现、journal 归因独立复跑）
- 集成: cherry-pick 7ecd8b2b+8885a8d1+9aa7adbb → a5ced566+d501643d+01893e53; 门禁复跑 typecheck 0 / 专用库 opik_t20_int2 迁移 ok / 四套件 56 pass 0 fail
- 节点状态: T20 已验证并集成（17/37: T01–T11+T14+T15+T16+T19+T20+T32）
- 迁移序号分配登记: 0123 T19 / 0124 T20 / **0125 T34-renumber / 0126 T22**（后续按派发顺序分配并记此处）

## T34-rn/T22 dispatch（2026-10-15 19:4x）
- T34-rn: ctx_1331a5642983 / opik-t34-rn / base integration-main@01893e53 — cherry-pick 970b89e1 + 重编号 0124→0125（T20 保 0124）
- T22: ctx_883658c9b4e8 / opik-t22-w / base integration-main@01893e53 — 实验 schema 冻结配置，迁移 0126
- 运行中: T12retry ctx_b3080a98d7d6、T17 ctx_c48277d53643、T34-rn、T22

## T17 实现 worker_done（2026-10-15 19:47）
- ctx_c48277d53643 succeeded → opik-t17-w 提交 56bf3f58（23 文件 +22365/-17）
- 要点: traceparent 闭合+断链双层检测、id-links 表（其迁移号 0125 系 T17 brief 所写）、links 双向 seam、T15 4 low 收口、记录器/link store 装配待 run-association 激活
- 门禁（实现者报告）: server typecheck 0 / 单元 59 / 集成 10×2 轮 / agent-langgraph typecheck+57 / biome 零新增 / 邻接回归 259+20
- **迁移号冲突 2**: T17 的 0125 vs T34-rn 的 0125——裁定 T34-rn 保 0125，T17 集成准备轮重编号 0127（T22 已占 0126）。根因: T17 brief 写 0125 在先、0125 又分配给 T34-rn 在后，调度簿记失误
- 独立评审派发: ctx_7e4482cfb0a6（opik-t17-rev，只读）
- 迁移序号分配（更新）: 0123 T19 / 0124 T20 / 0125 T34 / 0126 T22 / 0127 T17

## T34-rn worker_done（2026-10-15 19:49）
- ctx_1331a5642983 succeeded → opik-t34-rn 提交 f3311a58（= 01893e53 + 970b89e1 重编号）; journal 126 行含 0125、二跑幂等、T20 0124 未触碰、export 26 pass、T20/T19 回归 19 pass
- 独立复核派发: ctx_d00312b0d716（opik-t34-ver，只读核重编号）

## T34 复核+集成（2026-10-15 19:51）
- 复核 ctx_d00312b0d716（opik-t34-ver）: PASS（journal 126 有序、snapshot 链正确、SQL sha256 一致、零残留引用、全新库 26/0）
- 集成: cherry-pick f3311a58 → 8435bb48; 门禁复跑 typecheck 0 / 专用库 opik_int_g2 迁移 ok / export+case-review 35 pass 0 fail
- 节点状态: T34 已验证并集成（18/37: T01–T11+T14+T15+T16+T19+T20+T32+T34）
- 集成期登记: T33 验收项须含 T34 报告 §6 接线清单（routes/boot/reauthorize/purge）; T35 brief 并入 T34 2 medium

## T12retry 实现 worker_done（2026-10-15 19:53）
- ctx_b3080a98d7d6 succeeded → opik-t12-w2 提交 57b76b23+254b0068+39219acc+cd61e704（15 文件 +1516/-87）
- 要点: B-lite 落地（shared/ai-observability-runs.ts 唯一契约源、422 显式拒绝、binding 可选 join）、前端列表页（游标栈分页/失效回首页/双语词表/XSS 纯文本渲染/unavailable 词汇）
- 门禁（实现者报告）: app+server typecheck 0 / bun test 22+51 / biome 无修复
- 遗留登记: createRunsQueryRoutes 挂载（T33 接线，port:null 诚实 503）; 服务端筛选待 port verified filter 后替换 422 seam
- 独立评审派发: ctx_aa4f2c7a96e9（opik-t12-rev，只读）
- 运行中: T22 ctx_883658c9b4e8、T17rev ctx_7e4482cfb0a6、T12rev

## T17 评审（2026-10-15 19:54）
- ctx_7e4482cfb0a6（opik-t17-rev）: Spec PASS / 质量 APPROVE（0 critical/high; 1 medium: 链路检测 verdict 丢弃+空 catch 静默; 2 low: unique_violation 判定、claimed 死分支+no-op 假覆盖测试; 2 info）
- 修复派发: ctx_a1ca944b4ec3（opik-t17-fix）
- 集成顺序裁定: T22 先落 0126，T17 重编号 0127 后集成（journal idx 需连续，不可跳号）
- 运行中: T22 ctx_883658c9b4e8、T12rev ctx_aa4f2c7a96e9、T17fix

## T22 裁决（2026-10-15 19:57）
- 问题: T22 基线 journal 顶 0124（派发早于 T34 0125 集成），指定 0126 跳号违反 journal 不变量
- 裁决: A——分支内用 0125，集成准备时重编号下一可用号（T34-rn 模式）; 拒绝 no-op 占位与接受 finding
- 迁移号实况: 集成分支 0124(T20)/0125(T34); T22 与 T17 集成时按到达顺序取 0126/0127

## T22 实现 worker_done（2026-10-15 19:59）
- ctx_883658c9b4e8 succeeded → opik-t22-w 提交 e72f9c8e（11 文件 +21493/-1）
- 要点: 单表双态 draft→frozen、FK 钉 dataset version+hash 复述、(scope,hash) 部分唯一索引幂等、审计 opik.experiment_submitted、698 行测试; 分支内迁移号 0125（裁决 A）
- 门禁（实现者报告）: typecheck/migrate/50+50 回归/biome 绿; journal 零新增 finding
- 独立评审派发: ctx_f04e24779c34（opik-t22-rev，重点: DELETE/UPDATE 守卫 IS DISTINCT FROM 模式、canonical hash 单源）
- 运行中: T12rev ctx_aa4f2c7a96e9、T17fix ctx_a1ca944b4ec3、T22rev

## T12 评审（2026-10-15 19:59）
- ctx_aa4f2c7a96e9（opik-t12-rev）: Spec PASS / 质量 APPROVE（0 critical/high; 2 medium: flaky 篡改游标测试 1/4096 自等、游标失效回首页无前端测试; 5 low）
- 修复派发: ctx_b5d0448f05bd（opik-t12-fix，连跑 100 次证明稳定）
- 运行中: T17fix、T22rev、T12fix

## T22 评审（2026-10-15 20:03）
- ctx_f04e24779c34（opik-t22-rev）: Spec PASS / 质量 APPROVE（2 low: 死码、draft hash 未锁空; golden hash 评审人独立复算匹配; 守卫 fail-closed 全新连接测试在）
- T22-rn 派发: ctx_4f877cdb53cb（opik-t22-rn，重编号 0126 + 2 Low 顺手修 + 全回归）
- 运行中: T17fix、T12fix、T22rn

## T17 修复轮 worker_done（2026-10-15 20:04）
- ctx_a1ca944b4ec3 succeeded → opik-t17-fix 提交 d54f1159+46cf43a3
- M-1 verdict/link 失败入 OpikWriteStats 治理计数（经 T09 健康快照、仅枚举标签）; L-1a onConflictDoNothing 去 target→divergent; L-1b claimed 激活+测试; L-2 重写为真实 observer 注册+RED 验证
- 门禁: typecheck 0 / migrate 幂等 / 71 pass / biome 零新增
- 增量复审派发: ctx_5b5c722a2c06（opik-t17-rev2）
- 运行中: T12fix、T22rn、T17rev2

## T17 复审（2026-10-15 20:08）
- ctx_5b5c722a2c06（opik-t17-rev2）: M-1/L-1a/L-1b/L-2 全 RESOLVED / 质量 APPROVE（独立复现 RED、71/71、copilot.ts 零 diff）
- 待集成: T22-rn 落 0126 后 T17-rn 重编号 0127 cherry-pick d54f1159 链

## T21 dispatch（2026-10-15 20:1x）
- ctx_4c1716c57bc0 / opik-t21-w / base integration-main@8435bb48（dep T02+T20 ✓）
- T33 顺序裁定: 待 T12fix/T22rn/T17rn 集成后统一派发（挂载契约一次收口，验收含 T34 §6 清单）
- 运行中: T12fix ctx_b5d0448f05bd、T22rn ctx_4f877cdb53cb、T21

## T12 修复轮 worker_done（2026-10-15 20:12）
- ctx_b5d0448f05bd succeeded → opik-t12-fix 提交 f52952a6（测试+注释 diff）
- M-1 flaky×2 修（自等缺陷+TTL 竞态，200/100 循环全绿）; M-2 前端 403/410 失效路径测试; L-1/L-3/L-5 修; L-2/L-4 留 T13
- 复核派发: ctx_ccc573d3e28f（opik-t12-ver，轻量）
- 运行中: T22rn、T21、T12ver

## T22-rn worker_done（2026-10-15 20:13）
- ctx_4f877cdb53cb succeeded → opik-t22-rn 两提交（0126 重编号+2 Low 修）; 0126 snapshot 合并 export_jobs（journal 不变量要求）; 127 迁移两跑幂等; 65/65
- 复核派发: ctx_267598543685（opik-t22-ver）
- 运行中: T21、T12ver、T22ver

## T12 集成（2026-10-15 20:2x）
- cherry-pick 57b76b23..f52952a6 → 7f6f90d9..06156175; 冲突 1 处（queries/runs.ts: T34 export projectRow × T12 capability 参数）合并保留两者
- 集成追平 2 提交: 0136e1c0（exports.ts map 调用点显式传 row，防 index 漏入 capability）+ 测试同修（01256175 后）; 全因 rows.map(projectRow) 的 map-index 陷阱
- 门禁: server typecheck 0 / 专用库 opik_t12_int 77 pass 0 fail / app typecheck 0 / runs-list 15 pass
- 教训记录: 重复 for-loop cherry-pick 已完成序列会制造 AA 假冲突——abort 即净; bun 管道后 \$? 是 tail 的
- 节点状态: T12 已验证并集成（19/37: T01–T12+T14+T15+T16+T19+T20+T32+T34）

## T22-rn 复核（2026-10-15 20:19）
- ctx_267598543685（opik-t22-ver）: PASS（journal 链 127 条、SQL 逐行 diff 仅编号+CHECK、snapshot 合并逐字节核对、全新库 56/56）
- 遗留 1 Low: schema check() 表达式漏同步（drizzle-kit generate 会回退约束）→ 微修复派发 ctx_edf187720c0f（opik-t22-fx2）
- 运行中: T21、T13、T22fx2

## T22 集成（2026-10-15 20:30）
- cherry-pick 187637af+2dc8a0f5+dca7fd98 → 0b0f17dc+c38967a2+9763b798; journal 至 0126（127 条）
- 门禁: typecheck 0 / 专用库 opik_t22_i2 迁移 ok / 43 pass 0 fail
- 节点状态: T22 已验证并集成（20/37: T01–T12+T14+T15+T16+T19+T20+T22+T32+T34）
- 迁移号分配更新: 0127 T17-rn / 0128 T23(如需) / 0129 T35(如需) / 0130 T26(如需)

## T23/T26/T35 + T17-rn dispatch（2026-10-15 20:3x）
- T17-rn: ctx_5ab3a0bcda7f（0127 重编号+cherry-pick 56bf3f58..46cf43a3，重点 queries/runs.ts+bindings.ts 手工合并）
- T23: ctx_b1ed3ab8e3b3（隔离执行+生产写工具拒绝，迁移如需 0128）
- T26: ctx_2e34e50c8b32（规则评分器纯函数，尽量无迁移）
- T35: 已派发（回执尾段截断，dispatch id 待下轮 check 核对; 迁移如需 0129; 含 T34 2 medium 加固）
- 运行中: T21、T13、T17rn、T23、T26、T35

## T13 实现 worker_done（2026-10-15 20:41）
- ctx_4bd325afbca2 succeeded → opik-t13-w 提交 7595fabd（10 文件 +968/-39; T12 L-2 形状防御+L-4 键清理一并落）
- 门禁（实现者报告）: app typecheck 0 / 40/40 前端 / biome / server typecheck 0 / 51/51 邻接
- 独立评审派发: ctx_067428b964ce（opik-t13-rev）
- 运行中: T21、T17rn、T23、T26、T35、T13rev

## T35 重复派发处置（2026-10-15 21:0x）
- 首次派发输出非纯 JSON 致解析误报失败，实际成功（ctx_ed3d85ed3b9a/opik-t35-w）; 重试又派发一个（ctx_a1994533ec1c/opik-t35-w-2，orca 自动 -2 后缀）
- 处置: worker-stop ctx_a1994533ec1c，保留首派发。教训: worker-start 输出解析失败≠派发失败，先 worker-list/inbox 核实再重试

## 429 限流事故与续接重派（2026-10-16 会话重建后）

- 前次会话 2026-10-15 21:1x 因上游 Claude 5 小时限额触顶（429，限额 04:55 重置）中止：6 个在途 worker 全部死于限流，均未 worker_done。证据: worker-read 转录尾部（T13rev 终点为显式 429 system error；其余终点为 12h+ 无新记录的中途 assistant/reasoning，无 settlement）。
- 处置: worker-stop ×6 + 连同 T35-w-2/T12 僵尸共 8 个 worker-release（worktree 与 WIP 全部保留）。reclaimable=0。
- 实况快照: T17-rn 4 提交干净（fe9118a0/265d5a13/f17bbd12/7f403237，renumber 0127 完成，缺报告与门禁复跑）; T13rev 零产出; T21 13 文件 WIP; T23 11 文件 WIP（0128）; T26 2 路径 WIP; T35 7 文件 WIP（0129）。
- 重派（同 Task --retry-of，精确 worktree 选择器复用原工作区，agent=claude）:
  | 任务 | 旧 | 新 Dispatch | worktree |
  |---|---|---|---|
  | T13 独立评审 | ctx_067428b964ce | ctx_a37dce0e631b | opik-t13-rev |
  | T17-rn 续完 | ctx_5ab3a0bcda7f | ctx_6bde0820872b | opik-t17-rn |
  | T21 续完 | ctx_4c1716c57bc0 | ctx_d26f2d465d19 | opik-t21-w |
  | T23 续完 | ctx_b1ed3ab8e3b3 | ctx_65b3e22e508c | opik-t23-w |
  | T26 续完 | ctx_2e34e50c8b32 | ctx_ce8843fae64f | opik-t26-w |
  | T35 续完 | ctx_ed3d85ed3b9a | ctx_785006c66b69 | opik-t35-w |
- 六个 worker 均已发送续接说明（前次死因+WIP 清单+不要重做已完成部分）。
- 已集成不变: 20/37（T01–T12+T14+T15+T16+T19+T20+T22+T32+T34）。下一波: T13/T17 集成后 → T18、T33; T23 后 → T24; T26 后 → T28。

## T17-rn 重试完成 + T17-ver 派发（2026-10-16）
- 重试 ctx_6bde0820872b succeeded: 保留前次 4 提交（fe9118a0/265d5a13/f17bbd12/7f403237），新增 21d397b2（biome 3 处清理）+ 7c96e243（renumber-report）+ dbafa553（镜像到 T17-rn/）。验证: journal 0127.prevId=0126.id、0126 表在 0127 snapshot 逐字节一致、零 0125_opik_id_links 残留、专用库 opik_t17_rn 128/128+幂等、T17+T12 测试 110/110、server+agent-langgraph typecheck（57/57）、biome 改动文件 clean。预存基线问题（journal 7 远古失败、copilot.ts biome 债）在 9763b798 复现确认，非本票引入。已释放。
- T17-ver 独立复核派发: ctx_f975946fa819 / task_2d7da83fc688 / worktree opik-t17-ver ← 1123786563/opik-t17-rn（dbafa553）。七项清单: journal 链/SQL diff+sha256/snapshot 合并/零残留/三方合并语义/全新库 opik_t17_ver 迁移+测试/ver-report。
- 运行中: T13rev ctx_a37dce0e631b、T21 ctx_d26f2d465d19、T23 ctx_65b3e22e508c、T26 ctx_ce8843fae64f、T35 ctx_785006c66b69、T17ver ctx_f975946fa819。

## T13 评审完成 + 修复轮派发（2026-10-16）
- T13rev（重试 ctx_a37dce0e631b）succeeded: 报告 216bbd3f。四门禁复跑绿（app/server typecheck 0、前端 31、server 39、i18n parity+路由守卫 9）。结论: Spec PARTIAL / 质量 REQUEST-CHANGES。#19 七项主验收+L-4 全 PASS; 缺口=T12 L-2 深度: present-缺-metadata 与越权 state 两子类崩溃到路由错误页而非 unavailable 态（Q-M1 medium）+ nextCursor 缺失放行 undefined（low）。已释放。
- T13-fix 派发: ctx_1ea38f95b514 / task_4c8302a84c92 / opik-t13-fix ← 1123786563/opik-t13-w@7595fabd。修 Q-M1+Q-L+两例畸形 RED→GREEN 测试。
- 运行中: T21 ctx_d26f2d465d19、T23 ctx_65b3e22e508c、T26 ctx_ce8843fae64f、T35 ctx_785006c66b69、T17ver ctx_f975946fa819、T13fix ctx_1ea38f95b514。

## T23/T26 实现 worker_done + 双评审派发（2026-10-16）
- T23（重试 ctx_65b3e22e508c）succeeded: f8a9920e。迁移 0128 执行表（五词状态机 CHECK）、T34 租约 worker（reauthorize 复检/条件 settle/撤销必赢）、工具拦截门三重 fail-closed、billing precheck 402、readOnlyTools 冻结 golden hash。实现者修两处测试侧缺陷（投影 envelope 语义、sweep 5s→30s 超时）。门禁: typecheck 0/全新库 128 条/52 pass 复跑同绿/biome 0。T24 runner 与 T25 结算经注入 seam 留待。已释放。
- T26（重试 ctx_ce8843fae64f）succeeded: 6f3b5fac。scoring/rules.ts 纯函数（extractRuleSet 深冻、scoreRunOutput 确定性、5 算子、失败三分类不冒充 0 分、无迁移）。修 WIP 矛盾测试数据+SafeValue/SafeText 收窄。门禁: 22/22、biome 0、typecheck 0。已释放。
- T23-rev 派发: ctx_2dbba6a3ccc3 / opik-t23-rev ← opik-t23-w@f8a9920e（重点: 0128 迁移、三重 fail-closed 不可绕过、租约并发语义、golden hash 复算、两处测试修正未掩盖缺陷）。
- T26-rev 派发: ctx_22acbe4a8d9e / opik-t26-rev ← opik-t26-w@6f3b5fac（重点: 纯函数性、算子边界、失败分类穷尽、T22 契约、对抗用例≥6 组）。
- 运行中: T21 ctx_d26f2d465d19、T35 ctx_785006c66b69、T17ver ctx_f975946fa819、T13fix ctx_1ea38f95b514、T23rev、T26rev（6 个）。

## T21 实现 worker_done + 评审派发（2026-10-16）
- T21（重试 ctx_d26f2d465d19）succeeded: fec2ea39（13 文件，基线 8435bb48 早于 T22 集成——集成时注意冲突处置）。前次 WIP 已完整，本次逐字段核验契约镜像+全门禁复算（typecheck 0、biome 0、目标 24/24、全量 1217/1240→负载回落后 81/81）。已释放。
- T21-rev 派发: ctx_79c684089406 / opik-t21-rev ← opik-t21-w@fec2ea39（重点: 契约镜像独立 diff、页面约定、渲染安全、23 失败归因抽查）。
- 运行中: T35 ctx_785006c66b69、T17ver ctx_f975946fa819、T13fix ctx_1ea38f95b514、T23rev ctx_2dbba6a3ccc3、T26rev ctx_22acbe4a8d9e、T21rev ctx_79c684089406（6 个）。

## T17-ver PASS + T17 集成 + T33 派发（2026-10-16）
- T17-ver（ctx_f975946fa819）七项全 PASS: journal 128 有序、0127 SQL 与源 0125 逐字节一致（sha256 967a179d）、snapshot 165 表+id_links 且 0126 与 BASE 字节一致、零残留、runs.ts/bindings.ts 合并逐行核验（63 行纯叠加）、全新库 opik_t17_ver 128+幂等+110/0/445、agent-langgraph 3/0。报告 16f51b0a。已释放。
- **T17 集成**: cherry-pick 9763b798..dbafa553（7 提交）→ integration-main bf3286ab，零冲突。门禁: typecheck 0、专用库 opik_t17_int 迁移 ok+幂等、id-links/trace-chain/runs-query/bindings 79/0/213、export 15/0/40、case-review 19/0/75、app runs-list 15/0/77。**T17 节点: 已验证并集成（21/37: T01–T12+T14+T15+T16+T17+T19+T20+T22+T32+T34）**。
- T33 派发: ctx_2b379a1714e8 / task_05945c15314d / opik-t33-w ← integration-main@bf3286ab。Part1=Issue #39 管理汇总 API（三态区分、scope 先行、旁路）; Part2=接线清单（T34 §6: exports 路由挂载/export worker boot/reauthorize seam/cancelForActor/work_items purge + T12 createRunsQueryRoutes 挂载 + T17 link store 装配）。
- 运行中: T35 ctx_785006c66b69、T13fix ctx_1ea38f95b514、T23rev ctx_2dbba6a3ccc3、T26rev ctx_22acbe4a8d9e、T21rev ctx_79c684089406、T33 ctx_2b379a1714e8（6 个）。

## T23-rev PASS + T23 集成 + T24 派发（2026-10-16）
- T23-rev（ctx_2dbba6a3ccc3）: Spec PASS / 质量 APPROVE（0 critical/high; 2 low: 取消无 settle 审计、审计 payload 工具名未投影 → 并入 T24 brief; 7 info 多为 T34 同形状）。门禁独立复算（独立库 opik_t23_rev 128 条、52/0、golden hash 444df837 复算一致、撤销/租约 interleaving 推演必赢）。报告 a3936cd1。已释放。
- T23 集成（含机械合并）: T23 分支 journal 有 idx 跳号（126→128，tag 0128），cherry-pick f8a9920e 冲突仅 _journal.json——手工合并保留 0127(T17)+0128(T23)（journal 129 条连续）; 0128_snapshot prevId 改指 0127.id（3ba2690b）并入 ai_observation_id_links 表（167 表），共享表程序化 diff 零漂移。→ integration-main f2142cf5。门禁: 专用库 opik_t23_int 迁移+幂等、executions 31/0/88、id-links/export/case-review 回归 60/0/184、typecheck 0。**T23 节点: 已验证并集成（22/37: T01–T17+T19+T20+T22+T23+T32+T34）**。
- T24 派发: ctx_2279dab7540f / opik-t24-w ← integration-main@f2142cf5。有界并发+重授权+取消/lease+双 worker 认领; 并入 T23-rev 2 low; 生产 runner 落地、计费透传 T25 seam。
- 运行中: T35 ctx_785006c66b69、T13fix ctx_1ea38f95b514、T26rev ctx_22acbe4a8d9e、T21rev ctx_79c684089406、T33 ctx_2b379a1714e8、T24 ctx_2279dab7540f（6 个）。

## T26-rev + T35 实现 worker_done（2026-10-16）
- T26-rev（ctx_22acbe4a8d9e）: 六重点全核验（纯函数/失败分类穷尽/T22 契约/SafeValue 收窄），22 对抗用例按分类作答。findings: 1 medium（json_path 断言不校验 expected 类型，隐式转换可错判 passed）、2 low（Number 宽松解析; 回溯墙上时间已文档化移交）、5 info; 无 critical/high 不阻塞。报告 c2da4345。已释放。
- T35（重试 ctx_785006c66b69）succeeded: d91ca44a。retention 核心（策略折叠/有界幂等发现/T34 租约 worker/上游同步状态机/旗标本地删除/审计治理计数）、port+http 删除契约扩展、0129 迁移三件套、T34 两 medium 加固+多副本防双删; 修 3 实现+4 测试缺陷。门禁: typecheck 0/专用库 opik_t35_int 迁移/29+16 测试/biome 0（最终在 5547 复验; 调试私有容器 opik-t35-pg@5549 保留供复核）。挂载接线按 T33 模式后置。已释放。
- T26-fix 派发: ctx_363fe3d87638 / opik-t26-fix ← opik-t26-w@6f3b5fac（M-1 类型校验+L-1 严格解析，RED→GREEN）。
- T35-rev 派发: ctx_65a4850d3606 / opik-t35-rev ← opik-t35-w@d91ca44a（重点: 删除链真实性、T34 加固复核、0129 三件套、门禁 5547 复算）。
- 运行中: T13fix ctx_1ea38f95b514、T21rev ctx_79c684089406、T33 ctx_2b379a1714e8、T24 ctx_2279dab7540f、T26fix ctx_363fe3d87638、T35rev ctx_65a4850d3606（6 个）。

## T21-rev 通过 + T21 集成（2026-10-16）
- T21-rev（ctx_79c684089406）: 契约镜像逐字段独立 diff 一致; #27 四验收+A4/A5/A7 前端面成立; 门禁复算 typecheck 0/24 pass/biome 0; 4 个超时失败单独复跑 11/0 证实过载归因。5 Minor（键数自述不准/注释前瞻 runs.ts/syncing+truncated 无测试钉住/pending 标题闪变）→ syncing/truncated 钉住与标题闪变并入 T30 brief。报告 4b947d5f。已释放。
- **T21 集成**: cherry-pick fec2ea39 零冲突 → integration-main（基线 8435bb48 → f2142cf5 之上，app 文件与 T12/T17/T23 无碰撞）。门禁: app typecheck 0、datasets 15/0/57、routes+i18n 17/0/65。**T21 节点: 已验证并集成（23/37: T01–T17+T19+T20+T21+T22+T23+T32+T34）**。
- 运行中: T13fix ctx_1ea38f95b514、T33 ctx_2b379a1714e8、T24 ctx_2279dab7540f、T26fix ctx_363fe3d87638、T35rev ctx_65a4850d3606（5 个）。

## T26-fix worker_done + 增量复审派发（2026-10-16）
- T26-fix（ctx_363fe3d87638）succeeded: e8556e2c。M-1 json_path 按 assert 类型校验（contains→string/gt 族→finite number/equals→primitive，不符 RULE_SYNTAX_INVALID）; L-1 JSON 数值文法严格化; L-2 仅确认文档（rules.ts:46）。RED 22/3→GREEN 25/0、biome 0、typecheck 0、版本 bump 2。已释放。遗留 L-2 墙钟硬杀归 T23/T24 编排器（并入后续 brief 时注意）。
- T26-rev2 增量复审派发: ctx_17268fa324d8 / opik-t26-rev2 ← opik-t26-fix@e8556e2c（只审单提交 diff，对抗用例独立自创）。
- 运行中: T13fix ctx_1ea38f95b514、T33 ctx_2b379a1714e8、T24 ctx_2279dab7540f、T35rev ctx_65a4850d3606、T26rev2 ctx_17268fa324d8（5 个）。

## T35-rev 完成 + 修复轮派发（2026-10-16）
- T35-rev（ctx_65a4850d3606）: 删除证据链全部成立（契约与 T04 语义逐字段一致、pre-I/O 拒绝、四 interleaving 不双删不漏删、0129 链正确、7 处修正无掩盖）; 门禁独立复算（opik_t35rev 库 29+16、biome 0）。findings: 1 Medium（AC1 复合条款「撤销可见性/停止任务/失效缓存」部分未交付且未声明）+5 Low（不续租/work_items 无 purge/本地失败重放上游/无永久保留出口/报告计数 13→14）+6 Info。报告 3a8e1f4c。已释放。
- T35-fix 派发: ctx_60202a0a646e / opik-t35-fix ← opik-t35-w@d91ca44a。M-1 删除前置序（或 seam+显式声明）+逐 Low 处置。
- 登记: T35 的 retention work_items purge 与 L1/L2 接线扩展并入 T33 集成后的接线收口（T33 已在跑，T35 未集成不阻断）。
- 运行中: T13fix ctx_1ea38f95b514、T33 ctx_2b379a1714e8、T24 ctx_2279dab7540f、T26rev2 ctx_17268fa324d8、T35fix ctx_60202a0a646e（5 个）。

## T13-fix worker_done + 增量复审派发（2026-10-16）
- T13-fix（ctx_1ea38f95b514）succeeded: 4f822adf（4 RED）+bcdec14d（修复全落 runs.ts 查询边界: present 缺 payload/nextCursor 缺失→unavailable fault; 越权 state→coerce unknown）+fix-report。门禁: 双 typecheck 0、35/35、server 39/39、biome 0; 4 例全量失败经基线对照证实预存 flake。已释放。
- T13-rev2 派发: ctx_134ec7ef8668 / opik-t13-rev2 ← opik-t13-fix。通过后集成 T13 → 解锁 T18。
- 运行中: T33 ctx_2b379a1714e8、T24 ctx_2279dab7540f、T26rev2 ctx_17268fa324d8、T35fix ctx_60202a0a646e、T13rev2 ctx_134ec7ef8668（5 个）。

## T26-rev2 REQUEST-CHANGES + fix2 派发（2026-10-16）
- T26-rev2（ctx_17268fa324d8）: M-1 RESOLVED（对抗变体验证+RED 重放复演属实）; 但 L-1 修复引入 M-2 新回归: parseStrictNumber 丢 Number.isFinite 门，'1e400'/400 位串→Infinity 错误 passed。总评 REQUEST-CHANGES。报告 b40f9aa6。已释放。
- T26-fix2 派发: ctx_73687b9f9882 / opik-t26-fix2 ← opik-t26-fix@e8556e2c（一行 finite 门+三方向 RED+结构化对称用例）。
- 运行中: T33 ctx_2b379a1714e8、T24 ctx_2279dab7540f、T35fix ctx_60202a0a646e、T13rev2 ctx_134ec7ef8668、T26fix2 ctx_73687b9f9882（5 个）。

## Orca 重启处置 + T13 集成 + T26fix2/T18/rev3（2026-10-16）
- Orca 重启（runtime 58ad49b0→604a1580）: T13rev2 的 worker_done 于中断前送达（Spec PARTIAL→PASS、Code RC→APPROVE，报告 2ddcb3b6，9 组对抗自创用例）。T35-fix 死于 ECONNRESET（转录终点 system 错误，零产出）→ stop+release+同 worktree 重试 ctx_d6b14cf754aa。T33/T24 重启后存活（转录 49s/43s 前仍在推进）。T26-fix2 已结算 succeeded（commit 1703f258+fix2-report 完整）。
- **T13 集成**: 首次 cherry-pick 误用范围 7595fabd..ff3648b4 漏掉实现提交 → abort+reset 重做 7595fabd^..ff3648b4（4 提交: b68124f5/1e187136/3a468cdb/cf4b7f6d）。冲突 2 处: i18n test 注释合并（runs 链+datasets 链双事实）; runs-list.test 追加 L-2/Q-L 用例。合并后 runs.ts/run-detail.test/runs-list.test 与评审版逐字节一致。门禁: app typecheck 0、52/0/228（detail+list+routes+datasets）。**T13 节点: 已验证并集成（24/37: T01–T17+T19–T23+T32+T34，即原 23+T13）**。
- T18 派发: ctx_265d39c96afc / opik-t18-w ← integration-main@cf4b7f6d。步骤树 UI（三态渲染、fail-closed、i18n 对称）; 并入 T15 前端两 low、T21 syncing/truncated 钉住（如相邻）。
- T26-rev3 派发: ctx_0119da530268 / opik-t26-rev3 ← opik-t26-fix2@1703f258（只审 fix2 diff）。
- 教训: cherry-pick 范围 X..Y 排除 X 本身; 实现票集成须含基提交。
- 运行中: T33 ctx_2b379a1714e8、T24 ctx_2279dab7540f、T35fix(retry) ctx_d6b14cf754aa、T18 ctx_265d39c96afc、T26rev3 ctx_0119da530268（5 个）。

## T26-rev3 通过 + T26 集成 + T28 派发（2026-10-16）
- T26-rev3（ctx_0119da530268）: M-2 RESOLVED（对抗用例含 MAX_VALUE 边界/下溢/舍入边界; e8556e2c 旧版重放复现 M-2 现场）; 门禁复算 26/0/193、biome/tsc 0; 报告声明与代码逐项一致。报告 be17b449。已释放。
- **T26 集成**: cherry-pick 6f3b5fac^..be17b449（4 提交: 163111af/af87d957/d5ae1fcd/bf5bac8d）零冲突。门禁: typecheck 0、26/0/193、biome clean。**T26 节点: 已验证并集成（25/37: T01–T17+T19–T23+T26+T32+T34）**。
- T28 派发: ctx_ceb1f1b0b41f / opik-t28-w ← integration-main@bf5bac8d。逐样本结果+失败五分类+均值不掩盖+scope 对抗+回链校验; json_path 叶子上溢消费侧防御。
- 运行中: T33 ctx_2b379a1714e8、T24 ctx_2279dab7540f、T35fix ctx_d6b14cf754aa、T18 ctx_265d39c96afc、T28 ctx_ceb1f1b0b41f（5 个）。

## T24 实现 worker_done + 评审派发（2026-10-16）
- T24（ctx_2279dab7540f）succeeded: f08e5608。0129 写前结果表（in_flight+条件落定+四词状态机 CHECK）、逐样本 reauthorize、续跑跳过已完成、接管 in_flight→unknown 不重复调用、settle 持久行组装; 并入 T23-rev L-1（cancelExecutionsForActor+settle 审计）/L-2（projectSafeName）; 生产 case runner（单轮受控网关+T25 seam 仅接口）。门禁: typecheck 0/全新库 130 条/129 测试含并发用例/biome 0。已释放。
- 迁移号登记: 0129 已被 T24 占用（集成主线）; T35 分支本地 0129 集成时重编号 0130。
- T24-rev 派发: ctx_b2667cb5bd27 / opik-t24-rev ← opik-t24-w@f08e5608。
- 运行中: T33 ctx_2b379a1714e8、T35fix ctx_d6b14cf754aa、T18 ctx_265d39c96afc、T28 ctx_ceb1f1b0b41f、T24rev ctx_b2667cb5bd27（5 个）。

## T33 实现 worker_done + 评审派发（2026-10-16）
- T33（ctx_2b379a1714e8）succeeded: b716b1e0。admin/summary API（scope 先行/五状态/T13 词汇/显式 null/无迁移）+ Part2 全接线（exports+runs 路由挂载、export worker boot+reauthorize+manifest 验证 OpikPort、cancelForActor 接 people-revoke 与 §9 deletion shutdown、opik.export reaper）。门禁: typecheck 0、25+164+602 测试 0 fail、biome 0（专用库 opik_t33_int）; 两个预存失败先在 pristine HEAD 复现后修复。报告含 RED→GREEN+逐项接线清单。已释放。
- T33-rev 派发: ctx_605a682cbfce / opik-t33-rev ← opik-t33-w@b716b1e0（重点: scope 对抗、接线逐项、T17 link store 装配落地核对、预存修复质量）。
- 运行中: T35fix ctx_d6b14cf754aa、T18 ctx_265d39c96afc、T28 ctx_ceb1f1b0b41f、T24rev ctx_b2667cb5bd27、T33rev ctx_605a682cbfce（5 个）。

## T24-rev PASS + T24 集成 + T25 派发（2026-10-16）
- T24-rev（ctx_b2667cb5bd27）: Spec PASS / Code APPROVE。interleaving 逐场景无双调用/双扣费路径; WAL 三层咬合+逐样本 reauthorize+四词/五词机隔离+L-1/L-2+T25 seam 诚实全核实; 门禁独立复算（opik_t24rev 库 130 迁移、129 测试、biome 0）。findings: 1 Low（报告 §4 \"bad name!\" 证据位置标注失实，实际在 redaction 单测——T37 证据核验时注意）+4 Info。报告 58ff5b31。已释放。
- **T24 集成**: cherry-pick f08e5608 零冲突 → 15264555; journal 130 条（0129 落位）。门禁: 专用库 opik_t24_int 迁移+幂等、typecheck 0、execution 三套件 45/0/129、export/id-links/experiments 回归 51/0/146。**T24 节点: 已验证并集成（26/37: T01–T17+T19–T24+T26+T32+T34）**。
- T25 派发: ctx_063aa1f054e1 / opik-t25-w ← integration-main@15264555。计费准入+结算幂等（复用 billing 域、缺 usage 非 0、调用前拒绝、重放不重扣）。
- 运行中: T35fix ctx_d6b14cf754aa、T18 ctx_265d39c96afc、T28 ctx_ceb1f1b0b41f、T33rev ctx_605a682cbfce、T25 ctx_063aa1f054e1（5 个）。

## T33-rev PASS + T33 集成 + T36 派发（2026-10-16）
- T33-rev（ctx_605a682cbfce）: Spec PASS / Code APPROVE。五验收+A 映射成立; §4 接线六项逐一核验（worker boot manifest 冒烟复跑）; 两个顺手修独立复现预存; 门禁专用库复算一致。3 Minor（时间窗语义未入报告/admin 枚举串行放大/listBots 静默空列表——页面侧收口并入 T36）+6 Info。报告 6f6973aa。已释放。
- **T33 集成**: cherry-pick b716b1e0 零冲突; journal 仍 130（无迁移属实）; 门禁: typecheck 0、admin-summary+export+runner+runs-query 86/0/256。**T33 节点: 已验证并集成（27/37: T01–T17+T19–T24+T26+T32+T33+T34）**。
- T36 派发: ctx_53a6daecf133 / opik-t36-w ← integration-main（T33 后）。管理员汇总页+导出状态页（双语/键盘/窄屏/深链越权/三态区分）; 并入 T33-rev 3 Minor 页面侧收口。
- 运行中: T35fix ctx_d6b14cf754aa、T18 ctx_265d39c96afc、T28 ctx_ceb1f1b0b41f、T25 ctx_063aa1f054e1、T36 ctx_53a6daecf133（5 个）。
- 剩余未集成: T18 T25 T28 T35 T36（运行中）+ T27 T29 T30 T31 T37（未开始; T27 等 T25; T29 等 T28; T30 等 T28; T31 等 T29+T30; T37 终验）。

## T35-fix worker_done + rev2 派发（2026-10-16）
- T35-fix（重试 ctx_d6b14cf754aa）succeeded: fa00ee65。M-1 三步删除前置序落地（notPendingDeletion 四读者路径/cancelForScope 沿 T34 seam/invalidateReads seam+声明 T33 接线）; RED→GREEN 3 例; L5 修、L1/L3/L4 声明、L2 移交 T33; 零新迁移。门禁: 5547 新库 opik_t35fix、typecheck 0、241/1（唯一失败经基线复验为 T22 0126 FK 挡 T19 datasets 回滚的既有失败）、biome 0。已释放。
- T35-rev2 派发: ctx_5b214cb1bb27 / opik-t35-rev2 ← opik-t35-fix@fa00ee65。
- 登记: T35 集成时 0129→0130 重排 + fix-report §5 移交清单（invalidateReads/purge/renew 接线、datasets 回滚用例修正）需后续小接线票（T33 已集成，不能重开——建 T35-wire 小票）。
- 运行中: T18 ctx_265d39c96afc、T28 ctx_ceb1f1b0b41f、T25 ctx_063aa1f054e1、T36 ctx_53a6daecf133、T35rev2 ctx_5b214cb1bb27（5 个）。

## T35-rev2 通过 + T35 集成 + T35-wire 派发（2026-10-16）
- T35-rev2（ctx_5b214cb1bb27）: M1 全 RESOLVED（notPendingDeletion 对 fresh 连接读者隐藏、cancelForScope 五 interleaving 终态不可侵犯、invalidate 键逐字一致）; RED 独立复现（3 fail 全新用例）; 预存失败基线坐实; L1-L5 处置一致; 门禁 563/1 仅预存。报告 0645bbeb。已释放。
- **T35 集成（重排 0129→0130）**: cherry-pick d91ca44a+fa00ee65+两评审报告（846ae69e/094f937f）。冲突 3: audit.ts 双枚举并存（experiment_execution_settled+retention_deleted）; journal 保 T24 0129（idx 129）+T35 重排 0130（idx 130）; 0129_snapshot 双加冲突→T24 版保留、T35 两 retention 表并入新 0130_snapshot（170 表、prevId=bcbee236）。**journal when 严格递增被 0130 分支旧时间破坏→migration-runner 拒绝; 修 when=1792127022977（+1）单独提交。** 门禁: 专用库 opik_t35_int2 迁移 131 条+幂等、typecheck 0、retention+export+executions 68/0/250。**T35 节点: 已验证并集成（28/37: T01–T17+T19–T24+T26+T32+T33+T34+T35）**。
- T35-wire 派发: ctx_45321dae4ccf / opik-t35-wire ← integration-main。invalidateReads 接 RunsQueryService、retention work_items purge、renew 核对、修 datasets 回滚既有失败。
- 运行中: T18 ctx_265d39c96afc、T28 ctx_ceb1f1b0b41f、T25 ctx_063aa1f054e1、T36 ctx_53a6daecf133、T35wire ctx_45321dae4ccf（5 个）。

## T28/T18 实现 worker_done + 双评审派发（2026-10-16）
- T28（ctx_ceb1f1b0b41f）succeeded: 34217017。结果查询服务+REST 契约（routes/results.ts 挂载契约未接线——T30 集成时挂载）、七类失败分类封闭、均值仅 scored+显式基数排除数、scope 对抗（伪造/猜测/跨 scope/跨 epoch/跨实验回链）、settleCompleted 逐 case 投影精化; 零迁移。门禁: typecheck 0、专用库 136/136、biome 0。已释放。
- T18（ctx_265d39c96afc）succeeded: 52882a14。RunStep wire 契约+steps 查询边界守卫（Q-M1 式/词汇漂移 fail-closed/A3 不变量）+步骤树组件（嵌套/时序/断链保根/三态/检索摘要/i18n parity）; 20 新用例 RED(18)→GREEN、85+39 绿、biome 0。**重要披露: 集成分支无服务端 span 读回 seam（OpikOperation 无读操作，需 T04 式验证证据），纯前端钉契约，服务端留后续票**。T15 4 low 核实已在 T17 收口。已释放。
- T28-rev 派发: ctx_0dab575baf15 / opik-t28-rev ← opik-t28-w@34217017。
- T18-rev 派发: ctx_bb72069ed50e / opik-t18-rev ← opik-t18-w@52882a14（含 T18-server 后续票建议裁决）。
- 登记: T30 brief 须含 routes/results.ts 挂载; T18-server 票待 T18-rev 裁决。
- 运行中: T25 ctx_063aa1f054e1、T36 ctx_53a6daecf133、T35wire ctx_45321dae4ccf、T28rev ctx_0dab575baf15、T18rev ctx_bb72069ed50e（5 个）。

## T25 实现 worker_done + 评审派发（2026-10-16）
- T25（ctx_063aa1f054e1）succeeded: 4e2a807a。execution-billing.ts: 预留先于网关调用（fail-closed 402）、usage 经既有 outbox+credits 精确结算、未知成本保 hold+证据行不当 0、幂等键沿 T24 自然键（重放/接管不双扣）、实现 T23 ExecutionBudgetPrecheck; 零迁移。门禁: 8/8 新套件+53/53 邻接+credits 150/150×3、typecheck 0、biome 0、专用库 130 条。一次时序 flake 已披露待归因核验。boot 装配与 HTTP 面留接线票; T27 Judge 复用同 seam。已释放。
- T25-rev 派发: ctx_77f7ec08655b / opik-t25-rev ← opik-t25-w@4e2a807a（资金语义最高谨慎度）。
- 运行中: T36 ctx_53a6daecf133、T35wire ctx_45321dae4ccf、T28rev ctx_0dab575baf15、T18rev ctx_bb72069ed50e、T25rev ctx_77f7ec08655b（5 个）。

## T36 实现 worker_done + 评审派发（2026-10-16）
- T36（ctx_53a6daecf133）succeeded: 75cc28af。管理员汇总页（T33 消费/五因 readiness/无旁路）+导出状态页（T34 消费/五状态闭合词汇/撤权翻转无陈旧）; T33-rev 3 Minor 收口; visibilitychange 环境发现已披露。门禁: 27+86/0、双 typecheck 0、biome 0、无迁移; RED→GREEN 在报告 §5。导出发起 UI/控制台入口按边界留场（报告 §3）。已释放。
- T36-rev 派发: ctx_2411757ed191 / opik-t36-rev ← opik-t36-w@75cc28af（重点: 键盘/窄屏抽查、深链越权、visibilitychange 归因、AC4 覆盖度）。
- 运行中: T35wire ctx_45321dae4ccf、T28rev ctx_0dab575baf15、T18rev ctx_bb72069ed50e、T25rev ctx_77f7ec08655b、T36rev ctx_2411757ed191（5 个）。

### 2026-10-16 派发参数事故：4 评审秒失败（coordinator 责任）+ 重派

- 事故: T28rev/T18rev/T25rev/T36rev 首次派发（ctx_0dab575baf15/bb72069ed50e/77f7ec08655b/2411757ed191）在 worktree_create 阶段失败，transcript 全零。
- 根因: `--base-branch 1123786563/opik-tXX-w` 引用不存在——T18/T25/T28/T36 实现分支只有**本地引用** `opik-tXX-w`（无 remote 前缀；此前任务如 T13/T17/T19 有 remote-tracking 引用故未踩坑）。`git worktree add` 报 `fatal: invalid reference`。
- 处置: 4 个 failed dispatch worker-release；worktree 路径无残留；用本地分支名重派，spec 原文保留仅修正分支引用:
  - T28rev = ctx_5da1d2cc28d5 (base opik-t28-w@34217017)
  - T18rev = ctx_53f0108829f5 (base opik-t18-w@52882a14)
  - T25rev = ctx_8ab817f5a923 (base opik-t25-w@4e2a807a)
  - T36rev = ctx_5cbb0fbb574a (base opik-t36-w@75cc28af)
- 验证: git worktree list 四个 rev worktree 均已创建于正确基点；worker-list 全部 ready/dispatched。
- 教训: 派发引用分支前先 `git rev-parse --verify <ref>`；实现者不推 remote（no-push 规则）时分支只有本地名。
- T35wire（ctx_45321dae4ccf）观察: 运行中，transcript 200 条，正在核 datasets 2BP01 回滚（发现 HEAD 72a5f1f6 已含 CASCADE 修复、与 git log 矛盾——正在追 merge 来源）。最后消息后静默约 100 分钟，按检查点处理继续观察（12h 阈值）。
- 当前在途 5: T35wire、T28rev、T18rev、T25rev、T36rev。

### 2026-10-16 T35wire 死于 Orca 重启（第二次）+ 续接重派

- 证据: transcript 停在 200 条（尾部 reasoning@1792130831 + system@1792132702），70+ 分钟零增长; `_meta.runtimeId` 由 604a1580 变为 c9353520（Orca runtime 重启）。与上次 T35-fix ECONNRESET 模式一致。
- 死前 WIP（未提交 7 文件）: queries/runs.ts、retention.ts、routes/index.ts、routes/runs.ts、scope.ts、index.ts、opik-retention.integration.test.ts、opik-runs-query.test.ts——即移交清单接线工作。
- 死前关键中间结论（已写入续接 brief）: datasets 2BP01 失败在 T35 基线 d91ca44a 属实（DROP TABLE 无 CASCADE），但 HEAD 72a5f1f6 已含 CASCADE 修复——经 merge 提交进入（git log -- path 简化历史不显示第二父改动）。续接 worker 须复跑验证（docker opik-t35-pg@5549 仍在）。
- 处置: worker-stop + worker-release ctx_45321dae4ccf → 同 worktree 续接重派 ctx_915e5962fd83（--worktree path:opik-t35-wire，明确不丢弃 WIP）。
- 备注: worker-start 指向已有 worktree 用 `--worktree path:<path>`，--repo path: 会被拒（creation options 限 new-child/new-top-level）。
- 重派的 4 个评审已发心跳（T28rev/T36rev alive investigating）。
- 当前在途 5: T35wire2=ctx_915e5962fd83、T28rev、T18rev、T25rev、T36rev。

### 2026-10-16 T28-rev 完成 PASS + T28 集成遇架构冲突升级

- T28rev（ctx_5da1d2cc28d5）worker_done: **PASS（1 Low / 2 Nit）**，无 critical/high/medium。门禁在 opik_t28_rev 独立库复算全绿（typecheck 0 / 136 测试 / biome 0），报告提交 232843e5。L-1（plainUsage 只验顶层信封、深层裸字符串纵深防御缺口）→ 登记 T29 brief 顺手项; N-1 重复 index 后写覆盖、N-2 execution_failed code 开放 string 为 Nit。
- 集成尝试: cherry-pick 34217017 到集成 main@72a5f1f6 冲突（executions.ts + opik-executions.integration.test.ts）。
- 冲突实质（非机械）: T24 集成版（15264555）的 write-ahead 架构（markCaseStarted/recordCaseOutcome(detail 即时投影)/settleCompletedFromOutcomes）与 T28 的 settleCompleted 逐字段投影**并行演化**——集成 main 的 settleCompleted 已含 T28 注释版逐字段投影（T24 实现者吸收），但 runCase 循环走 FromOutcomes 路径，落库形状为顶层信封+detail 字段名; T28 results.ts 契约为 root.cases+output/usage 信封（裸顶层）。两形状互不兼容 → 直接合并会让 T28 评分把全部 case 判 CASE_RECORD_DAMAGED（fail-closed 但功能全损）。
- 裁决: 按 AGENTS.md 冲突规则升级为实现票 T28-merge（不静默重设计）。cherry-pick 已 abort，集成 main 保持 72a5f1f6。
- 待派: T28-merge（base 72a5f1f6，裁决形状对齐方向+实现+门禁）。

### 2026-10-16 T35wire 集成完成（fix-report §5 移交全部收口）

- T35wire2（ctx_915e5962fd83）worker_done f0e40dee: 保留死前 8 文件 WIP 并完整覆盖三项移交（invalidateReads 经 boot 单一共享 RunsQueryService 接线 + scopeCacheKey/invalidateKey seam、retention work_items purge + 非终态补建工单前置、renew 维持不接线结论）; datasets 2BP01 在 HEAD 已消失（CASCADE 经 merge 第二父带入，5549 复跑 10 pass）——与死前调查结论一致。
- 集成: cherry-pick f0e40dee → **a97ba15d**（无冲突，fast-base 72a5f1f6）。
- 门禁复跑（集成 main）: typecheck 0 错; 专用门禁库 opik_t35w_gate（docker opik-t35-pg@5549，t35/t35）migrate 幂等二跑 ok; 58/58 测试全绿（opik-runs-query + opik-retention.integration）; biome index.ts 报错经基线 72a5f1f6 复验为既有非本票引入。
- 已释放 ctx_915e5962fd83。清理项: 门禁库 opik_t35w_gate 用后即弃（容器 5549 保留至 T37 验收）。
- 当前进度: 29/37 集成（T01–T17、T19–T24、T26、T32–T35 含 handoff wiring）。在途 4: T28merge、T18rev、T25rev、T36rev。

### 2026-10-16 T18 集成完成 + stash 事故教训 + T18-server 开票

- T18rev（ctx_53f0108829f5）worker_done: **通过（4 LOW + 2 INFO，无 high/medium）**。关键裁决: 披露属实（OpikOperation 无 span 读回、creator 读路由未接 T01 seam）; 契约钉住可支撑服务端票零前端改动; Issue #24 AC1/AC2 部分满足、AC3/AC4 满足; **明确建议开 T18-server**（37 票无一承接）。4 LOW: 环防御无 shipped 用例、unheard executionState/kind 收窄未钉、空串 name 空白标题、重复 spanId key 警告。报告 d5592e84。
- **stash 事故（教训）**: 验证 biome 基线时 `git stash -u || true`（当时工作树干净未创建 stash）后 `git stash pop` 弹出了**他人遗留的 billing 旧 stash**（task5-wip-check），在集成 main 留下 billing-credits-writer UU 冲突。处置: checkout HEAD -- 恢复，stash 本体无损保留。教训: 集成 worktree 禁用 git stash; 基线验证改用临时 worktree/`git show <base>:<file>`。
- T18 集成: cherry-pick 52882a14 → **0aa0d63e** + d5592e84 → **4feee732**（无冲突）。门禁: app typecheck 0、37/37 测试（run-detail+run-steps）、biome 5 文件 clean。
- 开票 T18-server: 读回 seam 补全（port 操作+T04 证据+查询服务+steps 路由+boot 接线+前端对接）+ 4 LOW 顺手收口。base 4feee732。
- 进度: 30/37 集成。在途 3: T28merge、T25rev、T36rev。

### 2026-10-16 T25 集成完成 + T36-rev 2 Major 转修复票 + T27/T36fix/T18server 派发

- T25rev（ctx_8ab817f5a923）worker_done: **双结论 PASS 无阻塞**（4 Low + 2 Info: 拒绝原因坍缩 budget_refused、precheck 粗粒度、occurredAt 取结算时刻、测试全表 delete——建议随路由接线票收口）。AC1-AC4 全满足; 三重幂等围栏+5 路并发结算探针实证不双扣; 未知成本 hold 无永久泄漏（15min 过期回收+reconcile）; billing flake 归因核验成立。报告 0d7d1735。
- T25 集成: cherry-pick 4e2a807a → **02ea1d17** + 0d7d1735 → **f242b250**（无冲突）。门禁: typecheck 0、migrate ok（opik_t25_gate@5547）、billing 集成 8/8、biome clean。
- T36rev（ctx_5cbb0fbb574a）worker_done: **2 Major + 2 Minor + 4 Info**——M-1 时间窗 chips ms(1h/1d/7d) 与 label(24h/7d/30d) 不符、测试未拦语义; M-2 撤权翻转靠 focus refetch 但生产 refetchOnWindowFocus:false 且 settled 后 interval 关闭→撤权后下载按钮无限期存活、报告 §3.4 失实; m-1 server index.ts:5141 .catch(()=>[]) 吞错（T33 M-3 根因）; m-2 导出发起 UI 无归属票（T38/T43 归属，登记不阻塞）。AC1/AC3/AC4 成立、AC2 需修复。报告 3204ed76（在 opik-t36-rev worktree）。
- 派发: T27=ctx_d72a74c11232（base f242b250，Judge 六条验收）; T36fix=ctx_5619216a4643（base opik-t36-w，修 M-1/M-2/m-1）; T18server=ctx_4b35b0c87f68（base 4feee732，span 读回 seam+4 LOW 顺手）。
- 已释放: ctx_8ab817f5a923、ctx_5cbb0fbb574a。
- 进度: 31/37 集成（+T18、T25）。在途 5: T28merge、T27、T36fix、T18server（+T28merge 仍在）。

### 2026-10-16 T28 集成（经 merge 票）+ T25 交叉适配票

- T28merge（ctx_e9a5b069acf8）worker_done: 裁决方向——settleCompletedFromOutcomes 落库对齐 T28 裸契约 {cases:[{index,status,output?,usage?}]}，recordCaseOutcome record 时每字段预算投影，T24 write-ahead 接管/no-double-billing 一字未动，T28 已评审 results.ts 零改动。schema 改动纯注释（DDL 零变化，无迁移）。门禁: typecheck、T24 21 pass、T28 47 pass（opik_t28_merge 库）、biome clean。报告 872f7d60。
- 集成: cherry-pick c2d93816^..872f7d60 → **6b18ff87..ffe9e200**（4 提交，无文件冲突）。
- **集成侧门禁发现交叉**（cherry-pick 不报但 typecheck 报）: execution-billing.ts:209 用旧 outcome.detail，T28-merge 改签名为 {status, output?, usage?}（信封）。根因: T28-merge 基于 72a5f1f6，先于它合入的 T25(02ea1d17) 不在其门禁视野。集成 main 当前 typecheck 红（已知中间态）。
- 派发: T28billing=ctx_b206134a53c0（base ffe9e200，usage 信封 unwrap + 未知成本不当 0 语义 + 三套件零回归）。集成 main 待此票修复后恢复全绿。
- 教训: 并行票基于不同基点合入时，cherry-pick 无冲突 ≠ 类型层无交叉——集成侧 typecheck 是必要门禁（本例证明）。
- 进度: 32/37 集成（T28 计入，待 billing 适配收口）。在途 5: T27、T36fix、T18server、T28billing。

### 2026-10-16 T29/T30 派发（T28 集成解锁）

- T29=ctx_5bdf46a6423d（base ffe9e200）: 对比接口+兼容性判定（#35 四验收）+ routes/results.ts 挂载义务 + T28rev L-1/T25rev 4Low 顺手评估; 约束不改 execution-billing.ts（与 T28billing 避撞）。
- T30=ctx_3373c049008f（base ffe9e200）: 实验页面（#36 四验收）+ T21-rev 遗留钉住项顺手; i18n evaluations 命名空间扩展。
- 在途 6: T27、T36fix、T18server、T28billing、T29、T30。

### 2026-10-16 T36fix 完成 + T36-rev2 复审派发

- T36fix（ctx_5619216a4643）worker_done 9b55387a: M-1 ms 对齐意图（day/week/month=24h/7d/30d）+跨度断言; M-2 局部 refetchOnWindowFocus:true 覆盖+生产同源测试构造+settled 后撤权翻转/admin 收窄两用例+失实声明重写; m-1 删 .catch(()=>[]) 失败传播 500+server 用例。门禁: 双 typecheck 0、89 pass（86+3）、17 pass（16+1）、biome 改动文件零命中。4 Info 逐项判定不改、m-2 边界外。
- 按纪律 Major 修复须独立复审: 派 T36rev2=ctx_5019b28261b3（base 1123786563/opik-t36-fix@9b55387a，只读双结论）。
- 在途 6: T27、T18server、T28billing、T29、T30、T36rev2。

### 2026-10-16 T30 澄清裁决（AC4 回链口径）+ 新留场项

- T30 提问: AC4「结果可回链到运行详情」与 wire 事实冲突（评测隔离执行无 runs 绑定）; 提交/取消 HTTP 路由不存在。
- 裁决: **选 A**——execution 投影 + T28 resultLink 为回链（spec 实质: 结果→执行记录可追溯; runs 详情路由字面不适用，隔离设计使然）; URL 面 POST experiments + cancel 确认，要求钉进 shared/ 前端契约（T18 同款）+ 契约测试断言真实 URL/字段。报告须显式声明 AC4 按执行详情口径满足。T37 端到端按此口径核 A5。
- **新留场项（移交清单）**: 提交/取消/实验相关 HTTP 路由实现（T22/T23 只到 store 层，results.ts 挂载归 T29 但提交/取消无归属票）——需在 T31 后、T37 前开专门路由票，否则 A5「页面提交实验」无服务端支撑。

### 2026-10-16 T28billing 集成完成——集成 main 恢复全绿

- T28billing（ctx_b206134a53c0）worker_done 1d2da7be: 修复内容超出预期——除 billing 信封适配（exactTokensOf 解 raw/信封/每字段信封三种拼写，非 projected/缺数/非有限数→unknown-cost 路径 hold 保留不当 0）外，还发现并修复 runner 在 runtime 仍产旧 detail 形状（真实执行落不到 output/usage）。3 新单测+5 旧断言更新。门禁: tsc 0（修复前 TS2339）、biome、opik_t28b 库 76 集成+10 单测。
- 集成: cherry-pick 1d2da7be → **359ab955**。集成侧复验: typecheck 恢复 0、migrate ok、41/41 四套件、biome clean。**集成 main 恢复全绿**。
- 留场清单合并更新（实验路由票范围）: 提交/取消/结果/对比 HTTP 路由（T22/T23/T28 store 层已备）+ billed runner 生产装配（createBilledEvaluationCaseRunner 现仅测试消费）。归属: T29 承接 results 挂载; 其余待专门票（T31 后 T37 前开）。
- 进度: 32/37 集成（T28 链含 merge+billing 适配全部收口）。在途 5: T27、T18server、T29、T30、T36rev2。

### 2026-10-16 T27 完成 + T27-rev 派发

- T27（ctx_d72a74c11232）worker_done a2c3bb73: scoring/judge.ts 三键准入（入口映射+已实现批准 scorer 版本+定价模型）、T25 billing 复用（opik-judge-case 词汇）、T05 投影 rationale、10 码失败分类不伪造成功。六验收全有证据: 18 单测+4 集成（受控假 provider 全流程: gating/调用次数/双结算）+198 adjacency 两轮。typecheck/biome clean、零迁移。
- 留场: T28 消费 JudgeScoreRecord + boot wiring（准入清单部署加载、createEntranceModelCall env 接线）→ 归实验路由票（与既有留场合并）。
- 派发: T27rev=ctx_717a7dffd540（base 1123786563/opik-t27-w@a2c3bb73，只读双结论，资金+准入最高谨慎度）。
- 在途 5: T18server、T29、T30、T36rev2、T27rev。

### 2026-10-16 T36 集成完成（实现+fix+rev2 整链）

- T36rev2（ctx_5019b28261b3）worker_done 66a13a84: **双结论 APPROVE + Spec 合规通过（AC2 成立）**。M-1/M-2/m-1 全部实证（query-core 5.102.2 源码合并顺序+生产构造对照探针双重验证 refetchOnWindowFocus opt-in 生效; listBots 500 端到端传播+页面 unavailable 接住）。4 Info 判定成立，新增 1 Info（测试注释措辞，不阻塞）。门禁独立复算全绿。
- 集成: cherry-pick 75cc28af^..66a13a84 → **72c9f838（实现）→ 7d6dd5df（fix）→ c6e14aed（rev2 报告）**。两处冲突机械解决: a) runs.ts——T18 steps 类型与 T36 refusalCode export 并存（类型保留+export+T36 注释）; b) index.ts——T35wire runsQuery 行与 T36fix 删 .catch 并存。
- 门禁（集成 main）: 双 typecheck 0、app 68 pass（含 runs-list/run-steps 回归）、server admin-summary 17 pass、biome 触碰文件 clean（index.ts 7 命中全既有: organizeImports 涉全文件 360 行 import 排序、noConsole@798/823/841、noNonNullAssertion@4570——均不在本次触碰行 55-61/5155-5165; /tmp 对照法因无项目 biome.json 无效，以行号比对+历次报告佐证）。
- 已释放 ctx_5019b28261b3。
- 进度: **33/37 集成**（T01–T28、T32–T36）。在途 4: T18server、T29、T30、T27rev。未集成: T27（待 rev）、T29、T30、T31（等 T29+T30）、T37（验收）。

### 2026-10-16 T29 完成 + T29-rev 派发

- T29（ctx_5bdf46a6423d）worker_done 4ce6cbff: comparison.ts + GET /experiment-comparisons; 兼容性三阻断字段（datasetContentHash/judgeVersion/judgeConfig），其余冻结字段对照不阻断; delta 封闭方向词、退化行双侧 T28 回链、缺失 null 不当 0; **results 路由挂载闭环（T28 移交项）**+真实挂载表 e2e; T28-rev L-1 收口+4 测试; T25-rev 4 Low 留置（execution-billing 冻结面，报告 §4 理由）。门禁: 本票 typecheck 零错（execution-billing.ts:209 为其 base ffe9e200 上基线既有——T28billing 359ab955 已修，集成后消失）、789/789 全 opik 面（opik_t29 库）、biome clean。
- 派发: T29rev=ctx_cb336a916b84（base 1123786563/opik-t29-w@4ce6cbff，只读双结论）。
- 在途 4: T18server、T30、T27rev、T29rev。

### 2026-10-16 T18server 第二次死亡（429 限流）+ 续接重派

- 证据: transcript 停 136 条，尾部 system@1792139242 = "API Error: Request rejected (429) 账户速率限制"。与 429 整批事故同款死法（单发）。
- 死前 WIP: M server/tests/opik-port.test.ts + ?? server/tests/opik-run-steps.test.ts（TDD 测试先行中）; 勘察已完成（T01 seam、T04 模式、docker 环境盘点含 validation 栈 9 容器 healthy）。
- 处置: stop + release ctx_4b35b0c87f68 → 同 worktree 续接重派 ctx_4afc702d94e6（WIP 保留指令 + 原 brief 六项 + 死前进度重建 + 429 频率提醒）。
- 在途 4: T30、T27rev、T29rev、T18server2。

### 2026-10-16 429 配额整批事故（第二次）+ 配额重置后重派

- 事故: T30/T27rev/T29rev/T18server2 四个 worker 于约 17:17 全部死于 429 错误码 1308「已达到 5 小时使用上限，限额 2026-10-16 20:16:13 重置」。与第一次 429（1302 速率限制）不同，本次为**配额耗尽**——立即重派无效，须等重置。
- 发现延迟: coordinator 的 waiter 超时循环未区分「worker 长时间工作」与「worker 已死」，约 20:40 才巡检发现（浪费约 3 小时窗口）。教训: 无心跳且 transcript 尾部为 system 消息的停滞（>30 分钟）应触发尾部内容检查，而非继续等待。
- WIP 盘点: T30 8 文件页面实现 WIP; T27rev 干净; T29rev 一个临时探针（重派时删除重写）; T18server 测试 WIP。
- 处置: 20:40 配额已重置（时间计算失误一度以为还要等 2.6h，date 对照纠正）→ stop+release ×4 → 同 worktree 续接重派 ×4:
  - T30-2=ctx_836c7e4b79f0、T18server3=ctx_2fd4cf92accd、T27rev2=ctx_407a210b1b1a、T29rev2=ctx_ca5625ae437d
- 进度不变: 33/37 集成。在途 4。

- 修正: T30rev 首派 ctx_40134fc1c44c 又踩分支引用坑（反向: T30 实现分支是 1123786563/opik-t30-w 带 remote 前缀，本地 opik-t30-w 不存在）→ release 后用正确引用重派 ctx_7b466a792dea，worktree 验证建于 de176f86。分支规则终版: **派发前必须 git worktree list/git branch -a 核对实际引用全名**（本地与 remote 前缀两种都可能）。

### 2026-10-16 T29 集成完成

- T29rev2（ctx_ca5625ae437d）worker_done 1b70fad8: **Spec PASS + Code APPROVE（2 Low/2 Nit 不阻塞）**。三阻断字段有 A7/A9 依据、delta 四词封闭缺失恒 null、T28 语义零漂移、回链不可伪造+七路 scope 对抗、挂载真实 e2e、L-1 收口对齐写入侧、T25-rev 四 Low 留置成立（归宿后续路由收口票）。typecheck 1 错经三提交交叉定位为兄弟分支交叉（base 已修、合并自消——集成复验证实）。门禁: 789/789 独立库复算。
- 2 Low 登记: L-1 非终态样本（in_progress/pending_reconciliation）提前判 regressed/improved 并入 regressions → **T31 brief 必含**（消费前收口）; L-2 损坏 hash 基数背离 TypeError 500（仅存储损坏可达）→ 收口票。
- 集成: cherry-pick 4ce6cbff → **1d5e09c0** + 1b70fad8 → **fdcc6889**（无冲突）。门禁: typecheck 0、64/64（comparison×2+results）、biome 4 文件 clean。
- 已释放 ctx_ca5625ae437d。
- 进度: **34/37 集成**。在途 3: T18server3、T27rev2、T30rev。剩余: T27（集成待 rev）、T30（待 rev）、T31（等 T30 集成）、T37+路由收口票。

### 2026-10-16 T27-rev 结论: Spec FAIL（B-1）→ T27-rn 适配轮

- T27rev2（ctx_407a210b1b1a）worker_done 9cd41d84: **模块本体全过（Code APPROVE）——三键准入/计费逐缝复用/投影纪律/10 码词表/门禁 SHA256 复算绿**。唯一阻塞 B-1: 第三次兄弟分支交叉——judge.ts:546-547 读旧 outcome.detail（tsc 红 3 处），返回侧旧形状经 TS 5.9 async 箭头盲区静默通过被 worker 丢弃（judge 记录无落地通道）。另: 实现报告「0130 未占用」声明不实（0130=T35，下个空号 0131）。
- 派发: T27rn=ctx_4b13291ef002（base fdcc6889=集成 main 最新——直接在集成面适配一次到位: 读侧新形状+返回侧盲区显式类型堵死+T28 消费面最小扩展裁决+落地通道测试）。
- 兄弟交叉模式（第三次）已固化教训: **派发新票时若 base 含尚在评审的兄弟票改动区域，brief 须预告形状可能漂移**; 集成侧 typecheck 是兜底。
- 已释放 ctx_407a210b1b1a。在途 3: T18server3、T30rev、T27rn。

### 2026-10-16 T30 集成完成 + T31 派发

- T30rev（ctx_7b466a792dea）worker_done 64a3d7b7: **Spec PASS / Code APPROVE（3 Low + 5 Info 无阻塞）**。四验收成立、AC4 按裁决 A verbatim、shared 契约逐字段镜像+名断言、F3/F4/F5 真实收口、五项门禁全复算绿。3 Low: submit 响应守卫漏 canaryFindings、PageSection mt 覆盖、Syncing 断言行名满足——前一项归路由收口票，后两项 T31 视归属。
- 集成: cherry-pick de176f86 → **89f0a808** + 64a3d7b7 → **88de4d4a**。一处机械冲突（routes 测试路由清单数组——T36 exports 行与 T30 experiments 行并存）。门禁: app typecheck 0、42/42、biome clean。
- 派发: T31=ctx_7ebf5d79eae9（base 88de4d4a; 对比页面四验收 + **必含 T29-rev L-1 修复**（非终态样本提前判级）+ T30-rev 2 Low 页面项视归属）。
- 进度: **35/37 集成**（T01–T30、T32–T36; T27 待 rn）。在途 3: T18server3、T27rn、T31。
- 收尾路线: T27rn→复审→集成; T31→复审→集成; 然后路由收口票（实验提交/取消/results 已挂/对比路由+billed runner 装配+judge boot wiring+T29rev L-2+T30rev L-1）; 最后 T37 端到端验收 → 全分支审阅 → 外层 OCR。

### 2026-10-16 T18-server 完成 + T18s-rev 派发

- T18server3（ctx_2fd4cf92accd）worker_done b91b1198（第三任续接，WIP 零丢弃）: 六项全交付——listSpans seam（T04 能力门+共享助手）、RunsQueryService.steps（判属先行/诚实空/信封翻页/投影纪律/spanId 去重/时序）、/:runId/steps 路由（T33 共享服务零 boot 改动）、4 LOW 收口、**真实栈证据落盘 spans-live/**（9 容器: 真实写入 4 span→GET /v1/private/spans 读回→投影全对→删除 404 复核）。2 披露: tool JSON 参数平铺 input 缺席（不逆向重建——合理裁决）、行序非时序排序兜底。门禁: 双 typecheck 0、server 734/0（opik_t18s 库）、前端 89/0（85 零回归+4 新）、biome。
- 派发: T18srev=ctx_11f34cd493e1（base opik-t18-server 本地分支——按新纪律已核对 worktree 引用，只读双结论，重点核真实栈证据质量）。
- 已释放 ctx_2fd4cf92accd。在途 3: T27rn、T31、T18srev。

- 修正: T18srev 首派 ctx_11f34cd493e1 分支引用坑（opik-t18-server 实为 1123786563/ 前缀）→ release 后正确引用重派 ctx_03b0fea8f7ac，worktree 验证建于 b91b1198。

### 2026-10-16 T27rn 完成 + T27rn-rev 派发

- T27rn（ctx_4b13291ef002）worker_done（worktree 链: fdcc6889+40c7c6fd cherry-pick+0b0f1201）: B-1 三点全修——读侧顶层 output、返回 {...outcome, judge}+显式 Promise 标注（实证旧形状 TS2353 非静默）、judge 落地通道按评审路径 1 最小面（detail JSONB 第三 per-field 信封，record/settle/T28 读侧全链，零迁移零新表; SampleReason 显示留显示侧票）。门禁: typecheck 0、18+5（含落地端到端）、T28 42+9 零回归、203/203 两遍（opik_t27rn 库）、biome 0。L-1 更正: 下个空迁移号 0131。
- 派发: T27rnrev=ctx_b6d62db9964f（base 1123786563/opik-t27-rn@0b0f1201，快审: B-1 RESOLVED 与否+双结论）。
- 已释放 ctx_4b13291ef002。在途 3: T31、T18srev、T27rnrev。

### 2026-10-16 T18-server 集成完成

- T18srev（ctx_03b0fea8f7ac）worker_done ed120c46: **通过（1 LOW + 3 INFO 无阻塞）**。listSpans 真共享无第二套、判属先于上游、零 boot 改动属实、spans-live 证据逐字段复算吻合、2 披露属实处置合理、4 LOW 全收口。门禁独立复算全过（734/0 于 opik_t18s_rev 库）。1 LOW 登记: MAX_SPAN_PAGES=100 静默截断 vs never-truncate 矛盾（达顶改 502 建议）→ 收口票。
- 集成: cherry-pick b91b1198 → **f2c89465** + ed120c46 → **8281f4ba**（无冲突）。门禁: 双 typecheck 0、101/101（steps+port+runs-query，opik_t18s_gate 库 migrate 幂等）、biome clean。
- 已释放 ctx_03b0fea8f7ac。进度: 36/37 集成（T27 待 rnrev）。在途 2: T31、T27rnrev。
- Issue #24 状态: AC1/AC2 由 T18+T18-server 联合补全达成（前端契约+服务端 seam+真实栈证据）。

### 2026-10-16 T27 整链集成完成

- T27rnrev（ctx_b6d62db9964f）worker_done cf3e22a3: **B-1 RESOLVED + Code APPROVE**。三点全实证（读侧无 detail 残留、盲区标注双向复现——去标注 0 错证明标注必要、第三信封投影纪律与 output/usage 一致+计费面零接触）。门禁全量复算一致（203/203 两遍于 opik_t27rnrev 库）。L-3: judge 展示分类显示侧票 → 收口票清单确认（SampleReason 显示）。
- 集成: cherry-pick 40c7c6fd^..cf3e22a3 → **aa5fef72（实现）→ e93919c0（适配）→ 1c9bec99（复审报告）**（无冲突）。门禁: typecheck 0、86/86（judge+results+executions，opik_t27_gate 库）、biome clean。
- 已释放 ctx_b6d62db9964f。
- **进度: 36/37 集成，仅剩 T31（运行中）**。Issue #33 六验收达成（T27+rn 适配）。

## 2026-10-16 会话续接（第三段，coordinator 重建后）+ T31 完成 + T31rev 派发

- 续接盘点: `orca status` ready; run_ab5804dae285 worker-list 复核 100+ 行，T27rnrev/T18srev 均已 settled+released，无失联 worker; 集成 main tip `1c9bec99`（T27 整链集成完成）与 ledger 尾部一致。收件箱仅 1 条: T31 worker_done。
- **T31 完成**（ctx_7ebf5d79eae9 succeeded）: 提交 `00a4e9df`（1123786563/opik-t31-w，base 88de4d4a）。交付: 对比页面（四 id search 参数 GET 面 + 页内选择表单）+ T29-rev L-1 服务端修复（非终态样本 → incomparable，不入 regressions; RED 2→GREEN 20/20 配对单测+真管道集成用例）+ T30-rev L2（mt 覆盖删除）/L3（In-flight one 行名）收口。门禁声称: 双 typecheck 0、795/795 全 opik 面（opik_t31 新库）、139/139 app、biome clean、48 键双语对称。报告: docs/plans/evidence/2026-10-16-issue4/T31/implementation-report.md。
- 派发: T31rev=ctx_3ee6b0b59f33 / task_459e183c0dea（provider=pi，worktree opik-t31-rev，base 1123786563/opik-t31-w@00a4e9df，只读双结论; brief 含 #37 四验收+L-1 修复复验+门禁独立复算指令）。回执核对: live/working/owned。
- 已 ack delivery_0850f12397ec 并释放 ctx_7ebf5d79eae9。
- 在途 1: T31rev。进度: 36/37 集成，T31 待评审集成。
- 收尾路线（不变）: T31rev → T31 集成 → **路由收口票**（实验提交/取消 HTTP 路由 + billed runner 生产装配 + judge boot wiring + T29rev L-2 + T30rev L-1 + T18srev L-1 MAX_SPAN_PAGES 502 + T25rev 4 Low 视面 + SampleReason 显示）→ T37 端到端验收（#43 真实自托管栈，A1–A13+37 子票映射核验）→ 全分支独立审阅（BASE bab7c0b9→HEAD+未提交）→ 外层 OCR（agent audience，committed+workspace 两范围）→ finishing-a-development-branch。
- 路由收口票 base 必须为 T31 集成后的 integration-main（shared wire/experiments.ts 与 T31 有真实重叠，兄弟交叉已三次教训，不再冒险）。

### 2026-10-16 T31 评审+集成完成 → 37/37 子票全集成

- T31rev（ctx_3ee6b0b59f33）worker_done: **Spec PASS / Code APPROVE（4 Info 无阻塞）**。L-1 修复 49 对全组合探针+独立 worktree 复现 RED(2)/GREEN(20); L2/L3 落地、L1 未越界; 门禁全新库 opik_t31rev 复算 795/795+139/139+双 tsc+biome 全绿（app 全家桶 4 例 flake 经基线对照证实基线既有）。评审报告提交 5218830b。Info-1: 实现报告 48 键 vs 实测 51 叶（文档精度）。
- 集成: cherry-pick 00a4e9df → **2fa50432** + 5218830b → **33af51fc**（无冲突）。集成侧门禁: server tsc 0、comparison 24/24（opik_t31_gate 新库 @5547 migrate+test）、app tsc 0 + 32/32（comparison/routes/datasets）、biome 触碰 4 文件 clean。
- 已 ack+release ctx_3ee6b0b59f33。**进度: 37/37 子票全部集成。** Issue #37 四验收达成。
- 剩余收尾: T-Routes 收口票 → T37（#43）→ 全分支审阅 → 外层 OCR。

### 2026-10-16 T-Routes 收口票派发

- ctx_73add71627b9 / task_ebf824dce4e8 / pi / worktree opik-t-routes / base 1123786563/opik-integration-main@33af51fc。
- 范围: A 实验提交/取消 HTTP 路由（wire 契约已钉、store 已备、页面已消费）; B 生产装配（billed runner 接生产 worker + judge 准入 boot wiring）; C Low 收口（T30rev L-1 canaryFindings、T29rev L-2 损坏 hash 500、T18srev L-1 MAX_SPAN_PAGES 502、T25rev 4 Low 视面、T27rnrev L-3 SampleReason 显示）。禁做实验列表页（T31 裁决后续票）。迁移备用号 0131。
- 环境备注: 集成门禁库密码确认 opik_t07/opik_t07（本账本内记录）; journal 顶 0130 复核。

### 2026-10-16 T-Routes question 裁决: index.ts boot 选 B

- 问题: 实验 worker 在 server/src/index.ts 从未 boot(T23 只交付工厂),票面允许编辑面不含 index.ts。
- 裁决 B: 特别允许最小编辑 index.ts(~20 行 boot 块,enabled-only 守卫,沿 export worker .start() 先例)。理由: 不 boot 则 A5 端到端(提交→执行→结果)在 T37 必然失败。建议组装逻辑放 execution-boot.ts,index.ts 只调用。不触碰 index.ts 其他行与既有基线诊断。

### 2026-10-17 T-Routes 完成 + 评审派发

- T-Routes（ctx_73add71627b9）worker_done: 5 提交于 1123786563/opik-t-routes（base 33af51fc）。A: submit/cancel 路由 12 集成测（真实挂载表）; B: execution-boot.ts 生产装配 + index.ts ~37 行 enabled-only 块（billed runner reserve→charge→settle 轨迹测试、judge admission env fail-closed）; C: 五 Low 四修一 won't-fix（C-4 L-2 粗粒度 precheck）。污染事件透明披露+file-unique scope 修复（bde617b5）。门禁: 双 tsc 0、opik 面 869/0（base 844/0）、app 面 147/0、biome index.ts base 7 条零新增。
- 派发: TRoutesrev=ctx_ca5addbbbfab / task_08e6045a7d1a（pi,worktree opik-t-routes-rev,只读双结论,重点=生产 boot/计费语义/污染事件/门禁复算）。
- 在途 1: TRoutesrev。

### 2026-10-17 T-Routes-rev 结论: Spec FAIL(H1)→ 修复轮派发

- TRoutesrev（ctx_ca5addbbbfab）worker_done cf598ceb: 门禁全量复现(869/0+147/0+双 tsc+biome rule-identical); **Spec FAIL 于范围 B**: H1(高,本票引入) index.ts:5149 未传 executionBilling 给 createAiObservabilityRoutes → 生产实验提交恒 402,特性生产端到端死(fail-safe 方向,报告未披露); ~一行修复+wiring 守卫。范围 A PASS、范围 C PASS(C-4 L-2 won't-fix 裁决成立)。M1 新套件仍有全表 delete; L1 boot afterEach eq-vs-like 无效; L2 17 基线套件共享 user-a scope(预存,登记不修)。Info2: app 面测试需先 generate:app-config。
- 派发修复轮: ctx_9c535647f087 / task_208e37397820（pi,同 worktree opik-t-routes 续接,H1 接线+守卫测试、M1 全表 delete 改 sweep 清理、L1 假清理修正; RED→GREEN; 门禁复跑 ≥870/0）。
- 在途 1: 修复轮。

### 2026-10-17 T-Routes 修复轮完成 + 增量复审派发

- 修复轮（ctx_9c535647f087）worker_done a0190920: H1=index.ts 接真实 executionBilling precheck（worker-boot gate 下 createExecutionBudgetPrecheck）+source-level wiring 守卫测试 RED(3)→GREEN(4)+行为测试 funded 200/unfunded 402; M1/L1=两套件改按 id/like 限定清理。门禁: opik 面 874/0/46 文件（base 869/0,+5 守卫）、app 147/0、双 tsc 0、biome index.ts base 7 条。
- 已 ack+release 实现者。派发增量复审: ctx_66de65fac6c2 / task_f5113648ec5a（pi,opik-t-routes-rev2,cf598ceb..a0190920 快审,验证 H1/M1/L1 RESOLVED+RED 声称可信度+门禁复算）。
- 在途 1: 增量复审。

### 2026-10-17 T-Routes 整链集成完成

- 增量复审（ctx_66de65fac6c2）worker_done e56e129f: **H1/M1/L1 全 RESOLVED,Spec PASS / APPROVE**。参数链核对(index.ts:5165 同门同账簿/fail-closed 保持)、RED 守卫实证复现(基线 3 fail 恢复后 4 pass)、funded 200/unfunded 402 行为测试真实挂载表+真实账本; M1 逐 id 清理、L1 真删。门禁独立复算一致(874/0/46、147/0、双 tsc、biome index.ts base 同款零新增)。新登记 1 Low(boot afterAll 注释 usage 足迹声明过宽,预存非回归)。
- 集成: cherry-pick 33af51fc..e56e129f → **46153ffe..ae613f46**(8 提交,无冲突)。集成侧门禁: server tsc 0、全量 opik 面 874/0/46(opik_troutes_gate 新库)、app tsc 0+147/0、biome touched clean、index.ts diff 人工核对(H1 接线+boot 块,enabled-only)。
- **T-Routes 节点: 已验证并集成。A5 服务端支撑闭环(提交/取消路由+生产 boot+billed runner+judge wiring)。**
- 进度: 37/37 子票+1 衍生收口票全部集成。剩余: T37(#43 终验)→ 全分支审阅 → 外层 OCR → finishing。

### 2026-10-17 T37 终验派发

- ctx_3b2706f9ed7d / task_cdf7d79f8569 / pi / worktree opik-t37-w / base 1123786563/opik-integration-main@ae613f46。
- 范围: A1–A13 证据索引+真实栈端到端补证(采集/查询/评测走 T-Routes 提交路由/ID 映射/删除)+全套验证命令+acceptance-report。独立 review+OCR 由协调者后续执行(AC3 引用位预留)。
- 在途 1: T37。

### 2026-10-17 T37 完成 + G 缺口裁决 + fix/rev 并行派发

- T37（ctx_3b2706f9ed7d）worker_done 2a468e63: 真实栈 4 probe 全过（A 采集+ID 映射、B 框架父子形状、C/C2 评测端到端+真实计费结算、D 保留删除+导出撤权+缓存失效）; 门禁全绿（三 typecheck 0、874/0、147/0、biome 0、app build）; detailed 翻转 FRAMEWORK_STEPS_VERIFIED_ON_REAL_INSTANCE（T16 预告语义）; A1–A13: 11 条闭环+A11 路径闭环带 2 缺口+G3。报告 acceptance-report.md 含迁移 0122–0130 回退说明与 AC3 预留位。
- 裁决: G1（binding 终态无生产写者→retention 发现永不含生产 binding,A11 生产删除不可达）/G2（run 删除不清 id_links）/G3（检索摘要 write/read 形状错位）全部修复; O1（dataset 上游同步无生产接线）spec §8 外不修; O2（collector 不转发 traces 文档句）顺手修。
- 并行派发: T37fix=ctx_6093be44932d（同 worktree opik-t37-w,G1/G2/G3/O2+probe D 去直改重跑+门禁）; T37rev=ctx_6e8cf0962c2b（opik-t37-rev 只读,probe 证据真实性+A1–A13 抽查+缺口漏报核查+翻转正当性）。两票文件零重叠（rev 只提交自己报告）。
- 在途 2: T37fix、T37rev。

### 2026-10-17 T37-rev 通过 + Medium 追加给 fix 票

- T37rev（ctx_6e8cf0962c2b）worker_done d6a441fc: **Spec PASS / 证据质量 APPROVE**。全量复算一致（874/0、147/0、agent-langgraph 57/0、A1/A10 冒烟 52/0、typecheck）; 五 probe 内证一致（trace 贯通/计费 69/404/cancelled）; G1/G2/G3/O1/O2 代码级坐实; 翻转正当。新登记: 1 Medium（A13 容器导出半边证据弱于表述,collector 零 trace 段）+3 Low+2 Info。
- 裁决: Medium 追加给 T37fix（orchestration send 已达）——补最小真实容器导出冒烟,成本过高则如实登记 O3。真实栈 probe 未复跑(避免污染并行票,约定成立)。
- 已 ack+release 评审者。在途 1: T37fix(含追加项)。

### 2026-10-17 T37fix 完成 + 增量复审派发

- T37fix（ctx_6093be44932d）worker_done 64efdaf6+dd8b4fb6: G1=T07 store finish seam 唯一终态写者+reportBasicRun 路由/探针共用生产组合+守卫 RED→GREEN; G2=retention 删除事务内按 W3C trace 清 id_links; G3=写侧 kb_ids 裸串数组+round-trip 证明; O2 文档句; 追加容器导出冒烟 7/7(容器内 collector 出现真实 trace 段+backend 私有 API 逐字读回+collector 不转发佐证)。probe D 按生产终态重跑 16/16(GAP-CHECK 硬断言)。门禁: 888/0(874+14 新)、147/0、agent-langgraph 57/0、三 tsc 0、biome 0、build 过、无迁移。中途网关 502 事故两次停滞,coordinator 探活+降级指引后恢复。
- 已 ack+release。派发增量复审: ctx_3de240873bf2 / task_75d35654c8ee（pi,opik-t37fix-rev,2a468e63..dd8b4fb6,五项 RESOLVED 验证+门禁复算）。
- 在途 1: T37fix-rev。

### 2026-10-17 T37 整链集成完成——实现阶段收官

- T37fix-rev（ctx_3de240873bf2）worker_done ee16c591: **六项全 RESOLVED（G1/G2/G3/A13 容器冒烟/probe D 硬断言/O2）,Spec PASS / APPROVE**。门禁全新库逐数复现（888/0、147/0、57/0）; G2 RED 由复审独立复现; A13 现栈现场取证证实。2 非阻塞: Low（g2-red-retention.txt 文件误标为 GREEN 运行,RED 由复审复现证实）、Info（冒烟 stdout 未落仓）。
- 集成: 首次 cherry-pick 33af51fc..ee16c591 重复已完成序列制造 AA 假冲突（已知坑重现,abort）; 改挑 ae613f46..ee16c591 → **25ca47c9（T37 验收）→ 279ce1d0（fix）→ ece64bdc（冒烟）→ 0af5d9eb（fix-rev 报告）** + d6a441fc（T37-rev 报告,来自 opik-t37-rev 分支）→ **f536f743**。全部无冲突。
- 集成侧门禁: server tsc 0、opik 面 888/0/47（opik_t37_gate 新库 migrate+test）、app tsc 0+147/0、agent-langgraph tsc 0+57/0。
- **进度: 37/37 子票 + T-Routes + T37-fix 全部集成。实现阶段收官。** Issue #43 AC1/AC2/AC4/AC5 闭环;AC3(独立 review 已有 T37-rev+fix-rev;全范围 OCR 进行中)。
- 剩余: 全分支独立审阅（BASE bab7c0b9→f536f743+未提交）→ 外层 OCR（committed+workspace 两范围）→ finishing-a-development-branch。

### 2026-10-17 全分支终审 + T-Final 派发

- 终审（ctx_e7bd66de8ce6,claude/claude-fable-5-1/max,回执 requested 确认;worktree opik-final-review）worker_done ea572fdc: **Spec PASS(A1–A13 抽验成立)/ 安全 APPROVE / 质量 APPROVE**。关键发现: H1(高) basic-run 报告路由零挂载→bindings 生命周期与 port.createTrace 生产零调用,detail/steps 恒 404,retention run 链装配层不可达;M1(中) builtin scope 线程化未实施(T14/T15 注释明示归 run-association 票,该票从未开过);M2(中) manifest 信任锚=git 内 docs 文件+缺失静默降级;L1 setOverride 死面/L2 .env.example 缺 OPIK 变量/L3 billing 门双写;I1–I5(基线/登记)。计费幂等键无碰撞等正面确认。
- 集成终审报告 → **f7d4cd30**。
- 裁决: H1+M1+M2+L2+L3 必修,L1 给裁量,I1–I5 登记不修。派发 T-Final=ctx_abca880e5223（pi,opik-t-final,base f7d4cd30;含真实 builtin 执行端到端复验验收)。
- 在途 1: T-Final。OCR 排队于 T-Final 集成后。

### 2026-10-17 T-Final 完成 + 增量复审派发

- T-Final（ctx_abca880e5223,历经两次网关 502 停滞+coordinator 探活恢复）worker_done 9913898b: H1=basic-run 路由挂载(real-server proof); M1=builtin run scope 经 ALS carrier+生产 resolver 线程化(e2e 3/3 span 上游); M2=manifest 移 server/ai-observability/opik-contract/+boot sha256 指纹; L2 env 条目; L3 evaluationBillingReady 共享谓词; L1 如实延后(裁量)。门禁: 904/0(+16)、147/0、57/0、biome 零新、build clean;真实栈 e2e 25/25(挂载路由+真实 builtin 工具循环+retention sweep)。两条 production-truth notes: T14 观测绕过走计量模型路径;builtin id-links 保持惰性。
- 派发: TFinalrev=ctx_672b7aca649e（pi,opik-t-final-rev,f7d4cd30..9913898b 快审,H1/M1 真实性+两条披露评估+门禁复算）。
- 在途 1: TFinalrev。之后: 集成 → 外层 OCR(committed bab7c0b9..HEAD;集成 worktree clean,workspace 范围空) → finishing。

### 2026-10-17 T-Final 复审: M1 UNRESOLVED → 修复轮 2 派发

- TFinalrev（ctx_672b7aca649e）worker_done 26e74254: **Spec FAIL**——M1 UNRESOLVED(High): agent-resolver.ts:131-152 从未转发已注入的 resolveRunObservationScope,生产四入口 builtin 恒无 ALS scope 恒不上游写; 单测仅源文本断言、e2e 直调绕过断点。H1/M2/L2/L3 RESOLVED、L1 延后属实。证据可信度不 APPROVE: biome『零新诊断』不实(1 条未使用 import)、boot log 未入库。另登记: 生产无 setModelUsageMeter 接线(b616ccaa 移除)为 model-span 前提假设; id-links 惰性致上游副本不被本地删除链覆盖。
- 派发修复轮 2: ctx_8501e5ab46a2 / task_d5068a53107d（同 worktree opik-t-final;转发 seam+行为测试+e2e 经 createActorAgentResolver+biome/log+接线调查裁决）。
- 在途 1: TFinal-fix2。

### 2026-10-17 T-Final fix2 完成 + 终审闭环复审派发

- fix2（ctx_8501e5ab46a2）worker_done 9af964bf: M1=resolver 转发 resolveRunObservationScope+行为测试经 createActorAgentResolver RED→GREEN+真实栈 e2e 26 PASS(2 model+1 tool span 上游、detail/steps 200、生产入口); biome 零新诊断(17=17); boot log 入库; setModelUsageMeter 调查后登记为限制(重接改变计量语义)。门禁: opik 906/0(virgin DB)、147/0、57/0、3×tsc 0、build 0。
- 派发: TFinalrev2=ctx_d3a93edb0791（pi,opik-t-final-rev2,26e74254..9af964bf 快审）。
- 在途 1: TFinalrev2。通过后: 集成 T-Final 整链 → 外层 OCR → finishing。

### 2026-10-17 T-Final 整链集成 + OCR Round 1 + 双修复票派发

- TFinalrev2（ctx_d3a93edb0791）worker_done dc95c441: **M1 RESOLVED / APPROVE**(转发经四生产入口核实、行为测试真实 RED→GREEN、e2e 经生产入口 26 PASS 内部咬合; biome 17=17; boot log 入库; setModelUsageMeter 不接线理由成立——gate 预留+交付结算已整体替换 meter 事后记账,再挂=双记)。1 Low: e2e 实为 27 PASS 报 26(保守笔误,本 ledger 注记)。
- T-Final 集成: cherry-pick f7d4cd30..dc95c441 → **89601de9..17f482b0**(4 提交无冲突)。集成门禁: server tsc 0、opik 906/0(opik_tfinal_gate 新库)、app tsc 0+147/0、alg tsc 0+57/0。**T-Final 节点: 已验证并集成。**
- **外层 OCR Round 1**(coordinator 执行): provider z-ai-coding/glm-5.3(llm test 验证; anthropic 无凭据不可用,该 provider 唯一已配置,glm-5.3 为其最强档)。范围 bab7c0b9..HEAD committed(集成 worktree clean,workspace 范围空——dirty-files:0 已验证)。历程: 首跑 1h3m8s 被 coordinator 误杀于收尾;三次 --resume(7e036f5a→f00beb2e→a08af733→0835ce7f final),历经 glm 网关反复 502 挂起,终以 0835ce7f 完成输出。**结果: 160/160 文件,231 findings(3 critical/15 high/88 medium/125 low)**。证据: docs/plans/evidence/2026-10-16-issue4/ocr/{round1-committed.json,round1-summary.md,round1-background.md}。
- coordinator 核实: critical#1/#2(Outlet 缺失,全仓 Outlet=0,BotSubpage children 回调)属实;high#1/#8/#15(datasets/case-review 路由未挂载)属实;high#2(executions 无删除路径)**误读**——0126 trigger 级联通道存在。
- 派发并行修复: OCRfixS=ctx_d4ce73cbfa3c(pi,opik-ocr-fix-server: drizzle config 3 文件/0127 快照两键/datasets+case-review 挂载/retention upstream_done 降级/name 脱敏/ReDoS/ownership 排除法第二处/契约对齐/model-span trace 裁量/medium triage); OCRfixA=ctx_76bddd352b6f(pi,opik-ocr-fix-app: 两处 Outlet+渲染链守卫测试/app medium triage)。两票文件零重叠(app vs server/shared)。
- 在途 2: OCRfixS、OCRfixA。

### 2026-10-17 OCR 修复双票完成 + 集成 + 合并复审派发

- OCRfixA（ctx_76bddd352b6f）worker_done c8fb8828: critical#1/#2 修(runs/evaluations 父路由 child-active 时渲染 Outlet,详情替换列表各自带回链;守卫测试 createRouter 照 routeTree 同构组装,四生产路由文件,RED 3 fail→GREEN 5 pass);14 个 app medium 全部有效并修(17 新回归测试);门禁: app tsc 0、目标套件 181/0、全量 app 1578 pass/4 fail 基线字节一致 flake、build 0。
- OCRfixS（ctx_d4ce73cbfa3c,历经网关 502 多次停滞+探活恢复）worker_done fca07768..ea973afe(11 提交): 10 crit/high 全解决(c3+drizzle config 补 3 文件+快照 0126–0130 规范化经 drizzle-kit diff 4→0 spurious;h1/h8/h15/h14 datasets/case-review 挂载+契约投影+e2e 5/5;h5 name deny-scan;h7 upstream_done 不降级;h9 ReDoS 静态守卫;h10 ownership 显式判定双点;h6 model span W3C trace+override 半边登记限制;h2 预核实误读)。63 server/shared medium triage: 40 修+23 登记。0131 迁移(retention indexes)。门禁: opik 945/0(基线 906,+39)、app 147/0+build、alg 57/0、biome 净减(733 vs 736)。报告 9725d9ba(worker 直接提交集成 main)。
- 集成: OCR 证据 round1 三文件+9725d9ba+server 11 提交+app c8fb8828 → **287fb99e**。集成门禁: server tsc 0、opik 945/0(opik_ocr1_gate 新库)、app tsc 0+164/0、alg tsc 0+57/0。
- 派发合并复审: ctx_3c0e1c1d71a0（pi,opik-ocr-fix-rev,17f482b0..287fb99e,双结论+triage 抽验）。通过后 OCR round 2。
- 在途 1: OCRfixRev。

### 2026-10-17 OCRfixRev 结论(RC+FAIL) → 修复轮 2 派发

- OCRfixRev（ctx_3c0e1c1d71a0）worker_done e513dac2: **修复质量 RC + triage FAIL**。已核实成立部分: 3c+15h 修复真实、门禁精确复现(945/0/50 复审者自建 virgin 库 opik_ocr_fixrev1、164/0、双 tsc、biome 733 一致); h3/h4 快照规范化独立复算为真; 18 项 triage 抽验全成立。四项返工: ①F-H1 0131_snapshot.json 坏工件(仅 152/160 表,缺 5 ai 表;live→0131 快照独立 diff 15 语句含 5 DROP TABLE,"0 diffs" 声明为假); ②F-L1 server 10 文件 format 漂移+4 新 lint; ③F-H2 h2 误判 misread——executions 无删除路径/FK no action 钉死实验与 dataset 版本(23503 永久 RETENTION_TARGET_PINNED)属实且仍在; ④F-M1 m131 既未修也未登记,40/23 算术不吻合。另 F-L2(m176 10 路由 seam fail-open 推断,登记成立)/F-L3(app 报告日志未入库,gitignored application-config.ts 环境前置)。
- 已 ack+release 评审者。
- 派发修复轮 2: OCRfixS2=ctx_673bac93aa8e / task_514b605f2fa1（pi,复用 worktree opik-ocr-fix-rev@e513dac2。brief: ocr/fix2-brief.md。R1 0131 快照 live 序列化重做+0 diffs 硬验收;R2 biome --write 归零;R3 h2 按原案 A 事务内先删 executions(或 B 迁移级联)+TDD 配对测试;R4 m131 leaseMs=120_000+triage 账目重述。门禁全套。报告 ocr/fix2-server-report.md）。
- 在途 1: OCRfixS2。通过后: 增量定向复审(0131 快照复算+biome+h2 测试+m131) → 集成 → OCR Round 2。
- 事故记录: OCRfixS2 首派(ctx_673bac93aa8e)在 R1 钻研中遭遇网关/推理流冻结(↑162k ↓31k 静止 1.5h+,两次探活无效),Orca 重启(2026-10-17 晚)杀掉 worker,死前零提交(HEAD 保持 e513dac2,clean)。有价值遗留: /tmp/gen-live.ts 已验证配方(展平 import 后 generateDrizzleJson → /tmp/live-snapshot.json 160 表/7 enums)+复审者 /tmp/verify-diff5.ts 复算脚本,均已写入 brief 附录。
- 处置: worker-stop fence 旧 dispatch → retry-of 重派成功: **ctx_84d72fa936b3 / task_514b605f2fa1**(pi,复用 worktree opik-ocr-fix-rev@e513dac2,brief 含前次已知结果)。
- 在途 1: OCRfixS2-retry(ctx_84d72fa936b3)。
- 第二次停滞与拆票(17:24): retry worker ctx_84d72fa936b3 在 R1 完成(17:11-17:12,快照重做+验证 PASS 双向 0 语句,未提交)后 12 分钟无落盘,worker-stop。裁决: 连续两次长会话停滞,拆票降低单会话上下文压力——**票 A(ctx_7d0d6fef9325,同 task_514b605f2fa1 retry 链,worktree opik-ocr-fix-rev,含 R1 已完成现场的提交+R2 biome+R4 leaseMs+账目重述)+ 票 B(ctx_1c41637ae177/task_0e97c9c49261,新 worktree opik-ocr-fix-r3 自 e513dac2,R3 h2 executions 删除路径 TDD)**。两票文件零重叠。brief: ocr/fix2a-brief.md、fix2b-brief.md。
- 在途 2: OCRfix2-A、OCRfix2-B。

## 2026-10-17 18:15 — OCRfix2 双票完成 + 集成 + 集成侧门禁全绿

**双票结果**(两 dispatch 均 completed):
- 票 A(ctx_7d0d6fef9325 / task_514b605f2fa1,worktree opik-ocr-fix-rev):按原始 fix2-brief 完成**全部四项** R1-R4(拆票 brief 未送达,retry 派发携带的是原始 brief)。提交链 7385b446(R1+R2)→ d3353fb5(R3)→ 88e10c74(R4)→ a42950d4(报告)。门禁:server tsc 0 / 全新库 opik_ocr_fix2 全套 948/0/50 / app tsc 0 / biome 全仓 714≤733 触及 0 / R1 复算 PASS。
- 票 B(ctx_1c41637ae177 / task_0e97c9c49261,worktree opik-ocr-fix-r3):独立完成 R3(352de120),全新库 opik_fix2b@5547 全套 947/0/50。
- **双实现收敛**:两份 R3 补丁功能一致(retention.ts 同 17 行、测试同 144 行,仅注释措辞差异)——独立佐证。裁决:落 A 链,B 代码提交不落(避免重复),仅取其报告文件作佐证。

**集成**(opik-integration-main,BASE 287fb99e):
- cherry-pick:2ed18475(R1+R2)/ eed205b6(R3)/ ed81c088(R4)/ ea0c5791(报告);94a8873d(票 B 报告佐证,coordinator 提交)。
- 集成侧门禁(本机实跑):server tsc 0;全新库 opik_fix2int@5547 migrate ok + 全套 **948/0/50/3445**;app tsc 0;biome 全仓 490≤733(与 A worktree 现测一致;A 报告的 714 为其测量时点差异,门禁上限不受影响);触及文件仅 5 条 src/index.ts 预存 findings(与 base 287fb99e 同位置同内容逐字节核验);R1 复算脚本在集成树实跑 PASS(双向 0 语句)。

**下一步**:定向增量复审(R1/R3/R4/R2 四项返工的真实性独立复核)→ 通过后 OCR Round 2。

## 2026-10-17 18:30 — OCRfix2Rev2 通过(Spec PASS + Code APPROVE)

- 复审 worker ctx_9da0302d4267 / task_e8024c923563(worktree opik-ocr-fix2-rev2,base 94a8873d),报告 57e70cb8,已 cherry-pick 进集成 main。
- 逐项:R1 复审者自写独立脚本复算 0/0 语句双向 + id/prevId/journal/SQL 四不动 ✓;R3 同事务/flag/settled-only/守卫语义 + 两测试实质 + 0126 守卫-only 属实,retention 24/0 ✓;R4 生产 boot 读活 lease_until,boot 3/0 ✓;R2 触及 21 文件除 index.ts 5 条预存外 0 findings,全仓 714 ≤ 733 ✓;triage 63 口径独立复算闭合 ✓。
- 复审者自建 fresh 库 opik_fix2rev2:全套 **948/0/50**,server+app typecheck 0。
- findings:**0 critical/high/medium**;2 LOW(judge 二次 gateway 调用极端 case 撞 120s 租期边界—严格收窄非回归,建议后续 3× 或 case 后补 renew;retention 套件 7 次中 1 次 flake—取证不全,登记 CI 关注)+ 1 NIT(evidence 脚本硬编码 worktree 路径)+ 1 observation(跨 scope 异常 execution 停 PINNED 直至 reaper—fail-closed 一致)。全部登记为遗留,不阻塞。
- biome 口径注记:复审者与实现者在各自 worktree 全仓 714;coordinator 集成侧现测 490(bunx 解析口径差异),两口径均 ≤733 硬门,以 714 为准记录。

**下一步:OCR Round 2(全范围 bab7c0b9..HEAD,background=/tmp/round2-background.md)。**

## 2026-10-17 20:08 — OCR Round 2 完成(partial)+ 补跑 + 分诊派发

- **Round 2 主跑**(bab7c0b9..6cfd08ad,session 5b6649b4-270d-4ac0-ad9a-2b525f204f54,z-ai-coding/glm-5.3,18:23-20:03):**188 findings = 0 critical / 11 high / 50 medium / 127 low**;**partial**——164 项中 1 组失败(LLM 超时:case-review/comparison/results + routes ×3 + scoring/judge+rules 共 8 文件)。
- **补跑**:`--resume 5b6649b4… --timeout 60 -- OCR_LLM_TIMEOUT=600`(pid 46423)运行中,完成后覆盖缺口。
- **分诊**:round2-findings-raw.json(61 条 c/h/m)→ worker ctx_124a3d2dbefd / task_0742776a2116(worktree opik-ocr-r2-triage)三分类 V/D/F,重点自核 H0-H10(langgraph 命名/参数序、redaction {40}、datasets TOCTOU、rules 字符类、health 门控、judge 租约、copilot spanInput/terminal)。
- 11 high 初览:多数疑似真实新缺陷(非 round1 重复);H6 = fix2rev2 LOW#1 被 OCR 升 high(judge 二次网关调用的租期核算)。

## 2026-10-17 20:16 — 补跑裁决:覆盖成立

- resume(session 235b63af)未产生新失败(warnings null),总数不变 188。
- 核实:失败组(case-review/comparison/results+routes+scoring 共 8 文件)的 round-1 findings **已发布**(16 条,含 H2/H7 两条 high);组仅败于 round-2 后置过滤轮。分诊 worker 的逐条 V/D/F 验证(强于后置过滤)补齐该缺口。**裁决:OCR Round 2 覆盖成立,不重跑;最终修复后 Round 3 全范围复跑兜底。**

## 2026-10-17 20:39 — 分诊 worker 首派停滞,已 stop+重派

- 首派 ctx_124a3d2dbefd / task_0742776a2116:brief 输入路径误写相对路径(findings 文件在 coordinator 工作区),worker 陷入 `find /` 后 transcript 冻结 13+ 分钟零写入 → 20:38 stop。
- 重派 ctx_02f8aec09521 / task_19c00998691b(复用 worktree opik-ocr-r2-triage @6cfd08ad),brief 已改为内联 /tmp 绝对路径并明示"勿全盘搜索"。

## 2026-10-17 21:05 — Round 2 分诊完成:V 56 / D 5 / F 0

- 分诊 worker(ctx_02f8aec09521 / task_19c00998691b,commit 765df81a)已 cherry-pick 进集成 main(6cfd08ad 之后)。11 high 中 10 V + 1 D(R2-36);medium 45 V + 4 D;F=0。high 全部实证:H4/H7 真实执行复现、H3 读 manager.cjs 运行时分发、H8 全调用方扫描、H5 读事务语句。
- Round1 重报 15 条(low/docs 路径,从未入修复面)按 V 计。
- **coordinator 裁决**:
  1. R2-00/01/11 不升 Spec/ADR——A2 要求明确,是实现缺陷,修复方向无歧义(命名对齐 + 参数序 + 真实 graph 回归),按 AGENTS.md 冲突规则无需回设计层;
  2. R2-36(登记 LOW)随本轮修(租期 3× + 理由 + 配对测试);
  3. R2-21 orphan enterprise_run_events 并入迁移票(0132 显式 DROP + 前置零引用 grep 守卫);
  4. R2-33 状态词汇以真实实例 evidence 钉住,证据不足则登记;
  5. R2-13 镜像 digest 尽力修(registry 不可达则登记)。
- **修复组织(9 票两波,文件零重叠)**:W1=T1 langgraph(R2-00/01/11)/ T2 redaction+contract(R2-30/31)/ T4 scoring(R2-41)/ T7 app 守卫与页面(9 defect)/ T9 evidence 脚本+compose(R2-13..20,24,25,26,18);W2=T3 retention/datasets+迁移 0132(11 defect)/ T5 health-boot-lease(R2-45/58/59/36)/ T6 copilot-span(R2-52/53/32)/ T8 misc server(R2-33/29/40/46/47/48/55/56/57)。

## 2026-10-17 21:15 — R2 修复轮派发(9 票并行,base=集成 main @2fe18dcf)

| 票 | dispatch / task | 范围 |
|---|---|---|
| T1 langgraph | ctx_db7289736d80 / task_94a045e19ef5 | R2-00/01/11 + 真实 graph 回归 |
| T2 redaction+contract | ctx_da47bf3aed02 / task_f6dca1709028 | R2-30/31 |
| T4 scoring | ctx_b4c277e91fa1 / task_c924c993a22c | R2-41 |
| T7 app | ctx_de4977a6d71b / task_0159871b0115 | R2-08/06≡07/05/09/10/02/03/04/12 |
| T9 evidence+compose | ctx_c4dee83c4bf4 / task_61550d987854 | R2-13..20,24,25,26,18 |
| T3a datasets/experiments/retention | ctx_a089fc0acb7e / task_a69bbf486135 | R2-34/35/37/39/43/44 |
| T3b 迁移 0132 | ctx_071f73cdd210 / task_7e5ae1f471e3 | R2-22≡50/23≡27/49/21/42 |
| T5 health/boot/lease | ctx_ed36f4de9100 / task_55e78d819f08 | R2-45/58/59/36 |
| T6 copilot-span | ctx_ca859b022d71 / task_a3bd4b06f085 | R2-52/53/32 |
| T8 misc server | ctx_0b85ce66fdda / task_443083c633b3 | R2-33/29/40/46/47/48/55/56/57 |

覆盖:V 56 全部 + R2-36(D,裁决随修)+ R2-18(NIT)。文件零重叠已核对(T1/T9 共享 b-framework.ts 不同区域已互注;T5 禁 routes/admin-summary.ts;T3a/T3b 文件集互斥)。

## 2026-10-17 21:28 — 限流事故与处置

- 9 pi 并发触发账户级 429(code 1302 速率限制):T7/T3a/T6 brief 递送被拒、零进展。其余 6 票(T1/T2/T4/T9/T3b/T5/T8 中活跃 6 个)无 429。
- 处置:stop T7(ctx_de4977a6d71b)/T3a(ctx_a089fc0acb7e)/T6(ctx_ca859b022d71),保留 6 票运行;三票待空位释放后按原 brief 重派(worktree 可复用)。
- 教训:pi 账户并发上限 <9,后续波次 ≤6 并发。

## 2026-10-17 22:05 — T2 完工收账;T7 重派

- **T2 完成**:dispatch completed 但 worker 未提交,coordinator 核读报告(RED→GREEN 齐全、958/0 全新库 opik_r2t2、typecheck 0、biome 714/触及 0)后代提交 **e3938c87**(R2-30 {40,}+sk-ant- / R2-31 终扫可触发)。
- T7 重派:ctx_d2671ea62b29 / task_014cf4d4f29d(复用 worktree,原 brief)。现役:T1/T4/T9/T3b/T5/T8/T7 = 7。

## 2026-10-17 22:11 — T4 完工;T3a 重派

- **T4 完成**:fd415afa(R2-41 字符类切片修复,自提交,worktree clean,dispatch completed)。
- T3a 重派(复用 worktree,原 brief)。现役:T1/T9/T3b/T5/T8/T7/T3a = 7。已收:T2(e3938c87)、T4(fd415afa)。

## 2026-10-17 22:15 — T5 完工(3/4);R2-58 移交 T6

- **T5 完成**:d26aaa8d(R2-45 门控自愈保持 fail-closed / R2-59 listAll / R2-36 lease 180_000+断言收紧 2×);R2-58 受阻移交(copilot.ts 归 T6)。dispatch 状态 failed(升级问题挂起),成果已提交、worktree clean。
- T6 重派含 R2-58。现役:T1/T9/T3b/T8/T7/T3a/T6 = 7。已收:T2(e3938c87)、T4(fd415afa)、T5(d26aaa8d,3/4)。

## 2026-10-17 22:25 — T1/T6 收官

- T1:84de7e1a(命名对齐+handleChainStart runtime 序,自行提交,dispatch completed)。
- T6:ed02d4c0(capture 上下限+fragments 裸值+R2-58 scope 于 doStream 入口捕获,自行提交,completed)。
- 已收 5/10:T1 84de7e1a / T2 e3938c87 / T4 fd415afa / T5 d26aaa8d(3/4)/ T6 ed02d4c0。在途 5:T9/T3b/T8/T7/T3a。

## 2026-10-17 22:40 — 9/10 完工;仅 T7 在途

- **T9**:a7275ed7(6 镜像 digest 锚定 registry 实测;e2e/probe 断言硬化;fix2-r1-verify 可移植)。coordinator 代提交(dispatch completed 未自交)。守卫 fixture 1 行机械维护已裁可。
- **T3b**:72ac57dd(0132:3 索引 + DROP orphan 表;快照双向 0 diff;boundedInteger 严格解析;opik_r2t3b 949/0)。内存高压 flake 已如实记录并复跑澄清。
- **T8**:fab1cee7(9 项全;opik_r2t8 959/0/51;R2-33 词汇以 evidence 钉死、ONGOING 未证注明;契约断言入 tsc 范围)。app fixture 2 行机械补字段已裁可。
- **T3a**:4f2d8112(自提交)。
- 已收 9/10;T7(ctx_d2671ea62b29)在途,dirty=18。

## 2026-10-17 23:10 — R2 修复轮全部集成,集成侧门禁全绿

- **T7**:42c31936(app 守卫深化 9 defect,本票 134/0,4 存量失败为 round1 已证基线同款)。
- cherry-pick 10 票全部零冲突:333dc866(T1)/36d38cf0(T2)/4c8a76db(T4)/dd8619ec(T5)/9cb1b605(T6)/4d5d42d2(T9)/faf58168(T3b)/ac0e9bef(T8)/01ff6f85(T3a)/0d3ebbca(T7)。
- **集成门禁**(全新库 opik_r2int):server/app/agent-langgraph 三端 tsc 0;全套 opik **1001/0/51**(基线 948+53 新增);langgraph 60/0(含 T1 真实 graph 回归);biome 全仓 490≤733;**0132 快照复算 PASS**(live↔0132 双向 0 语句;0131→0132 恰 3 CREATE INDEX;enterprise_run_events 物理 DROP 在 SQL 层,快照层 0131 起本就不含该表,一致)。
- app 全量后台复跑中(/tmp/r2int-app-full.log;预期 1591/4 存量)。
- **下一步**:R2 修复轮独立复审(范围 2fe18dcf..HEAD)→ OCR Round 3。

## 2026-10-17 23:50 — R2 修复轮复审:Spec PASS(带残留)+ Code APPROVE(1M)

- 复审 ctx_e5635b891e08 / commit cf69e39b(已 cherry-pick 进集成 main)。55/57 项独立验证成立(高危项全部自跑复算:R2-30 十样例、R2-41 十三形状、R2-11 自读 manager.cjs、T9 digest registry 实测、0132 复算)。复审自有库 opik_r2rev2:1001/0/51、三端 tsc 0、langgraph 60/0、触及 biome 9 既有+1 新增(F-4)。
- **findings**:F-1(M)= R2-40 app 半边未落地(completed 导出下载空数组,发布前必须修);F-2=R2-51、F-3=R2-54 两项 low 为**coordinator 派单遗漏**(非 worker 失败);F-4 = T1 测试文件 1 条 import 排序;F-5/F-6 观察(T37 证据需实例重跑换证;node_modules 环境项)。
- 处置:派 T11 单票收尾(F-1+F-2+F-3+F-4)→ 集成 → 门禁 → **OCR Round 3**。

## 2026-10-18 00:12 — Orca 重启事故与 T11 重派

- Orca 重启杀掉 T11 首派(ctx_7bb29d62080f,仅留 TODO.md 零提交);重派 ctx_fdb331a86e01 / task_60da5c7306cd(复用 worktree,brief 附重派注记与报告获取路径)。

## 2026-10-18 01:18 — T11 二次中断与三次重派

- Orca 第二次重启杀掉 T11 retry2(ctx_fdb331a86e01),现场已覆盖全部四项(11 文件未提交)。重派 retry3,brief 附"接手现场勿重写"注记。

## 2026-10-18 01:45 — T11 收官;R2 循环闭合;OCR Round 3 启动

- **T11**:4f731393 → 集成 86344b5c。四项全落地:F-1a 下载走 artifactUrl+fail-closed、F-1b upstreamTruncated 双语渲染、F-2 lastCollectedAt 双重诚实化(3 集成测试)、F-3 头注、F-4 biome。worker 历经两次 Orca 重启 + 一次宿主机重启 + 一次 429,三次重派后交付。
- T11 后集成门禁:root typecheck 0/0/0;全新库 opik_r3int 全套 **1004/0/51**(首轮 1000/4 为宿主机重启后负载 flake,复跑 0 fail);langgraph 60/0。
- 覆盖核算:R2 循环 57/57(56V+R2-36)+ 复审 F-1/F-4 全部落地;R2-18 NIT 随 T9。
- **OCR Round 3 启动**(bab7c0b9..HEAD,background=/tmp/round3-background.md,z-ai-coding/glm-5.3)。

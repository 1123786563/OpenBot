# Opik T32/#38 采集入口认证与控制面/私有 API 保护——接线立项书

> **2026-10-31 ｜ 立项书，未实施**
>
> 票：#38 [Opik T32] 采集入口认证与控制台/私有 API 保护（父 Spec #4 Opik 自托管聚合；覆盖验收域 A4/A5/A13；Blocked by #15 已解除——T09 已 PASS）。37 子票中唯一未闭合项。
>
> 输入基线：四份深读报告（built-auth / ingest-path / control-plane / prior-rulings）、方案评审胜出书（方案 C）+ 评审嫁接要点 + 对抗验证推翻项；关键锚点已在本仓逐一根验。

---

## 0. Spec 约束（六组，全文有效，任何实施切片不得违反）

1. **Opik 整体可选、禁用零影响**：一切新面（ingest 路由、control-plane 席位、铸币）挂在 `OPIK_ENABLED==='true'` 门后，沿用 absent = not mounted 挂载合同与诚实 `capability_missing`/503 词汇；禁用部署的行为与今日**逐字节相同**（含未认证请求的响应码，见 §2.3 修正）。
2. **身份单源**：`ControlPlaneActor` 只能是 `deploymentRequireUser` 已确立的应用身份（id+OpenBotRole）；新代码零表零 schema 零 db 导入；不建第二套 Opik 用户库；企业 Spec 落地时只替换 `hasPlatformQualification` 这一个谓词（`server/src/enterprise/tenancy/observability-authz.ts:33-38` 预留位，`qualifiesForDeploymentObservation` 是其企业侧范例：tenant_admin 结构性拒绝）。
3. **两把钥匙永不互换 + fail-closed**：`InternalProducerCredential.verify` 不接受 actor（会话不是 ingest 材料）；有效生产者令牌到达控制面必得 403 `PRODUCER_NOT_AUTHORIZED_FOR_CONTROL_PLANE`（凭据不是身份）；missing≡wrong 同答 401 `PRODUCER_AUTH_REQUIRED`；五枚错误码-状态码映射（control-plane-auth.ts:101-127）已冻结并由测试穷举守护，接线层不得改写。
4. **凭据卫生**：凭据只在受信 wiring 内 `issue()` 铸币（256 位随机）、进程内引用交接；不读 env、不落盘、不进任何序列化/inspect/日志/错误/证据（toJSON 与 inspect.custom 双脱敏，control-plane-auth.ts:174-181）；上游 `OPIK_API_KEY` 与内部凭据互不派生（签发永不读环境）。
5. **冻结版本与契约清单**：Opik 2.2.100 digest 锚定不浮动；写路径只经已验证的 `port.writeSpans`/`createTrace` 契约（opik-http.ts:51-60 必备能力复验），零清单外端点；ownership drift 挂起语义（按 scope 挂写、操作员重启解除）保留；`OPIK_API_KEY` 语义不变（其裸值 authorization 头格式受 R4-18 约束，未验证前不靠猜扩展）。
6. **企业面 fail-closed 与非目标**：本票不读任何 `ENTERPRISE_*` 变量，无企业通道时 /api/enterprise 全 503 的语义零触碰；**不做**私有 API passthrough、不新增观测数据面与用户可见 Opik 数据（run-detail 无控制台链接现状保持）、不改上游镜像与 digest（`docker/compose/opik.yml` 是本仓自有裁剪栈，端口声明属本仓文件）；不扩 Spec 非目标。

---

## 1. 背景与设计边界

### 1.1 为何 BUILT NOT WIRED

T32 交付的 `server/src/ai-observability/control-plane-auth.ts` 是一个**纯策略模块**：两扇门、且没有任何一把钥匙能开两扇门——

- **内部生产者凭据** `InternalProducerCredential`（:136-182）：`issue()` 进程内 `randomBytes(32)` 铸币（:144-148，无导出构造路径）；`verify()` 双侧 sha256 摘要后 `timingSafeEqual` 常时比较（:161-171），非字符串在 coercion 前拒绝。
- **控制面授权** `authorizeControlPlane`（:190-221）：决策序为未知资源→403 `CONTROL_PLANE_RESOURCE_UNKNOWN`（:202-204）；actor 缺失/畸形时凭据验真则 403 `PRODUCER_NOT_AUTHORIZED_FOR_CONTROL_PLANE`（机器身份被识别并被拒绝），否则 401 `AUTH_REQUIRED`（:207-213）；非 admin→403 `PLATFORM_QUALIFICATION_REQUIRED`（:216-218）；唯一通过形 `{ok:true, actorId}`。

全仓 grep 证实：`server/src` 内**零生产调用方**（仅 observability-authz.ts:36 与 integration-evidence.ts:164 两处注释/证据引用），唯一行使者是它自己的测试套件 `server/tests/opik-control-plane-auth.test.ts`。文件头 :26-31 自述 WIRING STATUS = **BUILT, NOT WIRED**（OCR m118），预留 seam 面向未来的 in-process ingest 路由或私有 API passthrough——该意图只活在头注释里，不在调用图上。

### 1.2 私有 loopback 边界的出处

T32 的部署保护实际以 **compose 反代 loopback 绑定**而非进程内认证入口落地：

- `docker/compose/opik.yml:329-330`：前端反代 5174 仅绑 `127.0.0.1`/`[::1]`（双栈）；`opik.yml:364-369`：OTLP 5418(http)/5417(gRPC) 同样仅 loopback 发布；backend 8080 不对外发布，只经前端 nginx 反代。
- `reference/opik.md:38-39`：所有发布端口只绑 loopback；`:81-84`「控制面访问」条款明文：#38 完成前实例只应 loopback 运行、不得暴露网络、不得当作已受保护控制面。
- 由此形成的事实边界：**同宿主机任意进程可未认证直写** `127.0.0.1:5418` 或 `5174/v1/private/otel/v1/traces`（带 projectName 头即被接受）；远程主机被 loopback 绑定挡住。模块头 :40-43 自己声明：本模块只在 seam 证明策略，单靠它不构成对已部署端点的保护。

（注：模块头 :43 引用的「T32 implementation report」未在归档/证据目录找到独立文件；部署主张的既有事实载体只有 reference/opik.md 该节。本立项书 PR3 将以正式访问规则文档补齐这一缺口。）

### 1.3 五轮终审为何判 UNVERIFIABLE

R1–R5（final-review-codex.md:159、-r2:167、-r3:189、-r4:138、final-review-r5.md:129/143）一致维持：**UNVERIFIABLE——BUILT NOT WIRED 设计边界（私有 loopback）；无整实例入口证明**。机理：#38 的验收是对「已部署整实例」的运行期主张，需要「整实例生产入口 + 内部 producer 未认证拒绝」的联合证明；模块单测只在 seam 层证明策略，loopback 绑定是部署配置而非认证入口。同时实例未暴露、无公开攻击面，评审拒绝无证指控公开越权。接线正是把这条 UNVERIFIABLE 变为可取证事实的唯一路径。

### 1.4 现状控制面与采集面（信任域盘点）

- **入站写面（OpenBot 自身）**：唯一一个是 `POST /api/ai-observability/bots/:botId/runs`（basic-run 报告，routes/index.ts:121-143），挂根级 requireUser+1MiB bodyLimit 之后，认证完整。
- **ingest 生产者全是进程内观察者**：builtin model-span/tool-step/remote-run 记录器（runtime.ts:8356-8458）经 observer 绑定门与有界写队列调 `port.writeSpans`/`createTrace`；OpenBot **无任何入站 span/trace HTTP 端点**。
- **对 Opik 上游**：出站走 opik-http.ts 单一适配器（writeSpans→`POST {baseUrl}/v1/private/otel/v1/traces`，:1065；createTrace→`/v1/private/traces`，:895）；认证仅可选 `OPIK_API_KEY` 裸值 authorization 头（:428-443，格式未对真实 key 验证，R4-18）。
- **整实例控制台与私有 API**：由 compose 前端容器发布，不经 OpenBot app/server 任何代理，浏览器无通路，App 不收 Opik 凭据，run-detail 无控制台链接（app/src/components/ai-observability/run-detail.tsx:236-238）。应用角色检查对它**不在场**——保护纯靠 loopback。
- **企业侧**：observability-authz.ts 的 AC1–AC4（公司查询/导出/trace 链接/部署级门）同样已建未接路由（MT124-126/MT138 下游）；无 `ENTERPRISE_*` 通道时企业面全 503。

---

## 2. 决策

### 2.1 选定：方案 C——进程内 ingest 路由 + 部署边界收口（停发 OTLP 宿主端口）+ authorizeControlPlane 规则席位；**拒绝私有 API passthrough**

理由：

1. **凭据铸币与验真同进程**：无跨重启共享秘密、无第二份持久化材料，`InternalProducerCredential` 的类合同（进程内铸币、一次性交接、全脱敏）原样成立，模块零改动。
2. **不动上游、不耦合两栈可用性**：passthrough 需要代理任意私有端点——违反冻结契约清单纪律（不引入 47-manifest 未覆盖的操作），且 Opik 控制台可用性会被 OpenBot 进程重启绑架。
3. **401 取证即一条 curl**：未认证写入拒绝的证据形状（父计划 Task 1 Step 4：真实冒烟中未认证请求必须 401/403，凭据 header 用部署配置且不进报告）在自有路由上最易取得且可复跑。
4. **停发 5418/5417 收掉平行未认证写面**：`reference/opik.md:41-45` 已明言本栈 otel-collector 只 debug-export 不转发、无合法消费方；服务端写走 5174 反代。停发后「绕过内部凭据直写 OTLP」的路径消失。
5. **控制面规则可成文、可真机取证**：五资源判定经 `authorizeControlPlane` 席位发布，与企业替换位（hasPlatformQualification）零冲突。

落选方案一句带过：**私有 API passthrough**（代理整实例私有 API 供 admin 使用）——被拒，如上 2；其可取部分以下列嫁接点吸收。

### 2.2 评审嫁接点（全部吸收进本设计）

1. **ingest 每批活体重授权**（嫁接 Opt1/方案一）：复用 `createExportReauthorization` 模式（wiring.ts:96-133：活角色 resolveActor→manage gate→explicitObservationOwnership→活 epoch→重派 ObservationScope）；在 bindings store 补 `byOpikTrace` 的**无 scope 只读**查找变体（既有 `byOpikTrace(scope, opikTraceId)` 在 bindings.ts:173/:509 是 scope 键控的；ingest 门需要按 opikTraceId 返回 botId+记录 actorId 的 scope-less 变体，不复制 drift 逻辑）。效果：生产者凭据单独**不足以**写入；凭据失窃也写不进已降权/已转移的 run。
2. **projectName 由部署 locator 派生**，生产者不能选 project——写进 ingest 契约并用测试钉死（防投毒到他人 workspace）。
3. **Handoff 产物一以独立决策表成文**（五资源×actor 决策表 = authorizeControlPlane 冻结语义逐格成文 + ingest 机器门规则 + 部署边界条款），独立于任何端点存在；`/control-plane` 席位只回同一规则，评审对照真实冒烟响应码逐行核表。
4. **pre-guard bodyLimit 纪律**（嫁接 Opt2）：index.ts:107 是 requireUser+bodyLimit 同一 `use()`；本设计让 ingest 路由注册在根 use() **之内**（继承全域 bodyLimit），若实现改选注册其外则必须自带 bodyLimit——两种形态均以 413 测试钉死（房规配对 OCR m174）。
5. **守卫覆盖三重防线测试**：会话守卫必须罩住全部非 `/ingest` 兄弟路由、绝不罩 `/ingest`；路由清单钉死「无 /opik 代理路径」；文件头注释声明。防注册顺序/路径豁免被后续编辑破坏。
6. **Handoff 产物二的成文受信发放通道**（嫁接方案一/A）：C 原答「跨进程唯一 sanctioned=第一方 harness」撑不起票面字面要求；补一个约 60 行的 **admin 资格凭据交接端点**（一次性展示语义+审计记录+轮换 runbook；v1 不轮换登记为已知限界），见 §3.6。是否进 v1 列 open question 1。
7. **上游 API-key 姿态的可选加固侦察**（嫁接 Opt1，Phase 0、不入本票范围）：先用 `server/scripts/opik-contract.ts` 清偿 R4-18（Authorization 头 scheme/casing），再探测冻结 2.2.100 backend 能否对 ingest 强制 API-key 认证；可行则「无 key 直写 5174→401」留作后续票依据，不可行则把 5174 残留风险升格为「冻结版本下已证不可闭合」，终结该 open question。
8. **E5 端口面不变式**（嫁接 B）：compose 冒烟断言「唯一 published 端口是 5174（loopback）」并入取证——把 5417/5418 停发从一次性改动变成被钉住的端口面不变式。
9. **mTLS 边缘登记为已声明未来升级路径**（嫁接 Opt2/B）：写入 reference/opik.md 附录（多进程宿主场景），连带两条纪律——任何新传输路径不得 disable 证书校验（`rejectUnauthorized:false` 类捷径写进验收测试禁止）、证书轮换程序必须先于任何启用写入文档。
10. **证据卫生双向 token-grep**（嫁接方案二）：冒烟响应与 server 运行日志**双向** grep 为空作为 E2 硬通过条件（原方案只承诺 token 不入证据目录）。

### 2.3 对抗验证推翻项（必须吸收的修正）

原方案把 index.ts:107 根守卫无条件改为「路径条件豁免 /ingest/*」，被推翻：禁用部署（producerCredential 缺席、ingest 不挂载）中，未认证 `POST /api/ai-observability/ingest/**` 会从今日的 **401**（requireUser 在路由匹配前发出）变为 **404**，与「禁用→逐字节相同」自相矛盾；且这是对覆盖全部既有观测路由的唯一认证门的无条件改写，回归面扩大（差异仅在会话模式；单用户 dev 模式 requireUser 直答无此差）。

**修正**：豁免做成**凭据条件式**——`deps.producerCredential` 在场才使用路径条件守卫，缺席则原样 `routes.use("*", deps.requireUser, bodyLimit(...))`；守卫覆盖测试新增钉死「禁用 boot 下 /ingest/* 未认证仍 401」。

---

## 3. 接线设计

### 3.0 总原则

**模块零改动，只增调用方**。control-plane-auth.ts 的导出面、错误码、决策序、脱敏合同一行不动（其自身测试套件以零改动为基线）；`hasPlatformQualification` 仍是定义恰好一次、被咨询恰好一次的唯一谓词（测试 :348-355 钉死）。

### 3.1 路由层

**① `server/src/ai-observability/routes/index.ts`**

- `AiObservabilityDeps`（:53-96）增两项可选 dep：`producerCredential?: InternalProducerCredential`、`reauthorizeIngest?: ExportReauthorization`（或等价重授权闭包）。缺席 = 不挂载，沿 :10-13 的 absent = not-mounted 合同。
- 根守卫（:107）改为**凭据条件式**（§2.3 修正）：

```ts
// producerCredential 在场才豁免机器门路径；缺席则与今日逐字节相同。
const sessionGuard = deps.producerCredential
  ? sessionGuardExempting("/ingest")   // /ingest/* 跳过 requireUser，其余全罩
  : deps.requireUser;
routes.use("*", sessionGuard, bodyLimit({ maxSize: 1024 * 1024 }));
```

  bodyLimit 全域保留（ingest 因此继承 1MiB 上限，满足嫁接点 4；文件头注释声明豁免边界）。
- 在兄弟子路由处挂载两个新面（均受 absent=not-mounted 约束）：

**② 新建 `server/src/ai-observability/routes/ingest.ts` —— `POST /ingest/traces`（AC1 的门）**

门序（逐层 fail-closed）：

1. **唯一身份门 = `producerCredential.verify(请求头)`**：missing≡wrong 同答 401 `PRODUCER_AUTH_REQUIRED`（control-plane-auth.ts:161-171），无近失信号；会话永不出现在此门（verify 不吃 actor）。
2. **归属门**：payload 须携带既有 run binding 的 opikTraceId；经 bindings store 新增的 `byOpikTrace` 无 scope 只读变体（既有实现 bindings.ts:509 为 scope 键控）查得 `{botId, actorId}`；无归属→4xx 拒绝（不泄露绑定存在性）。
3. **每批活体重授权**（嫁接点 1）：以绑定行的 actorId 过 `createExportReauthorization` 同款链路（活角色→canManageBot→explicitObservationOwnership→活 epoch→ObservationScope）；null→拒绝该批。凭据单独不足以写入。
4. **同管线写入**：经与进程内记录器**同一** T05 投影/redaction 与 healthService 有界写队列入 `port.writeSpans`——不绕背压/drift 挂起语义（这是实现红线，评审须专项核）；`createTrace` 强制携带 run binding 的既有规则不变。projectName/locator 由服务端从部署配置与绑定行派生，生产者提供的路由字段一律丢弃（嫁接点 2，测试钉死）。
5. **port null 语义**：凭据门通过但部署无已验证 port（manifest 缺失）→ 写入答诚实 503 `capability_missing`（auth 先行，保持 fail-closed 与诚实词汇）。成功→202（已入队）。

**③ 新建 `server/src/ai-observability/routes/control-plane.ts` —— `GET /control-plane` 规则席位（AC2/AC4 的门）**

- 位于根会话守卫之内（非 /ingest 路径，先过 requireUser），再对五资源逐一 `authorizeControlPlane({ actor: context.var.actor, resource, producerCredential, offeredProducerToken: 请求头 })`。
- **只回判定矩阵与访问规则文本**，不回任何配置值/凭据/connection-config 字段。
- 响应形状：admin→200 + 五资源全 `{ok:true, actorId}` 矩阵；普通用户→403（body 携带五资源拒判矩阵，均为 `PLATFORM_QUALIFICATION_REQUIRED`）；无会话→401 `AUTH_REQUIRED`（根守卫先答）；呈有效生产者令牌→403 `PRODUCER_NOT_AUTHORIZED_FOR_CONTROL_PLANE`。
- 与席位同文件：`POST /control-plane/producer-credential/handoff`（§3.6，PR4，可独立弃置）。

**④ 不建任何 passthrough**：私有 API 唯一可达通道保持为服务端已验证 port + 受信 ObservationScope（每 bot manage gate 已测）；路由清单测试钉死不存在 `/opik` 代理路径（嫁接点 5）。`server/src/assembly/http.ts:2363` 单挂载行不动；requireUser 用共享 `deploymentRequireUser`（runtime.ts:8225-8227，OCR m209），不二次构造。

### 3.2 boot 铸币与注入（`server/src/assembly/runtime.ts`）

- 在 :8180-8191 的既有门（`opikBootConfig.enabled && baseUrl !== null`，与 port 加载同一快照语义）内：`InternalProducerCredential.issue()` **每 boot 单次铸币**；同点构造 ingest 重授权闭包（复用 wiring.ts:63-84 `createActorResolver` + :96-133 模式）。
- :8224-8259 的 `createAiObservabilityRoutes` 注入 `producerCredential` 与重授权 dep（与 bindings:8232、port:8234 同点）。
- 禁用/缺 baseUrl → 不铸币、两新面不挂载、根守卫保持原样——禁用部署逐字节同今日（含 /ingest/* 未认证仍 401）。
- 不读任何 env 发放凭据；`OPIK_API_KEY`（:8189 透传缝）语义不变。

### 3.3 部署收口（`docker/compose/opik.yml` + 文档钉）

- :364-369 **删除 5418/5417 四行宿主端口发布**（otel-collector 保留无宿主端口；其只 debug-export 不转发，reference/opik.md:41-45 明文，无合法消费方）。旧文档跟随者得到响亮的 connection refused（非静默）。
- :329-330 的 5174 维持双栈 loopback 不动。
- 同步 `reference/opik.md` 端口表（:28-39，删 5418/5417 行）、:41-45 注记、:63 故障排查行；同步 `server/tests/opik-deployment.test.ts:133` 文档钉，并新增「唯一 published 端口 = 5174 且仅 loopback」断言（嫁接点 8 的不变式）。

### 3.4 AC 逐条覆盖表

| AC | 实现（how） | 取证（evidence） |
| --- | --- | --- |
| **AC1** 采集入口要求内部生产者认证；未认证写入被拒绝 | `POST /ingest/traces` 唯一身份门=`InternalProducerCredential.verify`（control-plane-auth.ts:161-171），missing≡wrong 同答 401；归属门+每批活体重授权+同管线有界写入 `port.writeSpans`；deps 缺席=不挂载 | E1：真栈 curl 无凭据→401 `PRODUCER_AUTH_REQUIRED`、错凭据→**逐字节相同** 401；E2：harness 持据 POST→经已验证端口读回 canary 落库；E5：停发后 curl 5418→connection refused（无平行未认证写面）；单测钉 401 形状、413、not-mounted、守卫覆盖 |
| **AC2** 整个控制面（含私有 API）受保护，私有 API 不能绕过应用角色检查 | 不建 passthrough（路由清单测试钉死无 /opik 代理路径）；私有 API 唯一通道=服务端已验证 port+ObservationScope（每 bot manage gate 已测）；`/control-plane` 席位对五资源逐一过 `authorizeControlPlane`，有效生产者令牌被识别并拒绝为身份（control-plane-auth.ts:207-213） | E3：真机会话冒烟——普通用户→五资源全 403；持生产者令牌头→403 `PRODUCER_NOT_AUTHORIZED_FOR_CONTROL_PLANE`；admin→200 规则矩阵；既有 per-bot manage gate 套件保持绿 |
| **AC3** 使用现有身份系统，不建第二套 Opik 用户库 | `ControlPlaneActor` 只取 `deploymentRequireUser` 已确立的 AuthenticatedActor（runtime.ts:8227 同源注入）；新路由零表零 schema 零 db 导入；模块源码扫描测试（无 db/schema/drizzle/userRoles 导入）沿用并扩展到新路由文件 | E3 的真实登录态同时证明身份来源=应用会话；源码扫描套件（opik-control-plane-auth.test.ts:343-346 同款）扩展绿 |
| **AC4** 普通用户不能读取连接配置、管理诊断或凭据；整实例控制台仅限相应平台资格 | 五资源判定全走 `authorizeControlPlane`（普通用户=403 `PLATFORM_QUALIFICATION_REQUIRED`）；connection-config/management-diagnostics/credentials **维持零用户面**（config 仅存服务端 env；席位只回规则不回值）；整实例控制台的平台资格以拓扑声明落定：唯一通路=宿主 loopback=宿主操作员访问，写进 reference/opik.md 与席位规则；企业落地只换 `hasPlatformQualification` 一个谓词（替换位不动） | E3：普通用户五资源 403 矩阵真机记录；E5：`docker compose ps --format json` 证 5174 仅 loopback、5418/5417 未发布；新增 payload-scan 测试钉所有用户可达观测 payload 无 connection-config/凭据键（兼裁决 admin-summary 边界） |

### 3.5 Handoff 产出物一：控制面访问规则（成文形态）

落位 `reference/opik.md`「控制面访问」节改写（PR3），独立于任何端点存在；`/control-plane` 席位返回同一规则的机器可读形。内容三块：

**(a) 五资源×actor 决策表**（= authorizeControlPlane 冻结语义逐格成文，评审对照 E3 冒烟响应码逐行核表）：

| 资源 \ 请求者 | admin（应用会话） | user（应用会话） | 无会话 | 呈有效生产者令牌 |
| --- | --- | --- | --- | --- |
| console | 允许（`{ok, actorId}`） | 403 PLATFORM_QUALIFICATION_REQUIRED | 401 AUTH_REQUIRED | 403 PRODUCER_NOT_AUTHORIZED_FOR_CONTROL_PLANE |
| private-api | 同上 | 同上 | 同上 | 同上 |
| connection-config | 同上 | 同上 | 同上 | 同上 |
| management-diagnostics | 同上 | 同上 | 同上 | 同上 |
| credentials | 同上 | 同上 | 同上 | 同上 |
| 未知资源 | 403 CONTROL_PLANE_RESOURCE_UNKNOWN（全行） | | | |

注：console 与 connection-config 等当前共用同一 admin 谓词（资源粒度未分级）——这是封闭集的既定语义；若产品要求更细资格分层（如仅运维可及诊断），属扩 `ControlPlaneResource` 判定的显式决策，不在本票（见 open question 5）。

**(b) ingest 机器门规则**：会话不是材料；唯一身份门=凭据 verify（missing≡wrong 401）；写入另需归属绑定+每批活体重授权，三重缺一即拒；projectName 由部署侧派生。

**(c) 部署边界条款**：接线完成后原 :81-84 loopback-only 过渡条款由认证与规则替代，但拓扑事实保留——整实例控制台唯一通路=宿主 loopback=宿主操作员（拓扑强制）；任何 OpenBot 中介访问必过 `authorizeControlPlane`（现=admin 角色，企业落地只换 hasPlatformQualification 一个谓词）；私有 API 仅服务端已验证端口+ObservationScope 可达，无浏览器通路且以测试钉死不新增；同宿主机多进程部署的 mTLS 与上游 API-key 升级路径列入附录（含禁 `rejectUnauthorized:false`、轮换程序先于启用的纪律，嫁接点 7/9）。

### 3.6 Handoff 产出物二：内部生产者凭据发放方式（成文形态）

1. **铸币**：每 boot 在受信 wiring 内 `InternalProducerCredential.issue()` 单次铸币（256 位随机，base64url）；进程内引用交付受信 wiring（类自身 toJSON/inspect 全脱敏）。
2. **卫生**：不读 env、不落盘、不序列化、不入日志/错误/证据；token 只在受信交接时读一次；`OPIK_API_KEY` 永不成为内部凭据（签发路径零 env 读取，测试源码扫描钉死）。
3. **轮换**：v1 = 进程重启（重启使一切已发放 token 失效；现无进程外持据者）。轮换程序写进 reference/opik.md。
4. **跨进程发放的 sanctioned 通道**（两条）：
   - **第一方 harness**：`server/scripts/opik-e2e-ingest.ts` 增 `--internal-producer` 模式——同进程铸币、token 只读一次、仅用于冒烟写、永不入证据目录与日志（E2 双向 token-grep 硬门）。它同时是参考生产者实现。
   - **admin 资格交接端点**（PR4，约 60 行，可独立弃置）：`POST /control-plane/producer-credential/handoff`，守卫=`authorizeControlPlane(resource:"credentials")`；**一次性展示语义**（响应体返回当前 boot 铸币的 token，审计行记录发放者与时间，token 永不入日志——日志捕获断言钉死）；v1 不重铸不吊销，登记为已知限界。
5. 成文位置：reference/opik.md 发放契约节 + 交接端点行为说明。

---

## 4. 实施切片（最小 PR 序列）

| 切片 | 内容 | 测试与门禁 |
| --- | --- | --- |
| **PR0 侦察**（前置，不入本票范围，先于关票） | `server/scripts/opik-contract.ts`：一验 R4-18 Authorization 头 scheme/casing；二探冻结 2.2.100 backend 能否对 ingest 强制 API-key 认证 | 产出只写结论入 open question 2 与后续票依据；不动生产代码 |
| **PR1 部署收口** | opik.yml:364-369 停发 5418/5417；reference/opik.md 端口表/注记/排查同步；opik-deployment.test.ts:133 文档钉同步 + 「唯一 published 端口=5174 loopback」不变式断言 | opik-deployment 套件绿；T37 e2e ingest 对改动后 compose 复跑绿（E6 前置）；server 全测试无回归 |
| **PR2 ingest 路由 + 条件守卫 + 铸币** | routes/index.ts deps+条件守卫（§3.1①）；routes/ingest.ts；bindings `byOpikTrace` 只读变体；runtime.ts 门内铸币+注入（§3.2） | 新 `server/tests/opik-ingest-route.test.ts`：无头→401、错 token→逐字节同答、对 token→202 且写经队列探针入 writeSpans、无归属→4xx、超限 body→413、deps 缺席/禁用 boot→不挂载且 **/ingest/* 未认证仍 401**（禁用逐字节等价）、守卫覆盖钉（罩全部非 /ingest 兄弟、绝不罩 /ingest）、重授权吊销用例（角色降级/转移后旧绑定拒写）、projectName 派生钉；路由清单钉（无 /opik 代理）。门禁：opik 全套件绿 + control-plane-auth 原套件零改动绿 |
| **PR3 control-plane 席位 + 访问规则成文** | routes/control-plane.ts（GET 席位）；reference/opik.md :81-84 改写为 §3.5 三块 + 升级路径附录 | 席位测试：普通用户五资源 403、admin 200 矩阵、生产者令牌头→403、无会话 401、payload 无任何配置/凭据键；admin-summary 等用户可达面 payload-scan；文档钉同步。门禁：套件绿 |
| **PR4 凭据交接端点**（可独立弃置，待 open question 1） | §3.6-4b 交接端点 + audit 行 + 轮换 runbook | 非 admin→403、admin 一次性展示、日志 token-grep 空（捕获断言）、审计行写入；门禁：套件绿 |
| **PR5 真机取证与证据回收** | opik-e2e-ingest.ts `--internal-producer`；执行 E1–E6；integration-evidence.ts:156-171 basisRefs 补 E1–E5、MT110 供应商半边注记更新（ingest 半边已真机验证） | §5 全部通过条件满足（含双向 token-grep）；关票材料齐 |

每片共同门禁：server `bun test` 全绿；format/lint 用锁定 biome 2.5.10 判定且不新增增量诊断（main 基线红另案处理，不以本票修复）。

---

## 5. 真机取证计划（真实 2.2.100 digest 栈 + `OPIK_ENABLED=true` + 已迁移 DATABASE_URL）

| 编号 | 取证 | 通过条件 |
| --- | --- | --- |
| **E1 未认证写入 401** | 起栈起 server，curl 无凭据 / 错凭据 `POST /api/ai-observability/ingest/traces` | 两响应均为 401 `PRODUCER_AUTH_REQUIRED` 且**逐字节一致**（diff 为空，无近失信号）入证据目录 |
| **E2 持据写入落库** | harness `--internal-producer` 同进程铸币、真实 HTTP POST | 经已验证端口 REST 读回 canary 落库；**双向 token-grep**（证据工件 + server 运行日志）为空是硬通过条件 |
| **E3 会话冒烟矩阵** | 真实登录态（本地已登录调试会话配方取普通用户+admin）：普通用户调 `/control-plane`、持生产者令牌头调、admin 调 | 依次 403 矩阵 / 403 `PRODUCER_NOT_AUTHORIZED_FOR_CONTROL_PLANE` / 200 规则矩阵；评审对照 §3.5(a) 决策表逐行核 |
| **E4 禁用零影响** | `OPIK_ENABLED` 未设 boot | ingest 与席位均不挂载（会话内 404）、无铸币；未认证 `/ingest/*` 仍 401（逐字节同今日）；全套件绿 |
| **E5 端口面不变式** | `docker compose ps --format json` + `curl 127.0.0.1:5418` | 唯一 published 端口=5174 且仅 loopback 绑定；5418 connection refused（响亮非静默） |
| **E6 既有栈零回归** | 既有 T37 e2e ingest 套件对同栈复跑 | 全绿 |

证据回收：`server/src/enterprise/tenancy/integration-evidence.ts:156-171` opik-observability 条目（enabled-unverified，ownerTicket MT110）basisRefs 补 E1–E5，注记改为「隔离三环 + 采集入口半边已真机验证；查询/评测半边仍缺凭据」。

---

## 6. 风险与回退

**风险（按序）与缓解**：

1. **根守卫改造是最大手术点**（index.ts:107 是全部既有观测路由的唯一认证门）：豁免过宽=某路径意外失去会话门。缓解：凭据条件式守卫（§2.3）+ 三重守卫覆盖钉 + 禁用 boot 逐字节等价测试 + 会话/单用户两模式都测。
2. **ingest 路由今天无生产消费者**（远程 AG-UI 上报走 basic-run 会话路由），是为取证与未来生产者建的受认证入口，攻击面净增。缓解：最小契约+fail-closed+1MiB bodyLimit+每批重授权；且这是票面二选一的明示形态。
3. **5174 反代残留旁路**：同宿主机进程仍可未认证直写（宿主=信任域）。进程级认证需改上游，冻结 2.2.100 禁止。缓解：诚实写入部署声明；PR0 侦察后按结论定性（后续票可收 vs 冻结版本下已证不可闭合）；多进程宿主启用上游 API-key 姿态列为可选加固（T37 证据史 z8e- key 先例）。
4. **外部 span 绕过 T05 投影/redaction 会击穿 credential-shaped canary 防线（T37 A4）**：设计强制同管线，这是实现红线，评审专项核。
5. **1MiB bodyLimit 可能拒大 span 批次**：按现行 house 配对保留，文档化上限。
6. **每 boot 铸币=重启使持据外部生产者失效**（现无此生产者）：轮换语义=重启，写进发放契约与 runbook。
7. **停发 5418/5417 的文档跟随者**：得 connection refused（响亮非静默）；文档钉与端口表同步。
8. **admin-summary 无连接配置/凭据字段系深读结论，未逐字段复核**：payload-scan 测试即裁决，以测试为准。
9. **交接端点自身是揭示 token 的新面**：admin 资格门+审计+一次性展示语义+日志 grep 断言；若产品不收，PR4 整片可弃（见 open question 1）。

**回退**：单次 revert PR1–PR4 提交群（路由两文件、index.ts 守卫与 deps、runtime.ts 注入、opik.yml 端口、reference/opik.md、integration-evidence basisRefs、测试与 harness 扩展）——模块回到 BUILT-NOT-WIRED，其自身测试套原样绿；无 schema/数据迁移、无凭据持久化可清理；compose 侧 `docker compose up -d` 即恢复端口声明。禁用部署全程无感知（本就未挂载未铸币）；已启用部署回退后采集入口消失，但进程内观察者写路径不受影响（它们从不经过该路由）。

---

## 7. Open Questions（需用户/产品拍板）

1. **交接端点进 v1 还是仅 runbook 成文**：PR4 约 60 行补齐 Handoff 产物二的字面交付，但引入一个揭示 token 的端点（admin 门+审计+一次性展示已缓解）；不收则跨进程发放仅剩第一方 harness，需用户确认该口径足够。
2. **PR0 侦察的三分支处理**：R4-18 头格式验证失败或 2.2.100 backend 不支持 ingest API-key 认证时，5174 残留风险定性为「冻结版本下已证不可闭合」并仅留 mTLS/隔离宿主为升级路径；成功则开后续票做上游 API-key 收口（含 key 轮换 runbook）。结论出来前本票按「部署声明」处理。
3. **企业面 `hasPlatformQualification` 替换时序**：先于本接线（则席位上线即企业语义）还是后于（则 v1 以应用 admin 角色运行、替换位不动）？两套已建判定（app admin 角色 vs `qualifiesForDeploymentObservation`）接线时须择一并废弃另一路径，本立项书默认后者（v1 应用角色，企业落地时只换谓词）。
4. **admin-summary 边界口径确认**：其服务端不做 admin 角色检查（靠 accessFilter+manage gate 收窄）是否符合 AC4 口径——本票以 payload-scan 测试钉「用户可达 payload 无连接配置/凭据键」为裁决，需产品认可该边界而非要求整体 admin 化。
5. **资源粒度分级与未来进程外生产者**：五资源共用单一 admin 谓词是否满足产品对「诊断仅运维可及」类分层的需求（扩 `ControlPlaneResource` 判定是显式决策）；ingest 路由的第一真实进程外消费者是谁、其契约是复用 observer 绑定门/写队列语义还是新的最小写契约。
6. **线上票面未核项**：github.com/1123786563/OpenBot issue #38 是否有本地快照（.archive/runs/2026-10-24-opik-issue4/scope/issues/issue-38.json）之外的补充评论；模块头引用的「T32 implementation report」独立文件未在归档找到，PR3 的成文规则即其替代载体
---

## 附：本文锚点核验记录（2026-10-31）

落库前对全文引用的 file:line 锚点做了两组独立抽查（compose 端口、reference/opik.md 条款、routes/index.ts 守卫与 absent=not-mounted 合同、assembly/http.ts 单挂载行、observability-authz.ts 替换位、integration-evidence basisRefs、runtime boot 门与 routes 注入、wiring 重授权、opik-http R4-18 注、run-detail 无链接、deployment 文档钉、谓词单点测试），全部命中。一处锐化：`bindings.byOpikTrace` 并非新建——scope 键控实现已在 bindings.ts:173/:509，新增的是无 scope 只读变体（上文已改）。

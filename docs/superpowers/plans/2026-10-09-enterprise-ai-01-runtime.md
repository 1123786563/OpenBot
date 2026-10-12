# Go Agent 运行时验证实施计划

> **面向执行 Agent：** 使用 `subagent-driven-development` 或 `executing-plans` 逐任务执行。本次仅修订文档，不运行命令；历史勾选保留为历史组件进度，不代表本轮复验或生产准入。

**文档基线：** `enterprise-mvp-v0.2`，2026-10-09；决策、共同契约、门禁分别见总计划 §1、§4、§6。当前整个 MVP 不引入 OpenFGA/OPA。

**目标：** 验证 tRPC-Agent-Go 经现有 TS HttpAgent 协议接缝和新企业治理回调工作。R1–R4 仅评估 G1a 候选；G1b 持久安全及 G2 试点验收通过前，不承载真实租户或真实副作用。

**架构：** Go 不接管租户、数据库、授权或模型供应商密钥。TS 验证签名和成员身份，Go 使用受验证的上下文；整个候选可禁用，不影响遗留通道。

**技术栈：** 独立 Go module、标准库 HTTP、tRPC-Agent-Go 与其 AG-UI 子模块、Bun/Hono 契约测试。

**规格：** [总体方案](docs/superpowers/specs/2026-10-09-enterprise-ai-platform-design.md)；基线与全局约束见 [总计划](docs/superpowers/plans/2026-10-09-enterprise-ai-00-master.md)。本轮修订对应[评审报告](2026-10-09-enterprise-ai-documents-review.md)的运行时及跨文档问题。

## 全局约束

- “一个数据域一个写入方。”Go 无业务库访问权限。
- “运行引用具体版本，不能在执行中解析 latest。”
- 不接受客户端 actorId/userId 为身份，不将签名密钥交给 Go。
- R1–R4 完成后仅可申请 G1a（协议与身份候选）；G1b 依赖 T1–T3、E1–E4、P2–P4、D2/D4 的持久安全证据，G2 另验收业务、SLO、恢复和双部署。完整门禁以总计划 §6 为准。缺失分册或测试不可用不能记为通过。
- 本册所有新增数值上限是建议的验证配置，不是既有项目实测性能或框架保证。
- 测试 fake 模型只用于确定性协议测试，真实业务效果须另用授权评测数据验证。
- 所有提交步骤均需用户另行授权，不自动 commit。

---

## 文件职责

`runtime-go/cmd/runtime/main.go` 启动；`internal/identity/` 可信上下文；`internal/adapter/agui.go` 框架接缝；`internal/callback/client.go` TS工具回调；`internal/server/` 健康、限流与认证；`testdata/` 无凭证协议样本；`server/src/enterprise/runtime/validation-routes.ts` 签名验证路由；`server/tests/enterprise/runtime-contract.test.ts` TS契约；`server/scripts/enterprise-runtime-probe.ts` 启动真 Go 验证的测试协调器。

## 当前状态与片段使用方式

2026-10-09 复核：runtime-go module、identity/adapter/callback/server 组件已存在；`cmd/runtime/main.go` 仍仅挂健康服务。R1/R2 的历史 `[x]` 保留，R3旧版勾选合并为R3历史记录；均不代表修订后合同已实现，也不重写历史执行授权。以下是新增待完成差量：

- [x] 对齐 §R2 的企业信封与 R2-B 真实进程装配，不仅测试 Handler。（2026-10-10 R4-A 验证收口：R2-B①②③ 全部实证——契约测试构建并启动实际 `cmd/runtime` 二进制，经真实 middleware 链（gate→auth→TrackExecutions→RequireVerifiedInput→RouteByExpert）与框架 Runner，由 TS HttpAgent 消费真实 `/internal/enterprise/v1/runtime/execution` 路由，16/16 通过）
- [x] 将 R3 遗留回调替换为企业 prepare/execute＋操作回执契约。
- [ ] 补可信输入、事件语义、故障恢复/取消、依赖风险复核与 R4 证据。

代码块除明确完整的测试外均为接口/算法片段，须由所属步骤补齐导入、Schema、装配与故障测试；不能仅复制片段标记整步通过。现有文件优先局部修改，路径存在时禁止重新初始化或覆盖。

## R1：冻结依赖并建立最小可测试 HTTP 服务

**文件：** 已有 `runtime-go/go.mod`、`go.sum`、`internal/server/health.go`、`health_test.go`、`cmd/runtime/main.go`、`dependency-review.json`；读取后按差量修订，不重建覆盖。

**接口：** `server.Health(ready func() bool) http.Handler`；`GET /health/live` 与 `GET /health/ready` 分离；不探测付费模型。

- [x] 先核对 G0 与现有文件，给下述测试创建文件。

```go
package server
import (
    "net/http/httptest"
    "testing"
)
func TestReadinessIsNotLiveness(t *testing.T) {
    h := Health(func() bool { return false })
    for _, c := range []struct{ path string; code int }{
        {"/health/live", 200}, {"/health/ready", 503},
    } {
        w := httptest.NewRecorder()
        h.ServeHTTP(w, httptest.NewRequest("GET", c.path, nil))
        if w.Code != c.code { t.Fatalf("%s: %d", c.path, w.Code) }
    }
}
```

- [x] 历史初始化记录：module名openbot/runtime-go；当前已存在，不再初始化。原候选提交`9bb1c42b968c659124a5bb76eb6a676d546442a1`的AG-UI子模块曾核对下限Go 1.24.4，但该数字不是推荐当前工具链；以实际完整依赖图最高下限和受支持安全补丁为准。工具链不可用不是行为RED；风险处置按R4-B，不因历史勾选忽略扫描问题。

```bash
go test ./internal/server -run TestReadinessIsNotLiveness -count=1
```

首次实现时RED应来自Health缺失；当前文件已有实现，重跑只能记回归，不为制造RED删除既有代码。进入新候选修订前先比较已有依赖图，再按批准版本锁定；不盲目tidy或覆盖现有安全修订：

```bash
go get trpc.group/trpc-go/trpc-agent-go@9bb1c42b968c659124a5bb76eb6a676d546442a1 trpc.group/trpc-go/trpc-agent-go/server/agui@9bb1c42b968c659124a5bb76eb6a676d546442a1
go mod tidy
go mod verify
go list -m all
go version
```

记录真实解析版本、sum、工具链与漏洞报告到dependency-review.json；不要复制上游的本地replace指令。module已存在，上述依赖锁定命令仅适用于获批的新候选修订，不要求每次执行go get。进入实施先读取已有go.mod/go.sum和风险报告，再确定是否需安全升级；绝不覆盖用户现有module或把旧扫描当本次结果。

- [x] 实现健康检查与显式地址参数、优雅关闭；read-header 超时和 body 限额在 R2 业务 handler 增加。

```go
package server
import "net/http"
func Health(ready func() bool) http.Handler {
    m := http.NewServeMux()
    m.HandleFunc("/health/live", func(w http.ResponseWriter, r *http.Request) {
        w.WriteHeader(http.StatusOK)
    })
    m.HandleFunc("/health/ready", func(w http.ResponseWriter, r *http.Request) {
        if !ready() { w.WriteHeader(http.StatusServiceUnavailable); return }
        w.WriteHeader(http.StatusOK)
    })
    return m
}
```

- [x] 运行上述测试、`go test ./...`、`go vet ./...`。检查仅新增候选文件；为后续审查保留独立差异。

## R2：验证身份后才进入 AG-UI Runner

**文件：** 核对并局部修订 `runtime-go/internal/identity/context.go`、`context_test.go`、`internal/adapter/agui.go`、`internal/server/auth.go`、`auth_test.go`、`server/src/enterprise/runtime/validation-routes.ts`、`server/tests/enterprise/runtime-validation.test.ts`；缺失测试按需新增，不覆盖已有候选。

**消费：** 总计划§4的RuntimeInvocation与短期能力、独立服务身份、TS权威Run/成员/委托/lease映射。旧 `readRunAssertion`/Agent token只用于隔离历史兼容fixture，不作为企业运行凭证；旧payload不能用客户端tenant/principal字段补全。

**产出：** `VerifiedRun`对应wire映射，包含下方结构全部字段；ModelRouteRef/BudgetReservationID必填，计划发起还需DelegationRef。TS `createRuntimeValidationRoutes` 仍依赖显式verify注入，但正式verify必须认证服务并查询权威事实，无默认允许实现。G1a使用无外部副作用的测试账本；正式接线依赖T1–T3/E1–E2。旧BotID只能在适配层映射专家版本，不作为全局主体键。

- [x] 编写拒绝测试，不先请求模型。

```go
package identity
import (
    "context"
    "testing"
)
func TestMissingVerifiedIdentityIsDenied(t *testing.T) {
    if _, err := FromContext(context.Background()); err == nil {
        t.Fatal("unverified caller accepted")
    }
}
```

TS验证测试按v1合同重写：缺少服务认证返回401；已认证但body缺必填字段返回400；Schema合法但capability无效/过期返回401；可信身份与run/attempt/turn不匹配返回403；TS无法查询权威账本返回503且Go不启动模型。fixture必须包含总计划§4.2完整信封并在测试内签发测试能力，不能只提交旧body.assertion却期待新接口接受。测试可在子路由挂载后调用本地路径，但真实进程测试必须验证完整 `/internal/enterprise/v1/runtime/validate` 路由和服务身份。

- [x] 运行 `go test ./internal/identity -count=1`（Go目录）与 `bun test server/tests/enterprise/runtime-validation.test.ts`（根目录）观察 RED。
- [x] 实现可信上下文。只有 auth middleware 调用 WithVerified；模型与请求 payload 不得自行生成该上下文。

```go
package identity
import (
    "context"
    "errors"
)
// Interface sketch: exact wire parsing and expiry validation belong to auth middleware.
type VerifiedRun struct {
    TenantID, PrincipalID, ActorID, InitiatorKind string
    RunID, AttemptID, TurnID, ThreadID, ExpertVersion string
    InputDigest, ModelRouteRef, BudgetReservationID string
    LeaseID, FencingToken, ExpiresAt, DelegationRef string
}
type key struct{}
func WithVerified(ctx context.Context, v VerifiedRun) context.Context {
    return context.WithValue(ctx, key{}, v)
}
func FromContext(ctx context.Context) (VerifiedRun, error) {
    v, ok := ctx.Value(key{}).(VerifiedRun)
    if !ok || v.TenantID == "" || v.PrincipalID == "" || v.ActorID == "" ||
        v.InitiatorKind == "" || v.RunID == "" || v.AttemptID == "" || v.TurnID == "" ||
        v.ThreadID == "" || v.ExpertVersion == "" || v.InputDigest == "" ||
        v.ModelRouteRef == "" || v.BudgetReservationID == "" ||
        v.LeaseID == "" || v.FencingToken == "" || v.ExpiresAt == "" {
        return VerifiedRun{}, errors.New("UNAUTHENTICATED_RUNTIME")
    }
    return v, nil
}
```

TS内部验证端点只接收strict RuntimeInvocation＋认证头内短期capability，验证服务身份、受众、期限、input_digest、tenant/principal/run/attempt/turn/thread/expert/lease/fencing绑定及当前成员/委托。缺字段400、无效服务/能力401、有效身份但绑定不符403、依赖不能验证503。返回最小VerifiedRun，不返回用户全对象/签名秘密。Go middleware先验证平台服务身份，再向固定内部TS验证地址请求；限时、禁重定向、限制body/response，验证和expires_at解析成功后才WithVerified。历史body.assertion格式不属于新企业wire契约，旧测试作为遗留回归单独保留，不能替代新信封测试。

- [x] 用实际已核对的框架接口实现适配函数 `New(a agent.Agent) (http.Handler, func() error, error)`，所有 Runner 使用同一可信解析器。

```go
func ResolveUser(ctx context.Context, in *adapter.RunAgentInput) (string, error) {
    v, err := identity.FromContext(ctx)
    if err != nil { return "", err }
    if in == nil || in.RunID != v.TurnID || in.ThreadID != v.ThreadID {
        return "", errors.New("RUN_BINDING_MISMATCH")
    }
    data, err := json.Marshal([]string{v.TenantID, v.PrincipalID, v.ExpertVersion})
    if err != nil { return "", err }
    return string(data), nil
}
```

函数导入context/encoding/json/errors、内部identity与框架adapter；R2-B规定New和实际main的装配步骤，不能把本解析器当完整服务。StateResolver不合入客户端state，显式关闭ReasoningContent/EventSourceMetadata；清空forwardedProps，能力留在私有context。FromContext只作已验证上下文完整性断言，Schema/期限/initiator枚举及计划触发必须带delegation_ref由middleware先检查。

- [x] 历史组件测试记录：同thread不同tenant、伪造actor、过期签名、禁用Token、验证503、超大body、重定向、私有state。该记录不覆盖v0.2新增信封/真实进程验收，须完成以下差量。

### R2-B：真实服务装配与可信输入

`New(a agent.Agent) (http.Handler, func() error, error)` 为adapter内部构造合同；不是可跳过启动接线的“完整实现”。在锁定SDK上将同一可信UserIDResolver、空StateResolver、输入校验Hook装配到真实Runner/AG-UI Handler；显式关闭ReasoningContent/EventSourceMetadata，清空客户端forwardedProps。构造失败清理已经创建的session/runner资源。

- [x] 实际main加载严格配置→建立固定TS验证/模型代理客户端→构建固定专家/工具目录→构建adapter.New→装配服务认证及请求上限middleware→挂内部执行/cancel路由→监听成功后ready。未配置能力/专家/可信端点则503，不回退固定user。
- [x] 监听及非付费依赖预检成功才能ready；liveness只检查进程。SIGTERM先draining/ready=false，再停止新Run、限时取消/排空，确认退出并关闭adapter；超时上报未退出/未知而非成功。
- [x] 实际二进制通过TS HttpAgent验证，不能只直接调用handler。所有具体HTTP路径/限额/错误Schema由R/E合同冻结，无配置禁止启动企业模式。（2026-10-10 验证：`bun test server/tests/enterprise/runtime-contract.test.ts` 16/16 通过——探针协调器现直接 `go build ./cmd/runtime` 启动真实二进制（严格配置、专家目录、gate、企业执行/取消路由），HttpAgent 打真实 `/internal/enterprise/v1/runtime/execution`；合成 launcher 已删除。既有 `/agui/` 合成路径不再存在，无需保留 fixture 场景）

| 输入字段 | 权威来源与验证 |
|---|---|
| 新用户内容/受限选项 | 用户可提供；大小、附件归属和Schema校验，不具有系统指令权限 |
| system/developer指令、专家版本、工具Schema、模型路由 | TS已批准不可变配置；Go校验input_digest/expert_version/route，不从用户messages/tools覆盖 |
| 历史assistant/tool结果 | TS账本已确认消息/回执引用；拒绝用户伪造历史工具结果 |
| state/forwardedProps | 默认不合入；内部身份/能力只在Go私有context，不转发到AG-UI事件 |
| resume/检查点/审批 | TS读取已确认checkpoint并复核审批/当前成员，签发新的受限invocation；拒绝任意客户端resume对象 |

摘要基于双方冻结的规范序列化与字段白名单；不各自散列不同JSON顺序。新增负向测试覆盖系统消息注入、伪造tool结果/Schema、路由改写、错误摘要、未获批resume、当前lease不符。个人thread按tenant/principal/expert版本键隔离，版本切换需平台明确创建/迁移上下文；共享会话未纳入MVP。

## R3：工具操作信封、回执与取消边界

**文件：** 局部修改已有 `internal/callback/client.go`、`client_test.go`、`internal/server/cancel.go`、`cancel_test.go`、`internal/adapter/agui.go`；新增TS `runtime-callback.test.ts`。正式工具账本/ActionPolicy属于P3，R3不得复制一套授权库。

**历史记录：** 旧版本R3曾将无HTTP重试、取消和race测试步骤标记为完成；本次保存这一历史，不确认当时结果。旧 `{run,name,args}`、`Result{Text,IsError}` 不满足企业操作合同，以下差量全部待实施验收，不能继承旧勾选。

### R3-A：调用合同与单写边界

- [x] Go `Prepare(ctx, ToolPreparation)` 与 `Execute(ctx, ToolExecution)` 使用总计划§4.2的strict wire Schema；服务身份/短期能力来自私有context，不能由模型args提供。prepare固定调用内部 `tool-invocations/prepare`，execute固定调用 `tool-invocations/{operation_id}/execute`。旧 `/api/agent-tools/call` 不挂企业入口，也不是故障回退。（2026-10-09 验证：runtime-go/internal/callback 严格编解码＋两端点固定路径＋凭证仅取自 identity 私有 context；TS 侧 fake 端点 server/src/enterprise/runtime/tool-invocations.ts；Go 回调不再引用旧入口，遗留 /api/agent-tools/call 拒绝语义回归保留在 runtime-callback.test.ts）
- [x] 平台以 `(tenant,run,tool_call_id)` 去重分配operation_id并绑定step、目标、参数摘要、安装版本；执行attempt另建。模型重复提议已提交/未知操作时进入核对，不通过新tool_call_id绕过；真正新意图需新的用户/确定性工作流决策及授权。（G1a fake 语义＋测试：复用 operation、异参数409、新 tool_call_id 同内容撞已冻结操作→409 reconciliation_required；G1b/P3 持久账本仍按 R3-C 矩阵另行验收）
- [x] prepare返回操作引用、是否需审批与安全预览，不执行外部操作；execute复核当前成员/ACL、专家安装授权、ActionPolicy、审批参数/期限、预算、lease/fencing。身份、目标、摘要冲突拒绝，不从调用方补全可信字段。（fake 以单一可观测 recheck 边界表达成员/ACL/安装/ActionPolicy/预算＋审批期限/参数与 fencing 断言，测试逐一断言；正式授权库属 P3 未复制。可信字段（tenant 等）仅来自 capability，body 冲突一律拒绝）
- [x] 回执至少含 `operation_id,execution_attempt_id,status,receipt_ref,error_code,reconciliation_required`；status限定not_submitted/submitted/succeeded/failed/unknown。`submitted/unknown`不可当一般工具错误传给Agent任意重试，必须持久化并将Run置为suspended/待核对。只有可信回执证明结果后再推进业务状态。（运行时侧验证：GovernedTool 对 submitted/unknown/冻结/需审批以 StopError 终止 Run，模型不再被询问、无重试面；回执字段与状态枚举两侧 strict；业务 Run suspended 状态机属 E 域，G1a 以 fake 冻结操作＋回执表达，G1b 账本另验）

### R3-B：传输、失效与取消

- [x] HTTP标准库编码strict请求，NewRequestWithContext绑定取消；服务凭证单独注入，固定地址、禁重定向、有界body/response和总超时。验证响应Schema与operation绑定；上限是测试配置，需容量验证。日志不记录秘密/参数正文/原始错误body。（2026-10-09 验证：callback.Client 新增总超时（无配置客户端也受界，`TestTotalTimeoutBoundsThePlaneCall`）、execute 回执 operation_id 必须与请求一致（`TestExecuteBindsTheReceiptToItsOperation`）、上下文取消直达调用（`TestContextCancellationReachesThePlaneCall`）、错误文本不携带凭证对（`TestErrorsNeverCarryTheCredentials`）；strict 编码/固定地址/禁重定向/有界响应/凭证仅私有 context 为既有测试继承复验。2026-10-09 二轮补齐有界请求 body：`MaxRequestBytes`（1 MiB 测试配置）在 dial 前拒绝超限序列化请求，RED→GREEN 见 `TestOversizedRequestsAreRefusedBeforeDial`（ErrInvalidWire 本地决定性拒绝、plane 零调用，非 unknown）
- [x] execute一旦开始发送而未得到可信回执，传输错误/解析失败/异常状态保守记unknown；只有能够证明请求未提交或服务端明确拒绝且未执行时可记not_submitted。无自动HTTP重试仍不等于业务幂等，P3的持久账本才阻断跨调用/跨进程重放。（2026-10-09 验证：HTTP 超时（既有 `TestExecuteDoesNotRetryUnknownOutcome`）、响应破损（`TestBrokenAnswerIsOneAttempt`，单次尝试）、回执 ACK 丢失（`TestLostReceiptAckIsNotResubmitted`，plane 已花费+连接中断，不重发）均不自动重试且 errors.Is(ErrOutcomeUnknown) 可机器判定；unknown 可查询＝TS fake 冻结操作后 re-prepare 报 reconciliation_required、二次 execute 409（runtime-callback.test.ts「an unknown receipt freezes the operation and the freeze stays queryable」）；404/400/422/401/403/409 分类为既有测试复验）
- [x] 取消按已验证 `{tenant_id,principal_id,run_id,attempt_id}` 查执行上下文，验证当前fencing；响应只为cancel_requested。实际模型/子进程退出才确认cancelled，已提交工具继续保留reconciliation，不承诺撤销外部业务。（2026-10-09 验证：新增 internal/server/executions.go 执行上下文注册表（进程内、按全元组记 fencing、TrackExecutions 随响应结束释放）；Cancel(canceler, executions) 全元组未命中 404 且不触 canceler（`TestCancelLooksUpTheExecutionContextByTheVerifiedTuple` 覆盖别 attempt/别租户/别主体）、fencing 不符 403 不动执行（`TestCancelRefusesStaleFencing`）、仅答 cancel_requested 与模型不响应取消保持/清理语义为既有测试复验；main.go 与探针 launcher 已接线）
- [x] Go重启清空本机执行态，不伪报旧Run继续运行；E2/D2收回lease并对账已确认checkpoint/receipt，再签新attempt。审批后更新短期能力必须重鉴权，禁止ignoreExpiry。（2026-10-09 G1a 范围验证：`TestRestartClearsLocalExecutionState` 证明新进程注册表为空、旧 Run 取消 404 不伪报；E2/D2 lease 回收对账属 E 域、G1b 另验；能力重鉴权＝每次调用重新验证 capability（fake `authenticate` 拒过期、无 ignoreExpiry），重签能力即刻可用且过期原件持续 401（runtime-callback.test.ts「a re-issued capability re-authenticates per call」），Go auth 中间件逐请求验证+本地期限复查为既有测试复验）

### R3-C：验收矩阵

| 用例 | 预期 | 阶段 |
|---|---|---|
| HTTP超时、响应破损、回执ACK丢失 | 不自动重试execute；unknown可机器判定并可查询 | G1a fake；G1b持久账本 |
| 相同业务操作跨Agent轮次/Activity/进程再次执行 | 复用operation，不重复副作用；异参数409 | G1b/P3 |
| 已批准参数/目标改变、审批到期、成员撤销 | 拒绝或重走批准，不沿用旧allow | G1b/T/P |
| 旧fencing、别租户、别主体、不同attempt调用或取消 | 拒绝且不调用模型/工具 | G1a与G1b |
| 模型不响应取消、子进程未退出 | 保持cancel_requested或明确失败，不能先报cancelled | G1a与G1b |
| submitted/unknown恢复、凭证更新失败、启动失败 | 停在核对/安全拒绝，释放本机资源；账本不丢 | G1b/E2/D2 |

G1a仅使用隔离fake服务和操作fixture验证传输合同，无真实副作用；缺P3时不得给G1b记通过。目标测试命令在实现后运行：

```bash
go test ./internal/callback ./internal/server -count=1
go test -race ./internal/...
```

TS在仓库根运行 `bun test server/tests/enterprise/runtime-callback.test.ts`，并保留既有遗留拒绝测试作为回归，不修改其原部署安全语义。

## R4：真实框架互操作与采用决策

**文件：** 新建 `runtime-go/internal/adapter/agui_test.go`、`runtime-go/testdata/agui-request.json`、`runtime-go/testdata/compatibility-report.json`（只由实测输出生成）、`server/tests/enterprise/runtime-contract.test.ts`、`server/scripts/enterprise-runtime-probe.ts`。

**接口：** `assertEventContract(events: Array<{type:string;runId?:string;threadId?:string}>):void`，测试协调器用 `Bun.spawn` 构建/启动 Go候选，监听 stdout 就绪地址，发HTTP测试并 finally关闭子进程，退出码传播。候选失败必须退出非零，不以跳过通过。

- [x] 创建协议序列断言测试。

```ts
import { expect, test } from "bun:test";
function assertEventContract(events: Array<{type:string}>) {
  expect(events[0]?.type).toBe("RUN_STARTED");
  expect(events.filter(e=>e.type==="RUN_STARTED")).toHaveLength(1);
  expect(events.filter(e=>e.type==="RUN_FINISHED"||e.type==="RUN_ERROR")).toHaveLength(1);
  expect(["RUN_FINISHED","RUN_ERROR"]).toContain(events.at(-1)?.type);
}
test("empty stream cannot count as a successful run",()=>{
  expect(()=>assertEventContract([])).toThrow();
});
```

- [x] `bun test server/tests/enterprise/runtime-contract.test.ts` 验证断言行为；再增加真正启动 Go并消费流的集成测试，此时未有完整接线必须失败。
- [x] Go测试构造一个本地 httptest 模型服务，返回确定性的聊天完成响应，使用实际 `model/openai.New(alias,WithBaseURL(url),WithAPIKey("test-only"))` 和 `llmagent.New` 接入 R2 New。此处是API兼容适配包名，不绑定实际模型供应商或模型名。

```json
{"id":"fixture","object":"chat.completion","choices":[{"index":0,"message":{"role":"assistant","content":"contract-ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}
```

仅测试响应使用上述固定数据。模型服务请求次数、记录的输入、模型错误、慢响应由测试闭包控制；不得以手写 SSE echo 代替真实框架测试。分别验证非流式提供方响应映射、流式增量、工具调用与错误终态。

- [x] TS用现有 `@ag-ui/client` 的 `HttpAgent` 接口消费实际 Go端点；用锁定依赖类型检查事件回调，不复制旧0.x API注释作为契约。比较与现有示例Agent使用同一 fake提供方的事件语义，不比较真实模型随机答案。
- [ ] 运行 `bun server/scripts/enterprise-runtime-probe.ts` 生成报告；包含 `commit,workspace_digest,document_baseline,go_version,dependency_graph_digest,sdk_versions,environment,commands,exit_codes,evidence_refs,limitations`；checks逐项记录身份/可信输入/文本/工具/等待/错误/取消/背压/重启，gates分别记录G1a/G1b/G2为not_run/passed/failed/blocked。G1b/G2本册不自动填写passed。
- [ ] 负载测量报告包括RSS、首事件、活跃连接/Run/模型并发、取消滞后、队列上限、持续时间、数据大小、硬件/镜像；运行/SRE负责人在测试前批准阈值。未定阈值只记测量，不得给容量门禁通过。
- [ ] 技术、运行、QA评审G1a；安全/SRE会同后续域评审G1b，G2由业务等共同签署，遵守总计划§6。失败只禁用候选/保留记录，不自动重写控制平面或切换真实业务。

### R4-A：锁定事件语义与故障用例

上文assertEventContract仅为“空流不通过”的起始单元测试，不构成完整验收。必须使用锁定TS/Go SDK和golden fixtures验证：

| 语义 | 验收要求 |
|---|---|
| 文本/工具生命周期 | message_id/tool_call_id配对、start/delta/end顺序，交错工具结果能归属；ToolCallEnd不是业务成功 |
| 等待输入/审批 | 按锁定协议的已验证字段/命名空间扩展映射，不能把RUN_FINISHED直接映射Run.succeeded；不强制使用滚动文档草案字段 |
| 断流/重连 | 传输结束不等于取消；E3账本续流按seq重建，重复提案去重，超过保留窗口走快照 |
| 慢消费者 | 有界队列和背压；终态/审批/回执不可丢，不无限缓存内存 |
| 重启/旧租约 | G1a只证明进程丢失时不伪报继续；G1b必须实际注入E2/D2/P3故障，旧fencing提交拒绝 |
| 真二进制 | 启动实际main、真实middleware、框架Runner及TS HttpAgent；fixture模型不是SSE echo |

2026-10-10 R4-A 逐行核对记录（G1a 行已具备可执行断言；G1b 行登记为依赖）：

- 文本/工具生命周期：`runtime-contract.test.ts` 生命周期测试断言 TEXT_MESSAGE_CONTENT/END 全部携带其 START 的 messageId、TOOL_CALL_ARGS/END 携带其 START 的 toolCallId、start→content→end 顺序、TOOL_CALL_END 之后仍有 RUN_FINISHED（非业务成功）；Go 侧 `agui_test.go` 既有 TOOL_CALL_START/END 计数与文本信封断言保留。
- 等待输入/审批：以锁定协议（@ag-ui/core 1.0.1 zod schema 与冻结 Go SDK 均含）的 `RUN_FINISHED.outcome{type:"interrupt",interrupts[]}` 为唯一映射载体——`internal/adapter/waitmapping.go` 将治理挂起（需审批/回执未决）从 RUN_ERROR 改写为 interrupt 终态，reason 冻结为 `tool_approval`/`operation_receipt_pending`，interrupt.id=平台 operation_id、toolCallId=线上工具调用 id；`runWaitState` 是平台侧冻结映射（interrupt≠succeeded 的可执行证明）。Go 单测先 RED（当时终态为无 outcome 的 RUN_ERROR）后 GREEN。
- 慢消费者：机制证明＝`internal/adapter/backpressure_test.go`（进程内全链路：消费端停读→provider 写阻塞、帧计数停滞、追读后 16MiB 字节级无损、唯一终态收尾）；探针 checks.backpressure＝对真实二进制的 2MiB 慢读者 harness（工具回执事件+全量 delta+终态不丢、停滞期 RSS 有界测量）。
- 重启/旧租约：G1a 半（进程丢失不伪报）由探针 checks.restart 与 `TestRestartClearsLocalExecutionState` 覆盖；E2/D2/P3 实际故障注入与旧 fencing 提交拒绝属 G1b，已写入报告 limitations 与探针 evidence。
- 真二进制：见 R2-B③ 勾选记录——真实 `cmd/runtime` 构建、真实路由、HttpAgent 消费、确定性 fixture 模型（非 SSE echo）。
- 断流/重连（G1b 行）：本探针无 E3 持久事件账本可续流，仅覆盖"传输结束≠取消"半边（cancel/restart checks）；seq 重建/去重/快照随 E1–E3 验收，已记入报告 limitations。

### R4-B：依赖风险修订与证据

`dependency-review.json`在此前评审记录了未修复风险；本轮未复扫，不把历史扫描当作当前漏洞结论。执行前记录候选修订号、当前工具链、SBOM/依赖图、扫描时间、适用性与修复/不适用证据、安全签署。修复可改变冻结版本，但必须生成新依赖图并复跑R2–R4；不能因“已锁定”拒绝安全升级。未闭环候选只可隔离研究，禁止G1b。上游API路径/依赖变动时先适配契约再验收，不复制过期测试成功记录。

修订映射：R-01→R2-B，R-02→R3，R-03→R2-B，R-04→R4-A，R-05→R4-B；X-03/04/05/06/07以总计划§4/§6与本册差量为准。

## 官方依据与边界

已读取固定提交的 `server/agui/go.mod`、`runner/options.go`、`model/openai/options.go` 与官方AG-UI示例。代码与文档可见 UserIDResolver 默认固定 user、默认客户端 state 合入，以及rawEvent携带上下文的能力，因此计划必须覆盖身份与状态过滤，不能照搬演示配置。

- [固定提交 AG-UI 模块](https://raw.githubusercontent.com/trpc-group/trpc-agent-go/9bb1c42b968c659124a5bb76eb6a676d546442a1/server/agui/go.mod)
- [AG-UI Runner配置源码](https://raw.githubusercontent.com/trpc-group/trpc-agent-go/9bb1c42b968c659124a5bb76eb6a676d546442a1/server/agui/runner/options.go)
- [官方 AG-UI 集成说明](https://raw.githubusercontent.com/trpc-group/trpc-agent-go/main/docs/mkdocs/en/blog/agui.md)

这些是历史方案编写证据，本轮未重新访问或执行构建，不是已编译成功或兼容全部协议的声明。文档修订不产生新的PASS证据；后续按v0.2差量和真实工作区执行。

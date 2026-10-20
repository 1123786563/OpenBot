# 03：运行账本、持久事件、模型网关与预算详细实施计划

> **面向执行 Agent：** 使用 `subagent-driven-development` 或 `executing-plans` 按任务执行。先读取本册与总计划，步骤以复选框记录。本次只获准编写文档，未授权安装、编码、创建角色、迁移、计费调用、部署或 Git 提交。

**目标：** 在 TypeScript 控制平面内建立统一 Run 账本、恢复边界、可重放事件和并发安全模型预算，令 Go 执行器成为可替换的受控消费者，而不是业务事实的唯一持有者。

**架构：** Hono/Bun 写业务 Run、attempt、turn、事件、检查点和成本记录；独立 Node/Temporal Worker 通过内部命令编排，不直接写业务库；Go 无业务库或供应商密钥，只消费受限能力、提交执行提案并调用 TS 模型代理。客户端只能消费已提交的事件。本地 Authz 负责资源读取，本册新增 RunPolicy 负责启动、取消、输入与恢复，不借 `read` 权限推导执行权。

**技术栈：** 现有 TypeScript、Hono、Bun SQL、Drizzle、Zod、AG-UI；现有 Go/tRPC-Agent-Go 作为候选。模型协议转换与供应商连接使用 Higress，逐 Run 准入及预算由 TS 代理强制执行。不引入 OpenFGA/OPA、新的消息中间件或另一个计费平台。

**规格与基线：** `enterprise-mvp-v0.2`，依据同目录 `2026-10-09-enterprise-ai-00-master.md` §1/§4/§6、当前 01、02 及总体方案。文件名沿用总计划注册的分册名；编制日期 **2026-10-10**。本册细化 E1–E4，不改写 00/01/02 已有进度，不声称其测试已通过。

## 全局约束

- “一个数据域一个写入方。”TS 运行域是 Run/事件/检查点写入方；工具操作回执属于 04，模型成本属于本册模型域；Node/Go 只能调用命令。
- “运行引用具体版本，不能在执行中解析 latest。”
- “同一计划不得同时被旧轮询和新调度器执行。”
- “身份验证、租户隔离、危险操作审批、沙箱、审计、预算上限和恢复演练不能推迟到‘企业版’。”
- 当前整个 MVP 不引入外部授权引擎，旧 CEL 也不是企业路径的后备许可。
- 身份为自然人 principal、个人 thread，计划使用有限期可撤销委托；共享会话和独立非人业务账号不在本册。
- 继承 02 的单短 `READ COMMITTED` 事务、可信 Scope、固定 SQL 常量＋`$n`参数、最小角色、RLS、明确错误码；不退回历史两阶段 ResourceRepository。
- API接收请求、AG-UI结束、Temporal完成、工具HTTP200，均不能单独证明业务成功。
- 未知副作用、未知模型费用不自动重试或释放冻结额度；对账状态与执行状态分别保存。
- 当前仓库有用户未提交改动。本册仅新增计划文件，不覆盖 billing、移动端、CI、迁移 journal、Go报告等文件，不读取凭证文件。
- 数量、TTL、超时和容量值均是本册建议测试配置或协议限制，不是压测结果；实际配置需要测试和门禁确认。

---

## 1. 范围、依赖与交付定义

| 工作包 | 本册必须完成 | 独立可验收产物 | 不冒充已完成的下游能力 |
|---|---|---|---|
| E1 | 线协议、Schema、幂等创建、Run＋预留＋Outbox原子提交、受控开通 | 真实DB中重复提交只产生一个Run；额度不足不留半成品 | 专家编辑发布UI由05提供 |
| E2 | attempt/turn/lease、能力验证、取消、检查点、恢复与过期处理 | 旧fence不可继续产生新结果；重启不盲重跑 | 04真实工具审批、06生产Temporal调度另验收 |
| E3 | 先落库事件、ACK重放、过滤、游标SSE、终态与恢复快照 | 断线续流不漏已确认事件、不重复渲染 | Web/App UI由06消费本册合同 |
| E4 | 路由版本、模型使用授权、预算预留/结算、受限模型代理、Go逐次调用绑定 | 超额不发请求；未知调用不再发起；回执幂等结算 | 正式套餐/发票不由预算账本承担 |

### 1.1 依赖不循环

E1先定义本册全部表及`BudgetReservation`合同，E4实现预算算法后才验收带预算的`createRun`。可以先写失败测试和事务骨架，**不能用永远允许的预算替身验收E1**。

推荐开发拓扑：E1-A/B → E4-A/B → E1-C/D → E2-A/B → E3-A/B → E4-C/D → E2-C/D → E3-C → E4-E →集成。

真实Go接线依赖01 R4；真实写工具依赖04；生产持久工作流依赖06 D2。03可先使用明确命名的测试编排适配器测试命令幂等，但不把它部署为第二个调度器。06 D2未完成时生产的Run启动入口保持禁用，02已有只读入口仍可独立使用。

### 1.2 工作区核对

本次读取的提交为 `dd9ae0b`，同时存在未提交变更，提交号不能代表全部文件状态。以下只读证据不等于执行验收：

| 文件 | 已见能力 | 本册做法 |
|---|---|---|
| `server/src/enterprise/contracts.ts` | Scope、Directory、ResourceReader；Tx导出自tenancy/transaction | 复用真实类型，不复制历史Drizzle事务类型 |
| `server/src/enterprise/authz/repository.ts` | 单事务readAuthorizedResource | 不重新引入snapshot/readIfCurrent公共API |
| `server/src/enterprise/bootstrap.ts` | 三个连接池、角色/RLS门禁、ready与drain | 可选追加运行模块；未启用不要求模型/Worker |
| `server/src/enterprise/runtime/validation-routes.ts` | RuntimeInvocation严格字段与verify注入 | 新建生产验证实现，禁止保留总是ok的测试注入 |
| `server/src/enterprise/runtime/tool-invocations.ts` | 明确标注G1a内存fake | 不用于生产；04接管，03只定义回执桥 |
| `runtime-go/cmd/runtime/main.go` | 已装配模型客户端、认证、执行/取消 | 增量改造逐模型能力和持久事件，不重建module |
| `runtime-go/internal/trustedinput/input.go` | user消息摘要和输入限制 | 保持用户输入摘要；恢复历史用独立受信上下文通道 |
| `server/src/db/schema/admin.ts` | modelUsage为模型运行次数记录 | 不拿它作金额/Token预算账本 |
| `server/src/billing/types.ts` | 订阅、用量、外部计费接缝 | 与用户正在改动的billing隔离；本册不重写Lago集成 |
| `server/src/db/schema/work.ts`、`routines/run-turn.ts` | 遗留功能队列和Intelligence线程 | 不把work.key当业务Run，不接入新调度双跑 |
| `server/package.json` | AG-UI及enterprise类型检查已存在 | 不重复新增同名脚本；扩大测试include并入CI |

## 2. 文件职责与单一拥有者

**已有文件局部修改：** `shared/enterprise/contracts.ts`（只重导出公开DTO）、`server/src/enterprise/app.ts`、`bootstrap.ts`、`config.ts`、`errors.ts`、`runtime/validation-routes.ts`、`tenancy/transaction.ts`、`authz/repository.ts`、`server/src/db/schema/index.ts`、`server/drizzle.config.ts`、`server/ops/enterprise/roles.sql`、`server/tsconfig.enterprise-tests.json`、`.github/workflows/ci.yml`、对应Go组件与测试。先看当时差异，禁止覆盖正在实现的02/移动端/billing。

| 拟新增位置 | 职责 |
|---|---|
| `shared/enterprise/run-contracts.ts` | RunView、公开事件与游标、严格公开请求Schema；没有capability/内部地址 |
| `server/src/enterprise/runs/contracts.ts` | RunService、Tx级命令、状态、编排与检查点合同 |
| `server/src/enterprise/runtime/wire.ts` | 内部严格Schema、现有RuntimeInvocation重导出；单一线合同 |
| `server/src/enterprise/runs/digest.ts` | 幂等请求规范化摘要、Go输入摘要对照 |
| `server/src/enterprise/runs/schema.ts` | 数据库结果Zod校验，不与Drizzle表重复命名 |
| `server/src/enterprise/runs/policy.ts` | Run动作授权和个人thread限制 |
| `server/src/enterprise/runs/store.ts` | 同事务Run创建、命令、行锁与版本更新 |
| `server/src/enterprise/runs/transitions.ts` | 确定性状态机、终态竞争规则 |
| `server/src/enterprise/runs/leases.ts` | 租约、心跳、fencing与attempt认领 |
| `server/src/enterprise/runs/checkpoints.ts`、`steps.ts`、`content-store.ts` | 检查点、持久步骤/调用序号、受限内容引用；恢复不重放未知步骤 |
| `server/src/enterprise/runs/outbox.ts` | 提交后可靠派送，稳定幂等键；不持DB锁发网络 |
| `server/src/enterprise/runs/events.ts`、`event-projection.ts` | 写事件/去重/seq与公开白名单投影 |
| `server/src/enterprise/runs/stream.ts` | 持久事件读取、权限续验、背压、游标 |
| `server/src/enterprise/runs/routes.ts` | 公共Run端点，无内部路径 |
| `server/src/enterprise/runtime/capabilities.ts`、`service-auth.ts` | 短期能力与机器认证；不把服务认证当用户许可 |
| `server/src/enterprise/runtime/ledger-verifier.ts`、`control-routes.ts` | 生产验证、内部命令、能力续期和执行上下文 |
| `server/src/enterprise/runtime/dispatcher.ts` | 连接Go流、分配源事件序列、确认落库后发布 |
| `server/src/enterprise/runtime/maintenance.ts` | 失联检测、取消收敛、对账派单；不依赖被撤销用户Scope |
| `server/src/enterprise/models/contracts.ts`、`catalog.ts`、`policy.ts` | 路由版本、业务别名、使用授权、成本边界 |
| `server/src/enterprise/models/money.ts`、`budget.ts` | 整数金额和原子预留/结算 |
| `server/src/enterprise/models/proxy.ts`、`usage.ts`、`reconciliation.ts` | 唯一上游调用、可信usage、未知对账 |
| `server/src/enterprise/runs/provision.ts`、`server/scripts/enterprise-run-provision.ts` | 受控发布种子、动作授权、预算/路由开通，不重建05市场 |
| `server/src/enterprise/internal-app.ts`、`internal-index.ts` | 独立内部listener、服务鉴权与实际装配 |
| `server/src/db/schema/enterprise-runs.ts`、`enterprise-run-events.ts`、`enterprise-models.ts` | 按领域声明表，迁移由Drizzle生成 |
| `server/tests/enterprise/{runs,models}/`、`runtime-ledger.test.ts` | 单元、真实DB、HTTP故障与Go接线测试 |
| `runtime-go/internal/modelproxy/`、`internal/resume/` | Go逐次模型认证、服务端恢复上下文，保持框架可替换 |

下文短文件名均相对此表所属目录。RLS只写入Drizzle登记的custom migration，不另维护第二份policies.sql。03涉及的bootstrap和Schema注册由集成人串行合入，不能让多个执行者覆盖同一文件。

## 3. 公共与内部合同（E1-A）

### 3.1 标识与公开DTO

- `run_id`：业务意图，从创建到等待/恢复保持不变。
- `attempt_id`：一次受租约约束的执行尝试，恢复可更换。
- `turn_id`：一段AG-UI生命周期；Go输入runId绑定此字段，不能绑定业务run_id。
- `thread_id`：个人对话容器，按tenant＋owner隔离，同一thread最多一个非终态Run。
- `model_attempt_id`：一次可能计费的上游请求，跨网络重放不能换ID。
- `operation_id`：04拥有的副作用操作，与工具调用的模型字符串ID不同。
- 数据库bigint在跨进程与JSON中均为十进制字符串，不转成JS number；金额使用BigInt运算。

`shared/enterprise/run-contracts.ts`：

```ts
import { z } from "zod";
export const RunStates=["queued","running","waiting_input","waiting_approval","suspended",
 "cancel_requested","succeeded","failed","cancelled","expired"] as const;
export type RunStatus=typeof RunStates[number];
export const ID=z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const Decimal=z.string().regex(/^(0|[1-9][0-9]*)$/);
export const CreateRunSchema=z.object({thread_id:ID.optional(),workspace_id:ID,
 expert_release_id:ID,model_alias:ID,input:z.object({text:z.string().min(1).max(32768)}).strict()}).strict();
export type CreateRun=z.infer<typeof CreateRunSchema>;
export type RunView={run_id:string;thread_id:string;status:RunStatus;revision:string;
 latest_seq:string;reconciliation_required:boolean;reason_code:string|null};
export type RunEventView={schema_version:"1";event_id:string;run_id:string;turn_id:string|null;
 seq:string;occurred_at:string;type:string;payload:Record<string,unknown>};
```

客户端不能指定tenant/principal、attempt、fence、价格、预算预留、批准结果或模型端点。`Idempotency-Key`使用ID同等字符限制，值由调用方生成但只有去重意义；每次重放仍验证当前授权，不因缓存命中绕过撤权。

### 3.2 服务端接口

`runs/contracts.ts` 定义并由 `server/src/enterprise/contracts.ts` 仅type重导出需要的公共服务端合同；不能把这些类型重导出到shared：

```ts
import type { Scope, Tx } from "../contracts";
import type { CreateRun, RunStatus, RunView, RunEventView } from "../../../../shared/enterprise/run-contracts";
export type RunCommand={command_id:string;expected_revision:string;
 kind:"cancel"|"input"|"resume";input?:{text:string}};
export interface RunService {
 create(scope:Scope,key:string,request:CreateRun):Promise<RunView>;
 get(scope:Scope,id:string):Promise<RunView>;
 command(scope:Scope,id:string,command:RunCommand):Promise<RunView>;
 readEvents(scope:Scope,id:string,after:string,limit:number):Promise<RunEventView[]>;
}
export type AttemptBinding={tenant_id:string;run_id:string;attempt_id:string;turn_id:string;
 lease_id:string;fencing_token:string;service_id:string};
export type DispatchJob={job_id:string;claim_token:string;workflow_id:string;run_id:string;tenant_id:string};
export interface WorkflowStarter {
 start(job:DispatchJob):Promise<{status:"started"|"already_started"|"unknown"|"rejected";receipt_ref:string|null}>;
}
export type EffectSummary={revision:string;pending:number;unknown:number;active:number;
 completed_operation_refs:string[]};
export interface EffectsReader { read(scope:Scope,runId:string):Promise<EffectSummary>; }
export type RecoveryContext={schema_version:"1";checkpoint_id:string|null;context_digest:string;
 message_refs:string[];completed_operation_refs:string[];pending_approval_ref:string|null};
export type RuntimeControlReceipt={status:"accepted"|"exited"|"not_found"|"unknown";receipt_ref:string|null};
export interface RuntimeControl { cancel(binding:AttemptBinding):Promise<RuntimeControlReceipt>; }
export type BudgetPort={reserveInTx(tx:Tx,input:ReserveInput):Promise<string>};
export type ReserveInput={tenantId:string;runId:string;principalId:string;workspaceId:string;
 expertReleaseId:string;reservationId:string;capMicros:string;currency:string;periodId:string};
```

`EffectsReader`的生产实现由04提供，03不能用空数组判断“没有效果”；仅当发布版本被独立校验为**没有任何工具/子任务能力**时，生产可用固定零效果实现。将来接入04，finalize读取已封存的效果屏障而不是不带版本的远程瞬时列表。

### 3.3 严格wire与摘要

- 复用现有`RuntimeInvocation`字段/头名，`schema_version="1"`；冻结黄金样本至 `server/tests/enterprise/runs/fixtures/wire-v1.json` 和Go对应testdata。Zod对象均strict；新增字段先升级双方合同，不修改旧摘要语义。
- 运行能力、事件、检查点和模型请求分受众，能力永不写入AG-UI state、正文、日志、Temporal历史或Outbox payload。
- Run创建摘要使用严格Schema解析后的确定字段顺序；文本不trim、不做Unicode归一化。采用以下可运行实现，额外测试换行、空字符串、中文及JSON键顺序：

```ts
import { createHash } from "node:crypto";
import { CreateRunSchema, type CreateRun } from "../../../../shared/enterprise/run-contracts";
export const sha256=(value:string)=>createHash("sha256").update(value,"utf8").digest("hex");
export function runRequestDigest(request:CreateRun):string {
 const v=CreateRunSchema.parse(request);
 return sha256(JSON.stringify(["run-create-v1",v.thread_id??null,v.workspace_id,v.expert_release_id,v.model_alias,v.input.text]));
}
export function goInputDigest(texts:readonly string[]):string {
 for(const text of texts){
  if(!text.isWellFormed())throw new Error("INVALID_UNICODE_INPUT");
 }
 const json=JSON.stringify(texts.map(content=>({content,role:"user"})))
  .replace(/\u2028/g,"\\u2028").replace(/\u2029/g,"\\u2029");
 return sha256(json);
}
```

Go当前摘要不包含checkpoint。可信恢复上下文通过新内部GET取回，绑定当前attempt与其持久 `context_digest`，不得把服务端历史混入用户摘要或放宽用户输入为system/tool。跨语言测试覆盖U+2028/U+2029；若Go序列化与JS字节不同，先统一显式转义规则并升级黄金样本，不能认为“都JSON”就相同。

### E1-A 执行步骤

- [ ] 写 `contracts.test.ts`：未知tenant字段、负数/指数形式revision、用户传resume/工具结果拒绝；相同解析后请求摘要相同、正文不同摘要不同。

```ts
import { expect,test } from "bun:test";
import { CreateRunSchema } from "../../../../shared/enterprise/run-contracts";
import { runRequestDigest } from "../../../src/enterprise/runs/digest";
const request={workspace_id:"w",expert_release_id:"release",model_alias:"chat",input:{text:"hello"}};
test("caller cannot assign tenant identity",()=>{
 expect(CreateRunSchema.safeParse({...request,tenant_id:"other"}).success).toBe(false);
});
test("request digest covers the content",()=>{
 expect(runRequestDigest(request)).not.toBe(runRequestDigest({...request,input:{text:"changed"}}));
});
```

- [ ] 运行 `bun test server/tests/enterprise/runs/contracts.test.ts`，缺实现为RED；不要删除已有实现制造RED。
- [ ] 新建上述合同/摘要文件，扩展现有RuntimeInvocation的严格解析单一来源并跑01回归。
- [ ] 校验OpenAPI操作、JSON Schema与黄金样本一致；由Zod `z.toJSONSchema`输出新wire Schema到 `server/tests/enterprise/runs/fixtures/wire-schema.json`，不手写第二套字段。
- [ ] 运行目标测试及 `bun run --cwd server typecheck:enterprise`，记录执行证据。

## 4. 数据模型、角色与原子创建（E1-B/C/D）

### 4.1 Schema字段合同

下表是新增Drizzle表的完整业务字段约定。所有租户表用复合主键，不建立只按id的跨租户外键。`created_at/updated_at`为timestamptz；`revision/seq/fence/金额/计数`使用bigint并在API转字符串；JSON列沿用本地 `schema/json.ts`。配置快照只存批准的非秘密值/引用。

| 表 / 所在Schema | 字段及约束 |
|---|---|
| enterprise_threads / runs | tenant_id,id,owner_principal_id,workspace_id,status(active/archived),created_at；PK(tenant,id)，FK(tenant,owner)→memberships、(tenant,workspace)→workspaces |
| enterprise_run_releases / runs | tenant_id,id,resource_id,version_digest,runtime_compatibility,expert_version,model_route_ref,input_limit_bytes,max_model_calls,max_run_micros,currency,tool_manifest_digest,tool_count,status(published/disabled),created_at；仅不可变批准版本；resource FK，tool_count=0才能独立验证 |
| enterprise_run_grants / runs | tenant_id,release_id,principal_id,action(start/cancel_own/resume_own),revision；PK(tenant,release,principal,action)，两个复合FK |
| enterprise_runs / runs | tenant_id,id,owner_principal_id,actor_user_id,workspace_id,thread_id,release_id,initiator_kind,delegation_ref?,request_key,request_digest,input_text,model_route_ref,model_grant_revision,release_digest,policy_revision,budget_reservation_id,status,revision,latest_seq,current_attempt_id?,current_turn_id?,current_fence,cancel_requested_at?,wait_deadline?,deadline_at,pending_approval_ref?,checkpoint_id?,reason_code?,reconciliation_required,created_at,updated_at；UK(tenant,owner,request_key)，非终态thread部分唯一索引 |
| enterprise_run_attempts / runs | tenant_id,run_id,id,turn_id,attempt_no,lease_id,lease_until,service_id,fencing_token,status(allocated/active/exited/lost),context_digest,started_at?,exited_at?,exit_receipt_ref?；PK(tenant,run,id)，UK(tenant,run,turn)，fence只增 |
| enterprise_run_commands / runs | tenant_id,run_id,command_id,payload_digest,kind,result_revision,result_status,created_at；PK(tenant,run,command_id)，重放相同回执、不新增turn |
| enterprise_run_messages / events | tenant_id,run_id,id,attempt_id,turn_id,role(user/assistant/tool),content_ref,content_digest,status(partial/committed),operation_ref?,created_at；复合FK attempt；content_ref指向受限加密存储，tool消息须有04回执 |
| enterprise_run_steps / runs | tenant_id,run_id,id,attempt_id,step_no,kind(model/tool/wait),status(allocated/submitted/committed/unknown),next_call_ordinal,result_ref?,revision；PK(tenant,run,id)，UK(tenant,run,attempt,step_no)；平台分配step，不能由模型任意生成 |
| enterprise_run_checkpoints / events | tenant_id,run_id,id,attempt_id,step_id,content_digest,runtime_compatibility,expert_version,payload,created_at；复合FK attempt；payload满足§6检查点Schema，不存凭证 |
| enterprise_run_events / events | tenant_id,run_id,event_id,seq,attempt_id?,turn_id?,source_event_id,source_digest,event_type,schema_version,payload,public_payload?,occurred_at；PK(tenant,run,seq)，UK(tenant,run,event_id)、UK(tenant,run,attempt_id,source_event_id)；平台事件attempt为空时另建partial unique |
| enterprise_run_snapshots / events | tenant_id,run_id,seq,payload,content_digest,created_at；PK(tenant,run,seq)，仅公开投影，不是执行checkpoint |
| enterprise_run_outbox / events | tenant_id,id,run_id,kind,payload_digest,payload,status(pending/claimed/delivered/unknown/rejected),claim_token?,claim_until?,available_at,attempts,last_error_code?,receipt_ref?,created_at；PK(tenant,id)，UK(tenant,run,kind,payload_digest) |
| enterprise_model_routes / models | tenant_id,id,alias,revision,resource_id,target_ref,price_revision,currency,input_unit_micros,output_unit_micros,per_request_micros,max_input_tokens,max_output_tokens,max_request_bytes,protocol_profile,usage_profile,status(active/disabled),created_at；UK(tenant,alias,revision)，target_ref不可由用户改写 |
| enterprise_model_grants / models | tenant_id,route_id,principal_id,revision,status(active/revoked)；PK(tenant,route,principal)，复合FK；变更需同资源锁 |
| enterprise_budget_accounts / models | tenant_id,id,scope_kind(tenant/workspace/expert/principal),scope_ref,period_id,starts_at,ends_at,currency,limit_micros,spent_micros,held_micros,status(active/frozen),revision；UK(tenant,scope_kind,scope_ref,period_id,currency)，非负计数 |
| enterprise_budget_reservations / models | tenant_id,id,run_id,cap_micros,spent_micros,held_micros,allocated_micros,currency,period_id,status(open/closed/reconciliation),created_at；UK(tenant,run)，allocated<=held，所有值非负 |
| enterprise_budget_bindings / models | tenant_id,reservation_id,account_id；PK三列，记录本次预留使用的账户集合，周期跨日不重新归属 |
| enterprise_model_attempts / models | tenant_id,id,run_id,attempt_id,logical_call_id,request_digest,route_id,price_revision,reservation_id,cap_micros,status(reserved/submitted/succeeded/failed/unknown),charged_micros?,usage_source?,response_digest?,provider_request_id?,lease_id,fencing_token,receipt_revision,created_at,submitted_at?,settled_at?；UK(tenant,run,logical_call_id) |
| enterprise_usage_entries / models | tenant_id,id,model_attempt_id,revision,input_tokens?,output_tokens?,cost_micros,kind(charge/adjustment),evidence_digest,created_at；UK(tenant,model_attempt,revision)，修改采用追加adjustment |
| enterprise_capabilities / runs | tenant_id,id,token_hash,service_id,audience(runtime/model/control),envelope_digest,run_id,attempt_id,lease_id,fencing_token,logical_call_id?,expires_at,revoked_at?,created_at；model受众必须绑定logical_call_id；仅hash落库 |
| enterprise_model_calls / models | tenant_id,run_id,logical_call_id,attempt_id,step_id,call_ordinal,route_id,status(allocated/submitted/settled/unknown),created_at；PK(tenant,run,logical_call)，UK(tenant,run,step,call_ordinal)；申请model能力前先创建，不依赖尚不存在的上游响应 |
| enterprise_run_delegations / runs | tenant_id,id,principal_id,release_id,route_id,max_run_micros,max_runs,used_runs,expires_at,revoked_at?,revision；03只验证，06定义授权UI/生命周期 |

`RunRelease`是05专家发布产物在运行域的不可变接入投影，不是再建一套专家编辑器。只有通过受控provision命令和摘要核对才能写入，不能由请求带整段系统提示词。model alias在创建时解析为唯一批准route revision，Run保存固定route_id。

Schema补充与生命周期细则（同属E1-B，不能只在内存实现）：

- `enterprise_run_attempts`增加 `sealed_at`、`effects_revision`、`model_calls_count`、`last_source_ordinal`；seal和新模型/工具准入锁同一attempt，计数达到release.max_model_calls拒绝新逻辑调用，重放不加次数。
- `enterprise_runs`增加 `input_revision`、`event_low_watermark`；命令输入正文单独写入run_messages，不覆盖原创建输入。messages只在commit后作为历史ref，存储`content_ref`的后端与加密配置由content-store固定映射，不能读取任意URI。
- `enterprise_model_routes`增加 `is_default_for_alias`；每租户alias只有一个默认active版本（部分唯一索引）。已有Run使用原route_id，默认切换不改变历史请求。
- `enterprise_model_attempts`增加 `response_ref`、`usage_status(pending/confirmed/unknown)`；已明确执行失败但可能计费仍为usage unknown，不能将failed等同未计费。
- `enterprise_model_calls`与model_attempts关系是1:1的MVP约束；显式fallback创建新logical_call及新的model_attempt并关联原调用，不复用已submitted记录覆盖它。
- `enterprise_budget_accounts/reservations`增加非负 `overage_micros`，reservation增加 `closed_at`；实际超支可以使spent超过limit，准入拒绝新调用，不用DB约束丢弃真实费用。
- `enterprise_capabilities`的model能力必须有logical_call_id，runtime/control不得借此获得model权限；既有RuntimeInvocation字段不添加模型密钥。
- 每张子表逐一添加复合FK：events/checkpoints/attempts/commands/outbox→runs，model_attempts→reservation/route/run_attempt，bindings→reservation/account，model_calls→run_steps；集合中的跨tenant引用必须由数据库拒绝。
- `enterprise_run_outbox`的通用系统回执与模型晚到对账不依赖当前用户仍为active，但只走maintenance固定命令，不拥有产生新业务意图的权限。

**约束重点：**

```sql
CREATE UNIQUE INDEX enterprise_thread_single_active_run
ON enterprise_runs(tenant_id,thread_id)
WHERE status NOT IN ('succeeded','failed','cancelled','expired');
CREATE UNIQUE INDEX enterprise_platform_event_source
ON enterprise_run_events(tenant_id,run_id,source_event_id) WHERE attempt_id IS NULL;
ALTER TABLE enterprise_budget_reservations ADD CONSTRAINT budget_reservation_nonnegative
 CHECK (cap_micros>=0 AND spent_micros>=0 AND held_micros>=0 AND allocated_micros>=0
  AND allocated_micros<=held_micros);
```

Run与reservation存在创建循环：reservation可FK到Run并设 `DEFERRABLE INITIALLY DEFERRED`，Run只保留非空reservation_id再加同样延迟复合FK；由custom迁移实现，事务提交时强制互相一致，不以nullable长期规避。active attempt指针同理按复合键验证，不写只按attempt.id的FK。

### 4.2 数据角色扩展

新增 `ob_ent_run_writer`（业务创建/命令）、`ob_ent_runtime_writer`（内部回调/事件/模型计量）、`ob_ent_dispatcher`（Outbox）、`ob_ent_run_operator`（离线Run配置与预算）、`ob_ent_run_maintenance`（失联收敛与结算）。均NOLOGIN、非owner、无BYPASSRLS，不让公开API取得operator或maintenance权限。

- `ob_ent_run_writer`通过 `withTenant`验证真实用户，仅可写本人thread/Run/command/outbox、绑定预算；只读成员/资源/grants，不能修改ACL。
- `ob_ent_runtime_writer`每次操作先认证服务＋DB能力映射。普通业务动作通过重新查询Directory产生Scope、withTenant复核；只允许该Run绑定的service/attempt/fence。不能接受body.tenant授权。
- `ob_ent_dispatcher`只能读取/更新脱敏Outbox表，不能读消息/事件/输入/capability。轮询跨租户队列是明确的有限系统权限，不给它资源/Run正文读权限。
- `ob_ent_run_operator`仅离线审批后创建release、run_grant、route/grant、budget，不可直接发模型请求；IAM仍归02的operator。
- 撤权后仍需停止旧进程/收账：在 `maintenance.ts` 创建私有 `withRunMaintenance`。它只接受从数据库已存在Run与服务绑定推导的MaintenanceContext，模块私有WeakSet签发；只允许fence失效、失联标记、取消确认、金额对账和审计，不可排队新执行或读取正文。使用独立维护登录角色，只开放相应表列/命令，API不能切换为该角色。

扩展02的角色目录策略时不能直接给新角色继承所有`ob_ent_data`能力；按同一Scope谓词逐表授权。示意RLS供custom迁移，不创建第二份SQL文件：

```sql
CREATE POLICY run_owner_write ON enterprise_runs FOR ALL TO ob_ent_run_writer
USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')
 AND owner_principal_id=nullif(current_setting('app.principal_id',true),''))
WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')
 AND owner_principal_id=nullif(current_setting('app.principal_id',true),''));
CREATE POLICY run_internal_scope ON enterprise_runs FOR ALL TO ob_ent_runtime_writer
USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')
 AND id=nullif(current_setting('app.run_id',true),''))
WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')
 AND id=nullif(current_setting('app.run_id',true),''));
```

RLS上下文仍由可信代码设置，不能抵抗完全控制TS进程的攻击者。补测试Public API不能读capabilities/内部outbox、Go无DB网络、dispatcher不能读input。内部writer的API函数必须使用固定SQL常量，禁止开放任意SQL/任意状态更新端点。

### E1-B 执行步骤

- [ ] 建 `server/tests/enterprise/runs/schema.test.ts`，检查表注册、复合FK、unique、bigint字符串映射以及不向既有表执行drop。
- [ ] 从表合同逐文件声明Drizzle表，登记 `schema/index.ts` 与 `drizzle.config.ts`。索引/DDL后用02隔离执行器生成迁移；旧journal已有未提交0057，不猜新编号。
- [ ] DBA批准后创建能力角色，custom迁移建立所有新增表ENABLE/FORCE RLS及最小GRANT。
- [ ] 跑真实DB反例：跨租户thread、release、route、reservation引用失败；无context无行；旧API角色不能写账本；dispatcher不能读输入。

```ts
// schema.test.ts的行为用例：db为经testDatabaseUrlFrom校验的专用受限池。
await expect(db.$client.unsafe("select token_hash from enterprise_capabilities")).rejects.toThrow();
await expect(db.$client.unsafe("truncate enterprise_runs")).rejects.toThrow();
```

- [ ] 执行 `bun test server/tests/enterprise/runs/schema.test.ts` 和类型检查，记录数据库角色与迁移摘要。

### 4.3 RunPolicy与创建（E1-C）

不扩展02的read动作为“所有动作允许”。`RunPolicy`定义如下，查询和判断都在调用方传入的同一个withTenant事务内：

```ts
import type { Scope,Tx } from "../contracts";
export type RunAccess={ownerPrincipalId:string;releaseId:string;workspaceId:string;threadId:string};
export interface RunPolicy {
 assertStart(tx:Tx,scope:Scope,releaseId:string,routeId:string):Promise<void>;
 assertOwn(tx:Tx,scope:Scope,run:RunAccess,action:"read"|"cancel"|"resume"):Promise<void>;
}
```

`assertStart`核对：当前成员链、release为published、resource/route属于scope租户与workspace、显式`run_grants.start`、model_grant.active、允许的route profile。`read`必须是本人Run且专家资源read仍有效；`resume`再验start/resume_own与当前模型授权；`cancel`允许本人停止既有Run即使专家执行授权被撤销，但不可跨租户，也不暴露被撤资源的内容。已暂停用户由维护通道停止，不开放未经认证的取消后门。

为避免嵌套事务，将02 `createResourceReader`中私有授权算法抽为仅server内部导出的 `assertResourceReadInTx(tx,scope,id,authz):Promise<ResourceView>`；仍不返回ResourceSnapshot，既有readAuthorizedResource调用该函数，所有外部消费者继续单事务。

统一锁顺序在02原链条上扩展：tenant→principal→membership→resource（ID排序）→budget_account（ID排序）→thread→run→reservation→model_attempt→operation。同一函数只能按顺序取锁，不能先锁Run再要求预算账户；需要账户ID时先读不可信hint，再按顺序上锁并复读绑定。所有网络调用在提交之后。

创建算法（`store.ts`导出 `createRunStore(deps:{db:Database;policy:RunPolicy;budget:BudgetPort}):RunService`，get/command/events下文细化）：

1. Schema校验输入，服务端计算request_digest。
2. withTenant内先读取同 `(tenant,principal,key)` 的既有记录并当前授权复核；同digest返回同run_id，不同时409。
3. 锁release/route资源、账户、thread；新thread由服务端生成ID并记录owner；旧thread必须active且owner匹配；禁止同时另一个非终态Run。
4. 冻结release/route/price/policy及计划上限，服务端生成run/reservation/turn/outbox ID。
5. 插入queued Run、输入与初始turn；调用 `budget.reserveInTx`使用同tx预留全Run上限。
6. 插入 `start_workflow` Outbox，payload只含ID，不含输入/秘密；写初始`RUN_QUEUED`事件与审计；提交后返回202 RunView。
7. 唯一冲突整事务回滚，另开当前授权只读事务核对已存在key；不同digest409，相同请求返回原Run。禁止捕获唯一冲突后继续使用已abort的tx。

关键SQL（模块常量；参数只传values）：

```sql
INSERT INTO enterprise_run_outbox(tenant_id,id,run_id,kind,payload_digest,payload,status,available_at,attempts,created_at)
VALUES($1,$2,$3,'start_workflow',$4,$5::jsonb,'pending',clock_timestamp(),0,clock_timestamp());
```

### E1-C 测试与实现步骤

- [ ] 写 `create.test.ts`，夹具通过离线provision创建真实租户、start grant、model grant、预算账户和无工具release。

```ts
// h是本册测试helper，固定专用测试库和真实RunService，不是永远允许的替身。
const request={workspace_id:h.workspaceId,expert_release_id:h.releaseId,model_alias:"chat",input:{text:"hello"}};
const [a,b]=await Promise.all([h.runs.create(h.scope,"same-key",request),h.runs.create(h.scope,"same-key",request)]);
expect(a.run_id).toBe(b.run_id);
expect(await h.count("runs")).toBe(1);
expect(await h.count("reservations")).toBe(1);
expect(await h.count("start_outbox")).toBe(1);
await expect(h.runs.create(h.scope,"same-key",{...request,input:{text:"other"}})).rejects.toThrow("IDEMPOTENCY_CONFLICT");
```

`h`在 `server/tests/enterprise/runs/support.ts` 实现为 `createRunHarness():Promise<{scope:Scope;workspaceId:string;releaseId:string;runs:RunService;count(kind:"runs"|"reservations"|"start_outbox"):Promise<number>;close():Promise<void>}>`；使用已批准测试角色URL，通过02的provision与本册provision建立fixture。count使用固定三条SQL而非请求拼表名；afterAll关闭连接，不清除其他测试数据。

- [ ] 运行测试，预算未实现导致的失败登记依赖E4-B，不装假的成功预算绕过。
- [ ] 实现RunPolicy/原子创建，故障注入在“插Run后、预留后、插Outbox后”三个位置抛测试异常，确认整个事务回滚。
- [ ] 复跑并发、额度不足、撤权、他人thread、路由权限、body超限、重放后权限撤销用例。
- [ ] 接入公共POST `/api/enterprise/v1/runs`，首次和相同请求重放统一返回202与当前RunView；创建不是执行完成证明。DTO不返回内部input_digest/服务地址/capability。

### 4.4 离线开通（E1-D）

`server/scripts/enterprise-run-provision.ts`模式固定为 `release-register/run-grant/route-register/model-grant/budget-open/delegation-register`。Zod严格输入，每种mode只允许对应字段；默认dry-run，`--apply`还需operation_id。身份/Workspace/Resource先由02创建，不能本册自动创建全局Principal。

- release-register核对文件摘要、资源归属、Go专家版本及runtime_compatibility；有工具的manifest须经过04，不允许输入tool_count=0却含工具配置。
- route-register只接target_ref/价格版本/限制，真实endpoint与secret通过部署映射加载；用户输入URI不得变成target。
- budget-open不修改已发生的spent/held；调额需独立operation_id与理由，同事务追加安全事件。
- 相同operation_id内容不同409；策略/路由失效在资源锁内提升revision；已Run持有固定版本但每次新调用仍检查disabled。
- delegation-register仅人工批准试点计划，明确principal/release/route/期限/次数/单Run上限；不能以长存session替代。

CLI写API：`applyRunProvision(tx:Tx,command:RunProvisionCommand):Promise<void>`。类型在 `runs/provision.ts` 定义，Zod按同一union严格校验；日期必须带时区、金额使用Decimal、ID使用ID Schema：

```ts
export type RunProvisionCommand={tenant_id:string;operator:string;operation_id:string} & (
 {mode:"release-register";id:string;resource_id:string;version_digest:string;runtime_compatibility:string;
  expert_version:string;model_route_ref:string;input_limit_bytes:number;max_model_calls:number;
  max_run_micros:string;currency:string;tool_manifest_digest:string;tool_count:number} |
 {mode:"run-grant";release_id:string;principal_id:string;action:"start"|"cancel_own"|"resume_own"} |
 {mode:"route-register";id:string;resource_id:string;alias:string;revision:string;target_ref:string;
  price_revision:string;currency:string;input_unit_micros:string;output_unit_micros:string;
  per_request_micros:string;max_input_tokens:number;max_output_tokens:number;max_request_bytes:number;
  protocol_profile:string;usage_profile:string;is_default_for_alias:boolean} |
 {mode:"model-grant";route_id:string;principal_id:string} |
 {mode:"budget-open";id:string;scope_kind:"tenant"|"workspace"|"expert"|"principal";
  scope_ref:string;period_id:string;starts_at:string;ends_at:string;currency:string;limit_micros:string} |
 {mode:"delegation-register";id:string;principal_id:string;release_id:string;route_id:string;
  max_run_micros:string;max_runs:number;expires_at:string}
);
```

所有注册记录初始状态和revision由服务端设置；budget-open固定spent/held/overage为0。同mode对应一条固定insert/upsert命令，只更新明确可变字段，不可用动态表名或全对象spread写DB。幂等操作记录复用02 security_events，payload_digest覆盖全部业务字段；真实目标/秘密不属于该CLI。

撤销也必须可执行：在同脚本增加 `disable-release/revoke-run-grant/disable-route/revoke-model-grant/revoke-delegation`，输入只含对应ID、reason与operation_id；release/route/委托更新状态和revision，grant按受限动作删除/改revoked；全部在统一resource/tenant锁和同事务审计下完成，不能通过手工SQL跳过锁。新增这五种操作的严格union与负向case，与注册操作一起验收；未来05/06管理入口复用这些领域命令。

验收命令：`bun test server/tests/enterprise/runs/provision.test.ts`；验证重复、冲突、审计失败回滚、未知target_ref与未批准专家拒绝。生产开通仍需单独授权。
## 5. 状态、租约与生产身份（E2-A/B）

### 5.1 状态机与并发优先规则

| 当前状态 | 输入 | 下一状态 | 必要事实 |
|---|---|---|---|
| queued | workflow已存在＋成功认领lease | running | 当前授权、预算、执行版本仍有效 |
| queued | 明确永久启动拒绝 | failed | 没有活跃执行，释放未消费预留 |
| running | 需用户输入/审批 | waiting_input / waiting_approval | checkpoint已落库、引用有效、Go当前turn实际结束 |
| running | 失联、lease过期、未知效果 | suspended | 失效fence，保留费用/操作冻结 |
| waiting_* | 有效新输入或04批准回执 | queued | 新turn/attempt、当前权限、旧执行已退出、预算可用 |
| suspended | 明确恢复命令 | queued | 兼容checkpoint、效果屏障、旧执行已退出或受隔离控制，重新授权 |
| 非终态 | 用户取消 | cancel_requested | 取消意图持久化，不能直接声称停机 |
| cancel_requested | 确认所有本地执行退出/从未启动 | cancelled | 后续未知副作用仍保留reconciliation_required |
| running | 完成候选 | succeeded | 当前fence、输出与事件持久、效果屏障无pending/unknown、模型费用已结算 |
| running | 明确不可恢复失败 | failed | 确定执行退出，费用结算或明确冻结与reason |
| waiting_* / queued | 到期且无活跃执行 | expired | 权限不再延长，释放可释放余额 |
| 任意终态 | 旧事件/新恢复 | 状态不变 | 新业务意图新Run；迟到对账只修金额记录 |

**取消优先定义：** 同Run命令在run行锁与CAS处线性化；若成功先提交，取消返回现有终态，不谎称取消；若cancel_requested先提交，成功提案不能覆写，必须收敛到取消。运行中达到deadline先提交取消意图并要求退出，不直接expired。版本冲突返回409，不能在客户端无限重试强行覆盖。

`transitions.ts`纯函数（调用方仍须检查权限、fence和持久事实，不能让Go直接传next状态）：

```ts
import type { RunStatus } from "../../../../shared/enterprise/run-contracts";
export const terminal=(s:RunStatus)=>["succeeded","failed","cancelled","expired"].includes(s);
export type TransitionInput={kind:"cancel"|"started"|"lost"|"wait_input"|"wait_approval"|"resume"|"complete"|"exit_cancel"|"fail"|"expire";
 eligible:boolean};
export function nextState(current:RunStatus,input:TransitionInput):RunStatus {
 if(terminal(current))return current;
 if(input.kind==="cancel")return "cancel_requested";
 if(!input.eligible)throw new Error("TRANSITION_PRECONDITION");
 if(current==="cancel_requested"){
  if(input.kind==="exit_cancel")return "cancelled";
  throw new Error("CANCEL_PENDING");
 }
 if(input.kind==="started"&&current==="queued")return "running";
 if(input.kind==="lost"&&current==="running")return "suspended";
 if(input.kind==="wait_input"&&current==="running")return "waiting_input";
 if(input.kind==="wait_approval"&&current==="running")return "waiting_approval";
 if(input.kind==="resume"&&["waiting_input","waiting_approval","suspended"].includes(current))return "queued";
 if(input.kind==="complete"&&current==="running")return "succeeded";
 if(input.kind==="fail"&&["queued","running","suspended"].includes(current))return "failed";
 if(input.kind==="expire"&&["queued","waiting_input","waiting_approval","suspended"].includes(current))return "expired";
 throw new Error("INVALID_TRANSITION");
}
```

`eligible`是store内部从数据库/已验证屏障计算的值，wire中禁止出现。更新语句固定CAS：

```sql
UPDATE enterprise_runs SET status=$4,revision=revision+1,updated_at=clock_timestamp()
WHERE tenant_id=$1 AND id=$2 AND revision=$3::bigint RETURNING revision::text,status;
```

状态、command回执、公开状态事件、恢复/取消Outbox在同一tx提交。终态之后不能追加新的模型/工具意图；迟到回执使用maintenance路径对账，终态不重新打开。

### E2-A 执行步骤

- [ ] 写 `transitions.test.ts`，包括取消胜过未提交成功、终态幂等、SDK结束不能直接成功。

```ts
import { expect,test } from "bun:test";
import { nextState } from "../../../src/enterprise/runs/transitions";
test("pending cancellation cannot become succeeded",()=>{
 expect(()=>nextState("cancel_requested",{kind:"complete",eligible:true})).toThrow("CANCEL_PENDING");
});
test("terminal state is not reopened",()=>{
 expect(nextState("succeeded",{kind:"resume",eligible:true})).toBe("succeeded");
});
```

- [ ] 运行测试 → 实现纯函数 → 在store里由固定命令映射，不接收任意status。
- [ ] 编写 `commands.test.ts`：command_id相同同摘要返回原回执；相同ID不同args409；resume并发只创建一次turn；cancel与complete并发只能一个终态。
- [ ] 增加队列等待/审批过期的状态事务，截止时间用数据库clock_timestamp判断，不相信Go上报的时间。
- [ ] 测试终态后迟到usage可以对账，但不能再触发Run或释放未知冻结。

### 5.2 Outbox与租约

`outbox.ts`：`claimDispatch(db,serviceId,limit):Promise<DispatchJob[]>`、`recordDispatchReceipt(job,receipt):Promise<void>`；跨租户dispatcher仅查最小Outbox，不载荷正文。`claim_token`服务端生成，每次claim不同，过期接管后旧claim不能ACK。

```sql
WITH chosen AS (
 SELECT tenant_id,id FROM enterprise_run_outbox
 WHERE kind='start_workflow' AND available_at<=clock_timestamp()
  AND (status='pending' OR (status='claimed' AND claim_until<clock_timestamp()))
 ORDER BY available_at,id FOR UPDATE SKIP LOCKED LIMIT $1
)
UPDATE enterprise_run_outbox o SET status='claimed',claim_token=$2,
 claim_until=clock_timestamp()+interval '30 seconds',attempts=attempts+1
FROM chosen c WHERE o.tenant_id=c.tenant_id AND o.id=c.id
RETURNING o.tenant_id,o.id,o.run_id;
```

- `workflow_id="enterprise-run-"+sha256(JSON.stringify([tenant_id,run_id]))`；同业务Run从不换workflow_id绕过去重。
- 提交后调用 `WorkflowStarter.start`；ACK丢失不标rejected、不释放预算。重试start前由06查询同workflow_id，校验业务映射；已存在即记录existing receipt。
- `recordDispatchReceipt`须比较id＋claim_token＋claim_until；未知保持待核对，不直接重置Run。D2 Worker注册成功只表明编排存在，不代表Go已经running。

`leases.ts`：`claimAttempt(scope,runId,commandId,serviceId):Promise<AttemptBinding>`，输入的serviceId必须来自认证的Worker身份；同command重放返回旧记录、不发第二份执行许可。新执行递增Run.current_fence并生成lease/attempt/turn；lease建议45秒、heartbeat每10秒，必须压测后配置。

```sql
UPDATE enterprise_run_attempts SET lease_until=clock_timestamp()+interval '45 seconds'
WHERE tenant_id=$1 AND run_id=$2 AND id=$3 AND lease_id=$4 AND fencing_token=$5::bigint
 AND service_id=$6 AND status='active' AND lease_until>clock_timestamp()
RETURNING lease_until;
```

过期不能心跳复活；new attempt必须新fence。通过固定SQL查询current_attempt/current_fence，不能只检查attempt自己的旧行。维护扫描过期行先取相同run锁、CAS为lost、撤销能力、转suspended。启动请求超时不得重新POST同Go进程造成双执行：查询执行注册/上下文，不能证实则先失效旧fence并核对。

### 5.3 内部机器认证与短期能力

`runtime/service-auth.ts`：部署输入服务记录 `{service_id,token_hash,scopes,disabled}`；TS仅存hash，配置中允许上一/当前凭证的受控轮换；比较用 `timingSafeEqual`，不按请求声明service_id授权。运行时服务只能validate/events/checkpoint/model；编排服务只能claim/dispatch/control；公开API完全不挂此listener。

`runtime/capabilities.ts` 使用**不透明随机令牌**，不自造JWT算法。它绑定数据库中的服务、audience、Run/attempt/lease/fence、invocation摘要和期限。随机值仅在创建响应返回一次，hash落库，日志不记录。

```ts
import { createHash,randomBytes } from "node:crypto";
export function newCapability():{token:string;hash:string} {
 const token=randomBytes(32).toString("base64url");
 return {token,hash:createHash("sha256").update(token).digest("hex")};
}
export function capabilityHash(token:string):string {
 if(!/^[A-Za-z0-9_-]{43}$/.test(token))throw new Error("INVALID_CAPABILITY");
 return createHash("sha256").update(token).digest("hex");
}
```

`verifyInvocation`实现现有 `InvocationValidationDeps.verify`：

1. 服务认证有效且有validate scope；严格解析信封；查hash对应能力，audience=`runtime`、service_id匹配、expires_at未到。
2. tenant/principal/user从能力绑定Run取，不从body创建。invocation所有字段必须与Run/attempt/保存摘要一致；expired能力401，过期lease/错误绑定403，已识别DB不可用503。
3. 通过Directory重新解析真实user并产生Scope，在withTenant检查成员、Run/release/route/委托、当前fence、非cancel/终态；同时调用02实际部署撤权检查，不能只检查membership而让部署禁用用户继续由Worker执行。没有能力记录就拒绝。委托还须验证principal/release/route绑定、次数与金额、expires_at/revoked_at；used_runs仅在新Run创建同事务增加，重放不再增加。
4. 返回原冻结信封白名单，Go不能据此延长期限。续期端点仅接受有效机器身份＋现有lease句柄，在数据库重新授权后签新能力，不接受过期用户cookie换令牌。

**控制与收账例外：** 取消已失效执行、接受真实迟到模型回执不能要求仍有效的用户执行能力，否则撤权会妨碍停机与收账。使用独立control/settlement scope的维护服务，只可针对已存在Run调用固定命令，不签新的执行能力。Go取消入口需增量支持该受限控制证明，并仍核对完整执行tuple，不能重用已过期execute能力忽略expiry。

### E2-B 验收步骤

- [ ] 写 `leases.test.ts`、`capabilities.test.ts`，先RED；覆盖过期心跳、旧fence、伪造服务身份、invocation摘要改变、撤权后续期拒绝。
- [ ] 实现Outbox claim与回执CAS，故障注入在提交后/发送后/ACK前；只存在一个workflow_id。
- [ ] 为现有validation-routes注入 `createLedgerVerifier`，保留G1a fake仅在测试，禁止生产入口import fakeToolPlane。
- [ ] 用两实例DB集成测试旧worker复活、新lease并发、取消与续期竞争；旧fence新的事件/checkpoint/model调用都拒绝。
- [ ] 重放旧fence**已提交且同摘要的事件**只返回既有最小ACK，不新增数据；未知事件一律拒绝，不能以重放为由跳过绑定。

命令：`bun test server/tests/enterprise/runs/leases.test.ts server/tests/enterprise/runs/capabilities.test.ts server/tests/enterprise/runtime-ledger.test.ts`。

## 6. 检查点、等待与取消恢复（E2-C/D）

### 6.1 执行checkpoint不是UI snapshot

`Checkpoint`在 `runtime/wire.ts` 严格定义以下字段：

```ts
export type Checkpoint={schema_version:"1";expert_version:string;runtime_compatibility:string;
 run_id:string;attempt_id:string;step_id:string;message_refs:string[];
 completed_operation_refs:string[];pending_approval_ref:string|null;
 budget_reservation_id:string;artifact_refs:string[];content_digest:string};
```

`content_digest`对去掉自身字段的确定顺序数组计算；数组保留业务顺序，不把不稳定的框架对象序列化为checkpoint。message/artifact/ref必须存在于当前tenant/Run且已提交；模型生成的“操作成功”文本不构成completed_operation_ref。

`checkpoints.ts` 导出 `saveCheckpoint(binding,checkpoint):Promise<{checkpoint_id:string;revision:string}>`、`planRecovery(scope,runId,commandId):Promise<RecoveryContext>`。写入前验证fence、当前step、专家版本、runtime兼容、每个引用；写checkpoint、等待状态、outbox、公开wait事件同事务。处于运行中的实时图只能在声明的安全边界持久：已完成模型调用、准备工具前、持久回执后、等待人类输入前。

**恢复规则：**

- 用户只能提交新user input或引用待处理请求，不能提交框架resume对象、审批结果、system/tool历史。
- `planRecovery`重新检查当前成员/RunPolicy、模型授权、预算与lease；取已确认checkpoint。专家版本不变，runtime版本不兼容返回409 `CHECKPOINT_INCOMPATIBLE`，不自动重放全程。
- 04审批回执来自其已消费/待消费状态和args_digest，不接受公开Run resume请求携带`approved:true`。04尚未实现时审批恢复保持blocked，假批准只用于隔离测试。
- 新turn执行输入包含**本轮新user内容**；历史、固定prompt、工具回执通过受信内部 `GET /internal/enterprise/v1/runs/{id}/execution-context`读取，授权绑定当前attempt，返回限量白名单结构与context_digest。
- Go新增 `internal/resume` 在完成服务验证后拉取上下文，不放宽trustedinput.Parse对用户角色的限制；受信历史只能在内部适配层装配。同一请求中的模型可见数据与凭证分开传递。
- 模型调用已submitted/unknown且没有持久结果，不自动再跑该step；先对账或显示恢复阻塞。即使模型无外部业务副作用，重复调用也可能重复计费。

### 6.2 效果屏障

运行完成或恢复前先通过当前fence关闭该attempt的新工具/模型准入，等待所有已登记调用退出/进入未知状态，再读**带屏障revision的**效果汇总。不能先查“没有活跃操作”、随后又准许同attempt产生工具调用。

04实现 `sealAttempt(runId,attemptId,fence):EffectSummary` 的同域线性化；其回执写入运行域检查点引用。没有04时，仅经过发布验证的tool_count=0且禁止A2A/子任务的release允许使用零效果屏障。模型域本地也执行seal，不再接受新model_attempt；已有调用仍允许settlement。

### E2-C/D 执行步骤

- [ ] `checkpoints.test.ts`：错误tenant引用、未确认操作、改变expert_version、重复step不同摘要拒绝；相同checkpoint重放返回原ID。
- [ ] `recovery.test.ts`：保存后杀Go；新attempt只能从确认checkpoint恢复；未知效果保持suspended；不能读取客户端伪造tool历史。
- [ ] `cancel.test.ts`：cancel响应202只显示请求已记录；Go回`accepted`但未退出，Run仍cancel_requested；`not_found`不是已退出证明，交维护核对实例与lease。
- [ ] 维护命令 `reconcileLostAttempt` 只能失效fence与标记suspended；若旧进程未证明退出，不能释放它可能消耗的模型预留或把CPU资源计为已释放。
- [ ] 当运行已停但外部效果unknown，可标cancelled并保留reconciliation_required；UI/审计明确“执行已停止，外部结果待核对”，不把未知操作说成撤销成功。
- [ ] `finishRun`在单事务内核对输出持久、事件确认、屏障、费用、revision，写终态；SDK `RUN_FINISHED`只记turn结束，不能调用finishRun绕过这些条件。

```ts
// recovery.test.ts，先写失败测试，再实现planRecovery的屏障与版本核对。
const checkpoint=await h.saveConfirmedCheckpoint();
await h.markAttemptLost();
await h.setUnknownEffect("operation-1");
await expect(h.recover(checkpoint)).rejects.toThrow("RECONCILIATION_REQUIRED");
expect((await h.getRun()).status).toBe("suspended");
```

恢复fixture在 `runs/support.ts` 增加上述四个具名方法，只通过生产store/隔离04契约替身制造指定状态，不直接改Run为成功。测试替身的未知效果不得被默认空列表覆盖。

验收命令：`bun test server/tests/enterprise/runs/checkpoints.test.ts server/tests/enterprise/runs/recovery.test.ts server/tests/enterprise/runs/cancel.test.ts`。真正Temporal等待/重放由06 D2补证据，03不执行全Agent Activity重试策略。
## 7. 持久事件与AG-UI续流（E3-A/B/C）

### 7.1 写入与ACK

**文件：** `runs/events.ts`、`event-projection.ts`；测试 `events.test.ts`、`event-projection.test.ts`。
**接口：** `appendRuntimeEvent(binding:AttemptBinding,input:EventProposal):Promise<EventAck>`；`appendPlatformEventInTx(tx,runId,input):Promise<EventAck>`仅域内调用。

```ts
export type EventProposal={schema_version:"1";run_id:string;attempt_id:string;
 source_event_id:string;event_type:string;payload:Record<string,unknown>};
export type EventAck={event_id:string;seq:string;duplicate:boolean};
```

1. 服务认证/当前capability/fence后，解析严格白名单。事件源不能写`RUN_SUCCEEDED`、预算结算或工具回执；这些只由TS领域命令产生。
2. 在短事务中锁Run，查询唯一源键。已有且source_digest相同返回原ACK，不分配seq；内容不同409 `EVENT_ID_CONFLICT`。
3. 新事件验证current_attempt/current_fence和活跃lease；`latest_seq+1`、事件行、turn投影及必要状态变化同事务。source_digest由服务端对event_type/schema/payload按确定规则计算，不信任传入摘要。
4. 提交后才能返回ACK和发布。数据库失败时不把event留在内存“先显示后补”；暂停消费/关闭Go连接并让lease失效收敛。
5. 若提交成功但ACK丢失，只重发相同源键和payload。源没有重放能力时将attempt挂起，不能对已失去的文本重新生成后套旧event_id。

Runtime原生SSE没有最终平台seq。TS `dispatcher.ts`是Go流的唯一读取者，在收到每条源事件时按`source_event_id=turn_id+":"+localOrdinal`分配稳定attempt内ID；ordinal映射若未落库且进程丢失，不能新进程从0接同一未知流。当前attempt失联按E2恢复为新attempt/turn，已持久事件保持不动。

### 7.2 白名单与协议语义

| 源事件 | 平台处理 |
|---|---|
| RUN_STARTED | 校验runId=turn_id、threadId匹配；每turn最多一次 |
| TEXT_MESSAGE_START/CONTENT/END | 只接受assistant公开输出；限定messageId、delta字节与顺序，拒绝系统提示和不支持role |
| TOOL_CALL_START/ARGS/END | 不转发完整args；返回受控工具显示名和状态；操作参数由04审核后的preview提供 |
| TOOL_CALL_RESULT | 必须与04持久receipt匹配，Go文本不能独立宣称操作成功 |
| RUN_FINISHED | 标turn协议结束；若interrupt则等待候选；业务终态由TS检查 |
| RUN_ERROR | 稳定错误码，删除原始stack/上游body；再由TS分类failed/suspended |
| STATE_SNAPSHOT/DELTA | 不转发任意Go状态；公开状态由TS账本生成 |
| RAW / reasoning / 任意metadata | 默认不持久公开、不下发；必要诊断另按安全采集规范 |
| CUSTOM | 只允许已注册schema的类型，未知拒绝，不执行其中命令 |

以当前安装的 `@ag-ui/core/client` 和01真实样本做Schema验收，线上文档中的新事件不能未经验证直接加入。运行凭证、租户成员、模型密钥、系统prompt不进入event payload；正文可能含敏感内容，按租户数据级别存储并加密，不用“已去掉metadata”声称内容绝对不泄密。

公开事件是平台`RunEventView`，其payload可以包含白名单AG-UI事件但不假装整个外层就是AG-UI原生协议。06前端适配器解包、按seq去重后交给已核对SDK reducer；UI业务状态依赖TS `RUN_STATE_CHANGED`，不是只看`RUN_FINISHED`。

### E3-A 执行步骤

- [ ] 写真实DB重复/冲突/并发seq测试，再实现append函数。

```ts
const proposal={schema_version:"1" as const,run_id:h.runId,attempt_id:h.attemptId,
 source_event_id:"turn-1:1",event_type:"TEXT_MESSAGE_CONTENT",payload:{messageId:"msg-1",delta:"hello"}};
const first=await h.append(proposal);
const second=await h.append(proposal);
expect(second.seq).toBe(first.seq);
expect(second.duplicate).toBe(true);
await expect(h.append({...proposal,payload:{messageId:"msg-1",delta:"different"}})).rejects.toThrow("EVENT_ID_CONFLICT");
```

fixture先写RUN_STARTED/TEXT_MESSAGE_START，不能用孤立CONTENT绕过顺序校验。`h.append`调用真实appendRuntimeEvent并使用当前DB能力绑定。

- [ ] 写“落库失败零发送”测试：把事务提交注入可识别错误，publisher调用数为0；恢复只按相同source_event_id重放。
- [ ] 验证平台终态伪造、rawEvent、工具参数、capability等额外字段被拒绝/过滤；把原始输入保存在调试日志不算通过。
- [ ] 状态事件与command同事务写；每个业务终态只有一次，Go对同turn重复结束拒绝但已提交源重放可ACK。
- [ ] 运行 `bun test server/tests/enterprise/runs/events.test.ts server/tests/enterprise/runs/event-projection.test.ts`。

### 7.3 游标API、SSE与撤权

**文件：** `runs/stream.ts`、`routes.ts`；测试 `stream.test.ts`、`stream.integration.test.ts`。

`GET /api/enterprise/v1/runs/{id}/events` 支持 `Last-Event-ID`或`after`。游标编码 `base64url(JSON.stringify([run_id,seq]))`，不是能力凭证；严格限长，解码结构正确且run匹配。两者同时存在但不同返回400；不能使用其他Run游标跳过权限。

- SSE帧：`id: <cursor>\nevent: run-event\ndata: <RunEventView JSON>\n\n`；不把原始delta直接拼接SSE行。
- 每批从数据库按seq读（建议最多100条），先重新认证会话、Directory/Scope、Run owner及read权限；对每个实际flush前复查授权并等待writer背压。网络IO不在数据库事务/锁内。
- 撤权提交后新检查必须拒绝；正在内核socket发送的已授权字节无法收回。设定验证的最大批大小/flush授权间隔并在验收记录窗口，不能宣称零字节瞬时撤回。
- 无新数据时退避轮询（测试默认1秒）、发送不含业务内容的心跳；不用新中间件作MVP必需依赖。通知可优化但DB是唯一事实。
- 取消浏览器连接只关闭订阅，不自动取消业务Run。慢读达到有界队列（建议256KiB）关闭订阅，客户端用最后已收到seq重连；不丢已提交事件。
- 不把连接保持为无限授权：session过期/成员暂停关闭流，下一次请求按标准401/403；流已开始后不能改HTTP状态，以无敏感内容的`stream-closed`控制帧并close，不写伪Run失败。

最小编码函数与测试：

```ts
export function sseFrame(cursor:string,event:RunEventView):string {
 if(/[\r\n]/.test(cursor))throw new Error("INVALID_CURSOR");
 return `id: ${cursor}\nevent: run-event\ndata: ${JSON.stringify(event)}\n\n`;
}
```

测试换行delta仍是单条JSON数据、非法cursor拒绝、重复帧客户端按seq丢弃。完整Stream handler使用已安装Hono/标准ReadableStream能力；结束、timeout、signal abort都必须清理定时器和数据库读循环。

### 7.4 重放与保留

- MVP默认不开自动清理，需要明确 `RUN_EVENT_RETENTION_DAYS`、`legal_hold`和容量审批后由06发布维护任务。这个值是部署输入，不虚构法定期限。
- 生成snapshot先投影已提交事件到确定seq，在同事务记录snapshot+digest与低水位；需要清理时只删`seq<=snapshot.seq`且无保全的旧公开事件，保留安全回执与对账账本自己的保留策略。
- 新增Run列 `event_low_watermark bigint NOT NULL DEFAULT 0`。cursor低于watermark时返回409 `EVENT_CURSOR_EXPIRED`，客户端GET `/runs/{id}/snapshot`获得同权限下的公开投影和resume_cursor，再继续；不能默默跳到最新造成漏消息。
- Snapshot重建只包含本Run、owner可见数据，不返回执行checkpoint、原始系统state或全租户会话。

### E3-B/C 验收步骤

- [ ] 断开→继续生成→重连，收到全部已提交seq且不重复；从中间seq开始不能遗漏后续。
- [ ] 保持旧session，暂停成员后验证连接及时关闭；另租户同runId无法订阅；已关闭session不可续流。
- [ ] 慢读、客户端断开、代理空闲timeout、服务重启、清理过期cursor有明确恢复行为，不启动新Run。
- [ ] 在未配置Go/模型时读取历史事件仍可工作；只有执行依赖损坏不应阻断已授权历史查看。
- [ ] 真实TS dispatcher消费Go `/runtime/execution`，屏蔽直连浏览器路径；Go已发送但DB未ACK的输出不能到用户。

命令：`bun test server/tests/enterprise/runs/stream.test.ts server/tests/enterprise/runs/stream.integration.test.ts`，另跑01 `runtime-contract.test.ts`确认turn/事件语义没有回归。

## 8. 模型路由、预算与调用结算（E4-A/B/C/D/E）

### 8.1 路由与发布准入（E4-A）

`model_alias`面向业务；创建Run时解析固定route/version。`models/catalog.ts`提供 `resolveRouteInTx(tx,scope,alias):Promise<ModelRoute>`，`models/policy.ts`提供 `assertModelUseInTx(tx,scope,routeId):Promise<void>`。

ModelRoute是§4.1的route行严格Schema＋部署registry中的目标引用。接口不能接受模型生成的endpoint、headers或credential_ref。目标解析只在TS模型代理/Higress内发生，Go只知道该route_ref。

- route批准要求：模型能力profile、上下文上限、输出上限、价格版本、计费单位、usage解释、取消行为、零重试配置、数据出域范围和测试证据。
- 一个route的一次物理调用只绑定一个明确供应商target。MVP关闭Higress/SDK隐藏重试、跨供应商fallback和共享响应缓存；要降级必须生成经预算批准的新model_attempt并可追踪，不伪装成原请求。
- 可以对**相同计费/能力profile**的健康实例按容量选择，但选定实例后冻结本attempt；跨profile价格变化需新route版本。未知价格/usage/无法硬限制输出的route不得进“硬预算”试点。
- 多模态、缓存折扣、推理Token等未验证计费维度先拒绝，不按纯文本单价套用。批准一个协议profile不等于所有供应商都兼容。

E4-A测试：禁用route后新调用拒绝、已有Run不能改alias跳到新目标、无model_grant拒绝、未知target_ref拒绝、不返回密钥或endpoint、相同别名跨租户独立。

### 8.2 金额与预算算法（E4-B）

单位：一种currency下的整数微单位`micros`（1个货币主单位=1,000,000 micros），不是把不同货币换算后混存。价格用**每Token整数micros**或经批准的更细分母；本册MVP采用前者，不拿UI浮点金额进预算。

`models/money.ts`：

```ts
export function units(value:string):bigint {
 if(!/^(0|[1-9][0-9]*)$/.test(value))throw new Error("INVALID_MONEY");
 const parsed=BigInt(value);
 if(parsed>9223372036854775807n)throw new Error("MONEY_OVERFLOW");
 return parsed;
}
export function cost(inputTokens:bigint,outputTokens:bigint,inRate:bigint,outRate:bigint,fixed:bigint):bigint {
 if([inputTokens,outputTokens,inRate,outRate,fixed].some(v=>v<0n))throw new Error("INVALID_MONEY");
 const result=inputTokens*inRate+outputTokens*outRate+fixed;
 if(result>9223372036854775807n)throw new Error("MONEY_OVERFLOW");
 return result;
}
```

**双层预留，不重复扣款：**

- 创建Run：计算批准的`run_cap`，在tenant/workspace/expert/principal账户同时增加`held`；四层账户是同一次花费的不同约束，不能把四层金额相加当成本。任一层不足全部回滚。
- Run reservation初始 `held=run_cap, spent=0, allocated=0`；绑定本周期账户集合。MVP不允许跨预算周期启动新模型步骤：周期到期停止新分配、将等待/恢复挂起，收完已提交调用费用后关闭reservation。新周期若需继续必须明确新业务Run并重新授权，不自动迁移余额或清空已花费。
- 准备模型：在Run预留内分配 `call_cap`，增加reservation.allocated，不再增加账户held。必须 `allocated+call_cap<=held`，即防止并发模型把同一余额重复使用。
- 确认费用actual且`actual<=call_cap`：`spent+=actual; held-=actual; allocated-=call_cap`，账户同样spent增actual/held减actual；未用差额仍留在Run held供后续使用。
- 确认未提交：仅allocated减call_cap；不记费用。unknown保持allocated与held，不释放。
- Run关闭：只释放`held-allocated`；unknown剩余额度进入reconciliation，核对后追加charge/adjustment再释放。不能TTL到期直接把unknown当零费用。
- actual>call_cap是计费profile违约：先计算 `otherAllocated=allocated-call_cap`、`spendable=held-otherAllocated`、`covered=min(actual,spendable)`；`spent+=actual; held-=covered; allocated=otherAllocated; overage+=actual-covered`。其他未知调用的冻结额度不可被本次超支侵占。账户同样增加真实spent、减少covered并记overage，冻结账户和route、告警。spent不能为了满足预算约束被截断；overage是实际成本中未被预留覆盖的标记，报表不能再将spent+overage重复相加。硬预算承诺以profile上下界已验证为前提。

预留条件更新（上锁账户后按ID顺序执行；任一无返回行抛`BUDGET_EXCEEDED`并回滚）：

```sql
UPDATE enterprise_budget_accounts SET held_micros=held_micros+$3::bigint,revision=revision+1
WHERE tenant_id=$1 AND id=$2 AND status='active'
 AND currency=$4 AND starts_at<=clock_timestamp() AND ends_at>clock_timestamp()
 AND spent_micros+held_micros+$3::bigint<=limit_micros
RETURNING id;
```

分配模型额度：

```sql
UPDATE enterprise_budget_reservations SET allocated_micros=allocated_micros+$3::bigint
WHERE tenant_id=$1 AND id=$2 AND status='open'
 AND allocated_micros+$3::bigint<=held_micros RETURNING id;
```

`models/budget.ts`实现 `BudgetPort.reserveInTx(tx:Tx,input:ReserveInput):Promise<string>`，并导出 `allocateCallInTx(tx:Tx,modelAttemptId:string,callCap:string):Promise<void>`、`settleCallInTx(tx:Tx,receipt:UsageReceipt):Promise<void>`、`closeReservationInTx(tx:Tx,reservationId:string):Promise<void>`。receipt类型在E4-C定义；tenant来自受信事务上下文，SQL同时限定tenant，不只按id更新。所有方法由上层按账户→Run→reservation→model_attempt顺序取锁，不在持有Run锁后补锁账户。

增加Schema字段：budget_accounts/reservations的`overage_micros bigint DEFAULT 0`、reservation`closed_at?`。追加不可变账务entry与settlement revision防重复；若同revision不同evidence_digest返回409，不重复扣减。

**保守call_cap：** 使用route批准的最大输入Token＋最大输出Token＋固定费用，或者已证明准确的tokenizer计数上界。不能用字符数/简单估计作硬预算。Go传的max_tokens只可减少，TS最后强制上限，供应商必须被验证遵守。

### E4-B 测试步骤

- [ ] 写 `money.test.ts` 和 `budget.test.ts` 的并发失败测试。

```ts
import { expect,test } from "bun:test";
import { units,cost } from "../../../src/enterprise/models/money";
test("large amounts never round through Number",()=>{
 expect(units("9007199254740993")).toBe(9007199254740993n);
 expect(cost(10n,2n,3n,7n,5n)).toBe(49n);
});
```

数据库fixture预算100微单位、两个并发Run各预留80（仅测试数值）：只允许一个成功，spent=0、held=80。预留、模型分配、结算完成后核对四层计数一致。

- [ ] 写unknown费用不释放、重复settlement不重复扣、跨周期、费用超cap冻结、余额不足不拨号测试。
- [ ] 实现固定SQL与BigInt算法，再接回E1创建事务，不能用旧modelUsage次数换算金额。
- [ ] 运行 `bun test server/tests/enterprise/models/money.test.ts server/tests/enterprise/models/budget.test.ts`，所有数据库fixture采用02安全库检查。
### 8.3 受控模型请求与可信计量（E4-C）

**数据路径：** Go Model Adapter → TS独立内部模型代理 → 固定Higress路由 → 批准供应商。网络策略禁止Go直接连接Higress供应商入口或互联网模型端点，防止绕过逐Run预算。Higress负责协议与流量治理，TS负责一次调用的业务授权和资金上限；两层不能各重试一次导致多次计费。

模型接口：

```ts
export type ModelGrantRequest={run_id:string;attempt_id:string;logical_call_id:string;
 lease_id:string;fencing_token:string;model_route_ref:string};
export type ModelGrant={model_capability:string;logical_call_id:string;expires_at:string};
export type UsageReceipt={model_attempt_id:string;receipt_revision:string;evidence_digest:string;
 status:"not_submitted"|"succeeded"|"failed"|"unknown";
 input_tokens:string|null;output_tokens:string|null;cost_micros:string|null;
 provider_request_id:string|null;source:"proxy_response"|"provider_reconciliation"};
```

- `POST /internal/enterprise/v1/models/grants`：有效runtime能力只允许申请一次指定logical_call的短期model能力，绑定相同Run/attempt/fence/route、服务及期限；不发起供应商请求。新grant重试不能新建新的logical_call；同键同绑定返回可轮换的等价能力，旧能力撤销，不能扩大金额。
- `POST /internal/enterprise/v1/models/chat/completions`：机器服务凭证＋model能力；body使用冻结的兼容协议profile，TS忽略/拒绝用户提供的provider/host/header；model字段必须等于批准alias或由TS覆写为route绑定的实际模型。
- `GET /internal/enterprise/v1/models/calls/{logical_call_id}`：只返回当前能力绑定的调用状态和最小回执。不得因为GET未找到而擅自重新提交一个已超时的请求；先确认数据库没有提交记录且能力未被消费。

代理执行算法：

1. 在body读取前做服务认证、body总字节限额；解析后按profile检查所有messages/tool schema/响应类型与generation limits。body含system/tool历史只允许来自已认证Runtime的服务端上下文装配，不对浏览器开放该路径。
2. TS按确定字段序列计算真实request_digest，能力查到logical_call。准备tx按固定锁顺序重新验证成员/RunPolicy/route/模型授权/lease；已seal或cancel拒绝。
3. 查既有model_attempt：同key不同digest409；已succeeded可返回已持久且profile允许重放的结果（不得新发供应商请求）；submitted/unknown返回409 `MODEL_OUTCOME_UNKNOWN`；已failed也不由网络重试创建新ID。首次分配call_cap并写reserved。
4. 提交`submitted`意图及状态时间，然后才拨号。崩溃发生在提交后、拨号前也保守为unknown，因为其他进程无法证明没发送；不以“很可能未发”退费后重跑。
5. 只从registry选择固定目标，禁redirect，限制连接/读/总耗时，不能转发客户端cookie、内部capability或service凭证到供应商。Higress认证密钥由TS独立秘密服务加载，不下发Go。
6. 上游usage只在代理可信响应路径解析；不要根据Go上报或模型文字计量。stream usage缺失/格式错误/提前断线→unknown，冻结cap并禁止自动重试，不记0费用。
7. 真正最终usage＋响应结束后，在tx中写UsageReceipt、模型attempt终态、reservation和账户变更、usage_entries；成功后才向Go发出最终确认结束。若结算失败则中止并记待对账，不发伪成功；此前流式文本只能作为未完成输出。
8. 完整响应重放存储由平台控制：给model_attempt追加 `response_ref`（受限对象或小型加密响应快照）、`response_digest`。只保存必要的重放结果，不把供应商完整原始header/body无条件入库。未保存结果的已完成调用返回已完成状态，不能重发以“找回”结果。

**usage归一化：** profile声明返回值是累计总量还是delta，最终累计值不能反复相加；input/output/cache/reasoning不能交叠重复计费；测试同一个最终usage重复出现只结算一次。MVP价格profile仅支持已验证的输入/输出/固定费；新增维度必须同时升级价格Schema、公式、上界与测试。

**同一logical_call是否可重新尝试：** 网络ACK不确定→不可以；明确本地校验拒绝且未提交→可使用同key更正请求须新业务意图及新command，不覆盖旧摘要；供应商明确拒绝且确认不计费→保留failed，重新调用需显式新模型attempt策略及额度，不能由SDK自动执行。

### E4-C 执行步骤

- [ ] `proxy.test.ts` 写拨号计数测试：预算不足、已取消、错fence、路由不匹配、超限body分别为0次上游请求；并发同logical_call只有1次。
- [ ] 在批准的隔离fake上游模拟成功usage、重复usage、断流、超时、5xx、redirect、超大响应；测试结果不代表供应商真实语义。
- [ ] 实现 `models/proxy.ts` 固定状态意图→调用→settle流程，测试`submitted`后杀进程再重放不增加拨号数。
- [ ] 加入真实Higress配置验收：固定target、重试关闭、运行期禁用/限流、上游计数与TS attempt一致。不能从网关介绍页面推断所有插件字段；执行前固定已部署版本，导出实际配置脱敏摘要并验证Schema。
- [ ] 经明确授权后用低预算真实模型验证usage和费用上界；没有该输入时E4-C只记协议验证，不能通过计费准入门禁。

命令：`bun test server/tests/enterprise/models/proxy.test.ts server/tests/enterprise/models/usage.test.ts`；真实网关测试文件 `gateway.integration.test.ts` 必须要求隔离端点配置，无配置记录blocked而非pass。

### 8.4 Go逐次模型绑定（E4-D）

**现状差量：** `runtime-go/cmd/runtime/main.go`当前在进程级创建一个带固定配置的模型客户端。此处不能只替换baseURL后继续共享静态长效key；每次模型GenerateContent必须从私有context获取当前run、申请特定logical_call能力，并为该调用建立独立headers。

在 `runtime-go/internal/modelproxy/model.go` 包装现有 `model.Model`。已核对框架接口 `GenerateContent(context.Context,*model.Request)(<-chan *model.Response,error)`、`Info()model.Info`。实现签名：

```go
package modelproxy

import (
 "context"
 "errors"
 "openbot/runtime-go/internal/identity"
 "trpc.group/trpc-go/trpc-agent-go/model"
)

type Call struct { LogicalID string; Capability string; ServiceCredential string }
type GrantClient interface {
 Issue(context.Context, identity.VerifiedRun, *model.Request) (Call, error)
}
type Model struct {
 Grants GrantClient
 Factory func(Call) model.Model
 Metadata model.Info
}
func (m *Model) Info() model.Info { return m.Metadata }
func (m *Model) GenerateContent(ctx context.Context, req *model.Request) (<-chan *model.Response,error) {
 if req==nil { return nil,errors.New("MODEL_INPUT_REQUIRED") }
 run,err:=identity.FromContext(ctx)
 if err!=nil { return nil,err }
 grant,err:=m.Grants.Issue(ctx,run,req)
 if err!=nil { return nil,err }
 return m.Factory(grant).GenerateContent(ctx,req)
}
```

`GrantClient.Issue`在 `client.go` 通过固定内部grants路径申请；logicalID由受信step上下文的`step_id+call_ordinal`派生，不是模型字符串。step上下文由TS确认的恢复计划提供，ordinal在每个新调用前持久化到模型域映射；重试Issue保持相同键。没有step映射时拒绝，不以随机新ID掩盖未知旧调用。

Factory使用已存在模型适配器的 `WithBaseURL`、`WithHeaders`创建**每调用独立**客户端，headers仅含机器凭证、model capability和logicalID；密钥不进入模型messages。供应商长期key从Go配置移除；兼容SDK如强制要求apiKey字段，只传该短期model能力且在TS接收后不转发。`WithHeaders`不是线程安全的全局可变map，禁止并发Run相互覆写。

关闭底层SDK自动重试并以fake上游拨号计数实证；精确option以当前锁定SDK类型确认，不升级依赖来凑示例。Go传入的stream最终成功只有TS已settle确认才结束；模型客户端捕获错误后不能隐式再次GenerateContent。无凭证context、不同Run并发、不匹配route、过期能力及取消均有单元测试。

**Go测试文件：** `internal/modelproxy/model_test.go`、`client_test.go`；修改 `cmd/runtime/main.go` 的模型构造，将provider替换为包装器；其他专家/工具的装配不重建。

- [ ] 写两个并发上下文分别使用不同model能力的测试、nil/unverified请求拒绝测试。
- [ ] 实现GrantClient/Factory和固定目标校验，验证Go进程无供应商长期key、不能请求未批准的目标。
- [ ] 跑 `go test ./internal/modelproxy ./internal/server ./internal/adapter -count=1`（workdir=runtime-go）。
- [ ] TS真实DB→Go→TS代理→fake模型集成测试，usage和Run预算一致；跨Run能力/旧fence被拒。
- [ ] 复跑01协议测试，验证代码变化未重新打开legacy callback或客户端resume权限。

### 8.5 对账、熔断与既有billing边界（E4-E）

`models/reconciliation.ts` 提供 `applyReconciliation(scopeOfService,receipt:UsageReceipt):Promise<void>`：scopeOfService来自maintenance验证，不能接受用户body的成本覆盖。证据必须含provider_request_id/请求时间窗口、route/price revision、供应商或可信代理记录摘要、审核来源；没有证据保持unknown。

- unknown不按租约TTL自动清零。定时扫描只创建核对任务与告警，不发起新模型请求。
- 迟到成功记实际成本并释放对应cap；迟到确证未提交只释放分配额；同模型receipt_revision相同内容幂等，不同内容冲突。
- actual超cap或单位含义变化→冻结route/相关账户，阻止新Run；保留overage，不因CHECK约束把实际支出丢弃。
- 批量缓存只用于报表，准入每次查锁内余额；熔断状态持久化，API不可接受客户端`ignore_budget`。
- 当前 `server/src/billing/` 和Lago相关改动保持不动。实时预算是内部成本上限，Billing是商业权益/收费；一个是准入数据，一个是下游账单，不作为彼此权威覆盖。
- 将来输出用量：在 `enterprise_run_outbox`增加 `usage_export` kind，稳定event_id=usage_entry.id；03只保证事件可导出。具体适配既有Billing需单独集成任务及测试，不能用模型请求重试作为对账手段。
- 成本报告分别列actual、held、unknown、overage，不把held称为已消费，不将四层预算之和称为总成本。

命令：`bun test server/tests/enterprise/models/reconciliation.test.ts`；故障覆盖回执丢失、重复对账、晚到费用、双工作者、撤权后收账仍可进行且不可重新执行。

## 9. 入口、实际装配与运维接口

### 9.1 公共API

| 方法与路径（前缀 `/api/enterprise/v1`） | 输入/响应 | 守卫 |
|---|---|---|
| POST `/runs` | CreateRun＋Idempotency-Key；202 RunView | session、Scope、start/模型grant、预算 |
| GET `/runs/{id}` | RunView | 当前owner与read权限；不暴露输入/秘密 |
| POST `/runs/{id}/commands` | RunCommand；202/200 RunView | command_id、expected_revision、同源JSON、按动作验证 |
| GET `/runs/{id}/events` | 有界SSE | 每批及flush授权，游标严格解析 |
| GET `/runs/{id}/snapshot` | 公开快照＋resume_cursor | 与events同权限 |
| GET `/models` | 已批准且当前可用alias/能力摘要 | 当前model_grant；不返回目标/秘密 |
| GET `/runs/{id}/usage` | actual/held/unknown/币种 | owner，不返回其他用户或tenant总额 |

用户不直接调用startAttempt、状态跳转、settle、grant capability。创建Run只代表接收，接口返回不会等待模型结束。

### 9.2 内部API

前缀 `/internal/enterprise/v1`，**独立listener**，反向代理禁止公开路由。总计划已有路径保持不变：

| 路径 | 调用者与凭证 | 实现拥有者 |
|---|---|---|
| POST `/runtime/validate` | Runtime机器凭证＋运行能力 | 现有validation-routes＋本册ledger-verifier |
| POST `/runs/{id}/claim`、`/heartbeat` | 编排机器身份/当前lease | leases.ts |
| POST `/runs/{id}/events`、`/checkpoints` | Runtime凭证＋能力＋current fence | events/checkpoints |
| GET `/runs/{id}/execution-context` | 当前Runtime能力，禁止公共body历史 | checkpoints.ts |
| POST `/runs/{id}/control` | 编排/维护控制权限＋固定command | control-routes.ts；无任意状态写入 |
| POST `/models/grants`、`/models/chat/completions` | 上述两阶段模型能力 | models/proxy.ts |
| GET `/models/calls/{logical_call_id}` | 绑定当前调用的服务/能力 | model status查询 |
| POST `/models/reconciliation` | 独立settlement服务，受限数据源 | reconciliation.ts |
| tool-invocations prepare/execute | 不在03装配fake | 04正式实现后才挂载 |

所有内部响应禁止返回token_hash、用户完整对象、DB URL。限body、请求超时、scope白名单；错误分类使用固定code/request_id/retryable，不把上游原始错误传到公开API。

当前 `EnterpriseError.status` 不含413/429，本册触及错误接线时增量加入这两种：body超限413、明确配额/并发拒绝429，未知计费结果409；鉴权仍401/403，未知程序错误500，已识别依赖故障503。对任何可能已经提交的模型/工具操作，即使HTTP为可恢复错误也不建议自动重试；公开create重放必须保持原Idempotency-Key。

公共路由的最小真实接线（放在现有Scope中间件后，完整get/command/events路径以本节表注册）：

```ts
import { Hono } from "hono";
import type { EnterpriseVariables } from "../app";
import { EnterpriseError } from "../errors";
import { CreateRunSchema,ID } from "../../../../shared/enterprise/run-contracts";
import type { RunService } from "./contracts";
export function mountRunRoutes(api:Hono<{Variables:EnterpriseVariables}>,runs:RunService):void {
 api.post("/runs",async c=>{
  const key=ID.safeParse(c.req.header("idempotency-key"));
  if(!key.success)throw new EnterpriseError("IDEMPOTENCY_KEY_REQUIRED",400);
  const body=CreateRunSchema.safeParse(await c.req.json());
  if(!body.success)throw new EnterpriseError("INVALID_RUN_INPUT",400);
  return c.json(await runs.create(c.var.scope,key.data,body.data),202);
 });
 api.get("/runs/:id",async c=>{
  const id=ID.safeParse(c.req.param("id"));
  if(!id.success)throw new EnterpriseError("RUN_NOT_FOUND",404);
  return c.json(await runs.get(c.var.scope,id.data));
 });
}
```

在读取JSON前用流式累计字节限制中间件，超过64KiB（建议测试默认）取消读取并413；非法JSON必须400，不让语法错误变成500。同源CSRF沿用02既有guard。RunService.get在withTenant里检查owner/资源read后返回RunView；command按kind严格Schema、CAS和幂等事务；events每批按同样owner/read检查，不用一次HTTP入口授权代替长流授权。

### 9.3 装配顺序

1. 保留02 `bootstrapEnterprise`的只读模式，新增可选 `runServices`依赖对象；显式运行功能启用才装配模型/内部服务。未启用不注册POST `/runs`，不是注册空实现返回成功。
2. `app.ts`在现有Scope中间件后挂 `mountRunRoutes(api,runServices)`；readiness继承身份/DB检查；运行功能不可用不得让既有只读模块伪装失败，但创建Run应明确503。
3. 扩展config读取运行域专属DB、内部监听地址、批准runtime registry、目标registry、服务认证hash、超时/配额；明确禁止默认公网地址和默认身份。启动先验证角色/RLS表集合，不只硬编码旧6表数。
4. `internal-index.ts`建立独立Hono内部app、独立认证与错误映射，不复用公开session中间件。不把内部listener配置为与公网同端口后仅靠路径阻挡。
5. runtime dispatcher由06独立Node Worker通过幂等内部命令控制；本册TS只提供执行和持久接口，不另起轮询旧routines。03测试用fake WorkflowStarter只能在测试入口显式注入。
6. drain先拒新Run/claim/model grant，停止领取Outbox，保留取消、回执收账与事件ACK，在期限内落最后状态后关闭连接池。强制退出不能标所有Run为成功/取消，剩余通过lease检查挂起。

新增运维命令只能读状态或发固定maintenance命令：`inspect-run/reconcile-model/expire-lease`，默认dry-run；写操作需operation_id和批准证据，不提供`force-success`或`clear-held-all`。

### 9.4 脱敏监控

- 指标：queued/running/suspended数、Outbox延迟、过期lease数、fence拒绝数、事件落库延迟/背压、unknown模型数/金额、预算拒绝、overage、取消未退出时长。
- 低基数指标只用state/route_profile/error_code；tenant/run/operation等标识放权限保护的trace/log，不作为无限标签。
- 不采集系统prompt、用户正文、能力Token、headers、供应商完整body到默认日志。诊断关联使用服务器产生request_id/trace_id。
- unknown费用、连续fence失败、预算账实不符、取消未退出、Outbox积压必须告警；具体阈值由D5容量/值守目标确定，03提供可测计数与查询，不编造SLO。

## 10. 迁移、检查与验收

### 10.1 迁移顺序

- [ ] 读取当前Schema/journal/用户差异，新增本册表，不重建已有02表与Go module。
- [ ] DBA授权后创建新角色；普通Drizzle迁移定义表，custom迁移定义RLS/延迟FK/部分索引；编号由generator分配。
- [ ] 在全新隔离库和已有02测试数据的升级库各跑一次；身份/资源只读路径回归不变。
- [ ] 部署只读历史查看→启用本地账本命令测试→批准的无工具release→模型网关试验；真实工具/生产调度须等04/06及门禁。
- [ ] 验证失败关闭运行入口，不DROP历史账本、不清空冻结额度、不把新Run流量切回旧工具路径。

### 10.2 测试矩阵

| ID | 场景 | 必须观察到的结果 | 所有者 |
|---|---|---|---|
| RUN-01 | 同创建key并发、ACK丢失 | 一个Run/预留/Outbox；不同摘要409 | E1-C |
| RUN-02 | Run插入后预算失败/Outbox失败 | 全事务回滚 | E1-C/E4-B |
| RUN-03 | 其他tenant/principal/thread引用 | 403/404/FK拒绝；无正文 | E1/T2 |
| RUN-04 | workflow启动ACK丢失 | 按同workflow_id查询/重发，不多建业务Run | E2/D2 |
| RUN-05 | lease过期/旧进程复活 | 新效果和新事件拒绝，已提交同摘要仅ACK | E2-B |
| RUN-06 | 取消与成功并发 | CAS只允许一个有效终态 | E2-A |
| RUN-07 | cancel accepted但未退出 | 保持cancel_requested，不虚报停机 | E2-D |
| RUN-08 | 等待批准跨进程重启 | 从持久checkpoint和04回执恢复，不能旧断言ignoreExpiry | E2-C/P3/D2 |
| RUN-09 | 事件提交成功ACK丢失 | 相同seq，不重复append | E3-A |
| RUN-10 | 数据库不可写但Go仍产出 | 不发布未提交事件，背压/挂起 | E3-A |
| RUN-11 | 断线续流/慢读/过期cursor | 按seq恢复或明确snapshot重置，不新建Run | E3-B/C |
| RUN-12 | session到期/成员撤权 | 流关闭，后续批无越权；记录已发送窗口 | E3-B |
| RUN-13 | Go伪造工具成功/预算结果 | 不改变平台事实 | E3/P3 |
| MOD-01 | 并发预留超过任一层预算 | 部分请求拒绝且零上游调用 | E4-B |
| MOD-02 | 同logical_call重放 | 最多一次新上游提交；不同digest409 | E4-C |
| MOD-03 | usage缺失/超时/5xx不明费用 | unknown＋冻结额度，不自动重试 | E4-C/E |
| MOD-04 | 重复/迟到settlement | 幂等结算，已终态Run不重开 | E4-E |
| MOD-05 | actual超cap | 真实支出记录＋冻结告警，不截断 | E4-B/E |
| MOD-06 | Go更换endpoint/route/凭证 | 网络与业务双重拒绝 | E4-D/D4 |
| MOD-07 | 下游/SDK隐藏重试 | 供应商计数必须与账本一致，否则profile不准入 | E4-C |
| MOD-08 | 撤权后模型尚在返回 | 不准新调用；受限维护身份可收账 | E2/E4 |
| ISO-01 | 内部端点从公网/旧UI到达 | 无路由或拒绝，不能借session调用 | E1/D4 |
| ISO-02 | dispatcher/Go读取客户数据或凭证 | 数据库权限/网络拒绝 | E1-B/D4 |
| DEP-01 | 只读02未启用运行域 | 不要求Go/Higress/Temporal，原入口正常 | 集成 |

检查点、取消和预算测试用进程退出/连接中断的真实故障注入，不能只修改内存状态来声称重启恢复。G1b/G2只有总计划注册的签署方可批准，03文档完成不等于通过门禁。

### 10.3 待执行检查命令

```bash
bun test server/tests/enterprise/runs
bun test server/tests/enterprise/models
bun test server/tests/enterprise/runtime-ledger.test.ts
bun test server/tests/enterprise/runtime-contract.test.ts
bun run --cwd server typecheck:enterprise
bun run --cwd server typecheck
bun run format:check
bun run lint
bun run test:ci
```

Go目录：

```bash
go test ./internal/modelproxy ./internal/resume ./internal/server ./internal/adapter -count=1
go test -race ./internal/modelproxy ./internal/server -count=1
go vet ./...
```

race需要目标环境支持；无法执行明确blocked，不改成普通test冒充race通过。当前enterprise tsconfig显式排除部分runtime测试：本册触及的测试先修正真实类型问题再移除相应exclude，不用关闭strict或继续排除来获得类型检查通过。CI已有enterprise命令，不重复添加；将本册新测试、Go和数据库role fixture接入实际CI。最低测试数量门槛不是精确总数，不凭新增用例猜数量。

只改文档时不运行这些会修改/访问环境的命令；实际执行时保存command、exit_code、源码/依赖/工作区摘要、fixture、DB角色、route/price/policy revision与限制。不保存凭证或客户材料。

## 11. 交接与必须阻断的输入

| 输入/下游 | 责任人 | 未具备时的明确行为 |
|---|---|---|
| 隔离DB、最小角色、真实身份测试 | DBA/安全/后端 | 真实集成blocked，不跳过后算pass |
| 专家发布版本、工具manifest与许可 | 05负责人/产品 | 只允许已审核无工具测试release，不开真实工具 |
| 04效果账本/审批回执/封存屏障 | 工具负责人 | 等待审批与副作用恢复blocked，不能空实现 |
| 06 Node/Temporal持久编排 | 调度/SRE | 生产POST创建禁用，测试可用明确fake starter |
| 固定Higress版本/配置、模型价格与usage证据 | 模型/SRE/财务 | profile不准入硬预算，不自动猜单价 |
| 保留期、密钥/存储、恢复水位 | 安全/法务/SRE | 不自动删除；容量与存储试点门禁阻断 |
| 业务评测样本、成本/质量阈值 | 产品/业务 | 协议验证不替代模型效果验收 |

03完成后的接收接口：04消费Run/attempt/fence与预算端口，返回真实效果屏障；05发布不可变RunRelease并使用model计量；06以Run命令和Outbox稳定键接入Temporal、以RunEventView接前端、以独立内部服务接部署。所有依赖从当前契约读取，不重建另一套标识/状态。

## 12. 依据、限制与本次交付范围

- [AG-UI事件语义](https://docs.ag-ui.com/concepts/events)：仅辅助理解，实际能力以当前锁定SDK和01契约测试为准。
- [Higress能力概览](https://higress.ai/docs/latest/overview/what-is-higress/)：确认网关职责，不据此宣称逐Run预算、重试控制或任何性能已验收。
- [Temporal超时与失败处理](https://docs.temporal.io/develop/typescript/workflows/timeouts)：业务Run与工作流状态分离，D2须单独验证Activity重试/取消。
- [锁定候选模型接口](https://raw.githubusercontent.com/trpc-group/trpc-agent-go/9bb1c42b968c659124a5bb76eb6a676d546442a1/model/model.go)、[模型适配选项](https://raw.githubusercontent.com/trpc-group/trpc-agent-go/9bb1c42b968c659124a5bb76eb6a676d546442a1/model/openai/options.go)：为本册Go包装器提供已读接口依据，不授权依赖升级。

当前工作区的01/02已有部分实现和用户进度。本册只读核对，不重复声称历史测试通过，不恢复旧设计，不修改其他分册或源代码。此处所有生产步骤与验收项均待执行，方案文件的完成不证明数据恢复、计费准确或生产隔离已达标。

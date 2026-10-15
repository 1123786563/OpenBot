# 执行前计划预检

状态：计划自查通过；运行时验证尚未执行。

## 任务内部一致性

|Task|文件/测试/接口检查|结果|
|---|---|---|
|1|bun test server/tests/enterprise/contract-schema.test.ts server/tests/enterprise/sdk-compatibility.test.ts 对应 Step 3 行为；核心断言在所属测试文件；Consumes/Produces 使用统一注册名；角色 backend_implementer|计划文本一致；执行证据待产生|
|2|bun test server/tests/enterprise/tenancy.integration.test.ts server/tests/enterprise/authz.integration.test.ts 对应 Step 3 行为；核心断言在所属测试文件；Consumes/Produces 使用统一注册名；角色 backend_implementer|计划文本一致；执行证据待产生|
|3|bun test server/tests/enterprise/conversations.integration.test.ts server/tests/thread-routes.test.ts 对应 Step 3 行为；核心断言在所属测试文件；Consumes/Produces 使用统一注册名；角色 backend_implementer|计划文本一致；执行证据待产生|
|4|bun test server/tests/enterprise/runs.integration.test.ts server/tests/enterprise/model-gateway.test.ts 对应 Step 3 行为；核心断言在所属测试文件；Consumes/Produces 使用统一注册名；角色 backend_implementer|计划文本一致；执行证据待产生|
|5|bun test server/tests/enterprise/tool-receipts.integration.test.ts server/tests/enterprise/tool-approval.test.ts 对应 Step 3 行为；核心断言在所属测试文件；Consumes/Produces 使用统一注册名；角色 backend_implementer|计划文本一致；执行证据待产生|
|6|go test ./... -count=1（runtime-go）；bun test server/tests/enterprise/runtime-process.test.ts（仓库根） 对应 Step 3 行为；核心断言在所属测试文件；Consumes/Produces 使用统一注册名；角色 backend_implementer|计划文本一致；执行证据待产生|
|7|bun test server/tests/enterprise/event-replay.integration.test.ts；go test ./internal/callback -count=1（runtime-go） 对应 Step 3 行为；核心断言在所属测试文件；Consumes/Produces 使用统一注册名；角色 backend_implementer|计划文本一致；执行证据待产生|
|8|bun test server/tests/enterprise/platform-runner.test.ts server/tests/enterprise/copilot-transport.test.ts 对应 Step 3 行为；核心断言在所属测试文件；Consumes/Produces 使用统一注册名；角色 backend_implementer|计划文本一致；执行证据待产生|
|9|bun test app/src/lib/copilot/platform-transport.test.ts；bun tests/runtime/chat-journey.ts 对应 Step 3 行为；核心断言在所属测试文件；Consumes/Produces 使用统一注册名；角色 frontend_implementer|计划文本一致；执行证据待产生|
|10|bun test server/tests/enterprise/recovery.integration.test.ts 对应 Step 3 行为；核心断言在所属测试文件；Consumes/Produces 使用统一注册名；角色 backend_implementer|计划文本一致；执行证据待产生|
|11|go test ./... -count=1（runtime-go）；bun test server/tests/enterprise/runtime-recovery.test.ts 对应 Step 3 行为；核心断言在所属测试文件；Consumes/Produces 使用统一注册名；角色 backend_implementer|计划文本一致；执行证据待产生|
|12|bun test server/tests/enterprise/headless-entrypoints.test.ts server/tests/enterprise/channel-runtime.test.ts 对应 Step 3 行为；核心断言在所属测试文件；Consumes/Produces 使用统一注册名；角色 backend_implementer|计划文本一致；执行证据待产生|
|13|bun test server/tests/enterprise/memory-provenance.integration.test.ts server/tests/memory-runtime.test.ts 对应 Step 3 行为；核心断言在所属测试文件；Consumes/Produces 使用统一注册名；角色 backend_implementer|计划文本一致；执行证据待产生|
|14|bun test server/tests/enterprise/learning-pipeline.integration.test.ts server/tests/learning-runtime.test.ts 对应 Step 3 行为；核心断言在所属测试文件；Consumes/Produces 使用统一注册名；角色 backend_implementer|计划文本一致；执行证据待产生|
|15|bun test app/src/lib/learning/queries.test.ts；bun tests/runtime/learning-journey.ts 对应 Step 3 行为；核心断言在所属测试文件；Consumes/Produces 使用统一注册名；角色 frontend_implementer|计划文本一致；执行证据待产生|
|16|bun test server/tests/enterprise/history-import.integration.test.ts 对应 Step 3 行为；核心断言在所属测试文件；Consumes/Produces 使用统一注册名；角色 backend_implementer|计划文本一致；执行证据待产生|
|17|bun test server/tests/enterprise/platform-config.test.ts tests/compose.test.ts；bun tests/runtime/deployment-offline.test.ts；helm lint charts/openbot 对应 Step 3 行为；核心断言在所属测试文件；Consumes/Produces 使用统一注册名；角色 backend_implementer|计划文本一致；执行证据待产生|
|18|cargo test --manifest-path desktop/src-tauri/Cargo.toml platform_runtime；cargo check --manifest-path desktop/src-tauri/Cargo.toml 对应 Step 3 行为；核心断言在所属测试文件；Consumes/Produces 使用统一注册名；角色 backend_implementer|计划文本一致；执行证据待产生|
|19|bun test desktop/src/App.test.tsx desktop/src/telemetry.test.ts；bun run --cwd desktop typecheck；bun tests/runtime/desktop-setup-journey.ts；bun tests/runtime/mobile-chat-journey.ts 对应 Step 3 行为；核心断言在所属测试文件；Consumes/Produces 使用统一注册名；角色 frontend_implementer|计划文本一致；执行证据待产生|
|20|bun test server/tests/enterprise/intelligence-removal.test.ts；bun server/scripts/runtime-acceptance.ts；go mod verify、go vet ./...、go test ./... -count=1、govulncheck ./...（runtime-go）；bun run typecheck；bun run lint；bun run build 对应 Step 3 行为；核心断言在所属测试文件；Consumes/Produces 使用统一注册名；角色 backend_implementer|计划文本一致；执行证据待产生|

## 每对共享文件或接口

|生产/消费任务|共享文件或合同|顺序及判断|
|---|---|---|
|T01 → T02|RuntimeTestFixture|前置已审查检查点后串行消费；同名合同来自Task 1，所属服务只有已指定任务实现。无计划冲突。|
|T01 → T03|ConversationDTO; RuntimeTestFixture|前置已审查检查点后串行消费；同名合同来自Task 1，所属服务只有已指定任务实现。无计划冲突。|
|T01 → T04|RunDTO|前置已审查检查点后串行消费；同名合同来自Task 1，所属服务只有已指定任务实现。无计划冲突。|
|T01 → T05|ToolReceiptDTO|前置已审查检查点后串行消费；同名合同来自Task 1，所属服务只有已指定任务实现。无计划冲突。|
|T01 → T06|RunDTO|前置已审查检查点后串行消费；同名合同来自Task 1，所属服务只有已指定任务实现。无计划冲突。|
|T01 → T07|EventDTO|前置已审查检查点后串行消费；同名合同来自Task 1，所属服务只有已指定任务实现。无计划冲突。|
|T01 → T08|Task 1 公共合同注册表|前置已审查检查点后串行消费；同名合同来自Task 1，所属服务只有已指定任务实现。无计划冲突。|
|T01 → T09|ConversationDTO; EventDTO|前置已审查检查点后串行消费；同名合同来自Task 1，所属服务只有已指定任务实现。无计划冲突。|
|T01 → T10|CheckpointDTO; RunDTO|前置已审查检查点后串行消费；同名合同来自Task 1，所属服务只有已指定任务实现。无计划冲突。|
|T01 → T11|Task 1 公共合同注册表|前置已审查检查点后串行消费；同名合同来自Task 1，所属服务只有已指定任务实现。无计划冲突。|
|T01 → T12|Task 1 公共合同注册表|前置已审查检查点后串行消费；同名合同来自Task 1，所属服务只有已指定任务实现。无计划冲突。|
|T01 → T13|Task 1 公共合同注册表|前置已审查检查点后串行消费；同名合同来自Task 1，所属服务只有已指定任务实现。无计划冲突。|
|T01 → T14|Task 1 公共合同注册表|前置已审查检查点后串行消费；同名合同来自Task 1，所属服务只有已指定任务实现。无计划冲突。|
|T01 → T15|Task 1 公共合同注册表|前置已审查检查点后串行消费；同名合同来自Task 1，所属服务只有已指定任务实现。无计划冲突。|
|T01 → T16|Task 1 公共合同注册表|前置已审查检查点后串行消费；同名合同来自Task 1，所属服务只有已指定任务实现。无计划冲突。|
|T01 → T17|Task 1 公共合同注册表|前置已审查检查点后串行消费；同名合同来自Task 1，所属服务只有已指定任务实现。无计划冲突。|
|T01 → T18|Task 1 公共合同注册表|前置已审查检查点后串行消费；同名合同来自Task 1，所属服务只有已指定任务实现。无计划冲突。|
|T01 → T19|Task 1 公共合同注册表|前置已审查检查点后串行消费；同名合同来自Task 1，所属服务只有已指定任务实现。无计划冲突。|
|T01 → T20|Task 1 公共合同注册表|前置已审查检查点后串行消费；同名合同来自Task 1，所属服务只有已指定任务实现。无计划冲突。|
|T02 → T03|server/drizzle.config.ts; server/drizzle/; server/src/db/schema/index.ts; ResourceReader; RuntimeTestFixture|前置已审查检查点后串行消费；同名合同来自Task 1，所属服务只有已指定任务实现。无计划冲突。|
|T02 → T04|server/drizzle.config.ts; server/drizzle/; server/src/db/schema/index.ts|前置已审查检查点后串行消费；同名合同来自Task 1，所属服务只有已指定任务实现。无计划冲突。|
|T02 → T05|server/drizzle.config.ts; server/drizzle/; server/src/db/schema/index.ts; ResourceReader|前置已审查检查点后串行消费；同名合同来自Task 1，所属服务只有已指定任务实现。无计划冲突。|
|T02 → T07|server/drizzle/|前置已审查检查点后串行消费；同名合同来自Task 1，所属服务只有已指定任务实现。无计划冲突。|
|T02 → T08|ScopeResolver|前置已审查检查点后串行消费；同名合同来自Task 1，所属服务只有已指定任务实现。无计划冲突。|
|T02 → T12|ResourceReader|前置已审查检查点后串行消费；同名合同来自Task 1，所属服务只有已指定任务实现。无计划冲突。|
|T02 → T13|server/drizzle.config.ts; server/drizzle/; server/src/db/schema/index.ts; ResourceReader|前置已审查检查点后串行消费；同名合同来自Task 1，所属服务只有已指定任务实现。无计划冲突。|
|T02 → T14|server/drizzle/; server/src/db/schema/index.ts; ResourceReader|前置已审查检查点后串行消费；同名合同来自Task 1，所属服务只有已指定任务实现。无计划冲突。|
|T02 → T17|ScopeResolver|前置已审查检查点后串行消费；同名合同来自Task 1，所属服务只有已指定任务实现。无计划冲突。|
|T03 → T04|server/drizzle.config.ts; server/drizzle/; server/src/db/schema/index.ts; ConversationService|前置已审查检查点后串行消费；同名合同来自Task 1，所属服务只有已指定任务实现。无计划冲突。|
|T03 → T05|server/drizzle.config.ts; server/drizzle/; server/src/db/schema/index.ts; ResourceReader|前置已审查检查点后串行消费；同名合同来自Task 1，所属服务只有已指定任务实现。无计划冲突。|
|T03 → T07|server/drizzle/|前置已审查检查点后串行消费；同名合同来自Task 1，所属服务只有已指定任务实现。无计划冲突。|
|T03 → T08|ConversationService|前置已审查检查点后串行消费；同名合同来自Task 1，所属服务只有已指定任务实现。无计划冲突。|
|T03 → T09|ConversationDTO|前置已审查检查点后串行消费；同名合同来自Task 1，所属服务只有已指定任务实现。无计划冲突。|
|T03 → T12|ConversationService; ResourceReader|前置已审查检查点后串行消费；同名合同来自Task 1，所属服务只有已指定任务实现。无计划冲突。|
|T03 → T13|server/drizzle.config.ts; server/drizzle/; server/src/db/schema/index.ts; ConversationService; ResourceReader|前置已审查检查点后串行消费；同名合同来自Task 1，所属服务只有已指定任务实现。无计划冲突。|
|T03 → T14|server/drizzle/; server/src/db/schema/index.ts; ResourceReader|前置已审查检查点后串行消费；同名合同来自Task 1，所属服务只有已指定任务实现。无计划冲突。|
|T03 → T16|ConversationService|前置已审查检查点后串行消费；同名合同来自Task 1，所属服务只有已指定任务实现。无计划冲突。|
|T04 → T05|server/drizzle.config.ts; server/drizzle/; server/src/db/schema/index.ts; RunService|前置已审查检查点后串行消费；同名合同来自Task 1，所属服务只有已指定任务实现。无计划冲突。|
|T04 → T06|ModelGateway; RunDTO; RunService|前置已审查检查点后串行消费；同名合同来自Task 1，所属服务只有已指定任务实现。无计划冲突。|
|T04 → T07|server/drizzle/; server/src/db/schema/enterprise-runs.ts; RunService|前置已审查检查点后串行消费；同名合同来自Task 1，所属服务只有已指定任务实现。无计划冲突。|
|T04 → T08|ConversationService; RunService|前置已审查检查点后串行消费；同名合同来自Task 1，所属服务只有已指定任务实现。无计划冲突。|
|T04 → T10|server/src/enterprise/runs/service.ts; server/src/enterprise/runs/store.ts; RunDTO; RunService|前置已审查检查点后串行消费；同名合同来自Task 1，所属服务只有已指定任务实现。无计划冲突。|
|T04 → T12|ConversationService; RunService|前置已审查检查点后串行消费；同名合同来自Task 1，所属服务只有已指定任务实现。无计划冲突。|
|T04 → T13|server/drizzle.config.ts; server/drizzle/; server/src/db/schema/index.ts; ConversationService; RunService|前置已审查检查点后串行消费；同名合同来自Task 1，所属服务只有已指定任务实现。无计划冲突。|
|T04 → T14|server/drizzle/; server/src/db/schema/index.ts; ModelGateway; RunService|前置已审查检查点后串行消费；同名合同来自Task 1，所属服务只有已指定任务实现。无计划冲突。|
|T04 → T16|ConversationService; RunService|前置已审查检查点后串行消费；同名合同来自Task 1，所属服务只有已指定任务实现。无计划冲突。|
|T04 → T17|ModelGateway|前置已审查检查点后串行消费；同名合同来自Task 1，所属服务只有已指定任务实现。无计划冲突。|
|T05 → T06|RunService; ToolService|前置已审查检查点后串行消费；同名合同来自Task 1，所属服务只有已指定任务实现。无计划冲突。|
|T05 → T07|server/drizzle/; RunService|前置已审查检查点后串行消费；同名合同来自Task 1，所属服务只有已指定任务实现。无计划冲突。|
|T05 → T08|RunService|前置已审查检查点后串行消费；同名合同来自Task 1，所属服务只有已指定任务实现。无计划冲突。|
|T05 → T10|server/src/enterprise/tools/receipts.ts; RunService; ToolService|前置已审查检查点后串行消费；同名合同来自Task 1，所属服务只有已指定任务实现。无计划冲突。|
|T05 → T12|ResourceReader; RunService|前置已审查检查点后串行消费；同名合同来自Task 1，所属服务只有已指定任务实现。无计划冲突。|
|T05 → T13|server/drizzle.config.ts; server/drizzle/; server/src/db/schema/index.ts; ResourceReader; RunService|前置已审查检查点后串行消费；同名合同来自Task 1，所属服务只有已指定任务实现。无计划冲突。|
|T05 → T14|server/drizzle/; server/src/db/schema/index.ts; ResourceReader; RunService|前置已审查检查点后串行消费；同名合同来自Task 1，所属服务只有已指定任务实现。无计划冲突。|
|T05 → T16|RunService|前置已审查检查点后串行消费；同名合同来自Task 1，所属服务只有已指定任务实现。无计划冲突。|
|T06 → T07|RunService; RuntimeInvocation|前置已审查检查点后串行消费；同名合同来自Task 1，所属服务只有已指定任务实现。无计划冲突。|
|T06 → T08|RunService|前置已审查检查点后串行消费；同名合同来自Task 1，所属服务只有已指定任务实现。无计划冲突。|
|T06 → T10|RunDTO; RunService; ToolService|前置已审查检查点后串行消费；同名合同来自Task 1，所属服务只有已指定任务实现。无计划冲突。|
|T06 → T11|runtime-go/internal/server/assembly.go|前置已审查检查点后串行消费；同名合同来自Task 1，所属服务只有已指定任务实现。无计划冲突。|
|T06 → T12|RunService|前置已审查检查点后串行消费；同名合同来自Task 1，所属服务只有已指定任务实现。无计划冲突。|
|T06 → T13|RunService|前置已审查检查点后串行消费；同名合同来自Task 1，所属服务只有已指定任务实现。无计划冲突。|
|T06 → T14|ModelGateway; RunService|前置已审查检查点后串行消费；同名合同来自Task 1，所属服务只有已指定任务实现。无计划冲突。|
|T06 → T16|RunService|前置已审查检查点后串行消费；同名合同来自Task 1，所属服务只有已指定任务实现。无计划冲突。|
|T06 → T17|ModelGateway|前置已审查检查点后串行消费；同名合同来自Task 1，所属服务只有已指定任务实现。无计划冲突。|
|T07 → T08|EventService; RunService|前置已审查检查点后串行消费；同名合同来自Task 1，所属服务只有已指定任务实现。无计划冲突。|
|T07 → T09|EventDTO|前置已审查检查点后串行消费；同名合同来自Task 1，所属服务只有已指定任务实现。无计划冲突。|
|T07 → T10|EventService; RunService|前置已审查检查点后串行消费；同名合同来自Task 1，所属服务只有已指定任务实现。无计划冲突。|
|T07 → T11|EventService|前置已审查检查点后串行消费；同名合同来自Task 1，所属服务只有已指定任务实现。无计划冲突。|
|T07 → T12|RunService|前置已审查检查点后串行消费；同名合同来自Task 1，所属服务只有已指定任务实现。无计划冲突。|
|T07 → T13|server/drizzle/; RunService|前置已审查检查点后串行消费；同名合同来自Task 1，所属服务只有已指定任务实现。无计划冲突。|
|T07 → T14|server/drizzle/; RunService|前置已审查检查点后串行消费；同名合同来自Task 1，所属服务只有已指定任务实现。无计划冲突。|
|T07 → T16|RunService|前置已审查检查点后串行消费；同名合同来自Task 1，所属服务只有已指定任务实现。无计划冲突。|
|T08 → T09|createPlatformRunner(deps: PlatformRunnerDeps, scope: PlatformScope): AgentRunner；createPlatformCopilotHandler(deps: PlatformCopilotDeps): (request: Request) => Promise<Response>；createPlatformRuntime(deps: PlatformRuntimeDeps): PlatformRuntime|前置已审查检查点后串行消费；同名合同来自Task 1，所属服务只有已指定任务实现。无计划冲突。|
|T08 → T10|EventService; RunService|前置已审查检查点后串行消费；同名合同来自Task 1，所属服务只有已指定任务实现。无计划冲突。|
|T08 → T11|EventService|前置已审查检查点后串行消费；同名合同来自Task 1，所属服务只有已指定任务实现。无计划冲突。|
|T08 → T12|ConversationService; RunService|前置已审查检查点后串行消费；同名合同来自Task 1，所属服务只有已指定任务实现。无计划冲突。|
|T08 → T13|ConversationService; RunService|前置已审查检查点后串行消费；同名合同来自Task 1，所属服务只有已指定任务实现。无计划冲突。|
|T08 → T14|RunService|前置已审查检查点后串行消费；同名合同来自Task 1，所属服务只有已指定任务实现。无计划冲突。|
|T08 → T16|ConversationService; RunService|前置已审查检查点后串行消费；同名合同来自Task 1，所属服务只有已指定任务实现。无计划冲突。|
|T08 → T17|server/src/runtime/bootstrap.ts; ScopeResolver|前置已审查检查点后串行消费；同名合同来自Task 1，所属服务只有已指定任务实现。无计划冲突。|
|T09 → T10|createPlatformTransport(options: PlatformTransportOptions): PlatformTransport；既有组件通过同一后端消费历史、运行和订阅|前置已审查检查点后串行消费；同名合同来自Task 1，所属服务只有已指定任务实现。无计划冲突。|
|T10 → T11|CheckpointService; EventService; RecoveryService|前置已审查检查点后串行消费；同名合同来自Task 1，所属服务只有已指定任务实现。无计划冲突。|
|T10 → T12|RunService|前置已审查检查点后串行消费；同名合同来自Task 1，所属服务只有已指定任务实现。无计划冲突。|
|T10 → T13|RunService|前置已审查检查点后串行消费；同名合同来自Task 1，所属服务只有已指定任务实现。无计划冲突。|
|T10 → T14|RunService|前置已审查检查点后串行消费；同名合同来自Task 1，所属服务只有已指定任务实现。无计划冲突。|
|T10 → T16|RunService|前置已审查检查点后串行消费；同名合同来自Task 1，所属服务只有已指定任务实现。无计划冲突。|
|T11 → T12|Go RestoreAgent(ctx context.Context, checkpoint PlatformCheckpoint, deps RecoveryDeps) (agent.Agent,error)；跨进程故障报告 runtime-recovery-report.json|前置已审查检查点后串行消费；同名合同来自Task 1，所属服务只有已指定任务实现。无计划冲突。|
|T12 → T13|ConversationService; ResourceReader; RunService|前置已审查检查点后串行消费；同名合同来自Task 1，所属服务只有已指定任务实现。无计划冲突。|
|T12 → T14|ResourceReader; RunService|前置已审查检查点后串行消费；同名合同来自Task 1，所属服务只有已指定任务实现。无计划冲突。|
|T12 → T16|ConversationService; RunService|前置已审查检查点后串行消费；同名合同来自Task 1，所属服务只有已指定任务实现。无计划冲突。|
|T12 → T17|server/src/index.ts|前置已审查检查点后串行消费；同名合同来自Task 1，所属服务只有已指定任务实现。无计划冲突。|
|T13 → T14|server/drizzle/; server/src/db/schema/index.ts; MemoryProvenanceService; ResourceReader; RunService|前置已审查检查点后串行消费；同名合同来自Task 1，所属服务只有已指定任务实现。无计划冲突。|
|T13 → T16|ConversationService; RunService|前置已审查检查点后串行消费；同名合同来自Task 1，所属服务只有已指定任务实现。无计划冲突。|
|T14 → T15|LearningService|前置已审查检查点后串行消费；同名合同来自Task 1，所属服务只有已指定任务实现。无计划冲突。|
|T14 → T16|LearningService; RunService|前置已审查检查点后串行消费；同名合同来自Task 1，所属服务只有已指定任务实现。无计划冲突。|
|T14 → T17|ModelGateway|前置已审查检查点后串行消费；同名合同来自Task 1，所属服务只有已指定任务实现。无计划冲突。|
|T15 → T16|LearningService|前置已审查检查点后串行消费；同名合同来自Task 1，所属服务只有已指定任务实现。无计划冲突。|
|T16 → T17|importLegacyArchive(scope, archive: LegacyArchive, options: ImportOptions): Promise<ImportReport>；cutoverConversation(scope, input: CutoverInput): Promise<CutoverReceipt>|前置已审查检查点后串行消费；同名合同来自Task 1，所属服务只有已指定任务实现。无计划冲突。|
|T17 → T18|RuntimeCapabilities 的 platform 模式；PlatformRuntimeConfig；自有 TS/Go bootstrap、隔离内部 listener、Compose/Helm 交付|前置已审查检查点后串行消费；同名合同来自Task 1，所属服务只有已指定任务实现。无计划冲突。|
|T18 → T19|平台 setup/health/reconnect Tauri 命令；桌面模型/组织凭据类型维持现有独立含义|前置已审查检查点后串行消费；同名合同来自Task 1，所属服务只有已指定任务实现。无计划冲突。|
|T19 → T20|无 Intelligence 账号/project/key 的可恢复安装向导与 Web/移动/桌面相同聊天行为|前置已审查检查点后串行消费；同名合同来自Task 1，所属服务只有已指定任务实现。无计划冲突。|

## 风险裁定

- SDK 同步 LocalThreadEndpointRunner 不适合异步 DB，Task 8 自有历史路由先匹配；不伪装 Promise 为同步值。
- 原工作区持续变化的 auth/config/index/验证报告与交付可能相交：本 BASE 隔离实现，集成前重新核对并保留用户修改。
- 个人记忆模块已存在，Task 13 原地扩展；频道调度保持 OpenBot 所有，不使用 SDK Intelligence Channels。
- 所有迁移任务串行生成 journal 下一编号，目录所有权仅限本任务增量；不固定已被占用编号。
- 未提交检查点必须包含新增和 ignored 交付文档，BASE..HEAD 空 diff 不能作为 Review 范围。

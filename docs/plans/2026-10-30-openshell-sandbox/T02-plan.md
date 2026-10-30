# T02 每 Bot 独立 computer 浏览器操作 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Project execution rules determine actual dispatch and authorization.

**Goal:** 一个有完整执行归属的 Bot 通过现有 OpenBot computer 入口，在独立 OpenShell 沙箱执行受控浏览器操作。

**Architecture:** 复用 `ComputerProvider` 和 `ComputerGateway`；T01 的 OpenShell driver 负责物理 computer，`agent-computer` 保持浏览器工具协议。可信业务 scope 由 OpenBot 服务解析、绑定至沙箱 identity，工作负载只持有浏览器所需权限。

**Tech Stack:** TypeScript/Bun、Chromium、Helm、OpenShell 测试集群、e2e runner。

**Spec:** `docs/specs/2026-10-30-openshell-sandbox.md`（A01、A02）；`docs/adr/0013-openshell-sandbox-substrate.md`；Ticket 草案 `docs/plans/2026-10-30-openshell-sandbox/ticket-breakdown.md#t02--每-bot-独立-computer-完成一次受控浏览器操作`。

**Issue:** 已发布为正式子 Issue [#736](https://github.com/1123786563/OpenBot/issues/736)（父 Spec [#734](https://github.com/1123786563/OpenBot/issues/734)，标签 `ready-for-agent`，Blocked by [#735](https://github.com/1123786563/OpenBot/issues/735)）。Issue 正文的 4 条验收（通过 OpenBot 入口完成浏览器操作；跨归属访问被拒绝；沙箱外壳不暴露控制面凭据；Chromium 与隔离规则兼容且不得为通过测试放宽已批准边界）分别由本计划 Task 1 与 Task 2 覆盖。`ready-for-agent` 不构成实施授权；实施前须重新摄取 #736 与批准事实源。

## Global Constraints

- **Blocked by T01 verified**，且其 driver、集群版本和隔离探针结果实际进入本工作区；草案不是实施授权。
- 执行身份含真实 tenant/workspace/Bot/environment/generation；跨业务范围即使逻辑 Bot 相同也不共享可变环境（ADR 0006、D7、D22）。
- Chromium 在加固配置下实测，不能使用 `--no-sandbox` 或放宽已批准网络边界换取启动成功；真实兼容性未知是门槛。
- 保留 `ComputerGateway` 和 `ComputerProvider` 既有动作入口、旧模式行为；本票不宣称 T04 的所有服务入口已统一鉴权。
- 完整档：独立行为验收、Review、适用 OCR，证据归 `.archive/runs/`。

## Review Focus

- 同一 Bot ID 被错误地映射到另一业务 scope：动作拒绝且不复用磁盘；Task 1。
- 旧 generation 的 URL/会话被新运行复用：拒绝旧引用；Task 1。
- 浏览器启动需放宽 seccomp 或禁用 Chromium 沙箱：应阻塞交付；Task 2。
- 浏览器容器可读取 Kubernetes/OpenShell token：必须拒绝就绪；Task 2。
- computer 网络策略只在初次启动生效、恢复后失效：重新校验后才允许动作；Task 2。

---

### Task 1: 把可信执行归属传到 computer provider

**Files:** Modify `server/src/computer/provider.ts`, `server/src/computer/openshell.ts`（T01 产物）, `server/src/computer/gateway.ts`, `server/src/computer/routes.ts`; test `server/tests/computer-provider.test.ts`, `server/tests/computer-gateway.test.ts`, `server/tests/multitenancy/computer-allocation.test.ts`。

**Interfaces:** 保持 `ComputerGateway.navigate(botId, actor, url, toolCallId?)` 和 `ComputerProvider.locate(botId): Promise<string>` 的对外形状。OpenShell 内部使用 `OpenShellScope` 与 `scopeFor(botId): Promise<OpenShellScope | null>`；若现有上下文不能安全解析完整 scope，先在 `server/src/computer/routes.ts` 的已鉴权路由到 provider 装配间增加显式可信 resolver，不能从 `x-openbot-*` 客户端头采信。

- [ ] **Step 1: RED。** 增加 `openshell_computer_refuses_missing_or_foreign_execution_scope` 和 `stale_generation_cannot_reach_new_computer`，覆盖 same Bot/different scope、different Bot/same team、缺 scope、旧 session；运行 `E2E_UNIT_OUTPUT=.e2e/t02/scope-red e2e run --config e2e.unit.config.ts server/tests/computer-provider.test.ts server/tests/computer-gateway.test.ts server/tests/multitenancy/computer-allocation.test.ts`，确认新增测试红。
- [ ] **Step 2: GREEN。** 在可信服务器路径解析 scope 并给 T01 driver，沙箱 identity 包含环境和代际；缓存键不能只有 Bot ID。拒绝时无 OpenShell 请求。运行相同套件到 `.e2e/t02/scope-green`，确认新用例绿。
- [ ] **Step 3: 回归。** 验证旧 `shared/docker/sandbox` provider 选择和现有 computer routes 不变；`cd server && bun run typecheck`。

### Task 2: 加固 Chromium 工作负载并完成真实操作

**Files:** Modify `charts/openbot/templates/computer/sandbox-template.yaml` 或 T01 新增的 OpenShell computer 模板（以实际 chart 文件为准）, `agent-computer/src/browser-runtime.ts`, `agent-computer/src/browser-mode.ts`（仅当实测证明需要兼容处理）, `server/src/computer/openshell.ts`; test `agent-computer/tests/runtime-hardening.test.ts`, `agent-computer/tests/headed-browser.test.ts`; create `scripts/openshell-computer-acceptance.ts`。

**Interfaces:** `agent-computer` 的 HTTP/tool 协议不变；OpenShell `locate/status/sessionOf` 只在实际 Chromium ready 且隔离、策略生效后报告 ready，`status` 不唤醒。加固参数要与选定 Chromium 版本、容器权限和 OpenShell 隔离互相兼容。

- [ ] **Step 1: RED。** 增加 `chromium_hardened_launch_refuses_unsafe_fallback`、`computer_workload_has_no_control_plane_credentials` 的验证；执行 `E2E_UNIT_OUTPUT=.e2e/t02/browser-red e2e run --config e2e.unit.config.ts agent-computer/tests/runtime-hardening.test.ts agent-computer/tests/headed-browser.test.ts`，确认新增断言红。
- [ ] **Step 2: GREEN。** 最小修改实际 browser launch/模板，保留 Chromium 沙箱及容器隔离；无权限或不兼容时明确失败，不能自动加 `--no-sandbox`。运行同一套件到 `.e2e/t02/browser-green`。
- [ ] **Step 3: 真实验收。** `scripts/openshell-computer-acceptance.ts` 从 OpenBot 已鉴权 computer 路由依次打开测试页面、执行受控点击、读取结果；另用不同 Bot/团队/合法业务范围尝试文件、profile、管理和网络访问，断言拒绝且无数据泄漏。实测容器内凭据不可见、seccomp/用户权限/Chromium 进程状态、策略恢复后仍生效。测试前核独占集群资源和输入，报告版本/配置/失败注入到 `.archive/runs/<run-key>/verification/`。
- [ ] **Step 4: 终验。** 独立 reviewer 核 A01/A02 与加固实际证据，执行适用 OCR；任何 OpenShell/Chromium 兼容门槛未证实则 T02 保持 blocked。

// server/src/gateway/integration.ts
// MOD08（Issue #628，根 #620）：M06 的具名内部集成臂（Bifrost 同步实现入口收拢）。
//
// 只做一件事：把「Key 状态同步的实现入口」装配从 assembly/runtime.ts 内联直传
// （原 `startGatewayKeyStateSyncScheduler({ database, auditStore, client:
// createGatewayVirtualKeyStateClient({ readGatewayEndpoint, resolveGatewayAdminCredential }) })`）
// 收拢为 M06 组内的**具名臂**。此前 Bifrost Key 同步的内部部件（key-state-sync.ts
// 的调度器与状态客户端、admin-credential/endpoint-config 的 controls 读取）在装配点
// 被直接触达；此后这一装配有唯一具名入口，调用方不再直接操纵同步实现
// （Issue #628 目标与范围）。
//
//   - key-state-sync.ts / admin-credential.ts / endpoint-config.ts 零改动：臂内逐字节
//     调用同一工厂（同参、同缺省语义——调度周期仍由环境变量在 start 函数内解析，
//     端点/凭据仍在客户端闭包里按调用时解析）。
//   - 同步实现细节不进 public：GatewayKeyStateSyncService / GatewayVirtualKeyStateClient
//     / GatewayKeyStateSyncScheduler 是 M06 内部 Adapter，只经本臂承载，public.ts
//     结构性不含（结构断言见 tests/multitenancy/model-access-public.test.ts D6）。
//   - 唯一装配差异是凭据缺失路径的具名化：原内联写法用非空断言（biome
//     noNonNullAssertion 禁新增），臂内改为显式守卫并按本组既有措辞抛出
//     （key-revocation.ts createDeploymentGrantKeyRevocator 同一句）；同步客户端把
//     任何抛出归类为既有 `gateway_key_sync_credential_unavailable`，结果形状不变。
//   - 类型纪律（MOD05/06/07 先例）：入参与产物形状经 M06 组内工厂签名以
//     ReturnType<> 提取，本文件不 import 跨模块契约——零新跨模块边。

import { gatewayAdminCredentialControls } from "./admin-credential";
import { gatewayEndpointControls } from "./endpoint-config";
import {
  createGatewayVirtualKeyStateClient,
  startGatewayKeyStateSyncScheduler,
} from "./key-state-sync";

/** 臂入参：调度器工厂的选项去掉 `client`——客户端的构造归本臂所有；装配层只持有
 *  共享数据库与 boot 审计 trail（05.9 的漂移告警读取它）。测试可按工厂同义注入
 *  `service`/`intervalMs`/`timer`。 */
export type GatewayKeyStateSyncArmInput = Omit<
  Parameters<typeof startGatewayKeyStateSyncScheduler>[0],
  "client"
>;

/** 臂产物（= startGatewayKeyStateSyncScheduler 的返回：同步器或未装配时的 undefined）。 */
export type GatewayKeyStateSyncArm = ReturnType<
  typeof startGatewayKeyStateSyncScheduler
>;

/**
 * 具名装配臂：包装 Key 状态同步的客户端构造与调度器启动。逐字节转发既有工厂（零逻辑、
 * 零判定、零缺省改写——调度周期仍由工厂按环境变量解析）；装配层经本臂接入 Bifrost
 * Key 同步，不再内联直传。
 */
export function createGatewayKeyStateSyncArm(
  input: GatewayKeyStateSyncArmInput,
): GatewayKeyStateSyncArm {
  const { database, auditStore, ...schedulerOptions } = input;
  return startGatewayKeyStateSyncScheduler({
    ...schedulerOptions,
    ...(database === undefined ? {} : { database }),
    ...(auditStore === undefined ? {} : { auditStore }),
    client: createGatewayVirtualKeyStateClient({
      readGatewayEndpoint: async () => {
        const controls = gatewayEndpointControls();
        return controls ? controls.readGatewayEndpoint() : undefined;
      },
      resolveGatewayAdminCredential: async () => {
        const controls = gatewayAdminCredentialControls();
        if (!controls) {
          throw new Error("The gateway admin credential is not configured.");
        }
        return controls.resolveGatewayAdminCredential();
      },
    }),
  });
}

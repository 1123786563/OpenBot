/*
 * MOD03 (#623): the deployment entry is now a thin shim. The runtime
 * assembly (config parsing, factory composition, background starts, the
 * explicit shutdown lifecycle) lives in ./assembly/runtime's
 * assembleRuntime(); the two MT009/MT011 services are re-exported for their
 * future consumers. Shape follows production-entry.ts: entry files boot,
 * they do not assemble.
 */
import { assembleRuntime } from "./assembly/runtime";
const runtime = await assembleRuntime();
export const teamResourceActionService = runtime.teamResourceActionService;
export const resourceInventoryService = runtime.resourceInventoryService;

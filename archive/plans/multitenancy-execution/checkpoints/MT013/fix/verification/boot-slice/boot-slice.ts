// MT013 fix round boot slice — mirrors server/src/index.ts startup wiring exactly:
// loadConfig() → if (config.multitenancy.enabled) { runMultitenancyStartupChecks(...); applyStartupVerdict(record, { log }); }
// Prints BOOT_CONTINUED if the process survived the verdict (i.e., index.ts would keep booting).
// Fix-round variants: cw = corrupt waiver file, mw = waiver path set but file absent.
// Expectation after F1: exactly ONE structured multitenancy-startup-validation record on
// stdout, exit 1, and NO stack trace on stderr (previously: bare TypeError stack + zero records).
import { loadConfig } from "/Users/wuyongjun/orca/workspaces/OpenBot/i6-mt013/server/src/config";
import {
  applyStartupVerdict,
  runMultitenancyStartupChecks,
} from "/Users/wuyongjun/orca/workspaces/OpenBot/i6-mt013/server/src/enterprise/tenancy/startup-checks";
import { getLogger } from "/Users/wuyongjun/orca/workspaces/OpenBot/i6-mt013/shared/logger";

const log = getLogger("server");
const config = loadConfig(process.env as Record<string, string | undefined>);
if (config.multitenancy.enabled) {
  const startupRecord = await runMultitenancyStartupChecks({
    inventoryPath: config.multitenancy.inventoryPath,
    waiversPath: config.multitenancy.waiversPath,
    directoryUrl: config.enterpriseDirectoryDatabaseUrl,
    dataUrl: config.enterpriseDataDatabaseUrl,
    tenantRuntimeUrl: config.tenantStorageRuntimeDatabaseUrl,
    singleUser: config.singleUser,
    singleUserEnvRaw: process.env.OPENBOT_SINGLE_USER,
    devNoAuthEnvRaw: process.env.OPENBOT_DEV_NO_AUTH,
  });
  applyStartupVerdict(startupRecord, { log });
}
console.log(`BOOT_CONTINUED multitenancy=${config.multitenancy.enabled}`);

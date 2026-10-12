/**
 * The craft module's public surface — what app.ts (or a boot file) imports to mount it.
 *
 * ASSEMBLY (the app.ts integration snippet; the module deliberately does not patch app.ts
 * itself — mounting is a deployment decision, like the workshop's):
 *
 * ```ts
 * import { createCraftRoutes } from "./craft";
 * import { loadCraftConfig } from "./craft/config";
 *
 * // in createApp's wiring, where the workshop routes mount:
 * const craftConfig = loadCraftConfig(process.env);
 * if (craftConfig.enabled) {
 *   app.route(
 *     "/api/craft",
 *     createCraftRoutes({
 *       requireUser,
 *       deps: {
 *         config: craftConfig,
 *         db: database,
 *         redis,                       // RedisPort | null — same port the workshop uses
 *         botIdFor: async (sessionId) => /* resolve the Bot owning this session *​/,
 *         llmConfigFor: async (session) => /* CraftLLMProviderConfig from your catalog *​/,
 *         sandboxConnectionFor: (botId) => sandboxClients.has(botId)
 *           ? { baseUrl: craftConfig.sandboxGatewayBaseUrl, token: craftConfig.sandboxGatewayToken }
 *           : null,
 *         userNameFor: async (userId) => (await db.select()...)?[0]?.name ?? null,
 *       },
 *     }),
 *   );
 * }
 * ```
 *
 * The three integration seams a deployment must answer (mirroring how the workshop
 * mounts behind canUseBot): which Bot's sandbox hosts a session, where the LLM catalog
 * comes from, and how to reach the agent-sandbox gateway.
 */

export {
  buildConnectableAppsList,
  COMPANY_KNOWLEDGE_SECTION,
  type ConnectableApp,
  generateAgentInstructions,
} from "./agent-instructions";
export {
  type CreateCraftPermissionGateInput,
  createCraftPermissionGate,
  isToolGated,
} from "./approval-gate";
export {
  type CraftApprovalSignals,
  createCraftApprovalSignals,
  createInProcessApprovalSignals,
} from "./approval-signals";
export {
  type CraftApprovalCandidate,
  craftApprovalDigest,
  createCraftApprovalRoutes,
  listLiveApprovals,
  openCraftApproval,
} from "./approvals";
export {
  type CraftConfig,
  type CraftEnv,
  type CraftStorageConfig,
  loadCraftConfig,
} from "./config";
export {
  SandboxProvisioningError,
  SandboxProvisioningInProgressError,
  StaleProvisioningAttemptError,
  UploadLimitExceededError,
} from "./errors";
export {
  approvalRequestedPacket,
  type BuildPacket,
  compactionPacket,
  contextUsagePacket,
  errorPacket,
  isBuildPacket,
  type TurnStreamItem,
} from "./events/packets";
export {
  type AgentMessageChunk,
  type AgentThoughtChunk,
  activityTimeoutError,
  isActivityTimeout,
  type PromptResponse,
  type SandboxEvent,
  SSEKeepalive,
  type ToolCallProgress,
  type ToolCallStart,
  TURN_ERROR_CODE_SESSION,
  TURN_ERROR_CODE_TIMEOUT,
  TURN_ERROR_CODE_TRANSPORT,
} from "./events/types";
export { createInterruptFence, type InterruptFence } from "./interrupt";
export {
  type AgentSelection,
  buildGatewayConfig,
  CRAFT_GATEWAY_PROVIDER_ID,
  type GatewaySelection,
  parseAgentSelection,
} from "./llm-config";
export { createSessionFlowLocks, type SessionFlowLocks } from "./locks";
export {
  type ConnectableAppServerRow,
  type CraftManagedContent,
  type CraftManagedContentResolver,
  type CraftManagedContentSources,
  companySearchSkillAvailable,
  createCraftManagedContentResolver,
  MANAGED_SKILLS_DIR,
  type ManagedContentFileApi,
  materializeManagedContent,
  personalUnconnectedApps,
  type ResolvedCraftManagedContent,
  USER_LIBRARY_DIR,
} from "./managed-content";
export { CraftSessionManager } from "./manager";
export { generateSessionName } from "./naming";
export { PodEventBus } from "./opencode/event-bus";
export {
  OpencodeHttpError,
  OpencodeServeClient,
  type PermissionAskedInfo,
  type PermissionGate,
  type PermissionGateDecision,
  type PromptAttachment,
  parsePermissionAsked,
  TurnState,
  translateOpencodeEvent,
  turnStateForStream,
} from "./opencode/serve-client";
export {
  buildProviderOpencodeConfig,
  type CraftLLMProviderConfig,
  type CraftModelDescriptor,
  opencodeConfigJson,
} from "./opencode-config";
export {
  type CraftRoutesDeps,
  type CraftRoutesFactory,
  createCraftRoutes,
  stopCraftIdleReaper,
} from "./routes";
export {
  createSandboxGateway,
  type SandboxGateway,
} from "./sandbox-gateway";
export {
  type CraftEditorMode,
  type CraftScheduledTaskRow,
  type CraftScheduledTaskRunRow,
  type CraftScheduledTaskStore,
  compileToCron,
  computeNextRunAt,
  createCraftScheduledTaskStore,
  createScheduledTaskRoutes,
  type EditorPayload,
  fireAndForgetRun,
  humanReadable,
  nextNFires,
  runScheduledTask,
  type ScheduledTaskExecutorDeps,
  type ScheduledTaskRoutesDeps,
  startCraftScheduledTaskSweeper,
  sweepScheduledTasks,
  validateCron,
} from "./scheduled-tasks";
export {
  type CraftIdleReaper,
  type CraftIdleReaperDeps,
  deleteSnapshots,
  restoreLatestSnapshot,
  type SnapshotContext,
  snapshotStoragePath,
  startCraftIdleReaper,
  takeSnapshot,
} from "./snapshot";
export {
  createObjectStore,
  type ObjectStore,
  type ObjectStoreMetadata,
} from "./storage/object-store";
export {
  type CraftMessageRow,
  type CraftSessionRow,
  type CraftSnapshotRow,
  type CraftStore,
  createCraftStore,
  newCraftId,
} from "./store";
export {
  BuildStreamingState,
  eventToSse,
  finalizePersist,
  persistSandboxEvent,
  SSE_KEEPALIVE,
} from "./streaming";
export {
  clearTurnDeadline,
  stampTurnDeadline,
  TURN_BUDGET_CLEAR_JSON,
  turnBudgetPluginSource,
  turnBudgetStampJson,
  turnBudgetStampPath,
} from "./turn-budget";
export {
  CONNECT_APP_PLUGIN_RELPATH,
  SESSION_CONNECT_APP_PLUGIN_SPEC,
  SESSION_PLUGINS,
  SESSION_TURN_BUDGET_PLUGIN_SPEC,
  TURN_BUDGET_PLUGIN_RELPATH,
} from "./session-plugins";
export {
  createTurnExecutor,
  MAX_TIMEOUT_CONTINUATIONS,
  TURN_ERROR_SUFFIX,
  type TurnExecutor,
} from "./turn-executor";
export { CRAFT_SSE_HEADERS } from "./turn-routes";
export {
  createTurnStateStore,
  type InteractiveTurn,
  type TurnStateStore,
} from "./turn-state";
export {
  SESSIONS_ROOT,
  sessionDirectory,
  setupSessionWorkspace,
} from "./workspace";

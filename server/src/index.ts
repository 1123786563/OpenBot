import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { AbstractAgent } from "@ag-ui/client";
import {
  CopilotKitIntelligence,
  IntelligenceAgentRunner,
} from "@copilotkit/runtime/v2";
import { serve } from "bun";
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { COMPUTER_GUIDANCE } from "../../shared/bot-prompt";
import { DICTATION_HTTP_IDLE_SECONDS } from "../../shared/dictation";
import { getLogger } from "../../shared/logger";
import { buildResponsibilityTurn } from "../../shared/responsibility-turn";
import { initProcessTracing } from "../../shared/trace";
import { workOwner } from "../../shared/work-owner";
import { createActivityStore } from "./activity/activity";
import {
  auditRoutineStore,
  enterpriseControls,
  guardDeliveryStore,
  guardHostAccess,
  headlessTurnRefusal,
  installEnterpriseControls,
} from "./admin/controls";
import {
  CoworkerUnavailableError,
  createActorAgentResolver,
} from "./agents/agent-resolver";
import {
  mintRunAssertion,
  type RunAssertion,
  readApprovedRunAssertion,
  readRunAssertion,
} from "./agents/callback-token";
import { canUseComputer } from "./agents/computer-access";
import { createAgentFetch } from "./agents/endpoint";
import { createHandoffDesk, HANDOFF_KIND } from "./agents/handoff";
import { createHandoffDelivery } from "./agents/handoff-delivery";
import { createHandoffRunner } from "./agents/handoff-runner";
import { signHandoffDeliveryRun } from "./agents/handoff-signing";
import {
  authoriseCoordinationRun,
  createCoordinationTools,
  readCoordinationHandoffClaim,
} from "./agents/handoff-tool";
import {
  configureBotLifecycle,
  createBotLifecycleStore,
} from "./agents/lifecycle";
import { createBotReset } from "./agents/lifecycle-reset";
import {
  createOpenMuseTemplateRevisionStore,
  createOpenMuseTemplateStore,
} from "./agents/openmuse-template-store";
import { canManageAgent } from "./agents/profile-policy";
import { createAgentProfileStore } from "./agents/profile-store";
import type { AgentActor } from "./agents/profile-types";
import { createRuntimeAgentLoader } from "./agents/runtime-agents";
import {
  createWakeUpRunner,
  createWakeUpStore,
  wakeUpTools,
} from "./agents/wake-up";
import { createRunBindingStore } from "./ai-observability/bindings";
import { opikConfigFromEnv } from "./ai-observability/config";
import type { BotManagementCheck } from "./ai-observability/context";
import { createOpikHealthService } from "./ai-observability/health";
import { createIdLinkStore } from "./ai-observability/id-links";
import { createModelSpanRecorder } from "./ai-observability/model-span";
import { createToolStepRecorder } from "./ai-observability/tool-steps";
import { createAiObservabilityRoutes } from "./ai-observability/routes";
import { createApp, createDeploymentRequireUser } from "./app";
import { createApprovedActionExecutor } from "./approvals/execute";
import {
  PERSON_QUESTION_WAITING,
  resumePersonQuestion,
} from "./approvals/question-resume";
import {
  createApprovalQuestions,
  type PersonQuestion,
  personQuestionSchema,
  questionConversationBot,
} from "./approvals/questions";
import {
  type ApprovalResumeDependencies,
  createApprovalService,
} from "./approvals/service";
import { createApprovalStore } from "./approvals/store";
import {
  ApprovalRefusedError,
  currentApprovalContext,
  parseApprovalContinuation,
  parseApprovalResult,
} from "./approvals/types";
import {
  type AuditInitiator,
  createAuditReader,
  createAuditStore,
  DEPLOYMENT_INITIATOR,
  handoffInitiator,
  PERSON_INITIATOR,
  recordAuditEvent,
} from "./audit";
import { startRetentionSweeps } from "./audit-retention";
import { createAuth } from "./auth";
import { DEV_ACTOR, initializeDevActorUser } from "./auth/dev-actor";
import type { AuthService } from "./auth/guards";
import { createRoleRepository } from "./auth/guards";
import { createIdentityProviderStore } from "./auth/identity-provider-store";
import { createOrganizationAuth } from "./auth/organization";
import { organizationUserStore } from "./auth/organization-store";
import type { OpenBotRole } from "./auth/roles";
import { CREDIT_SCALE, createCredits } from "./billing/credits";
import { createCreditWriter } from "./billing/credits-writer";
import {
  countChatInputTokens,
  fitChatInputRequest,
} from "./billing/input-bound";
import { createLagoClient } from "./billing/lago";
import { startUsageDeliverySweeps } from "./billing/maintenance";
import { checkOutboundUrl, createOutboundGuard } from "./billing/outbound";
import { createAlipayProvider } from "./billing/payments/alipay";
import { startPaymentSweeps } from "./billing/payments/maintenance";
import { createPaymentService } from "./billing/payments/service";
import { createPaymentStore } from "./billing/payments/store";
import { createWechatProvider } from "./billing/payments/wechat";
import { createReconciler } from "./billing/reconcile";
import {
  createBillingService,
  deploymentExternalCustomerId,
} from "./billing/service";
import { createBillingStatements } from "./billing/statements";
import { createBillingStore } from "./billing/store";
import {
  createCreditUsageTarget,
  createLagoUsageTarget,
  createUsageDelivery,
} from "./billing/usage-delivery";
import {
  createUsageEvidenceRecorder,
  isConfirmedNoCost,
} from "./billing/usage-evidence";
import { createUsageOutbox, UsageOutboxConflictError } from "./billing/usage-outbox";
import { USAGE_IDEMPOTENCY_KEY_PREFIX } from "./billing/types";
import { createWebhookVerifier } from "./billing/webhook-signature";
import {
  loadAttachmentForTurn,
  markAttachmentsSent,
} from "./channels/attachments";
import {
  createChannelEventHub,
  startChannelActivityListener,
} from "./channels/events";
import {
  createGroupConversations,
  createGroupStore,
  groupSourceForRun,
} from "./channels/group";
import { type ChannelStore, createChannelStore } from "./channels/routes";
import { websocket as channelSocket } from "./channels/socket";
import { createStallGuard } from "./channels/stall-guard";
import {
  forgetSettledSummaries,
  offerChannelsAwaitingSummary,
  summariseClaimedChannels,
} from "./channels/summary";
import { createThreadIdentity } from "./channels/thread-identity";
import { createChannelTitler } from "./channels/titler";
import { createSandboxClient } from "./codesandbox/client";
import { createCodeRunGateway } from "./codesandbox/gateway";
import type { CodeRunGatewayFactory } from "./codesandbox/routes";
import { createCodeRunStore } from "./codesandbox/store";
import { createSandboxedStore } from "./components/sandboxed";
import { createComponentStore } from "./components/store";
import { createComputerGateway } from "./computer/gateway";
import {
  createHeadlessComputerTools,
  HeadlessToolSuspension,
} from "./computer/headless-tools";
import { createPageFrameStore } from "./computer/page-frames";
import { startPolicyListener } from "./computer/policy-listener";
import { withPolicyPushOnWake } from "./computer/policy-network";
import {
  createPolicyStore,
  DEFAULT_ACTION_POLICY,
} from "./computer/policy-store";
import {
  createComputerProvider,
  describeComputerIsolation,
} from "./computer/provider";
import { createSnapshotStore } from "./computer/snapshot-store";
import { createStreamAuthorizer } from "./computer/stream-auth";
import { loadConfig } from "./config";
import {
  CreditGateError,
  CreditGateFailureError,
  CreditPolicyUnconfiguredError,
  type IdentifyActor,
  type IdentifyUser,
  ModelNotPricedError,
  ModelUsageSettlementError,
  mountCopilotRuntime,
  normalizeModelBaseUrls,
  runtimeModelForEnvironment,
  setBuiltinModelSpanObserver,
  setBuiltinToolStepObserver,
  setModelUsageGate,
  type ToolSelection,
} from "./copilot";
import { loadCraftConfig } from "./craft/config";
import { builtinSkillFilesFor, buildAvailableSourcesSection } from "./craft/builtin-skills";
import type { CraftKbSearch } from "./craft/kb-search-relay";
import { projectKbSearchResults } from "./craft/kb-search-relay";
import {
  createCraftManagedContentResolver,
  personalUnconnectedApps,
} from "./craft/managed-content";
import { resolveCraftMcpServers } from "./craft/mcp-servers";
import type {
  CraftLLMProviderConfig,
  CraftModelDescriptor,
} from "./craft/opencode-config";
import {
  type CraftRoutesFactory,
  createCraftRoutes,
  stopCraftIdleReaper,
} from "./craft/routes";
import { createCraftStore } from "./craft/store";
import {
  type WebappHmrSocketData,
  resolveWebappHmrUpgrade,
  webappHmrSessionIdFromPath,
  webappHmrSocketHandlers,
} from "./craft/webapp-proxy";
import {
  createCredentialAdminService,
  createCredentialStore,
  decryptCredentialForUse,
  resolveModelApiKey,
} from "./credentials";
import { createDatabase } from "./db/client";
import {
  channelAgents,
  channelMemberships,
  channels,
  intelligenceChannelMappings,
  responsibilityRuns,
  routineRuns,
  sessions,
} from "./db/schema";
import { createDeliveryRouter, DELIVERY_WORK_KINDS } from "./delivery/router";
import {
  configuredDeliveryProviders,
  type DeliveryScopeResolver,
} from "./delivery/routes";
import { createDeliveryStore } from "./delivery/store";
import type { DeliveryScope } from "./delivery/types";
import { DeliveryRefusedError } from "./delivery/types";
import { createDemonstrationRecorder } from "./demonstrations/recording";
import { createDemonstrationStore } from "./demonstrations/store";
import {
  createConversationRoutes,
  createUnavailableConversationRoutes,
} from "./enterprise/conversations/routes";
import { createConversationService } from "./enterprise/conversations/service";
import { createProductionRunnerComposition } from "./enterprise/runs/runner";
import {
  verifyDataDatabase,
  verifyDirectoryDatabase,
} from "./enterprise/tenancy/connections";
import { createScopeResolver } from "./enterprise/tenancy/store";
import {
  createHostAccessBroker,
  HostAccessRefusedError,
} from "./host-access/broker";
import { hostAccessTools } from "./host-access/tools";
import { githubCallbackRoutes } from "./identity/github-callback";
import { retireIdentityLinks, retireOwnedAccounts } from "./identity/retire";
import { slackCodeRedeemer } from "./identity/slack-redeem";
import { createIdentityStore } from "./identity/store";
import {
  createIntelligenceClient,
  observeIntelligenceAuthentication,
} from "./intelligence-client";
import { knowledgeServiceConfig } from "./knowledge/config";
import { knowledgeRequest } from "./knowledge/client";
import type { KnowledgeSearchResult } from "./knowledge/types";
import {
  createKnowledgeRuntime,
  knowledgeRetrievalOptionsFromEnv,
  setKnowledgeRetrievalObserver,
} from "./knowledge/retrieval";
import { knowledgeTools } from "./knowledge/tools";
import { clearLearningRevisionFallback } from "./learning/runtime";
import {
  createLearningAutoAssign,
  probeLearningContainer,
  withLearningAutoAssign,
} from "./learning/auto-assign";
import {
  cliLoginPresent,
  ensureLearningContainer,
  intelligenceApiOrigin,
  keyIntelligence,
  learningSetupInstructions,
} from "./learning/ensure-container";
import { createLearningSettingsStore } from "./learning/settings";
import { PostgresTenantStorageRegistry } from "./mastra/postgres-registry";
import {
  RegistryTenantStorageLookup,
  type TenantCredentialStore,
} from "./mastra/provisioning";
import { createTenantMastraStorage } from "./mastra/tenant-storage";
import { createMarketplaceStore } from "./marketplace/store";
import { createMemoryDefaults } from "./memory/defaults";
import { createMemoryIngestion } from "./memory/ingestion";
import { createIntelligenceMemory } from "./memory/intelligence";
import { createMemoryStore } from "./memory/store";
import { memoryTools } from "./memory/tools";
import { OPENMUSE_TEMPLATE_KEY } from "./mobile-bff/openmuse-bot";
import { createActivityFeed } from "./openmuse-activity/feed";
import { createOpenMuseActivityRoutes } from "./openmuse-activity/routes";
import { createOpenMuseCalendarClient } from "./openmuse-calendar/client";
import { createOpenMuseCalendarRoutes } from "./openmuse-calendar/routes";
import {
  createOpenConnectorOAuthClient,
  gmailClientCredentialsFromEnv,
  pushGmailClientConfig,
} from "./openmuse-connectors/client";
import { createOpenMuseGoogleOAuth } from "./openmuse-connectors/google-oauth";
import {
  createOpenMuseGoogleCallbackRoutes,
  createOpenMuseGoogleRoutes,
} from "./openmuse-connectors/routes";
import { createOpenMuseGoogleRows } from "./openmuse-connectors/store";
import { createOpenMuseDeletionManifest } from "./openmuse-deletion/manifest";
import { createOpenMuseFileBytePurger } from "./openmuse-deletion/purge";
import { createOpenMuseRelationalPurger } from "./openmuse-deletion/purge-relational";
import {
  createOpenMuseBackupRetention,
  createOpenMuseDeletionCleanupView,
} from "./openmuse-deletion/retention";
import { createOpenMuseDeletionRestore } from "./openmuse-deletion/restore";
import { createOpenMuseExternalAccessRevoker } from "./openmuse-deletion/revoke";
import { createOpenMuseWorkShutdown, recordWorkShutdown } from "./openmuse-deletion/shutdown";
import {
  createOpenMuseAccountDeletionStore,
  createOpenMuseDeletionResourceRows,
  recordDeletionResources,
} from "./openmuse-deletion/store";
import { createOpenMuseDocumentsRoutes } from "./openmuse-documents/routes";
import { createLocalFileByteStore } from "./openmuse-files/bytes";
import {
  createOpenMuseFileRows,
  createOpenMuseFileStore,
} from "./openmuse-files/store";
import {
  buildOpenMuseMailClient,
  createOpenMuseMailDial,
} from "./openmuse-mail/client";
import { createOpenMuseMailRoutes } from "./openmuse-mail/routes";
import { createOpenMuseNotificationRoutes } from "./openmuse-notifications/routes";
import {
  createOpenMuseNotificationRows,
  createOpenMuseNotificationStore,
  type OpenMuseNotificationEvent,
} from "./openmuse-notifications/store";
import { createOpenMuseOpsSignalsRoutes } from "./openmuse-ops/routes";
import {
  createOpenMuseOpsSignalReaders,
  createOpenMuseOpsSignals,
} from "./openmuse-ops/signals";
import {
  createOpenMuseGoalRows,
  createOpenMuseGoalStore,
  createOpenMuseGoalsRoutes,
  goalLookupFor,
} from "./openmuse-personal/goals";
import {
  createOpenMuseIdeaRows,
  createOpenMuseIdeaStore,
  createOpenMuseIdeasRoutes,
  ideaLookupFor,
} from "./openmuse-personal/ideas";
import {
  createOpenMuseMemoriesRoutes,
  createOpenMuseMemoryRows,
  createOpenMuseMemoryStore,
  memoryLookupFor,
} from "./openmuse-personal/memories";
import { openMusePersonalTools } from "./openmuse-personal/tools";
import { createCalendarCreateExecutor } from "./openmuse-reviewed-actions/calendar-create-executor";
import { createCalendarDeleteExecutor } from "./openmuse-reviewed-actions/calendar-delete-executor";
import { createCalendarUpdateExecutor } from "./openmuse-reviewed-actions/calendar-update-executor";
import { createKindDispatchingExecutor } from "./openmuse-reviewed-actions/dispatch-executor";
import { createGmailSendExecutor } from "./openmuse-reviewed-actions/gmail-send-executor";
import { createOpenMuseReviewedActionsRoutes } from "./openmuse-reviewed-actions/routes";
import { createOpenMuseReviewedActionService } from "./openmuse-reviewed-actions/service";
import {
  createOpenMuseActivityReviewedLister,
  createOpenMuseReviewedActionRows,
} from "./openmuse-reviewed-actions/store";
import { createOpenMuseTaskRunner } from "./openmuse-tasks/runner";
import {
  createOpenMuseTaskRows,
  createOpenMuseTaskStore,
} from "./openmuse-tasks/store";
import { createSignInNotifier, createSignInResumer } from "./passwords/resume";
import { createSignInService } from "./passwords/service";
import { createPasswordStore } from "./passwords/store";
import { createOnboardingStore } from "./people/onboarding";
import { createPeopleStore } from "./people/store";
import { createAccountModeSwitch } from "./plugins/account-mode";
import { useRoutineTools } from "./plugins/builtin-routines";
import { useComposioClient } from "./plugins/composio";
import { createComposioClient } from "./plugins/composio-adapter";
import { backfillComposioLogos } from "./plugins/logos";
import { redirectUriFor } from "./plugins/oauth";
import { useOpenConnectorClient } from "./plugins/openconnector";
import { createOpenConnectorClient } from "./plugins/openconnector-adapter";
import {
  createSharedUseGate,
  createSharedUseStore,
} from "./plugins/shared-use-store";
import { createPluginStore } from "./plugins/store";
import {
  grantedSkills,
  grantedTools,
  REFUSAL_MARKER,
  vendorAnswer,
} from "./plugins/tools";
import { createProactiveEngine } from "./proactive/engine";
import {
  createPrivateShareCheck,
  PRIVATE_SHARE_TOOL_REF,
} from "./proactive/private-share";
import {
  createReadOnlyClassifier,
  guardProactiveCallback,
  restrictCoordinationForRun,
  restrictToolsForRun,
} from "./proactive/restriction";
import { createProactiveStore } from "./proactive/store";
import { createProviderOAuthProxy } from "./provider-oauth";
import { createRedisPort } from "./redis";
import { createResponsibilityBindingStore } from "./responsibilities/bindings";
import {
  createEmailTriggerRoutes,
  createSnsVerifier,
  fetchText as fetchSnsText,
  inboundEmailConfigFromEnv,
} from "./responsibilities/email";
import {
  createResponsibilityEngine,
  type ResponsibilityEngine,
} from "./responsibilities/engine";
import {
  createSlackTriggerIngest,
  slackAccessFrom,
  useSlackChannelMembership,
  useSlackTriggerIngest,
} from "./responsibilities/slack";
import { createResponsibilityStore } from "./responsibilities/store";
import { responsibilityTools } from "./responsibilities/tools";
import { createTriggerIngressRoutes } from "./responsibilities/trigger-routes";
import { useTriggerTools } from "./responsibilities/trigger-tools";
import { createTriggerStore } from "./responsibilities/triggers";
import type { Responsibility } from "./responsibilities/types";
import { createTurnRunner } from "./routines/run-turn";
import { createRoutineRunner } from "./routines/runner";
import { createRoutineStore } from "./routines/store";
import { createIntentRouter } from "./routing/classify";
import {
  anthropicMessagesUrl,
  chatCompletionsUrl,
  createModelCompleter,
} from "./routing/model";
import { createSelfHostBanner } from "./self-host-banner";
import { createTeamBots } from "./team-bots/team-bots";
import {
  createPackageStatusReader,
  loadTenantPackage,
  synchronizeTenantPackage,
} from "./tenant-package";
import { markUntrusted } from "./untrusted-content";
import { createUserInstructionsStore } from "./user-instructions";
import { createUserPreferencesStore } from "./user-preferences";
import { createVoiceSessionStore } from "./voice/sessions";
import { createVoiceSummarizer } from "./voice/summary";
import { repeatAfterEach } from "./work/loop";
import {
  createWorkQueue,
  DEFAULT_MAX_ATTEMPTS,
  startWorkOfferedListener,
  type WorkOfferedListener,
} from "./work/queue";
import { indexArtifacts } from "./workshop/artifacts";
import { createTurnEventBus } from "./workshop/bus";
import { createInProcessTurnLock, createRedisTurnLock } from "./workshop/locks";
import {
  calculateExactModelUsageCharge,
  reportCodeRunUsage,
  UsageChargeError,
} from "./workshop/metering";
import { createTurnOrchestrator } from "./workshop/orchestrator";
import { createWorkshopPublicRoutes } from "./workshop/public-routes";
import {
  createWorkshopRoutes,
  type WorkshopRoutesFactory,
} from "./workshop/routes";
import {
  createInProcessShareLimiter,
  createShareService,
} from "./workshop/sharing";
import { createWorkshopStore } from "./workshop/store";

const log = getLogger("server");
const STABLE_BILLING_CODE = /^[a-z0-9_]{1,64}$/;
const MODEL_RESERVATION_WINDOW_MS = 15 * 60_000;

function usageOutboxWriteFailureCode(error: unknown): string {
  if (error instanceof UsageOutboxConflictError) {
    return "usage_outbox_conflict";
  }
  const code =
    typeof error === "object" && error !== null
      ? (error as { code?: unknown }).code
      : undefined;
  return typeof code === "string" && STABLE_BILLING_CODE.test(code)
    ? code
    : "usage_outbox_write_failed";
}

function logUsageOutboxWriteFailure(
  source: "llm" | "code_run",
  eventId: string,
  error: unknown,
  reservationId?: string,
  precomputedCode?: string,
) {
  // The error's NAME only: a database message can carry connection details, and the sweep
  // probes pin that nothing of the sort reaches the logs.
  log.error(
    {
      type: "billing-usage-outbox-write-failed",
      source,
      eventId,
      ...(reservationId ? { reservationId } : {}),
      code: precomputedCode ?? usageOutboxWriteFailureCode(error),
      ...(error instanceof Error ? { name: error.name } : {}),
    },
    "billing-usage-outbox-write-failed",
  );
}

function reservationReleaseFailureCode(error: unknown): string {
  const code =
    typeof error === "object" && error !== null
      ? (error as { code?: unknown }).code
      : undefined;
  return typeof code === "string" && STABLE_BILLING_CODE.test(code)
    ? code
    : "reservation_release_failed";
}

function logReservationReleaseFailure(input: {
  source: "llm";
  eventId: string;
  reservationId: string;
  reason: string;
  error: unknown;
}) {
  log.error(
    {
      type: "billing-reservation-release-failed",
      source: input.source,
      eventId: input.eventId,
      reservationId: input.reservationId,
      reason: input.reason,
      code: reservationReleaseFailureCode(input.error),
    },
    "billing-reservation-release-failed",
  );
}

// 本进程的全部出站依赖都是内网/本机（Casdoor、kb-mastra、agent 运行时等）：
// 开发机的 HTTP_PROXY 会把 localhost 请求劫持成代理 404/HTML（Bun fetch 读
// 环境代理且部分上下文连 NO_PROXY 都不生效——kb-mastra E2E 实测）。摘掉本
// 进程的代理变量是最稳出口；部署环境本就无代理，不受影响。
delete process.env.HTTP_PROXY;
delete process.env.http_proxy;
delete process.env.HTTPS_PROXY;
delete process.env.https_proxy;

/**
 * Who is asking, for a CopilotKit request.
 *
 * One resolver, because a run has two questions to answer about the same person: whose threads and
 * memory these are, and which coworkers they may run. Answering them from different places is how
 * one person ends up running another's private coworker, or reading their thread.
 */
async function resolveRequestActor(request: Request): Promise<{
  id: string;
  name: string;
  role: OpenBotRole;
}> {
  if (config.singleUser) {
    return { id: DEV_ACTOR.id, name: DEV_ACTOR.email, role: DEV_ACTOR.role };
  }
  const session = await auth?.api.getSession({ headers: request.headers });
  const user = session?.user;
  if (!user) {
    throw new Error("A CopilotKit run requires a signed-in user.");
  }
  const roles = user.role
    ? [user.role]
    : await roleRepository.rolesForUser(user.id);
  if (!roles.includes("admin") && !roles.includes("user")) {
    throw new Error("A CopilotKit run requires an authorized user.");
  }
  return {
    id: user.id,
    name: user.name ?? user.email ?? user.id,
    role: roles.includes("admin") ? "admin" : "user",
  };
}

/** The Intelligence projection of {@link resolveRequestActor}: threads are scoped to this person. */
const identifyUser: IdentifyUser = async (request) => {
  const { id, name } = await resolveRequestActor(request);
  return { id, name };
};

/**
 * The authorization projection of the same person: agent visibility is decided from this.
 *
 * An unauthenticated request resolves to a person who owns nothing rather than an error, so the
 * runtime can still describe itself, `/info` reports the licence and the public roster, which is
 * what a deployment check reads to tell "the licence is invalid" apart from "chat is silently
 * broken". It grants nothing: this actor matches no private profile and is not an administrator,
 * and a run still fails in `identifyUser`, which has no anonymous case because a thread must belong
 * to somebody.
 */
const ANONYMOUS_ACTOR = { id: "", role: "user" } as const;

const identifyActor: IdentifyActor = async (request) => {
  try {
    const { id, role } = await resolveRequestActor(request);
    return { id, role };
  } catch {
    return ANONYMOUS_ACTOR;
  }
};

const config = loadConfig();
// The environment seeds local policy once. The SDK fallback must not reapply an old revision
// after an administrator clears a pin to follow the latest published Skills.
clearLearningRevisionFallback();
// Read with the rest of the configuration, where an empty variable is an absent one. See
// `serverPort` in config.ts for what `process.env.PORT ?? …` did with `PORT=` instead.
const port = config.port;
const database = createDatabase(config.databaseUrl);
// Every dispatch point asks this database whether its person paused the Bot. See agents/lifecycle.ts.
configureBotLifecycle({ database });
const learningSettingsStore = createLearningSettingsStore(
  database,
  config.learning,
);
// Its own client, like the self-host banner's: the constructor opens nothing.
const learningProbeIntelligence = createIntelligenceClient(
  config.runtime.intelligence,
);
/*
 * Who can create the `openbot` container here: never the runtime key. A service token the operator
 * configured (local evaluation installs), or a CopilotKit CLI login on this machine, which is what a
 * laptop running `bun run start` has. Neither, and the log and Admin say exactly what to run instead.
 */
const learningApiOrigin = (() => {
  try {
    return intelligenceApiOrigin(config.runtime.intelligence.apiUrl);
  } catch {
    return undefined;
  }
})();
const learningCanCreate =
  learningApiOrigin !== undefined &&
  (config.learningSetup !== undefined || cliLoginPresent());
const learningAutoAssign = createLearningAutoAssign({
  enabled: config.learningAutoAssign,
  store: learningSettingsStore,
  probe: (containerId) =>
    probeLearningContainer(learningProbeIntelligence, containerId),
  ...(learningApiOrigin
    ? { instructions: learningSetupInstructions(learningApiOrigin) }
    : {}),
  ...(learningCanCreate && learningApiOrigin
    ? {
        create: () =>
          ensureLearningContainer({
            directory: process.cwd(),
            apiUrl: learningApiOrigin,
            nonInteractive: true,
            key: keyIntelligence(
              learningApiOrigin,
              config.runtime.intelligence.apiKey,
              config.runtime.intelligence.gatewayWsUrl,
            ),
            cliLogin: cliLoginPresent(),
            ...(config.learningSetup
              ? {
                  serviceToken: {
                    token: config.learningSetup.serviceToken,
                    projectId: config.learningSetup.projectId,
                  },
                }
              : {}),
          }),
      }
    : {}),
  audit: createAuditStore(database),
});
const learningSettings = withLearningAutoAssign(
  learningSettingsStore,
  learningAutoAssign,
);
learningAutoAssign.start();
await initializeDevActorUser(database, config.singleUser);
// The vault, built before the agent store because a customer's agent may sit behind a key and that
// key belongs here rather than on the agent row. See agents/auth-header.ts.
const credentialStore = createCredentialStore(database);
/**
 * The verified enterprise capabilities, shared by everything enterprise: conversation routes at
 * boot, and the durable browser Runner below. Null, never a permissive stand-in, when either
 * database is unconfigured or fails its capability check — the conversation routes answer
 * unavailable and the browser mount stays on the Intelligence runtime it already had.
 */
const enterpriseCapabilities = await (async () => {
  const directoryUrl = config.enterpriseDirectoryDatabaseUrl;
  const dataUrl = config.enterpriseDataDatabaseUrl;
  const tenantRuntimeUrl = config.tenantStorageRuntimeDatabaseUrl;
  if (!directoryUrl || !dataUrl || !tenantRuntimeUrl) return null;
  try {
    const directoryDatabase = createDatabase(directoryUrl);
    const dataDatabase = createDatabase(dataUrl);
    const [directory, data] = await Promise.all([
      verifyDirectoryDatabase(directoryDatabase),
      verifyDataDatabase(dataDatabase),
    ]).catch(async (error) => {
      // One side failing must not leak the other's fresh pool for the
      // process lifetime (OCR R10).
      await Promise.allSettled([
        directoryDatabase.$client.close(),
        dataDatabase.$client.close(),
      ]);
      throw error;
    });
    const registry = new PostgresTenantStorageRegistry({
      query: async (text, values) => ({
        rows: await database.$client.unsafe(text, values),
      }),
    });
    const credentials: TenantCredentialStore = {
      put: async () => {
        throw new Error("TENANT_CREDENTIAL_WRITE_FORBIDDEN");
      },
      get: async (reference) => {
        try {
          return await decryptCredentialForUse(
            config.keyEncryptionKey,
            credentialStore,
            reference,
          );
        } catch (error) {
          // Only a genuinely missing/revoked credential is "absent";
          // decryption or store failures must leave a trace, or a
          // misconfigured key is indistinguishable from an unprovisioned
          // tenant (OCR R10).
          const name = error instanceof Error ? error.name : "";
          if (name !== "CredentialUnusableError")
            console.error({
              error: "TENANT_CREDENTIAL_DECRYPT_FAILED",
              context: { credentialRef: reference },
              cause: error instanceof Error ? error.message : String(error),
            });
          return undefined;
        }
      },
      delete: async () => {
        throw new Error("TENANT_CREDENTIAL_DELETE_FORBIDDEN");
      },
    };
    const mastraStorage = createTenantMastraStorage(
      new RegistryTenantStorageLookup({
        registry,
        credentials,
        runtimeConnectionString: tenantRuntimeUrl,
      }),
    );
    const scopes = createScopeResolver(directory, {
      data,
      authenticate: async (request) => {
        const actor = await resolveRequestActor(request).catch((error) => {
          // Session-infrastructure faults are not "unauthenticated": leave
          // a trace so auth-store outages are diagnosable (OCR R10).
          console.error({
            error: "ENTERPRISE_SESSION_RESOLUTION_FAILED",
            cause: error instanceof Error ? error.message : String(error),
          });
          return null;
        });
        return actor ? { actorId: actor.id, entrypoint: "web" } : null;
      },
      selectTenant: (request) => request.headers.get("x-openbot-tenant-id"),
      selectWorkspace: (request) =>
        request.headers.get("x-openbot-workspace-id"),
    });
    return {
      data,
      scopes,
      conversations: createConversationService({ data, mastraStorage }),
    };
  } catch (error) {
    console.error("Enterprise conversation service unavailable", error);
    return null;
  }
})();
const enterpriseConversationRoutes = enterpriseCapabilities
  ? createConversationRoutes(
      enterpriseCapabilities.conversations,
      enterpriseCapabilities.scopes,
    )
  : createUnavailableConversationRoutes();
const identityStore = createIdentityStore(database, credentialStore);

const agentVault = {
  store: credentialStore,
  reader: credentialStore,
  encryptionKey: config.keyEncryptionKey,
};
const agentProfileStore = createAgentProfileStore(
  database,
  config.managedAgent?.endpoint,
  agentVault,
);
// The marketplace's own receipts, beside the agent store: an install writes a Bot through it and
// remembers which one here.
const marketplaceStore = createMarketplaceStore(database);
// Read here rather than beside the synchronise below, because the package names the deployment and
// the channel store needs that name before it can mint a thread id.
const tenantPackage = await loadTenantPackage(config.tenantPackageDirectory);
const threadIdentity = createThreadIdentity(
  config.deploymentId ?? tenantPackage.tenantId,
);
const baseChannelStore = createChannelStore(
  database,
  agentProfileStore,
  threadIdentity,
);
/**
 * A person spoke in one of their conversations. Bound once memory defaults exist (memory/defaults.ts):
 * a conversation with one Bot switches on that Bot's research and memory sources for this person.
 */
let personSpoke: ((ownerUserId: string, channelId: string) => void) | undefined;
const channelStore: ChannelStore = {
  ...baseChannelStore,
  async recordActivity(actor, channelId, activity, source) {
    await baseChannelStore.recordActivity(actor, channelId, activity, source);
    if (activity.agentId === null) personSpoke?.(actor.id, channelId);
  },
};
const channelEvents = createChannelEventHub();
/**
 * Which components each Bot may answer with.
 *
 * Nothing is seeded here. The catalogue is a fact about the build; a fork that ships four components
 * of its own should start with four rows, and the only thing that can enumerate them is
 * the app that compiled them. It announces itself on load; this process learns what exists from that,
 * and owns only what may be done with it.
 */
const componentStore = createComponentStore(database);
// Its own connection is held for the life of the process; announced activity from any instance
// arrives here and is fanned out to connected members.
const channelActivityListener = await startChannelActivityListener(
  config.databaseUrl,
  channelEvents,
);
const roleRepository = createRoleRepository(database);
const loadAgentsForActor = createRuntimeAgentLoader(
  database,
  agentVault,
  config.managedAgent,
);
await synchronizeTenantPackage(database, tenantPackage);
/*
 * Built before `auth`, because the deny list is consulted during sign-in and the store is what
 * holds it. It needs the administrator list too, so it can tell the screen which people the
 * deployment's configuration has already decided about.
 */
const peopleStore = createPeopleStore(
  database,
  config.auth?.initialAdminEmails ?? [],
  /*
   * Removing somebody retires what they connected: their plugin credentials and connections, and
   * their linked outside accounts (which keep resolving to them, now refused; the tokens are revoked
   * and every link needs reconnecting). Both halves run whichever fails, and the failure is rethrown
   * after (see retireOwnedAccounts).
   *
   * A closure, because `pluginStore` is built further down: this has to exist before `auth` does,
   * and that one needs the vault and the policy. `pluginStore` is read only when the closure runs —
   * an administrator or the directory removing somebody, never during module initialisation — so by
   * then the binding is there. The linked-account half writes its audit rows through a store made
   * on its own transaction, so it reads no later binding (`bootAuditStore` included).
   */
  (userId, by) =>
    retireOwnedAccounts({
      plugins: () => pluginStore.retireConnectionsFor(userId, by),
      identities: () =>
        retireIdentityLinks(
          database,
          credentialStore,
          (executor) => createAuditStore(executor),
          userId,
          by,
        ),
    }),
);
const identityProviderStore = createIdentityProviderStore(database);
/*
 * Built before `auth` for the same reason the people store is: sign-in writes to the trail, and the
 * store that receives those rows has to exist before anything can sign in.
 */
const signInAuditStore = createAuditStore(database);
const auth: AuthService | undefined = config.organizationAuthUrl
  ? createOrganizationAuth({
      authorityUrl: config.organizationAuthUrl,
      materializeUser: organizationUserStore(database),
    })
  : config.auth
    ? createAuth(
        config,
        database,
        (email) => peopleStore.isRevoked(email),
        signInAuditStore,
      )
    : undefined;
// Each computer is pushed its network policy on the way to the action that woke it, because a
// computer refuses every connection until one arrives (see `withPolicyPushOnWake`).
const computerProvider = config.computer
  ? withPolicyPushOnWake(createComputerProvider(config.computer), {
      policyForBot: (botId) => enterpriseControls()?.policyForBot(botId),
      ...(config.computer.token ? { token: config.computer.token } : {}),
      ...(config.webBotAuth ? { webBotAuth: config.webBotAuth } : {}),
    })
  : undefined;

if (computerProvider?.warm) {
  void computerProvider.warm();
}
// What Bots may do on their computers. Configuration supplies the deployment's default; an
// administrator can change it while running, and a restart returns to the configured one.
const policyStore = createPolicyStore(
  config.computer?.policy ?? DEFAULT_ACTION_POLICY,
  database,
);
// A boundary an administrator set is read back before the first action is decided, so a restart no
// longer silently returns to the configured default.
const policySource = await policyStore.load();
/*
 * And kept current afterwards.
 *
 * A boundary an administrator changes arrives at one server. Without this, every other server keeps
 * enforcing what it read at boot, so a new deny rule stops roughly one action in N while the screen
 * and the audit row both report success. See policy-listener.ts.
 */
const policyListener = await startPolicyListener(
  config.databaseUrl,
  policyStore,
);

/*
 * Record which boundary this process started with.
 *
 * The trail records the boundary a process starts with, so later audit reads can distinguish the
 * configured default from any administrator-updated policy that was persisted before restart.
 *
 * Not awaited and never fatal. A deployment must not fail to start because its audit trail is
 * unavailable, and the row is a note for a reader rather than something the server depends on.
 */
const bootAuditStore = createAuditStore(database);
// One store: the gateway writes through it, a route reads it, and the sweep below takes the old ones out.
const pageFrameStore = createPageFrameStore(database);
let deliveryNotifications: (
  scope: DeliveryScope,
  input: {
    id: string;
    text: string;
    kind: "reply" | "question" | "approval";
    requestId?: string;
  },
) => Promise<void> = async () => {
  throw new Error("Delivery is not initialized.");
};
const authoriseQuestion = async (question: PersonQuestion) => {
  const source = await sourceForCoordinationRun({
    ...question,
    botId: questionConversationBot(question),
    depth: 0,
  });
  if (question.channelId && source?.channelId !== question.channelId)
    throw new ApprovalRefusedError("The saved question source has changed.");
  if (!source)
    throw new ApprovalRefusedError(
      "That conversation is no longer available to this Bot and person.",
    );
  if (
    !(await agentProfileStore.get(
      await actorFor(question.actorId),
      question.botId,
    ))
  )
    throw new ApprovalRefusedError("That Bot is no longer available to you.");
};
const storedApprovals = createApprovalStore(database);
const approvalService = createApprovalService(
  {
    ...storedApprovals,
    open: async (action) => {
      const request = await storedApprovals.open(action);
      if (request.status === "pending") {
        const forwarded = action.continuation?.forwardedProps;
        const signed =
          forwarded &&
          typeof forwarded === "object" &&
          "openbotRun" in forwarded
            ? readRunAssertion(forwarded.openbotRun, config.keyEncryptionKey)
            : null;
        const run =
          signed &&
          signed.actorId === action.actorId &&
          signed.botId === action.botId
            ? signed
            : {
                actorId: action.actorId,
                botId: action.botId,
                runId: action.runId,
                threadId: action.threadId,
                depth: 0,
              };
        const source = await sourceForCoordinationRun(run);
        const botName = source
          ? ((
              await agentProfileStore
                .get(await actorFor(action.actorId), action.botId)
                .catch(() => null)
            )?.name ?? action.botId)
          : action.botId;
        if (source && run.threadId)
          await deliveryNotifications(
            {
              ownerUserId: action.actorId,
              channelId: source.channelId,
              agentId: source.botId,
              threadId: run.threadId,
            },
            {
              id: request.id,
              kind: "approval",
              requestId: request.id,
              text: `${botName} asks for approval to use ${action.toolRef}. Open the Bot's page in OpenBot to review this action.`,
            },
          );
      }
      return request;
    },
  },
  createApprovalQuestions(database, authoriseQuestion),
  async (ownerUserId, botId, snapshot) => {
    const source = await sourceForCoordinationRun({
      actorId: ownerUserId,
      botId,
      threadId: snapshot.threadId,
      runId: snapshot.runId,
      depth: 0,
      initiator: PERSON_INITIATOR,
    });
    if (!source)
      throw new ApprovalRefusedError(
        "That conversation is no longer available to this Bot and person.",
      );
    // Intelligence saves a streaming run's messages a moment behind the stream, and the browser runs
    // the tool as soon as the call arrives. A call that is not saved yet is waited for briefly; one
    // that never appears is refused below.
    let history = await routineIntelligence.getThreadMessages({
      threadId: snapshot.threadId,
      userId: ownerUserId,
    });
    const findCall = () =>
      history.messages
        .flatMap((message) => message.toolCalls ?? [])
        .find((call) => call.id === snapshot.toolCallId);
    for (let attempt = 0; !findCall() && attempt < 10; attempt++) {
      await Bun.sleep(500);
      history = await routineIntelligence.getThreadMessages({
        threadId: snapshot.threadId,
        userId: ownerUserId,
      });
    }
    const canonicalCall = findCall();
    if (
      !canonicalCall ||
      canonicalCall.name !== snapshot.toolName ||
      !isDeepStrictEqual(JSON.parse(canonicalCall.args), snapshot.args) ||
      history.messages.some(
        (message) =>
          message.role === "tool" && message.toolCallId === snapshot.toolCallId,
      )
    )
      throw new ApprovalRefusedError(
        "That unanswered tool call is not saved in this conversation.",
      );
    const tools = await approvalComputerTools(
      ownerUserId,
      botId,
      PERSON_INITIATOR,
    );
    const tool = tools.find(
      (tool) => tool.definition.name === snapshot.toolName,
    );
    if (!tool)
      throw new ApprovalRefusedError("That computer tool is not available.");
    return tool.execute(snapshot.args, {
      toolCallId: snapshot.toolCallId,
      signal: new AbortController().signal,
    });
  },
  { review: (prompt, signal) => chooseSkills(prompt, signal) },
);
// Housekeeping on a schedule: audit rows when asked for, screenshots always, one timer. See audit-retention.ts.
const retentionSweeps = startRetentionSweeps(
  config.databaseUrl,
  config.auditRetentionDays,
  pageFrameStore,
);
const computerGateway = computerProvider
  ? createComputerGateway({
      provider: computerProvider,
      auditStore: bootAuditStore,
      approvalGate: approvalService.gate,
      policy: () => policyStore.get(),
      // In Postgres, so the ref a click carries resolves against the snapshot that produced it even
      // when the snapshot was taken by another server. A Map here would be blank on every replica
      // but the one that snapshotted, and the boundary would decide with no element to look at.
      snapshots: createSnapshotStore(database),
      // So wiping a profile takes the pictures of its signed-in pages with it, which is what the
      // sentence on that button already promised.
      pageFrames: pageFrameStore,
      allowPrivateHosts: config.computer?.allowPrivateHosts,
      token: config.computer?.token,
    })
  : undefined;

/**
 * What a Bot can reach beyond its own computer.
 *
 * Built here rather than beside the component store because it needs the policy, and it needs the
 * same policy the computer gateway enforces rather than one of its own. A deployment that has said
 * "this Bot may not change anything in Jira" has said one thing, and it should not matter whether
 * the change would arrive through a browser or through a tool call.
 */
const sandboxedStore = createSandboxedStore(database, bootAuditStore);

/**
 * Composio, built ONCE: the client the transport calls through and the broker behind the app
 * directory are the same client, and the store below and the routes further down share it.
 *
 * ONE CLIENT, TWO SEAMS, INSTALLED TWO DIFFERENT WAYS, because the two are reached two different
 * ways. The transport is reached as a MODULE — `transportFor` maps a kind to one, exactly as the
 * builtin routines transport above is reached — so there is no constructor to hand a client to and
 * the registry is built at IMPORT TIME, long before there is configuration to read. That is why the
 * actions seam is installed globally, from here, the one place that has the key. The broker has no
 * such problem: it is an ordinary argument, passed to the store and to `createApp`.
 *
 * A DEPLOYMENT WITH NO KEY INSTALLS NEITHER, which is the state the transport is written for rather
 * than an edge of it. The seam stays null and every Composio listing and call refuses saying the
 * connector is not configured here; the store gets no broker and the app directory says the same.
 * Installing a client built from an absent key would turn all of that into a vendor error at first
 * use, which sends an operator looking for a broken Composio instead of at their own configuration.
 */
const composio = config.composioApiKey
  ? createComposioClient(config.composioApiKey)
  : null;
if (composio) useComposioClient(composio.actions);

/**
 * OpenConnector, built ONCE beside Composio, under the same one-client-two-seams arrangement: the
 * transport calls through `useOpenConnectorClient`'s module seam below, and the broker behind the
 * second app directory is the same client handed to the store and the routes.
 *
 * A DEPLOYMENT WITH EITHER TOKEN UNSET INSTALLS NEITHER, which is this broker's spelling of the
 * state the Composio block above documents: the client needs both faces (the runtime token to
 * list and call actions, the admin one to hold connections), so one token without the other is
 * half a broker — its directory could be browsed and nothing could be connected. `null` leaves the
 * transport seam uninstalled, where every OpenConnector listing and call refuses saying the
 * connector is not configured here, and the store and routes get no broker to offer.
 *
 * THE URL IS THE DEPLOYER'S AND NOBODY ELSE'S. `createOpenConnectorClient` validates it before
 * building anything — absolute, http or https, no user info — and refuses the boot that mis-set it;
 * see that adapter's docblock for the trust boundary this is one end of.
 */
const openConnector =
  config.openConnectorAdminToken && config.openConnectorRuntimeToken
    ? createOpenConnectorClient({
        url: config.openConnectorUrl,
        adminToken: config.openConnectorAdminToken,
        runtimeToken: config.openConnectorRuntimeToken,
      })
    : null;
if (openConnector) useOpenConnectorClient(openConnector.actions);

/**
 * The private sign-in form and the Passwords vault. A Bot asks to be signed in; the person answers
 * in a form outside the conversation; the computer types the login. See passwords/service.ts.
 */
const signInService = computerGateway
  ? createSignInService({
      store: createPasswordStore(database),
      gateway: computerGateway,
      // The admin switch, read at call time; installed further down, and absent in scripts.
      passwordManagerEnabled: async (ownerUserId) =>
        (await enterpriseControls()?.capabilityFor(
          ownerUserId,
          "passwordManager",
        )) ?? true,
      encryptionKey: config.keyEncryptionKey,
      auditStore: bootAuditStore,
      notify: createSignInNotifier({
        database,
        appUrl: config.appUrl,
        notify: (scope, input) => deliveryNotifications(scope, input),
      }),
      onResolved: (request) =>
        createSignInResumer({
          database,
          resumeResponsibility: (owner, runId, result) =>
            responsibilityStore.resumeWaiting(owner, runId, result),
          continueTurn: ({ ownerUserId, botId, snapshot, result, messageId }) =>
            approvalContinuationRunner({
              ownerUserId,
              routineId: "sign-in",
              agentId: botId,
              threadId: snapshot.threadId,
              instruction: "",
              initiator: snapshot.initiator ?? PERSON_INITIATOR,
              continuation: { snapshot, result, messageId },
            }),
          recordReply: async ({
            ownerUserId,
            channelId,
            botId,
            text,
            messageId,
          }) => {
            await channelStore.recordActivity(
              await actorFor(ownerUserId),
              channelId,
              { text, agentId: botId, at: new Date() },
              { id: messageId },
            );
          },
        })(request),
    })
  : undefined;

/*
 * Whether a Bot may act through a Shared app at all, kept apart from the policy boundary above
 * because it answers a different question: not "is this action allowed" but "is this Bot's
 * audience narrow enough for what an administrator approved for the shared account." Kept in
 * module scope because the publication, assignment and grant routes below also need to reapprove
 * or refile against it when a Bot's exposure changes.
 */
const sharedUseStore = createSharedUseStore(database);

const pluginStore = createPluginStore({
  database,
  deploymentId: config.deploymentId ?? tenantPackage.tenantId,
  auditStore: bootAuditStore,
  credentials: credentialStore,
  encryptionKey: config.keyEncryptionKey,
  policy: () => policyStore.get(),
  approvalGate: approvalService.gate,
  sharedUse: createSharedUseGate(sharedUseStore, bootAuditStore),
  // A connector send to other people asks the owner first. See plugins/share-target.ts.
  privateShareCheck: createPrivateShareCheck({
    approvals: approvalService.store,
  }),
  /*
   * Where a vendor sends people back, for a vendor whose client this deployment registers itself.
   *
   * The same value the connect and callback routes build, from the same config field, because it has
   * to match what was registered character for character. Undefined without a public URL, which is
   * the honest state: there is nowhere for a consent flow to come back to, so there is nothing worth
   * registering.
   */
  redirectUri: config.publicUrl ? redirectUriFor(config.publicUrl) : undefined,
  /*
   * The same client the transport seam above was installed with, never a second one. Enabling an
   * app writes the row here and creates the auth config at the vendor, and a store holding a
   * different client from the one the call goes out through is two deployments' worth of state
   * behind one screen. Undefined without a key, which leaves enabling an app refused rather than
   * attempted.
   */
  broker: composio?.broker,
  /*
   * The OpenConnector twin of the line above, with the same one-client rule: the store's enable and
   * connect paths (generalized in a later task) will dial through this broker or not at all, never
   * through a second client built anywhere else. Absent where the tokens are unset, which leaves
   * enabling an OpenConnector app refused rather than attempted.
   */
  openConnector: openConnector ?? undefined,
});

/*
 * Personal ⇄ Shared for a brokered app. Built here because it needs the plugin store, the shared-use
 * store and the approval policy at once: making an app Shared ends people's accounts, approves each
 * Bot that holds it and adds an ask-before-write rule for its writes.
 */
const accountModes = createAccountModeSwitch({
  store: pluginStore,
  sharedUse: sharedUseStore,
  teamRules: approvalService.store.policy,
  deploymentId: config.deploymentId ?? tenantPackage.tenantId,
  audit: bootAuditStore,
});

// Logo metadata is optional; a vendor outage must not prevent the API from starting.
if (composio) {
  void backfillComposioLogos(database, composio.broker).catch(() => {
    log.warn(
      "Composio app logos could not be updated. Existing icons remain available; missing logos will be retried on the next restart.",
    );
  });
}

/**
 * Routines, and the one moment its tools are told what to act on.
 *
 * The builtin transport is reached as a MODULE — `transportFor` maps a kind to one — so there is no
 * constructor to hand a store to and no request-time seam either: the transport registry is built at
 * import time, long before there is a database. So the store is installed here, once, from the place
 * that already owns building stores. Without this call the four tools are advertised and every one of
 * them refuses, which is the honest behaviour for a deployment that never wired it, and would be a
 * silent outage for this one.
 */
const routineStore = createRoutineStore(database);
useRoutineTools(routineStore);
const responsibilityStore = createResponsibilityStore(database, {
  resolveTarget: async (ownerUserId, agentId, channelId) => {
    const actor = await actorFor(ownerUserId);
    const [bot, channel] = await Promise.all([
      agentProfileStore.get(actor, agentId),
      channelStore.get(actor, channelId),
    ]);
    return bot && channel?.active && channel.agentIds.includes(agentId)
      ? { threadId: channel.threadId }
      : null;
  },
});
const responsibilityBindings = createResponsibilityBindingStore(database, {
  store: credentialStore,
  reader: credentialStore,
  encryptionKey: config.keyEncryptionKey,
});
/*
 * Event triggers. Every kind authenticates with its vendor's own scheme and then goes through the
 * responsibility engine's one ingest (event + run + queue in one transaction), so dispatch is the
 * same headless AG-UI path as every other responsibility run. `responsibilityEngine` is read at
 * delivery time, long after it is constructed further down.
 */
/*
 * Slack access: the owner's own linked Slack identity comes from the delivery bindings (read at call
 * time; `deliveryStore` is built further down), and channel membership from the Slack pairing via
 * `useSlackChannelMembership`. Until the pairing installs that, Slack triggers are refused.
 */
const slackAccess = slackAccessFrom(async (ownerUserId, teamId) => {
  const bindings = await deliveryStore.listBindings(ownerUserId);
  return (
    bindings.find(
      (binding) =>
        binding.transport === "slack" &&
        binding.realm === teamId &&
        binding.enabled,
    )?.identity ?? null
  );
});
const responsibilityTriggerStore = createTriggerStore(
  database,
  {
    store: credentialStore,
    reader: credentialStore,
    encryptionKey: config.keyEncryptionKey,
  },
  { slackAccess },
);
const triggerIngressDeps = {
  directory: responsibilityTriggerStore.directory,
  ingest: (event: unknown) => responsibilityEngine.ingest(event),
  auditStore: bootAuditStore,
};
const inboundEmail = inboundEmailConfigFromEnv(process.env);
const responsibilityTriggers = {
  store: responsibilityTriggerStore,
  emailDomain: inboundEmail?.domain ?? null,
  ingressRoutes: createTriggerIngressRoutes(triggerIngressDeps),
  emailRoutes: inboundEmail
    ? createEmailTriggerRoutes({
        ...triggerIngressDeps,
        config: inboundEmail,
        verify: createSnsVerifier(fetchSnsText),
        confirmSubscription: fetchSnsText,
      })
    : null,
};
// The Slack pairing calls `ingestSlackEvent` from responsibilities/slack.ts; this installs it.
useSlackTriggerIngest(
  createSlackTriggerIngest({ ...triggerIngressDeps, slackAccess }),
);
// Bots manage triggers from chat through the builtin Routines transport; keys never reach the model.
useTriggerTools({
  triggers: responsibilityTriggerStore,
  responsibilities: responsibilityStore,
  publicUrl: config.publicUrl ?? null,
  emailDomain: inboundEmail?.domain ?? null,
});

/**
 * Where a Bot handing work to another gets decided.
 *
 * The queue is the one #216 shipped, shared with the idle-computer culler and with routines: durable
 * work claimed by whichever replica gets to it, leased so a dead replica's work comes back. A hop is
 * that, because the Bot being addressed will very likely run on a different pod from the Bot that
 * addressed it, and a hop held in memory is lost the moment either is rescheduled.
 */
const handoffDesk = createHandoffDesk({
  queue: createWorkQueue(database),
  profiles: agentProfileStore,
  // Read per hop and never held, so revoking a grant applies to the next hop rather than after a
  // restart.
  mayAddress: async (fromBotId, toBotId) =>
    (
      await pluginStore
        .botsReachableFrom(fromBotId)
        // A grant that cannot be read is not a grant. Failing closed here costs a hop; failing open
        // would let a Bot address one nobody gave it because the database blinked.
        .catch(() => [] as string[])
    ).includes(toBotId),
  /*
   * Deferred rather than passed directly, because `actorFor` is defined further down with the rest
   * of the run-building collaborators. It is only ever called during a hop, long after this module
   * has finished loading.
   */
  actorFor: (userId) =>
    // Null rather than a throw: see the seam's own note. A role that cannot be read is not a role,
    // and the hop is refused with a sentence rather than ending the run in silence.
    actorFor(userId).catch(() => null),
  auditStore: bootAuditStore,
  caps: config.handoff,
});

void recordAuditEvent(bootAuditStore, {
  eventType: "computer.policy_loaded",
  targetType: "policy",
  initiator: DEPLOYMENT_INITIATOR,
  payload: {
    ...policyStore.get(),
    source:
      policySource === "the database"
        ? "an administrator, saved in this deployment"
        : config.computer?.policy
          ? "configuration"
          : "the built-in default",
    note:
      policySource === "the database"
        ? "Set while running and kept. A restart returns to this."
        : "The deployment default. Anything an administrator sets from here is kept.",
  },
}).catch(() => undefined);

/*
 * Record whether each Bot has a computer of its own.
 *
 * A shared provider is a fine way to run on a laptop, but the shared isolation state must be visible
 * rather than inferred.
 */
const isolation = describeComputerIsolation(computerProvider);

void recordAuditEvent(bootAuditStore, {
  eventType: "computer.isolation_loaded",
  targetType: "computer",
  initiator: DEPLOYMENT_INITIATOR,
  payload: {
    isolation: isolation.isolation,
    note: isolation.note,
  },
}).catch(() => undefined);

log.info(
  {
    type: "computer-isolation",
    provider: computerProvider ? computerProvider.name : "none",
    isolation: isolation.isolation,
    ...(isolation.warning ? { warning: isolation.warning } : {}),
  },
  "computer-isolation",
);
/**
 * One Bot's endpoint must not take down the platform.
 *
 * Restarting a remote agent while a run is in flight resets the socket. The rejection reaches the top
 * of the process, and Bun kills the whole server: every other person's conversation, every other Bot
 * and the admin surface go with it, because somebody redeployed their own agent.
 *
 * That blast radius is created by design the moment people can register their own endpoints,
 * so it belongs to that feature. A remote agent is untrusted infrastructure: it will restart, it will
 * time out, it will close a stream halfway through, and none of that is exceptional.
 *
 * Logged loudly rather than swallowed. A process that hides unhandled rejections is worse than one
 * that dies, so this prints the full reason and keeps serving; what it must never do is stay quiet.
 */
process.on("unhandledRejection", (reason) => {
  getLogger("server").error(
    {
      type: "unhandled-rejection",
      reason:
        reason instanceof Error
          ? { message: reason.message, stack: reason.stack }
          : String(reason),
      code:
        reason && typeof reason === "object" && "code" in reason
          ? String((reason as { code: unknown }).code)
          : undefined,
      note: "The server kept running. A remote agent's connection failing must not stop everyone else.",
    },
    "unhandled rejection",
  );
});

/**
 * The watch on Bot streams, built once and shared by every run.
 *
 * It has to outlive the request that opens a stream: the sweep that notices a silent one is still
 * running long after the run request has been answered, because in Intelligence mode that request is
 * answered in about a second and the Bot keeps writing for as long as it has something to say.
 *
 * The same audit store as everything else, so a Bot that hangs is recorded beside what Bots do.
 */
const stallGuard = createStallGuard({
  stallMs: config.agentStallTimeoutMs,
  auditStore: bootAuditStore,
});

normalizeModelBaseUrls();
const runtimeModel = runtimeModelForEnvironment(tenantPackage.model);

const intentRouter = createIntentRouter({
  complete: createModelCompleter({
    model: runtimeModel,
    resolveApiKey: () =>
      resolveModelApiKey({
        encryptionKey: config.keyEncryptionKey,
        reader: credentialStore,
        provider: runtimeModel.provider,
        keyId: tenantPackage.model.credentialSecretRef,
        environment: process.env,
      }),
  }),
});

/**
 * Pass one of tool selection: which skills a message needs, on the deployment's own model.
 *
 * Built once rather than per request, because it holds nothing about a person: the key is resolved
 * on every call, so a credential rotated a moment ago is used by the next run.
 */
const chooseSkills = createModelCompleter({
  model: runtimeModel,
  resolveApiKey: () =>
    resolveModelApiKey({
      encryptionKey: config.keyEncryptionKey,
      reader: credentialStore,
      provider: runtimeModel.provider,
      keyId: tenantPackage.model.credentialSecretRef,
      environment: process.env,
    }),
});

// Named collaborators are bound once in actorAgentResolver for chat, hops, and headless turns.

/** The deployment's model key, resolved per call so a credential rotated a moment ago is used next. */
const resolveRuntimeModelApiKey = () =>
  resolveModelApiKey({
    encryptionKey: config.keyEncryptionKey,
    reader: credentialStore,
    provider: runtimeModel.provider,
    keyId: tenantPackage.model.credentialSecretRef,
    environment: process.env,
  });

const hostAccessBroker = createHostAccessBroker(Date.now, {
  approvalGate: approvalService.gate,
  commandPolicy: (actorId) => approvalService.hostCommandPolicy(actorId),
});

// Tools run here, not in the browser. Each connector still executes through the plugin store, so the
// grant, the policy and the audit row are exactly where they were. Host-folder tools are also
// server-dispatched: the selected Bot and the signed-in owner are bound here, then the desktop worker
// receives only opaque grant ids and relative paths.
// Memory lives in CopilotKit Intelligence when this deployment is entitled to it, and in OpenBot's own
// tables when it is not; see memory/store.ts. Its own client, like the thread reader's: the
// constructor opens nothing.
const personalMemoryStore = createMemoryStore(database, {
  intelligence: createIntelligenceMemory({
    client: createIntelligenceClient(config.runtime.intelligence),
  }),
});
const demonstrationStore = createDemonstrationStore(database);
const demonstrationRecorder = createDemonstrationRecorder({
  store: demonstrationStore,
  // Teaching a shared deployment Bot is allowed as well as an owned one; the skill is the owner's.
  ownsBot: async (owner, bot) =>
    (await pluginStore.agentOwner(bot)) === owner ||
    (await agentProfileStore.get(await actorFor(owner), bot)) !== null,
  ownsSkill: async (owner, slug) =>
    (await pluginStore.skillOwner(slug)) === owner,
  routines: routineStore,
});
const memoryIngestion = createMemoryIngestion({
  store: personalMemoryStore,
  plugins: pluginStore,
  canUseBot: async (owner, bot) =>
    (await pluginStore.agentOwner(bot)) === owner ||
    (await agentProfileStore.get(await actorFor(owner), bot)) !== null,
});
// Proactive research may only read; see proactive/restriction.ts. Read from the catalogue per call.
const proactiveReadOnlyRefs = createReadOnlyClassifier(pluginStore);
// Conversation-side knowledge retrieval (P1): middleware injects reference material into every
// run and the search_knowledge tool re-queries on demand. Both come from one runtime, so the
// circuit breaker and the merge/dedup/format logic are shared. Built only when the service URL
// AND the kb list are configured: an unset URL is the feature off entirely (no log), while a set
// URL with no KB_RETRIEVAL_KB_IDS is half-configured and gets one boot-time warn naming it.
const knowledgeRetrievalOptions = knowledgeRetrievalOptionsFromEnv();
const knowledgeService = knowledgeServiceConfig();
const knowledgeRuntime =
  knowledgeService && knowledgeRetrievalOptions
    ? createKnowledgeRuntime(knowledgeService, knowledgeRetrievalOptions)
    : null;
if (!knowledgeRuntime && knowledgeService) {
  log.warn(
    { type: "knowledge-retrieval-unconfigured" },
    "knowledge-retrieval-unconfigured",
  );
}
/*
 * Memory sources and background research, on by default for each person and Bot, and never switched
 * back on once the person turns one down. See memory/defaults.ts.
 */
const memoryDefaults = createMemoryDefaults({
  database,
  ingestion: memoryIngestion,
  sources: config.memoryDefaults.sources,
  research: config.memoryDefaults.research,
  channelBots: async (ownerUserId, channelId) =>
    (await channelStore.get(await actorFor(ownerUserId), channelId))
      ?.agentIds ?? null,
  // The same rule research delivery uses, read when a person speaks (long after it is defined).
  canDeliver: async (ownerUserId, channelId, agentId) =>
    (await deliveryScopeFor(ownerUserId, channelId, agentId)) !== null,
  mintThreadId: () => threadIdentity.mint(),
  // Read when a Bot turn starts, long after `teamBots` below is defined.
  publishedByAnother: (ownerUserId, agentId) =>
    teamBots.publishedByAnother(ownerUserId, agentId),
});
personSpoke = memoryDefaults.personSpoke;
const loadPersonalMemoryForActor = (ownerUserId: string) => (botId: string) => {
  // Apps connected since this Bot's last turn become its memory sources. Never waits.
  memoryDefaults.botTurn(ownerUserId, botId);
  return memoryIngestion.contextFor(ownerUserId, botId);
};
const memorySweep = repeatAfterEach(async () => {
  try {
    await memoryIngestion.syncDue();
  } catch (error) {
    log.error(
      {
        type: "memory-sweep-error",
        error: error instanceof Error ? error.name : "UnknownError",
        context: { operation: "syncDue" },
        timestamp: new Date().toISOString(),
      },
      "memory-sweep-error",
    );
  }
  // Mirror to Intelligence what is out of step: the backfill on the first passes after a deployment
  // becomes entitled, and afterwards whatever an outage left behind. A no-op without Intelligence.
  try {
    await personalMemoryStore.mirrorPending();
  } catch (error) {
    console.error(
      JSON.stringify({
        type: "memory-sweep-error",
        error: error instanceof Error ? error.name : "UnknownError",
        context: { operation: "mirrorPending" },
        timestamp: new Date().toISOString(),
      }),
    );
  }
}, 60_000);
// Follow-ups a Bot schedules for itself, on the shared work queue. See agents/wake-up.ts.
const wakeUpStore = createWakeUpStore(database, { auditStore: bootAuditStore });
/** Team Bots: published Bots, their audiences, and teammates' consent to their own accounts. */
const teamBots = createTeamBots({
  database,
  connectedServers: async (userId) =>
    new Set(
      [
        ...(await pluginStore.connectionsFor(userId)),
        ...(await pluginStore.brokeredConnectionsFor(userId)),
      ].map((connection) => connection.serverId),
    ),
});

const loadToolsForActor =
  (actorId: string, initiator: AuditInitiator = PERSON_INITIATOR) =>
  async (botId: string) => [
    ...wakeUpTools({
      store: wakeUpStore,
      ownerUserId: actorId,
      agentId: botId,
      initiator,
    }),
    ...memoryTools({
      store: personalMemoryStore,
      ingestion: memoryIngestion,
      ownerUserId: actorId,
      agentId: botId,
    }),
    ...(await grantedTools({
      store: pluginStore,
      botId,
      actorId,
      initiator,
      // A Team Bot reaches its owner's accounts, and a teammate's own only with their consent.
      credentialActorFor: teamBots.credentialActorFor(actorId, botId),
    })),
    ...hostAccessTools({
      broker: hostAccessBroker,
      botId,
      actorId,
      auditStore: bootAuditStore,
      initiator,
    }),
    // Knowledge search appended last: same grant model as memory tools (every Bot holds it in
    // P1, A2), and the spread keeps the array literal append-only as the wiring grows.
    ...(knowledgeRuntime
      ? knowledgeTools({
          retriever: knowledgeRuntime.retriever,
          initiator,
          kbIds: knowledgeRetrievalOptions?.kbIds,
          // 工具路径的超时档：KB_SERVICE_TIMEOUT_MS（config.timeoutMs，默认 10s）。
          timeoutMs: knowledgeService?.timeoutMs,
        })
      : []),
    /*
     * C07 (contracts §7): the private OpenMuse Bot's own context — the P trio's
     * goal/idea/memory reads plus one-durable-Task delegation — bound to the
     * calling owner. Gated on the template row, so no other Bot is offered
     * them; the owner is the actor, never a tool argument.
     */
    ...(await openMuseToolsFor(actorId, botId)),
  ];

/** One person's standing instructions, for both the /api/settings routes and every run they start. */
const userInstructionsStore = createUserInstructionsStore(database);

/*
 * What this person has told every built-in coworker they run.
 *
 * Per actor and read per build, for the reason every other per-person fact here is: somebody who
 * edits their instructions and sends a message expects the message to land on the new ones, and a
 * value captured at boot would serve the whole deployment whatever the first person to sign in had
 * written.
 */
const loadInstructionsForActor = (actorId: string) => () =>
  userInstructionsStore.read(actorId);

/*
 * The file behind an attachment reference, read when a turn turns out to name one.
 *
 * Read per turn rather than held, for the reason the bytes are in the database at all: a message
 * carries a `/api/attachments/<id>` URL, and a model provider is not going to go and fetch it. The
 * row is fetched here and the bytes go up inline, so the Bot sees the file the person attached
 * instead of a link it cannot follow.
 *
 * Built per actor and passed to both turn paths — the request path through `mountCopilotRuntime` and
 * a routine's turn through `buildAgentFor` — so a routine firing at three in the morning inlines
 * exactly as a person's chat turn does, on exactly the same footing.
 *
 * NARROWED BY ACTOR AND BY CONVERSATION, and not silent. The reference reaches the loader out of
 * browser-supplied message content, so a turn can name an attachment in a channel the asker was
 * never in — or in one they ARE in but which is not the channel this turn is running in.
 * `loadAttachmentForTurn` answers both with the same membership join the fetch route uses plus the
 * run's own thread, and null when there is no row this person may see here.
 * `resolveAttachmentParts` fails the turn on that null rather than letting a Bot read a file back
 * to somebody who cannot open it.
 *
 * The thread is the CLOSURE'S ARGUMENT rather than something baked in beside the actor, because one
 * of these is built per actor per request and then used for however many runs that request makes;
 * a thread captured here would be the first run's, silently, for all of them.
 *
 * A PURE READ. `attachedAt` is written by the send rather than by anything here; see
 * `markAttachmentsSentForActor` below.
 */
const loadAttachmentForActor =
  (actorId: string) => (id: string, threadId: string) =>
    loadAttachmentForTurn(database, { actorId, threadId }, id);

/**
 * That the files on a message went out in it, recorded when a turn turns out to be a send.
 *
 * Bound per actor and handed to the same two turn paths as the reader above, so a routine's send at
 * three in the morning is recorded exactly as a person's chat turn is. `inlineAttachments`
 * (copilot.ts) calls it with the ids on the message being asked about and no others: history is
 * replayed on every turn and by whoever is running it, so nothing behind that message is evidence
 * of a send.
 *
 * NARROWED BY ACTOR, and more strictly than the reader is. Reading is scoped to channel
 * membership, because members are meant to see each other's sent files; recording a send is scoped
 * to the UPLOADER, because `attachedAt` is what the sweeper, the upload cap and the withdrawal
 * route all read as "this file rode in a message somebody sent" — and a member who could write it
 * on a colleague's staged row would freeze that colleague's own withdrawal at 409 and leave the row
 * unsweepable. See `markAttachmentsSent` in channels/attachments.ts.
 *
 * AND NARROWED BY CONVERSATION, taking the thread as an argument for the reason the reader does.
 * A stamp written against a channel that never saw the file freezes the row the same way, and is
 * reached without any colleague being involved: one person, two channels of their own, a file
 * named from the wrong one.
 */
const markAttachmentsSentForActor =
  (actorId: string) => (ids: readonly string[], threadId: string) =>
    markAttachmentsSent(database, { actorId, threadId }, ids);

/*
 * What the deployment tells a remote Bot about the run it is starting.
 *
 * Signed here, where the encryption key lives, so the runtime module never holds a secret. The Bot
 * hands this back when it calls a tool, and it is where the Bot id and the person's name come
 * from: its own token proves which agent is calling, this proves who it is calling for, and
 * neither is read out of the request body any more.
 */
const signRunForActor =
  (
    actorId: string,
    initiator: AuditInitiator = PERSON_INITIATOR,
    // How deep in a Bot-to-Bot chain a headless turn already is; see createGroupConversations.
    depth?: number,
  ) =>
  (
    botId: string,
    runId: string,
    threadId?: string,
    previousAssertion?: unknown,
  ) => {
    const previous = readRunAssertion(
      previousAssertion,
      config.keyEncryptionKey,
    );
    if (previous?.handoff) {
      if (previous.botId !== botId || previous.actorId !== actorId)
        throw new Error(
          "The delegated run identity does not match this Bot and owner.",
        );
      return previousAssertion as string;
    }
    return mintRunAssertion(
      {
        botId,
        actorId,
        runId,
        threadId,
        initiator,
        ...(depth ? { depth } : {}),
      },
      config.keyEncryptionKey,
    );
  };

/*
 * Which vendors this deployment connects to, held by a Bot or not.
 *
 * A Bot holding no grants used to be told nothing about connectors at all, so it treated a
 * connected vendor as an ordinary website and browsed to it: a Bot with no Drive grant opened
 * Google's sign-in page and asked a person to sign in to an account the deployment had already
 * connected. Naming them lets it say which one it has not been granted instead.
 *
 * Read per request rather than held, because a connector added a minute ago has to count.
 * Let failures reach buildAgents, which reports the missing guidance once and keeps the run usable.
 */
const loadVendors = async () =>
  (await pluginStore.listServers()).map((server) => server.id);

/*
 * How a run's tools are narrowed to the ones it is about.
 *
 * A model picks the right tool reliably out of about ten, and a deployment of this template
 * clears that as soon as it connects a second vendor. Past it the wrong tool gets called, or
 * none does and the answer comes from memory, and neither says so. So a Bot holding more than a
 * handful is offered the tools of the skills that match the message rather than everything at
 * once. See `plugins/selection.ts`.
 *
 * This narrows the offer and nothing else. What a Bot may call is the grant, checked in
 * `callTool` with the policy and the audit row exactly as before, so every path through here can
 * be wrong without a Bot gaining anything. That is also why every failure below is silent and
 * lands on the whole catalogue: the narrowing is worth an accuracy point, never a capability.
 */
const selectionForActor = (actorId: string): ToolSelection => ({
  loadSkills: (botId) => grantedSkills({ store: pluginStore, botId }),
  // The deployment's own model and key, the same pair the intent router uses, so selection is
  // never a second thing to configure. It throws on a missing key, which reads as "could not
  // choose" and leaves the whole catalogue offered.
  choose: chooseSkills,
  record: async (botId, selection) => {
    await recordAuditEvent(bootAuditStore, {
      eventType: "mcp.tools_discovered",
      targetType: "bot",
      targetId: botId,
      actorUserId: actorId,
      payload: {
        bot: botId,
        reason: selection.reason,
        granted: selection.granted,
        offered: selection.offered.length,
        skills: selection.skills,
      },
    });
  },
});

// Every run dials the stored endpoint again, so the check that was applied when it was
// registered has to be applied to wherever it redirects now.
// Absent computer configuration means nothing opted into private hosts, which is the safe
// reading and the same one `createApp` takes.
const agentFetch = createAgentFetch({
  allowPrivateHosts: config.computer?.allowPrivateHosts === true,
  // Named addresses are reachable on every hop, not only the one that was registered.
  allowedHosts: config.agentEndpointAllowedHosts,
  // The refusal is what the run already knows; this is what the deployment knows. Written here
  // rather than in `endpoint.ts` so that file keeps deciding and nothing else, the way the
  // target check it reuses does.
  onRefusal: ({ address, reason }) => {
    void recordAuditEvent(bootAuditStore, {
      eventType: "agent.dial_refused",
      targetType: "agent_endpoint",
      targetId: address,
      payload: { address, reason },
    }).catch((error) => {
      // A trail that cannot be written must not take a refusal down with it: the request is
      // already refused by the time this runs, and the alternative to a logged failure here is
      // an unhandled rejection.
      log.error({ err: error }, "Could not record a refused agent dial.");
    });
  },
});

/**
 * Who a routine acts as, resolved the way {@link resolveRequestActor} resolves it.
 *
 * THE ROLE IS READ, NOT ASSUMED. Which coworkers exist is decided per person and an administrator
 * sees Bots a user does not, so hardcoding `role: "user"` here would hide an administrator's own Bots
 * from their own routine — the routine would fail with "that Bot is no longer registered" for a Bot
 * sitting in front of them in chat. This asks the same repository the request path asks, so a routine
 * sees exactly the coworkers its owner sees.
 */
const actorFor = async (ownerUserId: string): Promise<AgentActor> => {
  // One person, and they are an administrator. The id stays the routine owner's rather than being
  // rewritten to DEV_ACTOR's: in this mode they are the same person, and if they ever were not,
  // silently borrowing the dev actor's identity would be worse than finding nothing.
  if (config.singleUser) return { id: ownerUserId, role: DEV_ACTOR.role };
  const roles = await roleRepository.rolesForUser(ownerUserId);
  if (!roles.includes("admin") && !roles.includes("user")) {
    throw new Error("A routine requires an authorized owner.");
  }
  return {
    id: ownerUserId,
    role: roles.includes("admin") ? "admin" : "user",
  };
};

/*
 * A run's source conversation: a channel's own thread, or a Bot's thread in a group conversation.
 * The group lookup applies the same live-membership and own-Bot checks. See channels/group.ts.
 */
const sourceForCoordinationRun = async (run: RunAssertion) =>
  (await channelSourceForRun(run)) ?? groupSourceForRun(database, run);
const channelSourceForRun = async (run: RunAssertion) => {
  if (!run.threadId) return null;
  const sources = await database
    .select({ channelId: channels.id, botId: channelAgents.agentId })
    .from(intelligenceChannelMappings)
    .innerJoin(channels, eq(channels.id, intelligenceChannelMappings.channelId))
    .innerJoin(
      channelMemberships,
      and(
        eq(channelMemberships.channelId, channels.id),
        eq(channelMemberships.userId, run.actorId),
      ),
    )
    .innerJoin(channelAgents, eq(channelAgents.channelId, channels.id))
    .where(
      and(
        eq(intelligenceChannelMappings.threadId, run.threadId),
        eq(intelligenceChannelMappings.userId, run.actorId),
        isNull(channels.deletedAt),
      ),
    );
  return (
    sources.find((source) => source.botId === run.botId) ??
    (run.handoff ? (sources[0] ?? null) : null)
  );
};
const personQuestions = createWorkQueue(database);
const coordination = createCoordinationTools({
  desk: handoffDesk,
  caps: config.handoff,
  approvalGate: approvalService.gate,
  privateShare: {
    check: createPrivateShareCheck({ approvals: approvalService.store }),
    // Resolved the way the desk resolves it: an id wins, then a single visible name. Null for the
    // owner's own Bot or a deployment Bot, since nobody else reads that work.
    audienceFor: async (from, target) => {
      const roster = await agentProfileStore.list(await actorFor(from.actorId));
      const wanted = target.trim().toLowerCase();
      const found =
        roster.find((candidate) => candidate.id.toLowerCase() === wanted) ??
        roster.find(
          (candidate) =>
            !candidate.hidden &&
            candidate.deletedAt === null &&
            candidate.name.toLowerCase() === wanted,
        );
      if (!found?.ownerUserId || found.ownerUserId === from.actorId)
        return null;
      return {
        kind: "handoff",
        id: found.ownerUserId,
        recipientUserIds: [found.ownerUserId],
        label: found.name,
      };
    },
    // A question from a conversation other people are in reaches them too, so it is held like a
    // handoff to another person. Only the owner reading it is the ordinary, unheld case.
    questionAudience: async (from) => {
      const channel = await channelSourceForRun(from);
      const group = channel ? null : await groupSourceForRun(database, from);
      const source = channel ?? group;
      if (!source) return null;
      const members = (
        await database
          .select({ userId: channelMemberships.userId })
          .from(channelMemberships)
          .where(eq(channelMemberships.channelId, source.channelId))
      ).map((row) => row.userId);
      if (members.every((userId) => userId === from.actorId)) return null;
      return {
        audience: {
          kind: group ? "group" : "channel",
          id: source.channelId,
          recipientUserIds: members,
        },
        // A channel thread is the conversation itself; a group Bot's own thread also holds context
        // only its owner has seen.
        origin: channel
          ? { kind: "shared_conversation", sharedWithUserIds: members }
          : { kind: "private_conversation" },
      };
    },
  },
  botsReachableFrom: (botId) => pluginStore.botsReachableFrom(botId),
  auditStore: bootAuditStore,
  authoriseRun: (run) =>
    authoriseCoordinationRun(run, {
      canUseBot: async (scope) => {
        const person = await peopleStore.find(scope.actorId);
        if (!person || person.revoked) return false;
        return (
          (await agentProfileStore.get(
            await actorFor(scope.actorId),
            scope.botId,
          )) !== null
        );
      },
      sourceThread: sourceForCoordinationRun,
      delegationFor: (claim) => readCoordinationHandoffClaim(database, claim),
    }),
  route: async (question) => {
    const source = await sourceForCoordinationRun(question);
    if (!source)
      return {
        refusal: "That question could not reach its source conversation.",
      };
    const key = createHash("sha256")
      .update(
        JSON.stringify([
          question.actorId,
          question.botId,
          question.runId,
          question.question,
        ]),
      )
      .digest("hex");
    const queued = await personQuestions.offer({
      kind: "person.question",
      key,
      payload: {
        ...question,
        sourceBotId: source.botId,
        channelId: source.channelId,
        mode: "completed_question",
        toolName: "ask_person",
        args: {
          question: question.question,
          ...(question.why ? { why: question.why } : {}),
        },
      },
    });
    if (queued === "refused")
      return { refusal: "The question could not be saved for its person." };
    await channelStore.recordActivity(
      await actorFor(question.actorId),
      source.channelId,
      {
        text: `A question needs your answer: ${question.question}`,
        agentId: source.botId,
        at: new Date(),
      },
      { id: `question:${key}` },
    );
    if (question.threadId) {
      // A person reads this in Slack or on their phone, where "general-assistant" is an id, not a name.
      const botName =
        (
          await agentProfileStore
            .get(await actorFor(question.actorId), question.botId)
            .catch(() => null)
        )?.name ?? question.botId;
      await deliveryNotifications(
        {
          ownerUserId: question.actorId,
          channelId: source.channelId,
          agentId: source.botId,
          threadId: question.threadId,
        },
        {
          id: key,
          text: `${botName} asks: ${question.question}`,
          kind: "question",
          requestId: key,
        },
      );
    }
    return {
      reached:
        "the person in the source conversation; the question is saved awaiting their reply",
    };
  },
});
const coordinationForActor =
  (
    actorId: string,
    initiator: AuditInitiator = PERSON_INITIATOR,
    baseDepth = 0,
  ) =>
  async (botId: string, input: import("@ag-ui/client").RunAgentInput) => {
    const assertion = readRunAssertion(
      input.forwardedProps?.openbotRun,
      config.keyEncryptionKey,
    );
    if (
      assertion &&
      (assertion.botId !== botId || assertion.actorId !== actorId)
    )
      throw new Error("The run assertion does not match this Bot and owner.");
    const run: RunAssertion = assertion?.handoff
      ? assertion
      : {
          botId,
          actorId,
          runId: input.runId,
          threadId: input.threadId,
          depth: assertion?.depth ?? baseDepth,
          initiator: assertion?.initiator ?? initiator,
        };
    const tools = await coordination.toolsForRun(run);
    return tools.map((tool) => ({
      ...tool,
      execute: async (args: unknown) => {
        if (!args || typeof args !== "object" || Array.isArray(args))
          return `${REFUSAL_MARKER} Tool arguments must be an object.`;
        const result = await coordination.call({
          name: tool.name,
          args: args as Record<string, unknown>,
          run,
        });
        if (!result) throw new Error("A coordination tool was not dispatched.");
        /*
         * A responsibility's question pauses its run, the way an approval does.
         *
         * Left running, the run ended "succeeded" the moment the question was saved, and the answer
         * came back to a run that was already over: the Bot read it, and then the store refused its
         * progress because it was not from the responsibility's current run, so the goal stayed
         * open for ever. Suspended, the run waits, and the answer resumes that same run as this
         * tool's result, with the right to record progress and finish.
         */
        const snapshot = currentApprovalContext();
        if (
          tool.name === "ask_person" &&
          run.initiator?.kind === "responsibility" &&
          snapshot &&
          !result.text.startsWith(REFUSAL_MARKER)
        )
          throw new HeadlessToolSuspension(
            "This responsibility is waiting for the person's answer.",
            {
              kind: PERSON_QUESTION_WAITING,
              continuation: snapshot,
            },
          );
        return result.text;
      },
    }));
  };

/**
 * One Bot, built for a routine's turn, as its owner.
 *
 * Per turn rather than per boot, for the same reason the request path rebuilds: a Bot registered or
 * edited since the last firing has to count, and a private coworker must be absent for everybody but
 * its owner. No header and no request are involved — the owner is asserted by construction, from the
 * routine row — which is the whole point of doing it here rather than adding an impersonation path to
 * a public route.
 */
const buildAgentFor = async ({
  ownerUserId,
  agentId,
  initiator,
  depth,
}: {
  ownerUserId: string;
  agentId: string;
  initiator: AuditInitiator;
  depth?: number;
}) => {
  const actor = await actorFor(ownerUserId);
  let agent: AbstractAgent | undefined;
  try {
    agent = await actorAgentResolver.resolveAgentForActor(actor, agentId, {
      initiator,
      depth,
    });
  } catch (error) {
    if (!(error instanceof CoworkerUnavailableError)) throw error;
  }
  if (!agent) {
    /*
     * Named, and raised rather than swallowed. The routine's Bot was deleted, or made private by
     * somebody else, or the owner lost the role that could see it. The runner turns this into a
     * failed run row with this sentence on it, the first failure is said once in the channel, and
     * the fatigue rule switches the routine off after ten — which is exactly the right handling for
     * a routine pointed at something that is not coming back.
     */
    const error = new Error(
      `That Bot is no longer registered, so this routine has nothing to run: ${agentId}.`,
    );
    error.name = "RoutineBotNotRegistered";
    throw error;
  }
  return agent;
};

/*
 * The pair a headless turn is driven through, built ONCE.
 *
 * Not the runtime's own pair: `mountCopilotRuntime` keeps its client and its runner inside
 * `CopilotRuntime` and hands neither back, and reaching into that object would be a worse seam than
 * building our own from the same three settings. Built from `config.runtime.intelligence`, which is
 * required and not optional — `RuntimeCapabilities` has exactly one mode and every Intelligence field
 * with it (`config.ts:10-22`), and `loadConfig` refuses to boot without them — so there is no
 * not-in-Intelligence-mode branch to write here. If a second mode is ever added, THIS is the line that
 * has to grow a guard, and the routine runner must then be left off `createApp` entirely.
 *
 * One runner for the process, reused across firings: it opens a socket per run and holds no idle
 * connection, but its `threads` map is per instance, and a runner per turn would fragment the
 * already-running check that keeps two turns off one thread. See `routines/run-turn.ts`.
 */
const routineIntelligence = observeIntelligenceAuthentication(
  new CopilotKitIntelligence({
    apiUrl: config.runtime.intelligence.apiUrl,
    wsUrl: config.runtime.intelligence.gatewayWsUrl,
    apiKey: config.runtime.intelligence.apiKey,
  }),
);
const routineAgentRunner = new IntelligenceAgentRunner({
  url: routineIntelligence.ɵgetRunnerWsUrl(),
  authToken: routineIntelligence.ɵgetRunnerAuthToken(),
});

/*
 * The headless computer tools every turn runner (routines, delivery, OpenMuse tasks) hands its
 * turn: one assembly, because `canUseComputer` and the actor shape are the security-relevant
 * parts and three hand-copied toolsets would mean the next gate change lands in one runner and
 * silently not in the other two.
 */
const computerToolsForTurn = async ({
  ownerUserId,
  agentId,
  initiator,
}: {
  ownerUserId: string;
  agentId: string;
  initiator: AuditInitiator;
}) => {
  if (!computerGateway) return [];
  const actor = await actorFor(ownerUserId);
  const profile = await agentProfileStore.get(actor, agentId);
  if (!profile) throw new Error("That Bot is not available to this owner.");
  // A Team Bot's teammate uses the Bot, not its owner's signed-in computer.
  if (!canUseComputer(profile, actor)) return [];
  return createHeadlessComputerTools({
    gateway: computerGateway,
    botId: agentId,
    actor: { id: actor.id, userId: actor.id, initiator },
    auditStore: bootAuditStore,
    ...(signInService ? { signIn: signInService } : {}),
  });
};

const routineRunner = createRoutineRunner({
  routineStore,
  channelStore,
  runTurn: createTurnRunner({
    intelligence: routineIntelligence,
    runner: routineAgentRunner,
    components: { store: componentStore, auditStore: bootAuditStore },
    buildAgentFor,
    toolsForTurn: computerToolsForTurn,
    learningContainerForThread: (input) =>
      copilotRuntime.learning?.containerForThread(input) ??
      Promise.resolve(undefined),
  }),
});

/**
 * The runtime, and the two things beside it a hop needs.
 *
 * `agentFor` builds the addressed Bot exactly the way a person's run builds it, and `history` reads
 * the conversation through the same client. Taken from here rather than assembled again, because a
 * Bot built by parallel wiring drifts the first time one of these arguments changes, and the drift is
 * invisible: it runs, and quietly holds different tools or a different role from the one the person
 * is talking to.
 */
const actorAgentResolver = createActorAgentResolver({
  loadAgents: loadAgentsForActor,
  model: runtimeModel,
  resolveModelApiKey: resolveRuntimeModelApiKey,
  stallGuard,
  loadToolsForActor: (actorId, initiator) =>
    restrictToolsForRun(
      initiator,
      loadToolsForActor(actorId, initiator),
      proactiveReadOnlyRefs,
    ),
  signRunForActor,
  computerGuidance: config.computer ? COMPUTER_GUIDANCE : undefined,
  loadVendors,
  selectionForActor,
  agentFetch,
  handoffForActor: (actorId, initiator, depth) =>
    restrictCoordinationForRun(
      initiator,
      coordinationForActor(actorId, initiator, depth),
    ),
  loadInstructionsForActor,
  loadAttachmentForActor,
  markAttachmentsSentForActor,
  // The runtime owns Learning. Resolve its reader only when a turn is built, after boot wiring.
  get acquireLearnedSkills() {
    return copilotRuntime.learning?.acquire;
  },
  loadPersonalMemoryForActor,
  // Undefined when retrieval is off: the resolver forwards it as an absent optional, which is
  // exactly "no middleware mounted" — the same shape as an unconfigured personal memory.
  loadKnowledgeForActor: knowledgeRuntime?.loadKnowledgeForActor,
});

/**
 * The browser mount's durable Runner, composed only from the boot-verified enterprise
 * capabilities. Admission reuses the same ScopeResolver and ConversationService the conversation
 * routes use, the same actor-authorized Bot the runtime selects, and the same effective
 * tenant-package/deployment model selection every other model consumer uses — issued per request
 * with immutable Expert and agent-bound route refs, never read from client fields. The
 * keyEncryptionKey stands in as the route/capability HMAC secret until the governed ModelGateway
 * slice names a dedicated one; both are deployment-owned secrets and never leave this process.
 */
const enterpriseRunner = enterpriseCapabilities
  ? createProductionRunnerComposition({
      data: enterpriseCapabilities.data,
      scopeResolver: enterpriseCapabilities.scopes,
      conversations: enterpriseCapabilities.conversations,
      identifyActor,
      resolver: actorAgentResolver,
      modelSelection: () => ({
        route: {
          model: runtimeModel,
          credentialSecretRef: tenantPackage.model.credentialSecretRef,
        },
        nativeBaseUrl:
          runtimeModel.provider === "anthropic"
            ? process.env.ANTHROPIC_BASE_URL
            : process.env.OPENAI_BASE_URL,
      }),
      modelCapabilitySecret: config.keyEncryptionKey,
      // The governed gateway dial resolves the admitted route's api key
      // through the same encrypted credential store every other surface uses.
      credentialEncryptionKey: config.keyEncryptionKey,
      credentialReader: credentialStore,
    })
  : undefined;

const copilotRuntime = mountCopilotRuntime(
  config,
  actorAgentResolver,
  identifyUser,
  identifyActor,
  {
    onRunBusy: (input) => {
      void channelStore.signalBusy(input.threadId, input.busy).catch(() => {});
    },
    learningSettings,
    ...(enterpriseRunner ? { enterpriseRunner } : {}),
  },
);

const responsibilityQueue = createWorkQueue(database);
const responsibilityEngine: ResponsibilityEngine = createResponsibilityEngine({
  store: responsibilityStore,
  queue: responsibilityQueue,
  runTurn: async (context) => {
    const initiator: AuditInitiator = {
      kind: "responsibility",
      id: context.responsibilityId,
    };
    const tools = responsibilityTools({
      store: responsibilityStore,
      engine: responsibilityEngine,
      ownerUserId: context.ownerUserId,
      agentId: context.agentId,
      channelId: context.channelId,
      responsibilityRunId: context.runId,
    });
    const runner = createTurnRunner({
      intelligence: routineIntelligence,
      runner: routineAgentRunner,
      components: { store: componentStore, auditStore: bootAuditStore },
      buildAgentFor: (input) => buildAgentFor({ ...input, initiator }),
      toolsForTurn: async () => {
        const actor = await actorFor(context.ownerUserId);
        // A Team Bot's teammate uses the Bot, not its owner's signed-in computer.
        const computer =
          computerGateway &&
          canUseComputer(
            await agentProfileStore
              .get(actor, context.agentId)
              .catch(() => null),
            actor,
          )
            ? createHeadlessComputerTools({
                gateway: computerGateway,
                botId: context.agentId,
                actor: { id: actor.id, userId: actor.id, initiator },
                auditStore: bootAuditStore,
                ...(signInService ? { signIn: signInService } : {}),
              })
            : [];
        return [
          ...computer,
          ...tools.map((tool) => ({
            definition: {
              name: tool.name,
              description: tool.description,
              parameters: z.toJSONSchema(tool.parameters),
            },
            execute: (args: unknown) => tool.execute(args),
          })),
        ];
      },
      learningContainerForThread: (input) =>
        copilotRuntime.learning?.containerForThread(input) ??
        Promise.resolve(undefined),
    });
    const saved = context.continuation;
    const snapshot = saved
      ? parseApprovalContinuation(saved.waiting.continuation)
      : undefined;
    const toolResult = saved ? parseApprovalResult(saved.response) : undefined;
    return runner({
      ownerUserId: context.ownerUserId,
      routineId: context.responsibilityId,
      agentId: context.agentId,
      threadId: context.threadId,
      initiator,
      signal: context.signal,
      ...(snapshot && toolResult
        ? {
            continuation: {
              snapshot,
              result: toolResult,
              messageId: `responsibility-result:${context.runId}:${snapshot.toolCallId}`,
            },
          }
        : {}),
      instruction: buildResponsibilityTurn({
        instruction: context.instruction,
        successCriteria: context.successCriteria,
        progress: context.progress,
        trigger: context.event,
        eventData: markUntrusted(
          JSON.stringify(context.event.payload),
          `${context.event.source} event`,
        ),
        responsibilityId: context.responsibilityId,
      }),
    });
  },
  onReply: async (context, text) => {
    await channelStore.recordActivity(
      await actorFor(context.ownerUserId),
      context.channelId,
      { text, agentId: context.agentId, at: new Date() },
      { id: `responsibility:${context.runId}` },
    );
    await deliveryNotifications(
      {
        ownerUserId: context.ownerUserId,
        channelId: context.channelId,
        agentId: context.agentId,
        threadId: context.threadId,
      },
      { id: `responsibility:${context.runId}`, kind: "reply", text },
    );
  },
});
/**
 * A turn for a responsibility that is not one of the engine's own firings: a person answering the
 * question its run asked. Same tools, same initiator and the same run to report progress against,
 * so the Bot can carry on with the goal instead of being unable to record it.
 */
const responsibilityAnswerTurn = ({
  responsibility,
  responsibilityRunId,
}: {
  responsibility: Responsibility;
  responsibilityRunId: string | undefined;
}) => {
  const initiator: AuditInitiator = {
    kind: "responsibility",
    id: responsibility.id,
  };
  const tools = responsibilityTools({
    store: responsibilityStore,
    engine: responsibilityEngine,
    ownerUserId: responsibility.ownerUserId,
    agentId: responsibility.agentId,
    channelId: responsibility.channelId,
    ...(responsibilityRunId ? { responsibilityRunId } : {}),
  });
  return createTurnRunner({
    intelligence: routineIntelligence,
    runner: routineAgentRunner,
    components: { store: componentStore, auditStore: bootAuditStore },
    buildAgentFor: (input) => buildAgentFor({ ...input, initiator }),
    toolsForTurn: async () => [
      ...(await approvalComputerTools(
        responsibility.ownerUserId,
        responsibility.agentId,
        initiator,
      )),
      ...tools.map((tool) => ({
        definition: {
          name: tool.name,
          description: tool.description,
          parameters: z.toJSONSchema(tool.parameters),
        },
        execute: (args: unknown) => tool.execute(args),
      })),
    ],
    learningContainerForThread: (input) =>
      copilotRuntime.learning?.containerForThread(input) ??
      Promise.resolve(undefined),
  });
};
const responsibilitySweep = repeatAfterEach(async () => {
  try {
    const report = await responsibilityEngine.dispatch({
      owner: workOwner("responsibility"),
      limit: 1,
    });
    if (
      report.succeeded.length ||
      report.failed.length ||
      report.waiting.length
    )
      log.info(
        { type: "responsibility-dispatch", ...report },
        "responsibility-dispatch",
      );
  } catch (error) {
    log.error(
      {
        type: "responsibility-dispatch-error",
        error: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString(),
      },
      "responsibility-dispatch-error",
    );
  }
}, 2_000);

const approvalQueue = createWorkQueue(database);
const approvalOwner = workOwner("approval");
const approvalComputerTools = async (
  ownerUserId: string,
  agentId: string,
  initiator: AuditInitiator,
) => {
  const actor = await actorFor(ownerUserId);
  const profile = await agentProfileStore.get(actor, agentId);
  if (!profile)
    throw new ApprovalRefusedError("That Bot is no longer available to you.");
  // A Team Bot's teammate uses the Bot, not its owner's signed-in computer.
  return computerGateway && canUseComputer(profile, actor)
    ? createHeadlessComputerTools({
        gateway: computerGateway,
        botId: agentId,
        actor: { id: actor.id, userId: actor.id, initiator },
        auditStore: bootAuditStore,
        ...(signInService ? { signIn: signInService } : {}),
      })
    : [];
};
const executeApprovedAction = createApprovedActionExecutor({
  sourceFor: sourceForCoordinationRun,
  gate: approvalService.gate,
  computerTools: approvalComputerTools,
  hostTools: ({ actorId, botId, initiator }) =>
    hostAccessTools({
      broker: hostAccessBroker,
      botId,
      actorId,
      initiator,
      auditStore: bootAuditStore,
    }),
  callTool: (input) => pluginStore.callTool(input),
  credentialActorFor: (actorId, botId, ref) =>
    teamBots.credentialActorFor(actorId, botId)(ref),
  coordinationCall: (input) => coordination.call(input),
  readRun: (value) => readApprovedRunAssertion(value, config.keyEncryptionKey),
  answer: vendorAnswer,
  privateShareToolRef: PRIVATE_SHARE_TOOL_REF,
  refusalMarker: REFUSAL_MARKER,
  personInitiator: PERSON_INITIATOR,
});
const approvalContinuationRunner = createTurnRunner({
  intelligence: routineIntelligence,
  runner: routineAgentRunner,
  components: { store: componentStore, auditStore: bootAuditStore },
  buildAgentFor,
  toolsForTurn: async ({ ownerUserId, agentId, initiator }) =>
    approvalComputerTools(ownerUserId, agentId, initiator),
  learningContainerForThread: (input) =>
    copilotRuntime.learning?.containerForThread(input) ??
    Promise.resolve(undefined),
});
const approvalSweep = repeatAfterEach(async () => {
  try {
    const [item] = await approvalQueue.claim({
      kind: "approval.resume",
      owner: approvalOwner,
      leaseMs: 15 * 60_000,
      limit: 1,
    });
    if (!item) return;
    // Set once the item is understood, so its last failed try can still tell the Bot.
    let abandon: ((reason: string) => Promise<void>) | undefined;
    try {
      const input = z
        .object({
          ownerUserId: z.string().min(1),
          approvalId: z.string().min(1),
        })
        .parse(item.payload);
      const resumeDependencies: ApprovalResumeDependencies = {
        // Asked before the action runs: with Use Bots off, or the Bot's model off the allowlist,
        // nothing is carried out and the refusal is final rather than retried.
        refusal: (action) =>
          headlessTurnRefusal({
            ownerUserId: action.actorId,
            agentId: action.botId,
          }),
        validate: (action) =>
          approvalService.validateReentry(action, () =>
            executeApprovedAction(action),
          ),
        execute: executeApprovedAction,
        continue: async ({
          continuation: snapshot,
          result,
          messageId,
          approvalId,
        }) => {
          const [waitingRun] = await database
            .select({ id: responsibilityRuns.id })
            .from(responsibilityRuns)
            .where(
              and(
                eq(responsibilityRuns.status, "waiting"),
                sql`${responsibilityRuns.waiting}->>'approvalId' = ${approvalId}`,
              ),
            )
            .limit(1);
          if (waitingRun) {
            await responsibilityStore.resumeWaiting(
              input.ownerUserId,
              waitingRun.id,
              result,
            );
            return;
          }
          const request = await approvalService.store.get(
            input.ownerUserId,
            approvalId,
          );
          // A group turn's approval also writes the resumed reply into the shared transcript.
          const outcome = await groupConversations.continueWaiting(
            approvalId,
            () =>
              approvalContinuationRunner({
                ownerUserId: input.ownerUserId,
                routineId: "approval",
                agentId: request.action.botId,
                threadId: snapshot.threadId,
                instruction: "",
                initiator: snapshot.initiator ?? PERSON_INITIATOR,
                continuation: { snapshot, result, messageId },
              }),
          );
          const [source] = await database
            .select({ channelId: intelligenceChannelMappings.channelId })
            .from(intelligenceChannelMappings)
            .where(
              and(
                eq(intelligenceChannelMappings.userId, input.ownerUserId),
                eq(intelligenceChannelMappings.threadId, snapshot.threadId),
              ),
            )
            .limit(1);
          if (source && outcome.replyText)
            await channelStore.recordActivity(
              await actorFor(input.ownerUserId),
              source.channelId,
              {
                text: outcome.replyText,
                agentId: request.action.botId,
                at: new Date(),
              },
              { id: messageId },
            );
          // A decision made in Slack, SMS or the phone gets its result back there too.
          if (source && outcome.replyText)
            await deliveryNotifications(
              {
                ownerUserId: input.ownerUserId,
                channelId: source.channelId,
                agentId: request.action.botId,
                threadId: snapshot.threadId,
              },
              { id: messageId, text: outcome.replyText, kind: "reply" },
            );
          await database
            .update(routineRuns)
            .set({
              status: "succeeded",
              finishedAt: new Date(),
              error: null,
              waiting: null,
            })
            .where(
              and(
                eq(routineRuns.status, "waiting"),
                sql`${routineRuns.waiting}->>'approvalId' = ${approvalId}`,
              ),
            );
        },
      };
      abandon = (reason) =>
        approvalService.abandon(
          input.ownerUserId,
          input.approvalId,
          reason,
          resumeDependencies,
        );
      await approvalService.resume(
        input.ownerUserId,
        input.approvalId,
        resumeDependencies,
      );
      if (
        !(await approvalQueue.finish({
          kind: item.kind,
          key: item.key,
          owner: approvalOwner,
        }))
      )
        throw new Error("The approval work lease was lost before completion.");
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      // The queue will not hand this item out again, so the conversation hears now or never.
      if (abandon && item.attempts >= DEFAULT_MAX_ATTEMPTS) {
        try {
          await abandon(reason);
          await approvalQueue.finish({
            kind: item.kind,
            key: item.key,
            owner: approvalOwner,
          });
          return;
        } catch (failure) {
          log.error(
            {
              type: "approval-abandon-error",
              error:
                failure instanceof Error ? failure.message : String(failure),
              timestamp: new Date().toISOString(),
            },
            "approval-abandon-error",
          );
        }
      }
      await approvalQueue.release({
        kind: item.kind,
        key: item.key,
        owner: approvalOwner,
        delayMs: 10_000,
        reason,
      });
      throw error;
    }
  } catch (error) {
    log.error(
      {
        type: "approval-resume-error",
        error: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString(),
      },
      "approval-resume-error",
    );
  }
}, 2_000);
const deliveryStore = createDeliveryStore(database);
const deliveryProviders = configuredDeliveryProviders(
  config.publicUrl ?? config.auth?.baseUrl ?? `http://localhost:${config.port}`,
);
// Slack channel membership for triggers is answered by OpenTag, which holds the workspace token.
useSlackChannelMembership((input) =>
  deliveryProviders.slack
    ? deliveryProviders.slack.isMember(input)
    : Promise.resolve(false),
);
const deliveryScopeFor: DeliveryScopeResolver = async (
  ownerUserId,
  channelId,
  agentId,
) => {
  const person = await peopleStore.find(ownerUserId);
  if (!person || person.revoked) return null;
  const actor = await actorFor(ownerUserId);
  const [channel, bot] = await Promise.all([
    channelStore.get(actor, channelId),
    agentProfileStore.get(actor, agentId),
  ]);
  return channel?.active && bot && channel.agentIds.includes(agentId)
    ? { ownerUserId, channelId, agentId, threadId: channel.threadId }
    : null;
};
const authoriseDeliveryScope = async (scope: DeliveryScope) =>
  (await deliveryScopeFor(scope.ownerUserId, scope.channelId, scope.agentId))
    ?.threadId === scope.threadId;
const deliveryRouter = createDeliveryRouter({
  store: deliveryStore,
  queue: createWorkQueue(database),
  owner: workOwner("delivery"),
  providers: deliveryProviders,
  authoriseScope: authoriseDeliveryScope,
  notifyEvent: (event) => responsibilityEngine.ingest(event),
  runTurn: async (input) => {
    if (!(await authoriseDeliveryScope(input)))
      throw new Error(
        "The delivery owner no longer has access to this conversation.",
      );
    const actor = await actorFor(input.ownerUserId);
    await channelStore.recordActivity(
      actor,
      input.channelId,
      { text: input.text, agentId: null, at: new Date() },
      { id: `delivery-input:${input.runId}` },
    );
    await channelStore.signalBusy(input.threadId, true);
    try {
      const result = await approvalContinuationRunner({
        ownerUserId: input.ownerUserId,
        routineId: `delivery:${input.runId}`,
        runId: input.runId,
        agentId: input.agentId,
        threadId: input.threadId,
        instruction: input.text,
        userMessage: {
          id: `delivery:${input.runId}`,
          role: "user",
          content: input.text,
        },
        initiator: PERSON_INITIATOR,
        signal: input.signal,
      });
      if (result.replyText)
        await channelStore.recordActivity(
          actor,
          input.channelId,
          { text: result.replyText, agentId: input.agentId, at: new Date() },
          { id: `delivery-reply:${input.runId}` },
        );
      return result;
    } finally {
      await channelStore.signalBusy(input.threadId, false);
    }
  },
  audit: (event) =>
    recordAuditEvent(bootAuditStore, {
      actorUserId: event.ownerUserId,
      initiator: PERSON_INITIATOR,
      eventType:
        event.kind === "inbound"
          ? "delivery.received"
          : event.kind === "sms_opt_out"
            ? "delivery.opted_out"
            : event.state === "failed"
              ? "delivery.failed"
              : "delivery.sent",
      targetType: "channel",
      targetId: event.channelId,
      payload: { deliveryId: event.id, kind: event.kind, state: event.state },
    }),
});
deliveryNotifications = (scope, input) => deliveryRouter.notify(scope, input);

/*
 * Proactive research: an opted-in Bot reading its owner's apps in the background, restricted to
 * reads by its initiator (see proactive/restriction.ts), through the same headless turn runner and
 * work queue as routines. Suggestions go to the web inbox and the owner's delivery routing.
 */
const proactiveStore = createProactiveStore(database);
const proactiveEngine = createProactiveEngine({
  store: proactiveStore,
  memory: personalMemoryStore,
  queue: createWorkQueue(database),
  owner: workOwner("proactive"),
  runTurn: createTurnRunner({
    intelligence: routineIntelligence,
    runner: routineAgentRunner,
    buildAgentFor,
    // Only the run's own two tools and refusals: no computer, no components.
    toolsForTurn: (input) => proactiveEngine.toolsForTurn(input),
    turnTimeoutMs: 3 * 60_000,
    learningContainerForThread: (input) =>
      copilotRuntime.learning?.containerForThread(input) ??
      Promise.resolve(undefined),
  }),
  resolveScope: deliveryScopeFor,
  notify: (scope, input) => deliveryNotifications(scope, input),
  startTask: async (scope, input) => {
    const actor = await actorFor(scope.ownerUserId);
    await channelStore.recordActivity(
      actor,
      scope.channelId,
      { text: input.text, agentId: null, at: new Date() },
      { id: `${input.runId}:input` },
    );
    const result = await approvalContinuationRunner({
      ...scope,
      routineId: input.runId,
      instruction: input.text,
      userMessage: { id: input.runId, role: "user", content: input.text },
      initiator: PERSON_INITIATOR,
      signal: input.signal,
    });
    if (result.replyText)
      await channelStore.recordActivity(
        actor,
        scope.channelId,
        { text: result.replyText, agentId: scope.agentId, at: new Date() },
        { id: `${input.runId}:reply` },
      );
  },
  catalogue: pluginStore,
  deniedToolNames: async (ownerUserId, agentId) => {
    const [tools, allowed] = await Promise.all([
      loadToolsForActor(ownerUserId)(agentId),
      proactiveReadOnlyRefs(),
    ]);
    return tools
      .filter((tool) => !allowed.has(tool.ref) && !allowed.has(tool.name))
      .map((tool) => tool.name);
  },
  mintThreadId: () => threadIdentity.mint(),
});
const proactiveSweep = repeatAfterEach(async () => {
  try {
    await proactiveEngine.sweep();
  } catch (error) {
    log.error(
      {
        type: "proactive-sweep-error",
        error: error instanceof Error ? error.name : "UnknownError",
        timestamp: new Date().toISOString(),
      },
      "proactive-sweep-error",
    );
  }
}, 60_000);
/*
 * Follow-ups a Bot scheduled for itself: one headless turn each, through the same turn runner as a
 * routine, into the person's conversation with that Bot. See agents/wake-up.ts.
 */
const wakeUpQueue = createWorkQueue(database);
const wakeUpRunner = createWakeUpRunner({
  queue: wakeUpQueue,
  store: wakeUpStore,
  owner: workOwner("wake-up"),
  actorFor,
  channels: channelStore,
  runTurn: createTurnRunner({
    intelligence: routineIntelligence,
    runner: routineAgentRunner,
    components: { store: componentStore, auditStore: bootAuditStore },
    buildAgentFor,
    toolsForTurn: computerToolsForTurn,
    learningContainerForThread: (input) =>
      copilotRuntime.learning?.containerForThread(input) ??
      Promise.resolve(undefined),
  }),
  notify: (scope, input) => deliveryNotifications(scope, input),
});
const wakeUpSweep = repeatAfterEach(async () => {
  try {
    const report = await wakeUpRunner.sweep();
    if (report.ran.length || report.skipped.length)
      log.info({ type: "bot-follow-up", ...report }, "bot-follow-up");
  } catch (error) {
    log.error(
      {
        type: "bot-follow-up-error",
        error: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString(),
      },
      "bot-follow-up-error",
    );
  }
}, 5_000);
const wakeUpReaper = repeatAfterEach(async () => {
  await wakeUpRunner.reap().catch(() => 0);
}, 60 * 60_000);
/*
 * OpenMuse Tasks (contracts §7 small first path): each Task row is offered to the
 * same work queue as a follow-up at creation, claimed here once, and run through
 * the same headless turn runner, into the owner's own conversation with their
 * private OpenMuse Bot. See openmuse-tasks/runner.ts. The store is built here —
 * not inline in the app tail — so its queue offer and this runner share one seam.
 */
const openMuseTaskQueue = createWorkQueue(database);
const openMuseTaskStore = createOpenMuseTaskStore({
  rows: createOpenMuseTaskRows(database),
  queue: openMuseTaskQueue,
});
/*
 * The §9 account-deletion store (D01), hoisted for the same reason: the C07 tool seam
 * below fences reads through its isDisabled, and the app tail's delete route and
 * /api/mobile fence answer through the same instance.
 */
const openMuseAccountDeletionStore = createOpenMuseAccountDeletionStore(database);
/*
 * The personal-files store (F01), hoisted beside the runner it feeds: the task
 * runner reads finance CSVs and document versions through it, and the app tail
 * passes the same one to the mobile bff mount and the documents router.
 */
/*
 * The ONE OpenMuse file-bytes root (round 6 M1): the store above and D06's
 * byte purger below read the same env default through the same instance, so
 * the two can never drift onto different roots — a purger pointed elsewhere
 * would mark purge complete while the user's bytes stayed on disk.
 */
const openMuseFileBytes = createLocalFileByteStore(
  process.env.OPENBOT_OPENMUSE_FILES_DIR ?? ".openmuse/files",
);
const openMuseFileStore = createOpenMuseFileStore({
  rows: createOpenMuseFileRows(database),
  byteStore: openMuseFileBytes,
});
/*
 * The OpenMuse template seam, hoisted beside the Task store it gates: the tool
 * wiring below and the app-tail mount at the bottom answer through one store,
 * per the same "built here, not inline in the tail" rule as the store above.
 */
const openMuseTemplateMethods = createOpenMuseTemplateStore({
  database,
  managedAgentAgUiUrl: config.managedAgent?.endpoint,
});
/*
 * C07 (contracts §7): the private OpenMuse Bot's runtime tools. The template
 * row is the gate — a Bot that is not the owner's OpenMuse Bot holds nothing —
 * and the owner is the actor the tools were built for. The template's grants
 * fixture does not yet name these four tools; recording them is a template
 * revision (I09), not a wiring change, so this grants nothing wider than the
 * private Bot's owner.
 */
/*
 * The rows the personal tools read, hoisted ONCE (round 6 M2): the template
 * gate used to rebuild three row objects per turn per call.
 */
const openMusePersonalGoalRows = createOpenMuseGoalRows(database);
const openMusePersonalIdeaRows = createOpenMuseIdeaRows(database);
const openMusePersonalMemoryRows = createOpenMuseMemoryRows(database);
/*
 * The template gate's answer per (owner, bot), cached in-process (M2): the
 * answer is stable for a bot's lifetime — the key moves only by
 * re-provisioning, which lands a NEW bot id and misses the cache — so one
 * lookup per bot serves every turn instead of a findByTemplateKey round
 * trip on every tool load of every Bot, OpenMuse deployment or not.
 */
const openMuseTemplateKeyCache = new Map<string, string | null>();
const openMuseToolsFor = async (ownerUserId: string, botId: string) => {
  const cacheKey = `${ownerUserId}:${botId}`;
  if (!openMuseTemplateKeyCache.has(cacheKey)) {
    const privateBot = await openMuseTemplateMethods.findByTemplateKey(
      ownerUserId,
      OPENMUSE_TEMPLATE_KEY,
    );
    openMuseTemplateKeyCache.set(cacheKey, privateBot?.id ?? null);
  }
  if (openMuseTemplateKeyCache.get(cacheKey) !== botId) return [];
  return openMusePersonalTools({
    ownerUserId,
    agentId: botId,
    goalLookup: goalLookupFor({ rows: openMusePersonalGoalRows }, ownerUserId),
    ideaLookup: ideaLookupFor({ rows: openMusePersonalIdeaRows }, ownerUserId),
    memoryLookup: memoryLookupFor(
      { rows: openMusePersonalMemoryRows },
      ownerUserId,
    ),
    tasks: openMuseTaskStore,
    // D01 at the tool seam: the chat path has no /api/mobile fence, so the fence is here.
    ownerFenced: () => openMuseAccountDeletionStore.isDisabled(ownerUserId),
  });
};
/*
 * T12 (§7): the notification store the runner emits through — built before
 * the runner so the seam is the same one the routes read.
 */
const openMuseNotificationStore = createOpenMuseNotificationStore({
  rows: createOpenMuseNotificationRows(database),
});
const openMuseTaskRunner = createOpenMuseTaskRunner({
  queue: openMuseTaskQueue,
  store: openMuseTaskStore,
  owner: workOwner("openmuse-task"),
  actorFor,
  channels: channelStore,
  // T13/T15: the files seam the finance CSV read and the document version
  // read/write run through — wired, so a finance or document Task's run reads
  // its File instead of failing on the unwired-seam default.
  files: openMuseFileStore,
  emitNotification: openMuseNotificationStore.emit,
  runTurn: createTurnRunner({
    intelligence: routineIntelligence,
    runner: routineAgentRunner,
    components: { store: componentStore, auditStore: bootAuditStore },
    buildAgentFor,
    toolsForTurn: computerToolsForTurn,
    learningContainerForThread: (input) =>
      copilotRuntime.learning?.containerForThread(input) ??
      Promise.resolve(undefined),
  }),
});
const openMuseTaskSweep = repeatAfterEach(async () => {
  try {
    const report = await openMuseTaskRunner.sweep();
    if (report.ran.length || report.skipped.length)
      log.info({ type: "openmuse-task", ...report }, "openmuse-task");
  } catch (error) {
    log.error(
      {
        type: "openmuse-task-error",
        error: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString(),
      },
      "openmuse-task-error",
    );
  }
}, 5_000);
const openMuseTaskReaper = repeatAfterEach(async () => {
  await openMuseTaskRunner.reap().catch(() => 0);
}, 60 * 60_000);
const deliverySweeps = DELIVERY_WORK_KINDS.map((kind) =>
  repeatAfterEach(async () => {
    try {
      await deliveryRouter.sweep(kind);
    } catch (error) {
      log.error(
        {
          type: "delivery-worker-error",
          kind,
          errorType: error instanceof Error ? error.name : "UnknownError",
        },
        "delivery-worker-error",
      );
    }
  }, 2_000),
);

const personResponseOwner = workOwner("person-response");
/**
 * Conversations with several Bots. Each Bot turn is an ordinary headless AG-UI turn into that Bot's
 * own group thread, built exactly as a routine's is, so governance, learning and the computer tools
 * apply unchanged; Bots answering each other reuse the handoff desk's grant and caps.
 */
const groupConversations = createGroupConversations({
  store: createGroupStore(database, () => threadIdentity.mint()),
  queue: createWorkQueue(database),
  owner: workOwner("group"),
  roster: async (ownerUserId, channelId) => {
    const actor = await actorFor(ownerUserId);
    const channel = await channelStore.get(actor, channelId);
    if (!channel || channel.agentIds.length < 2) return null;
    const bots: { id: string; name: string }[] = [];
    for (const agentId of channel.agentIds) {
      const profile = await agentProfileStore.get(actor, agentId);
      if (profile) bots.push({ id: agentId, name: profile.name });
    }
    return bots;
  },
  runTurn: createTurnRunner({
    intelligence: routineIntelligence,
    runner: routineAgentRunner,
    components: { store: componentStore, auditStore: bootAuditStore },
    buildAgentFor,
    toolsForTurn: computerToolsForTurn,
    learningContainerForThread: (input) =>
      copilotRuntime.learning?.containerForThread(input) ??
      Promise.resolve(undefined),
  }),
  caps: config.handoff,
  // The handoff desk's own grant check, read per hop and failing closed.
  mayAddress: async (fromBotId, toBotId) =>
    (
      await pluginStore.botsReachableFrom(fromBotId).catch(() => [] as string[])
    ).includes(toBotId),
  auditStore: bootAuditStore,
  activity: async (turn, agentId, text, sourceId) =>
    channelStore.recordActivity(
      await actorFor(turn.ownerUserId),
      turn.channelId,
      { text, agentId, at: new Date() },
      { id: sourceId },
    ),
  busy: async (turn, busy) =>
    channelStore.signalChannelBusy(
      await actorFor(turn.ownerUserId),
      turn.channelId,
      busy,
    ),
  createChannel: async (ownerUserId, agentIds) =>
    channelStore.create(await actorFor(ownerUserId), agentIds),
  // The owner says whether a Bot's words may reach the other people in a group.
  privateShare: createPrivateShareCheck({ approvals: approvalService.store }),
  // A Team Bot's consent card raised in a group turn is drawn in the shared transcript.
  listenForConsent: (ownerUserId, agentId) =>
    teamBots.listenForConsent(ownerUserId, agentId),
});
const groupSweep = repeatAfterEach(async () => {
  try {
    while (await groupConversations.sweep()) {}
  } catch (error) {
    log.error(
      {
        type: "group-sweep-error",
        error: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString(),
      },
      "group-sweep-error",
    );
  }
}, 1_000);

const personResponseSweep = repeatAfterEach(async () => {
  try {
    const [item] = await approvalQueue.claim({
      kind: "person.response",
      owner: personResponseOwner,
      leaseMs: 10 * 60_000,
      limit: 1,
      maxAttempts: 1,
    });
    if (!item) return;
    try {
      const payload = z
        .object({
          ownerUserId: z.string().min(1),
          // The saved question, initiator included, so the answer resumes the turn that asked.
          question: personQuestionSchema,
          response: z.string().min(1).max(6000),
        })
        .parse(item.payload);
      if (payload.ownerUserId !== payload.question.actorId)
        throw new ApprovalRefusedError(
          "The saved question owner does not match.",
        );
      await authoriseQuestion(payload.question);
      const outcome = await resumePersonQuestion({
        ownerUserId: payload.ownerUserId,
        question: payload.question,
        response: payload.response,
        messageId: `person-response:${item.key}`,
        runTurn: approvalContinuationRunner,
        responsibilities: responsibilityStore,
        responsibilityTurn: responsibilityAnswerTurn,
      });
      const source = await sourceForCoordinationRun({
        ...payload.question,
        botId: questionConversationBot(payload.question),
        depth: 0,
      });
      if (source && outcome.replyText)
        await channelStore.recordActivity(
          await actorFor(payload.ownerUserId),
          source.channelId,
          {
            text: outcome.replyText,
            agentId: questionConversationBot(payload.question),
            at: new Date(),
          },
          { id: `person-response:${item.key}` },
        );
      if (source && outcome.replyText)
        await deliveryNotifications(
          {
            ownerUserId: payload.ownerUserId,
            channelId: source.channelId,
            agentId: questionConversationBot(payload.question),
            threadId: payload.question.threadId,
          },
          {
            id: `person-response:${item.key}`,
            text: outcome.replyText,
            kind: "reply",
          },
        );
      if (
        !(await approvalQueue.finish({
          kind: item.kind,
          key: item.key,
          owner: personResponseOwner,
        }))
      )
        throw new Error(
          "The question response lease was lost before completion.",
        );
    } catch (error) {
      await approvalQueue.release({
        kind: item.kind,
        key: item.key,
        owner: personResponseOwner,
        delayMs: 0,
        reason: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  } catch (error) {
    log.error(
      {
        type: "person-response-error",
        error: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString(),
      },
      "person-response-error",
    );
  }
}, 2_000);

/**
 * Delivering hops, on every replica.
 *
 * A loop rather than a schedule, because a hop is somebody waiting for an answer rather than
 * housekeeping: the culler's minute-granularity CronJob would be an unexplainable pause in a
 * conversation. Every replica sweeps, and the queue decides which of them gets which hop, so adding a
 * replica adds delivery capacity rather than contention.
 *
 * Only where the capability is switched on. A deployment with a depth cap of zero never has a hop to
 * deliver, and a loop polling for work that cannot exist is a query a second for nothing.
 */
/*
 * Both zeros switch the capability off, so both have to stop the loop.
 *
 * Gated on the depth alone, a deployment that set the fan-out cap to zero still swept every two
 * seconds for hops that can never be offered: roughly forty thousand claim transactions per replica
 * per day, for a feature it had turned off.
 */
/**
 * The queue's own wake-up, when handing work between Bots is switched on at all.
 *
 * Held at module scope so the shutdown below can give its connection back. Undefined on a
 * deployment with the capability off, which is a deployment that never started one.
 */
let workOfferedListener: WorkOfferedListener | undefined;

if (config.handoff.maxDepth > 0 && config.handoff.maxPerRun > 0) {
  const runner = createHandoffRunner({
    queue: createWorkQueue(database),
    owner: workOwner("handoff"),
    auditStore: bootAuditStore,
    /*
     * The signed statement of the run the addressed Bot is about to start, carrying how deep the
     * chain has gone. Minted here, where the key lives, and one deeper than the run that asked.
     */
    sign: (work, claim) =>
      signHandoffDeliveryRun(work, config.keyEncryptionKey, undefined, claim),
    delivery: createHandoffDelivery({
      /*
       * Built as the person, WITH THEIR ROLE. The desk resolved it to decide the hop was allowed; a
       * delivery that then rebuilt them as an ordinary user could not find the Bot the desk had just
       * agreed to, and the person was told it never answered.
       */
      agentFor: async ({ actorId, botId, fromBotId, initiator }) => {
        const actor = await actorFor(actorId).catch(() => null);
        if (!actor) {
          throw new Error(
            "who this is for could not be confirmed, so the Bot was not run",
          );
        }
        return copilotRuntime.agentFor({
          actor,
          botId,
          initiator: handoffInitiator(fromBotId, initiator),
        });
      },
      history: copilotRuntime.history,
      lock: copilotRuntime.threadLock,
      /*
       * A scratch thread of the addressed Bot's own, one per hop.
       *
       * An Intelligence thread has exactly one agent, so a second Bot cannot answer inside the first
       * Bot's conversation however it asks. Its turn runs here instead, unmapped to any channel, and
       * what it said comes back to the conversation that asked through the relay — in the asking
       * Bot's voice, which is the only voice that thread admits. Minted with the deployment's own
       * identity, like every thread this deployment starts.
       */
      mintThreadId: () => threadIdentity.mint(),
      /*
       * The roster, told that a relayed answer landed. The delivery knows only the thread it ran
       * in; this resolves which channel shows that thread — a scratch thread maps to nothing and
       * announces nowhere, which is the point of a scratch thread.
       */
      announce: async (input) => {
        const [mapped] = await database
          .select({ channelId: intelligenceChannelMappings.channelId })
          .from(intelligenceChannelMappings)
          .where(eq(intelligenceChannelMappings.threadId, input.threadId))
          .limit(1);
        // A Bot's group thread maps to no channel; its answer goes to the shared transcript.
        if (!mapped) {
          await groupConversations.announceHandoff(input);
          return;
        }
        const actor = await actorFor(input.actorId).catch(() => null);
        if (!actor) return;
        await channelStore.recordActivity(actor, mapped.channelId, {
          text: input.text,
          agentId: input.agentId,
          at: new Date(),
        });
      },
      // The asking conversation shown as working while a hop runs in it. Keyed by thread, resolved
      // to its channel by the store; a scratch thread maps to none and signals nowhere.
      setBusy: (input) => channelStore.signalBusy(input.threadId, input.busy),
      newRunId: () => randomUUID(),
      // The same address and the same token the runtime uses. Assembling either from configuration
      // produced a runner every join was refused for, because the thread's active run is a lock the
      // platform issues rather than something an API key can claim.
      runner: new IntelligenceAgentRunner(
        copilotRuntime.runnerConnection(),
      ) as never,
    }),
  });

  const sweep = async () => {
    try {
      const report = await runner.sweep();
      if (report.delivered.length > 0 || report.skipped.length > 0) {
        log.info({ type: "bot-handoff", ...report }, "bot-handoff");
      }
    } catch (error) {
      // A sweep that failed must not take the loop with it: the next one may find the database back.
      log.warn({ err: error }, "[handoff] a sweep could not run");
    }
  };

  /*
   * ONE SWEEP AT A TIME ON THIS REPLICA, from both callers below. A sweep poked while one is
   * running is remembered rather than started, and runs once the current one ends — a wake-up
   * that arrived mid-sweep may be for a hop the running sweep's claim already missed.
   */
  let sweeping = false;
  let sweepAgain = false;
  const kick = async () => {
    if (sweeping) {
      sweepAgain = true;
      return;
    }
    sweeping = true;
    try {
      do {
        sweepAgain = false;
        await sweep();
      } while (sweepAgain);
    } finally {
      sweeping = false;
    }
  };

  /*
   * Woken by the queue itself, from any replica: a person is waiting through every hop, and the
   * poll below would spend up to two seconds per leg doing nothing. The poll stays as the
   * backstop — a notification is a latency optimisation, and one lost in transit costs one
   * interval, never the work. See repeatAfterEach for why an interval must not be used: an
   * interval would start another sweep every two seconds while a five-minute delivery runs, each
   * claiming a different batch, and this replica's concurrent agent runs would grow with the
   * backlog rather than stopping at the limit it was asked for.
   */
  workOfferedListener = await startWorkOfferedListener(
    config.databaseUrl,
    (kind) => {
      if (kind === HANDOFF_KIND) void kick();
    },
  );
  repeatAfterEach(kick, 2_000);
}

/*
 * And dropping the hops that are over, whether or not the capability is switched on.
 *
 * OUTSIDE THE GATE ABOVE, deliberately. A deployment that switches handing work off still has
 * whatever it made while it was on, and rows that stop being reaped are rows that stay at the head
 * of the queue: switched back on a month later, the first thing that happens is a month-old question
 * being delivered to somebody who has long since stopped waiting. Reaping is housekeeping about the
 * past rather than part of the feature.
 *
 * Every replica reaps; the statement is a delete by age, so two doing it is the same as one doing it.
 * Its own loop rather than a phase of the sweep, so an hour of failing to reap never delays an answer.
 */
const reaper = createHandoffRunner({
  queue: createWorkQueue(database),
  owner: workOwner("reaper"),
  sign: () => "",
  auditStore: bootAuditStore,
  // Never called: `reap` deletes rows by age and claims nothing.
  delivery: {
    deliver: async () => {
      throw new Error("the reaper does not deliver hops");
    },
  },
});
repeatAfterEach(
  async () => {
    try {
      const purged = await reaper.reap();
      if (purged > 0) {
        log.info({ type: "bot-handoff-reaped", purged }, "bot-handoff-reaped");
      }
    } catch (error) {
      log.warn(
        { err: error },
        "[handoff] hops that are over could not be dropped",
      );
    }
  },
  60 * 60 * 1_000,
);

/*
 * Naming conversations, in the API process rather than `worker/`, which the single-image container
 * does not run. Its own loop, so a slow model never delays a hop.
 */
const channelSummaries = {
  database,
  queue: createWorkQueue(database),
  transcript: routineIntelligence,
  title: createChannelTitler({
    model: runtimeModel.defaultModel,
    resolveApiKey: resolveRuntimeModelApiKey,
  }),
  owner: workOwner("summariser"),
};
repeatAfterEach(async () => {
  try {
    await offerChannelsAwaitingSummary(channelSummaries);
    const report = await summariseClaimedChannels(channelSummaries);
    if (report.written.length > 0) {
      log.info(
        { type: "channel-summaries", written: report.written },
        "channel-summaries",
      );
    }
    // Same pass: one statement, deletes by age, and two replicas running it changes nothing.
    await forgetSettledSummaries(channelSummaries);
  } catch (error) {
    // Never fatal, and never loud enough to drown the log: a deployment with no model configured
    // reaches this on every pass, and it has not gone wrong, it simply has no titles.
    log.warn({ err: error }, "[channels] conversations could not be named");
  }
}, 10_000);

/*
 * Trace context propagation and, when a collector is configured, trace export. Installed
 * beside the audit exporter below so the first request already runs inside a trace.
 */
initProcessTracing("server", process.env);

/*
 * Enterprise controls (server/src/admin): capability switches, SSO-required, SCIM offboarding,
 * computer termination, network policy push, Action Recording, the model allowlist and the
 * OpenTelemetry/SIEM export of the audit trail. Installed before the app so the computer boundary,
 * the HTTP gate and the guarded stores below all see it from the first request.
 */
await installEnterpriseControls({
  database,
  databaseUrl: config.databaseUrl,
  auditStore: bootAuditStore,
  ...(computerProvider ? { provider: computerProvider } : {}),
  ...(config.computer?.token ? { computerToken: config.computer.token } : {}),
  ...(config.webBotAuth ? { webBotAuth: config.webBotAuth } : {}),
  builtInModel: `${runtimeModel.provider}/${runtimeModel.defaultModel}`,
  people: peopleStore,
  initialAdminEmails: config.auth?.initialAdminEmails ?? [],
});
guardDeliveryStore(
  deliveryStore,
  bootAuditStore,
  (message) => new DeliveryRefusedError(message),
);
guardHostAccess(
  hostAccessBroker,
  (message) => new HostAccessRefusedError(message),
);
auditRoutineStore(routineStore, bootAuditStore);

// Asked only whether this deployment pays for Intelligence, for the self-host banner. Its own client
// rather than the runtime's, the same as the thread reader: the constructor opens nothing.
const selfHostBannerIntelligence = createIntelligenceClient(
  config.runtime.intelligence,
);

/*
 * The billing seam, assembled only when a provider was configured.
 *
 * One fail-fast first: the provider URL is vetted at the DNS level here, before the app exists,
 * because a base URL the outbound policy refuses is a deployment wired wrong (the policy is the one
 * in billing/outbound.ts: scheme allow-list, then the destination tables, then every DNS answer
 * re-judged as an address). The check cannot live in the synchronous `loadConfig` — resolving a name
 * is async — so boot is the boundary it gets instead, and a refused URL stops the process with the
 * variable named rather than surfacing as a 503 on the first sync.
 *
 * The guard built from the same verdict then rides on every request the client makes, immediately
 * before it is opened, which is the type-level half of the same guarantee (the client's
 * `assertTarget` is required, so no assembly can construct one that skips it).
 */
const billingSettings = config.billing;
/*
 * A deployment that configured the billing provider but not the hard-cap price block refuses
 * every metered call (index.ts's model gate). Say so at boot, with the offending keys, instead of
 * letting it surface as a user-facing "no credits left" on the first request (audit A4/C2).
 */
if (
  billingSettings !== undefined &&
  billingSettings.creditPolicy.configured === false
) {
  log.error(
    {
      type: "billing-credit-policy-unconfigured",
      issues: billingSettings.creditPolicy.issues.map((issue) => `${issue.key}:${issue.reason}`),
    },
    "billing-credit-policy-unconfigured: metered work will refuse until these keys are fixed",
  );
}
const billing =
  billingSettings === undefined
    ? undefined
    : await (async () => {
        const settings = billingSettings;
        const verdict = await checkOutboundUrl(settings.apiUrl, {
          allowPrivate: settings.allowPrivateHosts,
        });
        if (!verdict.allowed) {
          throw new Error(
            `LAGO_API_URL was refused by the outbound policy: ${verdict.reason}`,
          );
        }
        const externalCustomerKey = deploymentExternalCustomerId(
          config.deploymentId ?? tenantPackage.tenantId,
        );
        const lagoClient = createLagoClient({
          baseUrl: settings.apiUrl,
          apiKey: settings.apiKey,
          assertTarget: createOutboundGuard({
            allowPrivate: settings.allowPrivateHosts,
          }),
          ...(settings.requestTimeoutMs !== undefined
            ? { requestTimeoutMs: settings.requestTimeoutMs }
            : {}),
        });
        return {
          service: createBillingService({
            config: {
              externalCustomerKey,
              webhookMode: settings.webhookMode,
            },
            client: lagoClient,
            store: createBillingStore(database),
            // The reconciliation pass (T7): over the database directly, not the deps the
            // service holds — the pass audits those collaborators and must not read through
            // them. Scoped to the deployment's customer key, the same key the purchase
            // guard's uncached read uses, so audit and gate agree about "live".
            // The reconciliation pass (T7): over the database directly, not the deps the
            // service holds — the pass audits those collaborators and must not read through
            // them. Scoped to the deployment's customer key, the same key the purchase
            // guard's uncached read uses, so audit and gate agree about "live". The catalog
            // lookup prices each plan's expected allowance in scaled integer units (the same
            // arithmetic the grantor below uses), so the pass can audit that a paid order's
            // plan payout actually landed at the priced amount.
            reconciler: createReconciler(database, externalCustomerKey, (planCode) => {
              const entry = settings.planCatalog.get(planCode);
              return entry && entry.credits > 0
                ? Math.round(entry.credits * CREDIT_SCALE)
                : null;
            }),
            ...(settings.webhookKey
              ? {
                  verifier: createWebhookVerifier({
                    key: settings.webhookKey,
                  }),
                }
              : {}),
            planEntitlements: settings.planEntitlements,
          }),
          // Exposed for the payment assembly below: its activation gate reads the plan's wire
          // facts (interval, currency) through the same client, so the two never disagree about
          // where the provider lives.
          client: lagoClient,
          externalCustomerKey,
          customerName: `OpenBot deployment ${externalCustomerKey}`,
          // The credit ledger's write side — the same writer the admin grant route and the plan
          // payout below share. One writer, one set of birth invariants, every grant flows here.
          creditWriter: createCreditWriter(database),
        };
      })();
const usageOutbox =
  billing === undefined ? undefined : createUsageOutbox(database);

/*
 * The billing seam meters what the built-in Bots consume, once it exists: every model call's
 * admitted call reserves first, then the finished usage becomes one immutable outbox fact with the
 * same event/reservation identity and exact rational charge. Delivery to Lago and credits happens
 * downstream; a completed run whose durable write failed stays visible for reconciliation rather
 * than being silently charged in-process.
 */
if (billing !== undefined && usageOutbox !== undefined) {
  const creditPolicy = billingSettings?.creditPolicy;
  const recordUnsettledUsage = createUsageEvidenceRecorder(usageOutbox, (message) =>
    log.warn(message),
  );
  setModelUsageGate(async (input) => {
    if (!creditPolicy?.configured) {
      // `configured === false` narrows the union to the variant that carries `issues`, so the
      // offending keys reach the error (and the log) without a cast. `creditPolicy === undefined`
      // cannot happen inside this block, but the guard is on `?.` so answer it as "no issues known".
      throw new CreditPolicyUnconfiguredError(
        creditPolicy?.configured === false ? creditPolicy.issues : [],
      );
    }
    const modelId = input.modelId ?? runtimeModel.defaultModel;
    const modelPolicy = creditPolicy.models.get(modelId);
    if (!modelPolicy) throw new ModelNotPricedError(modelId);

    let reservation: Awaited<
      ReturnType<typeof billing.creditWriter.reserveCredits>
    >;
    try {
      reservation = await billing.creditWriter.reserveCredits({
        externalCustomerId: billing.externalCustomerKey,
        idempotencyKey: `${USAGE_IDEMPOTENCY_KEY_PREFIX}${input.eventId}`,
        maximumCents: Number(modelPolicy.maximumReservationUnits),
        expiresAt: new Date(
          input.occurredAt.getTime() + MODEL_RESERVATION_WINDOW_MS,
        ),
      });
    } catch (error) {
      log.error(
        {
          type: "billing-credit-gate-failed",
          eventId: input.eventId,
          model: modelId,
          name: (error as Error | null)?.name,
        },
        "billing-credit-gate-failed",
      );
      throw new CreditGateFailureError();
    }
    if (!reservation.reserved) {
      /*
       * The hold is the WORST-CASE ceiling (config.ts derives it from the configured token maxima),
       * so this refusal has two very different causes and the log is the only place they are
       * distinguishable: a balance that is genuinely empty, and a balance that is fine but smaller
       * than one call's maximum (decision gate G3). `available` and `required` in scaled units.
       */
      log.warn(
        {
          type: "billing-credit-reservation-refused",
          eventId: input.eventId,
          model: modelId,
          available: reservation.availableCents,
          required: Number(modelPolicy.maximumReservationUnits),
        },
        "billing-credit-reservation-refused",
      );
      throw new CreditGateError();
    }

    return {
      /*
       * The provider-bound contract, as it stands for the adapters this deployment actually
       * invokes. The built-in instance path is the OpenAI-compatible chat model: it maps
       * maxOutputTokens to max_tokens, which the chat-completions contract enforces, so the
       * output cap is proven. Its input side has no provider-enforced ceiling, so the bound
       * is the deployment's own (ADR-0001): a conservative bytes-based count that sits above
       * a typical tokenizer, and a fit that drops the oldest non-system messages until the
       * count fits the configured ceiling — the provider cannot be SENT more than the
       * reservation prices by our own measure, and a tokenizer that beats the calibration
       * surfaces at settlement as usage_over_bound: the stream fails, the hold is retained,
       * and billing/usage-evidence.ts keeps the provider's real token counts — the credits
       * target blocks the row in manual review (`missing_reservation`) while the Lago
       * target still meters the tokens the provider did report.
       * （G2 未决：Spec「Billed admission per surface」仍写 input_bound_unsupported，与 ADR-0001 的 counted+截断冲突，待回写。2026-10-15。）
       */
      bounds: {
        input: {
          enforced: "counted" as const,
          maximumTokens: modelPolicy.input.maximumTokens,
          countInputTokens: countChatInputTokens,
          fit: fitChatInputRequest(modelPolicy.input.maximumTokens),
        },
        output: {
          enforced: "provider_cap" as const,
          maximumTokens: modelPolicy.output.maximumTokens,
        },
      },
      finish: async (usage) => {
        /*
         * The decisive boundary: a successful finish means the immutable usage fact is
         * COMMITTED to the outbox (or an identical event already exists). Any failure —
         * invalid or over-bound usage, or a rejected write — is logged with both stable ids
         * and rethrown as a credential-free settlement error, so the stream the person sees
         * fails rather than reporting a successful answer whose usage vanished. The hold
         * stays `reserved`: chargeable work is never released by a failed write, and
         * reconciliation is what investigates it.
         */
        let charged: ReturnType<typeof calculateExactModelUsageCharge>;
        try {
          charged = calculateExactModelUsageCharge(modelPolicy, {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
          });
        } catch (error) {
          // Pricing refused the settlement — a distinct stage from the outbox write, so it
          // gets its own event and never the write-failure code a foreign error would
          // otherwise fall back to. The hold is retained either way.
          const code =
            error instanceof UsageChargeError ? error.code : "usage_charge_failed";
          log.error(
            {
              type: "billing-usage-charge-refused",
              source: "llm",
              eventId: input.eventId,
              reservationId: reservation.reservationId,
              ...(error instanceof Error ? { name: error.name } : {}),
              code,
            },
            "billing-usage-charge-refused",
          );
          // Audit A3: the tokens are real work this deployment will not price — a durable
          // evidence row (no reservation facts, hold retained) instead of numbers that die
          // with the stream error. The settlement-failure exit in copilot.ts may record the
          // same event again with zero tokens; the outbox keeps these real facts and logs the
          // second write as superseded.
          await recordUnsettledUsage({
            eventId: input.eventId,
            source: "llm",
            externalCustomerId: billing.externalCustomerKey,
            model: modelId,
            client: input.client,
            occurredAt: input.occurredAt,
            inputTokens: usage.inputTokens ?? 0,
            outputTokens: usage.outputTokens ?? 0,
            reason: code,
          });
          throw new ModelUsageSettlementError(code);
        }
        try {
          await usageOutbox.record({
            eventId: input.eventId,
            source: "llm",
            externalCustomerId: billing.externalCustomerKey,
            transactionId: input.eventId,
            inputTokens: charged.inputTokens,
            outputTokens: charged.outputTokens,
            model: modelId,
            client: input.client,
            occurredAt: input.occurredAt,
            reservationId: reservation.reservationId,
            actualCostNumerator: charged.actual.numerator.toString(),
            actualCostDenominator: charged.actual.denominator.toString(),
          });
        } catch (error) {
          const failureCode = usageOutboxWriteFailureCode(error);
          logUsageOutboxWriteFailure(
            "llm",
            input.eventId,
            error,
            reservation.reservationId,
            failureCode,
          );
          throw new ModelUsageSettlementError(failureCode);
        }
      },
      recordUnsettled: async (unsettled) => {
        await recordUnsettledUsage({
          eventId: unsettled.eventId,
          source: "llm",
          externalCustomerId: billing.externalCustomerKey,
          model: modelId,
          client: input.client,
          occurredAt: unsettled.occurredAt,
          inputTokens: unsettled.inputTokens,
          outputTokens: unsettled.outputTokens,
          reason: unsettled.reason,
        });
      },
      fail: async (failure) => {
        /*
         * Release only on a CONFIRMED no-cost (audit A2 / CONTEXT.md Pending Settlement /
         * ADR-0003): the provider refused before any token (`provider_error`), admission refused
         * before the provider (`bound_refused`), or the provider reported zero usage (`no_usage`).
         * Everything else is an unknown outcome — `usage_missing`, `stream_error`, `cancelled`:
         * the provider may have produced billable work we never learned about. Those keep the
         * hold (it expires on its own clock and reconciliation reports it) and leave a durable
         * evidence row naming the event, the reason, and whatever token counts the stream had
         * learned by the time it failed.
         */
        if (isConfirmedNoCost(failure.reason)) {
          try {
            await billing.creditWriter.releaseReservation(
              reservation.reservationId,
              failure.reason,
            );
          } catch (error) {
            logReservationReleaseFailure({
              source: "llm",
              eventId: input.eventId,
              reservationId: reservation.reservationId,
              reason: failure.reason,
              error,
            });
          }
          return;
        }
        await recordUnsettledUsage({
          eventId: input.eventId,
          source: "llm",
          externalCustomerId: billing.externalCustomerKey,
          model: modelId,
          client: input.client,
          occurredAt: input.occurredAt,
          inputTokens: failure.inputTokens ?? 0,
          outputTokens: failure.outputTokens ?? 0,
          reason: failure.reason,
        });
      },
    };
  });
} else {
  setModelUsageGate(undefined);
}

/*
 * The billing sweepers' stop handles (audit C3): both assemble only when their seam exists, and
 * both are stopped in the SIGINT/SIGTERM handler below so a shutdown cannot land mid-batch. The
 * locks make each sweeper single-instance across replicas — advisory-lock keys 4_192_005 (usage
 * delivery) and 4_192_006 (payments), reserved alongside audit-retention's 4_192_004.
 */
const billingSweepStops: (() => void)[] = [];

if (billing !== undefined && usageOutbox !== undefined) {
  const usageDelivery = createUsageDelivery({
    outbox: usageOutbox,
    sendToLago: createLagoUsageTarget(billing.service),
    chargeCredits: createCreditUsageTarget(billing.creditWriter),
    log: (message) => log.warn(message),
  });
  const usageSweeps = startUsageDeliverySweeps(usageDelivery, {
    log: (message) => log.warn(message),
    lock: { databaseUrl: config.databaseUrl, key: 4_192_005 },
  });
  billingSweepStops.push(usageSweeps.stop);
}

/*
 * The payment channels, assembled only when a channel was configured — which config.ts further
 * conditions on billing being configured, so a channel here always has its projection below it.
 *
 * One fail-fast per channel gateway, the same boundary the billing block above uses: a gateway
 * URL the outbound policy refuses is a deployment wired wrong, and it stops the process with the
 * variable named rather than surfacing as a 503 on the first purchase. The guard built from the
 * same verdict then rides on every channel request the adapters make.
 */
const paymentSettings = config.payments;
const payments =
  billing === undefined || paymentSettings === undefined
    ? undefined
    : await (async () => {
        const settings = paymentSettings;
        for (const [label, gatewayUrl] of [
          ...(settings.alipay
            ? ([["ALIPAY_GATEWAY_URL", settings.alipay.gatewayUrl]] as const)
            : []),
          ...(settings.wechat
            ? ([["WXPAY_GATEWAY_URL", settings.wechat.gatewayUrl]] as const)
            : []),
        ] as const) {
          const verdict = await checkOutboundUrl(gatewayUrl, {
            allowPrivate: settings.allowPrivateHosts,
          });
          if (!verdict.allowed) {
            throw new Error(
              `${label} was refused by the outbound policy: ${verdict.reason}`,
            );
          }
        }

        const channelGuard = createOutboundGuard({
          allowPrivate: settings.allowPrivateHosts,
        });
        const providers = new Map();
        if (settings.alipay) {
          providers.set(
            "alipay",
            createAlipayProvider({
              appId: settings.alipay.appId,
              privateKeyPem: settings.alipay.privateKeyPem,
              alipayPublicKeyPem: settings.alipay.alipayPublicKeyPem,
              gatewayUrl: settings.alipay.gatewayUrl,
              assertTarget: channelGuard,
            }),
          );
        }
        if (settings.wechat) {
          providers.set(
            "wechat",
            createWechatProvider({
              mchid: settings.wechat.mchid,
              appid: settings.wechat.appid,
              apiv3Key: settings.wechat.apiv3Key,
              merchantSerialNo: settings.wechat.merchantSerialNo,
              merchantPrivateKeyPem: settings.wechat.merchantPrivateKeyPem,
              platformCertificates: settings.wechat.platformCertificates,
              gatewayUrl: settings.wechat.gatewayUrl,
              skewSeconds: settings.callbackSkewSeconds,
              assertTarget: channelGuard,
            }),
          );
        }

        const externalCustomerKey = billing.externalCustomerKey;
        const paymentOrderStore = createPaymentStore(database);
        const paymentService = createPaymentService({
          providers,
          store: paymentOrderStore,
          catalog: settings.planCatalog,
          notifyBaseUrl: settings.notifyBaseUrl,
          orderTtlMinutes: settings.orderTtlMinutes,
          latePaymentWindowHours: settings.latePaymentWindowHours,
          acceptForeignCurrency: settings.acceptForeignCurrency,
          lago: {
            getPlan: async (planCode) => {
              const result = await billing.client.getPlan(planCode);
              if (result.status === 200 && result.body) {
                return {
                  found: true,
                  interval: result.body.interval,
                  currency: result.body.currency ?? undefined,
                };
              }
              return { found: false };
            },
            ensureSubscription: async (input) => {
              return billing.service.ensureSubscription(input);
            },
          },
          externalCustomerKey,
          activePlanCode: async () => {
            const entitlements = await billing.service.entitlements();
            return entitlements.active && entitlements.planCode
              ? entitlements.planCode
              : null;
          },
          invalidateEntitlementCache: () => {
            billing.service.invalidateEntitlementCache();
          },
          /*
           * The plan allowance's payout, built from the credit writer above and the catalog the
           * billing block parsed. `readCurrentPeriodEnd` goes through the SAME courtesy read the
           * entitlement answer rides (the subscription read beside the projection), so the grant's
           * expiry and the page's "下次权益周期更新" can never disagree about which period is running.
           */
          grantor: {
            creditsFor: (planCode) => {
              const entry = billingSettings?.planCatalog.get(planCode);
              // Whole credits in the catalog → scaled units (×100) in the ledger; null when the
              // plan is absent or grants none — the service treats that as "skip", not an error.
              return entry && entry.credits > 0
                ? Math.round(entry.credits * CREDIT_SCALE)
                : null;
            },
            grantPlanCredits: async (input) => {
              // The payment service only calls this with a non-null expiry (its own fallback
              // chain decided the period), so the seam's `Date | null` lands here as a Date.
              if (input.expiresAt === null) return { inserted: false };
              const result = await billing.creditWriter.grantCredits({
                externalCustomerId: input.externalCustomerId,
                source: "plan",
                totalCents: input.totalCents,
                expiresAt: input.expiresAt,
                reason: `plan allowance · ${input.planCode} · order ${input.orderId}`,
                // THE retry answer: one order buys one allowance, however many times its
                // activation is retried by the sweep, a replayed callback or a re-opened page.
                idempotencyKey: `plan:${input.orderId}`,
              });
              return { inserted: result.inserted };
            },
            readCurrentPeriodEnd: async (planCode) => {
              const entitlements = await billing.service.entitlements();
              const end = entitlements.subscription?.currentPeriodEnd ?? null;
              // The cache can lag the activation by one read (this grant runs BEFORE the
              // entitlement invalidation below), so the period answer is trusted only when the
              // projection already names this plan; otherwise the order's own period end answers.
              return entitlements.active &&
                entitlements.planCode === planCode &&
                end
                ? new Date(end)
                : null;
            },
          },
          // The purchase guard's UNCACHED fact (P1-5): read the local subscription projection
          // directly — one indexed query per purchase attempt — instead of the 10-minute TTL
          // cache whose failure fallback answers "not active". The projection is what the sync
          // and the webhooks both maintain; "live" matches the entitlement read's own
          // definition (active/incomplete).
          activePlanCodeUncached: async () => {
            const rows = await createBillingStore(database).readSubscriptions(
              billing.externalCustomerKey,
            );
            const live = rows.find(
              (row) => row.status === "active" || row.status === "incomplete",
            );
            return live ? live.planCode : null;
          },
        });
        const paymentSweeps = startPaymentSweeps(paymentService, {
          lock: { databaseUrl: config.databaseUrl, key: 4_192_006 },
        });
        billingSweepStops.push(paymentSweeps.stop);
        return {
          service: paymentService,
          // The statement read's other half: a bill is a stored order, so the ledger is the only
          // source that can answer it.
          store: paymentOrderStore,
          activePlanCode: async () => {
            const entitlements = await billing.service.entitlements();
            return entitlements.active && entitlements.planCode
              ? entitlements.planCode
              : null;
          },
        };
      })();

/*
 * The statement reads: 套餐用量 and the bill list.
 *
 * Built from whichever halves this deployment has, because the two answers draw on different
 * things — the plan-usage read needs the provider's reader plus this deployment's configured
 * ceilings, the bill list needs the local payment ledger. Billing configured without channels
 * answers plan usage and an empty bill list; neither half is missing-by-error, so a person with
 * no bills sees an empty page rather than a failure.
 */
const statements =
  billing === undefined
    ? undefined
    : createBillingStatements({
        service: billing.service,
        quotas: billingSettings?.planQuotas ?? new Map(),
        ...(payments ? { orders: payments.store } : {}),
      });

/*
 * The credit-ledger reads: 套餐与积分. Local only — the ledger lives in this deployment's own
 * database, so the read needs the shared `database` and the same customer key the billing block
 * derived, and nothing from the provider. (The WRITE side lives on the billing block above —
 * `billing.creditWriter` — because both its callers, the plan payout and the admin grant route,
 * are billing surfaces.)
 */
const credits =
  billing === undefined
    ? undefined
    : createCredits({
        database,
        externalCustomerKey: billing.externalCustomerKey,
        catalog: billingSettings?.planCatalog ?? new Map(),
      });

/*
 * The code sandbox behind run_code: a client per Bot to the agent-sandbox container, one writer
 * for the code_runs table, and the per-call factory the routes build their gateway through. Unset
 * AGENT_SANDBOX_URL (or its token) leaves the client null — the surface still mounts, and every
 * run lands a refused code_runs row beside its audit event rather than a 404 the caller cannot
 * tell apart from a missing deployment. The client is created inside the factory rather than
 * shared, because each one carries the Bot's id as the `x-openbot-bot-id` header the proxy routes
 * on: one Bot, one workspace. The run budget is the caller's timeoutSeconds, clamped to 1-600
 * seconds with a 120-second default in the gateway itself.
 */
const sandboxUrl = process.env.AGENT_SANDBOX_URL?.trim();
const sandboxToken = process.env.SANDBOX_TOKEN?.trim();
const codeRunBillingEnabled = billing !== undefined;
const codeRunStore = createCodeRunStore(database);
/*
 * Metering's one door (I4): every gateway finish that carries usage reports to Lago through
 * this hook. The run id is the transaction id — the provider deduplicates on it, so a replayed
 * settle is one event, and `code_runs` stays the single source of truth (the workshop's usage
 * column is a display copy and is never read here). A deployment without billing passes
 * `billing === undefined` straight through: silent, and the run row still stands.
 */
const codeRunUsageReporter = billing && usageOutbox
  ? async (input: import("./workshop/metering").CodeRunUsageInput): Promise<void> => {
      try {
        await reportCodeRunUsage(
          usageOutbox,
          {
            ...input,
            externalCustomerId: billing.externalCustomerKey,
            // True only when the hard-cap policy actually prices code runs; the gateway refuses
            // billed runs until the sandbox can enforce a budget, so this stays false today and
            // the guard inside reportCodeRunUsage is what makes flipping it safe.
            creditMeteringEnabled: billingSettings?.creditPolicy.configured === true,
          },
          (message) => log.warn(message),
        );
      } catch (error) {
        logUsageOutboxWriteFailure("code_run", `code-run:${input.runId}`, error);
      }
    }
  : undefined;
const sandboxClientFor = (botId: string) =>
  sandboxUrl && sandboxToken
    ? createSandboxClient({
        baseUrl: sandboxUrl,
        token: sandboxToken,
        botId,
      })
    : null;
const codeRunGatewayFactory: CodeRunGatewayFactory = ({ botId, ownerUserId }) =>
  createCodeRunGateway({
    client: sandboxClientFor(botId),
    billingEnabled: codeRunBillingEnabled,
    modelId: runtimeModel.defaultModel,
    botId,
    ownerUserId,
    initiator: PERSON_INITIATOR,
    store: codeRunStore,
    auditStore: bootAuditStore,
    ...(codeRunUsageReporter ? { onUsage: codeRunUsageReporter } : {}),
  });

/*
 * The workshop module, assembled in one place because its wiring is one decision: whether the
 * turn lock and the event fan-out ride Redis or stay in-process. createRedisPort answers it —
 * null when OPENBOT_REDIS_URL is unset (single-replica: an in-process lock and a polling bus,
 * deliberate, never silent) and a startup throw when WORKSHOP_REQUIRE_REDIS=1 asked for hard
 * Redis and did not get it (multi-replica: refusing to boot is the only safe answer, because
 * the in-process lock would let two replicas run the same turn). The gateway factory gains the
 * artifact hook here too, wiring B4's gallery pipeline into every workshop-driven run.
 */
const workshopRedisPort = createRedisPort({
  OPENBOT_REDIS_URL: process.env.OPENBOT_REDIS_URL,
  WORKSHOP_REQUIRE_REDIS: process.env.WORKSHOP_REQUIRE_REDIS,
});
const workshopStore = createWorkshopStore(database);
const workshopBus = createTurnEventBus(workshopRedisPort, {
  reader: workshopStore,
});
const workshopLock = workshopRedisPort
  ? createRedisTurnLock(workshopRedisPort, {
      ttlMs: Number(process.env.WORKSHOP_LOCK_TTL_MS?.trim() || 30_000),
    })
  : createInProcessTurnLock();
const workshopClientFor = (botId: string) => sandboxClientFor(botId);

const workshopOrchestrator = createTurnOrchestrator({
  store: workshopStore,
  lock: workshopLock,
  gatewayFor: ({ botId, ownerUserId }) =>
    createCodeRunGateway({
      client: workshopClientFor(botId),
      billingEnabled: codeRunBillingEnabled,
      modelId: runtimeModel.defaultModel,
      botId,
      ownerUserId,
      initiator: PERSON_INITIATOR,
      store: codeRunStore,
      auditStore: bootAuditStore,
      ...(codeRunUsageReporter ? { onUsage: codeRunUsageReporter } : {}),
    }),
  auditStore: bootAuditStore,
  // The Bot's sandbox client for the before/after workspace diff that feeds the gallery.
  clientFor: workshopClientFor,
  // B4's gallery pipeline, on the streaming path: after the turn's stream ends, the new
  // files (a before/after listFiles diff) land in the session's workshop_artifacts rows.
  // Contained here like the gateway's own hook — a gallery miss never fails a turn.
  indexArtifactsFor: async ({ sessionId, artifacts }) => {
    await indexArtifacts(workshopStore, sessionId, artifacts);
  },
});
/**
 * The ONE share service: the owner routes (mint/revoke behind canUseBot) and the anonymous
 * public routes (resolve/preview by token) are the same service's two faces, so they share one
 * instance — one limiter budget, one signing key, one place the token mint lives. The limiter
 * degrades in-process (Redis is the multi-replica shape, per sharing.ts), and the signing key
 * derives from the deployment's key-encryption key — a dedicated WORKSHOP_SHARE_SIGNING_KEY is
 * the cleaner long home, noted for the day it earns its own rotation story.
 */
const workshopSharing = createShareService({
  store: workshopStore,
  signingKey: `workshop-share:${config.keyEncryptionKey}`,
  limiter: createInProcessShareLimiter(),
});
/**
 * The workshop's ANONYMOUS half (B14/F9/B15b): the share routes, one factory like their
 * owner sibling. The sharing service rides the same workshopStore (the session row IS the
 * share row).
 */
const publicWorkshopRoutes = () => {
  return createWorkshopPublicRoutes({
    sharing: {
      resolveShareActor: workshopSharing.resolveShareActor,
      underRateLimit: workshopSharing.underRateLimit,
      signArtifactUrl: workshopSharing.signArtifactUrl,
    },
    listArtifacts: async (channelId) => {
      const session = await workshopStore.sessionByChannel(channelId);
      if (!session) return [];
      const rows = await workshopStore.listArtifacts(session.id);
      return rows.map((row) => ({
        id: row.id,
        name: row.name,
        type: row.type,
        sizeBytes: row.sizeBytes,
      }));
    },
    readArtifactFile: async (targetChannelId, artifactPath) => {
      // The static preview road reads the session's artifact bytes — the same reader the
      // owner's download route uses, reached anonymously through a token instead.
      const session = await workshopStore.sessionByChannel(targetChannelId);
      if (!session) return null;
      const rows = await workshopStore.listArtifacts(session.id);
      const artifact = rows.find(
        (row) => row.path === artifactPath || row.name === artifactPath,
      );
      if (!artifact) return null;
      const client = workshopClientFor(session.botId);
      if (!client) return null;
      const read = await client
        .readFile(artifact.path, 2_000_000)
        .catch(() => null);
      return read === null
        ? null
        : {
            bytes: new TextEncoder().encode(read.content),
            contentType: "application/octet-stream",
          };
    },
  });
};

const workshopRoutes: WorkshopRoutesFactory = ({ requireUser, canUseBot }) =>
  createWorkshopRoutes({
    requireUser,
    canUseBot,
    deps: {
      store: workshopStore,
      bus: workshopBus,
      orchestrator: workshopOrchestrator,
      clientFor: workshopClientFor,
      // The owner-side mint/revoke endpoints (F8's panel) ride the same single share service
      // the anonymous public routes read from — one budget, one key, two gated faces.
      sharing: workshopSharing,
    },
  });

/*
 * Craft: the autonomous-build surface, assembled beside the workshop for the same reason —
 * its wiring is one boot decision. The config answers the deployment's three questions in
 * one place (enabled, which Bot's sandbox, and the opencode-serve topology: native onyx
 * pods speak /event + prompt_async + absolute session dirs, the agent-sandbox gateway
 * speaks /events + /message + Bot-relative dirs). When AGENT_SANDBOX_URL points the
 * deployment at agent-sandbox, the assembly applies that gateway's topology itself below
 * (the OPENBOT_CRAFT_* variables remain the operator's explicit override of any leg).
 *
 * The LLM seam is the runtime model the rest of this process already answers on
 * (runtimeModel + resolveRuntimeModelApiKey), re-expressed as craft's provider catalog: one
 * OpenAI-compatible gateway provider whose catalog is the single default model. apiBase
 * falls back to the provider's public endpoint when the deployment set no gateway URL —
 * opencode needs SOME base URL, and the public one is the only honest default.
 */
const craftConfig = loadCraftConfig(process.env);
/*
 * The topology half of the wiring: behind the agent-sandbox gateway (AGENT_SANDBOX_URL
 * set), the opencode-serve surface is the gateway's, not a native pod's — /events (family-
 * filtered SSE), /message (the one prompt verb the allowlist carries), Bot-relative session
 * directories (its file API refuses absolute paths). The OPENBOT_CRAFT_* topology variables
 * are the operator's override for a future gateway that changes one of these; unset, the
 * assembly applies the agent-sandbox shape itself so a working deployment is the default,
 * not a configuration checklist.
 */
const craftTopoEnv: Record<string, string | undefined> = {
  OPENBOT_CRAFT_OPENCODE_EVENT_PATH: "/events",
  OPENBOT_CRAFT_OPENCODE_PROMPT_ENDPOINT: "message",
  OPENBOT_CRAFT_SESSION_DIRECTORY_MODE: "bot-relative",
};
const craftEffectiveConfig = sandboxUrl
  ? loadCraftConfig({
      ...process.env,
      ...Object.fromEntries(
        Object.entries(craftTopoEnv).map(([name, value]) => [
          name,
          process.env[name]?.trim() ? process.env[name] : value,
        ]),
      ),
    })
  : craftConfig;
/*
 * Craft's managed content (AGENTS.md app guidance + skill fileset + fingerprints), answered
 * for the session's user — never the deployment-wide Bot id. Both live legs resolve below:
 * the connectable-apps list (personal servers not yet connected) and the per-user craft MCP
 * set (the personal servers that ARE connected, each entry stamped with the relay url), so
 * mcp_config_hash fingerprints the resolved set. The one leg still absent is the
 * company-search skill: OpenBot's knowledge domain has no path the craft sandbox can call
 * (credentials stay out of agent-readable workspace files), so no such file ships and the
 * AGENTS.md Company-knowledge section stays out until a backed implementation lands.
 */
/*
 * The relay origin the per-user MCP set stamps into session opencode.json: the
 * operator's explicit override first, then the deployment's public url (the
 * same address deliveryProviders resolve against), then the loopback default —
 * the sandbox's opencode dials this and the relay attaches credentials, so it
 * must be an address that deployment's sandboxes can reach.
 */
const craftMcpRelayBaseUrl =
  craftEffectiveConfig.mcpRelayBaseUrl ||
  config.publicUrl ||
  config.auth?.baseUrl ||
  `http://localhost:${config.port}`;
/*
 * The craft company-search leg (D1): the knowledge domain over the same
 * service-to-service credential the knowledge routes use. The sources section
 * lists the deployment's knowledge bases (the KB domain is deployment-tenant);
 * the search fans out per KB, merges, and projects onyx-cli's result contract.
 * An unwired knowledge service holds the skill back entirely (null) — the
 * AGENTS.md Company-knowledge section stays out with it.
 */
const craftKnowledgeBases = async (): Promise<
  Array<{ id: string; name: string; description: string | null }> | null
> => {
  if (!knowledgeService) return null;
  try {
    const response = await knowledgeRequest(knowledgeService, "/kb");
    const body = (await response.json()) as {
      items?: Array<{
        id: string;
        name: string;
        description?: string | null;
      }>;
    };
    return (body.items ?? []).map((kb) => ({
      id: kb.id,
      name: kb.name,
      description: kb.description ?? null,
    }));
  } catch {
    return null;
  }
};
const craftCompanySearchSourcesSection = async (): Promise<string | null> => {
  const kbs = await craftKnowledgeBases();
  return kbs === null ? null : buildAvailableSourcesSection(kbs);
};
const craftKbSearch: CraftKbSearch | null = knowledgeService
  ? async ({ query, sourceTypes, days }) => {
      const kbs = (await craftKnowledgeBases()) ?? [];
      if (kbs.length === 0) return { status: "ok", results: [] };
      const settled = await Promise.allSettled(
        kbs.map((kb) =>
          knowledgeRequest(
            knowledgeService!,
            `/kb/${encodeURIComponent(kb.id)}/retrieve`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                query,
                top_k: 20,
                score_threshold: 0,
                hybrid: true,
              }),
            },
          ).then(
            (response) =>
              response.json() as Promise<{
                results: KnowledgeSearchResult[];
              }>,
          ),
        ),
      );
      // A KB domain that answers nothing at all is "unavailable" (the relay's
      // 503 shape); per-KB failures degrade to that KB contributing nothing.
      const perKb = settled.flatMap((entry) =>
        entry.status === "fulfilled" ? entry.value.results : [],
      );
      if (
        perKb.length === 0 &&
        settled.every((entry) => entry.status === "rejected")
      ) {
        return { status: "unavailable" };
      }
      return {
        status: "ok",
        results: projectKbSearchResults(perKb, { days, sourceTypes }),
      };
    }
  : null;
const craftManagedContentFor = createCraftManagedContentResolver({
  connectableAppsFor: async (userId) => {
    const [servers, held, brokered] = await Promise.all([
      pluginStore.listServers(),
      pluginStore.connectionsFor(userId),
      pluginStore.brokeredConnectionsFor(userId),
    ]);
    return personalUnconnectedApps(
      servers,
      new Set([
        ...held.map((row) => row.serverId),
        ...brokered.map((row) => row.serverId),
      ]),
    );
  },
  /*
   * The builtin skills (onyx's $ONYX/skills/builtin): pptx and
   * craft-documentation ship to everyone; a connector skill ships only when
   * the user has connected the matching MCP server (onyx's
   * connected-apps-only rule) — the personal connection set above is the same
   * fact the connectable list inverts. company-search ships when the
   * knowledge domain backs it, its sources section rendering the deployment's
   * knowledge bases (onyx renders the user's connector sources; OpenBot's KB
   * domain is deployment-tenant — the ruled D1 shape).
   */
  skillFilesFor: async (userId) => {
    const [held, brokered, sourcesSection] = await Promise.all([
      pluginStore.connectionsFor(userId),
      pluginStore.brokeredConnectionsFor(userId),
      craftCompanySearchSourcesSection(),
    ]);
    return builtinSkillFilesFor({
      connectedServerIds: new Set([
        ...held.map((row) => row.serverId),
        ...brokered.map((row) => row.serverId),
      ]),
      ...(sourcesSection !== null ? { companySearchSourcesSection: sourcesSection } : {}),
    });
  },
  /*
   * The per-user craft MCP set (the contract's C3 ruling): personal-account
   * servers the user HAS connected — the same connection fact the connectable
   * list inverts. Each entry's url is the RELAY route, never the vendor
   * endpoint: the credential attaches on the server side (mcp-relay.ts), so
   * none can enter a workspace file. Unconnected servers are dropped entirely,
   * onyx's unauthenticated-drop, because the relay would refuse their calls.
   */
  mcpServersFor: async (userId) => {
    const [wireServers, held, brokered] = await Promise.all([
      pluginStore.mcpWireServersFor(),
      pluginStore.connectionsFor(userId),
      pluginStore.brokeredConnectionsFor(userId),
    ]);
    return resolveCraftMcpServers({
      servers: wireServers.map((server) => ({
        id: server.id,
        name: server.title,
      })),
      connectedServerIds: new Set([
        ...held.map((row) => row.serverId),
        ...brokered.map((row) => row.serverId),
      ]),
      relayBaseUrl: craftMcpRelayBaseUrl,
    });
  },
});
const craftRoutes: CraftRoutesFactory | undefined = craftEffectiveConfig.enabled
  ? ({ requireUser }) =>
      createCraftRoutes({
        requireUser,
        deps: {
          config: craftEffectiveConfig,
          db: database,
          // Same port the workshop's locks and bus answer on: Redis when configured,
          // the in-process fallback when not — craft's turn state carries both shapes.
          redis: workshopRedisPort,
          // Craft's decision surface reads/writes the raw approval store (not the
          // coordination-wrapped approvalService.store) so opening/deciding never runs
          // run-orchestration side effects.
          approvals: storedApprovals,
          // craft_sessions rows hold no Bot relationship; every session routes to the
          // one deployment-chosen Bot workspace (validated to agent-sandbox's id rules
          // inside loadCraftConfig — an unusable configured id already fell back).
          botIdFor: async () => craftEffectiveConfig.sandboxBotId,
          llmConfigFor: async () => craftLlmConfig(),
          sandboxConnectionFor: () =>
            sandboxUrl && sandboxToken
              ? { baseUrl: sandboxUrl, token: sandboxToken }
              : null,
          userNameFor: async (userId) =>
            (await peopleStore.find(userId))?.name ?? null,
          generateName: craftGenerateName,
          // The managed-content layer over the plugins domain: connectable apps are
          // the enabled connector rows that act in the person's own account and that
          // they have NOT connected yet (onyx's get_connectable_apps_for_user —
          // shared/deployment-account apps answer for everybody and never appear).
          managedContentFor: craftManagedContentFor,
          // The relay's credential resolution: the plugins domain's own
          // per-person connection handling (MCP-wire servers only), decrypted
          // per forwarded call and never written anywhere the agent reads.
          mcpConnectionFor: (userId, serverId) =>
            pluginStore.mcpWireConnectionFor(userId, serverId),
          kbSearch: craftKbSearch,
          mcpRelayBaseUrl: craftMcpRelayBaseUrl,
        },
      })
  : undefined;

/*
 * The craft webapp's HMR websocket proxy (onyx webapp_proxy.py:387-398). An upgrade is not a
 * request/response, so this half terminates in the boot file's upgrade dispatcher beside the
 * computer-stream proxy — but it resolves through the SAME facts the HTTP webapp proxy uses
 * (the deployment's sandbox Bot, its gateway connection, the session's reserved port), so the
 * two surfaces can never route the same session to different upstreams.
 */
const craftWebappHmrDeps =
  craftEffectiveConfig.enabled && craftEffectiveConfig.webappProxyEnabled
    ? {
        config: craftEffectiveConfig,
        store: createCraftStore(database),
        botIdFor: async () => craftEffectiveConfig.sandboxBotId,
        sandboxConnectionFor: () =>
          sandboxUrl && sandboxToken
            ? { baseUrl: sandboxUrl, token: sandboxToken }
            : null,
      }
    : undefined;

/**
 * The craft model catalog as one descriptor. The limits are honest defaults rather than
 * per-model facts: OpenBot's runtime model is a wire id, not a models.dev entry, so the
 * catalog cannot know the real context window — a generous fixed pair keeps opencode's
 * compaction arithmetic from collapsing (see opencode-config.ts's limit comment) and is
 * corrected the day a per-model lookup exists.
 */
function craftModelDescriptor(modelId: string): CraftModelDescriptor {
  return {
    id: modelId,
    displayName: modelId,
    maxInputTokens: 200_000,
    maxOutputTokens: 32_000,
    inputModalities: ["text", "image"],
    outputModalities: ["text"],
    supportsReasoning: true,
    supportsToolCalls: true,
    supportsTemperature: true,
    supportsInterleavedReasoning: false,
  };
}

/** The single-model provider config a craft session's opencode.json is built from. */
async function craftLlmConfig(): Promise<CraftLLMProviderConfig> {
  const anthropic = runtimeModel.provider === "anthropic";
  // The gateway URL the rest of this process already uses; the provider's public
  // endpoint when none is set (opencode requires a base URL — absent is not an answer
  // it accepts, and the public API is the only neutral default).
  const apiBase =
    (anthropic
      ? process.env.ANTHROPIC_BASE_URL?.trim()
      : process.env.OPENAI_BASE_URL?.trim()) ||
    (anthropic ? "https://api.anthropic.com/v1" : "https://api.openai.com/v1");
  return {
    provider: "openbot",
    modelName: runtimeModel.defaultModel,
    apiKey: await resolveRuntimeModelApiKey(),
    apiBase,
    displayName: "OpenBot",
    models: [craftModelDescriptor(runtimeModel.defaultModel)],
  };
}

/**
 * The naming seam: one-shot system+user generation on the deployment's own model. NOT
 * createModelCompleter — that helper is single-prompt and force-enables
 * response_format:{type:"json_object"}, both wrong for a naming call whose prompt asks
 * for bare prose. Instead the two endpoint dialects are spoken directly (OpenAI
 * chat/completions with a system message; Anthropic messages with a system block), on the
 * base URLs normalizeModelBaseUrls() already normalized. Throws on failure — craft's
 * naming path catches and falls back deterministically, so the throw is the contract.
 */
async function craftGenerateName(
  system: string,
  user: string,
): Promise<string> {
  const key = await resolveRuntimeModelApiKey();
  if (!key) throw new Error("no model key");
  const anthropic = runtimeModel.provider === "anthropic";
  // normalizeModelBaseUrls() (above) has already normalized the provider's base URL —
  // including the /v1 segment chatCompletionsUrl/anthropicMessagesUrl would otherwise add —
  // so the version-aware helpers are reused for the one case it does NOT touch: the
  // unset-variable fallback to the provider's public endpoint.
  const url = anthropic
    ? anthropicMessagesUrl(process.env)
    : chatCompletionsUrl(process.env);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(anthropic
        ? { "x-api-key": key, "anthropic-version": "2023-06-01" }
        : { authorization: `Bearer ${key}` }),
    },
    // No response_format, no temperature: the naming prompt asks for a bare short
    // string, and reasoning models refuse temperature anyway.
    body: JSON.stringify(
      anthropic
        ? {
            model: runtimeModel.defaultModel,
            max_tokens: 200,
            system,
            messages: [{ role: "user", content: user }],
          }
        : {
            model: runtimeModel.defaultModel,
            messages: [
              { role: "system", content: system },
              { role: "user", content: user },
            ],
          },
    ),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`naming model answered ${response.status}`);
  const body = (await response.json()) as {
    choices?: { message?: { content?: unknown } }[];
    content?: { type?: string; text?: unknown }[];
  };
  const content = anthropic
    ? body.content
        ?.filter(
          (block) => block.type === "text" && typeof block.text === "string",
        )
        .map((block) => block.text)
        .join("") || undefined
    : body.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content)
    throw new Error("naming model returned no text");
  return content;
}

/*
 * The OpenMuse Gmail consent seam (G01). The vendor dial is built from the
 * deployment's OpenConnector address; a base that cannot be dialled logs and
 * leaves the dial unset, which the connect route answers 503 — a boot must
 * not die over a connector, but neither must it pretend to reach one.
 */
const openMuseGoogleClient = (() => {
  try {
    return createOpenConnectorOAuthClient({
      url: config.openConnectorUrl,
    });
  } catch (error) {
    log.error(
      {
        type: "openmuse-google-vendor-refused",
        error: error instanceof Error ? error.message : String(error),
      },
      "openmuse-google-vendor-refused",
    );
    return undefined;
  }
})();
// Hoisted: the Mail and Calendar surfaces read the same deleted-owner fence
// (D01's marker, via the connectors rows) that the OAuth service itself does,
// so a disabled owner's reads stop before any vendor dial on every surface.
const openMuseGoogleRows = createOpenMuseGoogleRows(database);
const openMuseGoogleService = createOpenMuseGoogleOAuth({
  ...(openMuseGoogleClient ? { client: openMuseGoogleClient } : {}),
  rows: openMuseGoogleRows,
});
/*
 * The origin the browser reaches this deployment on. GOOGLE_OAUTH_* carries
 * the Google client this deployment registers with the vendor once at boot
 * (credentials read in the module; config.ts is not edited for this seam).
 * The redirect URI is this origin's public callback path — O02 wires the
 * origin into config; until then OPENBOT_PUBLIC_ORIGIN names it.
 */
const openMusePublicOrigin = process.env.OPENBOT_PUBLIC_ORIGIN?.replace(
  /\/+$/,
  "",
);
const openMuseGoogleCredentials = gmailClientCredentialsFromEnv();
if (openMuseGoogleClient && openMuseGoogleCredentials && openMusePublicOrigin) {
  void pushGmailClientConfig(openMuseGoogleClient, {
    ...openMuseGoogleCredentials,
    redirectUri: `${openMusePublicOrigin}/api/public/openmuse-google/callback`,
  });
}
// The same deployment guard createApp mounts for /api — one construction, not a hand-copied
// twin: a second copy would age separately, and one prefix family guarded two ways is a
// silent fork the first time either gains a check. (Unreachable-in-a-booted-deployment branch
// included for the same reason it always was.)
const openMuseGoogleGuard = createDeploymentRequireUser(
  config,
  auth,
  roleRepository,
);
const openMuseGoogleOAuth = {
  app: createOpenMuseGoogleRoutes({
    service: openMuseGoogleService,
    requireUser: openMuseGoogleGuard,
    ...(openMusePublicOrigin
      ? { allowedHttpOrigin: openMusePublicOrigin }
      : {}),
  }),
  callback: createOpenMuseGoogleCallbackRoutes({
    service: openMuseGoogleService,
    resolveActor: async (headers) => {
      if (config.singleUser) return { id: DEV_ACTOR.id };
      const session = await auth?.api.getSession({ headers }).catch(() => null);
      return session?.user ? { id: session.user.id } : null;
    },
  }),
};

/*
 * The OpenMuse Mail read seam (M01). Its vendor dial is built from the same
 * deployment OpenConnector address as the consent client; a base that cannot
 * be dialled logs and leaves the dial unset, which the read route answers
 * 503 — a boot must not die over a connector, but neither must it pretend to
 * reach one. The guard and requireConnection are the G01 seam's own. R02
 * dials the SAME transport for the reviewed action send executor below.
 */
const openMuseMailDial = (() => {
  try {
    return createOpenMuseMailDial({
      url: config.openConnectorUrl,
    });
  } catch (error) {
    log.error(
      {
        type: "openmuse-mail-vendor-refused",
        error: error instanceof Error ? error.message : String(error),
      },
      "openmuse-mail-vendor-refused",
    );
    return undefined;
  }
})();
const openMuseMail = createOpenMuseMailRoutes({
  ...(openMuseMailDial
    ? { client: buildOpenMuseMailClient({ dial: openMuseMailDial }) }
    : {}),
  service: openMuseGoogleService,
  requireUser: openMuseGoogleGuard,
  ownerDisabled: openMuseGoogleRows.ownerDisabled,
});

/*
 * The OpenMuse Calendar read seam (A01). Its vendor client is built from the
 * same deployment OpenConnector address as the consent client, the same way
 * the Mail seam builds its own dial; a base that cannot be dialled logs and
 * leaves the client unset, which the read route answers 503 — a boot must
 * not die over a connector, but neither must it pretend to reach one. The
 * guard is the G01 seam's own; the route's requireConnection ask is the G03
 * calendar branch, which a Gmail grant never satisfies.
 */
const openMuseCalendarClient = (() => {
  try {
    return createOpenMuseCalendarClient({
      url: config.openConnectorUrl,
    });
  } catch (error) {
    log.error(
      {
        type: "openmuse-calendar-vendor-refused",
        error: error instanceof Error ? error.message : String(error),
      },
      "openmuse-calendar-vendor-refused",
    );
    return undefined;
  }
})();
const openMuseCalendar = createOpenMuseCalendarRoutes({
  ...(openMuseCalendarClient ? { client: openMuseCalendarClient } : {}),
  service: openMuseGoogleService,
  requireUser: openMuseGoogleGuard,
  ownerDisabled: openMuseGoogleRows.ownerDisabled,
});

/*
 * The OpenMuse Reviewed action seam (R01/R02, contracts §6): the claim/receipt
 * state machine with the Gmail send executor — the same deployment
 * OpenConnector dial the mail reads use, behind the G01 requireConnection
 * guard, whose pre-claim check answers a disconnected or re-bound account 409
 * before any provider call. The service, store and routes are R01's, plus the
 * service's one preflight call. The rows and service are hoisted (V01): the
 * Activity feed reads through the same rows and dispatches through the same
 * service instance, so both surfaces share one in-flight execution map.
 */
const openMuseReviewedActionRows = createOpenMuseReviewedActionRows(database);
const openMuseReviewedActionService = createOpenMuseReviewedActionService({
  rows: openMuseReviewedActionRows,
  // One executor per provider surface, dispatched by kind: the Gmail send
  // executor dials the mail transport, the gcalendar executors dial the
  // calendar client, and a kind no executor owns settles `failed` without a
  // dial (never a wrong-surface send).
  executor: createKindDispatchingExecutor({
    "gmail.send": createGmailSendExecutor({
      ...(openMuseMailDial ? { dial: openMuseMailDial } : {}),
      requireConnection: openMuseGoogleService.requireConnection,
    }),
    ...(openMuseCalendarClient
      ? {
          "gcalendar.create": createCalendarCreateExecutor({
            client: openMuseCalendarClient,
            requireConnection: openMuseGoogleService.requireConnection,
          }),
          "gcalendar.update": createCalendarUpdateExecutor({
            client: openMuseCalendarClient,
            requireConnection: openMuseGoogleService.requireConnection,
          }),
          "gcalendar.delete": createCalendarDeleteExecutor({
            client: openMuseCalendarClient,
            requireConnection: openMuseGoogleService.requireConnection,
          }),
        }
      : {}),
  }),
});
// Crash recovery (§6): a process that died between claim and settle leaves
// `executing` rows nothing can decide — flip them past the grace to
// outcome_unknown so the operator's reconcile owns the tail. Best-effort at
// boot; the sweep is idempotent.
void openMuseReviewedActionService
  .recoverAbandonedExecutions()
  .catch((error: unknown) => {
    log.warn(
      {
        type: "openmuse-reviewed-actions-recovery-failed",
        error: error instanceof Error ? error.message : String(error),
      },
      "openmuse-reviewed-actions-recovery-failed",
    );
  });
const openMuseReviewedActions = createOpenMuseReviewedActionsRoutes({
  service: openMuseReviewedActionService,
  requireUser: openMuseGoogleGuard,
});

/*
 * The OpenMuse Activity feed (V01+V02, contracts §8): the owner's merged
 * policy-approval, reviewed-action and task-notification list over the
 * approvals service (the same seam mobile-bff's activity reads), the
 * reviewed store's one activity lister, and the notification store's own
 * owner list — its list/markRead signatures are the feed's seam exactly.
 * Decisions route straight back to the owning modules — the feed itself
 * decides nothing.
 */
const openMuseActivity = createOpenMuseActivityRoutes({
  feed: createActivityFeed({
    approvals: approvalService,
    reviewed: openMuseReviewedActionService,
    listReviewed: createOpenMuseActivityReviewedLister({
      database,
      rows: openMuseReviewedActionRows,
    }),
    notifications: openMuseNotificationStore,
  }),
  requireUser: openMuseGoogleGuard,
});

/*
 * The §9 marker store's bookkeeping rows and the ONE cleanup view every
 * reader shares (the ops signals below, the admin surface below): hoisted
 * above their first consumer (round 6 M3) so no reader builds its own
 * second instance of either.
 */
const openMuseDeletionResourceRows = createOpenMuseDeletionResourceRows(
  database,
);
const openMuseDeletionCleanup = createOpenMuseDeletionCleanupView({
  markers: openMuseAccountDeletionStore,
  rows: openMuseDeletionResourceRows,
});

/*
 * The OpenMuse ops signals surface (O05, contracts §10): the operator's
 * health read at /api/admin/openmuse-ops/signals. The four readers are the
 * feature seams' own rows (G04 connections, the WorkQueue's task leases,
 * R04's uncertain actions) plus D09's cleanup view — read-only, so the
 * aggregation never writes through a seam it does not own.
 */
const openMuseOpsSignals = createOpenMuseOpsSignalsRoutes({
  signals: createOpenMuseOpsSignals({
    ...createOpenMuseOpsSignalReaders({
      database,
      // The ONE cleanup view (round 6 M3): the deletion assembly's own
      // instance, not a second markers+rows pair built here — the
      // "single-instance seam" rule the §9 assembly declared for itself.
      cleanupView: openMuseDeletionCleanup,
    }),
  }),
  requireUser: openMuseGoogleGuard,
});

/**
 * Observation authorization is the MANAGE question, not the chat question: `canAccessAgent`
 * says yes for a public Bot, and public chat access must not become access to another
 * creator's traces. The profile is returned rather than a boolean so readers act on the same
 * row the decision was made on.
 */
const aiObservabilityCanManageBot: BotManagementCheck = async (
  actor,
  botId,
) => {
  const profile = await agentProfileStore.get(actor, botId).catch(() => null);
  return profile && canManageAgent(actor, profile) ? profile : null;
};

// Review F-1: without a health service the enabled state is invisible over
// HTTP. The port stays null until a manifest-verified adapter is wired into
// this deployment, so an enabled configuration honestly answers
// capability_missing — and with no port there is no transport at all.
const opikHealthService = createOpikHealthService({
  config: () => opikConfigFromEnv(process.env),
  port: null,
});
const aiObservability = createAiObservabilityRoutes({
  requireUser: createDeploymentRequireUser(config, auth, roleRepository),
  canManageBot: aiObservabilityCanManageBot,
  healthService: opikHealthService,
});

/*
 * Built-in model-span recording (Issue #20 / T14), on the same inert-until-proven
 * footing as the health service above: one recorder whose only egress is the shared
 * bounded write queue. The observer is registered only when the boot-time config
 * snapshot says enabled — a disabled deployment keeps the product path untouched (no
 * prompt serialization, no delta accumulation). The built-in path carries no trusted
 * observation scope yet, so facts arrive scope-less and the recorder submits nothing
 * upstream; the run-association ticket owns threading the scope, after which these
 * spans flow through the queue unchanged.
 */
const opikModelSpans = createModelSpanRecorder({
  healthService: opikHealthService,
});
if (opikConfigFromEnv(process.env).enabled) {
  setBuiltinModelSpanObserver((fact) =>
    opikModelSpans.record({
      occurredAt: fact.startedAt,
      endedAt: fact.endedAt,
      provider: fact.provider,
      modelId: fact.modelId,
      ending: fact.ending,
      input: fact.input,
      output: fact.output,
    }),
  );
}

/*
 * Tool- and retrieval-step recording (Issue #21 / T15), on the same footing as the
 * model spans above: the built-in path's step facts (proposal / real execute / receipt,
 * correlated by toolCallId) and the retriever's observations (query, kb list, fragments)
 * adapt into one recorder whose only egress is the same bounded write queue. Disabled
 * deployments register no observer, so no argument accumulation or step bookkeeping
 * happens at all. As with T14, the facts carry no trusted scope yet — the recorder
 * submits nothing upstream until the run-association ticket threads one through.
 */
const opikToolSteps = createToolStepRecorder({
  healthService: opikHealthService,
  /*
   * The id-mapping half (Issue #23/T17): a tool step whose span adopted an explicit
   * upstream id is linked after the write lands, chain-checked against the run
   * binding's trace. Inert today for the same reason the span writes are — facts
   * arrive scope-less until the run-association ticket threads one — and activates
   * with zero changes when they do.
   */
  idLinks: createIdLinkStore(database, {
    bindings: createRunBindingStore(database),
  }),
});
if (opikConfigFromEnv(process.env).enabled) {
  setBuiltinToolStepObserver((fact) =>
    opikToolSteps.record({
      toolCallId: fact.toolCallId,
      toolName: fact.toolName ?? undefined,
      proposedAt: fact.proposedAt ?? undefined,
      endedAt: fact.endedAt,
      proposalObserved: fact.proposalObserved,
      executionObserved: fact.executionObserved,
      receiptObserved: fact.receiptObserved,
      execution: fact.execution,
      window: fact.window,
      input: fact.input,
      output: fact.output,
      // The run's W3C chain captured at cell open (Issue #23/T17): the step span
      // joins the cross-service trace instead of rooting a fresh random one.
      ...(fact.trace
        ? { trace: { traceId: fact.trace.traceId, parentSpanId: fact.trace.spanId } }
        : {}),
    }),
  );
  setKnowledgeRetrievalObserver((observed) =>
    opikToolSteps.recordRetrieval({
      occurredAt: observed.startedAt,
      endedAt: observed.endedAt,
      query: observed.query,
      kbIds: observed.kbIds,
      ...(observed.trace
        ? {
            trace: {
              traceId: observed.trace.traceId,
              parentSpanId: observed.trace.spanId,
            },
          }
        : {}),
      outcome:
        observed.outcome.status === "hit"
          ? {
              kind: "hit",
              fragments: observed.outcome.chunks.map((chunk) => ({
                kbId: chunk.kbId,
                chunkId: chunk.chunkId,
                docId: chunk.docId,
                source: chunk.source,
                score: chunk.score,
              })),
            }
          : observed.outcome.status === "miss"
            ? { kind: "miss" }
            : { kind: "degraded", reason: observed.outcome.reason },
    }),
  );
}

/*
 * The OpenMuse private Goal seam (P01, contracts §7): owner CRUD at
 * /api/mobile/openmuse-goals. The Bot-facing read-only lookup
 * (goalLookupFor) stays unwired here — no runtime tool registry exists yet,
 * so C07 ports the runtime and registers the owner's goal.read tool against
 * that seam.
 */
const openMuseGoals = createOpenMuseGoalsRoutes({
  store: createOpenMuseGoalStore({
    rows: createOpenMuseGoalRows(database),
  }),
  requireUser: openMuseGoogleGuard,
});

/*
 * The OpenMuse private Idea seam (P02, contracts §7): owner CRUD plus
 * accept/withdraw at /api/mobile/openmuse-ideas. Accept validates the Task
 * link through the tasks store's owner-scoped get (no store.ts export was
 * missing — the existing get already answers it). The Bot-facing read-only
 * lookup (ideaLookupFor) stays unwired here — no runtime tool registry
 * exists yet, so C07 ports the runtime and registers the owner's idea.read
 * tool against that seam.
 */
const openMuseIdeas = createOpenMuseIdeasRoutes({
  store: createOpenMuseIdeaStore({
    rows: createOpenMuseIdeaRows(database),
    getTask: (ownerUserId, taskId) =>
      openMuseTaskStore.get(ownerUserId, taskId),
  }),
  requireUser: openMuseGoogleGuard,
});

/*
 * The OpenMuse private Memory seam (P03, contracts §7): owner CRUD at
 * /api/mobile/openmuse-memories. The Bot-facing read-only lookup
 * (memoryLookupFor) stays unwired here — no runtime tool registry exists
 * yet, so C07 ports the runtime and registers the owner's memory.read tool
 * against that seam.
 */
const openMuseMemories = createOpenMuseMemoriesRoutes({
  store: createOpenMuseMemoryStore({
    rows: createOpenMuseMemoryRows(database),
  }),
  requireUser: openMuseGoogleGuard,
});

/*
 * The OpenMuse Task notification seam (T12, contracts §7): the owner's
 * notification feed beside the Task surface whose transitions emit into it.
 * Creation stays emit-only — the runner owns the writes, this is the read
 * and mark-read surface.
 */
const openMuseNotifications = createOpenMuseNotificationRoutes({
  store: openMuseNotificationStore,
  requireUser: openMuseGoogleGuard,
});

/*
 * The OpenMuse document inspection seam (F05): POST
 * /api/mobile/openmuse-files/:id/inspect over the personal-files store, so
 * the store is hoisted here — createApp passes the same one to the mobile
 * bff mount beside this router.
 */
// openMuseFileStore is the instance hoisted beside the task runner above.
const openMuseDocuments = createOpenMuseDocumentsRoutes({
  store: openMuseFileStore,
  requireUser: openMuseGoogleGuard,
});

/*
 * The §9 deletion assembly (D02–D09), built where every seam it consumes
 * already lives (ocr-ob-certify findings 15/16/19/20): the delete route's
 * shutdown/revocation/manifest, the admin surface's restore/purge/cleanup,
 * the backup-retention bookkeeping, and the session revocation that closes
 * the fence's tracked exposure.
 */
const openMuseDeletionRecord = recordDeletionResources(database);
const openMuseDeletionManifestBuilder = createOpenMuseDeletionManifest({
  rows: openMuseDeletionResourceRows,
  marker: openMuseAccountDeletionStore,
  files: openMuseFileStore,
  tasks: openMuseTaskStore,
  reviewed: openMuseReviewedActionService,
  goals: createOpenMuseGoalStore({ rows: createOpenMuseGoalRows(database) }),
  ideas: createOpenMuseIdeaStore({
    rows: createOpenMuseIdeaRows(database),
    getTask: (ownerUserId, taskId) =>
      openMuseTaskStore.get(ownerUserId, taskId),
  }),
  memories: createOpenMuseMemoryStore({
    rows: createOpenMuseMemoryRows(database),
  }),
  notifications: openMuseNotificationStore,
  connectors: openMuseGoogleService,
  agents: agentProfileStore,
  channels: channelStore,
});
/*
 * D02's work shutdown and D03's external revocation, run by the delete route
 * behind the marker. The shutdown's cancellation notices go through the
 * notification store's DELETION-FENCE BYPASS — their owner is fenced by the
 * time they fire (see notifications/store.ts's emit).
 */
const openMuseWorkShutdown = createOpenMuseWorkShutdown({
  tasks: openMuseTaskStore,
  // The ROWS seam carries cancelAwaiting (the service wraps it for HTTP); the
  // shutdown wants the row-level CAS the route matrix itself uses.
  reviewed: openMuseReviewedActionRows,
  record: recordWorkShutdown(database),
  emit: (event) =>
    openMuseNotificationStore.emit({
      userId: event.userId,
      taskId: event.taskId,
      eventKind: event.eventKind as OpenMuseNotificationEvent,
      attemptKey: event.attemptKey,
      title: event.title,
      ...(event.detail !== undefined ? { detail: event.detail } : {}),
      bypassDeletionFence: true,
    }),
});
const openMuseExternalAccessRevoker = createOpenMuseExternalAccessRevoker({
  connectors: openMuseGoogleService,
  record: openMuseDeletionRecord,
});
/** §9 hardening: the deleting owner's sessions go with the marker (one statement). */
const openMuseDeleteOwnerSessions = async (userId: string) => {
  await database.delete(sessions).where(eq(sessions.userId, userId));
};
/** D05/D06/D08/D09: the admin surface's seams. */
const openMuseDeletionRestore = createOpenMuseDeletionRestore({
  marker: openMuseAccountDeletionStore,
  files: openMuseFileStore,
  notifications: openMuseNotificationStore,
  manifestRows: openMuseDeletionResourceRows,
});
const openMuseFileBytePurger = createOpenMuseFileBytePurger({
  rows: openMuseDeletionResourceRows,
  marker: openMuseAccountDeletionStore,
  byteStore: openMuseFileBytes,
  files: openMuseFileStore,
});
const openMuseRelationalPurger = createOpenMuseRelationalPurger({
  rows: openMuseDeletionResourceRows,
  marker: openMuseAccountDeletionStore,
  agents: agentProfileStore,
  channels: channelStore,
  tasks: openMuseTaskStore,
  reviewed: openMuseReviewedActionService,
  goals: createOpenMuseGoalStore({ rows: createOpenMuseGoalRows(database) }),
  ideas: createOpenMuseIdeaStore({
    rows: createOpenMuseIdeaRows(database),
    getTask: (ownerUserId, taskId) =>
      openMuseTaskStore.get(ownerUserId, taskId),
  }),
  memories: createOpenMuseMemoryStore({
    rows: createOpenMuseMemoryRows(database),
  }),
  notifications: openMuseNotificationStore,
});
const openMuseBackupRetention = createOpenMuseBackupRetention({
  marker: openMuseAccountDeletionStore,
  record: openMuseDeletionRecord,
});
const identityGithubCallback =
  config.githubApp && config.publicUrl
    ? githubCallbackRoutes({
        clientId: config.githubApp.clientId,
        clientSecret: config.githubApp.clientSecret,
        publicUrl: config.publicUrl,
        appUrl: config.appUrl,
        encryptionKey: config.keyEncryptionKey,
        personIsActive: async (userId) => {
          const person = await peopleStore.find(userId);
          return person !== undefined && !person.revoked;
        },
        credentials: credentialStore,
        identity: identityStore,
        auditStore: bootAuditStore,
      })
    : undefined;

const app = createApp(
  config,
  auth,
  roleRepository,
  createAuditReader(database),
  createCredentialAdminService(
    config.keyEncryptionKey,
    credentialStore,
    createAuditStore(database),
  ),
  createPackageStatusReader(database),
  // The runtime call: the model, per-actor agent loading, and the two identity
  // functions are how a run is attributed to a person.
  copilotRuntime.handler,
  // The only path to an acting call.
  computerGateway,
  policyStore,
  // Bots as durable objects, and the channels they run in.
  agentProfileStore,
  channelStore,
  channelEvents,
  // The same store the boot row uses, so a Bot's own refusal lands in the trail beside its actions.
  bootAuditStore,
  componentStore,
  // MCP servers and packaged skills. Judged by the same policy the computer actions are, read
  // fresh on every call for the same reason: a rule added a moment ago applies to the next call.
  pluginStore,
  // Components authored in the browser. Their governance is the component store's; this owns only
  // the source, which is the part a rebuild would otherwise have owned.
  sandboxedStore,
  // How a thread that has no channel is named, so the direct Bot chat is in the same namespace.
  threadIdentity,
  // Who has signed in, and what an administrator may do about them.
  peopleStore,
  // The enterprise identity providers registered here. Read as facts about the deployment rather
  // than through Better Auth's own listing, which answers per person. See identity-provider-store.ts.
  identityProviderStore,
  // Chooses the coworker for an untagged message, on the deployment's own model and key.
  intentRouter,
  // What a browsing turn's screen looked like when it finished, so the transcript can show it later.
  pageFrameStore,
  // What a due routine actually does: a turn, run as its owner, into the thread they will open.
  routineRunner,
  // A person's own standing instructions: the list, and a switch to stop one.
  routineStore,
  // Where each person is in first-run onboarding, read by /api/me and written by the wizard.
  createOnboardingStore(database),
  // The same store every run reads through `loadInstructionsForActor`, so the screen a person edits
  // and the prompt their coworker is built from can never be two different pieces of text.
  userInstructionsStore,
  // The same database every other store here is built from, so a channel's staged and sent files
  // live behind the same connection as the messages that reference them.
  database,
  // Native host-folder sessions are session-only: grants disappear with this server process and the
  // desktop worker must authenticate with a fresh token for this run.
  hostAccessBroker,
  process.env.OPENBOT_DESKTOP_HOST_TOKEN,
  async (input) => {
    const proactiveRefusal = await guardProactiveCallback(
      input,
      proactiveReadOnlyRefs,
    );
    if (proactiveRefusal) return proactiveRefusal;
    const coordinated = await coordination.call(input);
    if (coordinated) return coordinated;
    const followUp = wakeUpTools({
      store: wakeUpStore,
      ownerUserId: input.actorId,
      agentId: input.botId,
      ...(input.initiator ? { initiator: input.initiator } : {}),
    }).find((candidate) => candidate.name === input.name);
    if (followUp) {
      const text = await followUp.execute(input.args);
      return { text, isError: text.startsWith(REFUSAL_MARKER) };
    }
    const { name, args, botId, actorId, initiator } = input;
    const memory = memoryTools({
      store: personalMemoryStore,
      ingestion: memoryIngestion,
      ownerUserId: actorId,
      agentId: botId,
    }).find((candidate) => candidate.name === name);
    if (memory) {
      const text = await memory.execute(args);
      return { text, isError: text.startsWith(REFUSAL_MARKER) };
    }
    if (!name.startsWith("host_")) return null;
    const tool = hostAccessTools({
      broker: hostAccessBroker,
      botId,
      actorId,
      auditStore: bootAuditStore,
      ...(initiator ? { initiator } : {}),
    }).find((candidate) => candidate.name === name);
    if (!tool) {
      return {
        text: `${REFUSAL_MARKER} That host tool is not available for this Bot right now.`,
        isError: true,
      };
    }
    const text = await tool.execute(args);
    return { text, isError: text.startsWith(REFUSAL_MARKER) };
  },
  // The app directory, behind the same client the plugin store and the transport already share.
  // Absent without a key, which leaves the routes reporting no broker rather than listing apps
  // nobody could connect.
  composio ? { broker: composio.broker } : undefined,
  process.env.OPENBOT_MODEL_OAUTH_FILE?.trim()
    ? createProviderOAuthProxy(process.env.OPENBOT_MODEL_OAUTH_FILE.trim())
    : undefined,
  createUserPreferencesStore(database),
  {
    store: createVoiceSessionStore(database, channelStore),
    summarize: createVoiceSummarizer({
      model: runtimeModel,
      resolveApiKey: resolveRuntimeModelApiKey,
    }),
    channels: channelStore,
  },
  {
    store: learningSettings,
    autoAssign: learningAutoAssign,
    status: copilotRuntime.learning?.status,
    inspect: copilotRuntime.learning?.inspect,
  },
  {
    approvals: approvalService,
    shared: { modes: accountModes, use: sharedUseStore },
    ...(signInService ? { passwords: signInService } : {}),
    demonstrations: {
      store: demonstrationStore,
      recorder: demonstrationRecorder,
    },
    delivery: {
      authenticated: {
        store: deliveryStore,
        router: deliveryRouter,
        scopeFor: deliveryScopeFor,
        listConversations: async (owner, cursor) =>
          channelStore.list(await actorFor(owner), { cursor, limit: 100 }),
        history: (scope) =>
          routineIntelligence.getThreadMessages({
            threadId: scope.threadId,
            userId: scope.ownerUserId,
          }),
        slack: deliveryProviders.slack,
        twilio: deliveryProviders.sms,
        pushProjectId: deliveryProviders.pushProjectId,
      },
      webhooks: {
        store: deliveryStore,
        router: deliveryRouter,
        approvals: approvalService,
        scopeFor: deliveryScopeFor,
        slack: deliveryProviders.slack,
        twilio: deliveryProviders.sms,
        identity: slackCodeRedeemer(identityStore, bootAuditStore),
      },
    },
    memory: { store: personalMemoryStore, ingestion: memoryIngestion },
    proactive: { store: proactiveStore, engine: proactiveEngine },
    responsibilities: {
      store: responsibilityStore,
      engine: responsibilityEngine,
      bindings: responsibilityBindings,
      triggers: responsibilityTriggers,
    },
    groups: groupConversations,
    teamBots,
    enterpriseConversations: enterpriseConversationRoutes,
    lifecycle: {
      lifecycle: createBotLifecycleStore(database),
      reset: createBotReset({
        database,
        softDeleteChannel: (actor, channelId) =>
          channelStore.softDelete(actor, channelId),
      }),
      activity: createActivityStore(database),
      wakeUps: wakeUpStore,
      profiles: agentProfileStore,
      auditStore: bootAuditStore,
    },
    // The marketplace's receipts, beside the agent store it writes Bots through.
    marketplace: { installs: marketplaceStore },
  },
  createSelfHostBanner({
    enabled: config.selfHostBanner,
    entitlements: () => selfHostBannerIntelligence.getRuntimeEntitlements(),
  }),
  billing,
  // The OpenConnector directory's client, appended last for the reason `createApp`'s own parameter
  // list states: same one-client rule as the Composio line further up, absent where the tokens are
  // unset so the second app directory reports no broker rather than listing apps nobody could
  // connect.
  openConnector ? { broker: openConnector.broker } : undefined,
  // APPENDED LAST, per the parameter's own docblock: optional and positional, so it goes after
  // every argument the existing call sites already pass.
  payments,
  // The governed code interpreter, appended last beside `payments` per that parameter's own
  // docblock: optional and positional, present even where the sandbox URL is not, so a run without
  // a sandbox is a refused outcome rather than a missing route.
  codeRunGatewayFactory,
  // APPENDED LAST, per the parameter's own docblock: the statement reads, built from the billing
  // service and the payment ledger above.
  statements,
  credits,
  // The workshop surface, beside the interpreter it extends. APPENDED LAST like `credits`
  // beside it: positional parameters only ever go at the end (see the block above the call
  // for the Redis-or-in-process wiring decision).
  workshopRoutes,
  publicWorkshopRoutes,
  // The craft surface, after the workshop pair it sits beside. APPENDED LAST, same
  // positional rule; undefined when the deployment disabled craft, which mounts nothing.
  craftRoutes,
  // The OpenMuse seam tail as ONE named object (ocr-ob-certify finding 14):
  // seventeen same-shaped positionals transposed silently at the typechecker;
  // named fields cannot be. Every field's own story is app.ts's docblock.
  {
    templateStore: openMuseTemplateMethods,
    // readinessProbe stays default (SELECT 1 on the deployment database).
    templateRevisions: createOpenMuseTemplateRevisionStore({ database }),
    files: openMuseFileStore,
    tasks: openMuseTaskStore,
    googleOAuth: openMuseGoogleOAuth,
    mail: openMuseMail,
    reviewedActions: openMuseReviewedActions,
    goals: openMuseGoals,
    calendar: openMuseCalendar,
    ideas: openMuseIdeas,
    memories: openMuseMemories,
    documents: openMuseDocuments,
    notifications: openMuseNotifications,
    accountDeletion: openMuseAccountDeletionStore,
    deletionShutdown: openMuseWorkShutdown,
    deletionRevoke: openMuseExternalAccessRevoker,
    deletionManifest: (userId) =>
      openMuseDeletionManifestBuilder.buildManifest(userId),
    deletionRevokeSessions: openMuseDeleteOwnerSessions,
    deletionNoteBackupRetention: (userId) =>
      openMuseBackupRetention.noteBackupRetention(userId),
    deletionAdmin: {
      restore: openMuseDeletionRestore,
      purge: (userId) => openMuseFileBytePurger.purgeFileBytes(userId),
      purgeRelational: (userId) =>
        openMuseRelationalPurger.purgeRelationalData(userId),
      cleanupView: openMuseDeletionCleanup,
    },
    activity: openMuseActivity,
    opsSignals: openMuseOpsSignals,
    aiObservability,
  },
  identityStore,
  identityGithubCallback,
);

/**
 * The live screen, proxied.
 *
 * Proxied rather than connected directly. `agent-computer` authenticates its callers with a
 * shared token, not with a person's session, and it must never be reachable from a browser. So the
 * socket terminates here, behind the same session guard as every other route, and this process opens
 * a second socket inward carrying the token.
 *
 * Not a Hono route because an upgrade is not a request/response: Bun hands it over before Hono sees a
 * body, so it is handled in `fetch` ahead of the app.
 */
// The stream's gate, extracted so its decisions can be tested without binding a port
// (see computer/stream-auth.ts): computer on → session → which Bot → route inward.
const authorizeStream = createStreamAuthorizer({
  resolveRequestActor,
  agentProfileStore,
  computerGateway,
  config,
  // Same list the sensitive writes trust (learning/routes.ts), so a SameSite=None deployment
  // cannot be ridden cross-site into a screen socket.
  trustedOrigins: config.auth?.trustedOrigins ?? [],
});

/** What each proxied socket carries: where to connect inward, and the socket once opened. */
type StreamData = {
  upstream: string;
  /** The computer token, handed to the inward socket as a header, never on the URL. */
  token: string;
  ownerUserId: string;
  botId: string;
  recordingId?: string;
  inward?: WebSocket;
};

/**
 * Bun takes exactly one WebSocket handler for the server, and three features need one: the app
 * proxies the computer stream and the craft webapp's HMR socket, and it pushes channel activity
 * through Hono's adapter. So this one dispatches on what the upgrade attached — an HMR socket
 * carries `hmr`, a stream proxy socket carries `upstream` without it, a Hono socket carries
 * neither — rather than any feature quietly taking the slot and breaking the others on connect.
 */
type ChannelSocket = Parameters<typeof channelSocket.open>[0];
type SocketData = StreamData | WebappHmrSocketData | ChannelSocket["data"];

const isProxiedStream = (data: SocketData): data is StreamData =>
  typeof (data as StreamData).upstream === "string" &&
  (data as WebappHmrSocketData).hmr !== true;

const isHmrSocket = (data: SocketData): data is WebappHmrSocketData =>
  (data as WebappHmrSocketData).hmr === true;

// Hono owns the socket's data once it has upgraded it; this hands its own back to it.
const asChannelSocket = (ws: { data: SocketData }) =>
  ws as unknown as ChannelSocket;

serve<SocketData>({
  port,
  async fetch(request, server) {
    const url = new URL(request.url);
    if (url.pathname === "/api/audio/transcriptions") {
      server.timeout(request, DICTATION_HTTP_IDLE_SECONDS);
    }
    // The workshop's and craft's event streams outlive the default request timeout by design:
    // their connection is the subscription, held open by a 15s keepalive against Bun's 10s idle
    // default — without this raise, every quiet stream is cut before its first keepalive
    // (craft's turn attach, parked on a connect_app ask, is exactly that quiet stream).
    if (
      (url.pathname.startsWith("/api/workshop/") ||
        url.pathname.startsWith("/api/craft/")) &&
      url.pathname.endsWith("/events")
    ) {
      server.timeout(request, 255);
    }
    if (url.pathname === "/api/voice/calls") server.timeout(request, 30);
    if (url.pathname === "/api/voice/sessions") server.timeout(request, 30);
    const decision = await authorizeStream(request);
    if (decision.kind === "refuse") {
      return new Response(decision.message, { status: decision.status });
    }
    if (decision.kind === "proxy") {
      const recording = await demonstrationStore.active(
        decision.actorId,
        decision.botId,
      );
      const upstream = recording
        ? `${decision.upstream}&recording=${encodeURIComponent(recording.id)}`
        : decision.upstream;
      if (
        server.upgrade(request, {
          data: {
            upstream,
            token: decision.token,
            ownerUserId: decision.actorId,
            botId: decision.botId,
            ...(recording ? { recordingId: recording.id } : {}),
          },
        })
      ) {
        return undefined as unknown as Response;
      }
      return new Response("Expected a WebSocket upgrade.", { status: 400 });
    }
    const hmrSessionId =
      craftWebappHmrDeps !== undefined
        ? webappHmrSessionIdFromPath(url.pathname)
        : null;
    if (
      hmrSessionId !== null &&
      craftWebappHmrDeps !== undefined &&
      request.headers.get("upgrade")?.toLowerCase() === "websocket"
    ) {
      // The webapp proxy's own auth, applied by hand because middleware does not run on an
      // upgrade (the stream branch above sets the precedent). Every refusal lands BEFORE the
      // upgrade commits — onyx's `_check_webapp_access` → WebSocketException(1008), answered
      // here as plain HTTP statuses while the request is still a request.
      const actor = await resolveRequestActor(request).catch(() => null);
      const decision = await resolveWebappHmrUpgrade(craftWebappHmrDeps, {
        sessionId: hmrSessionId,
        actor,
        // Verbatim, not a rebuilt "/_next/webpack-hmr": the scaffold's basePath IS
        // this mount, so the dev server serves HMR under it. See webappHmrUpstreamUrl.
        path: url.pathname,
        query: url.search,
      });
      if (!decision.ok) {
        return new Response(decision.error, { status: decision.status });
      }
      if (
        server.upgrade(request, {
          data: { upstream: decision.upstreamUrl, hmr: true as const },
        })
      ) {
        return undefined as unknown as Response;
      }
      return new Response("Expected a WebSocket upgrade.", { status: 400 });
    }
    return app.fetch(request, { server });
  },
  websocket: {
    open(ws) {
      if (isHmrSocket(ws.data)) {
        webappHmrSocketHandlers.open(ws as Bun.ServerWebSocket<WebappHmrSocketData>);
        return;
      }
      if (!isProxiedStream(ws.data)) {
        channelSocket.open(asChannelSocket(ws));
        return;
      }
      const stream = ws.data;
      /*
       * The token rides the upgrade's headers (Bun's options form — the DOM
       * types only know the protocols argument, hence the cast), matching
       * every HTTP call the transport makes to the computer, so it stays out
       * of any proxy or computer access log the URL would land in.
       */
      const inward = new WebSocket(stream.upstream, {
        headers: { "x-openbot-computer-token": stream.token },
      } as unknown as string | string[]);
      stream.inward = inward;
      // Frames outward, input inward. Buffered by neither side: a frame the browser is too slow for
      // should be dropped, not queued, because a stale frame is worse than a missing one.
      inward.onmessage = (event) => {
        if (stream.recordingId) {
          let recorded: unknown;
          try {
            recorded = JSON.parse(String(event.data));
          } catch {
            recorded = null;
          }
          if (
            recorded &&
            typeof recorded === "object" &&
            "type" in recorded &&
            recorded.type === "demonstration.action"
          ) {
            const data = stream;
            const message = recorded as {
              recordingId?: unknown;
              action?: unknown;
            };
            if (message.recordingId !== data.recordingId) {
              ws.send(
                JSON.stringify({
                  type: "error",
                  error:
                    "The recording identity changed. Stop and restart recording.",
                }),
              );
              return;
            }
            demonstrationRecorder
              .capture(
                data.ownerUserId,
                data.botId,
                data.recordingId ?? "",
                message.action,
              )
              .catch((error) => {
                log.error(
                  {
                    type: "demonstration-capture-error",
                    error: error instanceof Error ? error.name : "UnknownError",
                    context: { recordingId: data.recordingId },
                    timestamp: new Date().toISOString(),
                  },
                  "demonstration-capture-error",
                );
                try {
                  ws.send(
                    JSON.stringify({
                      type: "error",
                      error:
                        "A browser step could not be saved. Stop and review the demonstration before continuing.",
                    }),
                  );
                } catch {
                  /* A closed viewer cannot receive the already logged failure. */
                }
              });
            return;
          }
        }
        try {
          ws.send(String(event.data));
        } catch {
          inward.close();
        }
      };
      inward.onclose = () => ws.close();
      inward.onerror = () => ws.close();
    },
    message(ws, raw) {
      if (isHmrSocket(ws.data)) {
        webappHmrSocketHandlers.message(
          ws as Bun.ServerWebSocket<WebappHmrSocketData>,
          raw,
        );
        return;
      }
      if (!isProxiedStream(ws.data)) {
        channelSocket.message(asChannelSocket(ws), raw);
        return;
      }
      if (ws.data.inward?.readyState === 1) ws.data.inward.send(String(raw));
    },
    close(ws, code, reason) {
      if (isHmrSocket(ws.data)) {
        webappHmrSocketHandlers.close(ws as Bun.ServerWebSocket<WebappHmrSocketData>);
        return;
      }
      if (!isProxiedStream(ws.data)) {
        channelSocket.close(asChannelSocket(ws), code, reason);
        return;
      }
      ws.data.inward?.close();
    },
  },
});

if (config.singleUser) {
  // Loud, every boot. A server that is not checking who is asking should never be a quiet default.
  log.warn(
    { actor: DEV_ACTOR.email },
    "No identity provider is configured, so every request is treated as the development actor " +
      "(administrator). Configure GOOGLE_OAUTH_*, MICROSOFT_OAUTH_*, OKTA_OAUTH_* or " +
      "CASDOOR_OAUTH_* before anybody else can reach this.",
  );
}

// Each listener holds a connection of its own for the life of the process. Released on the way out,
// so a watch-mode restart does not leave two behind on every reload.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    responsibilitySweep.stop();
    wakeUpSweep.stop();
    wakeUpReaper.stop();
    openMuseTaskSweep.stop();
    openMuseTaskReaper.stop();
    memorySweep.stop();
    proactiveSweep.stop();
    approvalSweep.stop();
    personResponseSweep.stop();
    groupSweep.stop();
    for (const sweep of deliverySweeps) sweep.stop();
    // The billing sweepers (audit C3): stopped before the listeners below, so a shutdown cannot
    // land mid-batch. Each stop is its own try/catch — one that throws must not block the rest.
    for (const stop of billingSweepStops) {
      try {
        stop();
      } catch {
        // Deliberately swallowed: the remaining stops and the listener shutdown still run.
      }
    }
    // Craft's idle reaper (started by the craft route assembly, held at that module's scope).
    stopCraftIdleReaper();
    void Promise.allSettled([
      channelActivityListener.stop(),
      policyListener.stop(),
      // Started only where handing work between Bots is switched on, so it is often not there.
      workOfferedListener?.stop() ?? Promise.resolve(),
      Promise.resolve(retentionSweeps.stop()),
    ]).finally(() => process.exit(0));
  });
}

log.info({ port }, "OpenBot server listening on http://127.0.0.1");


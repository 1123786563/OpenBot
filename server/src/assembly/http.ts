/**
 * MOD02 (#622): the HTTP route/middleware assembly.
 *
 * Everything between `const app = new Hono(...)` and `return app` in
 * createApp moved here VERBATIM (same order, same judgments, same comments):
 * the CORS/tracking floors, the session guard, the enterprise gate, the
 * usage-origin and entry-context floors, every capability-conditional mount,
 * and the SPA static fallback. app.ts keeps its positional signature, the
 * configuration-shaped dependency list, and the helpers the mount consumes
 * (createDeploymentRequireUser, credentialInput, recordPersonEvent,
 * defaultReadinessProbe, UPLOAD_BODY_LIMIT_BYTES); it delegates the whole
 * mount to {@link assembleHttpApp} in one place. Business rules stay with
 * their owning modules — assembly composes, it does not decide (A03).
 *
 * Mount ORDER is load-bearing: CORS before any route, correlation before any
 * sub-app, the usage-origin floor after the gate and above every
 * usage-bearing surface, the CopilotKit runtime last among /api routes, the
 * SPA catch-all after every one of them. The per-mount comments below are the
 * ones createApp carried; they moved with their code.
 */

import { randomUUID } from "node:crypto";
import type { CopilotKitIntelligence } from "@copilotkit/runtime/v2";
import { MAX_IMAGE_BYTES } from "@openbot/shared/attachments";
import { getLogger } from "@openbot/shared/logger";
import type { Context, Hono as HonoApp, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { serveStatic } from "hono/bun";
import { cors } from "hono/cors";
import { enterpriseControls } from "../admin/controls";
import { createEnterpriseGate } from "../admin/gate";
import { createOpenMuseTemplateAdminRoutes } from "../admin/openmuse-template-routes";
import { createEnterpriseAdminRoutes } from "../admin/routes";
import {
  authoriseAgentCall,
  parseAgentToolCallInput,
  sameToken,
} from "../agents/callback-token";
import { computerAccessCheck } from "../agents/computer-access";
import { createBotLifecycleRoutes } from "../agents/lifecycle-routes";
import type { BotAccessCheck } from "../agents/profile-policy";
import type { AgentProfileStore } from "../agents/profile-store";
import { createAgentRoutes } from "../agents/routes";
// Type-only: no runtime edge back into app.ts (the values above arrive as deps).
import type {
  CoworkerSeams,
  createDeploymentRequireUser,
  DeploymentToolCaller,
  OpenMuseSeams,
} from "../app";
import { createApprovalRoutes } from "../approvals/routes";
import {
  type AuditEventType,
  AuditQueryError,
  type AuditReader,
  type AuditStore,
  auditEventsToCsv,
  auditQueryFromUrl,
  DEPLOYMENT_INITIATOR,
  readAuditExportRows,
  recordAuditEvent,
} from "../audit";
import { createClosedCompanyAssurance } from "../auth/company-assurance";
import { createCompanyAuthRoutes } from "../auth/company-auth-routes";
import { createDirectoryAuthority } from "../auth/directory/authority";
import type {
  IdentityActor,
  IdentityOperation,
} from "../auth/directory/contracts";
import {
  type IdentityExecutor,
  isIdentityCommandRefusal,
} from "../auth/directory/identity";
import {
  createDirectoryIngress,
  type NativeAuthPort,
} from "../auth/directory/ingress";
import {
  createDirectoryReadGate,
  createPlatformReadGate,
} from "../auth/directory/read-gate";
import {
  type AppVariables,
  type AuthService,
  type RoleRepository,
  requireAdmin,
} from "../auth/guards";
import type { IdentityProviderStore } from "../auth/identity-provider-store";
import {
  createMobileSessionHandoff,
  type MobileHandoffClient,
} from "../auth/mobile-session";
import { createMobileSessionRoutes } from "../auth/mobile-session-routes";
import { desktopAuthPage } from "../auth/native-browser";
import { createAsyncJobsViewService } from "../billing/async-jobs-view";
import type { Credits } from "../billing/credits";
import type { CreditWriter } from "../billing/credits-writer";
import {
  createPaymentCallbackRoutes,
  createPaymentRoutes,
} from "../billing/payments/routes";
import type { PaymentService } from "../billing/payments/service";
import { createBillingEntriesPublic } from "../billing/public";
import { createRealtimeUsageService } from "../billing/realtime-usage";
import { createRewardGranter } from "../billing/rewards";
import {
  createBillingAdminRoutes,
  createBillingCreditRoutes,
  createBillingRoutes,
  createBillingStatementRoutes,
  createBillingWebhookRoutes,
} from "../billing/routes";
import type { BillingStatements } from "../billing/statements";
import type { BillingService } from "../billing/types";
import { createWorkbenchPayerMiddleware } from "../billing/workbench-payer";
import { accessGrantRoutes } from "../bot-services/access-grants";
import { botServiceRoutes } from "../bot-services/auth";
import { botServiceCredentialRoutes } from "../bot-services/credential-routes";
import type { BotServiceRegistry } from "../bot-services/registry";
import { botServiceAdminRoutes } from "../bot-services/routes";
import type { BotServiceStore } from "../bot-services/store";
import {
  createAttachmentRoutes,
  createChannelAttachmentRoutes,
} from "../channels/attachments";
import type { ChannelEventHub } from "../channels/events";
import { createGroupRoutes } from "../channels/group";
import { type ChannelStore, createChannelRoutes } from "../channels/routes";
import type { ThreadIdentity } from "../channels/thread-identity";
import { createThreadRoutes } from "../channels/thread-routes";
import { createThreadReader } from "../channels/thread-status";
import {
  type CodeRunGatewayFactory,
  createCodeSandboxRoutes,
} from "../codesandbox/routes";
import { createComponentRoutes } from "../components/routes";
import type { SandboxedStore } from "../components/sandboxed";
import { createSandboxedRoutes } from "../components/sandboxed-routes";
import type { ComponentStore } from "../components/store";
import type { ComputerGateway } from "../computer/gateway";
import type { PageFrameStore } from "../computer/page-frames";
import type { PolicyStore } from "../computer/policy-store";
import { createComputerRoutes } from "../computer/routes";
import {
  configuredAuthProviders,
  type DeploymentConfig,
  trustedBrowserOrigins,
} from "../config";
import type { CraftRoutesFactory } from "../craft/routes";
import {
  type CredentialAdminService,
  type CredentialInput,
  CredentialRefusedError,
} from "../credentials";
import type { Database } from "../db/client";
import { withoutStatement } from "../db/query-failure";
import {
  createDeliveryRoutes,
  createDeliveryWebhookRoutes,
} from "../delivery/routes";
import { createDemonstrationRoutes } from "../demonstrations/routes";
import { mountDesktopConnectionFailure } from "../desktop-connection-failure";
import { createTranscriptionProvider } from "../dictation/provider";
import { createDictationRoutes } from "../dictation/routes";
import { withRunnerRequestContext } from "../enterprise/runs/request-context";
import { createLegacyEntryGuard } from "../enterprise/tenancy/assembly-legacy";
import { createDeploymentEntryContextMiddleware } from "../enterprise/tenancy/entry-context";
import { createBaScopeSelectionService } from "../enterprise/tenancy/workspace-admin";
import { createBaSelectionScopeMount } from "../enterprise/tenancy/workspace-scope-routes";
import {
  GatewayAdminCredentialNotConfiguredError,
  gatewayAdminCredentialControls,
} from "../gateway/admin-credential";
import { gatewayAdminCredentialRoutes } from "../gateway/admin-credential-routes";
import { gatewayAdminRoutes } from "../gateway/admin-routes";
import {
  createEnterpriseGatewayNegotiationStore,
  createGatewayCapabilityNegotiationService,
} from "../gateway/capability-negotiation";
import { notConfiguredConversionRateState } from "../gateway/conversion-rate";
import { createConversionRateStore } from "../gateway/conversion-rate-store";
import { gatewayEndpointControls } from "../gateway/endpoint-config";
import { createModelDiscoveryRoutes } from "../gateway/model-discovery-routes";
import { createModelSelectionRoutes } from "../gateway/model-selection-routes";
import { createEnterpriseGatewayProbeStore } from "../gateway/probe";
import {
  createGatewayReadinessService,
  installGatewayReadinessService,
} from "../gateway/readiness";
import { createHindsightRoutes } from "../hindsight/ops-routes";
import type { HostAccessBroker } from "../host-access/broker";
import { createHostAccessRoutes } from "../host-access/routes";
import { identityRoutes } from "../identity/routes";
import type { IdentityStore } from "../identity/store";
import {
  createLearningRoutes,
  type LearningAdminDependencies,
} from "../learning/routes";
import { createMarketplaceRoutes } from "../marketplace/routes";
import { createMastraContinuationRoutes } from "../mastra/continuation-routes";
import { createMemoryServiceEntryRoutes } from "../memory-service/entry-routes";
import { createMemoryConsumersRegistry } from "../memory-service/consumers-registry";
import {
  createOpenBotMemorySourceCheck,
  type SourceAccess,
} from "../memory-service/source-check";
import { mountMemoryServiceRoutes } from "../memory-service/routes";
import { createMobileBffActivity } from "../mobile-bff/activity";
import {
  createOpenMuseBotProvisioner,
  OPENMUSE_TEMPLATE_KEY,
} from "../mobile-bff/openmuse-bot";
import { createMobileBffRoutes } from "../mobile-bff/routes";
import { createMobileBffWorkspace } from "../mobile-bff/workspace";
import { openMuseAccountFence } from "../openmuse-deletion/fence";
import { createOpenMuseDeletionAdminRoutes } from "../openmuse-deletion/restore";
import { createOpenMuseAccountDeletionRoutes } from "../openmuse-deletion/routes";
import { createOpenMuseFilesRoutes } from "../openmuse-files/routes";
import { createOpenMuseTasksRoutes } from "../openmuse-tasks/routes";
import { parsePageLimit } from "../paging";
import { createPasswordRoutes, createSignInRoutes } from "../passwords/routes";
import type { OnboardingStore } from "../people/onboarding";
import { MAX_PAGE, type PeopleStore } from "../people/store";
import type { ComposioBroker, ConnectedAppBroker } from "../plugins/broker";
import { createToolAccess } from "../plugins/public";
import { createPluginRoutes } from "../plugins/routes";
import { createSharedUseRoutes } from "../plugins/shared-use-routes";
import {
  isDeploymentFault,
  PluginRefusedError,
  type PluginStore,
} from "../plugins/store";
import { REFUSAL_MARKER, vendorAnswer } from "../plugins/tools";
import { createProactiveRoutes } from "../proactive/routes";
import {
  type ModelProviderProxy,
  mountProviderOAuthProxy,
} from "../provider-oauth";
import { createGithubResponsibilityRoutes } from "../responsibilities/github";
import { createResponsibilityRoutes } from "../responsibilities/routes";
import { createRoutineRoutes, type RoutineStore } from "../routines/routes";
import type { RoutineRunner } from "../routines/runner";
import type { IntentRouter } from "../routing/classify";
import { createRoutingRoutes } from "../routing/routes";
import { createCoworkerRoutingService } from "../routing/service";
import type { SelfHostBanner } from "../self-host-banner";
import { createTeamBotRoutes } from "../team-bots/routes";
import { createRequestTracking } from "../telemetry/request-tracking";
import { createTraceMiddleware } from "../telemetry/trace-middleware";
import type { PackageStatusReader } from "../tenant-package";
import { withUsageOrigin } from "../usage-origin";
import {
  INSTRUCTIONS_LIMIT,
  InstructionsTooLongError,
  type UserInstructionsStore,
} from "../user-instructions";
import type { UserPreferencesStore } from "../user-preferences";
import { userPreferencesRoutes } from "../user-preferences-routes";
import { createVoiceProvider } from "../voice/provider";
import { createVoiceRoutes } from "../voice/routes";
import type { VoiceSessionServices } from "../voice/session-routes";
import {
  DIRECTORY_PATH as WEB_BOT_AUTH_DIRECTORY_PATH,
  directoryResponse as webBotAuthDirectory,
} from "../web-bot-auth";
import type { createWorkshopPublicRoutes } from "../workshop/public-routes";
import type { WorkshopRoutesFactory } from "../workshop/routes";
import { fireRoutineDispatch } from "./routine-dispatch";

const log = getLogger("server");

/**
 * The mount section's declared dependencies: createApp's fifty positional
 * parameters (copied field-for-field, docblocks included) plus the closures
 * and app.ts-owned helpers the section referenced from its enclosing scope,
 * explicitized by MOD02. Every value the mount reads arrives through this
 * object; assembleHttpApp imports no app.ts runtime binding.
 */
export interface HttpAssemblyDependencies {
  config: DeploymentConfig;
  auth?: AuthService;
  roleRepository?: RoleRepository;
  auditReader?: AuditReader;
  credentialService?: CredentialAdminService;
  packageStatusReader?: PackageStatusReader;
  /**
   * The CopilotKit endpoint, already built by the caller.
   *
   * Passed in rather than constructed here so this module never imports the runtime. The runtime
   * pulls in `eventsource`, which Bun cannot `require()` from a test, so importing it at module
   * scope broke every server test that touches createApp even though none of them use CopilotKit.
   */
  copilotHandler?: HonoApp;
  /** The single governed computer module: policy, audit trail, transport, and provider lifecycle. */
  computerGateway?: ComputerGateway;
  /** What the gateway enforces, and what an administrator can change while running. */
  computerPolicy?: PolicyStore;
  /** Bots as durable objects: profile, roster, visibility. */
  agentProfileStore?: AgentProfileStore;
  /** The durable channels a Bot runs in. */
  channelStore?: ChannelStore;
  /** Live channel activity. Absent leaves the routes working, just without the socket. */
  channelEvents?: ChannelEventHub;
  /**
   * Where a Bot's own refusal is written.
   *
   * Separate from `auditReader`, which only reads: this writes, and it is the one thing in the trail
   * that is not decided by the gateway, a model declining before it calls anything.
   */
  auditStore?: AuditStore;
  /**
   * Which components each Bot may answer with.
   *
   * Absent leaves the app working and every Bot answering in prose, which is the correct degraded
   * behaviour: a deployment that cannot reach its grant table must not fall back to granting
   * everything.
   */
  componentStore?: ComponentStore;
  /**
   * The MCP servers and packaged skills this deployment has, and which Bots hold them.
   *
   * Absent leaves every Bot with the tools it was born with, which is the correct degraded
   * behaviour: a deployment that cannot reach its grant table must offer nothing extra rather than
   * fall back to offering everything.
   */
  pluginStore?: PluginStore;
  /**
   * Components authored in the browser rather than compiled into the build.
   *
   * Absent leaves the compiled gallery working exactly as before, which is the correct degraded
   * behaviour: the React path is the primary one and does not depend on this.
   */
  sandboxedStore?: SandboxedStore;
  /**
   * How this deployment names the threads it mints.
   *
   * Absent leaves the direct Bot chat generating its own id in the browser, which works and simply
   * says nothing about which deployment the conversation belongs to.
   */
  threadIdentity?: ThreadIdentity;
  /**
   * Who has signed in, and what an administrator may do about them.
   *
   * Absent leaves the people screen answering 503 rather than an empty list, which is the honest
   * degraded behaviour: "nobody has signed in" and "this deployment cannot tell you" are different
   * answers and an administrator deciding who has access needs to know which one they are reading.
   */
  peopleStore?: PeopleStore;
  /**
   * The enterprise identity providers this deployment has registered.
   *
   * Read here rather than through Better Auth's own listing route, which scopes to the person asking:
   * a company's Okta tenant belongs to the deployment, not to whichever administrator pasted the
   * metadata in. See identity-provider-store.ts.
   */
  identityProviders?: IdentityProviderStore;
  /**
   * Chooses which coworker an untagged message is for, before a channel is pinned to one.
   *
   * Passed in already built, like the copilot handler, so this module never imports the model
   * client. Absent leaves the composer's existing behaviour untouched: an untagged message goes to
   * the default coworker, which is exactly the failsafe the router itself falls back to.
   */
  intentRouter?: IntentRouter;
  /**
   * Where the frame a browsing turn ended on is kept.
   *
   * Appended last on purpose: these are positional, so inserting one anywhere else silently
   * shifts every existing call site's arguments by one.
   *
   * Absent leaves the transcript working and past turns without a picture, which is the correct
   * degraded behaviour: a conversation that cannot show what it saw is better than one that shows
   * the wrong thing.
   */
  pageFrames?: PageFrameStore;
  /**
   * Fires one routine run with nobody's browser open, when the worker hands one back.
   *
   * Appended last, like `pageFrames`: these are positional, so inserting one anywhere else silently
   * shifts every existing call site's arguments by one.
   *
   * Absent leaves the internal `/internal/routines/run` route unmounted rather than mounted and
   * refusing every call: a deployment that never built a worker has no door for it, not a locked one.
   */
  routineRunner?: RoutineRunner;
  /**
   * A person's own standing instructions: the list, and a switch to stop one.
   *
   * Appended last, like `routineRunner` beside it: these are positional, so inserting one anywhere
   * else silently shifts every existing call site's arguments by one.
   *
   * Absent leaves the routes unmounted rather than mounted and refusing every call, the same
   * degraded shape every other optional store here takes: a deployment that never built the store
   * has no door for this at all, not a locked one.
   */
  routineStore?: RoutineStore;
  /**
   * Where each person is in first-run onboarding.
   *
   * Appended last, like everything above it: these are positional, so inserting one anywhere else
   * silently shifts every existing call site's arguments by one.
   *
   * Absent leaves /api/me reporting no onboarding to track, which is the correct degraded
   * behaviour: a deployment that cannot read the status must not lock everybody behind a gate
   * nothing can finish.
   */
  onboardingStore?: OnboardingStore;
  /**
   * One person's standing instructions, which every built-in coworker they run is told.
   *
   * Appended last, like everything above it: these are positional, so inserting one anywhere else
   * silently shifts every existing call site's arguments by one.
   *
   * Absent leaves the routes answering 503 rather than "you have written none". The difference
   * matters on exactly this screen: a person who cannot be told what they saved would otherwise be
   * shown an empty box, and the obvious thing to do with an empty box is fill it in again.
   */
  userInstructions?: UserInstructionsStore;
  /**
   * The database behind a channel's staged and sent files: upload, fetch, delete.
   *
   * Appended last, like everything above it: these are positional, so inserting one anywhere else
   * silently shifts every existing call site's arguments by one.
   *
   * Absent leaves the routes unmounted rather than mounted and refusing every call, the same
   * degraded shape every other optional store here takes: a deployment that never built the
   * database has no door for this at all, not a locked one.
   */
  attachmentDatabase?: Database;
  /** Session-only broker for native owner-approved host folder access. */
  hostAccessBroker?: HostAccessBroker;
  /** Fresh desktop-only bearer token for the native host worker poll/result channel. */
  desktopHostToken?: string;
  /** Server-owned tools that are not MCP but use the same signed agent callback route. */
  deploymentToolCaller?: DeploymentToolCaller;
  /**
   * The broker behind apps a person connects through Composio rather than an administrator
   * registering an MCP server.
   *
   * Appended last, like everything above it: these are positional, so inserting one anywhere else
   * silently shifts every existing call site's arguments by one.
   *
   * Passed in already built, like the copilot handler and the intent router, so this module never
   * imports the vendor's package. Absent leaves the plugin surface reporting that no broker is
   * configured, which is the correct degraded behaviour: a deployment with no Composio API key has
   * no app directory to offer, rather than one that lists apps nobody can connect.
   */
  composio?: { broker: ComposioBroker };
  /** Native model OAuth stays server-side; callers hold only a separate local bearer. */
  modelProviderProxy?: ModelProviderProxy;
  userPreferences?: UserPreferencesStore;
  voiceSessions?: VoiceSessionServices;
  learning?: LearningAdminDependencies;
  coworker?: CoworkerSeams;
  /**
   * Whether to offer help self-hosting, which also hides it from a deployment that pays for
   * Intelligence. Absent falls back to the operator's switch alone, so a test or a build without the
   * resolver still answers from `config.selfHostBanner` rather than asking the network.
   */
  selfHostBanner?: SelfHostBanner;
  /**
   * The billing seam's one service, mounted as its three route groups.
   *
   * A field here rather than another positional parameter, for the same reason the coworker object
   * above exists: everything past `auditReader` is optional and positional, and a mislaid argument
   * there is silent. Absent — a deployment that configured no provider — mounts none of the billing
   * surfaces, not ones that refuse: no webhook door, no entitlements read, no admin snapshot.
   *
   * `externalCustomerKey` arrives derived rather than derived here, because the tenant identity it
   * comes from (`deploymentExternalCustomerId(config.deploymentId ?? tenantPackage.tenantId)`) is
   * only whole in the assembly, and the sync and any future caller must not drift apart on it.
   */
  billing?: {
    service: BillingService;
    externalCustomerKey: string;
    /** What the provider's customer record calls this deployment. */
    customerName: string;
    /**
     * The credit ledger's write side, when the assembly built it. Lives on the billing group
     * (not the credits parameter further down) because the admin grant route is one of the
     * billing surfaces: absent leaves that route answering 503, the same "not configured, not
     * broken" answer every other absent piece here gives.
     */
    creditWriter?: CreditWriter;
    /**
     * The deployment's own database, where the personal grant route (ticket 02.8) resolves the
     * target user and their payer account. Absent leaves that route answering 503: a grant
     * route that cannot resolve must refuse, never fall back to a caller-named account key.
     */
    database?: Database;
  };
  /**
   * OpenConnector the broker, `composio`'s twin: the client behind a second app directory, already
   * built by the assembly, passed in so this module imports no vendor of either.
   *
   * APPENDED LAST, like `composio` before it, for the reason that parameter's own docblock gives:
   * these are positional, so inserting one anywhere else silently shifts every existing call
   * site's arguments by one. Absent — a deployment with either OpenConnector token unset — leaves
   * the plugin surface reporting no such broker, exactly as absent `composio` leaves it reporting
   * no Composio: one inert row under More apps, nothing connectable.
   */
  openConnector?: { broker: ConnectedAppBroker };
  /**
   * The direct-collection channels, APPENDED LAST for the reason the parameter above states:
   * everything past `auditReader` is optional and positional, and a mislaid argument there is
   * silent. Mounted only when the assembly built them (which it does only when a channel is whole
   * AND billing is configured — config.ts owns that precondition).
   *
   * `activePlanCode` arrives derived rather than derived here, for the same reason the billing
   * group's `externalCustomerKey` does: the single-subscription guard and the catalog's answer
   * must both read the projection through the billing service, never around it.
   */
  payments?: {
    service: PaymentService;
    activePlanCode(): Promise<string | null>;
  };
  /**
   * The governed code-interpreter module. Absent leaves run_code refusing everywhere.
   *
   * APPENDED LAST, like `payments` beside it, for the reason those parameters' own docblocks give:
   * these are positional, so inserting one anywhere else silently shifts every existing call
   * site's arguments by one.
   */
  codeRunGatewayFactory?: CodeRunGatewayFactory;
  /**
   * The statement reads: 套餐用量 (`/api/billing/plan-usage`) and the bill list
   * (`/api/billing/invoices`). APPENDED LAST for the same reason every parameter above it is.
   *
   * Separate from `billing` because the two answers are not the provider's: the plan-usage read
   * joins the provider's period and charges against a ceiling this DEPLOYMENT configured, and a
   * bill is a local payment order read as a statement — so the assembly builds this from whichever
   * of the two it has, and a deployment with channels but no configured ceiling still gets bills.
   * Absent mounts neither path, which is what a free deployment should look like from outside.
   */
  statements?: BillingStatements;
  /**
   * The credit-ledger reads: 套餐与积分 (`/api/billing/credits/*`). APPENDED LAST for the same
   * reason `statements` is: positional. Local only — the credit ledger lives in this deployment's
   * own database, so it has no provider dependency; absent mounts no credit path.
   */
  credits?: Credits;
  /**
   * The workshop: a Bot's working surface — turns, files, artifacts, the SSE stream — behind
   * canUseBot like every other Bot-scoped route. APPENDED LAST, same reason as `credits`.
   *
   * A factory rather than a router so the assembly decides the wiring (store, lock, bus,
   * orchestrator) in one place; the factory itself is built by the index assembly where the
   * Redis/no-Redis branch lives.
   */
  workshopRoutes?: WorkshopRoutesFactory;
  /**
   * The workshop's ANONYMOUS half (B14/F9/B15b): the share-token routes, mounted at
   * /api/public/workshop. A factory for the same reason `workshopRoutes` is — the sharing
   * service's wiring (store, limiter, signing key) is a boot decision. Optional: a
   * deployment without it simply has no public share surface.
   */
  publicWorkshopRoutes?: () => ReturnType<typeof createWorkshopPublicRoutes>;
  /**
   * Craft: the autonomous-build surface (`/api/craft` — sessions, send-message, SSE turn
   * streams), ported from onyx's build feature. APPENDED LAST like `workshopRoutes` beside
   * it: positional parameters only ever go at the end. A factory for the same reason — the
   * wiring (store, gateway, manager, executor, the deployment's model catalog) is one boot
   * decision; the craft tree carries its own enabled gate (503 mid-flight) and needs only
   * `requireUser` (its sandbox routing is not Bot-scoped like the workshop's canUseBot).
   * Absent (or OPENBOT_CRAFT_ENABLED explicitly disabled) mounts nothing.
   */
  craftRoutes?: CraftRoutesFactory;
  /**
   * The OpenMuse seam tail, ONE named object instead of seventeen trailing
   * positionals: ten of those were the same Hono router type, where any call
   * site's silent argument misordering typechecks and mounts a family under
   * the wrong prefix (goals under /api/mobile/openmuse-calendar) with no
   * runtime error to notice. Named fields cannot be transposed; the older
   * positional parameters above this one stay as they were.
   */
  openMuseSeams?: OpenMuseSeams;
  /** A person's own linked accounts. Absent answers 503 on /api/identity. */
  identity?: IdentityStore;
  /** The GitHub sign-in callback, built by the caller; mounted behind requireUser ahead of /api/identity. */
  identityGithubCallback?: Hono<{ Variables: AppVariables }>;
  /**
   * The Bifrost bot service registry (04.1) — and, since 04.2, its credential surface and
   * authenticator when the deployment composed a full {@link BotServiceRegistry}. A bare 04.1
   * store keeps every registry route working and leaves the credential surfaces answering a
   * tagged 503; absent answers a tagged 503 on /api/admin/bot-services.
   */
  botServices?: BotServiceStore | BotServiceRegistry;
  /**
   * The company-workbench payer wiring (Bifrost 09.2, #287): present binds the workbench
   * surface's requests to their company scope's payer — the account every reserve, settle and
   * remainder of the call then names (02.5's no-switch semantics carry it). Absent leaves the
   * workbench paths resolving exactly as before; this seam never binds a payer on its own.
   */
  workbenchPayer?: { database: Database };

  /**
   * #733 来源裁决的 OpenBot Access：签发的来源范围（Bot 归属）到裁决时是否
   * 仍成立。装配层用部署数据库构造；缺省时来源裁决入口不挂载（404）。
   */
  memorySourceAccess?: SourceAccess;

  /*
   * ── MOD02 explicitized dependencies ────────────────────────────────────────
   *
   * The fields above are createApp's parameters, unchanged. The ones below are
   * what the mount section used to read from its enclosing scope: one closure
   * created before the mount, and the helpers app.ts retains ownership of
   * (acceptance #4) and now hands in explicitly.
   */

  /**
   * ME15 (#487): the thread-status reader's Intelligence client accessor,
   * built by createApp before the mount begins. Passing the accessor — not
   * calling it — keeps the mount client-free until the first thread read that
   * needs one; a deployment without Intelligence constructs nothing and the
   * read refuses by name.
   */
  requireThreadReaderClient: () => CopilotKitIntelligence;
  /**
   * The deployment's session guard factory, owned and exported by app.ts
   * (index.ts mounts the same construction). The mount creates its own
   * requireUser with it, exactly where it did before the extraction.
   */
  createDeploymentRequireUser: typeof createDeploymentRequireUser;
  /**
   * The administrator credential routes' input parser. app.ts owns the
   * allowlist rule (never widened to match the schema enum); the mount only
   * consumes it.
   */
  credentialInput: (
    value: unknown,
    actorUserId: string,
  ) => CredentialInput | null;
  /** The people routes' person-event audit writer, owned by app.ts. */
  recordPersonEvent: (
    auditStore: AuditStore | undefined,
    context: { var: AppVariables },
    eventType:
      | "person.role_changed"
      | "person.access_revoked"
      | "person.access_restored",
    person: { id: string; email: string },
    payload: Record<string, unknown>,
  ) => Promise<void>;
  /**
   * The /ready default probe, owned by app.ts: one SELECT 1 raced against a
   * timeout, and "this app has no database" is down.
   */
  defaultReadinessProbe: (
    database: Database | undefined,
  ) => () => Promise<void>;
  /**
   * app.ts's UPLOAD_BODY_LIMIT_BYTES — the envelope ceiling the channel
   * attachment mount's bodyLimit reads. Passed by value so the constant keeps
   * exactly one definition.
   */
  uploadBodyLimitBytes: number;
}

/**
 * Assemble the deployment's HTTP app: one Hono instance carrying the full
 * middleware chain and route mount, in the order createApp registered them.
 * Returns the app; callers (createApp) return it unchanged.
 */
/**
 * One admin-screen security write as an identity command (T05.07): the
 * deployment's own people screen is the administrator's usual surface, and
 * when the assembly built the identity executor its role and access changes
 * are the same five operations the native Admin endpoints translate — one
 * command, one receipt, the platform actor the executor re-verifies in its
 * own lock. Absent keeps the legacy write exactly as it was (M0/M1 keep
 * their DTO and capability; the matrix is the caller's).
 *
 * Returns the refusal answer to return, or undefined when the command
 * committed and the caller's own adjuncts (blocklist row, retirement, audit
 * event, response) follow as before.
 */
async function runIdentityCommand(
  identity: Pick<IdentityExecutor, "execute">,
  context: Context<{ Variables: AppVariables }>,
  action: {
    operation: IdentityOperation;
    targetUserId: string;
    payload: Readonly<Record<string, unknown>>;
  },
): Promise<Response | undefined> {
  /*
   * The platform actor is the administrator's operator identity, not their
   * session — the same shape the native ingress issues, with nothing a
   * session actor carries that the frozen assert would refuse.
   */
  const actor: IdentityActor = Object.freeze({
    userId: context.var.actor.id,
    principalId: null,
    sessionId: null,
    kind: "platform",
    bindingId: null,
    provisioning: null,
  });
  try {
    await identity.execute(actor, {
      operation: action.operation,
      targetUserId: action.targetUserId,
      /*
       * Every screen action is its own command: the receipt is the audit
       * trail of THIS click, and a screen retry never borrows an earlier
       * command's committed result.
       */
      idempotencyKey: randomUUID(),
      payload: action.payload,
    });
    return undefined;
  } catch (error) {
    if (isIdentityCommandRefusal(error)) {
      return context.json(
        { error: error.message, code: error.code },
        error.status,
      );
    }
    throw error;
  }
}

export function assembleHttpApp(
  deps: HttpAssemblyDependencies,
): Hono<{ Variables: AppVariables }> {
  const {
    config,
    auth,
    roleRepository,
    auditReader,
    credentialService,
    packageStatusReader,
    copilotHandler,
    computerGateway,
    computerPolicy,
    agentProfileStore,
    channelStore,
    channelEvents,
    auditStore,
    componentStore,
    pluginStore,
    sandboxedStore,
    threadIdentity,
    peopleStore,
    identityProviders,
    intentRouter,
    pageFrames,
    routineRunner,
    routineStore,
    onboardingStore,
    userInstructions,
    attachmentDatabase,
    memorySourceAccess,
    hostAccessBroker,
    desktopHostToken,
    deploymentToolCaller,
    composio,
    modelProviderProxy,
    userPreferences,
    voiceSessions,
    learning,
    coworker,
    selfHostBanner,
    billing,
    openConnector,
    payments,
    codeRunGatewayFactory,
    statements,
    credits,
    workshopRoutes,
    publicWorkshopRoutes,
    craftRoutes,
    openMuseSeams,
    identity,
    identityGithubCallback,
    botServices,
    workbenchPayer,
    createDeploymentRequireUser,
    credentialInput,
    recordPersonEvent,
    defaultReadinessProbe,
    uploadBodyLimitBytes: UPLOAD_BODY_LIMIT_BYTES,
    requireThreadReaderClient,
  } = deps;

  // The OpenMuse seam tail, unpacked to the local names the body below reads —
  // one named object at the call site, no seventeen positional arguments to
  // transpose. (Finding ocr-ob-certify #14.)
  const {
    templateStore: openMuseTemplateStore,
    readinessProbe,
    templateRevisions: openMuseTemplateRevisions,
    files: openMuseFiles,
    tasks: openMuseTasks,
    googleOAuth: openMuseGoogleOAuth,
    mail: openMuseMail,
    reviewedActions: openMuseReviewedActions,
    goals: openMuseGoals,
    calendar: openMuseCalendar,
    ideas: openMuseIdeas,
    memories: openMuseMemories,
    documents: openMuseDocuments,
    notifications: openMuseNotifications,
    accountDeletion: openMuseAccountDeletion,
    deletionShutdown: openMuseDeletionShutdown,
    deletionRevoke: openMuseDeletionRevoke,
    deletionManifest: openMuseDeletionManifest,
    deletionRevokeSessions: openMuseDeletionRevokeSessions,
    deletionNoteBackupRetention: openMuseDeletionNoteBackupRetention,
    deletionAdmin: openMuseDeletionAdmin,
    activity: openMuseActivity,
    opsSignals: openMuseOpsSignals,
    aiObservability,
    aiObservabilityCancelForActor,
  } = openMuseSeams ?? {};

  const app = new Hono<{ Variables: AppVariables }>();
  // Browser origins the deployment already trusts (TRUSTED_ORIGINS plus the app URL) get CORS
  // headers on API responses, so a bundle served from one of them can call this API. Registered
  // before any route so it covers them all; native clients never send Origin and skip this.
  // The SAME list answers #410's craft write guard — one source, so CORS and the write surface
  // can never disagree about who is trusted.
  const browserOrigins = trustedBrowserOrigins(config);
  if (browserOrigins.length > 0) {
    app.use(
      "/api/*",
      cors({
        origin: (origin) =>
          browserOrigins.includes(origin) ? origin : undefined,
        credentials: true,
      }),
    );
  }
  // Correlation first: every response carries x-request-id, and /api requests get an
  // access log line with that id on it. Registered before any route so sub-apps
  // mounted later inherit the ambient request id for their own logs.
  const tracking = createRequestTracking({ logger: getLogger("server") });
  app.use("*", tracking.requestId);
  app.use("*", createTraceMiddleware());
  app.use("/api/*", tracking.accessLog);
  mountDesktopConnectionFailure(app, desktopHostToken);
  mountProviderOAuthProxy(app, modelProviderProxy);

  app.get("/health", (context) => context.json({ status: "ok" }));
  /*
   * Readiness, which unlike liveness is allowed to say no. `/health` above answers whether this
   * process is serving; `/ready` answers whether the deployment behind it is usable, which for
   * OpenBot is one question: does the database answer. The probe is injected so tests decide up
   * and down in code, and the default is a real SELECT 1 rather than an echo, so a caller polling
   * this route learns the truth about the deployment instead of the truth about the process.
   */
  const probe = readinessProbe ?? defaultReadinessProbe(attachmentDatabase);
  app.get("/ready", async (context) => {
    try {
      await probe();
      return context.json({ status: "ok", database: "up" });
    } catch {
      return context.json({ status: "unavailable", database: "down" }, 503);
    }
  });
  // The public key Bots' browsers sign their requests with, where Cloudflare and any other verifier
  // look for it. Public by design, and absent when Web Bot Auth is off. See web-bot-auth.ts.
  const webBotAuth = config.webBotAuth;
  if (webBotAuth) {
    app.get(WEB_BOT_AUTH_DIRECTORY_PATH, (context) =>
      webBotAuthDirectory(context.req.raw, webBotAuth),
    );
  }
  // Projected, never the raw runtime. config.runtime carries the Intelligence contract, including
  // INTELLIGENCE_API_KEY and the licence token, and this endpoint is reachable by anyone. Returning
  // the object wholesale would serve deployment secrets to the browser. Add fields here explicitly.
  app.get("/api/capabilities", async (context) =>
    context.json({
      mode: config.runtime.mode,
      durableHistory: config.runtime.durableHistory,
      /*
       * Whether a Bot may answer with an interface it wrote itself.
       *
       * Projected because the browser holds half of this capability. The runtime middleware turns a
       * generated interface into the events that paint it, and the SDK's provider registers the tool
       * that produces one; a deployment that switched the runtime half off while the browser went on
       * offering the tool would have Bots writing interfaces nothing ever draws. One flag, read by
       * both halves, so off means off.
       */
      generativeUi: config.generativeUi,
      // Whether to offer help self-hosting OpenBot. A fork running it for its own people turns it off,
      // and a deployment that pays for Intelligence never sees it. See self-host-banner.ts.
      selfHostBanner: selfHostBanner
        ? await selfHostBanner.shown()
        : config.selfHostBanner,
      transcription: Boolean(config.transcription),
      voice: Boolean(config.voice),
      /*
       * Which identity providers this deployment can sign somebody in with.
       *
       * Ids only, never the credentials: `configuredAuthProviders` returns names, and the clients
       * and secrets behind them stay in `config.auth`, which is not projected here.
       *
       * Answered at runtime rather than baked into the build, because the container image is built
       * once and knows nothing about the deployment that will run it. A sign-in screen compiled on a
       * build machine cannot offer a provider that machine had never heard of.
       */
      authProviders: configuredAuthProviders(config.auth),
      /*
       * Whether any enterprise identity provider has been registered.
       *
       * A count, not a list. The sign-in screen only needs to know whether to offer the email box
       * that routes by domain; naming the providers would tell anybody who loads the page which
       * companies use this deployment, which is not theirs to have before they sign in.
       */
      ssoConfigured: ((await identityProviders?.list()) ?? []).length > 0,
      /*
       * Whether an administrator requires SSO. The screen then leads with SSO and keeps social
       * sign-in only as the administrators' audited break-glass; the server refuses everybody else.
       */
      ssoRequired:
        enterpriseControls()?.snapshot()?.settings.ssoRequired === true,
      emailPassword: config.auth?.emailPassword === true,
      /*
       * Whether this deployment has a paid-plan provider behind it, and whether it currently pays.
       *
       * Two booleans, nothing else — the same allow-list discipline as every field above. The
       * provider's name for anything, the plan anybody is on, the codes a plan grants: none of that
       * is this endpoint's to hand to somebody who has not signed in. `paid` comes from the cached
       * entitlement read, which never reaches the provider on a read path and fails closed, so a
       * projection that cannot be read answers "not paid" rather than erroring this endpoint.
       */
      billing: billing
        ? {
            enabled: true,
            paid: (await billing.service.entitlements()).active,
          }
        : { enabled: false, paid: false },
    }),
  );

  const companyAssurance = createClosedCompanyAssurance({
    policy: coworker?.directory?.proofPolicy ?? {
      requiresProof: async () => false,
    },
  });

  if (coworker?.enterpriseConversations) {
    app.route(
      "/api/enterprise/conversations",
      coworker.enterpriseConversations,
    );
  }
  // MT126 (Issue #169): the stream entry's unified assembly — subscription
  // open/SSE/cancel, every route establishing its context from the same
  // shared factory. Absent (channels unwired) mounts nothing.
  if (coworker?.enterpriseStreamEntry) {
    app.route("/api/enterprise/streams", coworker.enterpriseStreamEntry);
  }
  // MT006 (issue #49) + T03.02 (#539): the existing scope app remains the
  // legacy/admin surface; when this process has both its authenticated session
  // source and database, wrap it with the authority-aware ba-v1 listing and
  // selection validation. The wrapper delegates every other route unchanged,
  // and legacy/paused GETs preserve the base DTO byte-for-byte. Missing auth or
  // database keeps the pre-T03.02 mount exactly as it was — no half-built BA
  // route and no guessed authority.
  if (coworker?.enterpriseWorkspaceScope) {
    const workspaceScope =
      auth && attachmentDatabase
        ? createBaSelectionScopeMount(coworker.enterpriseWorkspaceScope, {
            authenticate: async (request) => {
              const session = await auth.api
                .getSession({
                  headers: request.headers,
                  query: { disableCookieCache: true },
                })
                .catch(() => null);
              return session?.user.id
                ? { actorId: session.user.id, entrypoint: "web" }
                : null;
            },
            selection: createBaScopeSelectionService(attachmentDatabase, {
              // This application-owned database is the same verified target
              // every store behind the prebuilt enterprise scope app uses. The
              // service itself still reads clocks through the controlled
              // auth_read_eligibility_clocks function and authority in its own
              // short transaction; callers never receive a database handle.
              data: attachmentDatabase,
              authority: createDirectoryAuthority(),
              assurance: companyAssurance,
            }),
          })
        : coworker.enterpriseWorkspaceScope;
    app.route("/api/enterprise/workspace-scope", workspaceScope);
  }
  if (coworker?.pluginPackages) {
    app.route("/api/enterprise/plugin-packages", coworker.pluginPackages);
  }
  /*
   * The company-auth challenge route (T05.01 / #557). Mounted whenever this
   * process has a session source: unauthenticated callers get 401, and the
   * challenge itself refuses per its own authority/policy gates. The live
   * seam is `coworker.directory.companyAuth` when the assembly built one;
   * absent, the closed adapter answers its controlled 503 — the route exists,
   * issuance honestly reports not-ready, and no deployment silently grows a
   * half-wired challenge.
   */
  if (auth) {
    // The real BA session reader both enterprise auth surfaces share: the
    // company-auth challenge and the mobile handoff bind to the live
    // session, never to a caller's claim about one.
    const readBaSession = async (request: Request) => {
      const session = await auth.api
        .getSession({
          headers: request.headers,
          query: { disableCookieCache: true },
        })
        .catch(() => null);
      // The declared type names {user}; the real BA session also carries
      // its id, which the challenge binds to — narrowed here, not
      // re-declared in the vendor's types.
      const sessionId = (session as { session?: { id?: string } } | null)
        ?.session?.id;
      return session?.user.id && sessionId
        ? { userId: session.user.id, sessionId }
        : null;
    };
    app.route(
      "/api/enterprise/company-auth",
      createCompanyAuthRoutes({
        authenticate: readBaSession,
        assurance: coworker?.directory?.companyAuth ?? companyAssurance,
      }),
    );
    /*
     * The mobile session handoff (T05.12 / #568, interfaces §5.2): the
     * system-browser authorize and the registered BFF's exchange, on the
     * application database where the handoff rows and the BA sessions they
     * re-verify live. Mounted only when a session source, a database and
     * at least one registered mobile client all exist — a deployment without
     * MOBILE_SESSION_CLIENTS grows no half-registered surface, exactly as it
     * booted before.
     */
    if (attachmentDatabase && config.mobileSession) {
      app.route(
        "/api/enterprise/mobile",
        createMobileSessionRoutes({
          authenticate: readBaSession,
          handoff: createMobileSessionHandoff({
            database: attachmentDatabase,
            clients: config.mobileSession
              .clients as ReadonlyArray<MobileHandoffClient>,
          }),
        }),
      );
    }
  }
  /*
   * The native directory ingress (T02.11 / P04; interfaces §3.2).
   *
   * Mounted when the deployment has both a session store (auth) and its own
   * database, because the read gate opens a real transaction per native
   * directory read. It answers:
   *
   * - refused endpoints of the frozen table (X): a backend 403, never the
   *   pinned build's handler;
   * - unknown methods/paths under /admin, /organization, /sso, /scim: 404;
   * - directory/identity writes: translated into Directory/Identity commands.
   *   No executor is assembled here yet — the P08/P09/P12 tasks register the
   *   operations and the assembly — so every such write refuses with 503
   *   before anything is written, rather than reaching a handler that would
   *   open its own transaction (F-01);
   * - native directory reads: gated in this deployment's transaction and then
   *   forwarded to the pinned build, which answers;
   * - everything outside the table (sign-in, sessions, desktop, SCIM/SSO paths
   *   the table defers to P12): null, so the existing mount below behaves
   *   exactly as before.
   *
   * The company proof port answers "this company demands an additional proof".
   * Until the stored policy model arrives (P11), no company demands one, and
   * the port says so; demanding proof with no evidence bridge would refuse
   * every company read, which is why P11 replaces this port rather than the
   * gate.
   */
  const nativeDirectoryIngress =
    auth && attachmentDatabase
      ? createDirectoryIngress({
          database: attachmentDatabase,
          auth: auth as unknown as NativeAuthPort,
          readGate: createDirectoryReadGate({
            authority: createDirectoryAuthority(),
            assurance: companyAssurance,
          }),
          platformReadGate: createPlatformReadGate(),
          ...(coworker?.directory?.directory
            ? { directory: coworker.directory.directory }
            : {}),
          ...(coworker?.directory?.identity
            ? { identity: coworker.directory.identity }
            : {}),
          ...(coworker?.directory?.passwordRecovery
            ? { passwordRecovery: coworker.directory.passwordRecovery }
            : {}),
        })
      : null;
  /*
   * Registering an identity provider is an administrator's decision, not a signed-in one.
   *
   * Better Auth's SSO plugin guards these with `sessionMiddleware`, which asks only that somebody is
   * signed in. That is the wrong bar here: registering an IdP for a domain means anybody it vouches
   * for can sign in, so a plain user reaching this could mint themselves colleagues. The routes are
   * mounted through this handler, so the check goes in front of it.
   */
  const ADMIN_ONLY_AUTH_ROUTES = new Set([
    "/api/auth/sso/register",
    "/api/auth/sso/update-provider",
    "/api/auth/sso/delete-provider",
  ]);

  const AUTH_ROUTE_EVENTS: Record<string, AuditEventType | undefined> = {
    "/api/auth/sso/register": "identity_provider.registered",
    "/api/auth/sso/delete-provider": "identity_provider.removed",
  };

  /*
   * The SCIM 2.0 surface (T05.05 / #561), mounted before the generic auth
   * handler so it decides for every SCIM method: with the assembly's
   * transcription, a write runs inside its directory-command transaction
   * (the plugin's own handler, the hooks bound to the same transaction) and
   * a discovery/read returns null to the native contract below. Without the
   * transcription the request keeps today's classification — the closed
   * ingress rows answer their named 501 before anything is written.
   */
  app.on(
    ["GET", "POST", "PUT", "PATCH", "DELETE"],
    "/api/auth/scim/*",
    async (context) => {
      if (!auth) {
        return context.json(
          { error: "No identity provider is configured." },
          503,
        );
      }
      const transcription = coworker?.directory?.scim;
      if (transcription) {
        const answer = await transcription.handle(context.req.raw);
        if (answer) return answer;
        return auth.handler(context.req.raw);
      }
      const answer = nativeDirectoryIngress
        ? await nativeDirectoryIngress.handle(context.req.raw)
        : null;
      return answer ?? auth.handler(context.req.raw);
    },
  );

  app.on(["GET", "POST"], "/api/auth/*", async (context) => {
    if (
      context.req.method === "GET" &&
      new URL(context.req.url).pathname === "/api/auth/desktop" &&
      !config.organizationAuthUrl
    ) {
      return desktopAuthPage(
        context.req.raw,
        configuredAuthProviders(config.auth),
      );
    }
    if (!auth) {
      return context.json(
        { error: "No identity provider is configured." },
        503,
      );
    }

    /*
     * The closed native directory table decides before the pinned build's
     * handler runs; `null` means "not a directory endpoint" and the mount
     * continues unchanged.
     */
    const nativeDirectoryAnswer = nativeDirectoryIngress
      ? await nativeDirectoryIngress.handle(context.req.raw)
      : null;
    if (nativeDirectoryAnswer) return nativeDirectoryAnswer;

    if (ADMIN_ONLY_AUTH_ROUTES.has(new URL(context.req.url).pathname)) {
      const session = await auth.api.getSession({
        headers: context.req.raw.headers,
        // Fresh, not the cookie cache: a role changed a moment ago has to apply to this request.
        query: { disableCookieCache: true },
      });
      const roles = session?.user
        ? ((await roleRepository?.rolesForUser(session.user.id)) ?? [])
        : [];
      if (!roles.includes("admin")) {
        return context.json(
          { error: "Only an administrator may change identity providers." },
          403,
        );
      }
    }

    const eventType =
      AUTH_ROUTE_EVENTS[new URL(context.req.url).pathname] ?? undefined;

    // Read before the handler runs, because it consumes the stream: a clone taken afterwards is of
    // a request whose body is already gone, and the row would name no provider.
    const named =
      auditStore && eventType
        ? ((await context.req.raw
            .clone()
            .json()
            .catch(() => null)) as { providerId?: unknown } | null)
        : null;

    const answer = await auth.handler(context.req.raw);

    if (auditStore && eventType && answer.ok) {
      const session = await auth.api.getSession({
        headers: context.req.raw.headers,
        query: { disableCookieCache: true },
      });
      await recordAuditEvent(auditStore, {
        eventType,
        targetType: "identity_provider",
        ...(typeof named?.providerId === "string"
          ? { targetId: named.providerId }
          : {}),
        ...(session?.user ? { actorUserId: session.user.id } : {}),
        payload: {
          ...(typeof named?.providerId === "string"
            ? { providerId: named.providerId }
            : {}),
          ...(session?.user?.email ? { by: session.user.email } : {}),
        },
      });
    }

    return answer;
  });

  // One administrator, when nothing is configured to sign anybody in. Checked first, and only ever
  // true when there is no provider, so a configured deployment cannot fall back to it.
  const requireUser = createDeploymentRequireUser(config, auth, roleRepository);
  // Enterprise controls: capability switches and the model allowlist in front of the routes they
  // govern, the admin screen's API, and the SCIM verbs the GET/POST auth handler above does not take.
  app.use("/api/*", createEnterpriseGate(requireUser));
  /*
   * The usage-origin floor (2026-10-13 audit, F6): a signed-in person's request context says
   * `web`, so the usage facts its model calls and code runs record carry the caller they
   * really came from. Registered after the gate so only requests that got this far are named.
   * Hono composes handlers in registration order, so this covers exactly the usage-bearing
   * API surfaces mounted BELOW this point (the CopilotKit runtime, the workshop, the channels
   * — all of them); the earlier-mounted /api/capabilities, /api/auth/*, desktop-connection and
   * provider-proxy surfaces never pass through here, record no usage today, and any future
   * usage-bearing surface must mount below this line or name its own origin.
   */
  app.use("/api/*", (_context, next) => withUsageOrigin("web", next));
  /*
   * MT122 (issue #165): the deployment main entry's request-context floor,
   * mounted only in multitenancy mode beside a wired entry factory. Every
   * business route registered BELOW this line passes through it: a request
   * carrying the ruling #1 selection headers gets its context established
   * here and its business dependencies built from the scope factory — never
   * a default scope. The capabilities/auth/enterprise surfaces registered
   * above keep their own context establishment, and selection-header-less
   * requests pass untouched (the legacy migration is MT125's scope).
   */
  if (coworker?.entryContext && config.multitenancy.enabled) {
    app.use(
      "/api/*",
      createDeploymentEntryContextMiddleware(coworker.entryContext),
    );
    /*
     * MT125 (Issue #168): the legacy-family entrance guard, mounted in the
     * same mode-gated block after the entry-context floor — explicitly-closed
     * entrances answer 503 with a stable code instead of serving; registered
     * exceptions and unified entrances pass through to their own
     * establishment (their reasons live in the disposition table and the
     * MT001 inventory, not on this path). Single-tenant mode never mounts it:
     * the legacy surface is byte-for-byte what it was.
     */
    app.use("/api/*", createLegacyEntryGuard());
  }
  app.route("/api/admin/enterprise", createEnterpriseAdminRoutes(requireUser));
  /*
   * #731 内嵌管理入口：只返回部署配置的承载地址与本次装载的 requestId。
   * 未配置 MEMORY_SERVICE_URL 时不挂载，页面据此显示"未启用"。
   *
   * #733 来源裁决入口：MEMORY 在采集/召回/审核前回调。需要三件部署事实齐备
   * 才挂载——MEMORY_SERVICE_*（客户端身份）、MEMORY_SOURCE_CHECK_TOKEN（MEMORY
   * 出示的服务令牌）和装配层传入的来源 Access（数据库）。缺任一保持 404
   * fail-closed：MEMORY 的来源核验得不到放行，只会得到"无法核验"。
   */
  if (config.memoryService) {
    app.route(
      "/api/memory-service/entry",
      createMemoryServiceEntryRoutes({
        memoryBaseUrl: config.memoryService.baseUrl,
        requireUser,
      }),
    );
    if (config.memoryService.sourceCheckToken && memorySourceAccess) {
      mountMemoryServiceRoutes(app, {
        check: createOpenBotMemorySourceCheck({
          key: config.memoryService.sourceKey,
          consumers: createMemoryConsumersRegistry({
            baseUrl: config.memoryService.baseUrl,
            appId: config.memoryService.appId,
            appSecret: config.memoryService.appSecret,
          }),
          access: memorySourceAccess,
        }),
        serviceToken: config.memoryService.sourceCheckToken,
      });
    }
  }
  if (openMuseTemplateRevisions) {
    /*
     * Template revision preview/apply: administrator-only (requireUser + requireAdmin inside the
     * factory), mounted only where the assembly built the revision store beside the template store.
     */
    app.route(
      "/api/admin/openmuse-template",
      createOpenMuseTemplateAdminRoutes({
        requireUser,
        revisions: openMuseTemplateRevisions,
      }),
    );
  }

  app.route(
    "/api/audio",
    createDictationRoutes(
      requireUser,
      config.transcription
        ? createTranscriptionProvider(config.transcription)
        : undefined,
    ),
  );
  app.route(
    "/api/voice",
    createVoiceRoutes(
      requireUser,
      config.voice ? createVoiceProvider(config.voice) : undefined,
      channelStore,
      agentProfileStore,
      voiceSessions,
      learning?.status
        ? async (agentId) =>
            (await learning.status?.(agentId))?.configured ?? false
        : undefined,
    ),
  );

  app.get("/api/me", requireUser, async (context) =>
    context.json({
      user: {
        ...context.var.actor,
        /*
         * Read here rather than in the guard, so only this route pays the extra query. Null means
         * this deployment does not track onboarding, which the app reads as nothing to finish;
         * a not-yet-completed status is what sends it to /onboarding.
         */
        onboarding: onboardingStore
          ? await onboardingStore.status(context.var.actor.id)
          : null,
      },
      /*
       * True when this deployment admits everybody as one administrator and has no sign-in at
       * all. The app reads it to drop UI that presumes a session — a Log-out the server has no
       * route to serve answers its click with the 503 above.
       */
      singleUser: config.singleUser,
    }),
  );
  app.post("/api/me/onboarding", requireUser, async (context) => {
    if (!onboardingStore) {
      return context.json({ error: "Onboarding is not available." }, 503);
    }

    const body = (await context.req.json().catch(() => undefined)) as
      | { step?: unknown; completed?: unknown }
      | undefined;

    if (body?.completed === true) {
      await onboardingStore.complete(context.var.actor.id);
    } else if (
      typeof body?.step === "number" &&
      Number.isInteger(body.step) &&
      body.step >= 0 &&
      // The column's range — the only bound the server knows, since the wizard's length is the
      // app's fact rather than the deployment's.
      body.step <= 2_147_483_647
    ) {
      await onboardingStore.setStep(context.var.actor.id, body.step);
    } else {
      return context.json(
        { error: "Send the step to move to, or completed: true." },
        400,
      );
    }

    return context.json({
      onboarding: await onboardingStore.status(context.var.actor.id),
    });
  });
  /*
   * A person's own standing instructions, read and written by the person they belong to.
   *
   * `requireUser` and never `requireAdmin`, and scoped to `context.var.actor.id` rather than to
   * anything in the path or the body. There is deliberately no route here for reading somebody
   * else's or writing on their behalf: these instructions go into a prompt that then speaks as that
   * person's coworker, so a way to set them for another account would be a way to put words in
   * somebody's mouth in every channel they work in. An administrator has no business here either,
   * for the same reason.
   */
  app.route(
    "/api/settings/preferences",
    userPreferencesRoutes(requireUser, userPreferences),
  );

  /*
   * The session must match the sealed state's person, otherwise a link started by one person could
   * attach another person's GitHub account (login CSRF), so the callback requires the same session
   * as the rest of /api/identity; a missing session answers 401 rather than a redirect. Mounted
   * before the identity router so that router never sees a GET to this path; other methods fall
   * through to it and get its own 401/404.
   */
  if (identityGithubCallback) {
    app.use("/api/identity/github/callback", requireUser);
    app.route("/api/identity/github/callback", identityGithubCallback);
  }
  /*
   * A person's own linked accounts at outside providers (Slack, GitHub). Theirs alone: there is no
   * administrator view and no linking on somebody else's behalf. A provider is offered only when
   * its return path is wired: Slack needs the identity redeemer for the codes it issues, and GitHub
   * needs the callback mounted above, otherwise people would be sent away and back to nothing.
   */
  app.route(
    "/api/identity",
    identityRoutes(requireUser, identity, auditStore, {
      slackLinking: Boolean(
        coworker?.delivery?.webhooks.slack &&
          coworker.delivery.webhooks.identity,
      ),
      github:
        identityGithubCallback && config.githubApp && config.publicUrl
          ? {
              clientId: config.githubApp.clientId,
              publicUrl: config.publicUrl,
              encryptionKey: config.keyEncryptionKey,
            }
          : undefined,
    }),
  );

  /*
   * The administrator's bot service registry (Bifrost #234, 04.1): which server-side Bots this
   * deployment recognizes at all. Registration mints an identity and a declaration, never a
   * credential or a grant — those are 04.2's and 04.5+'s, under their own triggers. Absent leaves
   * the surface mounted but answering a tagged 503, so the Admin page can say the registry is
   * unavailable rather than the route having vanished.
   */
  app.route(
    "/api/admin/bot-services",
    botServiceAdminRoutes(requireUser, botServices, auditStore),
  );

  /*
   * The registry's credential surface (Bifrost #235, 04.2): issue, rotate, revoke and read the
   * masked status of a Bot's service credential, administrator-only. This is the one place a
   * credential's plaintext is ever handed out — once, in the issue and rotate responses. Mounted
   * beside 04.1's routes under the same prefix; without a composed registry it answers a tagged
   * 503 rather than vanishing.
   */
  app.route(
    "/api/admin/bot-services",
    botServiceCredentialRoutes(requireUser, botServices),
  );

  /*
   * The Bot-facing surface (Bifrost #235, 04.2): the single authenticated door a Bot's server
   * presents its service credential at. It answers "which Bot am I" and, since 04.3, carries the
   * binding-code issuance surface the registry composed — mounted on the same guard, so only an
   * authenticated Bot service identity can reach issuance. Since 05.3 (#244) it also carries the
   * short-lived virtual key claim surface the registry composed: a Bot presents an authorization
   * (grantId) and receives that user × Bot authorization's own key — the plaintext riding only
   * here, to the authenticated Bot service. Fail-closed in both directions — no registry, no
   * door; no valid credential, one uniform refusal that says nothing about whether a botId exists.
   */
  app.route(
    "/api/bot-service",
    botServiceRoutes(
      botServices && "authenticate" in botServices && botServices.authenticate
        ? {
            authenticate: botServices.authenticate,
            bindingCodes: botServices.bindingCodes,
            keys: "keys" in botServices ? botServices.keys : undefined,
          }
        : undefined,
    ),
  );

  /*
   * The model access confirmation surface (Bifrost #238, 04.5): a signed-in person's own two-step
   * authorization — preview what a one-time binding code names, then confirm it into a grant. The
   * service rides the composed registry (the seam 04.3's binding codes ride), so a deployment that
   * built only the bare 04.1 store answers a tagged 503 here rather than a confirmation flow with
   * no registry behind it. Nothing on this mount takes a user or an identity from a request: the
   * user is always the session's, the identity always the code's own (AC03).
   */
  app.route(
    "/api/model-access",
    accessGrantRoutes(
      requireUser,
      botServices && "modelAccess" in botServices
        ? botServices.modelAccess
        : undefined,
    ),
  );

  /*
   * The workbench model picker surface (Bifrost 03.10, #232): a signed-in person's own
   * selectable-model list with price display status, and the effective resolution naming
   * the layer it came from — plus the one write that stores a preference layer through
   * 03.9's validated service. The Bot context is the built-in workbench Bot (04.8),
   * resolved live in the registry the same way the confirmation flow above resolves its
   * seam; a deployment with no registry answers a tagged 503 rather than an empty list.
   * No answer here ever substitutes a model: an unavailable selection rides the stored
   * ref with its closed-vocabulary reason, and the screen prompts a re-selection.
   */
  app.route(
    "/api/model-selection",
    createModelSelectionRoutes(requireUser, botServices ?? undefined),
  );

  /*
   * The bot-facing model discovery surface (Bifrost 03.11, #233): an
   * authenticated Bot service's one read of the open catalog — its
   * capability-matching, open, priced models with price display status, plus
   * the capability-matching models not currently offered with their one
   * closed-vocabulary reason. The door is 04.2's service guard (the same
   * authenticate the /api/bot-service mount extracts), so an unauthenticated
   * caller gets one uniform 401 and a deployment with no registry gets the
   * tagged 503 door, never an empty answer. The response is the frozen
   * downstream contract (05.3 key issuance, 07.x pre-call validation): 03.8's
   * result named with 03.10's fields, no administrator configuration,
   * credential or other person's preference ever in the body.
   */
  app.route(
    "/api/model-discovery",
    createModelDiscoveryRoutes(
      botServices && "authenticate" in botServices && botServices.authenticate
        ? { authenticate: botServices.authenticate, botServices }
        : undefined,
    ),
  );

  /*
   * The gateway admin credential (Bifrost 01.2, #208): write and rotate the deployment's own key
   * for the Bifrost management surface, and read its redacted status. Write-only by construction:
   * no route here — and none may grow — returns the key; only the service's
   * `resolveGatewayAdminCredential` decrypts, for server-side trusted code, and 01.5 mounts the
   * probe that uses it. Resolved through the installed service rather than a createApp parameter:
   * the wiring installs it before the app is built (index.ts), and a test that never did reads a
   * tagged 503 — no signature seat moves, which the tail-parameter arithmetic in
   * identity-app-wiring.test.ts depends on.
   */
  app.route(
    "/api/admin/gateway/credential",
    gatewayAdminCredentialRoutes(requireUser, gatewayAdminCredentialControls()),
  );

  /*
   * The rest of the gateway surface (Bifrost 01.8, #214): the read-only status diagnostic and
   * the endpoint/rate/probe actions the administrator's screen drives. The services resolve
   * through the installed controls at request time (no new createApp parameter), the routes are
   * administrator-only, and the status answers the credential's fingerprint, never its key.
   */
  app.route("/api/admin/gateway", gatewayAdminRoutes(requireUser));

  /*
   * The gateway readiness gate (Bifrost 01.7, #213): the one door every paid
   * model capability passes. Installed here, in the dependency container,
   * because this is where the deployment configuration lives — the
   * environment's conversion rate (`config.gateway.creditConversionRate`, the
   * rate 01.4's store serves until an administrator saves one) reaches the
   * gate only through this scope. The five conditions resolve through the
   * installed services (endpoint 01.1, credential 01.2) and the shared
   * settings rows (probe 01.5, negotiation 01.6, rate 01.3/01.4); the gate
   * itself never dials the network. A test app without enterprise controls
   * installs it all the same and every condition answers fail-closed, which
   * is the point: paid work needs an installed gate AND a ready gateway, and
   * missing pieces refuse — no provider direct connection, no free usage.
   */
  installGatewayReadinessService(
    createGatewayReadinessService({
      readGatewayEndpoint: async () => {
        const endpoint = gatewayEndpointControls();
        return endpoint ? endpoint.readGatewayEndpoint() : undefined;
      },
      resolveGatewayAdminCredential: async () => {
        const credential = gatewayAdminCredentialControls();
        if (!credential) {
          throw new GatewayAdminCredentialNotConfiguredError(
            "The gateway admin credential is not configured.",
          );
        }
        return credential.resolveGatewayAdminCredential();
      },
      readLastGatewayProbe: async () => {
        const controls = enterpriseControls();
        return controls
          ? createEnterpriseGatewayProbeStore(
              controls.deps.database,
            ).readGatewayProbeResult()
          : undefined;
      },
      readLastGatewayNegotiation: async () => {
        const controls = enterpriseControls();
        if (!controls) return undefined;
        // The negotiation service's reader, not the raw row: a verdict
        // answers only for the configuration it decided against, and the
        // retirement rule lives there (01.6), not here.
        return createGatewayCapabilityNegotiationService({
          store: createEnterpriseGatewayNegotiationStore(
            controls.deps.database,
          ),
          readGatewayEndpoint: async () => {
            const endpoint = gatewayEndpointControls();
            return endpoint ? endpoint.readGatewayEndpoint() : undefined;
          },
          resolveGatewayAdminCredential: async () => {
            const credential = gatewayAdminCredentialControls();
            if (!credential) {
              throw new GatewayAdminCredentialNotConfiguredError(
                "The gateway admin credential is not configured.",
              );
            }
            return credential.resolveGatewayAdminCredential();
          },
        }).readLastGatewayNegotiation();
      },
      readConversionRate: async () => {
        const controls = enterpriseControls();
        if (!controls) return notConfiguredConversionRateState();
        return createConversionRateStore({
          database: controls.deps.database,
          environmentRate: config.gateway?.creditConversionRate,
        }).readConversionRate();
      },
    }),
  );

  app.get("/api/settings/instructions", requireUser, async (context) => {
    if (!userInstructions) {
      return context.json(
        { error: "Standing instructions are not available." },
        503,
      );
    }

    return context.json({
      // "" is what having written none looks like to a text box, and the store's null is what it
      // looks like to a database. The translation happens once, here.
      instructions: (await userInstructions.read(context.var.actor.id)) ?? "",
    });
  });
  app.put("/api/settings/instructions", requireUser, async (context) => {
    if (!userInstructions) {
      return context.json(
        { error: "Standing instructions are not available." },
        503,
      );
    }

    const body = (await context.req.json().catch(() => undefined)) as
      | { instructions?: unknown }
      | undefined;

    if (typeof body?.instructions !== "string") {
      return context.json({ error: "Send the instructions to save." }, 400);
    }

    /*
     * The cap is the store's rule, so the store is what enforces it and this catches the refusal
     * rather than checking the length again. A second copy of `> 4000` here is a second place for
     * the number to be changed in only one of them.
     */
    let saved: string;
    try {
      saved = await userInstructions.write(
        context.var.actor.id,
        body.instructions,
      );
    } catch (error) {
      if (error instanceof InstructionsTooLongError) {
        return context.json({ error: error.message }, 400);
      }
      throw error;
    }

    /*
     * The trail records that they changed and how long they now are, NEVER what they say.
     *
     * The audit table is append-only and read by administrators, and this is a person's own note
     * about how they want to be spoken to. Recording the text would put it somewhere they cannot
     * edit it and somebody else can read it, which is not what a preferences screen promises. The
     * length is enough to answer the question a trail is for: when did this change, and to what
     * extent.
     */
    if (auditStore) {
      await recordAuditEvent(auditStore, {
        eventType: "configuration.changed",
        targetType: "user_instructions",
        targetId: context.var.actor.id,
        actorUserId: context.var.actor.id,
        payload: {
          change: saved === "" ? "instructions_cleared" : "instructions_saved",
          characters: saved.length,
          limit: INSTRUCTIONS_LIMIT,
        },
      });
    }

    return context.json({ instructions: saved });
  });
  if (learning) {
    app.route(
      "/api/admin/learning",
      createLearningRoutes(
        learning,
        requireUser,
        [
          ...(config.auth?.trustedOrigins ?? []),
          ...(config.appUrl ? [config.appUrl] : []),
        ],
        auditStore,
      ),
    );
  }
  app.get("/api/admin/status", requireUser, (context) => {
    const denied = requireAdmin(context);
    return denied ?? context.json({ status: "ok" });
  });
  app.get("/api/admin/audit-events", requireUser, async (context) => {
    const denied = requireAdmin(context);
    if (denied) {
      return denied;
    }
    if (!auditReader) {
      return context.json({ error: "Audit logging is not configured." }, 503);
    }

    try {
      const url = new URL(context.req.url);
      const format = url.searchParams.get("format");
      if (
        format !== null &&
        format !== "" &&
        format !== "json" &&
        format !== "csv"
      ) {
        return context.json(
          { error: 'Query parameter "format" must be "json" or "csv".' },
          400,
        );
      }
      /*
       * The export answers the same filtered query as the list — `eventType`,
       * `actorUserId`, `initiatorKind`, `targetType`, `targetId`, `from`, `to` — so the
       * downloaded file and the table agree. Paging (`cursor`, `limit`) belongs to the
       * JSON list and is ignored here; the export walks every matching page up to the
       * cap in `readAuditExportRows` and names the file after the day it was pulled.
       */
      if (format === "csv") {
        const query = auditQueryFromUrl(url);
        const { events, truncated } = await readAuditExportRows(
          auditReader,
          query,
        );
        if (auditStore) {
          const { cursor: _cursor, limit: _limit, ...filters } = query;
          await recordAuditEvent(auditStore, {
            eventType: "audit.exported",
            targetType: "audit_trail",
            actorUserId: context.var.actor.id,
            payload: { format: "csv", rows: events.length, truncated, filters },
          });
        }
        const day = new Date().toISOString().slice(0, 10);
        context.header("Content-Type", "text/csv; charset=utf-8");
        context.header(
          "Content-Disposition",
          `attachment; filename="audit-events-${day}.csv"`,
        );
        // The row count it stopped at, so the page can say how much the file holds.
        if (truncated) {
          context.header("X-Audit-Export-Truncated", String(events.length));
        }
        return context.body(auditEventsToCsv(events));
      }
      return context.json(await auditReader.list(auditQueryFromUrl(url)));
    } catch (error) {
      if (error instanceof AuditQueryError) {
        return context.json({ error: error.message }, 400);
      }
      throw error;
    }
  });
  /*
   * Who is here, and what they may do.
   *
   * Administrator-only, like every other route in this group. A plain user reading the list would
   * learn every colleague's address and when they last signed in, which is not theirs to have.
   */
  app.get("/api/admin/people", requireUser, async (context) => {
    const denied = requireAdmin(context);
    if (denied) {
      return denied;
    }
    if (!peopleStore) {
      return context.json({ error: "People are not available." }, 503);
    }

    /*
     * A page, not the deployment.
     *
     * `limit` is parsed strictly and clamped into range at the edge, against the same ceiling the
     * store enforces, so a caller cannot ask for everybody by naming a large number and a typo
     * like `12abc` is a 400 rather than a silently coerced page. `search` is what makes paging
     * usable: an administrator looking for one colleague should not have to walk pages to reach
     * them.
     */
    const url = new URL(context.req.url);
    const parsed = parsePageLimit(url.searchParams.get("limit"), MAX_PAGE);
    if (!parsed.ok) {
      return context.json({ error: parsed.error }, 400);
    }
    // An unbounded `search` becomes a `%...% ILIKE` full scan. Cap it so a multi-megabyte
    // query cannot be used as a cheap denial of service against the people table.
    const search = url.searchParams.get("search");
    if (search !== null && search.length > 200) {
      return context.json(
        { error: "A search of at most 200 characters is required." },
        400,
      );
    }

    return context.json(
      await peopleStore.list({
        ...(url.searchParams.get("search")
          ? { search: url.searchParams.get("search") as string }
          : {}),
        ...(url.searchParams.get("cursor")
          ? { cursor: url.searchParams.get("cursor") as string }
          : {}),
        ...(parsed.limit !== undefined ? { limit: parsed.limit } : {}),
      }),
    );
  });

  app.post("/api/admin/people/:userId/role", requireUser, async (context) => {
    const denied = requireAdmin(context);
    if (denied) {
      return denied;
    }
    if (!peopleStore) {
      return context.json({ error: "People are not available." }, 503);
    }

    const body = await context.req.json().catch(() => null);
    const role = (body as { role?: unknown } | null)?.role;
    if (role !== "admin" && role !== "user") {
      return context.json(
        { error: "A role of admin or user is required." },
        400,
      );
    }

    const userId = context.req.param("userId");
    const person = await peopleStore.find(userId);
    if (!person) {
      return context.json({ error: "That person is not here." }, 404);
    }

    /*
     * The configured floor wins over the screen.
     *
     * Somebody named in INITIAL_ADMIN_EMAILS is promoted again at their next sign-in whatever this
     * route writes, so allowing the demotion would produce a screen that lies until they come back.
     * Refusing says the real thing: change the deployment's configuration.
     */
    if (person.configuredAdmin && role !== "admin") {
      return context.json(
        {
          error:
            "This deployment names that address in INITIAL_ADMIN_EMAILS, so they stay an administrator. Change the configuration instead.",
        },
        409,
      );
    }

    /*
     * Nobody demotes themselves.
     *
     * An administrator who does has just locked themselves out of the screen that would undo it,
     * and on a deployment with one administrator that is the whole deployment. Somebody else with
     * the role can do it, which is the check that makes handover possible without making lockout
     * a slip of the finger.
     */
    if (context.var.actor.id === userId && role !== "admin") {
      return context.json(
        { error: "You cannot remove your own administrator role." },
        409,
      );
    }

    if (person.role !== role) {
      const identity = coworker?.directory?.identity;
      if (identity) {
        // T05.07: the screen's role change is the identity command; without
        // the executor the legacy write and DTO answer exactly as before.
        const refusal = await runIdentityCommand(identity, context, {
          operation: "identity.role.set",
          targetUserId: userId,
          payload: {
            role,
            reason: `admin screen: role ${person.role} -> ${role}`,
          },
        });
        if (refusal) return refusal;
      } else {
        await peopleStore.setRole(userId, role);
      }
      await recordPersonEvent(
        auditStore,
        context,
        "person.role_changed",
        person,
        {
          from: person.role,
          to: role,
        },
      );
    }

    return context.json({ person: await peopleStore.find(userId) });
  });

  app.post("/api/admin/people/:userId/access", requireUser, async (context) => {
    const denied = requireAdmin(context);
    if (denied) {
      return denied;
    }
    if (!peopleStore) {
      return context.json({ error: "People are not available." }, 503);
    }

    const body = await context.req.json().catch(() => null);
    const revoked = (body as { revoked?: unknown } | null)?.revoked;
    if (typeof revoked !== "boolean") {
      return context.json({ error: "revoked must be true or false." }, 400);
    }

    const userId = context.req.param("userId");
    const person = await peopleStore.find(userId);
    if (!person) {
      return context.json({ error: "That person is not here." }, 404);
    }

    // The same floor, for the same reason: removing somebody the configuration names would last
    // until their next sign-in and no longer.
    if (person.configuredAdmin && revoked) {
      return context.json(
        {
          error:
            "This deployment names that address in INITIAL_ADMIN_EMAILS, so they cannot be removed here. Change the configuration instead.",
        },
        409,
      );
    }

    // Nobody can remove themselves. An administrator who does has locked themselves out of the
    // screen that would undo it.
    if (revoked && context.var.actor.id === userId) {
      return context.json({ error: "You cannot remove your own access." }, 409);
    }

    if (person.revoked !== revoked) {
      const identity = coworker?.directory?.identity;
      /*
       * The identity command first (T05.07): the disable/restore is the
       * disciplined write — one transaction owns the principal's suspension
       * or revival, the generation advance and every session's death — and
       * the blocklist half below is the screen's own sign-in block, which
       * the command adds to rather than replaces. A refused command writes
       * nothing at all, refusal included. Without the executor the legacy
       * writes answer exactly as before.
       */
      const identityCommand = identity
        ? await runIdentityCommand(identity, context, {
            operation: revoked ? "identity.disable" : "identity.restore",
            targetUserId: userId,
            payload: {
              reason: revoked
                ? "admin screen: access revoked"
                : "admin screen: access restored",
            },
          })
        : undefined;
      if (identityCommand) return identityCommand;
      if (revoked) {
        await peopleStore.revoke(userId, context.var.actor.id);
      } else {
        await peopleStore.restore(userId);
      }
      await recordPersonEvent(
        auditStore,
        context,
        revoked ? "person.access_revoked" : "person.access_restored",
        person,
        {},
      );
    }

    if (revoked) {
      await peopleStore.retireOwned(userId, context.var.actor.id);
      // T33: ending a person's access ends their observation authorization
      // too — queued export work is cancelled rather than left to fetch under
      // an authorization that no longer exists. Best-effort by design: the
      // worker re-authorizes per execution and drops what this call missed.
      if (aiObservabilityCancelForActor) {
        try {
          await aiObservabilityCancelForActor(userId);
        } catch (error) {
          // T33: best-effort beside the revoke — the worker's reauthorization
          // is the backstop that catches a missed cancellation — but not
          // SILENT (OCR R5-40): the same operation in index.ts's
          // deletionShutdown logs opik-export-cancel-failed with the userId,
          // and an administrator tracing a cancellation that missed needs the
          // same fact here. Same key, same fields, never a 500.
          log.warn(
            {
              err: error,
              type: "opik-export-cancel-failed",
              userId,
            },
            "opik-export-cancel-failed",
          );
        }
      }
    }

    return context.json({ person: await peopleStore.find(userId) });
  });

  /*
   * The identity providers this deployment has registered.
   *
   * Not Better Auth's own `GET /sso/providers`, which answers with the ones the person asking
   * registered themselves. Two administrators therefore saw two different deployments: the second
   * one to open this screen found it empty and registered a provider that was already there. What is
   * registered is a fact about the deployment, so every administrator sees the same list.
   */
  app.get("/api/admin/identity-providers", requireUser, async (context) => {
    const denied = requireAdmin(context);
    if (denied) {
      return denied;
    }
    if (!identityProviders) {
      return context.json(
        { error: "Identity providers are not available." },
        503,
      );
    }

    return context.json({ providers: await identityProviders.list() });
  });

  /*
   * Remove one.
   *
   * Ours rather than Better Auth's `delete-provider`, which refuses unless the person asking is the
   * one who registered it. That leaves a provider nobody can remove as soon as the administrator who
   * set it up has left, which is the same moment somebody most needs to.
   */
  app.delete(
    "/api/admin/identity-providers/:providerId",
    requireUser,
    async (context) => {
      const denied = requireAdmin(context);
      if (denied) {
        return denied;
      }
      if (!identityProviders) {
        return context.json(
          { error: "Identity providers are not available." },
          503,
        );
      }

      const providerId = context.req.param("providerId");
      const removed = await identityProviders.remove(providerId);
      if (!removed) {
        // A screen somebody left open, or two administrators removing the same one. Saying so beats
        // reporting success for something that was not there.
        return context.json({ error: "There is no such provider." }, 404);
      }

      if (auditStore) {
        await recordAuditEvent(auditStore, {
          eventType: "identity_provider.removed",
          targetType: "identity_provider",
          targetId: providerId,
          actorUserId: context.var.actor.id,
          payload: { removedBy: context.var.actor.email },
        });
      }

      return context.json({ removed: true });
    },
  );

  app.get("/api/admin/credentials", requireUser, async (context) => {
    const denied = requireAdmin(context);
    if (denied) {
      return denied;
    }
    if (!credentialService) {
      return context.json(
        { error: "Credential storage is not configured." },
        503,
      );
    }

    return context.json({ credentials: await credentialService.list() });
  });
  app.post("/api/admin/credentials", requireUser, async (context) => {
    const denied = requireAdmin(context);
    if (denied) {
      return denied;
    }
    if (!credentialService) {
      return context.json(
        { error: "Credential storage is not configured." },
        503,
      );
    }

    const body = await context.req.json().catch(() => null);
    const input = credentialInput(body, context.var.actor.id);
    if (!input) {
      return context.json({ error: "Credential input is invalid." }, 400);
    }

    return context.json(
      { credential: await credentialService.create(input) },
      201,
    );
  });
  app.post(
    "/api/admin/credentials/:credentialId/rotate",
    requireUser,
    async (context) => {
      const denied = requireAdmin(context);
      if (denied) {
        return denied;
      }
      if (!credentialService) {
        return context.json(
          { error: "Credential storage is not configured." },
          503,
        );
      }

      const body = await context.req.json().catch(() => null);
      const input = credentialInput(body, context.var.actor.id);
      if (!input) {
        return context.json({ error: "Credential input is invalid." }, 400);
      }

      try {
        return context.json({
          credential: await credentialService.rotate({
            ...input,
            previousCredentialId: context.req.param("credentialId"),
          }),
        });
      } catch (error) {
        if (error instanceof CredentialRefusedError) {
          return context.json({ error: error.message }, error.status);
        }
        throw error;
      }
    },
  );
  app.post(
    "/api/admin/credentials/:credentialId/revoke",
    requireUser,
    async (context) => {
      const denied = requireAdmin(context);
      if (denied) {
        return denied;
      }
      if (!credentialService) {
        return context.json(
          { error: "Credential storage is not configured." },
          503,
        );
      }

      try {
        return context.json({
          credential: await credentialService.revoke(
            context.req.param("credentialId"),
            context.var.actor.id,
          ),
        });
      } catch (error) {
        // Not found or already revoked: the second click on Revoke, answered as what it is.
        if (error instanceof CredentialRefusedError) {
          return context.json({ error: error.message }, error.status);
        }
        throw error;
      }
    },
  );
  app.get("/api/admin/package", requireUser, async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    if (!packageStatusReader) {
      return context.json({ error: "Tenant package is not configured." }, 503);
    }
    return context.json({ package: await packageStatusReader.active() });
  });
  /*
   * Where the worker hands a routine run back. Not under /api and not behind requireUser: the
   * worker is not a person with a session, it is another process on this deployment's own network,
   * and the shared secret below is its whole credential.
   *
   * Mounted only when a runner was built, so a deployment that never stood up a worker has no door
   * for this at all, rather than one that is mounted and permanently refuses.
   */
  if (routineRunner) {
    app.post("/internal/routines/run", async (context) => {
      const offered = context.req.header("authorization");
      const expected = config.workerSharedSecret
        ? `Bearer ${config.workerSharedSecret}`
        : null;
      /*
       * The no-secret-configured case is refused here, before any comparison, and with the exact
       * same response as a wrong secret. A deployment with no worker must not answer a guess any
       * differently than a deployment with a worker and a wrong key would.
       */
      if (!expected || !offered || !sameToken(offered, expected)) {
        /*
         * Recorded, because this is a boundary being held and every other one here leaves a row. A
         * worker with a stale or missing secret used to fail here in total silence: every routine
         * stopped firing and nothing anywhere said why, the same false negative `mcp.callback_refused`
         * exists to catch on the sibling unauthenticated boundary above.
         *
         * The reason is short and lives only in the row, never on the wire: the response below stays
         * byte-identical across all three causes on purpose (see the comment above), so this is the
         * one place the distinction is allowed to exist. The offered credential itself is never
         * recorded, not even a fragment of it.
         */
        if (auditStore) {
          try {
            await recordAuditEvent(auditStore, {
              eventType: "routines.dispatch_refused",
              targetType: "worker",
              initiator: DEPLOYMENT_INITIATOR,
              payload: {
                reason: !expected
                  ? "unconfigured"
                  : !offered
                    ? "missing-header"
                    : "mismatch",
                note: "A worker's bearer secret did not check out, so no routine run was dispatched.",
              },
            });
          } catch (error) {
            // Never fatal: the 401 above is already decided and sent. A trail that is briefly
            // unavailable is not a reason to turn a refusal into a 500.
            log.error(
              {
                type: "routine-dispatch-audit-write-failed",
                error: String(error),
              },
              "routine-dispatch-audit-write-failed",
            );
          }
        }
        return context.json({ error: "This endpoint is the worker's." }, 401);
      }
      const body = await context.req.json().catch(() => null);
      const routineRunId = (body as { routineRunId?: unknown } | null)
        ?.routineRunId;
      // An empty id is a string and used to answer 202 Accepted while the worker swallows the
      // failure. Only a non-empty id is accepted for dispatch.
      if (typeof routineRunId !== "string" || !routineRunId.trim()) {
        return context.json({ error: "A routineRunId is required." }, 400);
      }
      // ME09: the firing's durable identity, when the worker carries one —
      // the offer key the queue deduplicated on. Shape-checked, never
      // trusted as authorization (the scheduling record decides that); it
      // only names WHICH firing this is so a redelivery converges.
      const firingKey = (body as { firingKey?: unknown } | null)?.firingKey;
      const firing =
        typeof firingKey === "string" &&
        firingKey.trim() &&
        firingKey.length <= 200
          ? { firingKey: firingKey.trim() }
          : undefined;
      /*
       * Fire and answer: the consumer needs "accepted", not the outcome. The run row in
       * `routine_runs` carries the outcome, and the consumer finishes the work item on this 202.
       * Queue retries exist for DISPATCH failures only — a failed turn is final for this firing, and
       * the fatigue rule owns it. `run()` never throws by contract; this swallow only guards against
       * that contract being wrong without turning a bug there into an unhandled rejection here.
       */
      // The worker's bearer dispatch is an API surface, not a person's session. This route is
      // deliberately not under /api/* (see the comment above it), so no session `web` floor
      // applies here — naming `api` is what puts the turns this fans out on their usage facts
      // at all. The helper owns the fire-and-forget swallow and its one diagnostic log line
      // (#706 M-3).
      fireRoutineDispatch(routineRunner, routineRunId, firing);
      return context.json({ accepted: true }, 202);
    });
  }
  // The CopilotKit runtime, behind the same session guard as every other API route. Mounted last so
  // its own routing under /api/copilotkit cannot shadow an OpenBot route declared above.
  if (copilotHandler) {
    // 09.2: the workbench surface binds its payer inside the same request context the runner
    // already establishes — after the tenancy middleware has put this request's entry business
    // on the context, so the binding is the company the server issued the scope for, never a
    // header's claim. A request with no entry business passes through unbound.
    const workbenchPayerMiddleware = workbenchPayer
      ? createWorkbenchPayerMiddleware(workbenchPayer)
      : undefined;
    const runnerContext: MiddlewareHandler = async (context, next) => {
      const run = () => withRunnerRequestContext(context.req.raw, next);
      return workbenchPayerMiddleware
        ? workbenchPayerMiddleware(context, run)
        : run();
    };
    app.use("/api/copilotkit", runnerContext);
    app.use("/api/copilotkit/*", runnerContext);
    // Mounted at the ROOT with the handler carrying its own basePath. Mounting it at
    // "/api/copilotkit" as well double-prefixes it: Hono strips the prefix before the handler sees
    // the path, so every route lands at /api/copilotkit/api/copilotkit/* and /info 404s. The browser
    // reports that as "Runtime info request failed with status 404" and every run fails before it
    // starts, with nothing at all in the server log.
    app.route("/", copilotHandler);
  }

  /**
   * May this person act as this Bot?
   *
   * The store's own read path already applies `canAccessAgent`, so asking it for the Bot is the same
   * question the roster and the runtime ask, rather than a second copy of the rule.
   *
   * A deployment with no profile store has no agents table and therefore no private Bot to protect:
   * its Bots come from the tenant package and are public to everybody who can sign in. Answering yes
   * there keeps that deployment working without weakening one that has owners.
   */
  const canUseBot: BotAccessCheck = agentProfileStore
    ? async (actor, botId) =>
        (await agentProfileStore.get(actor, botId)) !== null
    : async () => true;

  // The Bot computer. Acting on a page needs the gateway and the policy it enforces, so both arrive
  // together or the routes are not mounted. An ungoverned computer is not a reduced feature. It is
  // the one shape of this feature that must not exist.
  if (computerGateway && computerPolicy) {
    app.route(
      "/api/computers",
      createComputerRoutes(
        computerGateway,
        computerPolicy,
        requireUser,
        // Not `canUseBot`: a Team Bot's teammates use the Bot, not its owner's signed-in computer.
        agentProfileStore ? computerAccessCheck(agentProfileStore) : canUseBot,
        pageFrames,
        auditReader,
      ),
    );
  }

  if (codeRunGatewayFactory)
    app.route(
      "/api/codesandbox",
      createCodeSandboxRoutes(requireUser, canUseBot, codeRunGatewayFactory),
    );

  /*
   * The workshop, beside the code interpreter it extends: same canUseBot gate, same
   * requireUser shell, mounted after its short-form sibling so the two surfaces read as a
   * pair. A factory (not a router) because the wiring — store, lock, bus, orchestrator — is
   * one assembly decision with a Redis branch that belongs to the boot file, not here.
   */
  if (workshopRoutes)
    app.route("/api/workshop", workshopRoutes({ requireUser, canUseBot }));

  /*
   * Observation, mounted as one unit. Every later observation ticket adds a sub-router
   * inside ai-observability/routes/index.ts, so this stays the only observation line here.
   */
  if (aiObservability) app.route("/api/ai-observability", aiObservability);

  // The anonymous sibling, beside the owner surface it shares a vocabulary with: same
  // /api/public/workshop prefix the share page fetches, no session, no canUseBot — the
  // token is the only key (see sharing.ts's "the one exception" head).
  if (publicWorkshopRoutes)
    app.route("/api/public/workshop", publicWorkshopRoutes());

  /*
   * Craft, after the workshop pair it sits beside in the product's mind: sessions,
   * send-message, SSE turn streams — the autonomous-build surface, behind requireUser only
   * (its sandbox routing is deployment-level, not Bot-scoped, so there is no canUseBot
   * question to answer here; the tree's own enabled gate answers the rest).
   */
  if (craftRoutes) app.route("/api/craft", craftRoutes({ requireUser }));

  if (hostAccessBroker) {
    app.route(
      "/api/host-access",
      createHostAccessRoutes({
        broker: hostAccessBroker,
        desktopToken: desktopHostToken,
        requireUser,
        canUseBot,
        auditStore,
        botName: agentProfileStore
          ? async (botId, actor) =>
              (await agentProfileStore.get(actor, botId))?.name ?? null
          : undefined,
      }),
    );
  }

  if (agentProfileStore) {
    /*
     * The marketplace, beside the agents routes: an expert install writes a Bot through the same
     * profile store, and the receipt store arrives on the coworker object beside it.
     */
    if (coworker?.marketplace) {
      /*
       * MOD16 (#636): the marketplace's writes go through the owner facades —
       * coworker.botCatalog wraps the same profile store this layer guards on (one
       * instance, identity delegation), and the ToolAccess here is built on the same
       * plugin store, so every write path is byte-for-byte the store call it was.
       */
      app.route(
        "/api/marketplace",
        createMarketplaceRoutes({
          installs: coworker.marketplace.installs,
          agents: coworker.botCatalog,
          ...(pluginStore
            ? {
                grants: createToolAccess({ store: pluginStore }),
                skillWrites: createToolAccess({ store: pluginStore }),
              }
            : {}),
          auditStore,
          requireUser,
        }),
      );
    }
    app.route(
      "/api/agents",
      createAgentRoutes(
        agentProfileStore,
        requireUser,
        // The same stance the computer uses: a laptop legitimately talks to its own services, a hosted
        // deployment must not. Passed from configuration rather than defaulted here, so "hosted and
        // permissive" cannot happen by forgetting something.
        config.computer?.allowPrivateHosts ?? false,
        // A Bot's own refusal goes in the same trail as everything else it does.
        auditStore,
        // Addresses this deployment named, which is how a hosted one reaches an agent on its own
        // network without dropping the floor for everything else.
        config.agentEndpointAllowedHosts,
        /*
         * What the Bot's own screen needs to show, and change, which Bots it may hand work to.
         *
         * Read per request rather than captured, for the reason the desk reads it per hop: a grant
         * made a minute ago counts and one revoked a minute ago stops counting. Absent with no
         * plugin store, which is a deployment where no Bot may address any other.
         */
        pluginStore
          ? {
              enabled:
                config.handoff.maxDepth > 0 && config.handoff.maxPerRun > 0,
              reachableFrom: (agentId) =>
                pluginStore.botsReachableFrom(agentId),
              // The same answer the write path checks, read up front so the screen can say it once.
              canHandOn: (agentId) => pluginStore.agentCanHandOn(agentId),
            }
          : undefined,
        // Whether "built-in" is a kind of coworker this deployment can actually make: the create
        // path falls back to the managed Bot's endpoint, so without one it can only refuse.
        config.managedAgent?.endpoint !== undefined,
        // The managed Bot's address, so a coworker created without an endpoint — which creation
        // stores as running at this address — can be told apart from one a person hosts.
        config.managedAgent?.endpoint?.toString(),
        coworker?.shared?.use,
      ),
    );
    // Choosing a coworker for an untagged message needs the same permission-filtered roster the
    // agents routes read, so it is mounted here where that store is in scope. Only when a router was
    // configured; without one the composer keeps sending untagged messages to the default.
    if (intentRouter) {
      app.route(
        "/api/route",
        createRoutingRoutes(
          createCoworkerRoutingService({
            store: agentProfileStore,
            router: intentRouter,
            auditStore,
            /*
             * Which vendors each coworker holds tools for, so the router weighs what a coworker can
             * reach and not only what somebody wrote it was for. Only when there is a plugin store to
             * ask: a deployment with no connectors routes exactly as it did.
             */
            reachableSystems: pluginStore
              ? async (agentId) => {
                  const granted = await pluginStore.listForAgent(agentId);
                  return [
                    ...new Set(
                      granted.tools.map(
                        (tool) =>
                          tool.toolName.replace(/^mcp__/, "").split("__")[0] ??
                          tool.toolName,
                      ),
                    ),
                  ];
                }
              : undefined,
          }),
          requireUser,
        ),
      );
    }
  }

  /*
   * The OpenMuse account fence (D01, contracts §9): one shared guard in front
   * of the whole /api/mobile prefix, standing before the mobile-bff mount and
   * every openmuse-* sub-app mount below it. A user carrying the deletion
   * marker is refused 403 with the stable code before any family runs;
   * unauthenticated requests keep the guards' own 401. The delete route is
   * registered BEFORE the fence on purpose: it is the route that writes the
   * marker, so a repeated delete after the marker exists must still answer
   * (idempotently, insert-once) rather than be fenced by its own act.
   */
  if (openMuseAccountDeletion) {
    app.route(
      "/api/mobile/openmuse-account",
      createOpenMuseAccountDeletionRoutes({
        requireUser,
        store: openMuseAccountDeletion,
        // D02/D03/D04 wired (ocr-ob-certify findings 15/16): the shutdown,
        // the external revocation and the manifest run behind the marker, and
        // the owner's auth sessions go with it (the fence's tracked exposure
        // — channels/computer/copilot read no marker, so the session itself
        // is what has to die).
        ...(openMuseDeletionShutdown
          ? { shutdownOwnerWork: openMuseDeletionShutdown }
          : {}),
        ...(openMuseDeletionRevoke
          ? { revokeExternalAccess: openMuseDeletionRevoke }
          : {}),
        ...(openMuseDeletionManifest
          ? { buildManifest: openMuseDeletionManifest }
          : {}),
        ...(openMuseDeletionRevokeSessions
          ? { revokeSessions: openMuseDeletionRevokeSessions }
          : {}),
        ...(openMuseDeletionNoteBackupRetention
          ? { noteBackupRetention: openMuseDeletionNoteBackupRetention }
          : {}),
      }),
    );
    app.use(
      "/api/mobile/*",
      openMuseAccountFence({
        requireUser,
        isDisabled: openMuseAccountDeletion.isDisabled,
      }),
    );
  }

  /*
   * The OpenMuse document surface (F05/F06/F09), under the files prefix the
   * route contract names: mounted beside — but BEFORE — the mobile bff whose
   * family-wide 8 KiB body limit would otherwise answer every fill first
   * (round 6 H5: a two-field fill §5's per-field budget admits is ~20 KiB,
   * so the family 413 made F06 unusable for large values; this sub-app
   * carries its own 1 MB fill ceiling and 64 KiB transfer ceiling, plus its
   * own requireUser). Deliberately OUTSIDE the channelStore block (round 6
   * M4): the documents seams depend on no channel store, and a deployment
   * without channels must still mount its routes rather than silently skip
   * them. The /api/mobile fence above runs first either way.
   */
  if (openMuseDocuments) {
    app.route("/api/mobile/openmuse-files", openMuseDocuments);
  }

  if (channelStore) {
    app.route(
      "/api/channels",
      createChannelRoutes(channelStore, requireUser, channelEvents, auditStore),
    );
    /*
     * The mobile client's aggregation seam, mounted only where its two stores
     * already exist: it reads the same roster and the same conversations the
     * routes above answer, under the same guard, and a deployment without
     * channels has nothing for a mobile roster to list.
     */
    app.route(
      "/api/mobile",
      createMobileBffRoutes({
        requireUser,
        agentProfileStore,
        channelStore,
        workspace: createMobileBffWorkspace({
          agentProfileStore,
          channelStore,
        }),
        ...(agentProfileStore && openMuseTemplateStore
          ? {
              openMuseProvisioner: createOpenMuseBotProvisioner({
                agentProfileStore: {
                  ...agentProfileStore,
                  ...openMuseTemplateStore,
                },
                /*
                 * A Bot's computer is keyed by the Bot's own id — the per-bot
                 * provider locates it lazily by botId and no separate computer
                 * profile row exists — so the id the template provisioned is
                 * the computer profile id.
                 */
                computerProfileIdFor: async (profile) => profile.id,
              }),
            }
          : {}),
        ...(coworker
          ? {
              activity: createMobileBffActivity({
                approvals: coworker.approvals,
                routines: routineStore,
              }),
            }
          : {}),
        ...(openMuseFiles
          ? {
              openMuseFiles: createOpenMuseFilesRoutes({
                store: openMuseFiles,
                requireUser,
              }),
            }
          : {}),
        ...(openMuseTasks && openMuseTemplateStore
          ? {
              openMuseTasks: createOpenMuseTasksRoutes({
                store: openMuseTasks,
                requireUser,
                resolvePrivateBotId: async (ownerUserId) =>
                  (
                    await openMuseTemplateStore.findByTemplateKey(
                      ownerUserId,
                      OPENMUSE_TEMPLATE_KEY,
                    )
                  )?.id ?? null,
                // T13/T15: the files seam finance and document tasks validate
                // their File inputs through at creation — without it the
                // routes answer 503 rather than writing rows that cannot run.
                ...(openMuseFiles ? { files: openMuseFiles } : {}),
              }),
            }
          : {}),
      }),
    );
  }

  /*
   * MT125 (Issue #168): the mobile aggregation's unified assembly — the one
   * entrance on the family whose read is scope-filtered (MT066's aggregate
   * over the three association gates). Mounted OUTSIDE the channelStore
   * block: it needs neither store, only the entry factory the assembly
   * wired; absent (enterprise capabilities unwired) mounts nothing.
   */
  if (coworker?.enterpriseMobileAggregate) {
    app.route("/api/mobile", coworker.enterpriseMobileAggregate);
  }

  /*
   * The OpenMuse Gmail consent surface (G01), mounted only where the assembly
   * built it: the session-guarded half under the mobile prefix its client
   * calls, and the public callback half Google redirects to. The callback is
   * deliberately NOT behind requireUser — its caller is Google — but the
   * sub-app resolves the session itself and refuses any callback whose
   * session is not the one that started the consent.
   */
  if (openMuseGoogleOAuth) {
    app.route("/api/mobile/openmuse-google", openMuseGoogleOAuth.app);
    app.route("/api/public/openmuse-google", openMuseGoogleOAuth.callback);
  }

  /*
   * The OpenMuse Mail read surface (M01), beside the Google consent surface it
   * depends on: the owner's Gmail messages, behind the session guard and the
   * G01 connection guard the router carries itself.
   */
  if (openMuseMail) {
    app.route("/api/mobile/openmuse-mail", openMuseMail);
  }

  /*
   * The OpenMuse Reviewed action surface (R01), beside the Mail surface whose
   * proposals it will one day execute: the §6 state machine behind the same
   * session guard, with the assembly-injected executor (the fake until R02).
   */
  if (openMuseReviewedActions) {
    app.route("/api/mobile/openmuse-reviewed-actions", openMuseReviewedActions);
  }

  /*
   * The OpenMuse private Goal surface (P01), beside the Reviewed action
   * surface: the owner's Goals behind the session guard the router carries
   * itself. goalLookupFor (the private Bot's read-only tool seam) lives in
   * the module, unwired until C07 ports the runtime's tool registry.
   */
  if (openMuseGoals) {
    app.route("/api/mobile/openmuse-goals", openMuseGoals);
  }

  /*
   * The OpenMuse Calendar read surface (A01), beside the Goal surface: the
   * owner's Calendar events behind the session guard and the G03 connection
   * guard the router carries itself — the branch a Gmail grant never
   * satisfies.
   */
  if (openMuseCalendar) {
    app.route("/api/mobile/openmuse-calendar", openMuseCalendar);
  }

  /*
   * The OpenMuse private Idea surface (P02), beside the Calendar surface:
   * the owner's Ideas behind the session guard the router carries itself.
   * ideaLookupFor (the private Bot's read-only tool seam) lives in the
   * module, unwired until C07 ports the runtime's tool registry.
   */
  if (openMuseIdeas) {
    app.route("/api/mobile/openmuse-ideas", openMuseIdeas);
  }

  /*
   * The OpenMuse private Memory surface (P03), beside the Idea surface: the
   * owner's Memories behind the session guard the router carries itself.
   * memoryLookupFor (the private Bot's read-only tool seam) lives in the
   * module, unwired until C07 ports the runtime's tool registry.
   */
  if (openMuseMemories) {
    app.route("/api/mobile/openmuse-memories", openMuseMemories);
  }

  /*
   * The OpenMuse Task notification surface (T12), beside the Memory surface:
   * the owner's notification feed behind the session guard the router
   * carries itself. Read and mark-read only — the events are emitted by the
   * task runner's transitions, never written here.
   */
  if (openMuseNotifications) {
    app.route("/api/mobile/openmuse-notifications", openMuseNotifications);
  }

  /*
   * The OpenMuse Activity feed (V01, contracts §8), beside the notification
   * surface: the owner's merged policy-approval and reviewed-action list,
   * behind the session guard the router carries itself. Every decision is
   * the owning module's own path — this surface aggregates, it never
   * decides.
   */
  if (openMuseActivity) {
    app.route("/api/mobile/openmuse-activity", openMuseActivity);
  }

  /*
   * The OpenMuse ops signals (O05, contracts §10), the operator's read-only
   * health surface: one aggregation over the feature seams, behind the
   * requireUser + requireAdmin double layer the router carries itself.
   */
  if (openMuseAccountDeletion && openMuseDeletionAdmin) {
    /*
     * D05/D06/D08/D09 (§9), mounted (ocr-ob-certify finding 20): without this
     * surface the 30-day restore window could never be exercised — the store's
     * only restore caller lived on this unmounted router — and the purge
     * convergence could never run, so markers fenced forever. Administrator
     * only, the template routes' own gate shape.
     */
    app.route(
      "/api/admin/openmuse-deletion",
      createOpenMuseDeletionAdminRoutes({
        requireUser,
        restore: openMuseDeletionAdmin.restore,
        ...(openMuseDeletionAdmin.purge
          ? { purge: openMuseDeletionAdmin.purge }
          : {}),
        ...(openMuseDeletionAdmin.purgeRelational
          ? { purgeRelational: openMuseDeletionAdmin.purgeRelational }
          : {}),
        ...(openMuseDeletionAdmin.cleanupView
          ? { cleanupView: openMuseDeletionAdmin.cleanupView }
          : {}),
      }),
    );
  }

  if (openMuseOpsSignals) {
    app.route("/api/admin/openmuse-ops", openMuseOpsSignals);
  }

  if (attachmentDatabase) {
    /*
     * `bodyLimit` sits in front of the upload route itself, not beside the mount below: the handler
     * in channels/attachments.ts calls `file.arrayBuffer()` before it has looked at a single byte of
     * size, so an unbounded body is read into memory in full before anything gets the chance to
     * refuse it. A person (or an attacker) posting a 2GB body would have it buffered in RAM before
     * the 413 the handler already knows how to return. `MAX_IMAGE_BYTES` is the largest thing this
     * route could ever legitimately accept — a text upload is refused smaller, inside the handler,
     * once the sniffed type is known — so refusing anything larger at the door costs nothing a real
     * upload was ever going to use.
     *
     * The ceiling is `UPLOAD_BODY_LIMIT_BYTES` and not `MAX_IMAGE_BYTES` itself because THIS GATE
     * MEASURES A DIFFERENT THING FROM EVERY OTHER ONE. See that constant.
     */
    const channelAttachments = new Hono<{ Variables: AppVariables }>();
    channelAttachments.use(
      "*",
      bodyLimit({
        maxSize: UPLOAD_BODY_LIMIT_BYTES,
        /*
         * THE REFUSAL AT THE DOOR HAS TO LOOK LIKE THE HANDLER'S OWN.
         *
         * hono's default `onError` answers with the plain string "Payload Too Large". The composer
         * (app/src/components/channels/composer/attachments.ts) reads `{ error }` off every failed
         * upload and falls back to a generic `Could not upload "<name>"` when the body will not
         * parse as JSON — so the default body cost the person the one sentence that would have told
         * them what went wrong, on the single refusal where the reason is both knowable and
         * actionable. This is the same `{ error }` shape and the same number the handler's own 413
         * names, so the two paths are indistinguishable from the outside.
         *
         * THE FILENAME AND THE KIND ARE BOTH DELIBERATELY ABSENT, and for the same reason: nothing
         * has parsed the multipart body at this point, which is the entire reason this middleware
         * runs ahead of the handler. The handler's sentences can say `'notes.txt' is larger than the
         * 1MB limit for files` because by then it has sniffed the bytes. This one cannot, and must
         * not guess — a 9MB text file refused here as being over "the 8MB limit for images" would
         * send somebody off to shrink it to 7MB, whereupon the handler would refuse it a second time
         * with a different number. So the sentence names the only thing that is true of every body
         * this gate rejects: none of them can be under the largest ceiling the route has.
         */
        onError: (context) =>
          context.json(
            {
              // The same rounding as `megabytes` in channels/attachments.ts, so the door and the
              // handler name one limit in one voice.
              error: `That upload is larger than the ${(MAX_IMAGE_BYTES / (1024 * 1024)).toFixed(0)}MB limit.`,
            },
            413,
          ),
      }),
    );
    channelAttachments.route(
      "/",
      createChannelAttachmentRoutes(attachmentDatabase, requireUser),
    );
    app.route("/api/channels", channelAttachments);

    app.route(
      "/api/attachments",
      createAttachmentRoutes(attachmentDatabase, requireUser),
    );
  }

  if (routineStore) {
    app.route(
      "/api/routines",
      createRoutineRoutes(routineStore, requireUser, {
        runner: routineRunner,
        auditStore,
      }),
    );
  }

  if (coworker?.delivery) {
    app.route(
      "/api/delivery/webhooks",
      createDeliveryWebhookRoutes(coworker.delivery.webhooks),
    );
    app.route(
      "/api/delivery",
      createDeliveryRoutes({ ...coworker.delivery.authenticated, requireUser }),
    );
  }
  if (coworker?.demonstrations)
    app.route(
      "/api/demonstrations",
      createDemonstrationRoutes(
        coworker.demonstrations.store,
        coworker.demonstrations.recorder,
        requireUser,
      ),
    );
  if (coworker?.lifecycle)
    app.route(
      "/api/bots",
      createBotLifecycleRoutes(coworker.lifecycle, requireUser),
    );
  if (coworker?.groups)
    app.route("/api/groups", createGroupRoutes(coworker.groups, requireUser));
  if (coworker?.teamBots)
    app.route(
      "/api/team-bots",
      createTeamBotRoutes(
        coworker.teamBots,
        requireUser,
        coworker.shared?.use,
        coworker.botCatalog,
      ),
    );
  /*
   * BEFORE `/api/approvals`, which would otherwise take every path under it and answer 404 for
   * these. Needs the trail as well as the store: approving a Bot's use of a team account is a
   * decision somebody must be able to find later.
   */
  if (coworker?.shared && auditStore)
    app.route(
      "/api/approvals/shared-use",
      createSharedUseRoutes(coworker.shared.use, requireUser, auditStore),
    );
  if (coworker?.approvals)
    app.route(
      "/api/approvals",
      createApprovalRoutes(coworker.approvals, requireUser),
    );
  if (coworker?.mastraContinuations)
    app.route(
      "/api/mastra-continuations",
      createMastraContinuationRoutes({
        ...coworker.mastraContinuations,
        requireUser,
      }),
    );
  if (coworker?.passwords) {
    app.route(
      "/api/sign-in-requests",
      createSignInRoutes(
        coworker.passwords,
        requireUser,
        // A sign-in is typed into the Bot's computer, so it answers to the same rule.
        agentProfileStore ? computerAccessCheck(agentProfileStore) : canUseBot,
      ),
    );
    app.route(
      "/api/passwords",
      createPasswordRoutes(coworker.passwords, requireUser),
    );
  }
  if (coworker?.proactive)
    app.route(
      "/api/proactive",
      createProactiveRoutes(
        coworker.proactive.store,
        coworker.proactive.engine,
        requireUser,
      ),
    );
  if (coworker?.hindsight)
    app.route(
      "/api/hindsight",
      createHindsightRoutes({ ...coworker.hindsight, requireUser }),
    );
  if (coworker?.responsibilities) {
    const { store, engine, bindings } = coworker.responsibilities;
    app.route(
      "/api/responsibilities",
      createResponsibilityRoutes(
        store,
        engine,
        requireUser,
        bindings,
        coworker.responsibilities.triggers,
        coworker.shared?.use,
      ),
    );
    if (coworker.responsibilities.triggers) {
      app.route(
        "/api/events/triggers",
        coworker.responsibilities.triggers.ingressRoutes,
      );
      if (coworker.responsibilities.triggers.emailRoutes)
        app.route(
          "/api/events/email",
          coworker.responsibilities.triggers.emailRoutes,
        );
    }
    app.route(
      "/api/events/github",
      createGithubResponsibilityRoutes({
        bindingFor: bindings.githubBindingFor,
        ingest: (event) => engine.ingest(event),
      }),
    );
  }

  if (componentStore) {
    app.route(
      "/api/components",
      createComponentRoutes(
        componentStore,
        requireUser,
        auditStore,
        canUseBot,
        sandboxedStore,
      ),
    );
  }

  if (pluginStore) {
    app.route(
      "/api/plugins",
      createPluginRoutes(
        pluginStore,
        requireUser,
        canUseBot,
        {
          encryptionKey: config.keyEncryptionKey,
          /*
           * Whether the person a consent was started for still has access, asked when the callback
           * lands rather than when the flow began.
           *
           * The callback carries no session — identity comes from the state — so this is where the
           * question gets asked at all. `find` answers both halves of it: no row means a user id that
           * names nobody, and `revoked` means an administrator removed them while they were away at
           * the vendor. Either way there is no live person for a fresh refresh token to belong to.
           *
           * No people store means this deployment cannot answer the question, so it refuses rather
           * than assuming yes. It also cannot remove anybody, which is exactly why guessing here
           * would be a hole nothing else closes.
           */
          personHasAccess: async (userId) => {
            if (!peopleStore) return false;
            const person = await peopleStore.find(userId);
            return person !== undefined && !person.revoked;
          },
          // The deployment-wide fallback a Bot may present, as a yes or no. The secret itself stays
          // in config and is checked in `/api/agent-tools/call`; the surface only needs to know
          // whether a Bot without its own credential has any way to call back.
          botsMayCallBack: Boolean(config.agentToolToken),
          publicUrl: config.publicUrl,
          appUrl: config.appUrl,
        },
        composio,
        coworker?.shared,
        openConnector,
      ),
    );
  }

  /*
   * Where a framework Bot runs a tool.
   *
   * A Bot that runs its own loop, in its own process, is the honest shape: the run does not need a
   * browser and does not stop when one closes. What it must not have is a route to a vendor that
   * goes around this deployment, so it calls here and this calls the plugin store, which asks the
   * same two questions it asks of everything else and writes the same audit row.
   *
   * Authenticated by a shared secret rather than a session, because the caller is a service and has
   * no person behind it. Absent secret means the route does not exist: a deployment that has not
   * configured this refuses rather than accepting anybody who can reach the port.
   */
  if (pluginStore || deploymentToolCaller) {
    const legacyToken = config.agentToolToken ?? "";
    app.post("/api/agent-tools/call", async (context) => {
      /*
       * Who is calling, and on whose behalf. Two questions, two credentials.
       *
       * The header says which agent: its own token, issued to it, stored here only as a hash. The
       * body's `run` says which Bot and which person, signed by this deployment for this run.
       *
       * Both are required, and they are checked against each other. This used to be one
       * deployment-wide token with the Bot and the actor read straight out of the body, which meant
       * anything holding that token could spend any Bot's grants and write any name into the audit
       * trail. A forgeable trail is worse than no trail, because it is believed.
       */
      const body = (await context.req.json().catch(() => null)) as {
        name?: string;
        args?: Record<string, unknown>;
        run?: unknown;
      } | null;

      const verdict = await authoriseAgentCall({
        presented: context.req.header("x-openbot-agent-token") ?? "",
        run: body?.run,
        encryptionKey: config.keyEncryptionKey,
        legacyToken,
        lookup: async (hash) =>
          (await agentProfileStore?.agentForCallbackToken(hash)) ?? null,
      });
      if (!verdict.ok) {
        /*
         * Recorded, because this is a boundary being held and every other one here leaves a row.
         *
         * The three outcomes inside `callTool` are all written after the caller has proved which Bot
         * it is. A caller that fails to prove it never reaches them, so this refusal used to leave
         * nothing at all — and it is the refusal behind the product's most confusing failure: a Bot
         * whose token no longer matches the deployment's has every call rejected here, returns
         * nothing to its own model, and the model tells the person there were no results. A false
         * negative delivered as an answer, with the trail agreeing nothing had happened.
         *
         * No Bot id and no actor. Both live in the credential that just failed to verify, so writing
         * them down would put an unproven claim in the record. The tool name comes from the body and
         * is capped for the same reason: it is untrusted input, kept because "which tool was being
         * reached for" is the useful half of the question.
         */
        if (auditStore) {
          await recordAuditEvent(auditStore, {
            eventType: "mcp.callback_refused",
            targetType: "mcp_tool",
            initiator: DEPLOYMENT_INITIATOR,
            targetId:
              typeof body?.name === "string"
                ? body.name.slice(0, 120)
                : "unknown",
            payload: {
              refusal: verdict.reason,
              status: verdict.status,
              note: "A caller could not prove which Bot it was, so no grant was consulted.",
            },
          });
        }
        return context.json({ error: verdict.reason }, verdict.status);
      }

      const parsedCall = parseAgentToolCallInput(body);
      if (!parsedCall.ok) {
        return context.json({ error: parsedCall.error }, 400);
      }

      try {
        const deploymentResult = await deploymentToolCaller?.({
          name: parsedCall.value.ref,
          args: parsedCall.value.args,
          botId: verdict.botId,
          actorId: verdict.actorId,
          initiator: verdict.initiator,
          run: verdict.run,
        });
        if (deploymentResult) return context.json(deploymentResult);

        if (!pluginStore) {
          return context.json({
            text: `${REFUSAL_MARKER} That tool is not registered in this deployment.`,
            isError: true,
          });
        }

        // MOD12（#632）：受管执行经 M08 公开门面（store.callTool 恒等委托）。
        const toolAccess = createToolAccess({ store: pluginStore });
        const result = await toolAccess.callTool({
          ref: parsedCall.value.ref,
          args: parsedCall.value.args,
          botId: verdict.botId,
          // From the assertion, never the body: this is the name the audit row will carry.
          actorId: verdict.actorId,
          ...(verdict.initiator ? { initiator: verdict.initiator } : {}),
        });
        // Worded by the helper the in-process door uses, so a framework Bot's model reads a vendor's
        // error as the vendor's and not as a result. Neither Bot words it on its way through.
        return context.json({
          text: vendorAnswer(result),
          isError: result.isError,
        });
      } catch (error) {
        /*
         * A refusal is an answer, not a failure: the Bot says what was blocked and carries on. The
         * marker leads it so a transcript can draw a refusal without reading the wording.
         *
         * AND THE SAME QUESTION THE IN-PROCESS DOOR ASKS, which this one asked of nothing at all.
         *
         * CRITERION. Nothing on the `isDeploymentFault` shelf has its message relayed from here,
         * and nothing leaving here carries a statement or a value bound to one.
         *
         * WHAT THIS SURFACE IS. The answer goes into the calling Bot's model as the tool result, so
         * it is the widest audience an error message in this deployment reaches: a model repeats
         * what it is handed — to the person asking, into whatever it writes next, and to the next
         * tool it calls. `plugins/tools.ts` wraps the identical `callTool` for a Bot running in
         * this process and has refused that shelf for exactly this reason since the
         * `ServerRowAmbiguousError` finding; the two doors to one store disagreeing meant a query
         * failure came back as `Failed query: … params: linear, usr_…` through one of them and as a
         * fixed sentence through the other. Which door a Bot arrives at is a deployment topology
         * decision and was never a disclosure decision.
         *
         * AND THROUGH {@link withoutStatement} AS WELL, because the two answer different questions
         * and `isDeploymentFault` says so itself: it "settles who may be told, not what". The shelf
         * decides whether this audience may hear a sentence at all; the door decides what any
         * sentence is allowed to contain. Today the two overlap on a query failure and this arm can
         * only be reached by something neither recognises — which is exactly the state the last two
         * findings in this area were found in, one predicate apart from a leak.
         *
         * AND ONLY A REFUSAL CARRIES THE MARKER, which is the in-process door's third question. The
         * transcript draws an answer that starts with it as a boundary holding, and the model reads
         * "Refused." as "not allowed". `callTool` throws `PluginRefusedError` for that, and rethrows
         * a vendor that broke after recording `mcp.call_failed`; marking every throw drew a vendor
         * outage, or a fault of this deployment's own, as a policy refusing.
         */
        if (error instanceof PluginRefusedError) {
          return context.json({
            text: `${REFUSAL_MARKER} ${withoutStatement(error)}`,
            isError: true,
          });
        }
        return context.json({
          text:
            error instanceof Error && !isDeploymentFault(error)
              ? `That tool could not be called: ${withoutStatement(error)}`
              : "That tool could not be called.",
          isError: true,
        });
      }
    });
  }

  if (sandboxedStore) {
    app.route(
      "/api/sandboxed",
      createSandboxedRoutes(sandboxedStore, requireUser),
    );
  }

  if (threadIdentity) {
    app.route(
      "/api/threads",
      createThreadRoutes(
        threadIdentity,
        requireUser,
        // ME15 (#487): a deployment can legitimately have no Intelligence to
        // build a reader from, so the client is resolved on the first request
        // that actually reads a thread — the adapter defers it — and one
        // without Intelligence gets the named refusal, never a broken mount.
        createThreadReader({
          getThread: (params) => requireThreadReaderClient().getThread(params),
        }),
      ),
    );
  }

  /*
   * The billing surfaces, when a provider is configured.
   *
   * Three groups, three doors. The webhook group sits under `/api` with no session on purpose: its
   * caller is the provider, whose whole credential is the signature the service verifies against the
   * raw body — the same shape as the delivery lane's webhook mount above, and safe for the same
   * reason (the enterprise gate passes a path it has no rule for straight through). The entitlement
   * read is a person's; the admin pair is an administrator's, behind the same double layer
   * `/api/admin/package` uses. All three are absent on a deployment that configured no provider:
   * a feature that is not configured should be missing, not broken.
   */
  if (billing) {
    app.route(
      "/api/billing/webhooks",
      createBillingWebhookRoutes({ service: billing.service }),
    );
    app.route(
      "/api/billing",
      createBillingRoutes({
        service: billing.service,
        requireUser,
        // MOD10（#630）C2：权益交付读经组内公开门面（薄委托同一 service.entitlements）。
        entitlementDelivery: createBillingEntriesPublic({
          entitlement: billing.service,
        }).entitlementDelivery,
      }),
    );
    app.route(
      "/api/admin/billing",
      createBillingAdminRoutes({
        service: billing.service,
        requireUser,
        requireAdmin,
        audit: auditStore,
        externalCustomerKey: billing.externalCustomerKey,
        customerName: billing.customerName,
        // 17.8's review read: the task dimension beside the anomaly queue, mounted only
        // where the billing assembly has the database the jobs live in.
        ...(billing.database
          ? {
              asyncJobsView: createAsyncJobsViewService({
                database: billing.database,
              }),
            }
          : {}),
        // The credit ledger's write side, mounted only where billing itself is: the grant route
        // reads its presence, so a deployment without the writer answers 503 instead of writing
        // into a ledger nobody configured.
        ...(billing.creditWriter ? { creditWriter: billing.creditWriter } : {}),
        // The personal grant route's resolution source (02.8): the deployment's own database,
        // where the payer mapping and the users table live.
        database: billing.database,
        // The disposal command's pricing anchor (08.9): the environment rate a version-0
        // price lock names, threaded to the settle path the disposal goes through.
        environmentRate: config.gateway?.creditConversionRate,
      }),
    );
  }
  /*
   * The statement reads, on the same prefix and behind the same session. Mounted in its own group
   * rather than folded into the one above, because it is built from a different thing: the group
   * above is the provider's reader, this one is the deployment's own two answers about its money.
   */
  if (statements) {
    // MOD10（#630）C3/C1：账单三读与读作用域 Payer 解析经组内公开门面（薄委托）。
    const entries = createBillingEntriesPublic({ statements });
    app.route(
      "/api/billing",
      createBillingStatementRoutes({
        statements,
        requireUser,
        accountQuery: entries.accountQuery,
        resolvePayer: entries.resolvePayer,
      }),
    );
  }
  /*
   * The credit-ledger reads, on the same prefix and behind the same session, from the local
   * ledger rather than the provider's reader or the payment table.
   */
  if (credits) {
    // MOD10（#630）C4/C5/C1：积分读面、实时/异步个人读与 Payer 解析经组内公开门面。
    // 两部读者实例同时供给门面与 503 准入检查（准入语义逐字节不动）。
    const realtimeUsage = billing?.database
      ? createRealtimeUsageService({ database: billing.database })
      : undefined;
    const asyncJobsView = billing?.database
      ? createAsyncJobsViewService({ database: billing.database })
      : undefined;
    const entries = createBillingEntriesPublic({
      credits,
      ...(realtimeUsage ? { realtimeUsage } : {}),
      ...(asyncJobsView ? { asyncJobsView } : {}),
    });
    app.route(
      "/api/billing",
      createBillingCreditRoutes({
        credits,
        requireUser,
        // The reward claim's write side (10.4): the granter resolves the claimer's own personal
        // payer and the writer lands the grant. Mounted only where both exist — a deployment
        // without the credit writer answers the claim route 503 instead of granting into a
        // ledger nobody configured (the admin grant route's admission rule).
        ...(billing?.creditWriter && billing.database
          ? {
              rewards: createRewardGranter({
                database: billing.database,
                creditWriter: billing.creditWriter,
              }),
            }
          : {}),
        // 15.8's realtime consumption rows ride the same database the ledger reads; mounted
        // only where the billing assembly has one, and the route refuses 503 without it.
        ...(realtimeUsage ? { realtimeUsage } : {}),
        // 17.8's async jobs read rides the same database the ledger reads; mounted only
        // where the billing assembly has one, and the route refuses 503 without it.
        ...(asyncJobsView ? { asyncJobsView } : {}),
        accountQuery: entries.accountQuery,
        resolvePayer: entries.resolvePayer,
        audit: auditStore,
      }),
    );
  }

  /*
   * The payment surfaces, when the assembly built them. Mount order here is not taste — two of
   * these facts were established by direct router experiments and reproduced by review:
   *
   * 1. THE CHANNEL CALLBACKS LIVE AT THEIR OWN PREFIX (`/api/payments/callbacks/:provider`),
   *    mounted with no session, like the Lago webhook door above. Mounted under `/api/billing`
   *    instead, the requireUser gate stands in front of the channels and every delivery answers
   *    401 — the exact failure the mount regression (payment-mount.test.ts) pins.
   * 2. THE PAYMENT USER GROUP RIDES `/api/billing` AFTER the billing user group, so both groups'
   *    paths coexist on one prefix.
   * 3. INSIDE that group, the static purchase routes (catalog, current) are REGISTERED BEFORE
   *    `GET /purchases/:id`: Hono matches a group's routes in registration order, and a
   *    parametric segment registered first swallows the static paths — with the order inverted,
   *    `catalog` is answered by the `:id` handler. payment-routes.test.ts asserts the order.
   */
  if (payments) {
    // MOD10（#630）C8/C1/C9：订单三读与 Payer 解析经组内公开门面（回调挂载不动，C11）。
    const entries = createBillingEntriesPublic({ payments: payments.service });
    app.route(
      "/api/payments/callbacks",
      createPaymentCallbackRoutes({ service: payments.service }),
    );
    app.route(
      "/api/billing",
      createPaymentRoutes({
        service: payments.service,
        requireUser,
        requireAdmin,
        audit: auditStore,
        activePlanCode: payments.activePlanCode,
        orders: entries.orders,
        resolvePayer: entries.resolvePayer,
      }),
    );
  }

  /*
   * The built app, served by the API that serves it.
   *
   * WHY THE SAME PROCESS. There is no CORS anywhere in this server, deliberately, so the app has to
   * reach `/api` on its own origin. Two containers behind one ingress does that too, and costs a
   * path rule on every deployment plus a way for the two to disagree about which host they are on.
   * One process cannot disagree with itself.
   *
   * MOUNTED LAST, so every `/api` route above already claimed its path. The catch-all below would
   * otherwise answer an unmatched `/api` call with the app's HTML, which is the failure that reads
   * as "the API returned HTML" and takes an hour to place.
   *
   * Absent in development: Vite serves the app and proxies `/api` here, so `APP_DIST_DIR` is unset
   * and none of this mounts.
   */
  if (config.appDistDir) {
    const root = config.appDistDir;
    app.use("/*", serveStatic({ root }));
    /*
     * A single-page app owns its routing, so a path with no file behind it is not missing: it is a
     * route the browser resolves once index.html has loaded. Without this, every deep link and every
     * refresh away from `/` is a 404, which is the classic way this deployment shape breaks.
     *
     * Written out rather than a second `serveStatic`, whose `path` option is resolved relative to the
     * working directory and silently matches nothing when handed the absolute root used above.
     *
     * `/api` is excluded so an unmatched API route still answers as one. Returning the app's HTML to
     * a fetch that expected JSON is the failure that gets read as "the API returned HTML".
     */
    app.get("*", async (context) => {
      if (context.req.path.startsWith("/api")) return context.notFound();
      const index = Bun.file(`${root}/index.html`);
      if (!(await index.exists())) return context.notFound();
      return new Response(index, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    });
  }

  return app;
}

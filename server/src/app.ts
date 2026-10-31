import { MAX_IMAGE_BYTES } from "@openbot/shared/attachments";
import { sql } from "drizzle-orm";
import type { Hono, Hono as HonoApp, MiddlewareHandler } from "hono";
import type { RunAssertion } from "./agents/callback-token";
import type { BotLifecycleServices } from "./agents/lifecycle-routes";
import type {
  OpenMuseTemplateMethods,
  OpenMuseTemplateRevisionService,
} from "./agents/openmuse-template-store";
import type { AgentProfileStore } from "./agents/profile-store";
import type { BotCatalog } from "./agents/public";
import type { ApprovalService } from "./approvals/service";
import { assembleHttpApp } from "./assembly/http";
import {
  type AuditInitiator,
  type AuditReader,
  type AuditStore,
  recordAuditEvent,
} from "./audit";
import type {
  CompanyAssurance,
  CompanyProofPolicyView,
} from "./auth/company-assurance";
import { createDevRequireUser } from "./auth/dev-actor";
import type { Directory } from "./auth/directory/contracts";
import type { IdentityExecutor } from "./auth/directory/identity";
import {
  type AppVariables,
  type AuthService,
  createRequireUser,
  type RoleRepository,
} from "./auth/guards";
import type { IdentityProviderStore } from "./auth/identity-provider-store";
import type { Credits } from "./billing/credits";
import type { CreditWriter } from "./billing/credits-writer";
import type { PaymentService } from "./billing/payments/service";
import type { BillingStatements } from "./billing/statements";
import type { BillingService } from "./billing/types";
import type { BotServiceRegistry } from "./bot-services/registry";
import type { BotServiceStore } from "./bot-services/store";
import type { ChannelEventHub } from "./channels/events";
import type { GroupConversations } from "./channels/group";
import type { ChannelStore } from "./channels/routes";
import type { ThreadIdentity } from "./channels/thread-identity";
import type { CodeRunGatewayFactory } from "./codesandbox/routes";
import type { SandboxedStore } from "./components/sandboxed";
import type { ComponentStore } from "./components/store";
import type { ComputerGateway } from "./computer/gateway";
import type { PageFrameStore } from "./computer/page-frames";
import type { PolicyStore } from "./computer/policy-store";
import type { DeploymentConfig } from "./config";
import type { CraftRoutesFactory } from "./craft/routes";
import type { CredentialAdminService, CredentialInput } from "./credentials";
import type { Database } from "./db/client";
import type {
  createDeliveryRoutes,
  createDeliveryWebhookRoutes,
} from "./delivery/routes";
import type { DemonstrationRecorder } from "./demonstrations/recording";
import type { DemonstrationStore } from "./demonstrations/store";
import type { PlatformScope } from "./enterprise/contracts";
import type { DeploymentEntryContextFactory } from "./enterprise/tenancy/entry-context";
import type { HindsightRouteServices } from "./hindsight/ops-routes";
import type { HostAccessBroker } from "./host-access/broker";
import type { IdentityStore } from "./identity/store";
import { lazyIntelligenceClient } from "./intelligence-optional";
import type { LearningAdminDependencies } from "./learning/routes";
import type { MarketplaceStore } from "./marketplace/store";
import type { MastraContinuationInstall } from "./mastra/approvals";
import type { MastraContinuationStore } from "./mastra/continuation-store";
import type { OpenMuseDeletionManifest } from "./openmuse-deletion/manifest";
import type { OpenMuseFileBytePurgeReport } from "./openmuse-deletion/purge";
import type { OpenMuseRelationalPurgeOutcome } from "./openmuse-deletion/purge-relational";
import type { OpenMuseDeletionRestore } from "./openmuse-deletion/restore";
import type { OpenMuseDeletionCleanupView } from "./openmuse-deletion/retention";
import type { OpenMuseAccountDeletionStore } from "./openmuse-deletion/store";
import type { OpenMuseFileStore } from "./openmuse-files/store";
import type { OpenMuseTaskStore } from "./openmuse-tasks/store";
import type { SignInService } from "./passwords/service";
import type { OnboardingStore } from "./people/onboarding";
import type { PeopleStore } from "./people/store";
import type { AccountModeSwitch } from "./plugins/account-mode";
import type { ComposioBroker, ConnectedAppBroker } from "./plugins/broker";
import type { SharedUseStore } from "./plugins/shared-use-store";
import type { PluginStore } from "./plugins/store";
import type { ProactiveEngine } from "./proactive/engine";
import type { ProactiveStore } from "./proactive/store";
import type { ModelProviderProxy } from "./provider-oauth";
import type { ResponsibilityBindingStore } from "./responsibilities/bindings";
import type { ResponsibilityEngine } from "./responsibilities/engine";
import type { TriggerStore } from "./responsibilities/triggers";
import type { ResponsibilityStore } from "./responsibilities/types";
import type { RoutineStore } from "./routines/routes";
import type { RoutineRunner } from "./routines/runner";
import type { IntentRouter } from "./routing/classify";
import type { SelfHostBanner } from "./self-host-banner";
import type { TeamBots } from "./team-bots/team-bots";
import type { PackageStatusReader } from "./tenant-package";
import type { UserInstructionsStore } from "./user-instructions";
import type { UserPreferencesStore } from "./user-preferences";
import type { VoiceSessionServices } from "./voice/session-routes";
import { createOpenBotSourceAccess } from "./memory-service/source-access";
import type { createWorkshopPublicRoutes } from "./workshop/public-routes";
import type { WorkshopRoutesFactory } from "./workshop/routes";

/**
 * How much of a multipart body is boundary, headers and other fields rather than file.
 *
 * Generous on purpose. Measured against what the composer actually sends — one `file` part and one
 * `uploadGroup` field — the framing is 360 bytes for a short filename and 614 for a 255-character
 * one; a filename full of non-ASCII percent-encodes to a few times that and is still nowhere near
 * this. 64 KiB is therefore an allowance no honest request can exhaust, and it raises the amount of
 * memory a hostile request can pin by 0.8%, which was never the number that mattered.
 */
const MULTIPART_FRAMING_ALLOWANCE = 64 * 1024;

/**
 * The ceiling on the whole POST body of a channel attachment upload.
 *
 * THIS IS NOT `MAX_IMAGE_BYTES`, AND THE DIFFERENCE IS THE POINT. Every other gate on this path —
 * the composer's pre-check, `attachmentsConfigFor`'s `maxSize`, the handler's own 413 — measures
 * THE FILE. This one measures THE ENVELOPE: `bodyLimit` runs before anything has parsed the
 * multipart body, so all it can count is bytes on the wire, file and framing together.
 *
 * Set to `MAX_IMAGE_BYTES` exactly, those two units were silently treated as one, and the ~360
 * bytes of boundary and headers wrapped around a file at the documented ceiling were enough to push
 * the body over it: an 8,388,608-byte image — the exact number the composer publishes as the limit —
 * was refused 413, while 8,388,308 bytes went through. A limit nobody can reach is a limit that is
 * wrong, so the envelope's ceiling is the file's ceiling plus room for the envelope.
 *
 * The slack costs nothing it was protecting against. A body between the two numbers is still read
 * into memory, and then still refused by the handler once `file.size` is a thing anybody can look
 * at — which is where a text upload, whose real limit is `MAX_FILE_BYTES`, is refused too. What the
 * door exists to stop is the 2GB body, and it still does.
 */
export const UPLOAD_BODY_LIMIT_BYTES =
  MAX_IMAGE_BYTES + MULTIPART_FRAMING_ALLOWANCE;

/** The ceiling on one readiness ping. A database that has said nothing for this long is down. */
const READY_TIMEOUT_MS = 1500;

/**
 * The default probe behind `/ready`: one SELECT 1, raced against a timeout so a database that
 * hangs answers down rather than holding the probe open for the pool's own connect timeout.
 *
 * With no database wired the probe always fails, because "this app has no database" is down — a
 * readiness route that answered up about a deployment with nothing behind it would be the one
 * lie a load balancer is not allowed to be told.
 */
function defaultReadinessProbe(database: Database | undefined) {
  return async () => {
    if (!database) throw new Error("No database is wired.");
    await Promise.race([
      database.execute(sql`select 1`),
      Bun.sleep(READY_TIMEOUT_MS).then(() => {
        throw new Error("The readiness ping timed out.");
      }),
    ]);
  };
}

/**
 * One row for something an administrator did to somebody's access.
 *
 * The address is on the row rather than only the user id, because the id means nothing to a person
 * reading the trail a year later and the user row may be gone by then.
 */
export type DeploymentToolCallInput = {
  name: string;
  args: Record<string, unknown>;
  botId: string;
  actorId: string;
  initiator?: AuditInitiator;
  /** Full verified scope. A caller cannot choose a different source thread, depth or lease. */
  run: RunAssertion;
};
export type DeploymentToolCaller = (
  input: DeploymentToolCallInput,
) => Promise<{ text: string; isError: boolean } | null>;

async function recordPersonEvent(
  auditStore: AuditStore | undefined,
  context: { var: AppVariables },
  eventType:
    | "person.role_changed"
    | "person.access_revoked"
    | "person.access_restored",
  person: { id: string; email: string },
  payload: Record<string, unknown>,
) {
  if (!auditStore) return;
  await recordAuditEvent(auditStore, {
    eventType,
    targetType: "person",
    targetId: person.id,
    actorUserId: context.var.actor.id,
    payload: { email: person.email, ...payload },
  });
}

/**
 * The deployment's session guard, the one construction both createApp and index.ts's OpenMuse
 * seams (Google OAuth, mail, calendar) mount: single-user answers its one administrator, a
 * configured provider answers real sessions, and neither configured is a deployment that never
 * booted (loadConfig refuses it) — answered at 503 rather than left undefined so the seam is
 * always a guard. Exported because index.ts used to carry a hand-copied twin of this ternary,
 * and one `/api` prefix guarded by two differently-aged guards is exactly the silent fork this
 * factory exists to prevent.
 */
export function createDeploymentRequireUser(
  config: Pick<DeploymentConfig, "singleUser">,
  auth?: AuthService,
  roleRepository?: RoleRepository,
): MiddlewareHandler<{ Variables: AppVariables }> {
  if (config.singleUser) return createDevRequireUser();
  if (auth && roleRepository) return createRequireUser(auth, roleRepository);
  return async (context) =>
    context.json({ error: "No identity provider is configured." }, 503);
}

export interface CoworkerSeams {
  /**
   * The native directory seams the assembly may build (T02.11/T05): the
   * company-proof answer the directory read gate asks (interfaces §5), the
   * live company-auth challenge (T05.01 / #557), the production
   * directory/identity executors (P08/P09/P12), password recovery (T04.05)
   * and the SCIM surface transcription (T05.05 / #561). A field here rather
   * than another positional parameter: the proof port must be injectable (a
   * proof-demanding company is a real deployment state), and an appended
   * positional would shift every createApp call site's tail offsets. Absent
   * keeps each mounted route on its closed adapter — the honest 503, never a
   * half-wired write. One type shared with
   * HttpAssemblyDependencies.coworker in assembly/http.ts.
   */
  directory?: {
    proofPolicy?: CompanyProofPolicyView;
    companyAuth?: Pick<CompanyAssurance, "challenge">;
    directory?: Directory;
    identity?: Pick<IdentityExecutor, "execute">;
    passwordRecovery?: { handle(request: Request): Promise<Response | null> };
    scim?: {
      handle(request: Request): Promise<Response | null>;
    };
  };
  demonstrations?: {
    store: DemonstrationStore;
    recorder: DemonstrationRecorder;
  };
  approvals?: ApprovalService;
  /**
   * Shared apps: who may use an app's one team account, and the switch that makes an app Shared.
   *
   * A field here rather than another positional parameter. Everything from `auditReader` on is
   * optional and positional, so a 37th argument is one an caller can misplace silently — the trap
   * `composio` and `connect` are both commented for. One object carries both halves because every
   * surface that needs one needs the other: the plugin routes switch modes and record approvals,
   * the approvals inbox answers requests, and publishing or assigning a Bot re-checks what it was
   * approved for. Absent, none of those surfaces exists — and nothing can turn an app Shared.
   */
  shared?: { modes: AccountModeSwitch; use: SharedUseStore };
  /** The private sign-in form and the Passwords vault. See passwords/service.ts. */
  passwords?: SignInService;
  delivery?: {
    authenticated: Omit<
      Parameters<typeof createDeliveryRoutes>[0],
      "requireUser"
    >;
    webhooks: Parameters<typeof createDeliveryWebhookRoutes>[0];
  };
  /**
   * #732: what remains of the Hindsight surfaces (#387–#391) — the evidence seam the
   * chat's answer basis inspects. The old memory operations left with the old paths.
   * Present only where the assembly built the seams AND a trusted scope resolver
   * exists; absent mounts nothing, the same "not configured, not broken" answer
   * every optional neighbour gives.
   */
  hindsight?: HindsightRouteServices;
  proactive?: { store: ProactiveStore; engine: ProactiveEngine };
  responsibilities?: {
    store: ResponsibilityStore;
    engine: ResponsibilityEngine;
    bindings: ResponsibilityBindingStore;
    /** Event triggers: owner management, public signed ingress and optional SES/SNS email. */
    triggers?: {
      store: TriggerStore;
      emailDomain: string | null;
      ingressRoutes: Hono;
      emailRoutes: Hono | null;
    };
  };
  groups?: GroupConversations;
  enterpriseConversations?: Hono;
  /** MT006 (issue #49): workspace scope listing + team administration routes. */
  enterpriseWorkspaceScope?: Hono;
  /** Plugin packages marketplace routes (#459); mounted only where a deployment wires them. */
  pluginPackages?: Hono;
  /**
   * ME06 (#478): the durable frontend_tool participation routes' deps —
   * the real continuation ledger and this deployment's scope resolver.
   * The `requireUser` middleware is created here (mount time), so the deps
   * arrive and the route builds where the auth middleware lives.
   */
  mastraContinuations?: {
    install: MastraContinuationInstall;
    store: MastraContinuationStore;
    resolveScope: (request: Request) => Promise<PlatformScope>;
  };
  /**
   * MT122 (issue #165): the deployment main entry's request-context seam.
   * Present, the business API mounts the entry middleware after the
   * usage-origin floor (multitenancy mode only); each request that carries
   * the ruling #1 selection headers gets its context established here and
   * its business dependencies built from the scope factory — never from a
   * startup-wide single config, and never from a default scope. Absent
   * (enterprise capabilities unwired or the switch off) the assembly is
   * byte-for-byte what it was.
   */
  entryContext?: DeploymentEntryContextFactory;
  /**
   * MT125 (Issue #168): the mobile aggregation's unified assembly
   * (GET /api/mobile/openmuse-aggregate over the MT066 scope service).
   * Mounted beside the mobile BFF; absent mounts nothing.
   */
  enterpriseMobileAggregate?: Hono;
  /** MT126 (Issue #169): the stream entry's unified assembly (/api/enterprise/streams). */
  enterpriseStreamEntry?: Hono;
  teamBots?: TeamBots;
  /**
   * MOD05（Issue #625，根 #620）：M03 BotCatalog 门面（发布/撤回经它委托，见
   * agents/public.ts）。与 assembly/http.ts HttpAssemblyDependencies.coworker 的同名字段
   * 同步——本类型是 createApp 位置参数的孪生声明，两处必须一致地可选。
   */
  botCatalog?: BotCatalog;
  /** Pause, reset, Activity and attention for a person's own Bots. See agents/lifecycle.ts. */
  lifecycle?: BotLifecycleServices;
  /**
   * The marketplace's own receipts: which expert each person installed, and the Bot the install
   * created. A field here rather than another positional parameter, for the same reason every
   * sibling above is: a misplaced positional argument is silent, and this one only matters
   * beside the agent store it writes through. Absent leaves the catalogue readable but nothing
   * installable — a deployment that cannot remember what a person installed must not guess.
   */
  marketplace?: { installs: MarketplaceStore };
}

export interface OpenMuseSeams {
  /** The OpenMuse template seam (see the docblock this object replaced). */
  templateStore?: OpenMuseTemplateMethods;
  /** The /ready probe; absent defaults to a real SELECT 1 on the database. */
  readinessProbe?: () => Promise<void>;
  /** The template revision admin seam (preview/apply). */
  templateRevisions?: OpenMuseTemplateRevisionService;
  /** The OpenMuse personal-files store. */
  files?: OpenMuseFileStore;
  /** The OpenMuse Task store (T01). */
  tasks?: OpenMuseTaskStore;
  /** The OpenMuse Google OAuth pair: the guarded app and the public callback. */
  googleOAuth?: { app: Hono<{ Variables: AppVariables }>; callback: Hono };
  mail?: Hono<{ Variables: AppVariables }>;
  reviewedActions?: Hono<{ Variables: AppVariables }>;
  goals?: Hono<{ Variables: AppVariables }>;
  calendar?: Hono<{ Variables: AppVariables }>;
  ideas?: Hono<{ Variables: AppVariables }>;
  memories?: Hono<{ Variables: AppVariables }>;
  documents?: Hono<{ Variables: AppVariables }>;
  notifications?: Hono<{ Variables: AppVariables }>;
  /** D01 (§9): the marker store behind the delete route and the fence. */
  accountDeletion?: OpenMuseAccountDeletionStore;
  /**
   * D02 (§9): the work shutdown the delete route runs behind the marker —
   * cancels Tasks/Monitors and awaiting Reviewed actions, records the
   * transitions on the marker.
   */
  deletionShutdown?: (userId: string) => Promise<unknown>;
  /**
   * D03 (§9): the external access revocation — Google seats withdrawn at
   * the vendor best-effort, rows landing revoked.
   */
  deletionRevoke?: (userId: string) => Promise<unknown>;
  /** D04 (§9): the resource manifest built before any metadata removal. */
  deletionManifest?: (userId: string) => Promise<OpenMuseDeletionManifest>;
  /**
   * §9 hardening (the fence's tracked exposure): the delete route revokes
   * the deleting owner's auth sessions with the marker, so a still-valid
   * session cannot keep reaching the seams the /api/mobile fence does not
   * cover (channels, the computer stream, copilot).
   */
  deletionRevokeSessions?: (userId: string) => Promise<unknown>;
  /**
   * D09 (§9): the backup-retention bookkeeping — notes on the marker that
   * the deployment's backup window covers this deletion.
   */
  deletionNoteBackupRetention?: (userId: string) => Promise<string | null>;
  /**
   * D05/D06/D08/D09 (§9): the admin surface at /api/admin/openmuse-deletion
   * — restore, the file byte purge, the final relational purge and the
   * cleanup view. Absent leaves the admin surface unmounted.
   */
  deletionAdmin?: {
    restore: OpenMuseDeletionRestore;
    purge?: (userId: string) => Promise<OpenMuseFileBytePurgeReport>;
    purgeRelational?: (
      userId: string,
    ) => Promise<OpenMuseRelationalPurgeOutcome>;
    cleanupView?: () => Promise<OpenMuseDeletionCleanupView>;
  };
  activity?: Hono<{ Variables: AppVariables }>;
  opsSignals?: Hono<{ Variables: AppVariables }>;
  /** Observation surfaces (ticket #7). Absent = the integration is not mounted at all. */
  aiObservability?: Hono<{ Variables: AppVariables }>;
  /**
   * T33 (T34 §6): what a user-disable/revocation path does about queued
   * observation export work — the store's cancelForActor seam. Best-effort
   * beside the revoke it accompanies: the export worker re-authorizes on
   * every execution, so a cancelled-call miss is caught at the next run,
   * never by shipping an artifact. Absent cancels nothing here.
   */
  aiObservabilityCancelForActor?: (actorId: string) => Promise<unknown>;
}

export function createApp(
  config: DeploymentConfig,
  auth?: AuthService,
  roleRepository?: RoleRepository,
  auditReader?: AuditReader,
  credentialService?: CredentialAdminService,
  packageStatusReader?: PackageStatusReader,
  /**
   * The CopilotKit endpoint, already built by the caller.
   *
   * Passed in rather than constructed here so this module never imports the runtime. The runtime
   * pulls in `eventsource`, which Bun cannot `require()` from a test, so importing it at module
   * scope broke every server test that touches createApp even though none of them use CopilotKit.
   */
  copilotHandler?: HonoApp,
  /** The single governed computer module: policy, audit trail, transport, and provider lifecycle. */
  computerGateway?: ComputerGateway,
  /** What the gateway enforces, and what an administrator can change while running. */
  computerPolicy?: PolicyStore,
  /** Bots as durable objects: profile, roster, visibility. */
  agentProfileStore?: AgentProfileStore,
  /** The durable channels a Bot runs in. */
  channelStore?: ChannelStore,
  /** Live channel activity. Absent leaves the routes working, just without the socket. */
  channelEvents?: ChannelEventHub,
  /**
   * Where a Bot's own refusal is written.
   *
   * Separate from `auditReader`, which only reads: this writes, and it is the one thing in the trail
   * that is not decided by the gateway, a model declining before it calls anything.
   */
  auditStore?: AuditStore,
  /**
   * Which components each Bot may answer with.
   *
   * Absent leaves the app working and every Bot answering in prose, which is the correct degraded
   * behaviour: a deployment that cannot reach its grant table must not fall back to granting
   * everything.
   */
  componentStore?: ComponentStore,
  /**
   * The MCP servers and packaged skills this deployment has, and which Bots hold them.
   *
   * Absent leaves every Bot with the tools it was born with, which is the correct degraded
   * behaviour: a deployment that cannot reach its grant table must offer nothing extra rather than
   * fall back to offering everything.
   */
  pluginStore?: PluginStore,
  /**
   * Components authored in the browser rather than compiled into the build.
   *
   * Absent leaves the compiled gallery working exactly as before, which is the correct degraded
   * behaviour: the React path is the primary one and does not depend on this.
   */
  sandboxedStore?: SandboxedStore,
  /**
   * How this deployment names the threads it mints.
   *
   * Absent leaves the direct Bot chat generating its own id in the browser, which works and simply
   * says nothing about which deployment the conversation belongs to.
   */
  threadIdentity?: ThreadIdentity,
  /**
   * Who has signed in, and what an administrator may do about them.
   *
   * Absent leaves the people screen answering 503 rather than an empty list, which is the honest
   * degraded behaviour: "nobody has signed in" and "this deployment cannot tell you" are different
   * answers and an administrator deciding who has access needs to know which one they are reading.
   */
  peopleStore?: PeopleStore,
  /**
   * The enterprise identity providers this deployment has registered.
   *
   * Read here rather than through Better Auth's own listing route, which scopes to the person asking:
   * a company's Okta tenant belongs to the deployment, not to whichever administrator pasted the
   * metadata in. See identity-provider-store.ts.
   */
  identityProviders?: IdentityProviderStore,
  /**
   * Chooses which coworker an untagged message is for, before a channel is pinned to one.
   *
   * Passed in already built, like the copilot handler, so this module never imports the model
   * client. Absent leaves the composer's existing behaviour untouched: an untagged message goes to
   * the default coworker, which is exactly the failsafe the router itself falls back to.
   */
  intentRouter?: IntentRouter,
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
  pageFrames?: PageFrameStore,
  /**
   * Fires one routine run with nobody's browser open, when the worker hands one back.
   *
   * Appended last, like `pageFrames`: these are positional, so inserting one anywhere else silently
   * shifts every existing call site's arguments by one.
   *
   * Absent leaves the internal `/internal/routines/run` route unmounted rather than mounted and
   * refusing every call: a deployment that never built a worker has no door for it, not a locked one.
   */
  routineRunner?: RoutineRunner,
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
  routineStore?: RoutineStore,
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
  onboardingStore?: OnboardingStore,
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
  userInstructions?: UserInstructionsStore,
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
  attachmentDatabase?: Database,
  /** Session-only broker for native owner-approved host folder access. */
  hostAccessBroker?: HostAccessBroker,
  /** Fresh desktop-only bearer token for the native host worker poll/result channel. */
  desktopHostToken?: string,
  /** Server-owned tools that are not MCP but use the same signed agent callback route. */
  deploymentToolCaller?: DeploymentToolCaller,
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
  composio?: { broker: ComposioBroker },
  /** Native model OAuth stays server-side; callers hold only a separate local bearer. */
  modelProviderProxy?: ModelProviderProxy,
  userPreferences?: UserPreferencesStore,
  voiceSessions?: VoiceSessionServices,
  learning?: LearningAdminDependencies,
  coworker?: CoworkerSeams,
  /**
   * Whether to offer help self-hosting, which also hides it from a deployment that pays for
   * Intelligence. Absent falls back to the operator's switch alone, so a test or a build without the
   * resolver still answers from `config.selfHostBanner` rather than asking the network.
   */
  selfHostBanner?: SelfHostBanner,
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
  },
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
  openConnector?: { broker: ConnectedAppBroker },
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
  },
  /**
   * The governed code-interpreter module. Absent leaves run_code refusing everywhere.
   *
   * APPENDED LAST, like `payments` beside it, for the reason those parameters' own docblocks give:
   * these are positional, so inserting one anywhere else silently shifts every existing call
   * site's arguments by one.
   */
  codeRunGatewayFactory?: CodeRunGatewayFactory,
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
  statements?: BillingStatements,
  /**
   * The credit-ledger reads: 套餐与积分 (`/api/billing/credits/*`). APPENDED LAST for the same
   * reason `statements` is: positional. Local only — the credit ledger lives in this deployment's
   * own database, so it has no provider dependency; absent mounts no credit path.
   */
  credits?: Credits,
  /**
   * The workshop: a Bot's working surface — turns, files, artifacts, the SSE stream — behind
   * canUseBot like every other Bot-scoped route. APPENDED LAST, same reason as `credits`.
   *
   * A factory rather than a router so the assembly decides the wiring (store, lock, bus,
   * orchestrator) in one place; the factory itself is built by the index assembly where the
   * Redis/no-Redis branch lives.
   */
  workshopRoutes?: WorkshopRoutesFactory,
  /**
   * The workshop's ANONYMOUS half (B14/F9/B15b): the share-token routes, mounted at
   * /api/public/workshop. A factory for the same reason `workshopRoutes` is — the sharing
   * service's wiring (store, limiter, signing key) is a boot decision. Optional: a
   * deployment without it simply has no public share surface.
   */
  publicWorkshopRoutes?: () => ReturnType<typeof createWorkshopPublicRoutes>,
  /**
   * Craft: the autonomous-build surface (`/api/craft` — sessions, send-message, SSE turn
   * streams), ported from onyx's build feature. APPENDED LAST like `workshopRoutes` beside
   * it: positional parameters only ever go at the end. A factory for the same reason — the
   * wiring (store, gateway, manager, executor, the deployment's model catalog) is one boot
   * decision; the craft tree carries its own enabled gate (503 mid-flight) and needs only
   * `requireUser` (its sandbox routing is not Bot-scoped like the workshop's canUseBot).
   * Absent (or OPENBOT_CRAFT_ENABLED explicitly disabled) mounts nothing.
   */
  craftRoutes?: CraftRoutesFactory,
  /**
   * The OpenMuse seam tail, ONE named object instead of seventeen trailing
   * positionals: ten of those were the same Hono router type, where any call
   * site's silent argument misordering typechecks and mounts a family under
   * the wrong prefix (goals under /api/mobile/openmuse-calendar) with no
   * runtime error to notice. Named fields cannot be transposed; the older
   * positional parameters above this one stay as they were.
   */
  openMuseSeams?: OpenMuseSeams,
  /** A person's own linked accounts. Absent answers 503 on /api/identity. */
  identity?: IdentityStore,
  /** The GitHub sign-in callback, built by the caller; mounted behind requireUser ahead of /api/identity. */
  identityGithubCallback?: Hono<{ Variables: AppVariables }>,
  /**
   * The Bifrost bot service registry (04.1) — and, since 04.2, its credential surface and
   * authenticator when the deployment composed a full {@link BotServiceRegistry}. A bare 04.1
   * store keeps every registry route working and leaves the credential surfaces answering a
   * tagged 503; absent answers a tagged 503 on /api/admin/bot-services.
   */
  botServices?: BotServiceStore | BotServiceRegistry,
  /**
   * The company-workbench payer wiring (Bifrost 09.2, #287): present binds the workbench
   * surface's requests to their company scope's payer — the account every reserve, settle and
   * remainder of the call then names (02.5's no-switch semantics carry it). Absent leaves the
   * workbench paths resolving exactly as before; this seam never binds a payer on its own.
   */
  workbenchPayer?: { database: Database },
) {
  /*
   * ME15 (#487): the thread-status reader's Intelligence client, resolved on
   * the first thread read that needs it. A deployment without Intelligence
   * constructs nothing here; the read refuses by name instead.
   */
  const requireThreadReaderClient = lazyIntelligenceClient({
    settings: config.runtime.intelligence,
    feature: "the thread-status reader",
  });
  /*
   * MOD02 (#622): the route/middleware mount itself now lives in
   * ./assembly/http.ts. assembleHttpApp instantiates the Hono app and
   * registers every middleware, guard, route mount and the SPA fallback in
   * the exact order this function used to carry inline, with every value it
   * reads arriving as an explicit dependency: the parameters above by name,
   * the lazily-resolved Intelligence accessor built just above, and the
   * helpers this module retains (createDeploymentRequireUser,
   * credentialInput, recordPersonEvent, defaultReadinessProbe,
   * UPLOAD_BODY_LIMIT_BYTES). Business rules stay with their owners;
   * assembly composes (A03).
   */
  const app = assembleHttpApp({
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
    // #733：来源裁决的 Access 与部署库同源（billing 组携带的就是部署库本身）。
    ...(billing?.database
      ? {
          memorySourceAccess: createOpenBotSourceAccess({
            database: billing.database,
          }),
        }
      : {}),
    createDeploymentRequireUser,
    credentialInput,
    recordPersonEvent,
    defaultReadinessProbe,
    uploadBodyLimitBytes: UPLOAD_BODY_LIMIT_BYTES,
    requireThreadReaderClient,
  });

  return app;
}

function credentialInput(
  value: unknown,
  actorUserId: string,
): CredentialInput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const body = value as Record<string, unknown>;
  /*
   * An allowlist, and deliberately narrower than `CredentialKind`.
   *
   * `CredentialKind` is derived from the schema enum, so it now includes `mcp_oauth_client` and
   * `mcp_user_token`. Neither belongs here. A user token is somebody's own grant and exists only as
   * the outcome of a consent they gave; a client is registered when a connector is added. Both are
   * written by the code that owns those flows, and an administrator hand-posting either would be
   * creating a credential attributed to a person who never agreed to it.
   *
   * So this list is not out of date with the enum — do not widen it to match.
   */
  if (
    (body.kind !== "model" &&
      body.kind !== "connector" &&
      body.kind !== "mcp") ||
    typeof body.provider !== "string" ||
    !body.provider.trim() ||
    typeof body.keyId !== "string" ||
    !body.keyId.trim() ||
    typeof body.plaintext !== "string" ||
    !body.plaintext ||
    !body.metadata ||
    typeof body.metadata !== "object" ||
    Array.isArray(body.metadata) ||
    Object.getPrototypeOf(body.metadata) !== Object.prototype
  ) {
    return null;
  }

  return {
    kind: body.kind,
    provider: body.provider.trim(),
    keyId: body.keyId.trim(),
    metadata: body.metadata as Record<string, unknown>,
    plaintext: body.plaintext,
    actorUserId,
  };
}

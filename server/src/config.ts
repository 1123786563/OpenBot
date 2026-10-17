function spreadOptional<K extends string, V>(
  key: K,
  value: V | undefined,
): { [_ in K]?: V } {
  return value === undefined ? {} : ({ [key]: value } as { [_ in K]?: V });
}

/**
 * What the runtime can do. There is exactly one answer because CopilotKit Intelligence is required
 * for durable threads and memory. Configuration the product cannot function without belongs at the
 * boot boundary.
 */
import {
  isLearningContainerId,
  type LearningTarget,
} from "../../shared/learning";
import { getLogger } from "../../shared/logger";
import { singleUserEnabled } from "./auth/dev-actor";
import { normalizeDomain } from "./auth/email-domain";
import { organizationAuthority } from "./auth/organization";
import type {
  BillingEntitlementEntry,
  BillingQuotaEntry,
  PlanCatalogCycle,
  PlanCatalogEntry,
} from "./billing/types";
import type { ActionPolicy } from "./computer/policy";
import { parseActionPolicy } from "./computer/policy-store";
import {
  type TranscriptionConfig,
  transcriptionConfig,
} from "./dictation/config";
import { type VoiceConfig, voiceConfig } from "./voice/config";
import { type WebBotAuth, webBotAuthFromEnv } from "./web-bot-auth";

/** The ledger's scale, restated as a config-layer constant: config must not import the read module. */
const CREDIT_SCALE_FOR_CONFIG = 100;

const log = getLogger("server");

export type RuntimeCapabilities = {
  mode: "intelligence";
  durableHistory: true;
  intelligence: IntelligenceSettings;
};

/**
 * The Intelligence contract. Three values are required; see runtimeCapabilities.
 *
 * `licenseToken` is optional. Managed Intelligence derives entitlement from the project key, and
 * `@copilotkit/runtime` declares `licenseToken` optional with a `COPILOTKIT_LICENSE_TOKEN` fallback
 * of its own. A deployment that still holds one keeps passing it; nothing here requires it.
 */
export type IntelligenceSettings = {
  apiUrl: string;
  gatewayWsUrl: string;
  apiKey: string;
  licenseToken?: string;
};

export type DockerComputerConfig = {
  provider: "docker";
  baseUrl: string;
  supervisorToken?: string;
  token?: string;
  allowPrivateHosts: boolean;
  policy?: ActionPolicy;
};

export type SharedComputerConfig = {
  provider: "shared";
  baseUrl: string;
  token?: string;
  allowPrivateHosts: boolean;
  policy?: ActionPolicy;
};

/**
 * A computer each, created by the cluster.
 *
 * The namespace is the whole scope: the service account this runs under may manage Sandboxes there
 * and nowhere else, which is a smaller blast radius than the Docker supervisor's, since that one
 * holds a socket that is root-equivalent on its host.
 */
export type SandboxComputerConfig = {
  provider: "sandbox";
  namespace: string;
  idleAfterMs: number;
  /** Where the chart mounted the shape of a computer. */
  templateFile: string;
  token?: string;
  allowPrivateHosts: boolean;
  policy?: ActionPolicy;
};

export type ComputerConfig =
  | DockerComputerConfig
  | SharedComputerConfig
  | SandboxComputerConfig;

/**
 * Who a deployment lets in, and through which front door.
 *
 * One identity provider is a product decision somebody else already made. A company running this
 * has Google or Entra or Okta and is not going to acquire another, so the shape here is a set of
 * optional providers rather than one required one, and the deployment turns on whichever it has.
 */
export type AuthProviderId = "google" | "microsoft" | "okta" | "casdoor";

/** An OAuth client, as every provider here needs one. */
export type OAuthClient = { clientId: string; clientSecret: string };

export type GithubAppConfig = {
  clientId: string;
  clientSecret: string;
};

export type AuthConfig = {
  baseUrl: string;
  secret: string;
  trustedOrigins: string[];
  initialAdminEmails: string[];
  /**
   * Email domains this deployment admits, on top of whatever the provider decided.
   *
   * Empty means no opinion, which is what every deployment running today already does. See
   * `auth/email-domain.ts` for why the provider's own answer is not this question.
   */
  allowedEmailDomains: string[];
  google?: OAuthClient;
  /**
   * `tenantId` decides who may sign in at all, so it is not a detail. `common` admits any Microsoft
   * account including personal ones, `organizations` any work or school account anywhere, and a GUID
   * admits one directory. A deployment that wants only its own company needs the GUID.
   */
  microsoft?: OAuthClient & { tenantId: string };
  /** Okta is an OIDC provider rather than a named one, so it is identified by its issuer. */
  okta?: OAuthClient & { issuer: string };
  /**
   * Casdoor, likewise an OIDC provider identified by its issuer. The issuer is the Casdoor origin
   * itself, such as `http://localhost:8000`, whose `/.well-known/openid-configuration` names the
   * authorization, token and userinfo endpoints.
   */
  casdoor?: OAuthClient & { issuer: string };
  /**
   * Email + password sign-in (Better Auth's `emailAndPassword`), for clients
   * without a browser to run OAuth in — the OpenMuse mobile app. Off by
   * default: deployments that authenticate through a provider keep this
   * surface closed. `decideSignInMethod` still refuses it on SSO-mandatory
   * deployments even when this is on.
   */
  emailPassword?: boolean;
};

/**
 * The providers this deployment can actually sign somebody in with.
 *
 * Ordered, and deliberately not alphabetically: this is the order the buttons appear in, and it is
 * fixed here rather than left to object key order so the sign-in screen cannot change shape because
 * of how a configuration happened to be written.
 */
export function configuredAuthProviders(
  auth: AuthConfig | undefined,
): AuthProviderId[] {
  if (!auth) return [];
  const providers: AuthProviderId[] = [];
  if (auth.google) providers.push("google");
  if (auth.microsoft) providers.push("microsoft");
  if (auth.okta) providers.push("okta");
  if (auth.casdoor) providers.push("casdoor");
  return providers;
}

export type ManagedAgentConfig = {
  /** The bundled Bot, absent when this deployment's provider cannot run it. */
  endpoint?: URL;
  /** Secret sent only to endpoints this deployment runs. Never stored in an agent row. */
  token: string;
  /**
   * The harness picked during setup, when there is one.
   *
   * Also an endpoint this deployment runs: its container was started by this deployment, on a port
   * it chose, holding this token. It gets the same header for the same reason.
   */
  alsoRun?: URL;
};

/**
 * How far one Bot handing work to another may go.
 *
 * NUMBERS A DEPLOYMENT CHOOSES, not constants. A small team and a company running this across
 * departments want different answers, and neither should have to edit code to get one.
 *
 * Both defaults are deliberately mean. A hop costs a whole agent turn at the other end, fan-out
 * shapes cost several times a single run because each Bot spends its own full budget, and on a
 * cluster a hop to a Bot whose computer is asleep also pays a pod resume. One level of delegation is
 * what most systems allow by default, and a deployment that wants more can say so.
 */
export type HandoffCaps = {
  /** How many Bots deep a chain may go. `0` switches the whole capability off. */
  maxDepth: number;
  /** How many other Bots one run may address. */
  maxPerRun: number;
};

export type DeploymentConfig = {
  /** Optional environment default. A saved Admin setting takes precedence. */
  learning?: LearningTarget;
  /**
   * Whether OpenBot assigns the Intelligence project's `openbot` Learning container as the default
   * when nobody has chosen one (learning/auto-assign.ts). On unless OPENBOT_LEARNING_AUTO_ASSIGN is
   * "false" or "0", and off whenever CPK_INTELLIGENCE_LEARNING_CONTAINER_ID names a container. It
   * never overrides a saved Admin setting. It creates the container only with a credential that can
   * (see `learningSetup`), never with the runtime key.
   */
  learningAutoAssign: boolean;
  /**
   * A credential that can create Learning containers, for a deployment whose operator supplied one.
   *
   * The runtime key cannot: Intelligence creates containers for a person's session, a CopilotKit CLI
   * login, or, on a CopilotKit local evaluation install only, a service token. The server holds
   * neither of the first two, so this is the service token, sent as `x-copilotkit-ei-service-token`
   * to `/api/learning/projects/:projectId/containers` with the project it belongs to. Both or
   * neither: a token without its project is refused at startup.
   */
  learningSetup?: { serviceToken: string; projectId: string };
  /**
   * Memory sources and background research OpenBot switches on for each person (memory/defaults.ts).
   * Both on unless OPENBOT_MEMORY_SOURCE_DEFAULTS or OPENBOT_PROACTIVE_DEFAULTS is "false" or "0".
   * Switching either off stops new defaults and leaves every existing row as it is.
   */
  memoryDefaults: { sources: boolean; research: boolean };
  /**
   * The multitenancy switch and its startup-validation inputs (MT013).
   *
   * Off by default; the legacy single-tenant boot is byte-for-byte unchanged while it is off.
   * On, the process runs the three startup checks in enterprise/tenancy/startup-checks.ts and
   * refuses to boot on any gap. `inventoryPath` names the CoverageInventory JSON the MT001
   * generator (`server/scripts/multitenancy/inventory.ts`) produced; `waiversPath` names an
   * explicit waiver list whose every entry carries a reason, because an audited exception is
   * the only kind this mode accepts.
   */
  multitenancy: {
    enabled: boolean;
    inventoryPath?: string;
    waiversPath?: string;
  };
  /** Audio configuration is independent of agent model providers. */
  transcription?: TranscriptionConfig;
  voice?: VoiceConfig;
  /** The port the API listens on. Named `PORT` or `SERVER_PORT`; see `serverPort`. */
  port: number;
  databaseUrl: string;
  enterpriseDirectoryDatabaseUrl?: string;
  enterpriseDataDatabaseUrl?: string;
  tenantStorageRuntimeDatabaseUrl?: string;
  keyEncryptionKey: string;
  /**
   * Authentication for the bundled Bot and/or the installed picked harness.
   *
   * The bundled endpoint is optional: plan credentials can run a picked harness without it.
   * Its presence, not this auth configuration, determines whether a bundled Bot is available.
   */
  managedAgent?: ManagedAgentConfig;
  /**
   * Private addresses an agent may be registered at, named one at a time.
   *
   * WHY THIS EXISTS. `AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS` is a floor, not a permission: it opens this
   * deployment's whole network, to browsing and to agent endpoints alike, which is why a production
   * deployment refuses to start with it on. That left bring-your-own-agent — a headline capability —
   * unusable in the image people are told to deploy, because a company's own agent legitimately lives
   * at an internal address and the only way to reach it was to drop the floor.
   *
   * So the address is named instead. Nothing else is opened, browsing is not widened, and the
   * never-allowed list is still checked first, so the metadata address cannot be named back in.
   * Empty by default, which is the same posture as before for anybody who does not set it.
   */
  agentEndpointAllowedHosts: ReadonlySet<string>;
  /**
   * What this deployment calls itself, when more than one shares an Intelligence project.
   *
   * Absent, the tenant package's id stands in, which separates deployments running different
   * packages but not a copy of one running alongside the original. See channels/thread-identity.ts.
   */
  deploymentId: string | undefined;
  /**
   * The key this deployment talks to Composio with, the broker that holds people's accounts for a
   * few hundred apps so a Bot can act in Gmail or Slack without an OAuth client of this
   * deployment's own registered with each of them.
   *
   * Optional, and undefined is the ordinary state rather than a degraded one. A deployment that has
   * not bought Composio is not a deployment missing something: there is nothing to connect, nothing
   * to grant and no Composio tool for a Bot to call, what remains on screen is one row that goes
   * nowhere under More apps on the admin Plugins page naming this variable, and nothing else it does
   * is any worse for that.
   *
   * Nothing here validates the key. There is no shape to check it against and no call worth making
   * at boot to find out, so the first real request is what says whether it works — which is also
   * where a key that was revoked last week would have surfaced regardless.
   */
  composioApiKey: string | undefined;
  /** GitHub App user sign-in, so people can link their GitHub account. Both or neither of GITHUB_APP_CLIENT_ID / GITHUB_APP_CLIENT_SECRET. */
  githubApp?: GithubAppConfig;
  /**
   * Where this deployment's OpenConnector container listens. Set by the deployer, never by a request.
   *
   * An ORIGIN rather than a base with a path, because every request the adapter issues is an
   * absolute path resolved against it — and the adapter validates the shape (absolute, http or
   * https, no user info) before it builds a client, refusing the boot that mis-set it rather than
   * the first person's connect attempt. The default names the documented compose service, which
   * binds the container to the host's loopback only.
   */
  openConnectorUrl: string;
  /**
   * The two faces of the same self-hosted broker: `OPENCONNECTOR_ADMIN_TOKEN` speaks for the
   * management face (`/api/*` — connections), `OPENCONNECTOR_RUNTIME_TOKEN` for the execution face
   * (`/v1/*` — the directory and action calls). Both unset is the ordinary state rather than a
   * degraded one, exactly as `composioApiKey` above: one inert row under More apps, nothing
   * connectable, nothing granted.
   */
  openConnectorAdminToken: string | undefined;
  openConnectorRuntimeToken: string | undefined;
  /**
   * Where this deployment is reached from outside, with no trailing slash.
   *
   * Needed because an OAuth redirect URI has to match what an administrator registered with the
   * vendor character for character, and it is shown on the Plugins page for them to copy. Built from
   * configuration rather than from the incoming request: a redirect URI assembled out of a Host
   * header is one an attacker has a say in.
   *
   * `OPENBOT_PUBLIC_URL` when set, otherwise `BETTER_AUTH_URL`, which is the same public address for
   * every deployment that has real sign-in. Undefined only where neither exists, which is a local
   * deployment running without authentication — and there is nothing to connect there anyway.
   */
  publicUrl: string | undefined;
  /**
   * The key Bots' browsers sign their requests with, and the address its public half is published
   * under. Undefined when Web Bot Auth is off; see `web-bot-auth.ts` for when that is.
   */
  webBotAuth?: WebBotAuth;
  /**
   * Where the browser app is served from, with no trailing slash.
   *
   * Separate from {@link DeploymentConfig.publicUrl} because they are genuinely two addresses: the
   * app is a Vite process on its own port locally, and the API is another. An OAuth callback lands on
   * the API and has to send the person back to a page, so a relative redirect would put them on the
   * API's origin, where no page exists.
   *
   * `OPENBOT_APP_URL` when set, otherwise the first `TRUSTED_ORIGINS` entry, which is already defined
   * as where the app is served from. Falls back to the API's own public URL, which is right for a
   * deployment serving both from one origin.
   */
  appUrl: string | undefined;
  tenantPackageDirectory: string;
  runtime: RuntimeCapabilities;
  /**
   * How long a Bot's stream may say nothing before this deployment ends the turn, in milliseconds.
   *
   * Zero means no watchdog, and an unset variable means zero. A turn that is ended is a turn
   * somebody loses, so a deployment that has not said it wants that gets the behaviour it already
   * had. `.env.example` ships a value, so a new clone starts with the watch on and an upgraded
   * deployment does not acquire it without being asked.
   */
  agentStallTimeoutMs: number;
  /**
   * How many days of audit trail this deployment keeps, or undefined to keep everything.
   *
   * Undefined by default. Deleting somebody's audit trail because a default said so is the worse of
   * the two failures, and a deployment that has not thought about retention should keep everything
   * until it has.
   */
  auditRetentionDays: number | undefined;
  oauth: {
    google?: { clientId: string; clientSecret: string };
  };
  auth?: AuthConfig;
  /** Customer OpenBot authority for employee desktop sessions, separate from Intelligence. */
  organizationAuthUrl?: string;
  /**
   * Admit everybody as one fixed administrator instead of requiring sign-in.
   *
   * True only when no identity provider is configured. See auth/dev-actor.ts for what stops this
   * reaching somewhere other people can get to.
   */
  singleUser: boolean;
  /** Names OpenBot on the analytics the runtime already sends. Off with OPENBOT_ACCESSIBILITY_DISABLED. */
  accessibility: boolean;
  /**
   * Whether a Bot may answer with an interface it wrote itself.
   *
   * This is not the component catalogue. A component is something this deployment holds: it was
   * either compiled into the build or authored in the playground, an administrator granted it to a
   * Bot, and all a Bot decides is which of them to draw. Here there is nothing to grant, because
   * there is nothing yet — the Bot writes the markup, the styles and the script for this one answer,
   * and they are gone when the conversation moves on.
   *
   * A deployment switch rather than a per-Bot grant because the SDK offers no seam for one. The
   * interface is painted from activity events that only the runtime middleware emits, and the tool
   * the model calls is registered by the browser for every Bot the moment that middleware is on.
   * Narrowing the middleware to some Bots would leave the rest able to call the tool and draw
   * nothing at all, which is a worse answer than never offering it.
   *
   * On by default. A deployment that cannot allow generated interfaces can explicitly opt out with
   * OPENBOT_GENERATIVE_UI=false or OPENBOT_GENERATIVE_UI=0.
   *
   * What it runs is sandboxed by the SDK, in an iframe with no same-origin access to this app, so a
   * generated interface reaches this deployment's data only through what the host hands it. This
   * deployment hands it nothing. It can load libraries from a CDN, which is the part a deployment
   * that must not reach the public internet from a browser tab needs to weigh.
   */
  generativeUi: boolean;
  /**
   * Whether the signed-in app shows the banner offering help self-hosting OpenBot.
   *
   * On by default, because a fresh clone is somebody evaluating the template. A fork that runs
   * OpenBot for its own organization turns it off with OPENBOT_SELF_HOST_BANNER=false or
   * OPENBOT_SELF_HOST_BANNER=0, since its people have nothing to self-host. This is the operator's
   * switch only; a deployment on a paid Intelligence plan hides the bar too (self-host-banner.ts).
   */
  selfHostBanner: boolean;
  /**
   * Where the built app is, when this process serves it.
   *
   * Set in a container image that carries both. Unset in development, where Vite serves the app and
   * proxies the API here, so the server stays an API and nothing shadows a route.
   */
  appDistDir?: string;
  /**
   * The Bot computer. Absent means the feature is off and its routes are not mounted, rather than
   * mounted and failing: a capability that is not configured should be missing, not broken.
   */
  computer?: ComputerConfig;
  /**
   * The paid-plan provider. Same absent-means-unmounted contract as the computer above it: a
   * deployment that has not configured billing has no billing routes, no webhook door and no
   * entitlements to read, rather than surfaces that are mounted and permanently refusing.
   *
   * Carries no secret beyond the provider credentials themselves, which live only here, in the
   * environment and in the request headers the client sends — never in a log line or a response.
   */
  billing?: LagoBillingConfig;
  /**
   * The direct-collection channels, beside the billing projection above. Same absent-means-
   * unmounted contract: a deployment that configured no channel mounts no payment surface at all.
   * Present only when at least one channel is whole AND billing itself is configured — the
   * channels collect money that becomes a Lago subscription, so a channel without the projection
   * it feeds is a deployment wired wrong, and refuses to start rather than collecting into
   * nothing.
   */
  payments?: PaymentsConfig;
  /** How far one Bot handing work to another may go. */
  handoff: HandoffCaps;
  /**
   * The secret a Bot presents when it calls a tool back through this server.
   *
   * A framework Bot runs its own tool loop, in its own process, which is what makes it a real
   * harness rather than a shape the browser drives. It still may not reach a vendor directly: it
   * calls here, and here is where the grant, the policy and the audit row are. This is what tells
   * that call apart from anybody else on the network.
   *
   * Absent means no Bot may call tools back, and a deployment that wanted them gets a refusal rather
   * than an open door.
   */
  agentToolToken?: string;
  /**
   * The secret the worker presents when it hands a routine run back to this server.
   *
   * Absent means the internal routines endpoint refuses everything, which is the correct state of a
   * deployment with no worker — a deployment that has not asked for scheduled turns should not have a
   * door for them standing open.
   */
  workerSharedSecret?: string;
};

export type Environment = Record<string, string | undefined>;

/**
 * The caps, read from the environment, refusing anything that is not a whole number at least zero.
 *
 * Refused rather than coerced. A cap is a safety number, and a deployment that typed `two` and got
 * the default would believe it had set one: the failure has to be at start-up where somebody is
 * looking, not at the first loop.
 */
function handoffCaps(environment: Environment): HandoffCaps {
  const read = (name: string, fallback: number): number => {
    const raw = optional(environment, name);
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`${name} must be a whole number of zero or more`);
    }
    return value;
  };
  return {
    // One level of delegation, which is what most systems allow before anybody asks for more.
    maxDepth: read("BOT_HANDOFF_MAX_DEPTH", 1),
    maxPerRun: read("BOT_HANDOFF_MAX_PER_RUN", 3),
  };
}

function required(environment: Environment, name: string): string {
  const value = environment[name]?.trim();
  if (!value) {
    throw new Error(`${name} must be configured`);
  }
  return value;
}

function optional(environment: Environment, name: string): string | undefined {
  return environment[name]?.trim() || undefined;
}

/**
 * Whether this deployment says it is in production, which is what the two hard refusals turn on.
 *
 * ONE PLACE, BECAUSE THE TWO GATES DID NOT AGREE. Both refuse a local-only setting on a deployed
 * server — the example encryption key, and private-host browsing — and both compare `NODE_ENV`
 * against `"production"`. The private-hosts gate read it through `optional`, so the comparison
 * trimmed; the key gate compared `environment.NODE_ENV` raw.
 *
 * Both sides of that comparison come out of the same file. `NODE_ENV=production ` with a trailing
 * space — invisible in an env file, and preserved verbatim by Docker's `env_file` and by every
 * hosting dashboard with a text box — therefore tripped one refusal and slipped past the other. The
 * one it slipped past is the one that decides whether the credential vault may be encrypted with a
 * key printed in this repository.
 *
 * A helper rather than a second `optional` call, so the next gate that needs this question cannot
 * pick the wrong way to ask it.
 */
function isProduction(environment: Environment): boolean {
  return optional(environment, "NODE_ENV") === "production";
}

/**
 * The key in `.env.example`, which every clone of this repository starts with.
 *
 * It is a valid key, which is the whole problem: it is the right length and the right encoding, so
 * nothing about it fails a check. A deployment that never changed it encrypts its credential vault
 * with a key printed in a public repository, and looks exactly like one that did.
 */
const PLACEHOLDER_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

export function keyEncryptionKey(environment: Environment): string {
  const value = required(environment, "KEY_ENCRYPTION_KEY");
  const decoded = Buffer.from(value, "base64");

  if (decoded.byteLength !== 32 || decoded.toString("base64") !== value) {
    throw new Error("KEY_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
  }

  /**
   * Refused in production, warned everywhere else. The placeholder is convenient locally and public
   * in any deployment.
   */
  if (value === PLACEHOLDER_KEY) {
    if (isProduction(environment)) {
      throw new Error(
        "KEY_ENCRYPTION_KEY is still the example key from .env.example, which is public. Generate one with: openssl rand -base64 32",
      );
    }
    log.warn(
      "KEY_ENCRYPTION_KEY is the example key from .env.example, which is public. Fine locally. Generate a real one before deploying: openssl rand -base64 32",
    );
  }

  return value;
}

/**
 * Whether this deployment may run with no sign-in at all.
 *
 * {@link singleUserEnabled} answers whether somebody ASKED for it, and the flag is how they say so.
 * That design is deliberate and stays: `single-user.test.ts` pins it, and the boot comment in
 * `.github/workflows/ci.yml` says the same thing in the same words. This asks the second question
 * the flag cannot answer, which is not "is this production" but "can anybody else reach it".
 *
 * NOT `NODE_ENV`. It looks like the signal and is not one here: `Dockerfile` sets
 * `NODE_ENV=production` for every container and `openbot.commonEnv` sets it for every chart
 * install, including the local trial the chart's own `validation.yaml` offers. Gating on it would
 * refuse a mode the chart advertises and would fail the image-boot job in CI, which runs exactly
 * this combination on purpose.
 *
 * The chart already asks the right question twice, and this is the same question moved to where a
 * deployment that never goes near Helm is also asked it:
 *
 *   config.singleUser + a LoadBalancer with no source ranges -> refused
 *   config.singleUser + config.publicUrl                     -> refused
 *
 * So: one administrator and no sign-in is a thing you run where only you can reach it. A public
 * URL, or a trusted origin that is not loopback, says somebody else can. `.env.example` ships the
 * flag on so a clone runs, and README's "Deploy it" hands that same `.env` to `docker run`; what
 * separates those two is an address, which is what this reads.
 */
function singleUserAllowed(
  environment: Environment,
  hasProvider: boolean,
): boolean {
  if (!singleUserEnabled(environment, hasProvider)) return false;

  const reachable = [
    optional(environment, "OPENBOT_PUBLIC_URL"),
    optional(environment, "OPENBOT_APP_URL"),
    ...commaSeparated(environment, "TRUSTED_ORIGINS"),
  ].filter((value): value is string => value !== undefined);

  const published = reachable.filter((value) => reachOf(value) === "public");
  if (published.length > 0) {
    throw new Error(
      `OPENBOT_SINGLE_USER admits every request as one administrator with no sign-in, so it cannot be combined with an address the public internet reaches: ${published.join(", ")}. Configure GOOGLE_OAUTH_*, MICROSOFT_OAUTH_* or OKTA_OAUTH_* with BETTER_AUTH_SECRET and BETTER_AUTH_URL, or serve it somewhere only you reach.`,
    );
  }

  /*
   * A private address is allowed and said out loud. index.ts already warns every boot that there is
   * no sign-in; what it cannot say, because it never reads an address, is that this one is carried
   * beyond the machine. Whoever is on that network is an administrator here.
   */
  const shared = reachable.filter((value) => reachOf(value) === "private");
  if (shared.length > 0) {
    log.warn(
      { addresses: shared.join(", ") },
      "OPENBOT_SINGLE_USER admits every request as one administrator with no sign-in, and this " +
        "deployment answers on an address beyond this machine. Anybody on that network is that " +
        "administrator. Configure a sign-in provider before anybody else is on it.",
    );
  }

  return true;
}

/**
 * How far an address reaches, which is the question `OPENBOT_SINGLE_USER` actually turns on.
 *
 * Not two answers but three, because the middle one is most of the deployments this flag exists
 * for. "No sign-in, one administrator" is a thing people run on a home server at `192.168.1.10`,
 * over Tailscale at `100.something`, on a VPN, or at `openbot.local`. None of those is loopback and
 * none of them is a stranger's to reach, so refusing them would refuse the feature's own audience
 * while the operator's only recourse is to turn off the flag that describes what they are doing.
 *
 * A routable public address is the different thing, and it is the one that refuses.
 *
 * UNPARSEABLE COUNTS AS PUBLIC, and so does an unrecognised name. A value nobody could read is not
 * a value anybody checked, and the safe reading of "I cannot tell" is never "it is fine".
 */
type Reach = "loopback" | "private" | "public";

function reachOf(raw: string): Reach {
  let bare: string;
  try {
    bare = new URL(raw).hostname.toLowerCase();
  } catch {
    return "public";
  }
  bare = bare.replace(/^\[|\]$/g, "").replace(/\.+$/, "");

  if (
    bare === "localhost" ||
    bare === "::1" ||
    bare === "0:0:0:0:0:0:0:1" ||
    /^127(\.\d{1,3}){3}$/.test(bare)
  ) {
    return "loopback";
  }

  if (bare.includes(":")) {
    // fc00::/7 is the unique local range and fe80::/10 the link-local one. Both are unroutable on
    // the public internet, which is the only property being asked about here.
    return /^f[cd]/.test(bare) || /^fe[89ab]/.test(bare) ? "private" : "public";
  }

  const octets = bare.split(".");
  if (octets.length === 4 && octets.every((part) => /^\d{1,3}$/.test(part))) {
    const [a, b] = octets.map(Number) as [number, number, number, number];
    const privateV4 =
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      // 169.254/16 is link-local, and 100.64/10 is the carrier-grade NAT range Tailscale hands out.
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127);
    return privateV4 ? "private" : "public";
  }

  // A name rather than an address. `.local` is mDNS, `.internal` and `.home.arpa` are reserved for
  // exactly this, and a single label with no dot at all is a LAN name that no public resolver
  // answers. Anything else is a name somebody could look up.
  const privateName =
    !bare.includes(".") ||
    bare.endsWith(".local") ||
    bare.endsWith(".internal") ||
    bare.endsWith(".lan") ||
    bare.endsWith(".home.arpa");
  return privateName ? "private" : "public";
}

function url(environment: Environment, name: string): string | undefined {
  const value = optional(environment, name);
  if (!value) {
    return undefined;
  }

  try {
    new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
  return value;
}

function optionalHttpUrl(
  environment: Environment,
  name: string,
): URL | undefined {
  const value = optional(environment, name);
  if (!value) {
    return undefined;
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid HTTP(S) URL`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${name} must be a valid HTTP(S) URL`);
  }

  return parsed;
}

/**
 * The Bot in the box, if this deployment has one.
 *
 * A URL with no token would send unauthenticated calls to a Bot that refuses them, so that half
 * alone refuses to start. A token with no URL is the leftover `scripts/start.sh` writes into
 * `.env`; it names nothing and is ignored, so a one-container image can boot from that file.
 */
function managedAgentConfig(
  environment: Environment,
): ManagedAgentConfig | undefined {
  const endpoint = optionalHttpUrl(environment, "MANAGED_AGENT_AG_UI_URL");
  // BYO writes a URL too, but does not run our image or hold our deployment token.
  const alsoRun = optional(environment, "PICKED_HARNESS_IMAGE")
    ? optionalHttpUrl(environment, "PICKED_HARNESS_URL")
    : undefined;
  const token = optional(environment, "MANAGED_AGENT_TOKEN");
  if (endpoint && !token) {
    throw new Error(
      "MANAGED_AGENT_TOKEN must be set when MANAGED_AGENT_AG_UI_URL is set",
    );
  }
  if (alsoRun && !token) {
    throw new Error(
      "MANAGED_AGENT_TOKEN must be set when an installed PICKED_HARNESS_URL is set",
    );
  }
  if ((!endpoint && !alsoRun) || !token) {
    return undefined;
  }
  /*
   * The harness somebody picked during setup is also an endpoint this deployment runs.
   *
   * It is a container this deployment started, on a port this deployment chose, holding the token
   * this deployment generated — the same relationship the Bot in the box has. It was not getting
   * the token because that was attached by matching one endpoint exactly, so the picked Bot was
   * registered, addressable, routed to, and answered every call with 401. Only visible by asking it
   * something in the window.
   */
  return {
    ...(endpoint ? { endpoint } : {}),
    token,
    ...(alsoRun ? { alsoRun } : {}),
  };
}

function oauthClient(
  environment: Environment,
  provider: "GOOGLE" | "MICROSOFT" | "OKTA" | "CASDOOR",
): OAuthClient | undefined {
  const clientId = optional(environment, `${provider}_OAUTH_CLIENT_ID`);
  const clientSecret = optional(environment, `${provider}_OAUTH_CLIENT_SECRET`);

  // Both or neither. One alone is a half-configured sign-in that fails at the first attempt rather
  // than at start-up, which is the worst moment to discover it.
  if (Boolean(clientId) !== Boolean(clientSecret)) {
    throw new Error(
      `${provider}_OAUTH_CLIENT_ID and ${provider}_OAUTH_CLIENT_SECRET must be set together`,
    );
  }

  return clientId && clientSecret ? { clientId, clientSecret } : undefined;
}

function githubAppConfig(
  environment: Environment,
): GithubAppConfig | undefined {
  const clientId = optional(environment, "GITHUB_APP_CLIENT_ID");
  const clientSecret = optional(environment, "GITHUB_APP_CLIENT_SECRET");

  // Both or neither. One alone is a half-configured sign-in that fails at the first attempt rather
  // than at start-up, which is the worst moment to discover it.
  if (Boolean(clientId) !== Boolean(clientSecret)) {
    throw new Error(
      "GITHUB_APP_CLIENT_ID and GITHUB_APP_CLIENT_SECRET must be set together",
    );
  }

  return clientId && clientSecret ? { clientId, clientSecret } : undefined;
}

function commaSeparated(environment: Environment, name: string): string[] {
  return (optional(environment, name) ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

/**
 * Microsoft's three multi-tenant audiences, which name no directory.
 *
 * Anything else is a directory this deployment's administrators control, named by GUID or by a
 * verified domain. `organizations` matters as much as `common` here and is the one a hand-written
 * check forgets: Microsoft's own description is that it admits any work or school account in any
 * directory, so a domain allowlist is no more enforceable under it than under `common`.
 *
 * Compared folded, because these arrive from an environment variable and `Common` is the same
 * audience as `common` to Microsoft.
 */
const MULTI_TENANT_AUDIENCES = new Set([
  "common",
  "organizations",
  "consumers",
]);

function namesNoDirectory(tenantId: string | undefined): boolean {
  return (
    tenantId !== undefined &&
    MULTI_TENANT_AUDIENCES.has(tenantId.trim().toLowerCase())
  );
}

/**
 * Sign-in, if this deployment has an identity provider to sign people in with.
 *
 * Any one of the four turns authentication on. More than one is allowed and is the normal shape
 * for a company mid-migration, where some people are on Entra and some are still on Okta.
 *
 * Every combination that cannot work refuses at start-up rather than at somebody's first attempt to
 * sign in, which is the worst moment to discover it: a provider with half its credentials, a
 * provider with no session secret to mint against, or a session secret configured with no provider
 * to use it.
 */
function authConfig(
  environment: Environment,
  google: OAuthClient | undefined,
): AuthConfig | undefined {
  const microsoft = microsoftAuth(environment);
  const okta = oktaAuth(environment);
  const casdoor = casdoorAuth(environment);

  const secret = optional(environment, "BETTER_AUTH_SECRET");
  const baseUrl = url(environment, "BETTER_AUTH_URL");

  if (!google && !microsoft && !okta && !casdoor) {
    if (secret || baseUrl) {
      throw new Error(
        "BETTER_AUTH_SECRET or BETTER_AUTH_URL is set but no identity provider is. Configure GOOGLE_OAUTH_*, MICROSOFT_OAUTH_*, OKTA_OAUTH_* or CASDOOR_OAUTH_*, or unset both",
      );
    }
    return undefined;
  }
  if (!secret) {
    throw new Error("Sign-in requires BETTER_AUTH_SECRET");
  }
  if (secret.length < 32) {
    throw new Error("BETTER_AUTH_SECRET must be at least 32 characters");
  }
  if (!baseUrl) {
    throw new Error("Sign-in requires BETTER_AUTH_URL");
  }

  /*
   * Somebody has to be an administrator, and only this says who.
   *
   * The role is written from this list and there is no route anywhere that changes one, so a
   * deployment that configures sign-in without it admits everybody as a plain user, shows nobody
   * the admin screens, and offers no way to promote anyone. Refusing at start-up is the only cheap
   * moment to catch that; the expensive one is after the first person has signed in.
   */
  const initialAdminEmails = commaSeparated(
    environment,
    "INITIAL_ADMIN_EMAILS",
  );
  if (initialAdminEmails.length === 0) {
    throw new Error(
      "Sign-in requires INITIAL_ADMIN_EMAILS naming at least one administrator. Nothing else grants the role, and no screen can promote somebody once the deployment is running",
    );
  }

  /**
   * Who may sign in, as distinct from who is an administrator once they have.
   *
   * Normalised through the same function the matcher uses, so a rule cannot mean one thing when
   * written and another when matched.
   */
  const namedDomains = commaSeparated(
    environment,
    "SIGNIN_ALLOWED_EMAIL_DOMAINS",
  );
  const allowedEmailDomains = namedDomains
    .map(normalizeDomain)
    .filter((domain): domain is string => domain !== undefined);

  /*
   * A list that names nothing is not an empty list, and the difference is every sign-in.
   *
   * `commaSeparated` drops blank entries BEFORE this normalisation rather than after it, so `@`,
   * `.` and `@.` each survive it and then normalise to nothing. That leaves a non-empty list no
   * address can ever match, every visitor refused at the door, and nothing said at boot. The same
   * reasoning INITIAL_ADMIN_EMAILS gives three lines up applies: start-up is the cheap moment to
   * catch it, and somebody's sign-in is the expensive one.
   */
  if (namedDomains.length > 0 && allowedEmailDomains.length === 0) {
    throw new Error(
      "SIGNIN_ALLOWED_EMAIL_DOMAINS is set but names no domain, so every sign-in would be refused. Write it as example.com,example.co.uk",
    );
  }

  /*
   * A list this deployment cannot enforce is worse than no list.
   *
   * `common` is multi-tenant, and OpenBot never sets `requireEmailVerification` or reads
   * `users.emailVerified`, so the address a rule is applied to is one the signing-in tenant's own
   * administrator wrote. Anybody may create a tenant. So an allowlist under `common` refuses the
   * honest and admits the rest, while reading on the Boundaries page as though it were a control.
   *
   * Refused rather than warned BECAUSE the operator has said what they want: they named domains.
   * The warning below is for the deployment that has said nothing, where multi-tenant may well be
   * the intent.
   */
  if (allowedEmailDomains.length > 0 && namesNoDirectory(microsoft?.tenantId)) {
    throw new Error(
      `SIGNIN_ALLOWED_EMAIL_DOMAINS names domains, but MICROSOFT_OAUTH_TENANT_ID is \`${microsoft?.tenantId}\`, which names no directory and admits accounts from any of them: the address the list is checked against is one the signing-in tenant writes for itself, so the list cannot hold. Set your directory GUID.`,
    );
  }

  /*
   * Nothing at all deciding who may sign in, on a deployment that is deployed. A warning rather
   * than a refusal, because a genuinely multi-tenant deployment is a real thing; arriving there by
   * setting nothing is the case worth naming.
   */
  if (
    isProduction(environment) &&
    allowedEmailDomains.length === 0 &&
    namesNoDirectory(microsoft?.tenantId)
  ) {
    log.warn(
      "MICROSOFT_OAUTH_TENANT_ID is unset, so it is `common` and any Microsoft account may sign in, including personal ones, and SIGNIN_ALLOWED_EMAIL_DOMAINS names no domain either. Set your directory GUID, or name the domains you admit.",
    );
  }

  return {
    baseUrl,
    secret,
    trustedOrigins: commaSeparated(environment, "TRUSTED_ORIGINS").length
      ? commaSeparated(environment, "TRUSTED_ORIGINS")
      : /*
         * All three spellings of the same place, because this is an allowlist of what a browser
         * sends and not an address anything dials. `localhost` alone refused a browser pointed at
         * `127.0.0.1:3010`, which is the address the rest of this deployment hands out.
         */
        ["http://127.0.0.1:3010", "http://[::1]:3010", "http://localhost:3010"],
    initialAdminEmails,
    allowedEmailDomains,
    ...(google ? { google } : {}),
    ...(microsoft ? { microsoft } : {}),
    ...(okta ? { okta } : {}),
    ...(casdoor ? { casdoor } : {}),
    emailPassword: optional(environment, "OPENBOT_EMAIL_PASSWORD") === "true",
  };
}

/**
 * Entra ID, and which directory it admits.
 *
 * `common` by default, matching Microsoft's own default, and said out loud in `.env.example` because
 * it admits personal Microsoft accounts as well as work ones. A company that means "our staff"
 * wants its directory GUID here.
 */
function microsoftAuth(
  environment: Environment,
): (OAuthClient & { tenantId: string }) | undefined {
  const client = oauthClient(environment, "MICROSOFT");
  if (!client) return undefined;
  return {
    ...client,
    tenantId: optional(environment, "MICROSOFT_OAUTH_TENANT_ID") ?? "common",
  };
}

/**
 * Okta, which is an OIDC provider rather than a named one.
 *
 * The issuer is what makes it a particular Okta rather than Okta in general, so it is required
 * alongside the credentials rather than defaulted to anything.
 */
function oktaAuth(
  environment: Environment,
): (OAuthClient & { issuer: string }) | undefined {
  const client = oauthClient(environment, "OKTA");
  const issuer = url(environment, "OKTA_OAUTH_ISSUER");
  if (!client) {
    if (issuer) {
      throw new Error(
        "OKTA_OAUTH_ISSUER is set but OKTA_OAUTH_CLIENT_ID and OKTA_OAUTH_CLIENT_SECRET are not",
      );
    }
    return undefined;
  }
  if (!issuer) {
    throw new Error(
      "Okta sign-in requires OKTA_OAUTH_ISSUER, such as https://example.okta.com/oauth2/default",
    );
  }
  return { ...client, issuer };
}

/**
 * Casdoor, an OIDC provider the same way Okta is: not one Better Auth knows the endpoints of, so
 * identified by its issuer and discovered against `/.well-known/openid-configuration`.
 *
 * The issuer is the Casdoor origin itself, path-free, such as `http://localhost:8000` locally or
 * `https://sso.example.com` for a deployment of your own.
 */
function casdoorAuth(
  environment: Environment,
): (OAuthClient & { issuer: string }) | undefined {
  const client = oauthClient(environment, "CASDOOR");
  const issuer = url(environment, "CASDOOR_OAUTH_ISSUER");
  if (!client) {
    if (issuer) {
      throw new Error(
        "CASDOOR_OAUTH_ISSUER is set but CASDOOR_OAUTH_CLIENT_ID and CASDOOR_OAUTH_CLIENT_SECRET are not",
      );
    }
    return undefined;
  }
  if (!issuer) {
    throw new Error(
      "Casdoor sign-in requires CASDOOR_OAUTH_ISSUER, such as http://localhost:8000",
    );
  }
  return { ...client, issuer };
}

/**
 * Sign-in configuration on its own, for entries that authenticate people but run none of the rest.
 *
 * The enterprise API (plan 02 §7 T3-B) proves somebody is a person and then asks the tenancy
 * directory which enterprises that person belongs to — it has no Intelligence runtime, no
 * transcription, no managed agent, and must not be forced to configure any of them just to check a
 * session cookie. This is the same `authConfig` `loadConfig` resolves — the same Google client
 * argument, and Microsoft/Okta/Casdoor resolved inside it — so the enterprise entry and the legacy
 * deployment admit exactly the same people with exactly the same rules. A thin wrapper on purpose:
 * the parsing, the refusal of half-configured providers and the INITIAL_ADMIN_EMAILS floor live in
 * ONE place, not in a second copy an entry could drift from.
 */
export function loadIdentityConfig(
  environment: Environment,
): AuthConfig | undefined {
  return authConfig(environment, oauthClient(environment, "GOOGLE"));
}

/**
 * Resolve the Intelligence contract, or refuse to start.
 *
 * The three addressing values are required together. A partial set is the more dangerous shape than
 * none at all: it means somebody intended to configure Intelligence and got it wrong, so failing on
 * the partial set alone (as this did) let a completely unconfigured deployment through as if that
 * were a choice.
 *
 * COPILOTKIT_LICENSE_TOKEN IS NO LONGER ONE OF THEM. Managed Intelligence issues a single project
 * key and derives entitlement from it, and requiring a second credential here sent people hunting
 * for a token the platform had stopped handing out. It is still read and still forwarded when a
 * deployment sets one, which is what a self-hosted Intelligence with its own licence needs.
 */
function runtimeCapabilities(environment: Environment): RuntimeCapabilities {
  const settings = {
    apiUrl: url(environment, "INTELLIGENCE_API_URL"),
    gatewayWsUrl: url(environment, "INTELLIGENCE_GATEWAY_WS_URL"),
    apiKey: optional(environment, "INTELLIGENCE_API_KEY"),
    licenseToken: optional(environment, "COPILOTKIT_LICENSE_TOKEN"),
  };

  const missing = Object.entries({
    INTELLIGENCE_API_URL: settings.apiUrl,
    INTELLIGENCE_GATEWAY_WS_URL: settings.gatewayWsUrl,
    INTELLIGENCE_API_KEY: settings.apiKey,
  })
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length > 0) {
    throw new Error(
      `CopilotKit Intelligence is required and is not configured. Missing: ${missing.join(", ")}`,
    );
  }

  return {
    mode: "intelligence",
    durableHistory: true,
    intelligence: settings as IntelligenceSettings,
  };
}

/**
 * Whether a Bot may reach addresses inside this deployment's own network.
 *
 * Off unless asked for, and the asking is only allowed on a laptop. The switch exists so that a
 * local deployment can browse the services running beside it; what it turns off is not one rule but
 * the whole private-address floor, in navigation and in the endpoint a Bot may be registered
 * against, so with it on a signed-in person can point a Bot at a link-local address.
 *
 * Refused in production for the reason the example encryption key is: the way a deployment ends up
 * with it is not forgetting to set something, it is copying `.env.example`, which shipped it on. The
 * cloud metadata addresses are refused underneath this either way — see `computer/target.ts` — but
 * that floor is the last one, not the only one worth keeping.
 */
/**
 * The private addresses this deployment will let an agent be registered at.
 *
 * A comma-separated list of hosts, each optionally with a port: `agents.internal`,
 * `10.0.0.42:9000`. Matching is exact, so a name with a port pins that port and a name without one
 * covers any port on that host. No suffixes and no wildcards, because a pattern that widens by
 * accident is the usual way a host check fails, and naming three addresses is not onerous.
 *
 * A scheme or a path is a mistake worth catching here rather than at the first registration that
 * silently never matches, so both are refused with the offending entry named.
 */
function agentEndpointAllowedHosts(
  environment: NodeJS.ProcessEnv,
): ReadonlySet<string> {
  const named = commaSeparated(environment, "AGENT_ENDPOINT_ALLOWED_HOSTS");
  const hosts = new Set<string>();
  for (const entry of named) {
    const host = entry.trim().toLowerCase();
    if (!host) continue;
    if (host.includes("/") || host.includes("://")) {
      throw new Error(
        `AGENT_ENDPOINT_ALLOWED_HOSTS entry "${entry}" must be a host, optionally with a port, and not a URL.`,
      );
    }
    if (host.includes("*")) {
      throw new Error(
        `AGENT_ENDPOINT_ALLOWED_HOSTS entry "${entry}" must name one host. Patterns are not accepted: list each address instead.`,
      );
    }
    hosts.add(normalizeAllowedHost(entry, host));
  }
  return hosts;
}

/**
 * An IPv6 entry, spelled the way the endpoint check will see it.
 *
 * `namedAsAllowed` compares against `URL.hostname`, which the parser canonicalises: compressed,
 * lower-case, in brackets. An entry kept as written matched only when the operator happened to
 * write it that way, so `[0:0:0:0:0:0:0:1]:8443` was a line that silently never matched, which is
 * the failure the URL and wildcard refusals above exist to prevent. Stripping the brackets instead
 * folded two different names into one: `[::1]:8443`, an address and a port, and `[::1:8443]`, an
 * address, both became `::1:8443`, so naming either admitted the other.
 *
 * The address goes through the URL parser rather than a hand-written normaliser, so the spelling
 * here is the parser's own and cannot drift from it. The port is kept as written, since the parser
 * drops a scheme's default port and an operator who wrote `:80` meant that port. A bracketed entry
 * the parser refuses is not an address, and is refused the way a URL is: at boot, naming the entry.
 */
function normalizeAllowedHost(entry: string, host: string): string {
  if (!host.startsWith("[")) return host;
  const close = host.indexOf("]");
  const address = close === -1 ? host : host.slice(0, close + 1);
  const port = close === -1 ? "" : host.slice(close + 1);
  const refusal = () =>
    new Error(
      `AGENT_ENDPOINT_ALLOWED_HOSTS entry "${entry}" must be a host, optionally with a port, and not a URL.`,
    );
  if (port && !/^:\d{1,5}$/.test(port)) throw refusal();
  let hostname: string;
  try {
    hostname = new URL(`http://${address}`).hostname;
  } catch {
    throw refusal();
  }
  return `${hostname}${port}`;
}

function privateHostsAllowed(environment: Environment): boolean {
  if (optional(environment, "AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS") !== "true") {
    return false;
  }

  // Through `isProduction`, so the comparison trims. Read raw, `NODE_ENV="production "` out of an
  // env file would slip past a gate that the switch beside it, which does trim, would still trip.
  if (isProduction(environment)) {
    throw new Error(
      "AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS=true is for local development only: it lets a Bot reach this deployment's own network. Remove it from this deployment's environment.",
    );
  }
  log.warn(
    "AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS=true lets a Bot reach this machine's own services. Fine locally, and for local development only. Remove it before deploying.",
  );

  return true;
}

/**
 * A duration a person would write, as milliseconds.
 *
 * `30m` rather than `1800000`, because this one is read and edited by whoever is deciding how long a
 * computer may sit idle, and a wrong number of zeroes there is either a computer that never sleeps
 * or one that vanishes mid-task. Plain digits are still milliseconds, so anything already set keeps
 * its meaning.
 */
export function durationMs(value: string): number {
  const match = /^(\d+)\s*(ms|s|m|h)?$/i.exec(value.trim());
  if (!match) {
    throw new Error(
      `"${value}" is not a duration. Write it as 30s, 30m, 2h, or a plain number of milliseconds.`,
    );
  }
  const amount = Number(match[1]);
  switch (match[2]?.toLowerCase()) {
    case "h":
      return amount * 3_600_000;
    case "m":
      return amount * 60_000;
    case "s":
      return amount * 1_000;
    default:
      return amount;
  }
}

function computerConfig(environment: Environment): ComputerConfig | undefined {
  const supervisorAddress = optional(environment, "COMPUTER_SUPERVISOR_URL");
  const sharedAddress = optional(environment, "AGENT_COMPUTER_URL");
  const sandboxNamespace = optional(environment, "COMPUTER_SANDBOX_NAMESPACE");
  if (!supervisorAddress && !sharedAddress && !sandboxNamespace) {
    return undefined;
  }

  /*
   * The secret the computers require. Without it every call to a computer is refused, and that is the
   * intended failure: `agent-computer` drives a browser holding real logins and must not answer
   * unauthenticated callers that can reach its port.
   */
  const computerToken = optional(environment, "COMPUTER_TOKEN");

  const allowPrivateHosts = privateHostsAllowed(environment);
  const policy = actionPolicy(environment);
  /*
   * Checked before the other two, because a deployment that named a namespace means the cluster to
   * make the computers, and a stray `AGENT_COMPUTER_URL` left in an environment would otherwise
   * quietly put every Bot back on one shared browser.
   */
  if (sandboxNamespace) {
    return {
      provider: "sandbox",
      namespace: sandboxNamespace,
      idleAfterMs: durationMs(
        optional(environment, "COMPUTER_SANDBOX_IDLE_AFTER") ?? "30m",
      ),
      templateFile:
        optional(environment, "COMPUTER_SANDBOX_TEMPLATE_FILE") ??
        "/etc/openbot/sandbox-template.json",
      allowPrivateHosts,
      ...(computerToken ? { token: computerToken } : {}),
      ...(policy ? { policy } : {}),
    };
  }

  const supervisorUrl = url(environment, "COMPUTER_SUPERVISOR_URL");
  if (supervisorUrl) {
    const supervisorToken = optional(environment, "SUPERVISOR_TOKEN");
    return {
      provider: "docker",
      baseUrl: supervisorUrl,
      allowPrivateHosts,
      ...(supervisorToken ? { supervisorToken } : {}),
      ...(computerToken ? { token: computerToken } : {}),
      ...(policy ? { policy } : {}),
    };
  }

  const baseUrl = url(environment, "AGENT_COMPUTER_URL");
  if (!baseUrl) {
    return undefined;
  }

  return {
    provider: "shared",
    baseUrl,
    allowPrivateHosts,
    ...(computerToken ? { token: computerToken } : {}),
    ...(policy ? { policy } : {}),
  };
}

/**
 * The paid-plan provider, as this deployment is allowed to see it.
 *
 * The URL is an origin, deliberately: the client owns the `/api/v1` prefix, so a value that arrived
 * with one is a value that was copied from a place that spells it differently (the provider's SDK
 * documentation, or a curl example), and would produce requests to `/api/v1/api/v1/...` at runtime.
 * That is refused here, at boot, with the sentence that names the fix — the same reasoning as every
 * other partial configuration in this file: the mistake belongs where somebody is looking.
 */
export type BillingCreditRate = {
  numerator: bigint;
  denominator: bigint;
};

export type BillingCreditPolicyIssue = {
  key: string;
  reason:
    | "missing"
    | "invalid_json"
    | "invalid_shape"
    | "negative"
    | "zero_denominator"
    | "out_of_range";
};

export type BillingModelCreditClassConfig = {
  rate: BillingCreditRate;
  maximumTokens: bigint;
  maximumCostUnits: bigint;
};

export type BillingModelCreditPolicyEntry = {
  input: BillingModelCreditClassConfig;
  output: BillingModelCreditClassConfig;
  maximumReservationUnits: bigint;
};

export type BillingCodeRunCreditPolicyConfig = {
  rate: BillingCreditRate;
  maximumTokens: bigint;
  maximumReservationUnits: bigint;
};

export type BillingCreditPolicyConfig =
  | {
      configured: false;
      mode: "hard_cap";
      issues: readonly BillingCreditPolicyIssue[];
    }
  | {
      configured: true;
      mode: "hard_cap";
      models: ReadonlyMap<string, BillingModelCreditPolicyEntry>;
      codeRun: BillingCodeRunCreditPolicyConfig;
    };

export const MAX_STORED_CREDIT_UNITS = 2_147_483_647n;

/** The largest whole-credit allowance the ledger's 32-bit `total` column can hold at ×100 scale. */
const MAX_CATALOG_CREDITS = Number(
  MAX_STORED_CREDIT_UNITS / BigInt(CREDIT_SCALE_FOR_CONFIG),
);
/** The largest integer cent amount a 32-bit `amount_cents` column can hold. */
const MAX_STORED_CENTS = Number(MAX_STORED_CREDIT_UNITS);

export type LagoBillingConfig = {
  /** The provider origin, for example `https://api.getlago.com`. No path, no query, no fragment. */
  apiUrl: string;
  /** The bearer credential. Never logged, never answered over HTTP, never stored. */
  apiKey: string;
  /** Which webhook signature mode the routes verify with; `off` mounts no webhook door. */
  webhookMode: "jwt" | "hmac" | "off";
  /** The key behind `webhookMode`, absent exactly when the mode is `off`. */
  webhookKey:
    | { mode: "jwt"; publicKeyPem: string }
    | { mode: "hmac"; key: string }
    | undefined;
  /**
   * The private-host opt-in for the provider URL. Loopback, RFC1918 and fc00::/7 only — link-local
   * and the cloud metadata addresses are never in it (../billing/outbound.ts owns that floor). For
   * a deployment developing against a Lago stack on its own machine.
   */
  allowPrivateHosts: boolean;
  /** Plan code → the entitlement entries that plan grants. */
  planEntitlements: ReadonlyMap<string, readonly BillingEntitlementEntry[]>;
  /** Plan code → the metered ceilings that plan includes. Empty means "metered, not capped". */
  planQuotas: ReadonlyMap<string, readonly BillingQuotaEntry[]>;
  /** Plan code → the catalog entry the upgrade dialog shows (name, credits, cycles, pricing). */
  planCatalog: ReadonlyMap<string, PlanCatalogEntry>;
  /**
   * The hard-cap credit policy block for metered work.
   *
   * Never defaulted. A deployment that has not supplied approved rates and token ceilings keeps the
   * billing provider configured while metered work remains later-refusable on `configured: false`.
   */
  creditPolicy: BillingCreditPolicyConfig;
  /** One request's ceiling, when the default 10s is not what this deployment wants. */
  requestTimeoutMs?: number;
};

/**
 * Read the billing configuration, or refuse to start.
 *
 * All-or-nothing on the addressing pair, XOR on the webhook keys, strict JSON on the plan map — the
 * partial shapes are exactly the ones that run "fine" until the first person whose entitlement was
 * silently wrong. A deployment that has configured none of it gets `undefined` and no billing
 * surface at all, which is the correct state of a free deployment.
 */
function billingConfig(
  environment: Environment,
): LagoBillingConfig | undefined {
  const apiUrl = optional(environment, "LAGO_API_URL");
  const apiKey = optional(environment, "LAGO_API_KEY");
  if (!apiUrl && !apiKey) {
    return undefined;
  }
  if (!apiUrl || !apiKey) {
    throw new Error(
      "Billing is half configured: LAGO_API_URL and LAGO_API_KEY must be set together, or neither",
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(apiUrl);
  } catch {
    throw new Error("LAGO_API_URL must be a valid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("LAGO_API_URL must be an http or https URL");
  }
  if (parsed.username || parsed.password) {
    throw new Error(
      "LAGO_API_URL must not carry credentials in the URL: set LAGO_API_KEY instead",
    );
  }
  const trailingPath = parsed.pathname.replace(/\/+$/, "");
  if (trailingPath !== "" || parsed.search || parsed.hash) {
    throw new Error(
      parsed.pathname.replace(/\/+$/, "") === "/api/v1"
        ? "LAGO_API_URL is the provider origin (for example https://api.getlago.com); the client adds the /api/v1 prefix itself"
        : "LAGO_API_URL must be the provider origin only, without a path, query or fragment",
    );
  }

  const publicKeyPem = optional(environment, "LAGO_WEBHOOK_PUBLIC_KEY");
  const hmacKey = optional(environment, "LAGO_WEBHOOK_SECRET");
  if (publicKeyPem && hmacKey) {
    throw new Error(
      "LAGO_WEBHOOK_PUBLIC_KEY and LAGO_WEBHOOK_SECRET are both set: the provider signs with one algorithm, so name it by setting exactly one of them",
    );
  }
  const webhookKey =
    publicKeyPem !== undefined
      ? { mode: "jwt" as const, publicKeyPem }
      : hmacKey !== undefined
        ? { mode: "hmac" as const, key: hmacKey }
        : undefined;

  const planEntitlements = billingPlanEntitlements(environment);
  const planQuotas = billingPlanQuotas(environment);
  const planCatalog = billingPlanCatalog(environment);
  const creditPolicy = billingCreditPolicyConfig(environment);
  const allowPrivateHosts = billingPrivateHostsAllowed(environment);

  const timeoutRaw = optional(environment, "LAGO_REQUEST_TIMEOUT_MS");
  let requestTimeoutMs: number | undefined;
  if (timeoutRaw !== undefined) {
    const value = Number(timeoutRaw);
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(
        "LAGO_REQUEST_TIMEOUT_MS must be a whole number of milliseconds greater than zero",
      );
    }
    requestTimeoutMs = value;
  }

  return {
    apiUrl,
    apiKey,
    webhookMode: webhookKey?.mode ?? "off",
    webhookKey,
    allowPrivateHosts,
    planEntitlements,
    planQuotas,
    planCatalog,
    creditPolicy,
    ...(requestTimeoutMs !== undefined ? { requestTimeoutMs } : {}),
  };
}

function billingCreditPolicyConfig(
  environment: Environment,
): BillingCreditPolicyConfig {
  const issues: BillingCreditPolicyIssue[] = [];
  const modelRates = jsonObjectEnvironment(
    environment,
    "BILLING_MODEL_CREDIT_RATES",
    issues,
  );
  const modelMaximums = jsonObjectEnvironment(
    environment,
    "BILLING_MODEL_MAX_RESERVATION_TOKENS",
    issues,
  );
  const codeRunRate = jsonValueEnvironment(
    environment,
    "BILLING_CODE_RUN_CREDIT_RATE",
    issues,
  );
  const codeRunMaximumTokens = exactWholeNumber(
    optional(environment, "BILLING_CODE_RUN_MAX_RESERVATION_TOKENS"),
    "BILLING_CODE_RUN_MAX_RESERVATION_TOKENS",
    issues,
  );

  const models = new Map<string, BillingModelCreditPolicyEntry>();
  if (modelRates !== undefined || modelMaximums !== undefined) {
    const modelIds = new Set<string>([
      ...Object.keys(modelRates ?? {}),
      ...Object.keys(modelMaximums ?? {}),
    ]);
    for (const modelId of modelIds) {
      const rateRecord = modelRates?.[modelId];
      const maximumRecord = modelMaximums?.[modelId];
      if (rateRecord === undefined) {
        issues.push({
          key: `BILLING_MODEL_CREDIT_RATES.${modelId}`,
          reason: "missing",
        });
        continue;
      }
      if (maximumRecord === undefined) {
        issues.push({
          key: `BILLING_MODEL_MAX_RESERVATION_TOKENS.${modelId}`,
          reason: "missing",
        });
        continue;
      }
      const parsedRateRecord = objectRecord(
        rateRecord,
        `BILLING_MODEL_CREDIT_RATES.${modelId}`,
        issues,
      );
      const parsedMaximumRecord = objectRecord(
        maximumRecord,
        `BILLING_MODEL_MAX_RESERVATION_TOKENS.${modelId}`,
        issues,
      );
      if (parsedRateRecord === undefined || parsedMaximumRecord === undefined) {
        continue;
      }
      const inputRate = exactRate(
        parsedRateRecord.input,
        `BILLING_MODEL_CREDIT_RATES.${modelId}.input`,
        issues,
      );
      const outputRate = exactRate(
        parsedRateRecord.output,
        `BILLING_MODEL_CREDIT_RATES.${modelId}.output`,
        issues,
      );
      const inputMaximumTokens = exactWholeNumber(
        parsedMaximumRecord.input,
        `BILLING_MODEL_MAX_RESERVATION_TOKENS.${modelId}.input`,
        issues,
      );
      const outputMaximumTokens = exactWholeNumber(
        parsedMaximumRecord.output,
        `BILLING_MODEL_MAX_RESERVATION_TOKENS.${modelId}.output`,
        issues,
      );
      if (
        inputRate === undefined ||
        outputRate === undefined ||
        inputMaximumTokens === undefined ||
        outputMaximumTokens === undefined
      ) {
        continue;
      }
      const inputMaximumCostUnits = ceilingProduct(
        inputMaximumTokens,
        inputRate,
      );
      const outputMaximumCostUnits = ceilingProduct(
        outputMaximumTokens,
        outputRate,
      );
      const maximumReservationUnits =
        inputMaximumCostUnits + outputMaximumCostUnits;
      if (
        maximumReservationUnits === 0n ||
        maximumReservationUnits > MAX_STORED_CREDIT_UNITS
      ) {
        issues.push({
          key: `BILLING_MODEL_MAX_RESERVATION_TOKENS.${modelId}`,
          reason: "out_of_range",
        });
        continue;
      }
      models.set(modelId, {
        input: {
          rate: inputRate,
          maximumTokens: inputMaximumTokens,
          maximumCostUnits: inputMaximumCostUnits,
        },
        output: {
          rate: outputRate,
          maximumTokens: outputMaximumTokens,
          maximumCostUnits: outputMaximumCostUnits,
        },
        maximumReservationUnits,
      });
    }
  }
  if (
    issues.length === 0 &&
    modelRates !== undefined &&
    modelMaximums !== undefined &&
    models.size === 0
  ) {
    issues.push({ key: "BILLING_MODEL_CREDIT_RATES", reason: "missing" });
  }

  const parsedCodeRunRate =
    codeRunRate === undefined
      ? undefined
      : exactRate(codeRunRate, "BILLING_CODE_RUN_CREDIT_RATE", issues);
  const codeRunMaximumReservationUnits =
    parsedCodeRunRate === undefined || codeRunMaximumTokens === undefined
      ? undefined
      : ceilingProduct(codeRunMaximumTokens, parsedCodeRunRate);
  if (
    codeRunMaximumReservationUnits !== undefined &&
    codeRunMaximumReservationUnits > MAX_STORED_CREDIT_UNITS
  ) {
    issues.push({
      key: "BILLING_CODE_RUN_MAX_RESERVATION_TOKENS",
      reason: "out_of_range",
    });
  }
  if (
    issues.length > 0 ||
    parsedCodeRunRate === undefined ||
    codeRunMaximumTokens === undefined ||
    codeRunMaximumReservationUnits === undefined
  ) {
    return {
      configured: false,
      mode: "hard_cap",
      issues,
    };
  }

  return {
    configured: true,
    mode: "hard_cap",
    models,
    codeRun: {
      rate: parsedCodeRunRate,
      maximumTokens: codeRunMaximumTokens,
      maximumReservationUnits: codeRunMaximumReservationUnits,
    },
  };
}

function jsonValueEnvironment(
  environment: Environment,
  key: string,
  issues: BillingCreditPolicyIssue[],
): unknown {
  const raw = optional(environment, key);
  if (raw === undefined) {
    issues.push({ key, reason: "missing" });
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch {
    issues.push({ key, reason: "invalid_json" });
    return undefined;
  }
}

function jsonObjectEnvironment(
  environment: Environment,
  key: string,
  issues: BillingCreditPolicyIssue[],
): Record<string, unknown> | undefined {
  const parsed = jsonValueEnvironment(environment, key, issues);
  if (parsed === undefined) return undefined;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    issues.push({ key, reason: "invalid_shape" });
    return undefined;
  }
  return parsed as Record<string, unknown>;
}

function objectRecord(
  value: unknown,
  key: string,
  issues: BillingCreditPolicyIssue[],
): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    issues.push({ key, reason: "invalid_shape" });
    return undefined;
  }
  return value as Record<string, unknown>;
}

function exactRate(
  value: unknown,
  key: string,
  issues: BillingCreditPolicyIssue[],
): BillingCreditRate | undefined {
  if (value === undefined) {
    issues.push({ key, reason: "missing" });
    return undefined;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    issues.push({ key, reason: "invalid_shape" });
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const numerator = exactWholeNumber(
    record.numerator,
    `${key}.numerator`,
    issues,
  );
  const denominator = exactWholeNumber(
    record.denominator,
    `${key}.denominator`,
    issues,
  );
  if (denominator === 0n) {
    issues.push({ key: `${key}.denominator`, reason: "zero_denominator" });
    return undefined;
  }
  if (numerator === undefined || denominator === undefined) {
    return undefined;
  }
  return { numerator, denominator };
}

function exactWholeNumber(
  value: unknown,
  key: string,
  issues: BillingCreditPolicyIssue[],
): bigint | undefined {
  if (value === undefined) {
    issues.push({ key, reason: "missing" });
    return undefined;
  }
  if (typeof value === "number") {
    if (!Number.isInteger(value) || !Number.isSafeInteger(value)) {
      issues.push({ key, reason: "out_of_range" });
      return undefined;
    }
    if (value < 0) {
      issues.push({ key, reason: "negative" });
      return undefined;
    }
    return BigInt(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!/^-?\d+$/.test(trimmed)) {
      issues.push({ key, reason: "out_of_range" });
      return undefined;
    }
    const parsed = BigInt(trimmed);
    if (parsed < 0n) {
      issues.push({ key, reason: "negative" });
      return undefined;
    }
    return parsed;
  }
  issues.push({ key, reason: "out_of_range" });
  return undefined;
}

function ceilingProduct(value: bigint, rate: BillingCreditRate): bigint {
  if (value === 0n || rate.numerator === 0n) return 0n;
  return (value * rate.numerator + rate.denominator - 1n) / rate.denominator;
}

/**
 * The plan map, as JSON in one variable. Each plan's list accepts either the legacy bare code
 * strings (`{"pro": ["intelligence", "teams"]}`) or entries with presentational copy
 * (`{"pro": [{"code": "intelligence", "label": "..."}]}`); both resolve to entry objects, so a
 * deployment can move to the richer form one plan at a time.
 *
 * Malformed JSON, or JSON of the wrong shape, refuses to start rather than falling back to an empty
 * map — an operator who wrote entitlements and mistyped them would otherwise run a deployment that
 * quietly grants nothing, and the first person to notice would be somebody who was owed something.
 * Same boundary as `actionPolicy` above it.
 */
function billingPlanEntitlements(
  environment: Environment,
): ReadonlyMap<string, readonly BillingEntitlementEntry[]> {
  const raw = optional(environment, "LAGO_PLAN_ENTITLEMENTS") ?? "{}";
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("LAGO_PLAN_ENTITLEMENTS must be valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      "LAGO_PLAN_ENTITLEMENTS must be a JSON object of plan code to a list of entitlement codes",
    );
  }
  const plans = new Map<string, readonly BillingEntitlementEntry[]>();
  for (const [planCode, codes] of Object.entries(
    parsed as Record<string, unknown>,
  )) {
    if (!Array.isArray(codes)) {
      throw new Error(
        `LAGO_PLAN_ENTITLEMENTS plan "${planCode}" must be a list of non-empty entitlement codes`,
      );
    }
    const entries: BillingEntitlementEntry[] = [];
    for (const entry of codes) {
      if (typeof entry === "string") {
        if (entry.length === 0) {
          throw new Error(
            `LAGO_PLAN_ENTITLEMENTS plan "${planCode}" must be a list of non-empty entitlement codes`,
          );
        }
        entries.push({ code: entry });
        continue;
      }
      if (entry === null || typeof entry !== "object") {
        throw new Error(
          `LAGO_PLAN_ENTITLEMENTS plan "${planCode}" entries must be codes or objects with a "code"`,
        );
      }
      const record = entry as Record<string, unknown>;
      if (typeof record.code !== "string" || record.code.length === 0) {
        throw new Error(
          `LAGO_PLAN_ENTITLEMENTS plan "${planCode}" entries must carry a non-empty "code"`,
        );
      }
      if (record.label !== undefined && typeof record.label !== "string") {
        throw new Error(
          `LAGO_PLAN_ENTITLEMENTS plan "${planCode}" entry label must be a string`,
        );
      }
      if (
        record.description !== undefined &&
        typeof record.description !== "string"
      ) {
        throw new Error(
          `LAGO_PLAN_ENTITLEMENTS plan "${planCode}" entry description must be a string`,
        );
      }
      entries.push({
        code: record.code,
        ...(record.label !== undefined ? { label: record.label } : {}),
        ...(record.description !== undefined
          ? { description: record.description }
          : {}),
      });
    }
    plans.set(planCode, entries);
  }
  return plans;
}

/**
 * Read `LAGO_PLAN_QUOTAS`: plan code → the metered ceilings that plan includes.
 *
 * ```json
 * { "pro": [{ "metricCode": "llm_tokens", "metricName": "模型 tokens", "unit": "tokens", "limit": 2000000 }] }
 * ```
 *
 * The same strictness as the entitlement map next door, for the same reason: a ceiling that is
 * silently wrong is a usage bar that lies. `limit` is a whole non-negative number because a
 * fraction of a token is not a thing, and `unit` defaults to the metric code rather than to a
 * guess at what the deployment measures.
 *
 * Empty and absent are the same answer, and it is a legitimate one: a deployment that caps nothing
 * still measures everything, and the usage page draws "metered, not capped" rather than nothing.
 */
function billingPlanQuotas(
  environment: Environment,
): ReadonlyMap<string, readonly BillingQuotaEntry[]> {
  const raw = optional(environment, "LAGO_PLAN_QUOTAS") ?? "{}";
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("LAGO_PLAN_QUOTAS must be valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      "LAGO_PLAN_QUOTAS must be a JSON object of plan code to a list of quotas",
    );
  }
  const plans = new Map<string, readonly BillingQuotaEntry[]>();
  for (const [planCode, quotas] of Object.entries(
    parsed as Record<string, unknown>,
  )) {
    if (!Array.isArray(quotas)) {
      throw new Error(
        `LAGO_PLAN_QUOTAS plan "${planCode}" must be a list of quota objects`,
      );
    }
    const entries: BillingQuotaEntry[] = [];
    for (const entry of quotas) {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error(
          `LAGO_PLAN_QUOTAS plan "${planCode}" quotas must be objects with a "metricCode" and a "limit"`,
        );
      }
      const record = entry as Record<string, unknown>;
      if (typeof record.metricCode !== "string" || !record.metricCode) {
        throw new Error(
          `LAGO_PLAN_QUOTAS plan "${planCode}" quotas must carry a non-empty "metricCode"`,
        );
      }
      if (typeof record.limit !== "number" || !Number.isInteger(record.limit)) {
        throw new Error(
          `LAGO_PLAN_QUOTAS plan "${planCode}" quota "${record.metricCode}" limit must be a whole number`,
        );
      }
      if (record.limit < 0) {
        throw new Error(
          `LAGO_PLAN_QUOTAS plan "${planCode}" quota "${record.metricCode}" limit must not be negative`,
        );
      }
      if (record.metricName !== undefined && typeof record.metricName !== "string") {
        throw new Error(
          `LAGO_PLAN_QUOTAS plan "${planCode}" quota "${record.metricCode}" metricName must be a string`,
        );
      }
      if (record.unit !== undefined && typeof record.unit !== "string") {
        throw new Error(
          `LAGO_PLAN_QUOTAS plan "${planCode}" quota "${record.metricCode}" unit must be a string`,
        );
      }
      if (record.usedCents !== undefined && typeof record.usedCents !== "number") {
        throw new Error(
          `LAGO_PLAN_QUOTAS plan "${planCode}" quota "${record.metricCode}" usedCents must be a number`,
        );
      }
      const metricCode: string = record.metricCode;
      const unit: string = record.unit ?? metricCode;
      entries.push({
        metricCode,
        metricName: record.metricName ?? metricCode,
        unit,
        used: 0,
        limit: record.limit as number,
        remaining: record.limit as number,
        usedCents: record.usedCents ?? 0,
      });
    }
    plans.set(planCode, entries);
  }
  return plans;
}

/**
 * Read `PLAN_CATALOG`: plan code → the catalog entry the upgrade dialog shows.
 *
 * ```json
 * {
 *   "advanced": {
 *     "name": "高级版",
 *     "credits": 9000,
 *     "features": ["每月基础积分", "每月赠送积分", "全部模型可选"],
 *     "pricing": [
 *       { "code": "recurring_monthly", "label": "连续包月", "priceCents": 14000, "originalCents": 19900, "discountLabel": "7折", "unit": "month" },
 *       { "code": "monthly", "label": "1个月", "priceCents": 19900, "unit": "month" }
 *     ]
 *   }
 * }
 * ```
 *
 * The same strictness as the entitlement and quota maps beside it: a cycle whose price is silently
 * wrong is a checkout that charges the wrong number. `credits` and `priceCents` are whole
 * non-negative integers; a cycle without `originalCents`/`discountLabel` is sold at face value.
 * `unit` defaults from the cycle code. Empty and absent are the same answer — a deployment that
 * names no catalog still bills, it just has no upgrade dialog to draw.
 */
function billingPlanCatalog(
  environment: Environment,
): ReadonlyMap<string, PlanCatalogEntry> {
  const raw = optional(environment, "LAGO_PLAN_CATALOG") ?? "{}";
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("LAGO_PLAN_CATALOG must be valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      "LAGO_PLAN_CATALOG must be a JSON object of plan code to a plan entry",
    );
  }

  const cycleCodes = new Set<PlanCatalogCycle["code"]>([
    "recurring_monthly",
    "monthly",
    "recurring_yearly",
    "yearly",
  ]);
  const plans = new Map<string, PlanCatalogEntry>();
  for (const [planCode, entry] of Object.entries(
    parsed as Record<string, unknown>,
  )) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(
        `PLAN_CATALOG plan "${planCode}" must be an object with a name, credits, features and pricing`,
      );
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.name !== "string" || record.name.length === 0) {
      throw new Error(
        `PLAN_CATALOG plan "${planCode}" must carry a non-empty "name"`,
      );
    }
    if (
      typeof record.credits !== "number" ||
      !Number.isInteger(record.credits) ||
      record.credits < 0
    ) {
      throw new Error(
        `PLAN_CATALOG plan "${planCode}" credits must be a whole non-negative number`,
      );
    }
    // A paid order pays this allowance out through credit_grants.total, a 32-bit column at ×100
    // scale. An allowance that does not fit is refused HERE, at boot, rather than after the
    // money lands: the payout insert would fail inside activation and strand a paid order in a
    // permanent retry (audit A6).
    if (record.credits > MAX_CATALOG_CREDITS) {
      throw new Error(
        `PLAN_CATALOG plan "${planCode}" credits must fit the credit ledger's 32-bit column (at most ${MAX_CATALOG_CREDITS} whole credits at ×100 scale)`,
      );
    }
    if (!Array.isArray(record.features)) {
      throw new Error(
        `PLAN_CATALOG plan "${planCode}" features must be a list of strings`,
      );
    }
    const features: string[] = [];
    for (const feature of record.features) {
      if (typeof feature !== "string" || feature.length === 0) {
        throw new Error(
          `PLAN_CATALOG plan "${planCode}" features must be non-empty strings`,
        );
      }
      features.push(feature);
    }
    if (!Array.isArray(record.pricing) || record.pricing.length === 0) {
      throw new Error(
        `PLAN_CATALOG plan "${planCode}" pricing must be a non-empty list of cycles`,
      );
    }
    const pricing: PlanCatalogCycle[] = [];
    for (const cycle of record.pricing) {
      if (cycle === null || typeof cycle !== "object" || Array.isArray(cycle)) {
        throw new Error(
          `PLAN_CATALOG plan "${planCode}" cycles must be objects with a "code" and a "priceCents"`,
        );
      }
      const c = cycle as Record<string, unknown>;
      if (typeof c.code !== "string" || !cycleCodes.has(c.code as never)) {
        throw new Error(
          `PLAN_CATALOG plan "${planCode}" cycle code must be one of recurring_monthly, monthly, recurring_yearly, yearly`,
        );
      }
      const code = c.code as PlanCatalogCycle["code"];
      if (
        typeof c.priceCents !== "number" ||
        !Number.isInteger(c.priceCents) ||
        c.priceCents < 0
      ) {
        throw new Error(
          `PLAN_CATALOG plan "${planCode}" cycle "${code}" priceCents must be a whole non-negative number`,
        );
      }
      if (c.priceCents > MAX_STORED_CENTS) {
        throw new Error(
          `PLAN_CATALOG plan "${planCode}" cycle "${code}" priceCents must fit the payment order table's 32-bit column (at most ${MAX_STORED_CENTS})`,
        );
      }
      if (c.label !== undefined && typeof c.label !== "string") {
        throw new Error(
          `PLAN_CATALOG plan "${planCode}" cycle "${code}" label must be a string`,
        );
      }
      if (
        c.originalCents !== undefined &&
        c.originalCents !== null &&
        (typeof c.originalCents !== "number" ||
          !Number.isInteger(c.originalCents))
      ) {
        throw new Error(
          `PLAN_CATALOG plan "${planCode}" cycle "${code}" originalCents must be a whole number`,
        );
      }
      if (
        typeof c.originalCents === "number" &&
        c.originalCents > MAX_STORED_CENTS
      ) {
        throw new Error(
          `PLAN_CATALOG plan "${planCode}" cycle "${code}" originalCents must fit the payment order table's 32-bit column (at most ${MAX_STORED_CENTS})`,
        );
      }
      if (
        c.discountLabel !== undefined &&
        c.discountLabel !== null &&
        typeof c.discountLabel !== "string"
      ) {
        throw new Error(
          `PLAN_CATALOG plan "${planCode}" cycle "${code}" discountLabel must be a string`,
        );
      }
      const unit =
        c.unit ??
        (code === "recurring_yearly" || code === "yearly" ? "year" : "month");
      if (unit !== "month" && unit !== "year") {
        throw new Error(
          `PLAN_CATALOG plan "${planCode}" cycle "${code}" unit must be "month" or "year"`,
        );
      }
      pricing.push({
        code,
        label: c.label ?? code,
        priceCents: c.priceCents as number,
        originalCents:
          c.originalCents === undefined || c.originalCents === null
            ? null
            : (c.originalCents as number),
        discountLabel:
          c.discountLabel === undefined || c.discountLabel === null
            ? null
            : (c.discountLabel as string),
        unit: unit as "month" | "year",
      });
    }
    plans.set(planCode, {
      name: record.name,
      credits: record.credits as number,
      features,
      pricing,
    });
  }
  return plans;
}

/**
 * Whether the provider URL may sit inside this deployment's own network.
 *
 * Off unless asked for, and the asking is loud. Unlike the computer's switch this one is not
 * production-refused: a company that runs its own Lago inside its own network is a legitimate
 * deployment, and the outbound floor beneath it (link-local and the metadata addresses, always
 * refused) is the part that must never move. The warning is kept because the common way to end up
 * with it is copying `.env.example`, and a copy deserves to know what it copied.
 */
function billingPrivateHostsAllowed(environment: Environment): boolean {
  const raw = optional(environment, "LAGO_ALLOW_PRIVATE_HOSTS");
  const allowed = raw === "true" || raw === "1";
  if (allowed) {
    log.warn(
      "LAGO_ALLOW_PRIVATE_HOSTS=true lets the billing provider sit on this deployment's own network. Fine against a local Lago stack; check that this is deliberate before deploying.",
    );
  }
  return allowed;
}

/** One purchasable plan, as the payment catalog names it. */
export type PaymentPlanConfig = {
  amountCents: number;
  currency: "CNY";
  periodMonths: number;
};

/** One collection channel, wholly configured or not present at all. */
export type AlipayProviderConfig = {
  appId: string;
  /** Merchant private key, inline PEM or a file path; read once at boot, never logged. */
  privateKeyPem: string;
  /** Alipay's platform public key, shared by callback and gateway-response verification. */
  alipayPublicKeyPem: string;
  gatewayUrl: string;
};

export type WechatProviderConfig = {
  mchid: string;
  appid: string;
  /** The 32-byte APIv3 key, used only for callback decryption; never logged. */
  apiv3Key: string;
  merchantSerialNo: string;
  merchantPrivateKeyPem: string;
  /** Platform certificates, each inline PEM or a file path; serials derive at boot. */
  platformCertificates: readonly string[];
  gatewayUrl: string;
};

export type PaymentsConfig = {
  /** Whichever channels this deployment configured; at least one, by construction. */
  alipay?: AlipayProviderConfig;
  wechat?: WechatProviderConfig;
  /** What may be bought. Keys are a subset of the billing plan map's keys, checked at boot. */
  planCatalog: ReadonlyMap<string, PaymentPlanConfig>;
  /** Where the channels must call back: a public https origin, no path. */
  notifyBaseUrl: string;
  /** The private-host opt-in for the channel gateways, with the same warning as the Lago one. */
  allowPrivateHosts: boolean;
  /** How long a QR checkout stays payable, in minutes. */
  orderTtlMinutes: number;
  /** How far a callback timestamp may drift, in seconds. */
  callbackSkewSeconds: number;
  /** How long after an order expired a late payment is still honoured, in hours. */
  latePaymentWindowHours: number;
  /**
   * Whether a Lago plan priced in another currency may still be activated. Off is the default:
   * the order is collected in CNY, and a plan billed in anything else is a mismatch worth
   * refusing. On, the activation proceeds with a loud warning — the order table is the
   * authority on what was collected.
   */
  acceptForeignCurrency: boolean;
};

/** A credential that may arrive inline (a PEM's banner) or as a path to a file holding one. */
function pemOrFile(value: string, variable: string): string {
  if (value.includes("-----BEGIN")) {
    return value;
  }
  const { readFileSync } = require("node:fs") as typeof import("node:fs");
  try {
    const contents = readFileSync(value, "utf8");
    if (!contents.includes("-----BEGIN")) {
      throw new Error(`${variable} points at ${value}, which holds no PEM material`);
    }
    return contents;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(variable)) throw error;
    throw new Error(`${variable} names a file that could not be read: ${value}`);
  }
}

/** Comma-separated credentials, each inline PEM or path. */
function pemList(value: string, variable: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => pemOrFile(entry, variable));
}

/**
 * The notify base's destination floor, judged statically: the scheme must be https, and the host
 * must not be loopback, private, link-local or otherwise reserved — the same tables the outbound
 * gate owns (../billing/outbound.ts), minus DNS: this check runs synchronously at boot, and the
 * async gate still runs on every channel request with resolution. Loopback and RFC1918 are
 * forgivable under the opt-in; link-local, CGNAT, TEST-NET and multicast never are, on either
 * layer.
 */
function notifyBaseAllowed(environment: Environment, raw: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return "PAYMENT_NOTIFY_BASE_URL must be a valid URL";
  }
  if (parsed.protocol !== "https:") {
    return "PAYMENT_NOTIFY_BASE_URL must be an https URL: the channels post payment notifications to it";
  }
  if (parsed.pathname.replace(/\/+$/, "") !== "" || parsed.search || parsed.hash) {
    return "PAYMENT_NOTIFY_BASE_URL must be the origin only, without a path, query or fragment";
  }

  const refusal =
    "PAYMENT_NOTIFY_BASE_URL must be a public https address the channels can reach";
  const allowPrivate = paymentPrivateHostsAllowed(environment);
  const host = parsed.hostname.toLowerCase().replace(/\.+$/, "");

  if (host === "localhost" || host.endsWith(".localhost")) {
    return allowPrivate ? undefined : refusal;
  }
  if (host.startsWith("[") && host.endsWith("]")) {
    return ipv6LiteralAllowed(host.slice(1, -1), allowPrivate) ? undefined : refusal;
  }
  if (host.includes(":")) {
    return ipv6LiteralAllowed(host, allowPrivate) ? undefined : refusal;
  }
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    return ipv4LiteralAllowed(Number(ipv4[1]), Number(ipv4[2]), allowPrivate)
      ? undefined
      : refusal;
  }
  return undefined;
}

/** The IPv4 tables from the outbound gate, reduced to boot's yes/no. */
function ipv4LiteralAllowed(a: number, b: number, allowPrivate: boolean): boolean {
  if (a === 127 || (a === 0 && b === 0)) return allowPrivate; // loopback and "this host"
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) {
    return allowPrivate; // RFC1918
  }
  // Link-local (the metadata addresses sit here), "this network", CGNAT, TEST-NET,
  // benchmarking, multicast and reserved: never, opt-in or not.
  if (a === 169 || a === 0 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 192 && (b === 0 || b === 88)) return false;
  if (a === 198 && (b === 18 || b === 19 || b === 51)) return false;
  if (a === 203 && b === 0) return false;
  return true;
}

/**
 * The IPv6 spellings boot can judge by hand: loopback (`::1`), the unspecified address, and the
 * two prefixes that are never a payment destination — unique-local `fc00::/7` (private, opt-in
 * forgivable) and link-local `fe80::/10` (never). A global unicast literal passes; a name is not
 * this function's problem.
 */
function ipv6LiteralAllowed(literal: string, allowPrivate: boolean): boolean {
  const address = literal.toLowerCase();
  if (address === "::1" || address === "::") return allowPrivate;
  if (address.startsWith("fc") || address.startsWith("fd")) return allowPrivate; // fc00::/7
  if (/^fe[89ab]/.test(address)) return false; // fe80::/10 link-local
  if (address.startsWith("ff")) return false; // multicast
  return true;
}

function paymentPrivateHostsAllowed(environment: Environment): boolean {
  const raw = optional(environment, "PAYMENT_ALLOW_PRIVATE_HOSTS");
  return raw === "true" || raw === "1";
}

/** A whole positive number from an optional variable, with the refusal naming the variable. */
function positiveInt(
  environment: Environment,
  name: string,
  fallback: number,
): number {
  const raw = optional(environment, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a whole number greater than zero`);
  }
  return value;
}

function loudSwitch(
  environment: Environment,
  name: string,
  warning: string,
): boolean {
  const raw = optional(environment, name);
  const enabled = raw === "true" || raw === "1";
  if (enabled) log.warn(warning);
  return enabled;
}

/**
 * The direct-collection configuration, or `undefined` when no channel exists.
 *
 * All-or-nothing per channel group, and the catalog is mandatory the moment any channel exists —
 * the same half-configuration refusal the billing block above practises. A deployment that can
 * collect money but has no price to collect for is a mis-wiring, not a soft degradation, and it
 * stops the boot here where somebody is looking. The catalog's keys must be plans the billing
 * provider actually knows (a subset of LAGO_PLAN_ENTITLEMENTS), prices are integer cents in CNY,
 * and the period is monthly — the Lago wire interval the activation below creates.
 *
 * The notify base is the one public address the channels are told to call back; it must be https
 * and public (loopback and private space are refused unless PAYMENT_ALLOW_PRIVATE_HOSTS is on,
 * which also warns, exactly like the Lago opt-in). A deployment that configured channels but no
 * billing projection refuses: collection without a subscription to activate is half a product.
 */
function paymentsConfig(
  environment: Environment,
  billing: LagoBillingConfig | undefined,
): PaymentsConfig | undefined {
  const alipayAppId = optional(environment, "ALIPAY_APP_ID");
  const alipayPrivateKey = optional(environment, "ALIPAY_PRIVATE_KEY");
  const alipayPublicKey = optional(environment, "ALIPAY_PUBLIC_KEY");
  const alipayConfigured =
    alipayAppId !== undefined ||
    alipayPrivateKey !== undefined ||
    alipayPublicKey !== undefined;
  let alipay: AlipayProviderConfig | undefined;
  if (alipayConfigured) {
    if (!alipayAppId || !alipayPrivateKey || !alipayPublicKey) {
      throw new Error(
        "Alipay is half configured: ALIPAY_APP_ID, ALIPAY_PRIVATE_KEY and ALIPAY_PUBLIC_KEY must all be set, or none",
      );
    }
    alipay = {
      appId: alipayAppId,
      privateKeyPem: pemOrFile(alipayPrivateKey, "ALIPAY_PRIVATE_KEY"),
      alipayPublicKeyPem: pemOrFile(alipayPublicKey, "ALIPAY_PUBLIC_KEY"),
      gatewayUrl:
        optional(environment, "ALIPAY_GATEWAY_URL") ??
        "https://openapi.alipay.com/gateway.do",
    };
  }

  const wechatMchid = optional(environment, "WXPAY_MCHID");
  const wechatAppid = optional(environment, "WXPAY_APPID");
  const wechatApiv3Key = optional(environment, "WXPAY_API_V3_KEY");
  const wechatSerial = optional(environment, "WXPAY_SERIAL_NO");
  const wechatPrivateKey = optional(environment, "WXPAY_PRIVATE_KEY");
  const wechatPlatformCerts = optional(environment, "WXPAY_PLATFORM_CERTS");
  const wechatConfigured =
    wechatMchid !== undefined ||
    wechatAppid !== undefined ||
    wechatApiv3Key !== undefined ||
    wechatSerial !== undefined ||
    wechatPrivateKey !== undefined ||
    wechatPlatformCerts !== undefined;
  let wechat: WechatProviderConfig | undefined;
  if (wechatConfigured) {
    if (
      !wechatMchid ||
      !wechatAppid ||
      !wechatApiv3Key ||
      !wechatSerial ||
      !wechatPrivateKey ||
      !wechatPlatformCerts
    ) {
      throw new Error(
        "WeChat Pay is half configured: WXPAY_MCHID, WXPAY_APPID, WXPAY_API_V3_KEY, WXPAY_SERIAL_NO, WXPAY_PRIVATE_KEY and WXPAY_PLATFORM_CERTS must all be set, or none",
      );
    }
    if (wechatApiv3Key.length !== 32) {
      throw new Error("WXPAY_API_V3_KEY must be exactly 32 characters");
    }
    const platformCertificates = pemList(wechatPlatformCerts, "WXPAY_PLATFORM_CERTS");
    if (platformCertificates.length === 0) {
      throw new Error(
        "WXPAY_PLATFORM_CERTS must name at least one platform certificate (PEM or path)",
      );
    }
    wechat = {
      mchid: wechatMchid,
      appid: wechatAppid,
      apiv3Key: wechatApiv3Key,
      merchantSerialNo: wechatSerial,
      merchantPrivateKeyPem: pemOrFile(wechatPrivateKey, "WXPAY_PRIVATE_KEY"),
      platformCertificates,
      gatewayUrl:
        optional(environment, "WXPAY_GATEWAY_URL") ?? "https://api.mch.weixin.qq.com",
    };
  }

  if (!alipay && !wechat) {
    return undefined;
  }

  // A channel that collects into a deployment with no billing projection has nothing to activate.
  if (!billing) {
    throw new Error(
      "Payment channels are configured but billing is not: LAGO_API_URL and LAGO_API_KEY are required whenever ALIPAY_* or WXPAY_* is set, because collected payments activate Lago subscriptions",
    );
  }

  const catalogRaw = optional(environment, "PAYMENT_PLAN_CATALOG");
  if (catalogRaw === undefined || catalogRaw.trim() === "") {
    throw new Error(
      "PAYMENT_PLAN_CATALOG is required when a payment channel is configured: the deployment can collect money but has no price to collect for",
    );
  }
  let catalogParsed: unknown;
  try {
    catalogParsed = JSON.parse(catalogRaw);
  } catch {
    throw new Error("PAYMENT_PLAN_CATALOG must be valid JSON");
  }
  if (
    !catalogParsed ||
    typeof catalogParsed !== "object" ||
    Array.isArray(catalogParsed)
  ) {
    throw new Error(
      "PAYMENT_PLAN_CATALOG must be a JSON object of plan code to { amountCents, currency, periodMonths }",
    );
  }
  const planCatalog = new Map<string, PaymentPlanConfig>();
  for (const [planCode, entry] of Object.entries(
    catalogParsed as Record<string, unknown>,
  )) {
    if (!billing.planEntitlements.has(planCode)) {
      throw new Error(
        `PAYMENT_PLAN_CATALOG plan "${planCode}" is not a plan in LAGO_PLAN_ENTITLEMENTS: a plan the deployment cannot entitle must not be purchasable`,
      );
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(
        `PAYMENT_PLAN_CATALOG plan "${planCode}" must be an object with amountCents, currency and periodMonths`,
      );
    }
    const { amountCents, currency, periodMonths } = entry as Record<string, unknown>;
    if (typeof amountCents !== "number" || !Number.isInteger(amountCents) || amountCents <= 0) {
      throw new Error(
        `PAYMENT_PLAN_CATALOG plan "${planCode}" amountCents must be a positive integer number of cents`,
      );
    }
    if (currency !== "CNY") {
      throw new Error(
        `PAYMENT_PLAN_CATALOG plan "${planCode}" currency must be "CNY": only CNY is collected in v1`,
      );
    }
    if (periodMonths !== 1) {
      throw new Error(
        `PAYMENT_PLAN_CATALOG plan "${planCode}" periodMonths must be 1 (monthly): that is the Lago interval the activation creates`,
      );
    }
    // THE PRICE CROSS-CHECK (P1-2's root cause, closed at boot): the collected price and the
    // displayed price are two configs, and nothing else compares them — a deployment that
    // raises LAGO_PLAN_CATALOG's monthly price but forgets PAYMENT_PLAN_CATALOG shows one
    // number and collects another, which is the exact failure a person reads as being
    // overcharged. Refuse to start; the monthly cycle is the only cycle v1 collects.
    const displayed =
      billing.planCatalog.get(planCode)?.pricing.find(
        (cycle) =>
          cycle.code === "monthly" || cycle.code === "recurring_monthly",
      );
    if (displayed && displayed.priceCents !== amountCents) {
      throw new Error(
        `PAYMENT_PLAN_CATALOG plan "${planCode}" amountCents (${amountCents}) does not match LAGO_PLAN_CATALOG's monthly price (${displayed.priceCents}): the checkout would collect a different number than the dialog shows — align the two catalogs before starting`,
      );
    }
    if (!displayed) {
      // Not a mismatch (the payment catalog is the collector's truth), but the upgrade dialog
      // cannot offer it — say so at boot rather than discovering a plan nobody can click.
      log.warn(
        `PAYMENT_PLAN_CATALOG plan "${planCode}" has no monthly cycle in LAGO_PLAN_CATALOG: it is purchasable through the API but the upgrade dialog will not show it`,
      );
    }
    planCatalog.set(planCode, {
      amountCents,
      currency: "CNY",
      periodMonths: 1,
    });
  }

  const notifyRaw =
    optional(environment, "PAYMENT_NOTIFY_BASE_URL") ??
    optional(environment, "OPENBOT_PUBLIC_URL") ??
    authBaseUrl(environment);
  if (notifyRaw === undefined) {
    throw new Error(
      "PAYMENT_NOTIFY_BASE_URL is required when a payment channel is configured (or set OPENBOT_PUBLIC_URL / BETTER_AUTH_URL): the channels need a public https address to call back",
    );
  }
  const notifyProblem = notifyBaseAllowed(environment, notifyRaw);
  if (notifyProblem) {
    throw new Error(notifyProblem);
  }

  const allowPrivateHosts = paymentPrivateHostsAllowed(environment);
  if (allowPrivateHosts) {
    log.warn(
      "PAYMENT_ALLOW_PRIVATE_HOSTS=true lets a payment gateway sit on this deployment's own network. Fine against a sandboxed channel stack; check that this is deliberate before deploying.",
    );
  }

  return {
    ...(alipay ? { alipay } : {}),
    ...(wechat ? { wechat } : {}),
    planCatalog,
    notifyBaseUrl: notifyRaw.replace(/\/+$/, ""),
    allowPrivateHosts,
    orderTtlMinutes: positiveInt(environment, "PAYMENT_ORDER_TTL_MINUTES", 15),
    callbackSkewSeconds: positiveInt(
      environment,
      "PAYMENT_CALLBACK_SKEW_SECONDS",
      300,
    ),
    latePaymentWindowHours: positiveInt(
      environment,
      "PAYMENT_LATE_PAYMENT_WINDOW_HOURS",
      24,
    ),
    acceptForeignCurrency: loudSwitch(
      environment,
      "PAYMENT_ACCEPT_FOREIGN_CURRENCY",
      "PAYMENT_ACCEPT_FOREIGN_CURRENCY=true lets a payment activate a Lago plan priced in a currency other than CNY. The order table remains the authority on what was collected; check that this mismatch is deliberate.",
    ),
  };
}

/** The auth base URL, read the way loadConfig derives `publicUrl`, without building auth. */
function authBaseUrl(environment: Environment): string | undefined {
  return optional(environment, "BETTER_AUTH_URL");
}

/**
 * The action policy, as JSON in one variable.
 *
 * Refuses to start on malformed JSON or a policy of the wrong shape, rather than falling back to the
 * default. An operator who wrote a rule and mistyped it would otherwise get a running deployment that
 * silently permits what they had just tried to forbid, and no indication that anything was wrong.
 * Configuration the product cannot honour belongs at the boot boundary; see the note at the top.
 */
function actionPolicy(environment: Environment): ActionPolicy | undefined {
  const raw = optional(environment, "AGENT_COMPUTER_POLICY");
  if (!raw) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("AGENT_COMPUTER_POLICY must be valid JSON");
  }

  const result = parseActionPolicy(parsed);
  if (!result.ok) {
    throw new Error(`AGENT_COMPUTER_POLICY is invalid: ${result.error}`);
  }
  return result.policy;
}

/**
 * How long silence on a Bot's stream is allowed to last.
 *
 * Refuses to start on anything that is not a whole number of milliseconds, rather than falling back
 * to the default. Same reasoning as the action policy above it: an operator who meant to write a
 * two-minute timeout and typed something else would otherwise get a running deployment with a
 * silently different boundary, and no indication that anything was wrong.
 *
 * Zero is a legitimate value and means off. It is not the same as a malformed one.
 */
function accessibilityEnabled(environment: Environment): boolean {
  const off = optional(environment, "OPENBOT_ACCESSIBILITY_DISABLED");
  return off !== "true" && off !== "1";
}

/**
 * Whether a Bot may draw an interface it wrote itself.
 *
 * Default-on, matching the product capability the browser can already render. Operators who cannot
 * allow generated interfaces can explicitly opt out. `false` is the documented spelling and `0` is
 * accepted alongside it as the conventional off value used by environment-driven switches.
 *
 * Anything else leaves the capability on. A typo should not silently become an opt-out, and the
 * capability must stay consistent between runtime and browser projection.
 *
 * The answer has to reach the browser as well as the runtime, which is why it ends up on
 * /api/capabilities rather than staying server-side. Enabling only the runtime half would leave the
 * browser never offering the tool; enabling only the browser half would have a Bot generate a whole
 * interface that nothing renders. See DeploymentConfig.generativeUi.
 */
function generativeUiEnabled(environment: Environment): boolean {
  const value = optional(environment, "OPENBOT_GENERATIVE_UI");
  return value !== "false" && value !== "0";
}

/** Same rule as generated interfaces: on unless explicitly "false" or "0". */
function selfHostBannerEnabled(environment: Environment): boolean {
  const value = optional(environment, "OPENBOT_SELF_HOST_BANNER");
  return value !== "false" && value !== "0";
}

/**
 * How long the audit trail is kept.
 *
 * Refused rather than coerced, like everything else here. "We accepted your retention policy but not
 * the one you wrote" is a bad answer about a control an auditor will ask to see, and a typo that
 * silently became 0 would delete the trail rather than keep it.
 */
function auditRetentionDays(environment: Environment): number | undefined {
  const raw = optional(environment, "AUDIT_RETENTION_DAYS");
  if (!raw) return undefined;

  const days = Number(raw);
  if (!Number.isInteger(days) || days < 1) {
    throw new Error(
      "AUDIT_RETENTION_DAYS must be a whole number of days, at least 1. Leave it unset to keep the audit trail forever.",
    );
  }
  return days;
}

function agentStallTimeoutMs(environment: Environment): number {
  const raw = optional(environment, "AGENT_STALL_TIMEOUT_MS");
  if (!raw) {
    return 0;
  }

  const milliseconds = Number(raw);
  if (!Number.isInteger(milliseconds) || milliseconds < 0) {
    throw new Error(
      "AGENT_STALL_TIMEOUT_MS must be a whole number of milliseconds, or 0 to switch the watchdog off",
    );
  }
  return milliseconds;
}

/** Where the API listens when nothing says otherwise: what `.env.example` and the image ship. */
const DEFAULT_PORT = 3001;

/**
 * The port the API listens on, from either of its two names.
 *
 * `PORT` and `SERVER_PORT` name one number: either moves the server, and two that disagree are
 * refused at boot rather than half-applied. Read through `optional` like every other setting here,
 * and that is the point. An unset variable declared in a compose file, or left as `PORT=` in a
 * `.env`, arrives as an empty string rather than as absent, so `process.env.PORT ??
 * process.env.SERVER_PORT` never fell through to the second name, and `Number.parseInt("")` is
 * `NaN`. Given `NaN`, `Bun.serve` binds an ephemeral port: the server came up somewhere nobody had
 * asked for, `SERVER_PORT` ignored, and the script polling it reported a server that never
 * started — the failure #312 set out to remove, back through the other name.
 *
 * A value that is not a whole port number is refused for the reason the caps above are: `30o1`
 * used to start the server on port 30, and a typo has to fail where somebody is looking.
 */
function serverPort(environment: Environment): number {
  const read = (name: string): number | undefined => {
    const raw = optional(environment, name);
    if (raw === undefined) return undefined;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1 || value > 65535) {
      throw new Error(`${name} must be a whole number between 1 and 65535`);
    }
    return value;
  };
  const port = read("PORT");
  const serverPort = read("SERVER_PORT");
  if (port !== undefined && serverPort !== undefined && port !== serverPort) {
    throw new Error(
      `PORT (${port}) and SERVER_PORT (${serverPort}) disagree: set one or set both to the same value`,
    );
  }
  return port ?? serverPort ?? DEFAULT_PORT;
}

export function loadConfig(
  environment: Environment = process.env,
): DeploymentConfig {
  const google = oauthClient(environment, "GOOGLE");
  const auth = authConfig(environment, google);
  const organizationAuthValue = optional(
    environment,
    "OPENBOT_ORGANIZATION_AUTH_URL",
  );
  const organizationAuthUrl = organizationAuthValue
    ? organizationAuthority(organizationAuthValue)
    : undefined;
  const managedAgent = managedAgentConfig(environment);
  const githubApp = githubAppConfig(environment);
  const publicUrl = (
    optional(environment, "OPENBOT_PUBLIC_URL") ?? auth?.baseUrl
  )?.replace(/\/+$/, "");
  // GitHub sends people back to this address after they approve. Without it linking is silently
  // switched off, so say so at start-up instead.
  if (githubApp && !publicUrl) {
    throw new Error(
      "GITHUB_APP_CLIENT_ID needs OPENBOT_PUBLIC_URL (or BETTER_AUTH_URL) so GitHub can send people back to this server.",
    );
  }
  const workerSharedSecret = optional(environment, "WORKER_SHARED_SECRET");
  // Read once so the payments block can refuse a channel configured without its projection.
  const billing = billingConfig(environment);
  const deploymentKey = keyEncryptionKey(environment);
  const webBotAuth = webBotAuthFromEnv(environment, {
    publicUrl,
    keyEncryptionKey: deploymentKey,
  });

  return {
    port: serverPort(environment),
    transcription: transcriptionConfig(environment),
    voice: voiceConfig(environment),
    databaseUrl: required(environment, "DATABASE_URL"),
    ...spreadOptional(
      "enterpriseDirectoryDatabaseUrl",
      optional(environment, "ENTERPRISE_DIRECTORY_DATABASE_URL"),
    ),
    ...spreadOptional(
      "enterpriseDataDatabaseUrl",
      optional(environment, "ENTERPRISE_DATA_DATABASE_URL"),
    ),
    ...spreadOptional(
      "tenantStorageRuntimeDatabaseUrl",
      optional(environment, "OPENBOT_TENANT_STORAGE_RUNTIME_DATABASE_URL"),
    ),
    keyEncryptionKey: deploymentKey,
    ...(webBotAuth ? { webBotAuth } : {}),
    ...(managedAgent ? { managedAgent } : {}),
    ...(githubApp ? { githubApp } : {}),
    agentEndpointAllowedHosts: agentEndpointAllowedHosts(environment),
    deploymentId: optional(environment, "DEPLOYMENT_ID"),
    composioApiKey: optional(environment, "COMPOSIO_API_KEY"),
    openConnectorUrl:
      optional(environment, "OPENCONNECTOR_URL") ?? "http://localhost:3100",
    openConnectorAdminToken: optional(environment, "OPENCONNECTOR_ADMIN_TOKEN"),
    openConnectorRuntimeToken: optional(
      environment,
      "OPENCONNECTOR_RUNTIME_TOKEN",
    ),
    publicUrl,
    appUrl: (
      optional(environment, "OPENBOT_APP_URL") ??
      commaSeparated(environment, "TRUSTED_ORIGINS")[0] ??
      optional(environment, "OPENBOT_PUBLIC_URL") ??
      auth?.baseUrl
    )?.replace(/\/+$/, ""),
    tenantPackageDirectory:
      optional(environment, "TENANT_PACKAGE_DIR") ?? "../examples/fintech",
    runtime: runtimeCapabilities(environment),
    learning: learningDefault(environment),
    learningAutoAssign: learningAutoAssignEnabled(environment),
    ...learningSetupCredential(environment),
    memoryDefaults: {
      sources: switchedOn(environment, "OPENBOT_MEMORY_SOURCE_DEFAULTS"),
      research: switchedOn(environment, "OPENBOT_PROACTIVE_DEFAULTS"),
    },
    multitenancy: multitenancyConfig(environment),
    agentStallTimeoutMs: agentStallTimeoutMs(environment),
    auditRetentionDays: auditRetentionDays(environment),
    oauth: { google },
    auth,
    ...(organizationAuthUrl ? { organizationAuthUrl } : {}),
    /*
     * The authority short-circuits this, and that ordering is load-bearing: a white-label
     * deployment naming an external authority lets it win, and `singleUserAllowed` is never
     * reached and so cannot refuse a combination that already resolves.
     */
    singleUser:
      !organizationAuthUrl &&
      singleUserAllowed(environment, configuredAuthProviders(auth).length > 0),
    accessibility: accessibilityEnabled(environment),
    generativeUi: generativeUiEnabled(environment),
    selfHostBanner: selfHostBannerEnabled(environment),
    ...(optional(environment, "APP_DIST_DIR")
      ? { appDistDir: optional(environment, "APP_DIST_DIR") as string }
      : {}),
    computer: computerConfig(environment),
    billing,
    payments: paymentsConfig(environment, billing),
    handoff: handoffCaps(environment),
    ...(optional(environment, "AGENT_TOOL_TOKEN")
      ? { agentToolToken: optional(environment, "AGENT_TOOL_TOKEN") as string }
      : {}),
    ...(workerSharedSecret ? { workerSharedSecret } : {}),
  };
}

/**
 * Same rule as generated interfaces: on unless explicitly "false" or "0". A container named in the
 * environment is a choice, so there is nothing to assign.
 */
function learningAutoAssignEnabled(environment: Environment): boolean {
  if (optional(environment, "CPK_INTELLIGENCE_LEARNING_CONTAINER_ID"))
    return false;
  const value = optional(environment, "OPENBOT_LEARNING_AUTO_ASSIGN");
  return value !== "false" && value !== "0";
}

/** On unless the variable is "false" or "0", the rule every default-on switch here follows. */
function switchedOn(environment: Environment, name: string): boolean {
  const value = optional(environment, name);
  return value !== "false" && value !== "0";
}

/**
 * The multitenancy mode switch: an explicit opt-in, never a default (MT013).
 *
 * A default-on rule like {@link switchedOn} would be exactly wrong here: multitenancy changes
 * who the deployment serves, and its boot runs startup checks that can refuse to start. A
 * deployment must arrive at this mode by naming it, so the variable accepts an explicit value
 * on either side and refuses everything else — a typo must not silently become an opt-in any
 * more than a silent default may turn a single-tenant server multi-tenant.
 */
function multitenancyConfig(environment: Environment): {
  enabled: boolean;
  inventoryPath?: string;
  waiversPath?: string;
} {
  const raw = optional(environment, "OPENBOT_MULTITENANCY")?.trim();
  let enabled: boolean;
  if (raw === undefined || raw === "") {
    enabled = false;
  } else if (raw === "on" || raw === "true" || raw === "1") {
    enabled = true;
  } else if (raw === "off" || raw === "false" || raw === "0") {
    enabled = false;
  } else {
    throw new Error(
      `OPENBOT_MULTITENANCY must be "on", "true", "1" (multitenancy mode), or "off", "false", "0" (the default single-tenant mode); got "${raw}". Leave it unset to keep the legacy boot unchanged.`,
    );
  }
  const inventoryPath = optional(environment, "OPENBOT_MULTITENANCY_INVENTORY");
  const waiversPath = optional(environment, "OPENBOT_MULTITENANCY_WAIVERS");
  return {
    enabled,
    ...(inventoryPath ? { inventoryPath } : {}),
    ...(waiversPath ? { waiversPath } : {}),
  };
}

/** The service token and its project, both or neither. See `DeploymentConfig.learningSetup`. */
function learningSetupCredential(environment: Environment): {
  learningSetup?: { serviceToken: string; projectId: string };
} {
  const serviceToken = optional(environment, "INTELLIGENCE_SERVICE_TOKEN");
  const projectId = optional(environment, "INTELLIGENCE_PROJECT_ID");
  if (!serviceToken && !projectId) return {};
  if (!serviceToken || !projectId)
    throw new Error(
      "INTELLIGENCE_SERVICE_TOKEN and INTELLIGENCE_PROJECT_ID go together: the token creates the openbot Learning container in that project. Set both, or neither.",
    );
  if (!/^[1-9][0-9]{0,15}$/.test(projectId))
    throw new Error(
      "INTELLIGENCE_PROJECT_ID must be the Intelligence project's numeric ID.",
    );
  return { learningSetup: { serviceToken, projectId } };
}

/** Optional container default; the enabled preference alone does not collect or deliver. */
function learningDefault(environment: Environment): LearningTarget | undefined {
  const containerId = optional(
    environment,
    "CPK_INTELLIGENCE_LEARNING_CONTAINER_ID",
  );
  if (!containerId) return undefined;
  if (!isLearningContainerId(containerId))
    throw new TypeError(
      "CPK_INTELLIGENCE_LEARNING_CONTAINER_ID must use 1–64 lowercase letters, numbers, and single hyphens.",
    );
  const revision = optional(environment, "CPK_INTELLIGENCE_SKILLS_REVISION");
  return { containerId, ...(revision ? { revision } : {}) };
}

import { createHash } from "node:crypto";
import {
  getCurrentDBAdapterAsyncLocalStorage,
  runWithAdapter,
  runWithEndpointContext,
} from "@better-auth/core/context";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { electron } from "@better-auth/electron";
import { expo } from "@better-auth/expo";
import { scim } from "@better-auth/scim";
import { sso } from "@better-auth/sso";
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { genericOAuth, okta } from "better-auth/plugins";
import { eq, sql } from "drizzle-orm";
import { getLogger } from "../../../shared/logger";
import { createEnterpriseStore } from "../admin/settings-store";
import type { AuditEventInput, AuditStore } from "../audit";
import { recordAuditEvent } from "../audit";
import type { DeploymentConfig } from "../config";
import type { Database } from "../db/client";
import {
  accounts,
  scimConnectionBindings,
  scimGroupMembers,
  scimGroups,
  scimIdentityTombstones,
  scimProjectionGrants,
  scimSubjects,
  scimUsers,
  sessions,
  ssoProviders,
  users,
  verifications,
} from "../db/schema";
import type { Directory, DirectoryTx } from "./directory/contracts";
import { createIdentityFinalizer } from "./directory/finalizer";
import {
  createIdentityExecutor,
  type IdentityBaAccess,
  type IdentityExecutor,
} from "./directory/identity";
import { createAuthMailOutbox } from "./directory/outbox";
import { principalRegistry } from "./directory/principal-registry";
import {
  assertBaAuthorityPreconditions,
  BA_AUTHORITY_CONFIG_VIOLATION,
  createTransactionBoundBa,
} from "./directory/transaction-adapter";
import { DOMAIN_REFUSAL_MESSAGE, emailDomainAllowed } from "./email-domain";
import { encryptSsoConfig } from "./encrypt-sso-config";
import { assertAuthMailTakeover, createAuthMail } from "./mail";
import { isConfiguredAdmin, type RoleDatabase, seedRole } from "./roles";
import {
  createScimTransactionCapture,
  recordProvisioned,
  type ScimConnectionSpec,
  scimOptions,
} from "./scim";

/**
 * Bun fetch 代理豁免（本机/内网上游）：Bun 在进程启动时锁定 HTTP_PROXY 且
 * 运行时摘 env / NO_PROXY / 逐请求 proxy:"" 都拦不住带 body 的 POST（kb-mastra
 * E2E 实测）。better-auth 的 OIDC 交换（better-fetch→globalThis.fetch）与
 * jose 的 JWKS 拉取都走全局 fetch——这里给 globalThis.fetch 打补丁：目标是
 * loopback/内网时逐请求带 proxy:""（Bun 专属字段）禁用代理；外网目标原样
 * 放行（保留代理能力）。auth bootstrap 里调用一次。
 */
function patchGlobalFetchForLocalhost(): void {
  const original = globalThis.fetch.bind(globalThis);
  const loopback =
    /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1\]|host\.docker\.internal)(:\d+)?$/;
  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    let raw: string;
    try {
      raw =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const { hostname } = new URL(raw);
      if (!loopback.test(hostname)) return original(input, init);
    } catch {
      // URL 解析失败（相对路径等）：走原 fetch。
      return original(input, init);
    }
    /*
     * loopback 目标：node:http 直连。实测（kb-mastra E2E + 本 auth 修复）
     * Bun 1.4.2 长驻进程的 fetch 被环境代理劫持 localhost，且逐请求
     * proxy:"" 对带 body 的 POST 不生效——node:http 从不读代理变量，
     * 是唯一稳定通道。方法/头/体语义保持：Request 实例先展开再直连。
     *
     * 直连必须仍是完整 fetch 语义（craft 的回环 agent-sandbox 网关是首个
     * 长流消费方，见 remediation-verification.md F-A）：
     * - content-length 按【字节】计：字符串 .length 是 UTF-16 码元数，
     *   多字体会少报——服务端按声明读体（文件被静默截断），剩余字节滞留
     *   keep-alive 连接，下一个请求配到滞留垃圾的 400 响应。
     * - 响应在【头到达】即结算、body 以流透传：缓冲到 end 的实现对
     *   SSE/长流（/events）永远不结算，事件零到达。
     * - init.signal 必须接线：否则任何挂起请求都无超时可依。
     */
    const url = new URL(raw);
    const method =
      init?.method ?? (input instanceof Request ? input.method : "GET");
    const headerSource =
      init?.headers ?? (input instanceof Request ? input.headers : undefined);
    const headers: Record<string, string> = {};
    if (headerSource) {
      const entries =
        headerSource instanceof Headers
          ? [...headerSource.entries()]
          : Array.isArray(headerSource)
            ? (headerSource as string[][]).map(([k, v]) => [k, v] as const)
            : Object.entries(headerSource as Record<string, string>);
      for (const [key, value] of entries) headers[key] = value;
    }
    const rawBody =
      init?.body ?? (input instanceof Request ? await input.text() : undefined);
    let body: Buffer | undefined;
    if (rawBody !== undefined) {
      body =
        typeof rawBody === "string"
          ? Buffer.from(rawBody, "utf8")
          : Buffer.from(await new Response(rawBody as BodyInit).arrayBuffer());
    }
    const [{ request }, { Readable }] = await Promise.all([
      import("node:http"),
      import("node:stream"),
    ]);
    return new Promise<Response>((resolve, reject) => {
      const req = request(
        {
          hostname: url.hostname,
          port: url.port,
          path: `${url.pathname}${url.search}`,
          method,
          headers: {
            ...headers,
            ...(body !== undefined
              ? { "content-length": String(body.byteLength) }
              : {}),
          },
        },
        (res) => {
          const status = res.statusCode ?? 0;
          // 传输层分帧头不属于 Response 元数据；残留会让 Response 构造异常
          // 或误导消费者，剥掉（原生 fetch 的 Response 从不携带它们）。
          const responseHeaders: Record<string, string> = {};
          for (const [key, value] of Object.entries(res.headers)) {
            if (value === undefined) continue;
            if (
              key === "transfer-encoding" ||
              key === "connection" ||
              key === "keep-alive"
            )
              continue;
            responseHeaders[key] = Array.isArray(value)
              ? value.join(", ")
              : value;
          }
          if (status === 204 || status === 304) {
            res.resume(); // 无体响应：读完（空）才能把 socket 还回池。
            resolve(new Response(null, { status, headers: responseHeaders }));
            return;
          }
          resolve(
            new Response(
              Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>,
              {
                status,
                headers: responseHeaders,
              },
            ),
          );
        },
      );
      req.on("error", reject);
      const signal = init?.signal;
      if (signal) {
        const onAbort = () => {
          req.destroy(
            signal.reason instanceof Error
              ? signal.reason
              : new Error("The loopback fetch was aborted.", {
                  cause: signal.reason,
                }),
          );
        };
        if (signal.aborted) onAbort();
        else {
          signal.addEventListener("abort", onAbort, { once: true });
          req.on("close", () => signal.removeEventListener("abort", onAbort));
        }
      }
      if (body !== undefined) req.end(body);
      else req.end();
    });
  }) as typeof fetch;
}

// 模块加载即打补丁（server 启动 import auth 时生效，先于任何 IdP 交互）。
patchGlobalFetchForLocalhost();

const log = getLogger("server");

/** What a person sees when SSO is required and they tried another way in. */
export const SSO_REQUIRED_MESSAGE =
  "This deployment requires signing in through your company's identity provider. Enter your work email to continue.";

/**
 * SSO-required mode, decided on every sign-in, account link and account creation.
 *
 * Better Auth's `validateUserInfo` is told how the identity arrived (`oauth` for Google, Microsoft
 * and Okta-by-OAuth; `sso-oidc` / `sso-saml` for a registered enterprise provider; `scim` for a
 * directory). While `sso_required` is on, only the last three are admitted.
 *
 * BREAK-GLASS: an address in INITIAL_ADMIN_EMAILS may still sign in another way, so a broken or
 * misconfigured identity provider cannot lock every administrator out. Each such sign-in is written
 * as `session.break_glass`. Fails closed: settings that cannot be read refuse the sign-in.
 */
export async function decideSignInMethod(input: {
  method: string;
  email: string | undefined;
  ssoRequired: () => Promise<boolean>;
  initialAdminEmails: readonly string[];
}): Promise<"allow" | "break_glass" | "refuse"> {
  if (["sso-oidc", "sso-saml", "scim"].includes(input.method)) return "allow";
  let required: boolean;
  try {
    required = await input.ssoRequired();
  } catch {
    required = true;
  }
  if (!required) return "allow";
  if (input.email && isConfiguredAdmin(input.email, input.initialAdminEmails)) {
    return "break_glass";
  }
  return "refuse";
}

/**
 * Write a row about a sign-in, and never let the writing of it stop one.
 *
 * These run inside Better Auth's own hooks, where a thrown error becomes a refused sign-in. A trail
 * that is briefly unavailable must not lock everybody out of the deployment, so the failure is
 * logged where an operator will see it and the sign-in continues.
 */
async function record(
  auditStore: AuditStore | undefined,
  event: AuditEventInput,
): Promise<void> {
  if (!auditStore) return;
  try {
    await recordAuditEvent(auditStore, event);
  } catch (error) {
    log.error(
      {
        type: "sign-in-audit-write-failed",
        eventType: event.eventType,
        error: String(error),
      },
      "sign-in-audit-write-failed",
    );
  }
}

export async function stampSignIn(
  database: RoleDatabase,
  userId: string,
  at: Date,
): Promise<void> {
  try {
    await database
      .update(users)
      .set({
        lastSignedInAt: sql`greatest(coalesce(${users.lastSignedInAt}, ${at}), ${at})`,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId));
  } catch (error) {
    log.error(
      {
        type: "sign-in-stamp-write-failed",
        userId,
        error: String(error),
      },
      "sign-in-stamp-write-failed",
    );
  }
}

/**
 * An address for somebody arriving from Entra, whatever claim it turned up in.
 *
 * Entra does not always send `email`. Microsoft return it only when the profile carries an email
 * attribute, and for a multi-tenant application optional claims may not arrive at all, because an
 * external user's token is minted by their own tenant and does not inherit this application's claim
 * configuration. `common`, the default tenant here, is multi-tenant.
 *
 * Better Auth maps `email` straight through with no fallback, so on those deployments it is
 * undefined. That matters more here than in most products: every authorization decision OpenBot
 * makes about a person is keyed on their address. `INITIAL_ADMIN_EMAILS`, the role, the deny list
 * and the People screen all read it, so an absent address is not a cosmetic gap. Somebody would
 * sign in successfully, match no administrator, and land as a plain user with nothing on any screen
 * explaining why.
 *
 * `upn` first because it is the directory's own name for the account, then `preferred_username`,
 * which the OIDC spec explicitly does not promise is an address but which Entra populates with the
 * UPN in practice. Returning nothing when neither is present is deliberate: Better Auth then
 * refuses the sign-in, and being refused is a far better answer than being quietly admitted as
 * somebody the deployment cannot recognise.
 */
export function mapEntraProfile(profile: Record<string, unknown>) {
  const claim = (name: string) => {
    const value = profile[name];
    return typeof value === "string" && value.includes("@") ? value : undefined;
  };

  const email = claim("email") ?? claim("upn") ?? claim("preferred_username");
  if (!email) {
    log.error(
      {
        type: "entra-profile-missing-email",
        note: "Entra returned no email, upn or preferred_username claim, so this person cannot be identified. Add `email` as an optional claim on the app registration, or use a single-tenant MICROSOFT_OAUTH_TENANT_ID.",
        claims: Object.keys(profile),
      },
      "entra-profile-missing-email",
    );
    return {};
  }

  return { email };
}

/**
 * Casdoor as a generic OAuth provider, shaped the way Better Auth's own `okta()` helper is.
 *
 * Casdoor is not one place: every deployment runs its own origin, so like Okta it is discovered
 * against `/.well-known/openid-configuration` rather than named as a social provider. Better Auth
 * 1.7 ships no `casdoor()` preset, so this is the same five fields one would be. The trailing slash
 * is dropped the same way `okta()` drops it, because the discovery URL is built by joining.
 */
function casdoor(options: {
  clientId: string;
  clientSecret: string;
  issuer: string;
}) {
  const issuer = options.issuer.replace(/\/$/, "");
  return {
    providerId: "casdoor",
    accountIssuer: issuer,
    discoveryUrl: `${issuer}/.well-known/openid-configuration`,
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    scopes: ["openid", "profile", "email"],
  };
}

/**
 * The whole of what the auth factory reads from configuration, per plan 02 §7 T3-B.
 *
 * The factory used to take a full DeploymentConfig but consults exactly two fields: `auth` (every
 * provider, secret and rule below) and `keyEncryptionKey` (SSO config encryption). Narrowing the
 * parameter to those two is what lets the standalone enterprise entry authenticate people without
 * fabricating an Intelligence runtime it does not have — and it is enforced by structure, not by a
 * cast: a caller passing only these fields compiles, and nothing can smuggle a half DeploymentConfig
 * through `as`. The database/SSO dependencies inside the factory are unchanged by this type; the
 * identity connection's per-table privileges are enumerated in
 * server/drizzle/0057_enterprise_identity_grants.sql (granted to the NOLOGIN role ob_ent_identity).
 */
export type AuthBootstrapConfig = Pick<
  DeploymentConfig,
  "auth" | "keyEncryptionKey"
>;

/**
 * The frozen organization-plugin options of interfaces §3.2 (T02.11 / P04).
 *
 * The plugin itself is not mounted yet: the pinned schema it needs on
 * `sessions` (activeOrganizationId/activeTeamId) and on `users` (the Admin
 * plugin's ban/role columns) is a schema task's, and mounting it before those
 * columns exist would make every session write fail. These options are
 * exported now so the task that mounts it cannot drift from the decision:
 *
 * - `allowUserToCreateOrganization: false` — opening a company is the private
 *   platform command (P06), never a self-service native call;
 * - `disableOrganizationDeletion: true` — removal is a reviewed request that
 *   archives assets, never a physical delete;
 * - `dynamicAccessControl` is deliberately absent — the first phase has fixed
 *   roles only, and the native create/update/delete-role endpoints are closed
 *   in the ingress table.
 *
 * The Admin plugin's impersonate permission is removed the same way: it is not
 * part of the access control this deployment assembles, and the ingress
 * refuses /admin/impersonate-user and /admin/stop-impersonating outright.
 */
export const DIRECTORY_ORGANIZATION_PLUGIN_OPTIONS = Object.freeze({
  allowUserToCreateOrganization: false,
  disableOrganizationDeletion: true,
  teams: Object.freeze({ enabled: true }),
});

/*
 * The fixed build's table mapping, shared by the main adapter and the
 * identity executor's transaction-bound twin so the two can never disagree
 * about which physical table a model lands in (T05.08).
 */
const BA_ADAPTER_SCHEMA = Object.freeze({
  users,
  sessions,
  accounts,
  verifications,
  ssoProviders,
  scimConnectionBindings,
  scimIdentityTombstones,
  scimSubjects,
  scimUsers,
  scimProjectionGrants,
  scimGroups,
  scimGroupMembers,
});

/**
 * T05.08 (#564): the auth instance a directory-wired deployment assembles
 * carries its identity executor — the object the assembly mounts behind
 * createApp's `coworker.directory.identity` seam, where the native admin
 * account writes (create-user, update-user, set-user-password) translate
 * into identity commands. Optional because a legacy deployment that wires
 * nothing assembles none and keeps the honest 503 it answers today.
 */
export type DirectoryIdentityAuth = ReturnType<typeof betterAuth> & {
  /** Assigned once by the factory below; never written afterwards. */
  directoryIdentity?: Pick<IdentityExecutor, "execute">;
};

/**
 * The fixed-build calls the identity executor's BA half needs (§2.1/§5.1):
 * the pinned build's own createUser/password paths, reached only from
 * inside a command's TransactionBoundBa run so every row they write rides
 * the command's transaction. Outside one there is nothing to ride, so the
 * calls refuse rather than orphan a user or a credential.
 */
function createDirectoryIdentityBaAccess(
  auth: ReturnType<typeof betterAuth>,
): IdentityBaAccess {
  return {
    createUser: async (input) => {
      const context = await auth.$context;
      /*
       * The current TransactionBoundBa store: the identity command is
       * running, and its adapter is bound to the command's open
       * transaction. The nested runWithAdapter declares that this createUser
       * is not its own transaction — which is exactly true — so the fixed
       * build's user-create database hooks (the domain/revocation gate
       * before, the role bootstrap after) execute inline inside the command
       * instead of queueing as post-commit work the hook fence refuses.
       */
      const store = (await getCurrentDBAdapterAsyncLocalStorage()).getStore() as
        | { adapter?: unknown }
        | undefined;
      if (!store?.adapter) {
        throw new Error(
          "DIRECTORY_IDENTITY_BA_STORE_MISSING: the fixed build's createUser may only run inside the identity command's TransactionBoundBa — a user row written outside the command transaction is the orphan the receipt exists to prevent",
        );
      }
      /*
       * validateUserInfo demands an endpoint context; an identity command is
       * not a fixed-build endpoint, so the deployment's own context view is
       * supplied and the source names how this user really arrived — a
       * platform command, never a sign-in. The gate itself (SSO-required,
       * admitted domains, revoked addresses) runs unchanged: an SSO-mandated
       * deployment still refuses an admin-created account except for its
       * break-glass administrators.
       */
      await runWithEndpointContext(
        /*
         * The pinned build's createUser reads only context.options (the
         * validateUserInfo gate) and context.logger off this view; the cast
         * stands for that narrow contract rather than forging a full
         * endpoint context.
         */
        {
          context: { options: context.options, logger: context.logger },
        } as never,
        () =>
          runWithAdapter(store.adapter as never, async () => {
            const user = await context.internalAdapter.createUser(
              {
                id: input.userId,
                email: input.email,
                name: input.name,
                ...(input.image !== null ? { image: input.image } : {}),
              },
              { method: "platform" },
            );
            if (!user) {
              throw new Error(
                "DIRECTORY_IDENTITY_BA_CREATE_REFUSED: the fixed build's createUser returned no user; the command is refused rather than binding the pre-allocated id to nothing",
              );
            }
            if (input.password !== null) {
              const hashed = await context.password.hash(input.password);
              await context.internalAdapter.linkAccount({
                providerId: "credential",
                // The pinned build's synthetic issuer for local credentials.
                issuer: "local:credential",
                accountId: user.id,
                password: hashed,
                userId: user.id,
              });
            }
          }),
      );
    },
    writePassword: async (input) => {
      const context = await auth.$context;
      const hashed = await context.password.hash(input.newPassword);
      const existing = await context.internalAdapter.findCredentialAccount(
        input.userId,
      );
      if (existing) {
        await context.internalAdapter.updatePassword(input.userId, hashed);
      } else {
        await context.internalAdapter.createAccount({
          userId: input.userId,
          providerId: "credential",
          issuer: "local:credential",
          accountId: input.userId,
          password: hashed,
        });
      }
    },
    consumeResetToken: async (input) => {
      await (
        auth.api as unknown as {
          resetPassword: (args: {
            body: { token: string; newPassword: string };
          }) => Promise<unknown>;
        }
      ).resetPassword({
        body: { token: input.resetToken, newPassword: input.newPassword },
      });
    },
  };
}

/**
 * The SSO factory hard precondition (T05.05's named startup gate, extracted
 * from createAuth so the missing/false variants are pinnable at unit level):
 * the sso plugin must run with organizationProvisioning:{disabled:true} — a
 * provider-carried organizationId may never provision a member (interfaces
 * §3.2's callback contract). A missing flag or disabled:false is a startup
 * refusal before any route runs.
 */
export function assertSsoOrganizationProvisioningDisabled(
  plugins: readonly unknown[] | undefined,
): void {
  const ssoPlugin = (plugins ?? []).find(
    (
      plugin,
    ): plugin is {
      id: string;
      options?: { organizationProvisioning?: { disabled?: boolean } };
    } => Boolean(plugin) && (plugin as { id?: string }).id === "sso",
  );
  if (ssoPlugin?.options?.organizationProvisioning?.disabled !== true) {
    throw new Error(
      `${BA_AUTHORITY_CONFIG_VIOLATION}: the SSO plugin must run with organizationProvisioning:{disabled:true} — a provider-carried organizationId may never provision a member (interfaces §3.2's callback contract); refusing before any route runs`,
    );
  }
}

export function createAuth(
  config: AuthBootstrapConfig,
  database: Database,
  /**
   * Whether an administrator has removed this address.
   *
   * Checked here rather than only in the request guard, because a removed person whose sign-in
   * still succeeds gets a session, a user row and a place in the list: the removal would read as
   * having worked while quietly not having.
   */
  isRevoked?: (email: string) => Promise<boolean>,
  /**
   * Where getting in, and being turned away, are written down.
   *
   * Sign-in was the one thing this deployment did that left no trace. Two questions could not be
   * answered at all: who granted themselves the administrator role by editing the configuration, and
   * whether a person somebody has just removed had ever been here, because removing them deletes the
   * sessions that were the only evidence.
   *
   * Optional and never fatal. A trail that is unavailable must not stop somebody signing in, so every
   * write below is guarded and its failure is logged rather than raised.
   */
  auditStore?: AuditStore,
  /**
   * T05.05 (#561 / P12): the SCIM transcription wiring — the per-company
   * connections and the directory executor seam. Absent keeps the legacy
   * SCIM reactions exactly as they were (a deployment must not change
   * behaviour because a new optional parameter exists).
   */
  scimWiring?: {
    readonly connections?: readonly ScimConnectionSpec[];
    readonly directory?: (tx: DirectoryTx) => Pick<Directory, "execute"> | null;
  },
) {
  const authConfig = config.auth;
  if (!authConfig) {
    throw new Error("No identity provider is configured.");
  }

  /*
   * The mail seam (T04.04 / P08, interfaces §5.1): when the deployment
   * names an SMTP receiver, the fixed build's verification and reset
   * callbacks become createAuthMail's converters over the T02.12
   * transactional outbox — the URL and token are sealed into the stored
   * intent with the deployment's existing key material, and only the
   * post-commit worker delivers through standard SMTP. No SMTP
   * configuration keeps every mail notification off, exactly as before.
   */
  const authMail = authConfig.authSmtp
    ? createAuthMail({
        smtp: authConfig.authSmtp,
        outbox: createAuthMailOutbox({
          payloadSecret: config.keyEncryptionKey,
        }),
      })
    : null;

  /*
   * Okta and Casdoor go through the generic OAuth plugin, the other two do not.
   *
   * Google and Entra are named providers that Better Auth knows the endpoints of. Okta and Casdoor
   * are not one place each: every customer runs their own issuer, so both are OIDC discovery against
   * a URL rather than a provider with a fixed address. The plugin is registered only when at least
   * one of them is configured, so a deployment that uses neither carries no extra routes.
   *
   * They converge again at the browser: `signIn.social({ provider })` starts all four, so the
   * sign-in screen has one code path and does not need to know which kind each provider is.
   */
  const oidcProviders = [
    ...(authConfig.okta
      ? [
          okta({
            clientId: authConfig.okta.clientId,
            clientSecret: authConfig.okta.clientSecret,
            issuer: authConfig.okta.issuer,
          }),
        ]
      : []),
    ...(authConfig.casdoor ? [casdoor(authConfig.casdoor)] : []),
  ];
  /*
   * The transaction capture (T05.05): every transaction the fixed build opens
   * on this database records its open tx, so the SCIM hooks can execute their
   * directory commands on exactly the transaction the plugin owns. Installed
   * whenever the deployment wires the directory surface at all — the SCIM
   * transcription (T05.05) and the identity executor (T05.08) both need it,
   * and the sign-in hooks' writerOf below reads it either way. A legacy
   * deployment's database object is passed to the adapter untouched.
   */
  const scimCapture = scimWiring
    ? createScimTransactionCapture(database)
    : null;
  /*
   * The resolved options the fixed build hands its database factory once
   * $context initializes; the identity executor's transaction-bound adapter
   * twin is built from the same pair (T05.08).
   */
  let resolvedBaOptions: unknown;
  /*
   * The writer the sign-in hooks run on (T05.06): the fixed build's open
   * transaction when the capture seam is assembled — the same commit that
   * owns the user or session row — and the pool on a legacy deployment,
   * which keeps its own shape.
   */
  const writerOf = (): RoleDatabase =>
    (scimCapture?.currentTransaction() ?? database) as RoleDatabase;

  /**
   * The JIT half of an SSO arrival (T05.06 / P12, design §9): eligibility
   * comes only from the verified issuer+subject/binding. The provider row is
   * the server's fixed provider↔company binding; an approved wide rule for
   * that binding is the company's explicit opt-in, and the member it supplies
   * is the minimum role with the rule's fixed teams, on the callback's own
   * transaction. No rule, no binding or no subject supplies nothing — the
   * sign-in itself never depends on company eligibility, and the address a
   * provider reports is never an authority.
   */
  const jitProvisionMember = async (input: {
    readonly user: { readonly id: string };
    readonly userInfo: Record<string, unknown> | undefined;
    readonly provider:
      | {
          readonly providerId?: string;
          readonly organizationId?: string | null;
        }
      | undefined;
  }): Promise<void> => {
    const bindingId = input.provider?.providerId?.trim();
    const tenantId = input.provider?.organizationId?.trim();
    if (!bindingId || !tenantId) return;
    const subject =
      typeof input.userInfo?.sub === "string" &&
      input.userInfo.sub.trim() !== ""
        ? input.userInfo.sub.trim()
        : null;
    if (!subject) return;
    const tx = scimCapture?.currentTransaction();
    const directory = tx ? scimWiring?.directory?.(tx) : null;
    if (!tx || !directory) return;
    const [rule] =
      (
        (await tx.execute(
          sql`SELECT rule_id, revision::int AS revision FROM auth_provisioning_rules
             WHERE binding_id = ${bindingId} AND external_group IS NULL
               AND tenant_id = ${tenantId} AND status = 'approved'
               AND minimum_role = 'member' LIMIT 1`,
        )) as unknown as { rows?: { rule_id: string; revision: number }[] }
      ).rows ?? [];
    if (!rule) return;
    try {
      await directory.execute(
        {
          userId: input.user.id,
          principalId: null,
          sessionId: null,
          kind: "jit",
          bindingId,
          provisioning: {
            eventId: `jit:${bindingId}:${subject}`,
            ruleId: String(rule.rule_id),
            ruleRevision: Number(rule.revision),
            sourceSubject: subject,
          },
        },
        {
          operation: "member.provision",
          tenantId,
          idempotencyKey: `jit:${bindingId}:provision:${input.user.id}`,
          payload: { userId: input.user.id },
        },
      );
    } catch (error) {
      /*
       * The identity the SSO callback proved is not the company eligibility:
       * a rule revoked between the read and the command's own lock, a closed
       * company or a refused supply leaves the sign-in standing with no
       * member row. The command's own audit trail keeps the refusal.
       */
      log.error(
        {
          type: "jit-provision-refused",
          bindingId,
          tenantId,
          error: String(error),
        },
        "jit-provision-refused",
      );
    }
  };

  const scimDeps = {
    database,
    initialAdminEmails: authConfig.initialAdminEmails,
    ...(auditStore ? { auditStore } : {}),
    ...(scimWiring?.connections ? { connections: scimWiring.connections } : {}),
    ...(scimCapture
      ? {
          currentTransaction: scimCapture.currentTransaction,
          directory: scimWiring?.directory ?? null,
        }
      : {}),
  };
  const scimPluginOptions = scimOptions(scimDeps);
  const enterpriseStore = createEnterpriseStore(database);

  /*
   * The native app signs in through its custom scheme, and the Expo plugin appends the session cookie
   * to that redirect. Any Android app can register the same scheme, so the scheme is trusted only on
   * a deployment that runs the native app (EXPO_PROJECT_ID, as for push). Elsewhere a sign-in can
   * never be sent there.
   *
   * EXPO_APP_SCHEME names WHICH app that is. The built-in client uses openbotmobile://; the OpenMuse
   * client (apps/openmuse submodule, apps/mobile) registers openmuse://, and its OAuth callback is refused as an
   * untrusted origin unless the deployment says so. A custom scheme is deliberately not a URL the
   * browser validates, so this accepts scheme:// only and rejects anything else loudly rather than
   * silently widening the trust base to an arbitrary web origin.
   */
  const nativeScheme = process.env.EXPO_APP_SCHEME?.trim();
  if (nativeScheme && !/^[a-z][a-z0-9+.-]*$/i.test(nativeScheme))
    throw new Error(
      "EXPO_APP_SCHEME must be a bare URL scheme, e.g. openmuse.",
    );
  const nativeAppOrigin = `${nativeScheme ?? "openbotmobile"}://`;
  const nativeApp = Boolean(process.env.EXPO_PROJECT_ID?.trim());
  const plugins = [
    ...(nativeApp ? [expo()] : []),
    /*
     * SCIM 2.0 at /api/auth/scim/v2, only when SCIM_BEARER_TOKEN is set. See scim.ts.
     */
    ...(scimPluginOptions ? [scim(scimPluginOptions)] : []),
    electron({ clientID: "openbot-desktop", codeExpiresIn: 120 }),
    ...(oidcProviders.length > 0
      ? [genericOAuth({ config: oidcProviders })]
      : []),
    /*
     * Identity providers a company registers while this is running, by SAML or OIDC.
     *
     * Always on, unlike the three above, because it has nothing to configure: what it can do
     * depends entirely on what an administrator has registered, and an empty table means it offers
     * nothing. Turning it on and off would only mean a deployment could hold a registered IdP that
     * silently stopped working.
     *
     * `provisionUser` runs when somebody arrives through one of them. Their role has to be written
     * here or they land with no role at all and the request guard refuses them with a 403, which
     * reads as a broken deployment rather than a first sign-in.
     *
     * T05.06 (#562 / P12): the write runs on the fixed build's own open
     * transaction (the same commit that owns the user row), and the JIT half
     * derives the person's company eligibility ONLY from the verified
     * issuer+subject/binding of the provider row — never from the address.
     * A provider the server fixed to a company, with an approved wide
     * provisioning rule, supplies the minimum member role and the rule's
     * fixed teams through the directory command on that same transaction; a
     * provider without a rule supplies nothing, and the address a provider
     * reports never grants a role by itself.
     */
    sso({
      resolveUser: async () => ({ action: "continue" as const }),
      provisionUser: async ({ user, userInfo, provider }) => {
        await seedRole(
          writerOf(),
          user.id,
          user.email,
          authConfig.initialAdminEmails,
        );
        await jitProvisionMember({ user, userInfo, provider });
      },
      /*
       * §3.2's SSO callback contract: an organizationId a provider carries
       * creates no member (T02.11 / P04). Off is the fixed decision, and the
       * factory asserts below that the assembled plugin still says so — a
       * future edit that flips it would provision companies from a login
       * claim, which is exactly what the directory command exists to prevent.
       */
      organizationProvisioning: { disabled: true },
    }),
  ];

  const options: Parameters<typeof betterAuth>[0] = {
    user: {
      additionalFields: {
        preferences: {
          type: "json",
          required: false,
          // Settings validates and patches this field for both SSO and single-user mode.
          input: false,
        },
        /*
         * Directory groups, written by SCIM's projection (scim.ts) and read by the per-group
         * capability switches and network policies. Never accepted from a sign-in request.
         */
        groups: {
          type: "string[]",
          required: false,
          input: false,
        },
      },
      validateUserInfo: async ({ user, source }) => {
        const verdict = await decideSignInMethod({
          method: source.method,
          email: typeof user.email === "string" ? user.email : undefined,
          ssoRequired: async () =>
            (await enterpriseStore.settings()).ssoRequired,
          initialAdminEmails: authConfig.initialAdminEmails,
        });
        if (verdict === "allow") return;
        const provider = source.oauth?.providerId ?? source.method;
        if (verdict === "break_glass") {
          await record(auditStore, {
            eventType: "session.break_glass",
            targetType: "person",
            payload: {
              email: user.email,
              provider,
              action: source.action,
              reason:
                "SSO is required, and this address is named in INITIAL_ADMIN_EMAILS, so it was let in another way",
            },
          });
          return;
        }
        await record(auditStore, {
          eventType: "session.refused",
          targetType: "person",
          payload: {
            email: user.email,
            provider,
            reason: "SSO is required on this deployment",
          },
        });
        return {
          error: "sso_required",
          errorDescription: SSO_REQUIRED_MESSAGE,
        };
      },
    },
    baseURL: authConfig.baseUrl,
    secret: authConfig.secret,
    trustedOrigins: [
      ...authConfig.trustedOrigins,
      ...(nativeApp ? [nativeAppOrigin] : []),
    ],
    /*
     * Wrapped, so a company's client secret is ciphertext in the column.
     *
     * The SSO plugin writes `oidc_config` and `saml_config` as plaintext JSON, and the client secret
     * for a customer's directory is inside them. Every other secret this deployment keeps goes
     * through `KEY_ENCRYPTION_KEY`; these two were the exception. See encrypt-sso-config.ts.
     */
    database: (baOptions: unknown) => {
      resolvedBaOptions = baOptions;
      return encryptSsoConfig(
        drizzleAdapter(scimCapture?.database ?? database, {
          provider: "pg",
          usePlural: true,
          schema: BA_ADAPTER_SCHEMA,
          /*
           * Interactive transactions: the SCIM plugin's transcription needs
           * them, and so does the SSO user resolution (T05.06: resolveUser is
           * what makes the fixed build defer its link-account dispatch inside
           * a native transaction — the pinned package refuses the callback
           * without one), so the adapter always offers them.
           */
          transaction: true,
        }),
        config.keyEncryptionKey,
      )(baOptions as never);
    },
    account: {
      /*
       * The provider's access and refresh tokens, encrypted at rest.
       *
       * Better Auth's own mechanism, which uses `BETTER_AUTH_SECRET` rather than
       * `KEY_ENCRYPTION_KEY`. Deliberately theirs: it encrypts on the way into storage and decrypts
       * on the way out, in the one place that knows every path a token takes, and hand-rolling that
       * inside somebody else's storage layer is how rows become permanently unreadable. It also
       * tolerates the plaintext already in the column, so switching it on does not invalidate the
       * accounts of everybody who has already signed in.
       */
      encryptOAuthTokens: true,
    },
    /*
     * Email + password sign-in for the OpenMuse mobile client. Off unless
     * OPENBOT_EMAIL_PASSWORD=true: deployments that authenticate through
     * Casdoor/SSO keep this surface closed, and `decideSignInMethod` above
     * still refuses these requests when a deployment mandates SSO.
     *
     * With mail configured, the reset callback is the same outbox converter
     * (§5.1); the recovery HTTP translation around it is T04.05's.
     */
    ...(authConfig.emailPassword
      ? {
          emailAndPassword: {
            enabled: true,
            minPasswordLength: 8,
            requireEmailVerification: false,
            // The fixed recovery constants (T04.05 / §5.1): the token lives
            // one hour, and a reset revokes the fixed build's own sessions.
            // The revocation is deliberately defensive only — the real
            // security finalization (generation bump, every session and
            // proof, audit) is the Identity finalizer's, in the same
            // transaction the RecoveryIngress runs.
            resetPasswordTokenExpiresIn: 3600,
            revokeSessionsOnPasswordReset: true,
            ...(authMail
              ? { sendResetPassword: authMail.sendResetPassword }
              : {}),
          },
        }
      : {}),
    /*
     * Verification mail (T04.04): signup and every later sign-in of an
     * unverified address dispatch through the converter, so the intent is
     * registered in the signing transaction and delivered only after its
     * commit. The deferred link-account dispatch is taken over the same way
     * (the hook fence converts it inside the command), which is the
     * condition interfaces §3.1 sets for enabling these at all.
     */
    ...(authMail
      ? {
          emailVerification: {
            sendVerificationEmail: authMail.sendVerificationEmail,
            sendOnSignUp: true,
            sendOnSignIn: true,
          },
        }
      : {}),
    /*
     * §3.1's storage preconditions, stated explicitly (T02.11 / P04): session
     * and verification rows are the transaction database's, so the executor's
     * adapter and the identity finalizer read exactly what they wrote. These
     * are the pinned build's defaults; spelling them out is what makes the
     * boot assertion below a fact about the assembled object rather than a
     * hope about a default that a future version could change.
     */
    session: {
      storeSessionInDatabase: true,
    },
    verification: {
      storeInDatabase: true,
    },
    plugins,
    socialProviders: {
      ...(authConfig.google ? { google: authConfig.google } : {}),
      ...(authConfig.microsoft
        ? {
            microsoft: {
              clientId: authConfig.microsoft.clientId,
              clientSecret: authConfig.microsoft.clientSecret,
              tenantId: authConfig.microsoft.tenantId,
              mapProfileToUser: mapEntraProfile,
            },
          }
        : {}),
    },
    databaseHooks: {
      user: {
        create: {
          /*
           * Refuse before the account exists.
           *
           * Somebody removed and then signing in again would otherwise arrive as a brand-new person
           * with a fresh id, no role and no memory of having been removed, which is why the deny
           * list is keyed on the address rather than the id.
           */
          before: async (user) => {
            /*
             * Asked before the deny list because it needs no query, and before the account exists
             * because an address this deployment does not admit must not leave a user row behind.
             */
            if (
              !emailDomainAllowed(user.email, authConfig.allowedEmailDomains)
            ) {
              await record(auditStore, {
                eventType: "session.refused",
                targetType: "person",
                payload: {
                  email: user.email,
                  reason: "email domain not admitted by this deployment",
                },
              });
              throw new APIError("FORBIDDEN", {
                message: DOMAIN_REFUSAL_MESSAGE,
              });
            }
            if (await isRevoked?.(user.email)) {
              // The row a removed person coming back produces. Nothing else records the attempt:
              // no user row is written and no session exists to look at afterwards.
              await record(auditStore, {
                eventType: "session.refused",
                targetType: "person",
                payload: {
                  email: user.email,
                  reason: "access removed by an administrator",
                },
              });
              throw new APIError("FORBIDDEN", {
                message: "Your access to this deployment has been removed.",
              });
            }
            return { data: user };
          },
          after: async (user, context) => {
            /*
             * Who is an administrator is decided by email, not by which provider signed them in. A
             * deployment mid-migration has the same person arriving through Entra one week and
             * Okta the next, and they are the same person to this list.
             */
            // On the fixed build's own transaction (T05.06): the one-time
            // bootstrap shares the commit that owns the user row.
            await seedRole(
              writerOf(),
              user.id,
              user.email,
              authConfig.initialAdminEmails,
            );
            if (context?.path?.startsWith("/scim")) {
              await recordProvisioned(scimDeps, user);
            }
          },
        },
      },
      session: {
        create: {
          /*
           * And again for somebody who already has an account. The user hook above only fires for a
           * new one, so without this a removed person signs straight back in.
           */
          before: async (session) => {
            const [user] = await database
              .select({ email: users.email })
              .from(users)
              .where(eq(users.id, session.userId))
              .limit(1);
            /*
             * And again for an account that already exists, for the reason the deny list is checked
             * twice: the user hook fires only for a new one, so a domain later removed from the
             * list would otherwise keep admitting everybody who had already signed in once.
             */
            if (
              user &&
              !emailDomainAllowed(user.email, authConfig.allowedEmailDomains)
            ) {
              await record(auditStore, {
                eventType: "session.refused",
                targetType: "person",
                targetId: session.userId,
                actorUserId: session.userId,
                payload: {
                  email: user.email,
                  reason: "email domain not admitted by this deployment",
                },
              });
              throw new APIError("FORBIDDEN", {
                message: DOMAIN_REFUSAL_MESSAGE,
              });
            }
            if (user && (await isRevoked?.(user.email))) {
              await record(auditStore, {
                eventType: "session.refused",
                targetType: "person",
                targetId: session.userId,
                actorUserId: session.userId,
                payload: {
                  email: user.email,
                  reason: "access removed by an administrator",
                },
              });
              throw new APIError("FORBIDDEN", {
                message: "Your access to this deployment has been removed.",
              });
            }
            return { data: session };
          },
          after: async (session) => {
            /*
             * On the fixed build's own transaction (T05.06): the stamp shares
             * the commit that owns the session row.
             */
            await stampSignIn(writerOf(), session.userId, session.createdAt);

            const [user] = await database
              .select({ email: users.email })
              .from(users)
              .where(eq(users.id, session.userId))
              .limit(1);

            /*
             * The configured floor is NOT re-applied here (T05.06 sealed the
             * bootstrap): it ran once, at the account's creation, so from the
             * first sign-in on the role belongs to whoever administers the
             * deployment and a later ordinary login leaves it exactly where
             * the admin screen put it.
             */

            await record(auditStore, {
              eventType: "session.signed_in",
              targetType: "person",
              targetId: session.userId,
              actorUserId: session.userId,
              payload: { email: user?.email },
            });
          },
        },
      },
    },
  };

  /*
   * The §3.1 factory preconditions, asserted on the object this factory is
   * about to hand to the pinned build (T02.11 / P04):
   *
   * - session and verification rows live in the transaction database, so the
   *   executor's transaction-bound adapter can read and write them and no
   *   second storage is silently consulted;
   * - no secondaryStorage and no cookie cache — the internal cache sources
   *   those configurations enable register cache-writing post-commit hooks the
   *   hook fence must never drain (T01.04);
   * - no backgroundTasks.handler: the pinned build would run the work outside
   *   the command transaction, after the commit semantics the executor owns.
   *
   * A contrary option is a startup refusal, never a warning: a deployment that
   * boots with these violated would take directory writes whose side effects
   * left the transaction.
   */
  assertBaAuthorityPreconditions(options);
  assertSsoOrganizationProvisioningDisabled(options.plugins);
  /*
   * §3.1's takeover condition (T04.04): mail may only be enabled with the
   * outbox conversion installed — the converter callbacks and the hook
   * fence's notification-outbox disposition. A configuration that enables
   * mail without either never starts.
   */
  assertAuthMailTakeover({
    emailVerification: options.emailVerification as
      | {
          sendOnSignUp?: boolean;
          sendOnSignIn?: boolean;
          sendVerificationEmail?: unknown;
        }
      | undefined,
    emailAndPassword: options.emailAndPassword as
      | { sendResetPassword?: unknown }
      | undefined,
    authMail,
  });
  if (options.advanced?.backgroundTasks !== undefined) {
    throw new Error(
      `${BA_AUTHORITY_CONFIG_VIOLATION}: backgroundTasks is configured; the pinned build would run that work outside the directory command transaction, which is the boundary interfaces §3.1 fixes — remove it before booting`,
    );
  }

  const auth = betterAuth(options);
  if (scimCapture) {
    /*
     * T05.08 (#564): the deployment's identity executor, on the SAME
     * captured database the sign-in hooks write through, so a command's
     * transaction is the one the fixed build's user-create hooks, the BA
     * sync and the finalizer all share — and a fault anywhere in it refuses
     * the whole command. The commitment key is the deployment's auth secret
     * under SHA-256: server-held, never persisted, the same derivation the
     * recovery boundary uses for its actor commitments.
     */
    const executor = createIdentityExecutor({
      database: scimCapture.database,
      bound: createTransactionBoundBa({
        createTxAdapter: (tx) =>
          drizzleAdapter(tx as never, {
            provider: "pg",
            usePlural: true,
            schema: BA_ADAPTER_SCHEMA,
            transaction: false,
          })(resolvedBaOptions as never),
      }),
      registry: principalRegistry,
      finalizer: createIdentityFinalizer(),
      ba: createDirectoryIdentityBaAccess(auth),
      commitmentKey: createHash("sha256").update(authConfig.secret).digest(),
    });
    (auth as DirectoryIdentityAuth).directoryIdentity = executor;
  }
  return auth;
}

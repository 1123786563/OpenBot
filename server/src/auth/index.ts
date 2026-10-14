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
import { DOMAIN_REFUSAL_MESSAGE, emailDomainAllowed } from "./email-domain";
import { encryptSsoConfig } from "./encrypt-sso-config";
import { applyConfiguredAdmin, isConfiguredAdmin, seedRole } from "./roles";
import { recordProvisioned, scimOptions } from "./scim";

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
  database: Database,
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
) {
  const authConfig = config.auth;
  if (!authConfig) {
    throw new Error("No identity provider is configured.");
  }

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
  const scimDeps = {
    database,
    initialAdminEmails: authConfig.initialAdminEmails,
    ...(auditStore ? { auditStore } : {}),
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
     */
    sso({
      provisionUser: async ({ user }) => {
        await seedRole(
          database,
          user.id,
          user.email,
          authConfig.initialAdminEmails,
        );
      },
    }),
  ];

  return betterAuth({
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
    database: encryptSsoConfig(
      drizzleAdapter(database, {
        provider: "pg",
        usePlural: true,
        schema: {
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
        },
        // The SCIM plugin needs interactive transactions; nothing else here asked for them.
        transaction: Boolean(scimPluginOptions),
      }),
      config.keyEncryptionKey,
    ),
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
     */
    ...(authConfig.emailPassword
      ? {
          emailAndPassword: {
            enabled: true,
            minPasswordLength: 8,
            requireEmailVerification: false,
          },
        }
      : {}),
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
            await seedRole(
              database,
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
            await stampSignIn(database, session.userId, session.createdAt);

            /*
             * The configured floor, re-applied on every sign-in. Editing the list has to mean
             * something for people already in the table, or adding yourself after you first signed
             * in silently does nothing. Only promotes, and only addresses the list names: everybody
             * else's role belongs to the admin screen.
             */
            const promoted = await applyConfiguredAdmin(
              database,
              session.userId,
              authConfig.initialAdminEmails,
            );

            const [user] = await database
              .select({ email: users.email })
              .from(users)
              .where(eq(users.id, session.userId))
              .limit(1);

            /*
             * The promotion, on the trail.
             *
             * The floor is applied silently by design, which meant anybody who could edit
             * `INITIAL_ADMIN_EMAILS` made themselves an administrator and nothing anywhere said so.
             * Written only when the role actually changed, so a returning administrator does not
             * produce one of these on every sign-in.
             */
            if (promoted) {
              await record(auditStore, {
                eventType: "person.admin_by_configuration",
                targetType: "person",
                targetId: session.userId,
                actorUserId: session.userId,
                payload: {
                  email: user?.email,
                  reason:
                    "this address is named in INITIAL_ADMIN_EMAILS, so the configuration granted it",
                },
              });
            }

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
  });
}

import { type Context, Hono } from "hono";
import type { Database } from "../db/client";
import type { AccountGrant } from "./account-access";
import {
  assistantReadGrantId,
  workspaceIntegrationGrants,
} from "./integration-grants";
import { bearerSession } from "./native-auth";
import type { personalSaasStore } from "./store";

const grantLifetimeMs = 15 * 60_000;

type OwnerSession =
  | { kind: "authorized"; grant: AccountGrant }
  | { kind: "unconfirmed" }
  | { kind: "signed-out" };

export function integrationGrantRoutes({
  database,
  now,
  store,
  requestSession,
  authorize,
}: {
  database: Database;
  now: () => number;
  store: Pick<ReturnType<typeof personalSaasStore>, "withAuthorizedSession">;
  requestSession: (context: Context) => string | undefined;
  authorize: (token: string) => Promise<OwnerSession>;
}) {
  const routes = new Hono();
  const dispatch = workspaceIntegrationGrants(database, now);

  const ownerPath = "/workspaces/:workspaceId/bots/:botId/integration-grants";
  routes.on(
    "POST",
    [ownerPath, `${ownerPath}/:grantId/revoke`],
    async (context) => {
      const token = requestSession(context);
      if (!token) return context.json({ error: "sign_in_required" }, 401);
      const session = await authorize(token);
      if (session.kind === "unconfirmed")
        return context.json({ error: "account_status_unconfirmed" }, 503);
      if (session.kind === "signed-out")
        return context.json({ error: "sign_in_required" }, 401);

      const { workspaceId, botId, grantId } = context.req.param();
      const target = { workspaceId, botId, accountId: session.grant.accountId };
      const outcome = await store.withAuthorizedSession(
        session.grant,
        token,
        async (tx) => {
          const grants = workspaceIntegrationGrants(tx, now);
          if (grantId) {
            const revoked = await grants.revokeAssistantRead({
              ...target,
              grantId,
            });
            return { kind: "revocation", revoked } as const;
          }
          const expiresAt = new Date(now() + grantLifetimeMs);
          const issued = await grants.issueAssistantRead({
            ...target,
            expiresAt,
          });
          if (!issued) return null;
          return { kind: "issue", ...issued, expiresAt } as const;
        },
      );

      if (!outcome.authorized)
        return context.json({ error: "authorization_changed" }, 403);
      const result = outcome.result;
      if (!result || (result.kind === "revocation" && !result.revoked))
        return context.json({ error: "integration_grant_not_found" }, 404);
      if (result.kind === "revocation") return context.body(null, 204);
      const { credential, expiresAt } = result;
      return context.json(
        { id: assistantReadGrantId(credential), credential, expiresAt },
        201,
      );
    },
  );

  routes.get(
    "/integrations/workspaces/:workspaceId/bots/:botId",
    async (context) => {
      const credential = bearerSession(context.req.header("authorization"));
      if (!credential)
        return context.json({ error: "integration_credential_required" }, 401);
      const bot = await dispatch.execute({
        ...context.req.param(),
        credential,
        action: "assistant.read",
      });
      return bot
        ? context.json(bot)
        : context.json({ error: "assistant_not_found" }, 404);
    },
  );

  return routes;
}

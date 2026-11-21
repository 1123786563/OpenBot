import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { createTestCreditLedger } from "../billing/test-credit";
import type { AccountGrant } from "./account-access";
import type { personalSaasStore } from "./store";

const resource = z.strictObject({
  resourceId: z.string().trim().min(1).max(256),
});
const consent = resource.extend({
  confirmed: z.literal(true),
  expiresAt: z.iso.datetime(),
  maxMicrocredits: z
    .string()
    .regex(/^[1-9][0-9]{0,18}$/)
    .pipe(
      z
        .string()
        .refine((amount) => BigInt(amount) <= 9_223_372_036_854_775_807n),
    ),
});
const grantId = z.uuid();

type OwnerSession =
  | { kind: "authorized"; grant: AccountGrant; subject: string }
  | { kind: "unconfirmed" }
  | { kind: "signed-out" };

export function weknoraGrantRoutes({
  issuer,
  store,
  requestSession,
  authorize,
  now,
}: {
  issuer: string;
  store: Pick<ReturnType<typeof personalSaasStore>, "withAuthorizedSession">;
  requestSession: (context: Context) => string | undefined;
  authorize: (token: string) => Promise<OwnerSession>;
  now: () => number;
}) {
  const routes = new Hono();
  routes.use("*", bodyLimit({ maxSize: 4_096 }));
  routes.on("POST", ["/", "/:authorizationId/revoke"], async (context) => {
    const token = requestSession(context);
    if (!token) return context.json({ error: "sign_in_required" }, 401);
    const session = await authorize(token);
    if (session.kind === "unconfirmed")
      return context.json({ error: "account_status_unconfirmed" }, 503);
    if (session.kind !== "authorized")
      return context.json({ error: "sign_in_required" }, 401);

    const identity = { issuer, subject: session.subject };
    const authorizationId = context.req.param("authorizationId");
    const payload: unknown = await context.req.json().catch(() => undefined);
    const application = "weknora";
    if (authorizationId) {
      const input = resource.safeParse(payload);
      const id = grantId.safeParse(authorizationId);
      if (!input.success || !id.success)
        return context.json({ error: "invalid_spending_authorization" }, 400);
      const result = await store.withAuthorizedSession(
        session.grant,
        token,
        (tx) =>
          createTestCreditLedger(
            tx,
            () => new Date(now()),
          ).revokeExternalSpending(identity, {
            authorizationId: id.data,
            resourceId: input.data.resourceId,
            application,
          }),
      );
      if (!result.authorized)
        return context.json({ error: "authorization_changed" }, 403);
      return result.result
        ? context.body(null, 204)
        : context.json({ error: "spending_authorization_not_found" }, 404);
    }

    const input = consent.safeParse(payload);
    const id = grantId.safeParse(context.req.header("idempotency-key"));
    if (
      !input.success ||
      !id.success ||
      Date.parse(input.data.expiresAt) <= now()
    )
      return context.json({ error: "invalid_spending_consent" }, 400);
    const { resourceId, expiresAt, maxMicrocredits } = input.data;
    const result = await store.withAuthorizedSession(
      session.grant,
      token,
      (tx) =>
        createTestCreditLedger(
          tx,
          () => new Date(now()),
        ).authorizeExternalSpending(identity, {
          authorizationId: id.data,
          application,
          resourceId,
          expiresAt: new Date(expiresAt),
          maxMicrocredits: BigInt(maxMicrocredits),
        }),
    );
    if (!result.authorized || !result.result)
      return context.json({ error: "spending_authorization_unavailable" }, 403);
    return context.json(
      {
        authorizationId: result.result.authorizationId,
        revoked: result.result.revoked,
        application,
        resourceId,
        expiresAt,
        maxMicrocredits,
      },
      result.result.created ? 201 : 200,
    );
  });
  return routes;
}

import { Button } from "@astryxdesign/core/Button";
import { Heading } from "@astryxdesign/core/Heading";
import { VStack } from "@astryxdesign/core/Layout";
import { Link } from "@astryxdesign/core/Link";
import { List, ListItem } from "@astryxdesign/core/List";
import { Text } from "@astryxdesign/core/Text";
import { type Context, Hono } from "hono";
import { z } from "zod";
import type { Database } from "../db/client";
import { supportAccess } from "./support-access";
import {
  maxSupportSeconds,
  supportReason,
  supportResource,
} from "./support-contract";
import { page } from "./web-page";

const workspaceParams = z.object({ workspaceId: z.uuid() });
const ticketParams = workspaceParams.extend({
  ticketId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/),
});
const ownerAction = workspaceParams.extend({
  id: z.uuid(),
  action: z.enum(["approve", "revoke"]),
});
const requestBody = z.strictObject({
  reason: supportReason,
  durationSeconds: z.number().int().min(1).max(maxSupportSeconds),
  resources: z.array(supportResource).min(1).max(20),
});
const readBody = z.strictObject({
  resource: supportResource,
  reason: supportReason,
});

type Session =
  | {
      kind: "authorized";
      accountId: string;
      subject: string;
      isLive: () => Promise<boolean>;
      remainingMs: () => number;
      run: <T>(
        operation: (support: ReturnType<typeof supportAccess>) => Promise<T>,
      ) => Promise<T | undefined>;
    }
  | { kind: "unconfirmed"; reason: string; cutoffAt: number | null }
  | { kind: "signed-out" };

export function supportRoutes(input: {
  database: Database;
  authorize: (context: Context) => Promise<Session>;
  subjects: readonly string[];
}) {
  const routes = new Hono<{
    Variables: { session: Extract<Session, { kind: "authorized" }> };
  }>();
  const support = supportAccess(input.database);
  const subjects = new Set(input.subjects);
  const operator = "/api/support/workspaces/:workspaceId";
  const ticket = `${operator}/tickets/:ticketId/requests`;
  const owner = "/api/workspaces/:workspaceId/support-requests";

  routes.use(`${operator}/*`, async (context, next) => {
    const session = await input.authorize(context);
    if (session.kind === "unconfirmed")
      return context.json(
        { error: session.reason, cutoffAt: session.cutoffAt },
        503,
      );
    if (session.kind === "signed-out")
      return context.json({ error: "sign_in_required" }, 401);
    if (!subjects.has(session.subject))
      return context.json({ error: "support_operator_required" }, 403);
    context.set("session", session);
    await next();
  });

  routes.use(`${owner}/*`, async (context, next) => {
    const session = await input.authorize(context);
    if (session.kind === "unconfirmed")
      return context.json(
        { error: session.reason, cutoffAt: session.cutoffAt },
        503,
      );
    if (session.kind === "signed-out")
      return context.json({ error: "sign_in_required" }, 401);
    context.set("session", session);
    await next();
  });

  routes.get(`${operator}/metadata`, async (context) => {
    const target = workspaceParams.safeParse(context.req.param());
    const data =
      target.success && (await support.metadata(target.data.workspaceId));
    return data && (await context.var.session.isLive())
      ? context.json(data)
      : context.json({ error: "workspace_not_found" }, 404);
  });

  routes.post(ticket, async (context) => {
    const target = ticketParams.safeParse(context.req.param());
    const body = requestBody.safeParse(
      await context.req.json().catch(() => undefined),
    );
    if (!target.success || !body.success)
      return context.json({ error: "invalid_support_request" }, 400);
    const { accountId, subject, run } = context.var.session;
    const result = await run((support) =>
      support.request({
        ...target.data,
        ...body.data,
        operatorId: accountId,
        actorSubject: subject,
      }),
    );
    return result
      ? context.json(result, 201)
      : context.json({ error: "workspace_not_found" }, 404);
  });

  routes.post(`${ticket}/:id/read`, async (context) => {
    const target = ticketParams
      .extend({ id: z.uuid() })
      .safeParse(context.req.param());
    const body = readBody.safeParse(
      await context.req.json().catch(() => undefined),
    );
    if (!target.success || !body.success)
      return context.json({ error: "invalid_support_read" }, 400);
    const { accountId, subject, run, isLive } = context.var.session;
    const result = await run((support) =>
      support.read({
        ...target.data,
        ...body.data,
        operatorId: accountId,
        actorSubject: subject,
      }),
    );
    return result && (await isLive())
      ? context.json(result)
      : context.json({ error: "resource_unavailable" }, 404);
  });

  routes.get(owner, async (context) => {
    const target = workspaceParams.safeParse(context.req.param());
    const history =
      target.success &&
      (await support.history(
        target.data.workspaceId,
        context.var.session.accountId,
      ));
    return history && (await context.var.session.isLive())
      ? context.json(history)
      : context.json({ error: "workspace_not_found" }, 404);
  });

  routes.get(`${owner}/view`, async (context) => {
    const target = workspaceParams.safeParse(context.req.param());
    if (!target.success) return context.notFound();
    const { workspaceId } = target.data;
    const history = await support.history(
      workspaceId,
      context.var.session.accountId,
    );
    if (!history || !(await context.var.session.isLive()))
      return context.notFound();
    const path = `/api/workspaces/${workspaceId}/support-requests`;
    const tickets = new Map(
      history.requests.map(({ id, ticketId }) => [id, ticketId]),
    );
    return context.html(
      page(
        "Support access",
        <>
          <Text as="p">
            <Link href="/workspace">Back to workspace</Link>
          </Text>
          <section aria-labelledby="requests">
            <Heading level={2} id="requests">
              Requests
            </Heading>
            {history.requests.length ? (
              history.requests.map((request) => {
                const expired =
                  request.expiresAt && request.expiresAt <= new Date();
                const status = request.revokedAt
                  ? "Revoked"
                  : expired
                    ? "Expired"
                    : request.approvedAt
                      ? "Approved"
                      : "Pending";
                const action =
                  status === "Pending"
                    ? "approve"
                    : status === "Approved"
                      ? "revoke"
                      : undefined;
                return (
                  <article key={request.id}>
                    <Heading level={3}>Ticket {request.ticketId}</Heading>
                    <Text as="p">
                      {status} · Requested by {request.actorSubject} ·{" "}
                      {request.durationSeconds} seconds
                    </Text>
                    <Text as="p">{request.reason}</Text>
                    {request.expiresAt ? (
                      <Text as="p">
                        Expires {request.expiresAt.toISOString()}
                      </Text>
                    ) : (
                      ""
                    )}
                    <List edge="flush" hasDividers>
                      {request.resources.map(({ kind, id }) => (
                        <ListItem
                          key={`${kind}:${id}`}
                          label={
                            <VStack gap={2}>
                              {kind} · {id}
                            </VStack>
                          }
                        />
                      ))}
                    </List>
                    {action ? (
                      <form
                        method="post"
                        action={`${path}/${request.id}/${action}`}
                      >
                        <Button
                          type="submit"
                          label={
                            (action === "approve"
                              ? "Approve access"
                              : "Revoke access") +
                            " for ticket " +
                            request.ticketId
                          }
                        />
                      </form>
                    ) : (
                      ""
                    )}
                  </article>
                );
              })
            ) : (
              <Text as="p">No support requests.</Text>
            )}
          </section>
          <section aria-labelledby="accesses">
            <Heading level={2} id="accesses">
              Access history
            </Heading>
            {history.accesses.length ? (
              <List edge="flush" hasDividers>
                {history.accesses.map((access) => (
                  <ListItem
                    key={access.id}
                    label={
                      <VStack gap={2}>
                        {access.accessedAt.toISOString()} · Ticket{" "}
                        {tickets.get(access.requestId) ?? ""}·{" "}
                        {access.actorSubject} · {access.resource.kind} ·{" "}
                        {access.resource.id} · {access.reason}
                      </VStack>
                    }
                  />
                ))}
              </List>
            ) : (
              <Text as="p">No support accesses.</Text>
            )}
          </section>
          <script
            src="/assets/session.js"
            data-access-ms={context.var.session.remainingMs()}
            defer
          ></script>
        </>,
      ),
    );
  });

  routes.post(`${owner}/:id/:action`, async (context) => {
    const target = ownerAction.safeParse(context.req.param());
    const updated =
      target.success &&
      (await context.var.session.run((support) =>
        support.decide({
          ...target.data,
          accountId: context.var.session.accountId,
        }),
      ));
    if (!updated || !target.success)
      return context.json({ error: "support_request_unavailable" }, 404);
    if (
      context.req.header("content-type") === "application/x-www-form-urlencoded"
    )
      return context.redirect(
        `/api/workspaces/${target.data.workspaceId}/support-requests/view`,
        303,
      );
    return context.body(null, 204);
  });

  return routes;
}

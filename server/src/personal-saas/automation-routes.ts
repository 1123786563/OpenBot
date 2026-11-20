import { createHash, timingSafeEqual } from "node:crypto";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { html } from "hono/html";
import type { AccountGrant } from "./account-access";
import { inboundMessage, type personalAutomation } from "./automation";
import type { personalSaasStore } from "./store";

export const inboundRelayPath = "/api/webhooks/personal-inbound";
const automationReason: Record<string, string> = {
  account_disabled: "The account was disabled.",
  account_status_unconfirmed: "Account status could not be confirmed.",
  workspace_paused: "The workspace was paused.",
  run_interrupted: "The run was interrupted.",
  manual_resume_required: "Resume this item to accept new work.",
  message_predates_resume:
    "This message arrived after resume but was sent earlier.",
  routine_occurrence_expired: "This Routine missed its scheduled time.",
  routine_paused: "This Routine is switched off.",
  binding_unavailable: "The inbound binding changed or is unavailable.",
  conversation_unavailable: "The conversation is unavailable.",
  bot_execution_unavailable: "Bot execution is unavailable.",
  automation_quota_exceeded:
    "The workspace reached its automation trigger limit.",
  bot_quota_exceeded: "The workspace reached its Bot run limit.",
  opted_out: "The recipient opted out.",
};
export const automationPath = "/api/workspace/automation";

function browserView(context: Context) {
  return (
    !context.req.header("authorization") &&
    context.req.header("accept")?.includes("text/html")
  );
}

export function workspaceAutomationRoutes({
  automation,
  executionEnabled,
  getSession,
  page,
  withAuthorizedSession,
}: {
  automation: ReturnType<typeof personalAutomation>;
  executionEnabled: boolean;
  getSession(
    context: Context,
  ): Promise<{ token: string; grant: AccountGrant } | null>;
  page(title: string, body: ReturnType<typeof html>): ReturnType<typeof html>;
  withAuthorizedSession: ReturnType<
    typeof personalSaasStore
  >["withAuthorizedSession"];
}) {
  const automationRoutes = new Hono();
  automationRoutes.get("/", async (context) => {
    const session = await getSession(context);
    if (!session) return context.json({ error: "authorization_required" }, 403);
    const result = await withAuthorizedSession(
      session.grant,
      session.token,
      (tx) => automation.list(tx, session.grant.accountId),
    );
    if (!result.authorized)
      return context.json({ error: "authorization_changed" }, 403);
    if (browserView(context)) {
      const { routines, bindings } = result.result;
      const item = (
        resource: "routines" | "bindings",
        id: string,
        title: string,
        reason: string | null,
        canRun = false,
      ) => {
        const path = `${automationPath}/${resource}/${encodeURIComponent(id)}`;
        return html`<li><p>${title}</p>
          ${reason ? html`<p>${automationReason[reason] ?? reason}</p>` : ""}
          <a href="${path}/runs">History</a>
          ${reason === "manual_resume_required" ? html`<form method="post" action="${path}/resume"><button>Resume</button></form>` : ""}
          ${canRun && !reason ? html`<form method="post" action="${path}/run"><button>Run now</button></form>` : ""}
        </li>`;
      };
      return context.html(
        page(
          "Routines and inbound bindings",
          html`
        <a href="/workspace">Back to workspace</a>
        <h2>Routines</h2>
        ${
          routines.length
            ? html`<ul>${routines.map((routine) =>
                item(
                  "routines",
                  routine.id,
                  routine.title ?? "Routine",
                  routine.blockedReason,
                  routine.enabled && executionEnabled,
                ),
              )}</ul>`
            : html`<p>No Routines.</p>`
        }
        <h2>Inbound bindings</h2>
        ${
          bindings.length
            ? html`<ul>${bindings.map((binding) =>
                item(
                  "bindings",
                  binding.id,
                  binding.transport,
                  binding.blockedReason,
                ),
              )}</ul>`
            : html`<p>No inbound bindings.</p>`
        }
      `,
        ),
      );
    }
    return context.json(result.result);
  });
  automationRoutes.get("/:resource/:id/runs", async (context) => {
    const session = await getSession(context);
    if (!session) return context.json({ error: "authorization_required" }, 403);
    const { resource, id } = context.req.param();
    if (resource !== "routines" && resource !== "bindings")
      return context.notFound();
    const result = await withAuthorizedSession(
      session.grant,
      session.token,
      async (tx) =>
        resource === "routines"
          ? automation.routineHistory(tx, session.grant.accountId, id)
          : automation.bindingHistory(tx, session.grant.accountId, id),
    );
    if (!result.authorized)
      return context.json({ error: "authorization_changed" }, 403);
    if (!result.result) return context.notFound();
    if (browserView(context)) {
      const runs = result.result;
      return context.html(
        page(
          resource === "routines" ? "Routine history" : "Inbound history",
          html`<a href="${automationPath}">Back to Routines and inbound bindings</a>
        ${
          runs.length
            ? html`<ul>${runs.map((run) => {
                const date = "status" in run ? run.startedAt : run.receivedAt;
                const outcome =
                  "status" in run
                    ? (run.status ?? "queued or running")
                    : run.state;
                return html`<li><time datetime="${date.toISOString()}">${date.toISOString()}</time>
            <p>${outcome}${run.error ? ` · ${automationReason[run.error] ?? run.error}` : ""}</p></li>`;
              })}</ul>`
            : html`<p>No history yet.</p>`
        }`,
        ),
      );
    }
    return context.json({ runs: result.result });
  });
  automationRoutes.post("/:resource/:id/:action", async (context) => {
    const session = await getSession(context);
    if (!session) return context.json({ error: "authorization_required" }, 403);
    const { resource, id, action } = context.req.param();
    if (action !== "run" && action !== "resume") return context.notFound();
    if (
      resource !== "routines" &&
      (resource !== "bindings" || action !== "resume")
    )
      return context.notFound();
    const outcome = await withAuthorizedSession(
      session.grant,
      session.token,
      async (tx) =>
        resource === "routines"
          ? automation.routineAction(tx, session.grant.accountId, id, action)
          : {
              kind: await automation.resumeBinding(
                tx,
                session.grant.accountId,
                id,
              ),
            },
    );
    if (!outcome.authorized || outcome.result.kind === "denied")
      return context.json({ error: "authorization_changed" }, 403);
    const result = outcome.result;
    if (result.kind === "missing") return context.notFound();
    if (result.kind === "offline")
      return context.json({ error: "bot_execution_unavailable" }, 503);
    if (result.kind === "resumed")
      return browserView(context)
        ? context.redirect(automationPath, 303)
        : context.body(null, 204);
    if ("runId" in result)
      return browserView(context)
        ? context.redirect(
            `${automationPath}/routines/${encodeURIComponent(id)}/runs`,
            303,
          )
        : context.json({ runId: result.runId }, 202);
    return context.json(
      {
        error:
          result.kind === "running"
            ? "routine_already_running"
            : "routine_paused",
      },
      409,
    );
  });
  return automationRoutes;
}

export function inboundRelay(
  automation: Pick<ReturnType<typeof personalAutomation>, "receive">,
  token: string,
  now: () => number,
) {
  const app = new Hono();
  const digest = (value: string) => createHash("sha256").update(value).digest();
  const expected = digest(`Bearer ${token}`);
  app.post("/", bodyLimit({ maxSize: 128 * 1024 }), async (context) => {
    const credential = context.req.header("authorization") ?? "";
    if (!timingSafeEqual(expected, digest(credential)))
      return context.json({ error: "relay_authorization_required" }, 401);
    const message = inboundMessage.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!message.success || message.data.sentAt.getTime() > now())
      return context.json({ error: "invalid_message" }, 400);
    await automation.receive(message.data);
    return context.body(null, 204);
  });
  return app;
}

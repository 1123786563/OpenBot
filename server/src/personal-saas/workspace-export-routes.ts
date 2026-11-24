import { type Context, Hono } from "hono";
import { z } from "zod";
import { sign, verify } from "../auth/signed-value";
import type { Database } from "../db/client";
import type { AccountGrant, accountDecision } from "./account-access";
import {
  canExportWorkspace,
  exportWorkspaceId,
  readWorkspaceExport,
} from "./workspace-export";
import { latestSuspension } from "./workspace-suspension";

const exportPath = "/api/workspaces/:workspaceId/exports";
const label = "personal-workspace-export";
const lifetimeMs = 15 * 60 * 1000;
const link = z.tuple([
  z.uuid(),
  exportWorkspaceId,
  z.number().int().nonnegative(),
  z.number().int().positive(),
  z.uuid().nullable(),
]);

type Authorization =
  | { kind: "signed-out" }
  | ({ kind: "unconfirmed" } & Pick<
      Extract<ReturnType<typeof accountDecision>, { kind: "denied" }>,
      "reason" | "cutoffAt"
    >)
  | { kind: "authorized"; grant: AccountGrant };

export function workspaceExportRoutes({
  database,
  encryptionKey,
  now,
  authorize,
  stillAuthorized,
}: {
  database: Database;
  encryptionKey: string;
  now: () => number;
  authorize: (context: Context) => Promise<Authorization>;
  stillAuthorized: (context: Context, grant: AccountGrant) => Promise<boolean>;
}) {
  const routes = new Hono();

  function notFound(context: Context) {
    return context.json({ error: "export_not_found" }, 404);
  }

  async function handle(context: Context) {
    const download = context.req.param("download");

    const session = await authorize(context);
    if (session.kind === "signed-out")
      return context.json({ error: "sign_in_required" }, 401);
    if (session.kind === "unconfirmed")
      return context.json(
        { error: session.reason, cutoffAt: session.cutoffAt },
        503,
      );

    const workspaceId = exportWorkspaceId.safeParse(
      context.req.param("workspaceId"),
    );
    if (!workspaceId.success) return notFound(context);
    const { grant } = session;
    const target = {
      workspaceId: workspaceId.data,
      accountId: grant.accountId,
    };

    const suspension = await latestSuspension(database, target.accountId);
    if (suspension?.action === "pause")
      return context.json({ error: "workspace_paused" }, 403);
    const suspensionId = suspension?.id ?? null;

    if (download === undefined) {
      if (!(await canExportWorkspace(database, target)))
        return notFound(context);
      if (!(await stillAuthorized(context, grant)))
        return context.json({ error: "authorization_changed" }, 403);

      const expiresAt = now() + lifetimeMs;
      const claim = Buffer.from(
        JSON.stringify([
          target.accountId,
          target.workspaceId,
          grant.epoch,
          expiresAt,
          suspensionId,
        ]),
      ).toString("base64url");
      const downloadUrl = `/api/workspaces/${target.workspaceId}/exports/${sign(claim, encryptionKey, label)}/download`;
      if (context.req.header("accept")?.includes("text/html"))
        return context.redirect(downloadUrl, 303);
      return context.json({ downloadUrl, expiresAt: new Date(expiresAt) }, 201);
    }

    if (!/^[\w-]{1,200}\.[\w-]{43}$/.test(download)) return notFound(context);
    const claim = verify(download, encryptionKey, label);
    if (!claim) return notFound(context);
    const parsed = link.safeParse(
      JSON.parse(Buffer.from(claim, "base64url").toString("utf8")),
    );
    if (!parsed.success) return notFound(context);
    const [accountId, workspace, epoch, expiresAt, operationId] = parsed.data;
    if (
      target.accountId !== accountId ||
      target.workspaceId !== workspace ||
      grant.epoch !== epoch ||
      suspensionId !== operationId ||
      now() >= expiresAt
    )
      return notFound(context);

    const data = await readWorkspaceExport(database, target);
    if (!data) return notFound(context);
    const content = JSON.stringify(data, null, 2);
    if (!(await canExportWorkspace(database, target))) return notFound(context);
    if (!(await stillAuthorized(context, grant)))
      return context.json({ error: "authorization_changed" }, 403);
    if (now() >= expiresAt) return notFound(context);

    return context.body(content, 200, {
      "Content-Type": "application/json; charset=UTF-8",
      "Content-Disposition": 'attachment; filename="openbot-workspace.json"',
      "Referrer-Policy": "no-referrer",
    });
  }

  return routes
    .post(exportPath, handle)
    .get(`${exportPath}/:download/download`, handle);
}

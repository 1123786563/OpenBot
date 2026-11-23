import { sql } from "drizzle-orm";
import { z } from "zod";
import type { ApprovalAction } from "../../approvals/types";
import type { AuthenticatedActor } from "../../auth/guards";
import type { Database } from "../../db/client";
import { githubPilotRepositories } from "../../db/schema";
import { issueArgs, messageArgs, supportedBrokerAction } from "./broker-action";
import { createCorsairCutover, type CorsairScope } from "./cutover";
import { readCorsairReadiness } from "./readiness";
import { RevocationRefusal } from "./revocation";

type Reader = Pick<Database, "execute">;
type Validate = NonNullable<
  NonNullable<
    Parameters<typeof import("./cutover").dispatchCorsairWrite>[1]
  >["validate"]
>;
export type BotWrite = {
  action: ApprovalAction;
  send(
    approvalId: string,
    validate: Validate,
    approvalDigest?: string,
  ): Promise<unknown>;
};
type Prepare = (
  actor: AuthenticatedActor,
  args: unknown,
  connectionId: string,
  goal?: { id: string; runId: string; threadId: string },
) => Promise<BotWrite>;
type Pilots = Partial<Record<"github" | "slack" | "sharedSlack", Prepare>>;
type Readiness = Omit<
  Parameters<typeof readCorsairReadiness>[0],
  "canUseBot" | "database"
> & {
  database: Database;
};

const unsupported = () =>
  new RevocationRefusal(
    "This tool has no current verified Corsair mapping.",
    409,
  );

export function createCorsairBotWrites(
  options: Readiness,
  pilots: Pilots,
  actorFor: (id: string) => Promise<AuthenticatedActor | null>,
) {
  async function reviewedTool(
    db: Reader,
    scope: CorsairScope,
    ref: string,
    botId: string,
    kind: "personal" | "shared",
    excluded: readonly string[],
  ) {
    const pilot = kind === "shared" ? "sharedSlack" : scope.app;
    const registration =
      kind === "shared"
        ? options.sharedSlackRegistration
        : options.registrations[scope.app];
    const prepare = pilots[pilot];
    if (
      scope.workspaceId !== options.workspaceId ||
      !registration ||
      !prepare ||
      (kind === "shared" && scope.app !== "slack") ||
      excluded.includes(`tool:${ref}`) ||
      excluded.includes(`audit:${ref}`)
    )
      return null;
    const tool =
      scope.app === "github"
        ? "corsair/github.create_issue"
        : kind === "shared"
          ? "corsair/slack.shared_post_message"
          : "corsair/slack.post_message";
    const [mapping] = await db.execute<{ payload: unknown }>(sql`
      select e.payload from audit_events e
      join mcp_tools t on t.server_id || '/' || t.name = ${ref}
      join plugin_grants g on g.kind = 'mcp' and g.ref = ${ref} and g.agent_id = ${botId}
      where e.event_type = 'corsair.migration_policy_copied'
        and e.target_type = 'corsair_migration_policy'
        and e.target_id = ${JSON.stringify([scope.workspaceId, scope.app, registration, botId, kind])}
        and e.payload->>'legacyTool' = ${ref}
        and e.payload->>'targetTool' = ${tool}
        and e.payload->>'sourceTool' = to_jsonb(t)::text
        and g.granted_as is distinct from 'owner'
        and t.effect = 'write' and not t.destructive and not t.unclassified
      for share of t, g
    `);
    const parsed = z
      .object({ resources: z.array(z.string()) })
      .safeParse(mapping?.payload);
    return parsed.success
      ? { prepare, registration, tool, resources: parsed.data.resources }
      : null;
  }

  return {
    async advertised(
      scope: CorsairScope,
      ref: string,
      botId: string,
      kind: "personal" | "shared",
      excluded: readonly string[],
    ) {
      const mapping = await reviewedTool(
        options.database,
        scope,
        ref,
        botId,
        kind,
        excluded,
      );
      return (
        !!mapping &&
        (await readCorsairReadiness(options, scope.app)).capabilities.some(
          (capability) =>
            capability.key === `tool:${ref}` && capability.status === "ready",
        )
      );
    },
    async prepare(input: {
      scope: CorsairScope;
      ref: string;
      botId: string;
      actorId: string;
      kind: "personal" | "shared";
      goal?: { id: string; runId: string; threadId: string };
      provider: "composio" | "arcade";
      vendorUserId: string;
      pinned?: { id: string; vendorUserId: string; accountId: string | null };
      vendorName: string;
      args: Record<string, unknown>;
    }) {
      const {
        scope,
        ref,
        botId,
        actorId,
        kind,
        provider,
        vendorUserId,
        pinned,
      } = input;
      if (!supportedBrokerAction(scope.app, input.vendorName))
        throw unsupported();
      const actor = await actorFor(actorId);
      if (!actor) throw unsupported();
      const accountKey = pinned
        ? `legacy-account:${pinned.id}`
        : `legacy-account:${provider}:${kind === "shared" ? "" : actorId}`;
      const translated =
        scope.app === "github"
          ? issueArgs.safeParse(input.args)
          : messageArgs.safeParse(input.args);
      if (!translated.success)
        throw new RevocationRefusal(
          "These arguments are outside the verified Corsair operation.",
          409,
        );
      const brokerArgs = translated.data;
      async function resolve(db: Reader, excluded: readonly string[]) {
        if (excluded.includes(accountKey)) throw unsupported();
        const mapping = await reviewedTool(
          db,
          scope,
          ref,
          botId,
          kind,
          excluded,
        );
        if (!mapping) throw unsupported();
        const [legacy] = await db.execute<{ valid: boolean }>(sql`
          select exists (
            select 1 from brokered_connections b
            where b.provider = ${provider} and lower(btrim(b.app)) = ${scope.app}
              and b.holder = ${kind === "shared" ? "deployment" : "person"}
              and b.user_id is not distinct from ${kind === "shared" ? null : actorId}
              and b.vendor_user_id = ${vendorUserId} and b.verified
              and (b.holder = 'deployment' or case when ${pinned?.id ?? null}::text is null then
                not exists (select 1 from brokered_accounts a
                  where a.provider = b.provider and a.app = b.app and a.user_id = b.user_id)
              else exists (
                select 1 from brokered_accounts a
                where a.id::text = ${pinned?.id ?? null} and a.provider = b.provider
                  and a.app = b.app and a.user_id = b.user_id
                  and a.vendor_user_id = ${pinned?.vendorUserId ?? null}
                  and a.account_id = ${pinned?.accountId ?? ""}
                for share of a
              ) end)
            for share of b
          ) as valid
        `);
        if (!legacy?.valid) throw unsupported();
        const report = await readCorsairReadiness(
          { ...options, database: db },
          scope.app,
        );
        const account = report.capabilities.find(
          (capability) => capability.key === accountKey,
        );
        const targetId =
          account?.status === "ready" && account.decision?.kind === "verified"
            ? account.decision.targetId
            : undefined;
        const connection = report.connections.find(
          (row) =>
            row.id === targetId &&
            row.registration === mapping.registration &&
            row.kind === `${scope.app}-${kind}` &&
            (kind === "shared"
              ? row.status === "enrolled"
              : row.personId === actorId && row.status === "connected"),
        );
        if (
          !connection ||
          !report.capabilities.some(
            (capability) =>
              capability.key === `tool:${ref}` && capability.status === "ready",
          )
        )
          throw unsupported();
        const [destination] = await db.execute<{ held: boolean }>(sql`
          select case when ${kind} = 'shared' then exists (
            select 1 from corsair_shared_access
            where bot_id = ${botId} and installation_id = ${connection.id} and granted and approval is not null
            for share
          ) else exists (
            select 1 from plugin_grants
            where kind = ${`corsair.${scope.app}`} and agent_id = ${botId}
              and ref = jsonb_build_array(${scope.workspaceId}::text, ${mapping.registration}::text, ${mapping.tool}::text)::text
            for share
          ) end as held
        `);
        if (!destination?.held) throw unsupported();
        let args: unknown;
        if ("owner" in brokerArgs) {
          const repositories = await db.execute<{ id: string }>(sql`
            select repository_id as id from ${githubPilotRepositories}
            where workspace_id = ${scope.workspaceId} and registration = ${mapping.registration}
              and lower(name) = lower(${`${brokerArgs.owner}/${brokerArgs.repo}`})
            for share
          `);
          const repository = repositories[0];
          if (
            repositories.length !== 1 ||
            !repository ||
            !mapping.resources.includes(repository.id)
          )
            throw unsupported();
          args = {
            botId,
            repositoryId: Number(repository.id),
            title: brokerArgs.title,
            body: brokerArgs.body,
          };
        } else if (mapping.resources.includes(brokerArgs.channel)) {
          args = {
            botId,
            channelId: brokerArgs.channel,
            text: brokerArgs.text,
          };
        } else throw unsupported();
        return { ...mapping, connection, args };
      }
      const route = await createCorsairCutover(options.database, scope).read();
      if (route.kind === "legacy") throw unsupported();
      const resolved = await resolve(options.database, route.excluded);
      const prepared = await resolved.prepare(
        actor,
        resolved.args,
        resolved.connection.id,
        input.goal,
      );
      return {
        action: prepared.action,
        send: (approvalId: string, approvalDigest?: string) =>
          prepared.send(
            approvalId,
            async (db, excluded) => {
              const current = await resolve(db, excluded);
              if (
                current.connection.id !== resolved.connection.id ||
                current.connection.revision !== resolved.connection.revision ||
                current.connection.externalUserId !==
                  resolved.connection.externalUserId ||
                current.connection.subjectScope !==
                  resolved.connection.subjectScope ||
                JSON.stringify(current.args) !== JSON.stringify(resolved.args)
              )
                throw unsupported();
            },
            approvalDigest,
          ),
      };
    },
  };
}

export type CorsairBotWrites = ReturnType<typeof createCorsairBotWrites>;

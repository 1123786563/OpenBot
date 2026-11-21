import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { type AppVariables, requireAdmin } from "../../auth/guards";
import type { Database } from "../../db/client";
import { createAuditStore, withAuditTransaction } from "../../audit";
import { githubPilotRepositories } from "../../db/schema";
import { VERSION_ARG } from "../composio";
import { issueArgs, messageArgs, supportedBrokerAction } from "./broker-action";

import {
  corsairApp as apps,
  createCorsairCutover,
  cutoverObservationMs,
  readUnknownWrites,
  writeReconciledEvent,
  legacyOperationVerifiedEvent,
  corsairWriteKey,
} from "./cutover";
import {
  cleanupCommand,
  legacyBroker,
  readLegacyCleanup,
  recordLegacyCleanup,
} from "./legacy-cleanup";
import { copyVerifiedPolicy, migrationRequest } from "./migration-policy";
import { githubPilotTool } from "./routes";
import { sharedSlackTool } from "./slack/shared-provider";
import { tool as slackPilotTool } from "./slack/write-access";

type App = z.infer<typeof apps>;
type Options = {
  database: Database;
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
  workspaceId: string;
  registrations: Partial<Record<App, string>>;
  includeDeploymentLegacy: boolean;
  canUseBot?: (actor: AppVariables["actor"], botId: string) => Promise<boolean>;
  sharedSlackRegistration?: string;
  slackChannels?: readonly string[];
};
const reference = z.string().trim().min(1).max(256);
const checks = [
  "identity",
  "resourceScope",
  "approval",
  "event",
  "revocation",
] as const;
const verification = z.strictObject({
  kind: z.literal("verified"),
  inventoryRevision: z.string().regex(/^[a-f0-9]{64}$/),
  checks: z.strictObject({
    identity: reference,
    resourceScope: reference,
    approval: reference,
    event: reference,
    revocation: reference,
  }),
  targetId: reference.optional(),
  addedPermissions: z.array(reference).max(100),
});
const disabled = z.strictObject({
  kind: z.literal("disabled"),
  inventoryRevision: verification.shape.inventoryRevision,
  reason: reference,
});
const decision = z.discriminatedUnion("kind", [verification, disabled]);
const decisionEvent = "corsair.migration_readiness_decided";

type Capability = {
  key: string;
  source:
    | "tool_config"
    | "audit"
    | "trigger_config"
    | "corsair_grant"
    | "account";
  detail: unknown;
  needs: "personal" | "shared" | "trigger";
};

const accountRow = z.object({
  id: z.string(),
  kind: z.enum(["github-personal", "slack-personal", "slack-shared"]),
  personId: z.string().nullable(),
  registration: z.string(),
  externalUserId: z.string().nullable(),
  subjectScope: z.string().nullable(),
  revision: z.string().nullable(),
  expiresAt: z.string().nullable(),
  verificationRequiredAt: z.string().nullable(),
  teamId: z.string().nullable(),
  botUserId: z.string().nullable(),
  channelIds: z.array(z.string()).nullable(),
  disconnected: z.boolean(),
});

export async function readCorsairReadiness(
  {
    database,
    workspaceId,
    registrations,
    includeDeploymentLegacy,
    sharedSlackRegistration,
    slackChannels,
  }: Omit<Options, "requireUser" | "database"> & {
    database: Pick<Database, "execute">;
  },
  app: App,
) {
  const registration = registrations[app] ?? null;
  const scope = JSON.stringify([workspaceId, app]);
  const legacyUrl = [`composio://${app}`, `arcade://${app}`];
  const [inventory, evidence, copiedPolicies] = await Promise.all([
    database.execute<Capability>(sql`
      with legacy_apps as (
        select id, account_mode from mcp_servers
        where ${includeDeploymentLegacy}
          and lower(url) in (${legacyUrl[0]}, ${legacyUrl[1]})
          and provenance in ('composio', 'arcade')
      ),
      inventory as (
        select 'tool:' || t.server_id || '/' || t.name as key, 'tool_config' as source,
          jsonb_build_object('ref', t.server_id || '/' || t.name, 'mode', a.account_mode,
            'policy', to_jsonb(t), 'botIds', coalesce((
              select jsonb_agg(g.agent_id order by g.agent_id) from plugin_grants g
              where g.kind = 'mcp' and g.ref = t.server_id || '/' || t.name
            ), '[]'::jsonb)) as detail,
          case when a.account_mode = 'shared' then 'shared' else 'personal' end as needs
        from mcp_tools t join legacy_apps a on a.id = t.server_id
        union all
        select distinct 'audit:' || e.target_id, 'audit', jsonb_build_object('ref', e.target_id),
          case when a.account_mode = 'shared' then 'shared' else 'personal' end
        from audit_events e
        left join legacy_apps a on a.id = split_part(e.target_id, '/', 1)
        where e.event_type in ('mcp.call_succeeded', 'mcp.call_failed', 'mcp.call_rejected')
          and (e.payload->>'workspaceId' = ${workspaceId}
            or (${includeDeploymentLegacy} and e.payload->>'workspaceId' is null))
          and (a.id is not null or (lower(e.payload->>'server') = ${app}
            and lower(e.payload->>'provider') in ('composio', 'arcade')))
          and e.target_id is not null
          and not exists (select 1 from mcp_tools t join legacy_apps l on l.id = t.server_id
            where t.server_id || '/' || t.name = e.target_id)
        union all
        select 'trigger:' || id, 'trigger_config',
          jsonb_build_object('ownerId', owner_user_id, 'goalId', responsibility_id,
            'resource', config->>'repository', 'teamId', config->>'teamId',
            'channels', config->'channels', 'revision', updated_at), 'trigger'
        from responsibility_triggers where ${includeDeploymentLegacy} and kind = ${app} and enabled
        union all
        select 'corsair-trigger:' || id, 'trigger_config',
          jsonb_build_object('goalId', goal_id, 'connectionId', connection_id,
            'connectionRevision', connection_revision, 'resource', repository_id,
            'installationId', installation_id, 'eventTypes', event_types, 'revision', updated_at), 'trigger'
        from corsair_entities where workspace_id = ${workspaceId} and registration = ${registration}
          and entity_type = ${`openbot.${app}.trigger`} and disabled_at is null
        union all
        select 'grant:' || agent_id || ':' || ref, 'corsair_grant',
          jsonb_build_object('botId', agent_id, 'ref', ref, 'revision', updated_at), 'personal'
        from plugin_grants where kind = ${`corsair.${app}`}
          and starts_with(ref, left(jsonb_build_array(${workspaceId}::text, ${registration}::text)::text, -1) || ', ')
          and not exists (select 1 from audit_events e
            where e.event_type = 'corsair.migration_policy_copied' and e.target_type = 'corsair_migration_policy'
              and e.payload->>'workspaceId' = ${workspaceId} and e.payload->>'app' = ${app}
              and e.payload->>'registration' = ${registration} and e.payload->>'botId' = agent_id
              and e.payload->'binding'->>'kind' = 'personal' and e.payload->>'targetTool' is not null
          )
        union all
        select 'shared-grant:' || g.bot_id || ':' || a.id, 'corsair_grant',
          jsonb_build_object('botId', g.bot_id, 'installationId', a.id, 'policy', g.approval), 'shared'
        from corsair_shared_access g join corsair_accounts a on a.id = g.installation_id
        where ${app} = 'slack' and a.shared_workspace_id = ${workspaceId} and g.granted
          and not exists (select 1 from audit_events e
            where e.event_type = 'corsair.migration_policy_copied' and e.target_type = 'corsair_migration_policy'
              and e.payload->>'workspaceId' = ${workspaceId} and e.payload->>'app' = 'slack'
              and e.payload->>'registration' = a.registration and e.payload->>'botId' = g.bot_id
              and e.payload->'binding'->>'installationId' = a.id
          )
        union all
        select 'legacy-account:' || provider || ':' || coalesce(user_id, ''), 'account',
          jsonb_build_object('personId', user_id, 'provider', provider, 'revision', updated_at,
            'vendorUserId', vendor_user_id, 'verified', verified),
          case when holder = 'deployment' then 'shared' else 'personal' end
        from brokered_connections b where ${includeDeploymentLegacy} and lower(btrim(app)) = ${app}
          and (holder = 'deployment' or not exists (select 1 from brokered_accounts a
            where a.app = b.app and a.provider = b.provider and a.user_id = b.user_id))
        union all
        select 'legacy-account:' || id, 'account',
          jsonb_build_object('personId', user_id, 'provider', provider, 'accountId', id,
            'default', is_default, 'vendorUserId', vendor_user_id, 'externalAccountId', account_id), 'personal'
        from brokered_accounts where ${includeDeploymentLegacy} and lower(btrim(app)) = ${app}
      )
      select key, source, detail, needs from inventory order by key, detail
    `),
    database.execute<{ payload: unknown; actor: string; key: string }>(sql`
      select distinct on (payload->>'capability') payload, actor_user_id as actor,
        payload->>'capability' as key
      from audit_events
      where event_type = ${decisionEvent} and target_type = 'corsair_migration_scope'
        and target_id = ${scope}
      order by payload->>'capability', created_at desc, id desc
    `),
    database.execute<{ tool: string; bot: string }>(sql`
      select e.payload->>'legacyTool' as tool, e.payload->>'botId' as bot
      from audit_events e
      where e.event_type = 'corsair.migration_policy_copied'
        and e.target_type = 'corsair_migration_policy'
        and e.payload->>'workspaceId' = ${workspaceId} and e.payload->>'app' = ${app}
        and (case e.payload->'binding'->>'kind' when 'personal' then exists (
          select 1 from plugin_grants g where g.agent_id = e.payload->>'botId'
            and g.kind = ${`corsair.${app}`}
            and e.payload->>'registration' = ${registration}
            and g.ref = jsonb_build_array(${workspaceId}::text, ${registration}::text, e.payload->>'targetTool')::text
        ) when 'shared' then exists (
          select 1 from corsair_shared_access g join corsair_accounts a on a.id = g.installation_id
          where g.bot_id = e.payload->>'botId' and g.granted and g.approval is not null
            and a.id = e.payload->'binding'->>'installationId' and a.shared_workspace_id = ${workspaceId}
            and a.registration = ${sharedSlackRegistration ?? null}
        ) else false end)
    `),
  ]);
  const [accounts, repositories, defaults] = await Promise.all([
    database.execute(sql`
      select id, openbot_kind as kind, person_id as "personId", registration, revision,
        external_user_id as "externalUserId", subject_scope as "subjectScope",
        expires_at::text as "expiresAt", verification_required_at::text as "verificationRequiredAt",
        team_id as "teamId", bot_user_id as "botUserId", channel_ids as "channelIds",
        config ? 'openbotRevocation' as disconnected
      from corsair_accounts
      where (workspace_id = ${workspaceId} and registration = ${registration}
        and openbot_kind = ${`${app}-personal`})
        or (${app} = 'slack' and shared_workspace_id = ${workspaceId} and openbot_kind = 'slack-shared' and registration = ${sharedSlackRegistration ?? null})
      order by id
    `),
    database.execute<{ entity_id: string }>(sql`
      select entity_id, installation_id, node_id from corsair_entities
      where workspace_id = ${workspaceId} and registration = ${registration}
        and entity_type = ${`openbot.${app}.repository`}
      order by entity_id
    `),
    database.execute(sql`
      select person_id, connection_id, github_user_id from corsair_account_defaults
      where workspace_id = ${workspaceId} and registration = ${registration}
        and openbot_kind = ${`${app}-personal`}
      order by person_id
    `),
  ]);
  const revision = createHash("sha256")
    .update(
      JSON.stringify({
        inventory,
        accounts: accounts.map(
          ({ expiresAt: _expiresAt, ...account }) => account,
        ),
        repositories,
        defaults,
        registration,
        slackChannels,
        sharedSlackRegistration,
      }),
    )
    .digest("hex");
  const connections = z
    .array(accountRow)
    .parse(accounts)
    .map((account) => ({
      ...account,
      status: account.disconnected
        ? "disconnected"
        : account.kind === "slack-shared"
          ? "enrolled"
          : account.verificationRequiredAt
            ? "verification_required"
            : !account.expiresAt || Date.parse(account.expiresAt) <= Date.now()
              ? "refresh_or_reauthorize"
              : "connected",
    }));
  const evidenceByKey = new Map(evidence.map((entry) => [entry.key, entry]));
  const capabilities = inventory.map(({ key, source, detail, needs }) => {
    const latest = evidenceByKey.get(key);
    const reviewed = z.object({ decision }).safeParse(latest?.payload);
    const current =
      reviewed.success && reviewed.data.decision.inventoryRevision === revision
        ? reviewed.data.decision
        : null;
    const person = z
      .union([
        z.object({ personId: z.string() }).transform((row) => row.personId),
        z.object({ ownerId: z.string() }).transform((row) => row.ownerId),
      ])
      .safeParse(detail);
    const required =
      needs === "shared"
        ? connections.filter((c) => c.kind === "slack-shared")
        : connections.filter(
            (c) =>
              c.kind === `${app}-personal` &&
              (!person.success || c.personId === person.data),
          );
    const triggerPin = z
      .object({
        connectionId: z.string(),
        connectionRevision: z.string(),
      })
      .safeParse(detail);
    const permissionDiff =
      current?.kind === "verified" ? current.addedPermissions : null;
    const blockers: string[] = [];
    const tool = z
      .object({ ref: z.string(), botIds: z.array(z.string()) })
      .safeParse(detail);
    const pendingBotIds = tool.success
      ? tool.data.botIds.filter(
          (botId) =>
            !copiedPolicies.some(
              (mapping) =>
                mapping.bot === botId && mapping.tool === tool.data.ref,
            ),
        )
      : [];
    if (current?.kind !== "disabled") {
      if (pendingBotIds.length) blockers.push("policy_migration_required");
      if (!current)
        blockers.push(reviewed.success ? "evidence_stale" : "evidence_missing");
      if (permissionDiff?.length)
        blockers.push("additional_permissions_required");
      if (needs !== "shared" && !registration)
        blockers.push("registration_missing");
      if (
        !required.some(
          (c) => c.status === "connected" || c.status === "enrolled",
        )
      )
        blockers.push(
          needs === "shared"
            ? "shared_installation_missing"
            : "reauthorization_required",
        );
      if (
        source === "account" &&
        !required.some(
          (c) =>
            c.id ===
              (current?.kind === "verified" ? current.targetId : undefined) &&
            (c.status === "connected" || c.status === "enrolled"),
        )
      )
        blockers.push("account_mapping_unverified");
      if (needs === "trigger" && app === "slack") {
        const source = z
          .object({ teamId: z.string(), channels: z.array(z.string()) })
          .safeParse(detail);
        const targetId =
          current?.kind === "verified" ? current.targetId : undefined;
        if (
          !source.success ||
          !required.some(
            (account) =>
              account.id === targetId &&
              account.status === "connected" &&
              account.subjectScope === source.data.teamId,
          ) ||
          !connections.some(
            (account) =>
              account.status === "enrolled" &&
              account.teamId === source.data.teamId &&
              account.channelIds?.length &&
              source.data.channels.every((channel) =>
                account.channelIds?.includes(channel),
              ),
          )
        )
          blockers.push("trigger_mapping_unverified");
      }
      if (needs === "trigger" && app === "github" && !triggerPin.success) {
        const replacement = inventory.find(
          (candidate) =>
            candidate.key ===
            `corsair-trigger:${current?.kind === "verified" ? current.targetId : ""}`,
        );
        const pin = z
          .object({ connectionId: z.string(), connectionRevision: z.string() })
          .safeParse(replacement?.detail);
        if (
          !pin.success ||
          !required.some(
            (c) =>
              c.id === pin.data.connectionId &&
              c.revision === pin.data.connectionRevision &&
              c.status === "connected",
          )
        )
          blockers.push("trigger_mapping_unverified");
      }
      if (
        triggerPin.success &&
        !required.some(
          (c) =>
            c.id === triggerPin.data.connectionId &&
            c.revision === triggerPin.data.connectionRevision &&
            c.status === "connected",
        )
      )
        blockers.push("trigger_connection_unavailable");
    }
    return {
      key,
      source,
      detail,
      needs,
      status:
        current?.kind === "disabled"
          ? "disabled"
          : blockers.length
            ? "blocked"
            : "ready",
      requiredConnectionIds: required.map((c) => c.id),
      checks: Object.fromEntries(
        checks.map((check) => [
          check,
          current?.kind === "verified"
            ? { status: "verified", evidenceRef: current.checks[check] }
            : { status: "unverified" },
        ]),
      ),
      permissionDiff,
      pendingBotIds,
      decision: current && { ...current, actor: latest?.actor },
      blockers,
    };
  });
  const blockers = capabilities.length ? [] : ["inventory_missing"];
  return {
    workspaceId,
    app,
    registration,
    inventoryRevision: revision,
    connections,
    repositories,
    defaults,
    capabilities,
    blockers,
    ready:
      capabilities.length > 0 &&
      capabilities.every((entry) => entry.blockers.length === 0),
  };
}

export function createCorsairReadinessRoutes(options: Options) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", options.requireUser, async (c, next) => {
    c.header("Cache-Control", "no-store");
    const denied = requireAdmin(c);
    if (denied) return denied;
    await next();
  });
  routes.on(["GET", "POST"], "/:app/legacy-cleanup/:provider", async (c) => {
    const app = apps.safeParse(c.req.param("app"));
    const provider = legacyBroker.safeParse(c.req.param("provider"));
    if (!options.includeDeploymentLegacy || !app.success || !provider.success)
      return c.json(
        { error: "Deployment legacy cleanup scope unavailable." },
        404,
      );
    const scope = {
      workspaceId: options.workspaceId,
      app: app.data,
      provider: provider.data,
    };
    if (c.req.method === "POST") {
      if (c.req.header("X-OpenBot-Pilot") !== app.data)
        return c.json({ error: "The pilot request header is required." }, 403);
      const parsed = cleanupCommand.safeParse(
        await c.req.json().catch(() => null),
      );
      if (!parsed.success)
        return c.json({ error: "Invalid cleanup evidence." }, 400);
      if (
        !(await recordLegacyCleanup(
          options.database,
          scope,
          c.var.actor.id,
          parsed.data,
        ))
      )
        return c.json(
          {
            error:
              "Cleanup evidence refused. Check observation, inventory, impact and credential dependencies.",
          },
          409,
        );
    }
    return c.json(await readLegacyCleanup(options.database, scope));
  });
  const transitionRequest = z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("activate"),
      inventoryRevision: verification.shape.inventoryRevision,
    }),
    z.strictObject({
      kind: z.literal("rollback"),
      inventoryRevision: verification.shape.inventoryRevision,
      evidence: z.strictObject({
        workspaceId: reference,
        app: apps,
        observationUntil: z.iso.datetime(),
        observedAt: z.iso.datetime(),
        authorizationsValid: z.literal(true),
        permissionsCurrent: z.literal(true),
        legacyAuthorizationRef: reference,
        currentPermissionsRef: reference,
        capabilities: z.array(z.string().min(1)),
      }),
    }),
    z.strictObject({
      kind: z.literal("begin_cleanup"),
      inventoryRevision: verification.shape.inventoryRevision,
      evidence: z.strictObject({
        workspaceId: reference,
        app: apps,
        observationUntil: z.iso.datetime(),
        observedAt: z.iso.datetime(),
        incidentsResolved: z.literal(true),
        evidenceRef: reference,
      }),
    }),
  ]);
  routes.get("/:app/cutover", async (c) => {
    const app = apps.safeParse(c.req.param("app"));
    if (!app.success)
      return c.json({ error: "Unknown Corsair pilot app." }, 404);
    return c.json(
      await createCorsairCutover(options.database, {
        workspaceId: options.workspaceId,
        app: app.data,
      }).read(),
    );
  });
  routes.post("/:app/cutover", async (c) => {
    const parsed = apps.safeParse(c.req.param("app"));
    if (!parsed.success)
      return c.json({ error: "Unknown Corsair pilot app." }, 404);
    const app = parsed.data;
    if (c.req.header("X-OpenBot-Pilot") !== app)
      return c.json({ error: "The pilot request header is required." }, 403);
    const request = transitionRequest.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!request.success)
      return c.json({ error: "Invalid route transition." }, 400);
    const change = request.data;
    const cutover = createCorsairCutover(options.database, {
      workspaceId: options.workspaceId,
      app,
    });
    const actorId = c.var.actor.id;
    const state =
      change.kind === "activate"
        ? await cutover.activate(actorId, async (tx) => {
            await tx.execute(sql`
            select id from corsair_accounts
            where (workspace_id = ${options.workspaceId} and openbot_kind = ${`${app}-personal`})
              or (${app} = 'slack' and shared_workspace_id = ${options.workspaceId} and openbot_kind = 'slack-shared')
            order by id for share
          `);
            const report = await readCorsairReadiness(
              { ...options, database: tx },
              app,
            );
            if (
              report.inventoryRevision !== change.inventoryRevision ||
              !report.ready ||
              !report.capabilities.some(({ status }) => status === "ready")
            )
              return null;
            const triggers = report.capabilities.filter(({ key }) =>
              key.startsWith("trigger:"),
            );
            for (const trigger of triggers) {
              if (trigger.status === "disabled") continue;
              if (trigger.status !== "ready") return null;
              const [handoff] = await tx.execute<{ found: boolean }>(sql`
              select exists (
                select 1 from corsair_events e
                cross join lateral jsonb_array_elements(e.payload->'triggerPairs') as mapping(pair)
                where e.workspace_id = ${options.workspaceId} and e.event_type = 'openbot.events.handoff'
                  and e.payload->>'provider' = ${app} and e.occurred_at <= clock_timestamp()
                  and mapping.pair->>'legacy' = ${trigger.key.slice("trigger:".length)}
                  and ( ${app} = 'slack' or mapping.pair->>'corsair' =
                    ${trigger.decision?.kind === "verified" ? (trigger.decision.targetId ?? null) : null} )
              ) as found
            `);
              if (!handoff?.found) return null;
            }
            return report.capabilities
              .filter(({ status }) => status === "disabled")
              .map(({ key }) => key);
          })
        : change.kind === "rollback"
          ? await cutover.rollback(
              actorId,
              {
                evidence: change.evidence,
                inventoryRevision: change.inventoryRevision,
              },
              async (tx, current) => {
                const evidence = change.evidence;
                const observed = Date.parse(evidence.observedAt);
                const now = Date.now();
                if (
                  !options.includeDeploymentLegacy ||
                  evidence.workspaceId !== options.workspaceId ||
                  evidence.app !== app ||
                  evidence.observationUntil !== current.until ||
                  observed < Date.parse(current.until) - cutoverObservationMs ||
                  observed < now - 5 * 60 * 1000 ||
                  observed > now
                )
                  return false;
                const [accounts] = await tx.execute<{ verified: boolean }>(sql`
              with connections as (
                select provider, user_id, verified
                from brokered_connections
                where lower(btrim(app)) = ${app}
                for share
              ), accounts as (
                select provider, user_id
                from brokered_accounts
                where lower(btrim(app)) = ${app}
                for share
              )
              select exists (select 1 from connections)
                and not exists (select 1 from connections where not verified)
                and not exists (
                  select 1 from accounts a where not exists (
                    select 1 from connections c
                    where c.provider = a.provider and c.user_id = a.user_id and c.verified
                  )
                ) as verified
            `);
                if (!accounts?.verified) return false;
                const report = await readCorsairReadiness(
                  { ...options, database: tx },
                  app,
                );
                const required = [
                  ...new Set(
                    report.capabilities
                      .filter(({ key }) =>
                        /^(legacy-account|tool|audit):/.test(key),
                      )
                      .map(({ key }) => key),
                  ),
                ].sort();
                const attested = [...evidence.capabilities].sort();
                return (
                  report.inventoryRevision === change.inventoryRevision &&
                  required.some((key) => key.startsWith("legacy-account:")) &&
                  required.length === evidence.capabilities.length &&
                  required.every((key, index) => key === attested[index])
                );
              },
            )
          : await cutover.beginCleanup(
              actorId,
              {
                evidence: change.evidence,
                inventoryRevision: change.inventoryRevision,
              },
              async (tx, current) => {
                const { evidence } = change;
                const observedAt = Date.parse(evidence.observedAt);
                if (
                  !options.includeDeploymentLegacy ||
                  evidence.workspaceId !== options.workspaceId ||
                  evidence.app !== app ||
                  evidence.observationUntil !== current.until ||
                  observedAt < Date.parse(current.until) ||
                  observedAt > Date.now()
                )
                  return false;
                const report = await readCorsairReadiness(
                  { ...options, database: tx },
                  app,
                );
                return (
                  report.ready &&
                  report.inventoryRevision === change.inventoryRevision
                );
              },
            );
    return state
      ? c.json(state)
      : c.json(
          {
            error:
              "Route transition refused. Check readiness, event handoff, legacy evidence, or in-flight calls.",
          },
          409,
        );
  });
  const outcomeReview = z.strictObject({
    outcome: z.enum(["applied", "not_applied"]),
    evidenceRef: reference,
  });
  routes.get("/:app/unknown-writes", async (c) => {
    const app = apps.safeParse(c.req.param("app"));
    if (!app.success)
      return c.json({ error: "Unknown Corsair pilot app." }, 404);
    const approval = z.uuid().optional().safeParse(c.req.query("approvalId"));
    if (!approval.success)
      return c.json({ error: "Invalid Approval ID." }, 400);
    return c.json(
      await readUnknownWrites(
        options.database,
        { workspaceId: options.workspaceId, app: app.data },
        { approvalId: approval.data },
      ),
    );
  });
  routes.put("/:app/unknown-writes/:approvalId", async (c) => {
    const parsed = apps.safeParse(c.req.param("app"));
    if (!parsed.success)
      return c.json({ error: "Unknown Corsair pilot app." }, 404);
    const app = parsed.data;
    if (c.req.header("X-OpenBot-Pilot") !== app)
      return c.json({ error: "The pilot request header is required." }, 403);
    const approval = z.uuid().safeParse(c.req.param("approvalId"));
    const review = outcomeReview.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!approval.success || !review.success)
      return c.json({ error: "Invalid write reconciliation evidence." }, 400);
    const actorId = c.var.actor.id;
    const cutover = createCorsairCutover(options.database, {
      workspaceId: options.workspaceId,
      app,
    });
    const reviewed = await cutover.review(
      actorId,
      async (tx, _state, audit) => {
        const [write] = await readUnknownWrites(
          tx,
          { workspaceId: options.workspaceId, app },
          { approvalId: approval.data },
        );
        if (!write?.canReconcile) return false;
        await audit.insert({
          eventType: writeReconciledEvent,
          targetType: "corsair_migration_scope",
          targetId: JSON.stringify([options.workspaceId, app]),
          actorUserId: actorId,
          payload: {
            approvalId: write.approvalId,
            writeAttemptId: write.attemptId,
            ...review.data,
          },
        });
        return true;
      },
    );
    return reviewed
      ? c.body(null, 204)
      : c.json({ error: "Write is unavailable for reconciliation." }, 409);
  });
  routes.put("/:app/unknown-writes/:approvalId/operation", async (c) => {
    const parsed = apps.safeParse(c.req.param("app"));
    if (!parsed.success)
      return c.json({ error: "Unknown Corsair pilot app." }, 404);
    const app = parsed.data;
    if (c.req.header("X-OpenBot-Pilot") !== app)
      return c.json({ error: "The pilot request header is required." }, 403);
    const attemptId = z.uuid().safeParse(c.req.param("approvalId"));
    const operation = z
      .strictObject({
        providerSubject:
          app === "github"
            ? z.string().regex(/^[1-9]\d*$/)
            : z.string().regex(/^[UW][A-Z0-9]+$/),
        resourceId:
          app === "github"
            ? z.string().regex(/^[1-9]\d*$/)
            : z.string().regex(/^[CG][A-Z0-9]+$/),
        brokerArgs: z.record(z.string(), z.unknown()),
        evidenceRef: reference,
      })
      .safeParse(await c.req.json().catch(() => null));
    if (!attemptId.success || !operation.success)
      return c.json({ error: "Invalid operation equivalence evidence." }, 400);
    const scopeKey = JSON.stringify([options.workspaceId, app]);
    const cutover = createCorsairCutover(options.database, {
      workspaceId: options.workspaceId,
      app,
    });
    const verified = await cutover.review(
      c.var.actor.id,
      async (tx, _state, audit) => {
        const [attempt] = await tx.execute<{
          actor: string;
          vendorUserId: string;
          argumentDigest: string;
          ref: string;
          vendorAction: string | null;
        }>(sql`
        select s.actor_user_id as actor, s.target_id as ref,
          s.payload->>'vendorUserId' as "vendorUserId",
          s.payload->>'argumentDigest' as "argumentDigest",
          s.payload->>'vendorAction' as "vendorAction"
        from audit_events s
        where s.event_type = ${`corsair.${app}.write_started`}
          and s.payload->>'route' = 'legacy'
          and s.payload->>'workspaceId' = ${options.workspaceId}
          and coalesce(s.payload->>'writeAttemptId', s.payload->>'approvalId') = ${attemptId.data}
          and exists (
            select 1 from audit_events r
            where r.event_type = ${writeReconciledEvent} and r.target_id = ${scopeKey}
              and coalesce(r.payload->>'writeAttemptId', r.payload->>'approvalId') = ${attemptId.data}
              and r.payload->>'outcome' = 'applied'
          )
          and not exists (
            select 1 from audit_events v
            where v.event_type = ${legacyOperationVerifiedEvent} and v.target_id = ${scopeKey}
              and coalesce(v.payload->>'writeAttemptId', v.payload->>'approvalId') = ${attemptId.data}
          )
      `);
        const { providerSubject, resourceId, brokerArgs, evidenceRef } =
          operation.data;
        if (
          !attempt?.actor ||
          !supportedBrokerAction(
            app,
            attempt.vendorAction ?? attempt.ref.split("/").slice(1).join("/"),
          ) ||
          corsairWriteKey(
            attempt.actor,
            attempt.vendorUserId,
            attempt.ref,
            brokerArgs,
          ) !== attempt.argumentDigest
        )
          return false;
        const { [VERSION_ARG]: _version, ...sourceArgs } = brokerArgs;
        let args: { title: string; body?: string } | { text: string };
        if (app === "github") {
          const issue = issueArgs.safeParse(sourceArgs);
          if (!issue.success) return false;
          const [repo] = await tx.execute<{ valid: boolean }>(sql`
          select exists (
            select 1 from ${githubPilotRepositories}
            where workspace_id = ${options.workspaceId} and registration = ${options.registrations.github ?? null}
              and repository_id = ${resourceId}
              and lower(name) = lower(${`${issue.data.owner}/${issue.data.repo}`})
          ) as valid
        `);
          if (!repo?.valid) return false;
          const { title, body } = issue.data;
          args = { title, ...(body === undefined ? {} : { body }) };
        } else {
          const message = messageArgs.safeParse(sourceArgs);
          if (!message.success || message.data.channel !== resourceId)
            return false;
          args = { text: message.data.text };
        }
        await audit.insert({
          eventType: legacyOperationVerifiedEvent,
          targetType: "corsair_migration_scope",
          targetId: scopeKey,
          actorUserId: c.var.actor.id,
          payload: {
            writeAttemptId: attemptId.data,
            evidenceRef,
            writeKey: corsairWriteKey(
              attempt.actor,
              providerSubject,
              resourceId,
              args,
            ),
          },
        });
        return true;
      },
    );
    return verified
      ? c.body(null, 204)
      : c.json(
          {
            error:
              "An applied broker attempt awaiting operation evidence is required.",
          },
          409,
        );
  });
  routes.get("/:app", async (c) => {
    const app = apps.safeParse(c.req.param("app"));
    if (!app.success)
      return c.json({ error: "Unknown Corsair pilot app." }, 404);
    return c.json(await readCorsairReadiness(options, app.data));
  });
  routes.post("/:app/decisions", async (c) => {
    const app = apps.safeParse(c.req.param("app"));
    if (!app.success)
      return c.json({ error: "Unknown Corsair pilot app." }, 404);
    const body = z
      .strictObject({ capability: reference, decision })
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success)
      return c.json({ error: "Invalid readiness decision." }, 400);
    const actorId = c.var.actor.id;
    const cutover = createCorsairCutover(options.database, {
      workspaceId: options.workspaceId,
      app: app.data,
    });
    const result = await cutover.review(actorId, async (tx, _state, audit) => {
      const report = await readCorsairReadiness(
        { ...options, database: tx },
        app.data,
      );
      if (
        report.inventoryRevision !== body.data.decision.inventoryRevision ||
        !report.capabilities.some(({ key }) => key === body.data.capability)
      )
        return false;
      await audit.insert({
        eventType: decisionEvent,
        targetType: "corsair_migration_scope",
        targetId: JSON.stringify([options.workspaceId, app.data]),
        actorUserId: actorId,
        payload: body.data,
      });
      return true;
    });
    return result
      ? c.body(null, 204)
      : c.json(
          { error: "Reload the capability inventory before deciding." },
          409,
        );
  });
  routes.post("/:app/policies", async (c) => {
    const app = apps.safeParse(c.req.param("app"));
    if (!app.success)
      return c.json({ error: "Unknown Corsair pilot app." }, 404);
    const body = migrationRequest.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!body.success)
      return c.json({ error: "Verified policy mapping is required." }, 400);
    const review = body.data;
    const selectedApp = app.data;
    return withAuditTransaction(
      options.database,
      async (tx, deferTap) => {
        const report = await readCorsairReadiness(
          { ...options, database: tx },
          selectedApp,
        );
        const capability = report.capabilities.find(
          (entry) => entry.key === `tool:${review.legacyTool}`,
        );
        if (
          (options.canUseBot &&
            !(await options.canUseBot(c.var.actor, review.botId))) ||
          !options.includeDeploymentLegacy ||
          review.inventoryRevision !== report.inventoryRevision ||
          !capability ||
          capability.status === "disabled" ||
          capability.blockers.some(
            (blocker) => blocker !== "policy_migration_required",
          ) ||
          capability.needs !== review.binding.kind
        )
          return c.json(
            {
              error:
                "The source action and target must have current readiness evidence.",
            },
            409,
          );
        const binding = review.binding;
        const shared = binding.kind === "shared";
        const registration = shared
          ? options.sharedSlackRegistration
          : report.registration;
        const eligible = report.connections.filter(
          (account) => account.status === (shared ? "enrolled" : "connected"),
        );
        const verifiedAccounts = new Set(
          report.capabilities.flatMap((entry) =>
            entry.source === "account" &&
            entry.status === "ready" &&
            entry.decision?.kind === "verified"
              ? [entry.decision.targetId]
              : [],
          ),
        );
        const allowedResources = shared
          ? (eligible.find((account) => account.id === binding.installationId)
              ?.channelIds ?? [])
          : app.data === "github"
            ? report.repositories.map((repository) => repository.entity_id)
            : (options.slackChannels ?? []);
        if (
          !registration ||
          (binding.kind === "shared" &&
            !verifiedAccounts.has(binding.installationId)) ||
          (shared && app.data !== "slack") ||
          (binding.kind === "personal" &&
            binding.connections.some(
              (id) =>
                !verifiedAccounts.has(id) ||
                !eligible.some(
                  (account) =>
                    account.kind === `${app.data}-personal` &&
                    account.id === id,
                ),
            )) ||
          review.resources.some(
            (resource) => !allowedResources.includes(resource),
          )
        )
          return c.json(
            {
              error:
                "The reviewed identity or resource is unavailable in this scope.",
            },
            409,
          );
        const targetTool = shared
          ? sharedSlackTool.ref
          : app.data === "github"
            ? githubPilotTool.ref
            : slackPilotTool.ref;
        const copied = await copyVerifiedPolicy(
          tx,
          createAuditStore(tx, deferTap),
          {
            app: app.data,
            workspaceId: options.workspaceId,
            registration,
            adminId: c.var.actor.id,
            targetTool,
            review,
          },
        );
        if (!copied)
          return c.json(
            {
              error:
                "The source grant is unavailable or the destination already has a policy decision.",
            },
            409,
          );
        return c.body(null, 204);
      },
      { isolationLevel: "repeatable read" },
    );
  });
  return routes;
}

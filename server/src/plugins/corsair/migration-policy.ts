import { sql } from "drizzle-orm";
import { z } from "zod";
import type { AuditInitiator } from "../../audit";
import { globMatches } from "../../approvals/policy";
import { type ActionPolicy, evaluateActionPolicy } from "../../computer/policy";
import type { Database } from "../../db/client";
import { auditEvents } from "../../db/schema";
import { appCallPolicyContext } from "../plugin-store/call-policy";
import { corsairGrantRef } from "./grants";

const reference = z.string().trim().min(1).max(256);
const bindings = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("personal"),
    connections: z.array(z.uuid()).min(1).max(100),
  }),
  z.strictObject({ kind: z.literal("shared"), installationId: z.uuid() }),
]);
export const migrationRequest = z.strictObject({
  legacyTool: reference,
  botId: reference,
  inventoryRevision: z.string().regex(/^[a-f0-9]{64}$/),
  binding: bindings,
  resources: z.array(reference).min(1).max(100),
  evidence: z.strictObject({
    equivalentAppAndAction: reference,
    identityAndResources: reference,
    preservedRestrictions: reference,
    sharedAudienceAndOutsideInput: reference.optional(),
  }),
});
type Request = z.infer<typeof migrationRequest>;
type App = "github" | "slack";
type Executor = Pick<Database, "execute">;
const migrationRecord = migrationRequest.extend({
  sourceTool: z.string(),
  workspaceId: z.string(),
  app: z.enum(["github", "slack"]),
  registration: z.string(),
  targetTool: z.string(),
});
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
const migratedEvent = "corsair.migration_policy_copied";

function migrationKey(
  workspaceId: string,
  app: App,
  registration: string,
  botId: string,
  kind: "personal" | "shared",
) {
  return JSON.stringify([workspaceId, app, registration, botId, kind]);
}

export async function migratedPolicyAllows(
  db: Executor,
  input: {
    workspaceId: string;
    app: App;
    registration: string;
    botId: string;
    kind: "personal" | "shared";
    connectionId: string;
    resource: string;
    actorId: string;
    unknownInitiator?: boolean;
    initiator?: AuditInitiator;
    legacyPolicy?: () => ActionPolicy;
  },
) {
  const key = migrationKey(
    input.workspaceId,
    input.app,
    input.registration,
    input.botId,
    input.kind,
  );
  const [record] = await db.execute<{ payload: unknown }>(sql`
    select payload from audit_events where event_type = ${migratedEvent}
      and target_type = 'corsair_migration_policy' and target_id = ${key}
  `);
  if (!record) return true;
  const review = migrationRecord.safeParse(record.payload);
  if (!review.success) return false;
  const { legacyTool, binding, resources } = review.data;
  if (
    input.unknownInitiator ||
    !resources.includes(input.resource) ||
    binding.kind !== input.kind
  )
    return false;
  if (
    binding.kind === "personal"
      ? !binding.connections.includes(input.connectionId)
      : binding.installationId !== input.connectionId
  )
    return false;

  const [source] = await db.execute<{ allowed: boolean }>(sql`
    select exists (
      select 1 from plugin_grants g join mcp_tools t on t.server_id || '/' || t.name = g.ref
      where g.kind = 'mcp' and g.agent_id = ${input.botId}
        and g.ref = ${legacyTool} and g.granted_as is distinct from 'owner'
        and to_jsonb(t)::text = ${review.data.sourceTool}
    ) as allowed
  `);
  if (!source?.allowed) return false;
  if (binding.kind === "shared") {
    const [shared] = await db.execute<{ same: boolean }>(sql`
      select exists (
        select 1 from shared_use_approvals s join corsair_shared_access d
          on d.bot_id = s.agent_id and d.installation_id = ${binding.installationId}
        where s.agent_id = ${input.botId} and s.server_id = split_part(${legacyTool}, '/', 1)
          and s.approved_as is distinct from 'owner' and d.granted
          and d.approval = jsonb_build_object('audience', s.audience,
            'outsideInput', s.outside_input, 'members', coalesce((
              select jsonb_agg(jsonb_build_object('kind', m.kind, 'value', m.value) order by m.kind, m.value)
              from shared_use_approval_members m where m.agent_id = s.agent_id and m.server_id = s.server_id
            ), '[]'::jsonb))
      ) as same
    `);
    if (!shared?.same) return false;
  }

  const [policies, restrictive, declines, settings] = await Promise.all([
    db.execute<{ mode: string; deny: string[]; allow: string[] }>(
      sql`select mode, deny, allow from action_policy where id = 'current'`,
    ),
    db.execute<{ botId: string; toolRef: string; effect: string }>(sql`
      select bot_id as "botId", tool_ref as "toolRef", effect from approval_team_rules
      where revoked_at is null and behaviour = 'hand_off'
      union all
      select bot_id, tool_ref, effect from approval_rules
      where revoked_at is null and behaviour = 'hand_off' and owner_user_id = ${input.actorId}
    `),
    db.execute(sql`
      select 1 from approval_requests
      where owner_user_id = ${input.actorId} and decision in ('deny', 'handled')
        and action->>'toolRef' = ${legacyTool} and action->>'botId' = ${input.botId}
      limit 1
    `),
    db.execute(sql`
      select 1 from approval_team_settings where id = 'team'
        and (enforce_auto_review or exists (select 1 from jsonb_each_text(action_kinds) where value = 'hand_off'))
      union all select 1 from approval_preferences
      where owner_user_id = ${input.actorId} and enabled and auto_review
    `),
  ]);
  if (
    settings.length ||
    declines.length ||
    restrictive.some(
      (rule) =>
        globMatches(rule.botId, input.botId) &&
        globMatches(rule.toolRef, legacyTool) &&
        globMatches(rule.effect, "write"),
    )
  )
    return false;
  const persisted = z
    .object({
      mode: z.enum(["enforce", "dry-run"]),
      deny: z.array(z.string()),
      allow: z.array(z.string()),
    })
    .safeParse(policies[0]);
  if (policies.length && !persisted.success) return false;
  const policy = persisted.data ?? input.legacyPolicy?.();
  return evaluateActionPolicy(
    policy && { ...policy, mode: "enforce" },
    appCallPolicyContext({
      ref: legacyTool,
      botId: input.botId,
      actorId: input.actorId,
      effect: "write",
      initiator: input.initiator,
    }),
  ).forward;
}

export async function copyVerifiedPolicy(
  tx: Transaction,
  input: {
    app: App;
    workspaceId: string;
    registration: string;
    adminId: string;
    targetTool: string;
    review: Request;
  },
) {
  const { app, workspaceId, registration, adminId, targetTool, review } = input;
  const key = migrationKey(
    workspaceId,
    app,
    registration,
    review.botId,
    review.binding.kind,
  );
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`,
  );
  const [source] = await tx.execute<{ id: string; tool: string }>(sql`
      select s.id, to_jsonb(t)::text as tool from mcp_servers s join mcp_tools t on t.server_id = s.id
      join plugin_grants g on g.ref = s.id || '/' || t.name and g.kind = 'mcp'
      where g.ref = ${review.legacyTool} and g.agent_id = ${review.botId}
        and g.granted_as is distinct from 'owner'
        and lower(s.url) in (${`composio://${app}`}, ${`arcade://${app}`})
        and s.provenance in ('composio', 'arcade') and s.account_mode = ${review.binding.kind}
        and t.effect = 'write' and not t.destructive and not t.unclassified
      for share of s, t, g
    `);
  if (!source) return false;
  const previous = await tx.execute(sql`
      select 1 from audit_events where event_type = ${migratedEvent}
        and target_type = 'corsair_migration_policy' and target_id = ${key}
    `);
  if (previous.length) return false;
  let inserted: unknown[];
  if (review.binding.kind === "shared") {
    if (app !== "slack" || !review.evidence.sharedAudienceAndOutsideInput)
      return false;
    inserted = await tx.execute(sql`
        insert into corsair_shared_access (installation_id, bot_id, granted, approval)
        select a.id, s.agent_id, true, jsonb_build_object('audience', s.audience,
          'outsideInput', s.outside_input, 'members', coalesce((
            select jsonb_agg(jsonb_build_object('kind', m.kind, 'value', m.value) order by m.kind, m.value)
            from shared_use_approval_members m where m.agent_id = s.agent_id and m.server_id = s.server_id
          ), '[]'::jsonb))
        from shared_use_approvals s join corsair_accounts a
          on a.id = ${review.binding.installationId} and a.shared_workspace_id = ${workspaceId}
          and a.openbot_kind = 'slack-shared' and a.registration = ${registration}
        where s.agent_id = ${review.botId} and s.server_id = ${source.id}
          and s.approved_as is distinct from 'owner'
          and (s.audience = 'people') = exists (
            select 1 from shared_use_approval_members m
            where m.agent_id = s.agent_id and m.server_id = s.server_id
          )
          and exists (select 1 from brokered_connections b
            where b.holder = 'deployment' and b.verified and lower(b.app) = ${app}
              and b.provider = split_part((select url from mcp_servers where id = s.server_id), ':', 1))
        on conflict do nothing returning bot_id
      `);
  } else {
    const revoked = await tx.execute(sql`
        select 1 from audit_events
        where event_type = ${`corsair.${app}.grant_changed`} and target_id = ${review.botId}
          and payload->>'workspaceId' = ${workspaceId} and payload->>'tool' = ${targetTool}
          and payload->>'enabled' = 'false' limit 1
      `);
    if (revoked.length) return false;
    inserted = await tx.execute(sql`
        insert into plugin_grants (kind, ref, agent_id, granted_by, granted_as)
        values (${`corsair.${app}`}, ${corsairGrantRef(workspaceId, registration, targetTool)},
          ${review.botId}, ${adminId}, 'admin')
        on conflict do nothing returning agent_id
      `);
  }
  if (!inserted.length) return false;
  await tx.insert(auditEvents).values({
    eventType: migratedEvent,
    targetType: "corsair_migration_policy",
    targetId: key,
    actorUserId: adminId,
    payload: {
      ...review,
      sourceTool: source.tool,
      workspaceId,
      app,
      registration,
      targetTool,
    },
  });
  return true;
}

import { testDatabaseUrl } from "../tests/support/database";

/*
 * OFFLINE provisioning for the enterprise runtime candidate, per the runs
 * role contract (server/drizzle/0060: releases, routes/grants and budget
 * accounts belong to ob_ent_run_operator — the run writer can only reference
 * them). This is the runbook the e2e and a real deployment both start from:
 * identity rows (tenant/principal/membership/workspace), the expert release
 * and its start grant, the model route + grant, and the budget account.
 *
 * Idempotent by fixed ids. The URL comes from TEST_DATABASE_URL through the
 * same validator as every other test-side entry (never the developer's
 * application database).
 */

const url = testDatabaseUrl();

/*
 * T02.13's static writer list disposes this seed at M4: "the ba branch does
 * not seed the directory independently" — once the directory write authority
 * is BA, the identity/membership rows this runbook inserts would bypass the
 * command model (no envelope, no receipt, no clocks). Refuse before the first
 * insert in that state; a database with no authority row yet (a fresh island
 * the runbook is seeding for the first time) keeps the offline behavior.
 */
async function assertNotBaAuthority(sql: import("bun").SQL): Promise<void> {
  const rows =
    (await sql`SELECT directory_authority FROM auth_authority_states LIMIT 1`) as unknown as {
      rows?: { directory_authority?: string }[];
    };
  const authority = (Array.isArray(rows) ? rows : (rows.rows ?? []))[0]
    ?.directory_authority;
  if (authority === "ba") {
    throw new Error(
      "ENTERPRISE_RUNTIME_SEED_BA_AUTHORITY: the directory write authority is ba (M4+); the startup seed must be translated into directory commands or retired before it can write the identity/membership rows — see the T02.13 static writer list's disposal phase for this file",
    );
  }
}

const SEED = {
  tenant: "e2e-runtime-tenant",
  user: "e2e-runtime-user",
  principal: "e2e-runtime-principal",
  workspace: "e2e-runtime-workspace",
  resource: "e2e-runtime-resource",
  release: "e2e-runtime-release",
  route: "e2e-runtime-route",
  alias: "e2e-model-alias",
  account: "e2e-runtime-account",
  modelRouteRef: "e2e-model-route-ref",
  expertVersion: "assistant-v1",
  currency: "USD",
  limitMicros: "10000000",
} as const;

const sql = new Bun.SQL(url, { max: 1 });

try {
  await assertNotBaAuthority(sql);
  await sql.begin(async (tx) => {
    await tx`insert into enterprise_tenants (id, name) values (${SEED.tenant}, 'E2E Runtime Tenant')
             on conflict (id) do nothing`;
    await tx`insert into users (id, name, email, email_verified, created_at, updated_at)
             values (${SEED.user}, 'E2E Runtime', 'e2e-runtime@example.test', false, now(), now())
             on conflict (id) do nothing`;
    await tx`insert into enterprise_principals (id, user_id, status)
             values (${SEED.principal}, ${SEED.user}, 'active')
             on conflict (id) do nothing`;
    await tx`insert into enterprise_memberships (tenant_id, principal_id, role, status, epoch)
             values (${SEED.tenant}, ${SEED.principal}, 'member', 'active', 1)
             on conflict (tenant_id, principal_id) do nothing`;
    await tx`insert into enterprise_workspaces (tenant_id, id, name)
             values (${SEED.tenant}, ${SEED.workspace}, 'E2E Runtime Workspace')
             on conflict (tenant_id, id) do nothing`;
    await tx`insert into enterprise_resources (tenant_id, id, workspace_id, kind, status)
             values (${SEED.tenant}, ${SEED.resource}, ${SEED.workspace}, 'expert', 'active')
             on conflict (tenant_id, id) do nothing`;
    await tx`insert into enterprise_run_releases (tenant_id, id, resource_id, version_digest,
                 runtime_compatibility, expert_version, model_route_ref, input_limit_bytes,
                 max_model_calls, max_run_micros, currency, tool_manifest_digest, tool_count)
               values (${SEED.tenant}, ${SEED.release}, ${SEED.resource}, ${"e2e-release-digest"},
                 ${"go-candidate-1"}, ${SEED.expertVersion}, ${SEED.modelRouteRef}, 32768, 4, 1000000,
                 ${SEED.currency}, ${"e2e-manifest-digest"}, 1)
               on conflict (tenant_id, id) do nothing`;
    await tx`insert into enterprise_run_grants (tenant_id, release_id, principal_id, action, revision)
             values (${SEED.tenant}, ${SEED.release}, ${SEED.principal}, 'start', 1)
             on conflict (tenant_id, release_id, principal_id, action) do nothing`;
    await tx`insert into enterprise_model_routes (tenant_id, id, alias, revision, resource_id,
                 target_ref, price_revision, currency, input_unit_micros, output_unit_micros,
                 per_request_micros, max_input_tokens, max_output_tokens, max_request_bytes,
                 protocol_profile, usage_profile)
               values (${SEED.tenant}, ${SEED.route}, ${SEED.alias}, 1, ${SEED.resource},
                 ${"glm-upstream"}, 1, ${SEED.currency}, 1000, 2000, 0, 8192, 4096, 65536,
                 ${"openai-chat"}, ${"standard"})
               on conflict (tenant_id, id) do nothing`;
    await tx`insert into enterprise_model_grants (tenant_id, route_id, principal_id, revision, status)
             values (${SEED.tenant}, ${SEED.route}, ${SEED.principal}, 1, 'active')
             on conflict (tenant_id, route_id, principal_id) do nothing`;
    await tx`insert into enterprise_budget_accounts (tenant_id, id, scope_kind, scope_ref, period_id,
                 starts_at, ends_at, currency, limit_micros, revision)
               values (${SEED.tenant}, ${SEED.account}, ${"workspace"}, ${SEED.workspace},
                 ${"e2e-period"}, now(), now() + (30 * interval '1 day'), ${SEED.currency},
                 ${SEED.limitMicros}, 0)
               on conflict (tenant_id, id) do nothing`;
  });
  console.log(
    `seeded enterprise runtime fixtures for tenant ${SEED.tenant} (release ${SEED.release}, route ${SEED.route}, account ${SEED.account})`,
  );
} finally {
  await sql.close();
}

export { SEED };

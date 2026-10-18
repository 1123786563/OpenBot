# MT002 verification environment

Dedicated ephemeral PostgreSQL container `openbot-issue6-tenancy-test-pg`
(loopback 127.0.0.1:55432, database `openbot_enterprise_issue6_test`). Never the
development DATABASE_URL. The database started empty; schema + capability roles
were bootstrapped once with the existing tooling:

    cd server
    export TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55432/openbot_enterprise_issue6_test
    export ENTERPRISE_TEST_DIRECTORY_DATABASE_URL=postgres://ent_mt002_directory:${ENT_MT002_DIRECTORY_PASSWORD}@127.0.0.1:55432/openbot_enterprise_issue6_test
    export ENTERPRISE_TEST_DATA_DATABASE_URL=postgres://ent_mt002_data:${ENT_MT002_DATA_PASSWORD}@127.0.0.1:55432/openbot_enterprise_issue6_test
    export ENTERPRISE_TEST_OPERATOR_DATABASE_URL=postgres://ent_mt002_operator:${ENT_MT002_OPERATOR_PASSWORD}@127.0.0.1:55432/openbot_enterprise_issue6_test
    bun scripts/enterprise-test-db.ts migrate
    # -> {"type":"migrations-applied","status":"ok"}  (roles.sql bootstrap + drizzle 0000..0121 + ent* login provisioning)

The three `ent_mt002_*` LOGIN roles each hold exactly one NOLOGIN capability
(ob_ent_directory / ob_ent_data / ob_ent_operator); passwords are ephemeral
container-local test credentials only; literal values were redacted from this artifact on 2026-10-15 (repair task_a67106001ae6). Re-supply fresh passwords via the `${ENT_MT002_*_PASSWORD}` variables above (re-provision with `bun scripts/enterprise-test-db.ts provision` if the ephemeral container no longer exists).

Verification command (run at the worktree root):

    source <env above> && bun test server/tests/multitenancy/fixtures.test.ts

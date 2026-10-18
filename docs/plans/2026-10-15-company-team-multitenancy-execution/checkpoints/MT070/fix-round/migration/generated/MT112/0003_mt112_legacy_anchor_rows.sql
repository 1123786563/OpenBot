-- multitenancy migrate-test
INSERT INTO "enterprise_tenants" ("id", "name") VALUES ('ent-legacy-original', '原有公司') ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
INSERT INTO "enterprise_workspaces" ("tenant_id", "id", "name") VALUES ('ent-legacy-original', 'ent-legacy-default-team', '默认团队') ON CONFLICT ("tenant_id", "id") DO NOTHING;
--> statement-breakpoint
INSERT INTO "enterprise_principals" ("id", "user_id")
	SELECT 'entp-legacy-anchor-' || anchor_user."id", anchor_user."id"
	FROM (SELECT "id" FROM "users" ORDER BY "created_at" ASC, "id" ASC LIMIT 1) AS anchor_user
	ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
INSERT INTO "enterprise_memberships" ("tenant_id", "principal_id", "role")
	SELECT 'ent-legacy-original', "enterprise_principals"."id", 'tenant_admin'
	FROM "enterprise_principals"
	WHERE "enterprise_principals"."id" = 'entp-legacy-anchor-' || (SELECT "id" FROM "users" ORDER BY "created_at" ASC, "id" ASC LIMIT 1)
	ON CONFLICT ("tenant_id", "principal_id") DO NOTHING;
--> statement-breakpoint
INSERT INTO "enterprise_workspace_memberships" ("tenant_id", "workspace_id", "principal_id")
	SELECT 'ent-legacy-original', 'ent-legacy-default-team', "enterprise_principals"."id"
	FROM "enterprise_principals"
	WHERE "enterprise_principals"."id" = 'entp-legacy-anchor-' || (SELECT "id" FROM "users" ORDER BY "created_at" ASC, "id" ASC LIMIT 1)
	ON CONFLICT ("tenant_id", "workspace_id", "principal_id") DO NOTHING;

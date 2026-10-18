-- multitenancy migrate-test
INSERT INTO "openmuse_task_scopes" ("task_id", "tenant_id", "workspace_id", "principal_id", "user_id", "bot_id", "attribution")
SELECT t."id", unique_membership."tenant_id", unique_membership."workspace_id", p."id", p."user_id", t."bot_id", 'backfill'
FROM "openmuse_tasks" t
JOIN "enterprise_principals" p ON p."user_id" = t."owner_user_id"
JOIN (
	SELECT wm."principal_id",
		min(wm."tenant_id") AS "tenant_id",
		min(wm."workspace_id") AS "workspace_id",
		count(*) AS "membership_count"
	FROM "enterprise_workspace_memberships" wm
	GROUP BY wm."principal_id"
	HAVING count(*) = 1
) unique_membership ON unique_membership."principal_id" = p."id"
WHERE NOT EXISTS (
	SELECT 1 FROM "openmuse_task_scopes" s WHERE s."task_id" = t."id"
)
ON CONFLICT ("task_id") DO NOTHING;

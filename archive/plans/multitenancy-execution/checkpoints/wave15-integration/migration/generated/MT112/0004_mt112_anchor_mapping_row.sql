-- multitenancy migrate-test
INSERT INTO "enterprise_deployment_anchors" ("tenant_id", "deployment_tenant_id", "billing_external_customer_id")
	SELECT 'ent-legacy-original', pkg."tenant_id", 'openbot-deployment-' || pkg."tenant_id"
	FROM (SELECT "tenant_id" FROM "deployment_packages" ORDER BY "loaded_at" ASC, "tenant_id" ASC LIMIT 1) AS pkg
	ON CONFLICT ("tenant_id") DO NOTHING;

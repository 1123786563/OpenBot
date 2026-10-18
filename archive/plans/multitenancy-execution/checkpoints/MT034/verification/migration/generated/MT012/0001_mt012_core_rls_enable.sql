-- multitenancy migrate-test
ALTER TABLE "enterprise_tenants" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "enterprise_tenants" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "enterprise_principals" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "enterprise_principals" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "enterprise_memberships" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "enterprise_memberships" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "enterprise_workspaces" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "enterprise_workspaces" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "enterprise_resources" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "enterprise_resources" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "enterprise_resource_grants" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "enterprise_resource_grants" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "enterprise_security_events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "enterprise_security_events" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "enterprise_workspace_memberships" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "enterprise_workspace_memberships" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "enterprise_deployment_anchors" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "enterprise_deployment_anchors" FORCE ROW LEVEL SECURITY;

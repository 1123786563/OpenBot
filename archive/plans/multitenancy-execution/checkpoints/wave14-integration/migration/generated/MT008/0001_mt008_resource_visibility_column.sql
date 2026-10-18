-- multitenancy migrate-test
ALTER TABLE "enterprise_resources" ADD COLUMN "visibility" text;
--> statement-breakpoint
ALTER TABLE "enterprise_resources" ADD CONSTRAINT "enterprise_resource_visibility" CHECK ("visibility" is null or "visibility" in ('private', 'workspace'));

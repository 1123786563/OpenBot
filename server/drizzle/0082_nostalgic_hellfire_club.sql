ALTER TABLE "usage_outbox" DROP CONSTRAINT "usage_outbox_lago_status_check";--> statement-breakpoint
ALTER TABLE "usage_outbox" DROP CONSTRAINT "usage_outbox_credits_status_check";--> statement-breakpoint
ALTER TABLE "usage_outbox" ADD CONSTRAINT "usage_outbox_lago_status_check" CHECK ("usage_outbox"."lago_status" IN ('pending', 'delivered', 'blocked'));--> statement-breakpoint
ALTER TABLE "usage_outbox" ADD CONSTRAINT "usage_outbox_credits_status_check" CHECK ("usage_outbox"."credits_status" IN ('pending', 'delivered', 'blocked'));
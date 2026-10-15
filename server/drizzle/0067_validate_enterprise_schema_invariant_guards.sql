ALTER TABLE "mastra_message_intents"
	VALIDATE CONSTRAINT "mastra_message_intents_attachment_ids_array_check";--> statement-breakpoint

ALTER TABLE "enterprise_model_budget_reservations"
	VALIDATE CONSTRAINT "enterprise_budget_reservation_tokens_check";--> statement-breakpoint

ALTER TABLE "enterprise_runs"
	VALIDATE CONSTRAINT "enterprise_runs_model_route_maximum_tokens_check";

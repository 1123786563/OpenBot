CREATE TABLE "direct_chat_proposal_reviews" (
	"proposal_id" uuid PRIMARY KEY NOT NULL,
	"review" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "personal_learning_auto_approval" (
	"person_id" text PRIMARY KEY NOT NULL,
	"enabled" boolean NOT NULL
);
--> statement-breakpoint
ALTER TABLE "direct_chat_proposal_reviews" ADD CONSTRAINT "direct_chat_proposal_reviews_proposal_id_direct_chat_analyses_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."direct_chat_analyses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_learning_auto_approval" ADD CONSTRAINT "personal_learning_auto_approval_person_id_users_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
CREATE TABLE "direct_chat_skill_shares" (
	"proposal_id" uuid NOT NULL,
	"recipient_id" text NOT NULL,
	"thread_id" text NOT NULL,
	CONSTRAINT "direct_chat_skill_shares_proposal_id_recipient_id_pk" PRIMARY KEY("proposal_id","recipient_id")
);
--> statement-breakpoint
ALTER TABLE "direct_chat_skill_shares" ADD CONSTRAINT "direct_chat_skill_shares_proposal_id_direct_chat_proposal_reviews_proposal_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."direct_chat_proposal_reviews"("proposal_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "direct_chat_skill_shares" ADD CONSTRAINT "direct_chat_skill_shares_recipient_id_users_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "direct_chat_skill_shares" ADD CONSTRAINT "direct_chat_skill_shares_thread_id_intelligence_channel_mappings_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."intelligence_channel_mappings"("thread_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "direct_chat_skill_shares_recipient_idx" ON "direct_chat_skill_shares" USING btree ("recipient_id","thread_id");
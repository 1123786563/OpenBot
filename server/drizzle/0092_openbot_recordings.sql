CREATE TABLE "recorder_capture_trajectories" (
	"id" uuid PRIMARY KEY NOT NULL,
	"recording_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recorder_recording_events" (
	"recording_id" uuid NOT NULL,
	"seq" bigint NOT NULL,
	"event" jsonb NOT NULL,
	CONSTRAINT "recorder_recording_events_recording_id_seq_pk" PRIMARY KEY("recording_id","seq")
);
--> statement-breakpoint
CREATE TABLE "recorder_recordings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"title" text,
	"outcome" text,
	"reason" text,
	"outcome_seq" bigint,
	"deleted_at" timestamp with time zone,
	"cleanup_completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "recorder_capture_trajectories" ADD CONSTRAINT "recorder_capture_trajectories_recording_id_recorder_recordings_id_fk" FOREIGN KEY ("recording_id") REFERENCES "public"."recorder_recordings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recorder_recording_events" ADD CONSTRAINT "recorder_recording_events_recording_id_recorder_recordings_id_fk" FOREIGN KEY ("recording_id") REFERENCES "public"."recorder_recordings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recorder_recordings" ADD CONSTRAINT "recorder_recordings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "recorder_capture_trajectories_recording_idx" ON "recorder_capture_trajectories" USING btree ("recording_id");--> statement-breakpoint
CREATE INDEX "recorder_recordings_user_idx" ON "recorder_recordings" USING btree ("user_id","created_at","id");
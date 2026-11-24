CREATE TABLE "billing_pilot_signoffs" (
	"kind" text NOT NULL,
	"id" text NOT NULL,
	"evidence" text NOT NULL,
	"record" jsonb NOT NULL,
	"signed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"paused_at" timestamp with time zone,
	"paused_by" text,
	CONSTRAINT "billing_pilot_signoffs_kind_id_evidence_pk" PRIMARY KEY("kind","id","evidence"),
	CONSTRAINT "billing_pilot_signoff_kind" CHECK ("billing_pilot_signoffs"."kind" in ('application', 'channel')),
	CONSTRAINT "billing_pilot_signoff_evidence" CHECK ("billing_pilot_signoffs"."evidence" in ('fixture', 'deployment')),
	CONSTRAINT "billing_pilot_signoff_pause" CHECK (("billing_pilot_signoffs"."paused_at" is null) = ("billing_pilot_signoffs"."paused_by" is null))
);

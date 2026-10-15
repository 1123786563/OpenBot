CREATE TABLE "gateway_conversion_rates" (
	"rate_version" integer PRIMARY KEY NOT NULL,
	"numerator" bigint NOT NULL,
	"denominator" bigint NOT NULL,
	"is_current" boolean DEFAULT false NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "gateway_conversion_rates_one_current" ON "gateway_conversion_rates" USING btree ("is_current") WHERE "gateway_conversion_rates"."is_current";
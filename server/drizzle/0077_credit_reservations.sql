CREATE TABLE "credit_charge_remainders" (
	"external_customer_id" text PRIMARY KEY NOT NULL,
	"numerator" text NOT NULL,
	"denominator" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_charge_remainders_shape_check" CHECK ("credit_charge_remainders"."numerator" ~ '^[0-9]+$' AND "credit_charge_remainders"."denominator" ~ '^[1-9][0-9]*$')
);
--> statement-breakpoint
CREATE TABLE "credit_reservation_allocations" (
	"id" text PRIMARY KEY NOT NULL,
	"reservation_id" text NOT NULL,
	"grant_id" text NOT NULL,
	"amount" integer NOT NULL,
	"consumed" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "credit_reservation_allocations_amount_check" CHECK ("credit_reservation_allocations"."amount" > 0),
	CONSTRAINT "credit_reservation_allocations_consumed_check" CHECK ("credit_reservation_allocations"."consumed" >= 0 AND "credit_reservation_allocations"."consumed" <= "credit_reservation_allocations"."amount")
);
--> statement-breakpoint
CREATE TABLE "credit_reservations" (
	"id" text PRIMARY KEY NOT NULL,
	"external_customer_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"maximum" integer NOT NULL,
	"status" text DEFAULT 'reserved' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"actual_numerator" text,
	"actual_denominator" text,
	"charged" integer,
	"remainder_numerator" text,
	"remainder_denominator" text,
	"applied" integer,
	"released" integer,
	"release_reason" text,
	"ledger_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"terminal_at" timestamp with time zone,
	CONSTRAINT "credit_reservations_status_check" CHECK ("credit_reservations"."status" IN ('reserved', 'settled', 'released')),
	CONSTRAINT "credit_reservations_maximum_check" CHECK ("credit_reservations"."maximum" > 0),
	CONSTRAINT "credit_reservations_terminal_check" CHECK (("credit_reservations"."status" = 'reserved' AND "credit_reservations"."terminal_at" IS NULL) OR ("credit_reservations"."status" <> 'reserved' AND "credit_reservations"."terminal_at" IS NOT NULL)),
	CONSTRAINT "credit_reservations_settled_check" CHECK ("credit_reservations"."status" <> 'settled' OR ("credit_reservations"."actual_numerator" ~ '^[0-9]+$' AND "credit_reservations"."actual_denominator" ~ '^[0-9]+$' AND "credit_reservations"."actual_denominator" !~ '^0+$' AND "credit_reservations"."charged" >= 0 AND "credit_reservations"."applied" >= 0 AND "credit_reservations"."applied" <= "credit_reservations"."maximum" AND "credit_reservations"."released" = "credit_reservations"."maximum" - "credit_reservations"."applied"))
);
--> statement-breakpoint
ALTER TABLE "credit_charge_remainders" ADD CONSTRAINT "credit_charge_remainders_external_customer_id_billing_customers_external_id_fk" FOREIGN KEY ("external_customer_id") REFERENCES "public"."billing_customers"("external_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_reservation_allocations" ADD CONSTRAINT "credit_reservation_allocations_reservation_id_credit_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."credit_reservations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_reservation_allocations" ADD CONSTRAINT "credit_reservation_allocations_grant_id_credit_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."credit_grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_reservations" ADD CONSTRAINT "credit_reservations_external_customer_id_billing_customers_external_id_fk" FOREIGN KEY ("external_customer_id") REFERENCES "public"."billing_customers"("external_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_reservations" ADD CONSTRAINT "credit_reservations_ledger_id_credit_ledger_id_fk" FOREIGN KEY ("ledger_id") REFERENCES "public"."credit_ledger"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "credit_reservation_allocations_reservation_grant_idx" ON "credit_reservation_allocations" USING btree ("reservation_id","grant_id");--> statement-breakpoint
CREATE INDEX "credit_reservation_allocations_grant_idx" ON "credit_reservation_allocations" USING btree ("grant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_reservations_idempotency_key_unique_idx" ON "credit_reservations" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "credit_reservations_customer_status_idx" ON "credit_reservations" USING btree ("external_customer_id","status");--> statement-breakpoint
CREATE INDEX "credit_reservations_status_expires_idx" ON "credit_reservations" USING btree ("status","expires_at");
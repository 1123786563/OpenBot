-- T05.13 (#569, original task P12; interfaces §5.2 / F2): the per-action
-- admission fence behind POST /api/enterprise/mobile/session/authorize.
--
-- T05.12's session handle proves who browsed in; it is deliberately NOT a
-- reusable bearer (仅当前动作一次、无正向缓存). Every authorize call
-- re-verifies the handle's session, account, remote binding and identity
-- generation live, and then mints ONE admission bound to exactly this
-- handle, requestId and operation. This table is that one-shot fence:
--
--   auth_mobile_session_admissions — one row per admitted action. The
--     primary key is the SHA-256 of the admissionId the response carried
--     exactly once; the UNIQUE (handle_digest, request_id) makes admitting
--     the same requestId under the same handle structurally impossible,
--     whatever raced. The row is written in the SAME transaction as every
--     live re-verification read, so an admission never exists for facts the
--     transaction did not verify. The handle FK cascades: the session's
--     death (expiry, revoke, sign-out) takes its admissions with it.
--
-- No role but the mobile-session service's writer (0221's direct-grant
-- admission, the same capability 0222 gave the handoff tables) touches this
-- table; every other role stays at zero. Journal 0223 follows the tail at
-- 0222.
CREATE TABLE "auth_mobile_session_admissions" (
	"admission_digest" text PRIMARY KEY,
	"handle_digest" text NOT NULL,
	"request_id" text NOT NULL,
	"operation" text NOT NULL,
	"resource_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_mobile_session_admission_handle_fk" FOREIGN KEY ("handle_digest") REFERENCES "public"."auth_mobile_session_handles"("handle_digest") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
ALTER TABLE "auth_mobile_session_admissions" ADD CONSTRAINT "auth_mobile_session_admission_once" UNIQUE ("handle_digest", "request_id");
--> statement-breakpoint
ALTER TABLE "auth_mobile_session_admissions" ADD CONSTRAINT "auth_mobile_session_admission_shape" CHECK ("admission_digest" ~ '^[0-9a-f]{64}$' and "request_id" <> '' and length("request_id") <= 256 and "operation" <> '');
--> statement-breakpoint
CREATE INDEX "auth_mobile_session_admission_created_idx" ON "auth_mobile_session_admissions" USING btree ("created_at");
--> statement-breakpoint
REVOKE ALL ON TABLE "auth_mobile_session_admissions" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "auth_mobile_session_admissions" TO ob_ent_auth_writer;

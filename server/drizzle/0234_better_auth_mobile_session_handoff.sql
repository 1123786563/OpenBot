-- T05.12 (#568, original task P12; interfaces §5.2 / F2): the mobile
-- one-time PKCE session handoff's two tables, expand-only.
--
-- The mobile-session service (server/src/auth/mobile-session.ts) is the only
-- writer, on the auth-writer capability, following 0221's direct-grant
-- admission rather than 0218/0219's controlled functions: every write is one
-- INSERT at authorize, one locked conditional UPDATE + one INSERT inside the
-- exchange transaction, and the tables have no row semantics a function would
-- own. Every other runtime role keeps zero privileges — the 0214 discipline.
--
--   auth_mobile_handoff_codes: one row per authorize intent. PK = SHA-256 of
--     the one-time code (the plaintext only ever rides the redirect URL);
--     the row CHECKs pin the 120-second window (never longer, judged against
--     the row's own created_at), the 43-character S256 challenge, and that
--     consumption happens at or after creation.
--
--   auth_mobile_session_handles: one row per consumed code, minted in the
--     exchange's transaction. PK = SHA-256 of the opaque handle (plaintext
--     returned once, never stored); UNIQUE(code_digest) is the replay fence
--     — a second handle for one code is structurally impossible; the window
--     CHECK pins the 1800-second ceiling (the BA session's expiry may bind
--     tighter, never longer); (issuer, subject) are both-null-or-both-set.
CREATE TABLE "auth_mobile_handoff_codes" (
	"code_digest" text PRIMARY KEY NOT NULL,
	"intent_id" text NOT NULL,
	"user_id" text NOT NULL,
	"session_id" text NOT NULL,
	"client_id" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"code_challenge" text NOT NULL,
	"authority_origin" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_mobile_handoff_code_user_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "auth_mobile_handoff_code_session_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
ALTER TABLE "auth_mobile_handoff_codes" ADD CONSTRAINT "auth_mobile_handoff_code_window" CHECK ("expires_at" > "created_at" and "expires_at" <= "created_at" + interval '120 seconds');
--> statement-breakpoint
ALTER TABLE "auth_mobile_handoff_codes" ADD CONSTRAINT "auth_mobile_handoff_code_challenge_shape" CHECK (char_length("code_challenge") = 43);
--> statement-breakpoint
ALTER TABLE "auth_mobile_handoff_codes" ADD CONSTRAINT "auth_mobile_handoff_code_intent_shape" CHECK (char_length("intent_id") between 1 and 128);
--> statement-breakpoint
ALTER TABLE "auth_mobile_handoff_codes" ADD CONSTRAINT "auth_mobile_handoff_code_consumed_after_created" CHECK (("consumed_at" is null) or ("consumed_at" >= "created_at"));
--> statement-breakpoint
CREATE INDEX "auth_mobile_handoff_code_session_idx" ON "auth_mobile_handoff_codes" USING btree ("session_id","created_at");
--> statement-breakpoint
CREATE TABLE "auth_mobile_session_handles" (
	"handle_digest" text PRIMARY KEY NOT NULL,
	"code_digest" text NOT NULL,
	"user_id" text NOT NULL,
	"session_id" text NOT NULL,
	"client_id" text NOT NULL,
	"authority_origin" text NOT NULL,
	"audience" text NOT NULL,
	"principal_id" text,
	"issuer" text,
	"subject" text,
	"identity_generation" bigint,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_mobile_session_handle_user_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "auth_mobile_session_handle_session_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
ALTER TABLE "auth_mobile_session_handles" ADD CONSTRAINT "auth_mobile_session_handle_window" CHECK ("expires_at" > "created_at" and "expires_at" <= "created_at" + interval '1800 seconds');
--> statement-breakpoint
ALTER TABLE "auth_mobile_session_handles" ADD CONSTRAINT "auth_mobile_session_handle_binding_shape" CHECK (("issuer" is null) = ("subject" is null) and ("audience" <> ''));
--> statement-breakpoint
ALTER TABLE "auth_mobile_session_handles" ADD CONSTRAINT "auth_mobile_session_handle_identity_generation_safe_integer" CHECK (("identity_generation" is null) or ("identity_generation" >= 0 and "identity_generation" <= 9007199254740991));
--> statement-breakpoint
CREATE UNIQUE INDEX "auth_mobile_session_handle_code_uq" ON "auth_mobile_session_handles" USING btree ("code_digest");
--> statement-breakpoint
CREATE INDEX "auth_mobile_session_handle_user_idx" ON "auth_mobile_session_handles" USING btree ("user_id","created_at");
--> statement-breakpoint
REVOKE ALL ON TABLE "auth_mobile_handoff_codes" FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON TABLE "auth_mobile_session_handles" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "auth_mobile_handoff_codes" TO ob_ent_auth_writer;
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "auth_mobile_session_handles" TO ob_ent_auth_writer;

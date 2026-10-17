-- Bifrost 03.9 (#231, AC09/design Q16): the user's model preference layers.
--
-- `gateway_model_preferences` holds one cell per identity: `global` is the user's
-- default everywhere, `bot` their default for one Bot, `conversation` one session's
-- selection. Resolution answers the most specific cell that exists — 全局默认 →
-- 该 Bot 默认 → 当前会话选择, 越具体越优先 (Q16) — and a cell nobody wrote is
-- simply absent: no preference is the honest default, not an inherited guess.
--
-- The identity columns must agree with the scope, and the database enforces what
-- the service asserts: the empty string marks the part of the identity a scope
-- does not name, so a `bot` row that names a conversation or a `global` row that
-- belongs to one Bot cannot be stored by any writer, present or future.
--
-- Nothing here decides whether a ref may be chosen. The write path (03.9's
-- service) validates the ModelRef against 03.8's selectable list before it ever
-- reaches this table, and resolution answers what is stored — availability
-- gating stays with the caller (Q16: 不可用时明确报错, 第一版不自动换模型).
CREATE TABLE IF NOT EXISTS "gateway_model_preferences" (
	"user_id" text NOT NULL,
	"scope" text NOT NULL,
	"bot_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"capability" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT statement_timestamp() NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gateway_model_preferences_identity_pk" PRIMARY KEY("user_id","scope","bot_id","conversation_id")
);
--> statement-breakpoint
ALTER TABLE "gateway_model_preferences" ADD CONSTRAINT "gateway_model_preferences_scope_allowed" CHECK ("gateway_model_preferences"."scope" IN ('global', 'bot', 'conversation'));
--> statement-breakpoint
ALTER TABLE "gateway_model_preferences" ADD CONSTRAINT "gateway_model_preferences_capability_allowed" CHECK ("gateway_model_preferences"."capability" IN ('chat', 'embedding', 'image', 'speech', 'transcription', 'rerank', 'realtime', 'video', 'unknown'));
--> statement-breakpoint
ALTER TABLE "gateway_model_preferences" ADD CONSTRAINT "gateway_model_preferences_scope_identity_consistent" CHECK (("gateway_model_preferences"."scope" = 'global' AND "gateway_model_preferences"."bot_id" = '' AND "gateway_model_preferences"."conversation_id" = '') OR ("gateway_model_preferences"."scope" = 'bot' AND "gateway_model_preferences"."bot_id" <> '' AND "gateway_model_preferences"."conversation_id" = '') OR ("gateway_model_preferences"."scope" = 'conversation' AND "gateway_model_preferences"."bot_id" <> '' AND "gateway_model_preferences"."conversation_id" <> ''));

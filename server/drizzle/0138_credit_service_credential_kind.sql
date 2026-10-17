-- Bifrost #252 (06.1): the billing protocol's own service credential kind.
--
-- The vault's `credential_kind` enum gains `credit_service`: the one kind the deployment's
-- Bifrost admission extension's secret is stored under, so the door to Reserve/Status/Settle/
-- Release verifies against a credential that cannot be confused with a Bot's, a person's or
-- the deployment's own gateway-admin key. Purely additive: no rows carry it yet, and the
-- issuing path (server/src/billing/credit-service-auth.ts) rotates within the kind, where
-- `credentials_active_key_idx` keeps at most one live row for the fixed `gateway` keyId.
ALTER TYPE "public"."credential_kind" ADD VALUE 'credit_service';--> statement-breakpoint

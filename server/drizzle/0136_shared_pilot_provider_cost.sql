-- The shared total is a projection of the durable reservation and evidence
-- ledger. This includes pre-migration operations without a route-cost hold.
CREATE VIEW "pilot_provider_cost_exposure" AS
SELECT count(*)::text AS "operations",
       coalesce(sum(coalesce(observed.cost, operation.reserved)), 0)::text AS "outstanding"
FROM "test_credit_operations" operation
LEFT JOIN LATERAL (
    SELECT max(evidence.cost) AS cost
    FROM "test_credit_evidence" evidence
    WHERE evidence.account_id = operation.account_id
      AND evidence.operation_id = operation.id
) observed ON operation.dispatched_at IS NOT NULL
WHERE operation.state = 'reserved' OR operation.dispatched_at IS NOT NULL;
--> statement-breakpoint
CREATE FUNCTION "lock_pilot_provider_cost"() RETURNS void
LANGUAGE sql VOLATILE AS $$
    SELECT pg_advisory_xact_lock(hashtext('openbot.billing'), hashtext('pilot-provider-cost'));
$$;
--> statement-breakpoint
CREATE FUNCTION "enforce_pilot_provider_cost"() RETURNS trigger
LANGUAGE plpgsql VOLATILE AS $$
DECLARE
    ceiling bigint;
    outstanding numeric;
BEGIN
    -- The operator takes the same lock, including when setting the first cap.
    PERFORM lock_pilot_provider_cost();
    SELECT limit_microcredits INTO ceiling FROM pilot_provider_cost_limits WHERE path = '@pilot';
    IF ceiling IS NOT NULL THEN
        SELECT exposure.outstanding::numeric INTO outstanding FROM pilot_provider_cost_exposure exposure;
        IF outstanding + NEW.reserved > ceiling THEN
            RAISE check_violation USING CONSTRAINT = 'shared_pilot_provider_cost_limit',
                MESSAGE = 'Shared pilot provider cost limit reached';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
--> statement-breakpoint
-- Enforce at the reservation write so a cap denial rolls back user funding
-- and the ceiling stays active if an older application binary is deployed.
CREATE TRIGGER "enforce_pilot_provider_cost"
BEFORE INSERT ON "test_credit_operations"
FOR EACH ROW EXECUTE FUNCTION "enforce_pilot_provider_cost"();

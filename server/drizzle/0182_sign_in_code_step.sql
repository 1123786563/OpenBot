-- #496: the verification code a site asks for after it has taken the password.
--
-- `sign_in_requests` gains the `code_required` state: the site accepted the login and is showing a
-- one-time-code field, so the private form asks for only that. An open, non-final state — the
-- request is visible in the pending list, no turn is resumed, and only an explicit code submission
-- claims the execution lease again. No column changes: a code is never stored.
--
-- Expand-only constraint replacement: the old check is dropped and the same check, one state
-- richer, is added back under the same name. Every status the old check admitted is still legal, so
-- an application from before this migration reads and writes every row it wrote before; it just
-- sees a status value it does not know yet, which is why the application rolls back only after the
-- code_required rows are drained or closed (see the release runbook).
ALTER TABLE "sign_in_requests" DROP CONSTRAINT "sign_in_requests_status_check";--> statement-breakpoint
ALTER TABLE "sign_in_requests" ADD CONSTRAINT "sign_in_requests_status_check" CHECK ("sign_in_requests"."status" IN ('pending', 'filling', 'code_required', 'taken_over', 'signed_in', 'failed', 'cancelled', 'expired'));

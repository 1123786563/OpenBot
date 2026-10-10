-- Run-writer read-catalog completion, per plan 03 §4.2 + §4.3.
--
-- §4.3 requires the RunPolicy's queries and verdicts to run inside the CALLER's single
-- `withTenant` transaction ("查询和判断都在调用方传入的同一个withTenant事务内"): the create
-- path must verify the model route, the model grant, the expert resource grant and the
-- tenant policy revision in the same transaction that commits the run, and the read path
-- must re-run 02's single-transaction resource read (`assertResourceReadInTx`) on that very
-- transaction. 0060 scoped ob_ent_run_writer to memberships/workspaces/resources/releases/
-- run_grants only, which forced the policy onto cross-pool preflights (a TOCTOU window the
-- reviewer twice flagged). These statements complete the READ-ONLY catalog that §4.2's
-- "只读成员/资源/grants" promises — SELECT only, every statement pinned to the transaction's
-- tenant (principals additionally to the transaction's own principal) — and widen nothing
-- writable: the model ledger stays read-only for this role, ACLs stay operator-owned, and
-- the audit log stays untouched by design (the actor must never write its own audit).
--> statement-breakpoint
CREATE POLICY run_writer_tenant_read ON enterprise_tenants FOR SELECT TO ob_ent_run_writer
USING (enterprise_tenants.id=nullif(current_setting('app.tenant_id',true),''));
--> statement-breakpoint
CREATE POLICY run_writer_principal_read ON enterprise_principals FOR SELECT TO ob_ent_run_writer
USING (enterprise_principals.id=nullif(current_setting('app.principal_id',true),''));
--> statement-breakpoint
CREATE POLICY run_writer_resource_grant_read ON enterprise_resource_grants FOR SELECT TO ob_ent_run_writer
USING (enterprise_resource_grants.tenant_id=nullif(current_setting('app.tenant_id',true),''));
--> statement-breakpoint
CREATE POLICY run_writer_model_route_read ON enterprise_model_routes FOR SELECT TO ob_ent_run_writer
USING (enterprise_model_routes.tenant_id=nullif(current_setting('app.tenant_id',true),''));
--> statement-breakpoint
CREATE POLICY run_writer_model_grant_read ON enterprise_model_grants FOR SELECT TO ob_ent_run_writer
USING (enterprise_model_grants.tenant_id=nullif(current_setting('app.tenant_id',true),''));
--> statement-breakpoint
GRANT SELECT ON enterprise_tenants, enterprise_principals, enterprise_resource_grants,
 enterprise_model_routes, enterprise_model_grants TO ob_ent_run_writer;

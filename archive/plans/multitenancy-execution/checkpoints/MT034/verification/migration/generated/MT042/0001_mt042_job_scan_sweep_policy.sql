-- multitenancy migrate-test
CREATE POLICY "job_ownership_operator_sweep_read" ON "job_ownership" AS PERMISSIVE FOR SELECT TO ob_ent_operator
  USING (current_setting('app.scan_sweep', true) = 'on');

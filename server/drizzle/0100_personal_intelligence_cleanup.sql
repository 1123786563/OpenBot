CREATE TABLE "personal_intelligence_runs" (
	"account_id" uuid NOT NULL,
	"thread_id" text NOT NULL,
	"run_id" text NOT NULL,
	"agent_id" text NOT NULL,
	CONSTRAINT "personal_intelligence_runs_account_id_thread_id_run_id_agent_id_pk" PRIMARY KEY("account_id","thread_id","run_id","agent_id")
);
--> statement-breakpoint
ALTER TABLE "personal_intelligence_runs" ADD CONSTRAINT "personal_intelligence_runs_account_id_personal_saas_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."personal_saas_accounts"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
INSERT INTO personal_intelligence_runs (account_id, thread_id, run_id, agent_id)
SELECT w.account_id, w.key, w.key, b.agent_id
FROM work_items w
JOIN personal_workspaces p ON p.owner_id = w.account_id
JOIN personal_workspace_default_bots b ON b.workspace_id = p.id
WHERE w.kind = 'personal.bot.turn'
UNION ALL
SELECT p.owner_id, r.channel_id, rr.id, r.agent_id
FROM personal_workspaces p
JOIN personal_workspace_default_bots b ON b.workspace_id = p.id
JOIN routines r ON r.owner_user_id = ('personal-workspace:' || p.id::text) AND r.agent_id = b.agent_id
JOIN routine_runs rr ON rr.routine_id = r.id
UNION ALL
SELECT p.owner_id, d.thread_id, d.id, d.agent_id
FROM personal_workspaces p
JOIN personal_workspace_default_bots b ON b.workspace_id = p.id
JOIN delivery_inbox d ON d.owner_user_id = ('personal-workspace:' || p.id::text) AND d.agent_id = b.agent_id
UNION ALL
SELECT w.account_id, w.payload->>'threadId', w.payload->>'runId', b.agent_id
FROM work_items w
JOIN personal_workspaces p ON p.owner_id = w.account_id
JOIN personal_workspace_default_bots b ON b.workspace_id = p.id
WHERE w.kind = 'person.question' AND w.payload->>'botId' = b.agent_id
  AND nullif(w.payload->>'threadId', '') IS NOT NULL AND nullif(w.payload->>'runId', '') IS NOT NULL
UNION ALL
SELECT p.owner_id, a.action->>'threadId', a.action->>'runId', b.agent_id
FROM personal_workspaces p
JOIN personal_workspace_default_bots b ON b.workspace_id = p.id
JOIN approval_requests a ON a.owner_user_id = p.owner_id::text AND a.action->>'botId' = b.agent_id
WHERE nullif(a.action->>'threadId', '') IS NOT NULL AND nullif(a.action->>'runId', '') IS NOT NULL
ON CONFLICT DO NOTHING;

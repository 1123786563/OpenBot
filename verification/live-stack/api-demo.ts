// T12 closing-wave demo (API level, gate OPEN, pilot tuple t12-tenant/t12-team):
// PKG01 browse → PKG02 install (idempotent replay) → grant/revoke → PKG06 upgrade diff + apply
// → PKG04 expert template create (initial grant) → PKG06 rollback → PKG07 disable/reinstall
// → PKG10 unknown ledger + verify refusal.
import { writeFileSync, mkdirSync } from "node:fs";
const base = process.env.T12_SERVER ?? "http://localhost:3321";
const { cookie } = JSON.parse(await Bun.file("/tmp/t12-auth.json").text());
const scope = { "x-openbot-tenant": "t12-tenant", "x-openbot-workspace": "t12-team" };
const dir = "verification/browser/api";
mkdirSync(dir, { recursive: true });
async function api(method: string, path: string, body?: unknown, extra: Record<string, string> = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json", Origin: "http://localhost:3322", cookie, ...scope, ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}
const log: string[] = [];
const record: Record<string, unknown> = { headSha: (await Bun.$`git rev-parse HEAD`.text()).trim(), base, steps: {} };
const steps = record.steps as Record<string, any>;
function note(step: string, data: unknown) {
  steps[step] = data;
  log.push(`${step}: ${JSON.stringify(data)}`);
  writeFileSync(`${dir}/${step}.json`, JSON.stringify(data, null, 2));
}
const key = (s: string) => `t12-${s}-${Date.now()}`;

// PKG01 — browse + detail
let r = await api("GET", "/api/enterprise/plugin-packages");
note("PKG01_catalogue", { status: r.status, body: r.json ?? r.text.slice(0, 500) });
r = await api("GET", "/api/enterprise/plugin-packages/catalogue/openbot/demo-skill");
note("PKG01_detail_current", { status: r.status, body: r.json ?? r.text.slice(0, 800) });

// PKG02 — plan install 1.0.0, apply, replay apply (idempotency)
let planResp = await api("POST", "/api/enterprise/plugin-packages/plans",
  { operation: "install", packageKey: "openbot/demo-skill", version: "1.0.0", expectedRevision: null, config: {}, connectorInstalls: {} },
  { "idempotency-key": key("plan-install") });
note("PKG02_plan_install_100", { status: planResp.status, body: planResp.json ?? planResp.text.slice(0, 500) });
const planId = planResp.json?.planId;
let applyResp = await api("POST", `/api/enterprise/plugin-packages/plans/${planId}/apply`, undefined, { "idempotency-key": key("apply") });
note("PKG02_apply", { status: applyResp.status, body: applyResp.json ?? applyResp.text.slice(0, 500) });
const installId = applyResp.json?.id ?? applyResp.json?.installId;
const replayKey = key("apply-replay");
const replay1 = await api("POST", `/api/enterprise/plugin-packages/plans/${planId}/apply`, undefined, { "idempotency-key": replayKey });
const replay2 = await api("POST", `/api/enterprise/plugin-packages/plans/${planId}/apply`, undefined, { "idempotency-key": replayKey });
note("PKG02_apply_replay", { first: { status: replay1.status, body: replay1.json ?? replay1.text.slice(0, 300) }, second: { status: replay2.status, body: replay2.json ?? replay2.text.slice(0, 300) } });
r = await api("GET", "/api/enterprise/plugin-packages");
note("PKG02_list_after_install", { status: r.status, body: r.json ?? r.text.slice(0, 800) });
r = await api("GET", `/api/enterprise/plugin-packages/installs/${installId}`);
note("PKG02_install_detail", { status: r.status, body: r.json ?? r.text.slice(0, 800) });
const revision1 = r.json?.revision ?? r.json?.install?.revision;

// PKG03/04 prerequisite — grant then revoke (A04/A05): skill resource on t12-bot-1
r = await api("PUT", `/api/enterprise/plugin-packages/installs/${installId}/bots/t12-bot-1/grants`,
  { installId, botId: "t12-bot-1", expectedGrantRevision: null, resources: [{ resourceId: "summarize", kind: "skill" }] },
  { "idempotency-key": key("grant") });
note("PKG03_grant", { status: r.status, body: r.json ?? r.text.slice(0, 500) });
const grantRevision = r.json?.revision ?? r.json?.grantRevision ?? 1;
r = await api("GET", `/api/enterprise/plugin-packages/installs/${installId}`);
note("PKG03_ready_after_grant", { status: r.status, body: r.json ?? r.text.slice(0, 800) });
r = await api("DELETE", `/api/enterprise/plugin-packages/installs/${installId}/bots/t12-bot-1/grants`,
  { expectedGrantRevision: grantRevision }, { "idempotency-key": key("revoke") });
note("PKG03_revoke", { status: r.status, body: r.json ?? r.text.slice(0, 500) });
r = await api("GET", `/api/enterprise/plugin-packages/installs/${installId}`);
note("PKG03_needs_grant_after_revoke", { status: r.status, body: r.json ?? r.text.slice(0, 800) });

// PKG06 — upgrade plan with diff → apply → revision 2
planResp = await api("POST", "/api/enterprise/plugin-packages/plans",
  { operation: "upgrade", packageKey: "openbot/demo-skill", version: "1.1.0", expectedRevision: revision1, config: {}, connectorInstalls: {} },
  { "idempotency-key": key("plan-upgrade") });
note("PKG06_upgrade_plan_diff", { status: planResp.status, body: planResp.json ?? planResp.text.slice(0, 800) });
const upgradePlanId = planResp.json?.planId;
r = await api("POST", `/api/enterprise/plugin-packages/plans/${upgradePlanId}/apply`, undefined, { "idempotency-key": key("apply-upgrade") });
note("PKG06_upgrade_apply", { status: r.status, body: r.json ?? r.text.slice(0, 800) });

// PKG04 — expert template create + replay (same agentId) + initial grant
r = await api("GET", `/api/enterprise/plugin-packages/installs/${installId}`);
const revision2 = r.json?.revision ?? r.json?.install?.revision;
const expertKey = key("expert");
const expertReq = { installId, resourceId: "note-assistant", expectedRevision: revision2, name: "T12 Note Assistant" };
let e1 = await api("POST", `/api/enterprise/plugin-packages/installs/${installId}/experts/note-assistant`, expertReq, { "idempotency-key": expertKey });
let e2 = await api("POST", `/api/enterprise/plugin-packages/installs/${installId}/experts/note-assistant`, expertReq, { "idempotency-key": expertKey });
note("PKG04_expert_create", { first: { status: e1.status, body: e1.json ?? e1.text.slice(0, 500) }, replay: { status: e2.status, body: e2.json ?? e2.text.slice(0, 500) }, sameAgent: e1.json?.agentId === e2.json?.agentId });

// PKG06 — rollback to 1.0.0 with diff → apply
planResp = await api("POST", "/api/enterprise/plugin-packages/plans",
  { operation: "rollback", packageKey: "openbot/demo-skill", version: "1.0.0", expectedRevision: revision2, config: {}, connectorInstalls: {} },
  { "idempotency-key": key("plan-rollback") });
note("PKG06_rollback_plan_diff", { status: planResp.status, body: planResp.json ?? planResp.text.slice(0, 800) });
const rollbackPlanId = planResp.json?.planId;
r = await api("POST", `/api/enterprise/plugin-packages/plans/${rollbackPlanId}/apply`, undefined, { "idempotency-key": key("apply-rollback") });
note("PKG06_rollback_apply", { status: r.status, body: r.json ?? r.text.slice(0, 800) });
r = await api("GET", `/api/enterprise/plugin-packages/installs/${installId}`);
const revision3 = r.json?.revision ?? r.json?.install?.revision;
note("PKG06_after_rollback", { status: r.status, body: r.json ?? r.text.slice(0, 800) });

// PKG07 — disable → re-enable (generation bump, grants not resurrected)
r = await api("PATCH", `/api/enterprise/plugin-packages/installs/${installId}/status`,
  { status: "disabled", expectedRevision: revision3 }, { "idempotency-key": key("disable") });
note("PKG07_disable", { status: r.status, body: r.json ?? r.text.slice(0, 600) });
const revision4 = r.json?.revision ?? r.json?.install?.revision;
r = await api("PATCH", `/api/enterprise/plugin-packages/installs/${installId}/status`,
  { status: "enabled", expectedRevision: revision4 }, { "idempotency-key": key("enable") });
note("PKG07_reinstall_enable", { status: r.status, body: r.json ?? r.text.slice(0, 600) });

// PKG10 — dispatch ledger read surface (unknown injected separately via SQL) + verify refusal
r = await api("GET", `/api/enterprise/plugin-packages/installs/${installId}/dispatches`);
note("PKG10_ledger_before_inject", { status: r.status, body: r.json ?? r.text.slice(0, 600) });

writeFileSync(`${dir}/00-all-steps.json`, JSON.stringify(record, null, 2));
writeFileSync(`${dir}/00-all-steps.innerText.txt`, log.join("\n") + "\n");
console.log(log.join("\n"));
console.log("INSTALL_ID=" + installId);
await Bun.write("/tmp/t12-install.json", JSON.stringify({ installId, revision3, revision4 }));

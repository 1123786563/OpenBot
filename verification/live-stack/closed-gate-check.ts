// T12 live evidence: gate CLOSED (default) — legacy marketplace install path unchanged + package writes refuse 503.
import { writeFileSync } from "node:fs";
const base = process.env.T12_SERVER ?? "http://localhost:3321";
const { cookie, userId } = JSON.parse(await Bun.file("/tmp/t12-auth.json").text());
const scope = { "x-openbot-tenant": "t12-tenant", "x-openbot-workspace": "t12-team" };
async function api(method: string, path: string, body?: unknown, extra: Record<string, string> = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json", Origin: "http://localhost:3322", cookie, ...scope, ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}
const out: Record<string, unknown> = { userId, steps: {} as Record<string, unknown> };
const steps = out.steps as Record<string, any>;

// 1. legacy catalogue read
let r = await api("GET", "/api/marketplace");
steps.legacyCatalogue = { status: r.status, experts: (r.json as any)?.experts?.length, skills: (r.json as any)?.skills?.length };
// 2. legacy expert install (the old private-Bot path must behave exactly as before)
r = await api("POST", "/api/marketplace/experts/fullstack-engineer/install", {});
steps.legacyExpertInstall = { status: r.status, body: r.json ?? r.text.slice(0, 400) };
// 2b. idempotent re-install (legacy semantics)
r = await api("POST", "/api/marketplace/experts/fullstack-engineer/install", {});
steps.legacyExpertReinstall = { status: r.status, body: r.json ?? r.text.slice(0, 400) };
// 3. package reads stay open while the entry is closed
r = await api("GET", "/api/enterprise/plugin-packages");
steps.packageReadClosedGate = { status: r.status, body: r.json ?? r.text.slice(0, 400) };
// 4. package write (plan) must refuse with the closed-entry reason
r = await api("POST", "/api/enterprise/plugin-packages/plans",
  { operation: "install", packageKey: "openbot/demo-skill", version: "1.0.0", config: {} },
  { "idempotency-key": `t12-closed-${Date.now()}` });
steps.packagePlanClosedGate = { status: r.status, body: r.json ?? r.text.slice(0, 400) };

writeFileSync("verification/browser/gate-closed-legacy.json", JSON.stringify(out, null, 2));
const lines = Object.entries(steps).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("\n");
writeFileSync("verification/browser/gate-closed-legacy.innerText.txt", lines + "\n");
console.log(lines);

// T12 PKG10 demo: unknown dispatch visible in the ledger, inspected, and verification refused
// with the closed 422 reason (no vendor query protocol exists in this deployment).
import { writeFileSync } from "node:fs";
const base = process.env.T12_SERVER ?? "http://localhost:3321";
const { cookie } = JSON.parse(await Bun.file("/tmp/t12-auth.json").text());
const { installId } = JSON.parse(await Bun.file("/tmp/t12-install.json").text());
const scope = { "x-openbot-tenant": "t12-tenant", "x-openbot-workspace": "t12-team" };
async function api(method: string, path: string) {
  const res = await fetch(base + path, { method, headers: { Origin: "http://localhost:3322", cookie, ...scope } });
  const text = await res.text();
  let json: any = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}
const out: Record<string, unknown> = {};
let r = await api("GET", `/api/enterprise/plugin-packages/installs/${installId}`);
out.installUnknownBadge = { status: r.status, unknownDispatches: r.json?.unknownDispatches, readiness: r.json?.readiness };
r = await api("GET", `/api/enterprise/plugin-packages/installs/${installId}/dispatches`);
out.ledger = { status: r.status, body: r.json ?? r.text.slice(0, 600) };
r = await api("GET", `/api/enterprise/plugin-packages/installs/${installId}/dispatches/9a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d`);
out.inspect = { status: r.status, body: r.json ?? r.text.slice(0, 900) };
r = await api("POST", `/api/enterprise/plugin-packages/installs/${installId}/dispatches/9a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d/verify`);
out.verify = { status: r.status, body: r.json ?? r.text.slice(0, 600) };
writeFileSync("verification/browser/api/PKG10_unknown.json", JSON.stringify(out, null, 2));
const lines = Object.entries(out).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("\n");
writeFileSync("verification/browser/api/PKG10_unknown.innerText.txt", lines + "\n");
console.log(lines);

// Replay ONE real Next-Action request (captured by drive.ts, so the action id and
// body are the browser's own bytes) under each header shape, direct against
// next dev. Isolates the CSRF gate from everything else.
const HARNESS = "/Users/wuyongjun/.cache/craft414-harness";
const UPSTREAM = process.env.UPSTREAM ?? "http://127.0.0.1:3399/abc123";
const OUT = process.env.OUT ?? `${HARNESS}/out/replay.json`;
const PREVIEW = "http://127.0.0.1:3299";
const PREVIEW_AUTHORITY = "127.0.0.1:3299";

const drive = await Bun.file(`${HARNESS}/out/drive-direct.json`)
  .json()
  .catch(() => null);
const req0 = drive?.action_requests_captured?.[0];
if (!req0) throw new Error("no captured action request — run drive.ts (direct) first");

const base: Record<string, string> = { ...(req0.headers as Record<string, string>) };
delete base["content-length"];
delete base["host"];

type Variant = { name: string; note: string; headers: Record<string, string> };

function stripAll(h: Record<string, string>) {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    const l = k.toLowerCase();
    if (
      ["host", "origin", "cookie", "content-length", "accept-encoding"].includes(
        l,
      ) ||
      l.startsWith("x-forwarded-") ||
      l.startsWith("sec-fetch-")
    )
      continue;
    out[k] = v;
  }
  return out;
}

const variants: Variant[] = [
  {
    name: "1_ship_hygiene_shape",
    note: "what proxyWebappRequest actually sends today (origin+xfh+cookie+sec-fetch all stripped)",
    headers: stripAll(base),
  },
  {
    name: "2_origin_matches_upstream_host",
    note: "control: a first-party dev server in the browser",
    headers: { ...stripAll(base), origin: "http://127.0.0.1:3399" },
  },
  {
    name: "3_origin_preview_mismatch",
    note: "forward the browser Origin verbatim WITHOUT rewriting host",
    headers: { ...stripAll(base), origin: PREVIEW },
  },
  {
    name: "4_origin_preview_plus_xfh",
    note: "forward Origin AND inject x-forwarded-host/proto = preview authority",
    headers: {
      ...stripAll(base),
      origin: PREVIEW,
      "x-forwarded-host": PREVIEW_AUTHORITY,
      "x-forwarded-proto": "http",
    },
  },
  {
    name: "5_origin_foreign",
    note: "attack shape: unrelated Origin, no allowlist entry",
    headers: { ...stripAll(base), origin: "http://evil.test" },
  },
  {
    name: "6_ship_hygiene_plus_platform_cookie",
    note: "hygiene shape but the platform cookie is NOT stripped (control for AC3)",
    headers: {
      ...stripAll(base),
      cookie: "openbot_platform_session=PLATFORM-SECRET-DO-NOT-LEAK",
    },
  },
];

const body = req0.post_data ?? "[]";
const results: Record<string, unknown>[] = [];
for (const v of variants) {
  const res = await fetch(UPSTREAM, {
    method: "POST",
    headers: v.headers,
    body,
    redirect: "manual",
  });
  const text = await res.text();
  results.push({
    variant: v.name,
    note: v.note,
    sent_origin: v.headers.origin ?? "ABSENT",
    sent_xfh: v.headers["x-forwarded-host"] ?? "ABSENT",
    status: res.status,
    action_ok: text.includes("action-ok-"),
    csrf_reject_in_body:
      text.includes("Invalid Server Actions request") ||
      text.includes("does not match") ||
      text.includes("Missing `origin`"),
    header_echo:
      (text.match(/\{\\?"origin.{0,320}/s) ?? ["not-in-body"])[0].slice(0, 340),
    set_cookie: res.headers.getSetCookie(),
    x_action_redirect: res.headers.get("x-action-redirect") ?? "NONE",
    body_head: text.slice(0, 120).replace(/\s+/g, " "),
  });
  await Bun.sleep(150);
}

const out = {
  upstream: UPSTREAM,
  captured_action_id: base["next-action"],
  captured_body_len: String(body).length,
  results,
  at: new Date().toISOString(),
};
await Bun.write(OUT, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));

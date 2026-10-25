// T12 live-stack auth bootstrap: create (or reuse) the email/password admin the demos sign in as.
const base = process.env.T12_SERVER ?? "http://localhost:3321";
const creds = { email: "t12-admin@test.local", password: "T12-Accept-2026!", name: "T12 Admin" };
async function post(path: string, body: unknown) {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://localhost:3322" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, cookie: res.headers.getSetCookie?.() ?? [], text };
}
let r = await post("/api/auth/sign-up/email", creds);
if (r.status !== 200) r = await post("/api/auth/sign-in/email", { email: creds.email, password: creds.password });
const cookie = r.cookie.map((c) => c.split(";")[0]).join("; ");
const parsed = JSON.parse(r.text || "{}");
const userId = parsed.user?.id ?? parsed.session?.userId;
console.log(JSON.stringify({ status: r.status, userId, cookieLen: cookie.length }, null, 1));
await Bun.write("/tmp/t12-auth.json", JSON.stringify({ userId, cookie }));

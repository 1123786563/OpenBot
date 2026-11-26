import { setTimeout as delay } from "node:timers/promises";

const inputs = [
  "INITIAL_ADMIN_EMAIL",
  "INITIAL_ADMIN_PASSWORD",
  "INITIAL_ADMIN_FIRST_NAME",
  "INITIAL_ORG_NAME",
];
if (inputs.every((name) => !process.env[name])) process.exit(0);
if (inputs.some((name) => !process.env[name]))
  throw new Error("Fill all four Infisical administrator fields");

const origin = "http://backend:8080/api/v1/admin";
let config;
for (let attempt = 0; attempt < 60; attempt++) {
  try {
    const response = await fetch(origin + "/config", {
      signal: AbortSignal.timeout(4000),
    });
    if (response.ok) {
      ({ config } = await response.json());
      break;
    }
  } catch {
    // The API may still be running database migrations.
  }
  await delay(2000);
}
if (!config) throw new Error("Infisical did not become ready");
if (!config.initialized) {
  const response = await fetch(origin + "/signup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: process.env.INITIAL_ADMIN_EMAIL,
      password: process.env.INITIAL_ADMIN_PASSWORD,
      firstName: process.env.INITIAL_ADMIN_FIRST_NAME,
      organizationName: process.env.INITIAL_ORG_NAME,
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok)
    throw new Error(
      `Infisical admin setup failed (HTTP ${response.status}). Check the administrator fields and retry.`,
    );
}

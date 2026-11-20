import { z } from "zod";
import { createDatabase } from "../db/client";
import { createPersonalSaasApp } from "./app";

const httpsUrl = z.url({ protocol: /^https$/ }).refine((value) => {
  const url = new URL(value);
  return !url.username && !url.password && !url.hash;
});

const trial = z.object({
  OPENBOT_PERSONAL_SAAS_MODE: z.literal("private-trial"),
  OPENBOT_PERSONAL_SAAS_URL: httpsUrl.refine(
    (value) => new URL(value).href === `${new URL(value).origin}/`,
  ),
  CASDOOR_ISSUER: httpsUrl,
  CASDOOR_DISCOVERY_URL: httpsUrl,
  CASDOOR_ACCOUNT_STATUS_URL: httpsUrl,
  CASDOOR_CLIENT_ID: z.string().trim().min(1),
  CASDOOR_CLIENT_SECRET: z.string().trim().min(1),
  KEY_ENCRYPTION_KEY: z
    .base64()
    .refine(
      (value) =>
        Buffer.from(value, "base64").length === 32 &&
        value !== Buffer.alloc(32).toString("base64"),
    ),
  OPENBOT_SUSPENSION_OPERATOR_ID: z.string().trim().min(1).optional(),
  OPENBOT_SUSPENSION_OPERATOR_TOKEN: z
    .string()
    .regex(/^[A-Za-z0-9_-]{43}$/)
    .optional(),
  OPENBOT_SUSPENSION_SUPPORT_EMAIL: z.email().optional(),
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
});

const result = trial.safeParse(process.env);
if (!result.success) {
  throw new Error(
    `Invalid Personal SaaS trial configuration: ${result.error.issues.map((issue) => issue.path.join(".")).join(", ")}`,
  );
}
const env = result.data;
const operatorId = env.OPENBOT_SUSPENSION_OPERATOR_ID;
const operatorToken = env.OPENBOT_SUSPENSION_OPERATOR_TOKEN;
const suspensionSupport = env.OPENBOT_SUSPENSION_SUPPORT_EMAIL;
if (
  [operatorId, operatorToken, suspensionSupport].some(Boolean) &&
  !(operatorId && operatorToken && suspensionSupport)
)
  throw new Error(
    "Configure the suspension operator ID, token and support email together",
  );

const app = createPersonalSaasApp(
  {
    origin: new URL(env.OPENBOT_PERSONAL_SAAS_URL).origin,
    encryptionKey: env.KEY_ENCRYPTION_KEY,
    suspensionOperator:
      operatorId && operatorToken
        ? { id: operatorId, token: operatorToken }
        : undefined,
    suspensionSupport,
    casdoor: {
      issuer: env.CASDOOR_ISSUER,
      discoveryUrl: new URL(env.CASDOOR_DISCOVERY_URL),
      accountStatusUrl: new URL(env.CASDOOR_ACCOUNT_STATUS_URL),
      clientId: env.CASDOOR_CLIENT_ID,
      clientSecret: env.CASDOOR_CLIENT_SECRET,
    },
  },
  createDatabase(env.DATABASE_URL),
);

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: env.PORT,
  fetch: app.fetch,
});
console.info(
  JSON.stringify({
    type: "personal-saas-trial-listening",
    url: server.url.href,
  }),
);

async function refreshAccounts() {
  try {
    await app.refreshAccounts();
  } catch {
    console.warn(
      JSON.stringify({ type: "personal-saas-account-refresh-failure" }),
    );
  } finally {
    setTimeout(refreshAccounts, 1_000);
  }
}

void refreshAccounts();

import { inArray } from "drizzle-orm";
import { z } from "zod";
import { configureBotLifecycle } from "../agents/lifecycle";
import { createDatabase } from "../db/client";
import { personalWorkspaceClosures } from "../db/schema";
import { repeatAfterEach } from "../work/loop";
import { createPersonalSaasApp } from "./app";
import {
  cleanupSteps,
  closureCleanupClient,
  closureRestoreJournal,
} from "./closure-cleanup-contract";
import { workspaceQuotaConfig } from "./quotas";
import { reapplyWorkspaceClosures } from "./workspace-cleanup";

const httpsUrl = z.url({ protocol: /^https$/ }).refine((value) => {
  const url = new URL(value);
  return !url.username && !url.password && !url.hash;
});

const trial = z.object({
  OPENBOT_PERSONAL_SAAS_MODE: z.literal("private-trial"),
  OPENBOT_WORKSPACE_ADMISSIONS_PAUSED: z
    .enum(["true", "false"])
    .default("false"),
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
  OPENBOT_SUPPORT_SUBJECTS: z
    .string()
    .optional()
    .transform(
      (value) =>
        value
          ?.split(",")
          .map((subject) => subject.trim())
          .filter(Boolean) ?? [],
    ),
  OPENBOT_SUSPENSION_OPERATOR_ID: z.string().trim().min(1).optional(),
  OPENBOT_SUSPENSION_OPERATOR_TOKEN: z
    .string()
    .regex(/^[A-Za-z0-9_-]{43}$/)
    .optional(),
  OPENBOT_SUSPENSION_SUPPORT_EMAIL: z.email().optional(),
  OPENBOT_WORKSPACE_COMPUTER_SUPERVISOR_URL: z
    .url({ protocol: /^https?$/ })
    .optional(),
  OPENBOT_WORKSPACE_COMPUTER_SUPERVISOR_TOKEN: z
    .string()
    .trim()
    .min(1)
    .optional(),
  OPENBOT_CLOSURE_CLEANUP_URL: httpsUrl.optional(),
  OPENBOT_CLOSURE_CLEANUP_TOKEN: z.string().trim().min(1).optional(),
  OPENBOT_CLOSURE_RESTORE_JOURNAL: z.string().trim().min(1).optional(),
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

const supervisorUrl = env.OPENBOT_WORKSPACE_COMPUTER_SUPERVISOR_URL;
const supervisorToken = env.OPENBOT_WORKSPACE_COMPUTER_SUPERVISOR_TOKEN;
if (Boolean(supervisorUrl) !== Boolean(supervisorToken))
  throw new Error(
    "Configure the workspace Computer supervisor URL and token together",
  );

const cleanupUrl = env.OPENBOT_CLOSURE_CLEANUP_URL;
const cleanupToken = env.OPENBOT_CLOSURE_CLEANUP_TOKEN;
if (Boolean(cleanupUrl) !== Boolean(cleanupToken))
  throw new Error("Configure the closure cleanup URL and token together");

const database = createDatabase(env.DATABASE_URL);
const restoreJournal = env.OPENBOT_CLOSURE_RESTORE_JOURNAL;
const restoredClosures = restoreJournal
  ? closureRestoreJournal.parse(await Bun.file(restoreJournal).json())
  : [];
if (restoreJournal) await reapplyWorkspaceClosures(database, restoredClosures);
configureBotLifecycle({ database });
const botRuntime =
  process.env.OPENBOT_PERSONAL_SAAS_BOT_EXECUTION === "on"
    ? await import("eventsource").then(async () =>
        (await import("./bot-runtime")).createPersonalBotRuntime(database),
      )
    : undefined;
const app = createPersonalSaasApp(
  {
    admissionsPaused: env.OPENBOT_WORKSPACE_ADMISSIONS_PAUSED === "true",
    closureCleanup:
      cleanupUrl && cleanupToken
        ? closureCleanupClient(cleanupUrl, cleanupToken)
        : undefined,
    origin: new URL(env.OPENBOT_PERSONAL_SAAS_URL).origin,
    encryptionKey: env.KEY_ENCRYPTION_KEY,
    supportSubjects: env.OPENBOT_SUPPORT_SUBJECTS,
    botRuntime,
    quotas: workspaceQuotaConfig.parse({
      bot: process.env.OPENBOT_PERSONAL_QUOTA_BOT_RUNS,
      computer: process.env.OPENBOT_PERSONAL_QUOTA_COMPUTERS,
      storage:
        process.env.OPENBOT_PERSONAL_QUOTA_STORAGE_BYTES ??
        process.env.OPENBOT_PERSONAL_QUOTA_ATTACHMENT_BYTES,
      computerStorage:
        process.env.OPENBOT_PERSONAL_QUOTA_COMPUTER_STORAGE_BYTES,
      automation: process.env.OPENBOT_PERSONAL_QUOTA_TRIGGERS_PER_MINUTE,
    }),
    inboundRelayToken: process.env.OPENBOT_PERSONAL_SAAS_INBOUND_RELAY_TOKEN,
    suspensionOperator:
      operatorId && operatorToken
        ? { id: operatorId, token: operatorToken }
        : undefined,
    suspensionSupport,
    computer:
      supervisorUrl && supervisorToken
        ? { supervisorUrl, supervisorToken }
        : undefined,
    casdoor: {
      issuer: env.CASDOOR_ISSUER,
      discoveryUrl: new URL(env.CASDOOR_DISCOVERY_URL),
      accountStatusUrl: new URL(env.CASDOOR_ACCOUNT_STATUS_URL),
      clientId: env.CASDOOR_CLIENT_ID,
      clientSecret: env.CASDOOR_CLIENT_SECRET,
    },
  },
  database,
);

if (restoredClosures.length) {
  await app.sweepWorkspaceClosures();
  const records = await database
    .select({ cleanup: personalWorkspaceClosures.cleanup })
    .from(personalWorkspaceClosures)
    .where(
      inArray(
        personalWorkspaceClosures.id,
        restoredClosures.map(({ id }) => id),
      ),
    );
  if (
    records.length !== restoredClosures.length ||
    records.some(({ cleanup }) =>
      cleanupSteps.some((step) => cleanup[step]?.status !== "confirmed"),
    )
  )
    throw new Error(
      "Closure recovery is incomplete. Keep the recovery environment offline.",
    );
}

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

const renewComputers = app.renewWorkspaceComputers;
if (renewComputers) {
  async function maintainComputerLeases() {
    try {
      await renewComputers?.();
    } catch {
      console.warn(
        JSON.stringify({ type: "workspace-computer-lease-renewal-failure" }),
      );
    } finally {
      setTimeout(maintainComputerLeases, 1_000);
    }
  }
  void maintainComputerLeases();
}
repeatAfterEach(async () => {
  try {
    await app.sweepWorkspaceClosures();
  } catch {
    console.warn(JSON.stringify({ type: "workspace-closure-sweep-failure" }));
  }
}, 1_000);
repeatAfterEach(async () => {
  try {
    await app.sweepBotWork();
  } catch {
    console.warn(
      JSON.stringify({ type: "personal-saas-bot-work-sweep-failure" }),
    );
  }
}, 1_000);

if (botRuntime)
  repeatAfterEach(async () => {
    try {
      await app.sweepBotDecisions();
    } catch {
      console.warn(
        JSON.stringify({ type: "personal-saas-bot-decision-sweep-failure" }),
      );
    }
  }, 1_000);

for (const [task, sweep] of [
  ["schedule", app.offerAutomationSchedules],
  ["routine", app.sweepAutomationRoutines],
  ["inbound", app.sweepAutomationInbound],
] as const) {
  repeatAfterEach(async () => {
    try {
      await sweep();
    } catch {
      console.warn(
        JSON.stringify({
          type: "personal-saas-automation-sweep-failure",
          task,
        }),
      );
    }
  }, 1_000);
}

for (const [task, sweep] of Object.entries(app.backgroundWorkers ?? {})) {
  repeatAfterEach(async () => {
    try {
      await sweep();
    } catch {
      console.warn(
        JSON.stringify({
          type: "personal-saas-background-sweep-failure",
          task,
        }),
      );
    }
  }, 1_000);
}

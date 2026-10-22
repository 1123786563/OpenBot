/**
 * Shared MT044 fixture (Issue #87, inbound ownership attribution).
 *
 * Wraps the verified MT042 scan-executor fixture (restricted-role connections,
 * real scope issuance, real gate, real job-ownership service) and adds the
 * responsibilities trigger domain on the platform connection: real trigger
 * store with the credential vault, real responsibility store, the MT044
 * attribution service over the directory/operator channels, the enterprise
 * ingest seam, and the public ingress routes (HTTP trigger ingress + inbound
 * email) wired with that seam. Nothing here mocks the authorization path.
 */

import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { createCredentialStore } from "../../../src/credentials";
import { createDatabase, type Database } from "../../../src/db/client";
import { agents } from "../../../src/db/schema/core";
import {
  responsibilityEvents,
  responsibilityRuns,
} from "../../../src/db/schema/responsibilities";
import { workItems } from "../../../src/db/schema/work";
import {
  createInboundAttributionService,
  createInboundEnterpriseIngest,
} from "../../../src/enterprise/tenancy/inbound-attribution";
import {
  createEmailTriggerRoutes,
  type InboundEmailConfig,
  type SnsMessage,
} from "../../../src/responsibilities/email";
import { createResponsibilityStore } from "../../../src/responsibilities/store";
import {
  createTriggerIngressRoutes,
  type InboundAttributionSeam,
} from "../../../src/responsibilities/trigger-routes";
import { createTriggerStore } from "../../../src/responsibilities/triggers";
import type { ResponsibilityStore } from "../../../src/responsibilities/types";
import { enterpriseTestDatabaseUrlFrom } from "../../support/enterprise-database";
import { createScanExecutorFixture, type ScanFixture } from "./scan-executor";

export interface InboundAttributionFixture {
  readonly scan: ScanFixture;
  readonly store: ResponsibilityStore;
  readonly triggers: ReturnType<typeof createTriggerStore>;
  /** The MT044 seam exactly as the assembly would install it on the ingress routes. */
  readonly seam: InboundAttributionSeam;
  readonly ingress: ReturnType<typeof createTriggerIngressRoutes>;
  readonly emailRoutes: ReturnType<typeof createEmailTriggerRoutes>;
  /** Platform connection the responsibilities domain runs on (separate pool from the scan queue). */
  readonly responsibilities: Database;
  /** The identity every attributed trigger belongs to (company-a / team-a1 member). */
  readonly owner: {
    readonly userId: string;
    readonly principalId: string;
    readonly tenantId: string;
    readonly workspaceId: string;
    readonly companyB: {
      readonly tenantId: string;
      readonly workspaceId: string;
    };
  };
  /** A responsibility + webhook trigger pair attributed to company-a/team-a1. */
  enterpriseWebhookTrigger(
    label: string,
    attribution?: { tenantId: string; workspaceId: string },
  ): Promise<{
    responsibilityId: string;
    triggerId: string;
    secret: string;
  }>;
  /** A responsibility + email trigger pair attributed to company-a/team-a1. */
  enterpriseEmailTrigger(label: string): Promise<{
    responsibilityId: string;
    triggerId: string;
  }>;
  /** A responsibility + webhook trigger pair with NO mapping columns (the legacy personal kind). */
  personalWebhookTrigger(label: string): Promise<{
    responsibilityId: string;
    triggerId: string;
    secret: string;
  }>;
  /** Restores a suspended company membership (fixture hygiene between tests, platform channel). */
  restoreCompanyMembership(tenantId: string): Promise<void>;
  /** POSTs one authenticated webhook delivery to the public trigger ingress. */
  postWebhook(
    triggerId: string,
    secret: string,
    payload: Record<string, unknown>,
    idempotencyKey: string,
  ): Promise<Response>;
  /** POSTs one (signature-verified by the test stub) SNS email notification. */
  postEmail(input: {
    messageId: string;
    recipient: string;
    from: string;
    subject?: string;
  }): Promise<Response>;
  /** The rows a delivery must never write when it lands in quarantine instead. */
  businessRowsOf(input: { triggerId: string; deliveryId: string }): Promise<{
    events: number;
    runs: number;
    scanItems: number;
    personalItems: number;
  }>;
  dispose(): Promise<void>;
}

export const EMAIL_DOMAIN = "inbound.mt044.test";
const EMAIL_TOPIC_ARN = "arn:aws:sns:us-east-1:000000000000:mt044-inbound";

export async function createInboundAttributionFixture(): Promise<InboundAttributionFixture> {
  const scan = await createScanExecutorFixture();
  const responsibilities = createDatabase(enterpriseTestDatabaseUrlFrom(), {
    max: 2,
  }) as Database;
  const credentialStore = createCredentialStore(responsibilities);
  const botId = `mt044-bot-${randomUUID()}`;
  const channelId = `mt044-channel-${randomUUID()}`;
  const ownerUserId = scan.jobs.isolation.ids["user-a1-member"]!;
  await responsibilities.insert(agents).values({
    id: botId,
    name: "MT044 inbound trigger Bot",
    type: "built_in",
    configuration: {},
  });
  // One stable thread per (owner, bot, channel): beginRun re-resolves the
  // target and skips the run when the thread drifts (real store semantics), so
  // the fixture must answer the same threadId it answered at creation.
  const threads = new Map<string, string>();
  const store = createResponsibilityStore(responsibilities, {
    resolveTarget: async (owner, bot, channel) => {
      if (owner !== ownerUserId || bot !== botId || channel !== channelId)
        return null;
      const key = `${owner}:${bot}:${channel}`;
      const threadId = threads.get(key) ?? `mt044-thread-${randomUUID()}`;
      threads.set(key, threadId);
      return { threadId };
    },
  });
  const triggers = createTriggerStore(responsibilities, {
    store: credentialStore,
    reader: credentialStore,
    encryptionKey: Buffer.alloc(32, 11).toString("base64"),
  });
  const attributionService = createInboundAttributionService({
    platform: responsibilities,
    directory: scan.jobs.directory,
    operator: scan.jobs.operator,
  });
  const enterpriseIngest = createInboundEnterpriseIngest({
    store,
    jobs: scan.service,
    basisOf: ({ triggerId }) => ({
      companyRevision: 1,
      overrideRevision: null,
      document: { trigger: triggerId, basis: "mt044-inbound" },
    }),
  });
  const seam: InboundAttributionSeam = {
    resolve: (trigger) => attributionService.resolveTrigger(trigger),
    ingestEnterprise: ({ trigger, attribution, delivery }) =>
      enterpriseIngest({
        ownerUserId: trigger.ownerUserId,
        responsibilityId: trigger.responsibilityId,
        triggerId: trigger.id,
        source: trigger.kind,
        attribution,
        delivery,
      }),
    quarantine: (input) => attributionService.quarantine(input),
  };
  const ingress = createTriggerIngressRoutes({
    directory: triggers.directory,
    ingest: (event) => store.ingestEvent(event),
    attribution: seam,
  });
  const emailConfig: InboundEmailConfig = {
    domain: EMAIL_DOMAIN,
    topicArns: [EMAIL_TOPIC_ARN],
  };
  const emailRoutes = createEmailTriggerRoutes({
    directory: triggers.directory,
    ingest: (event) => store.ingestEvent(event),
    attribution: seam,
    config: emailConfig,
    // The SNS signature scheme has its own verified suite; this fixture's
    // subject is attribution, so verification is a standing allow.
    verify: async () => true,
    confirmSubscription: async () => ({}),
  });

  const owner = {
    userId: ownerUserId,
    principalId: scan.jobs.isolation.ids["principal-a1-member"]!,
    tenantId: scan.jobs.isolation.ids["company-a"]!,
    workspaceId: scan.jobs.isolation.ids["team-a1"]!,
    companyB: {
      tenantId: scan.jobs.isolation.ids["company-b"]!,
      workspaceId: scan.jobs.isolation.ids["team-b1"]!,
    },
  };

  async function responsibility(label: string) {
    return store.create(ownerUserId, {
      agentId: botId,
      channelId,
      title: `MT044 inbound triage (${label})`,
      instruction: "Triage the inbound delivery.",
      successCriteria: "A reply is posted.",
    });
  }

  return {
    scan,
    store,
    triggers,
    seam,
    ingress,
    emailRoutes,
    responsibilities,
    owner,

    async enterpriseWebhookTrigger(label, attribution) {
      const goal = await responsibility(label);
      const created = await triggers.create(ownerUserId, goal.id, {
        config: { kind: "webhook", filter: { eventTypes: ["deploy"] } },
        attribution: attribution ?? {
          tenantId: owner.tenantId,
          workspaceId: owner.workspaceId,
        },
      });
      if (!created.secret) throw new Error("Webhook trigger has no secret.");
      return {
        responsibilityId: goal.id,
        triggerId: created.trigger.id,
        secret: created.secret,
      };
    },

    async enterpriseEmailTrigger(label) {
      const goal = await responsibility(label);
      const created = await triggers.create(ownerUserId, goal.id, {
        config: { kind: "email", allowedSenders: [] },
        attribution: {
          tenantId: owner.tenantId,
          workspaceId: owner.workspaceId,
        },
      });
      return { responsibilityId: goal.id, triggerId: created.trigger.id };
    },

    async personalWebhookTrigger(label) {
      const goal = await responsibility(label);
      const created = await triggers.create(ownerUserId, goal.id, {
        config: { kind: "webhook", filter: { eventTypes: ["deploy"] } },
      });
      if (!created.secret) throw new Error("Webhook trigger has no secret.");
      return {
        responsibilityId: goal.id,
        triggerId: created.trigger.id,
        secret: created.secret,
      };
    },

    async restoreCompanyMembership(tenantId) {
      await responsibilities.execute(
        sql`update enterprise_memberships set status = 'active' where tenant_id = ${tenantId} and principal_id = ${owner.principalId}`,
      );
    },

    async postWebhook(triggerId, secret, payload, idempotencyKey) {
      return ingress.fetch(
        new Request(`https://openbot.test/${triggerId}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${secret}`,
            "idempotency-key": idempotencyKey,
          },
          body: JSON.stringify(payload),
        }),
      );
    },

    async postEmail({ messageId, recipient, from, subject }) {
      const notification = {
        notificationType: "Received",
        mail: {
          messageId,
          source: from,
          destination: [recipient],
          commonHeaders: {
            from: [from],
            to: [recipient],
            subject: subject ?? "Deploy note",
          },
        },
        receipt: { recipients: [recipient], dkimVerdict: { status: "PASS" } },
        content: `Subject: note\r\n\r\n${subject ?? "deploy finished"}`,
      };
      const message: SnsMessage = {
        Type: "Notification",
        MessageId: `sns-${messageId}`,
        TopicArn: EMAIL_TOPIC_ARN,
        Message: JSON.stringify(notification),
        Timestamp: new Date().toISOString(),
        SignatureVersion: "2",
        Signature: "test-stub",
        SigningCertURL: "https://sns.us-east-1.amazonaws.com/test.pem",
      };
      return emailRoutes.fetch(
        new Request("https://openbot.test/sns", {
          method: "POST",
          headers: { "content-type": "text/json" },
          body: JSON.stringify(message),
        }),
      );
    },

    /** The rows a delivery must never write when it lands in quarantine instead. */
    async businessRowsOf({ triggerId, deliveryId }) {
      const externalId = `${triggerId}:${deliveryId}`.slice(0, 256);
      const events = await responsibilities
        .select({ id: responsibilityEvents.id })
        .from(responsibilityEvents)
        .where(eq(responsibilityEvents.externalId, externalId));
      const runs = events.length
        ? await responsibilities
            .select({ id: responsibilityRuns.id })
            .from(responsibilityRuns)
            .where(
              inArray(
                responsibilityRuns.eventId,
                events.map((event) => event.id),
              ),
            )
        : [];
      const scanItems = await responsibilities
        .select({ key: workItems.key })
        .from(workItems)
        .where(
          and(
            eq(workItems.kind, "enterprise.job.due"),
            inArray(
              workItems.key,
              runs.length ? runs.map((run) => `run:${run.id}`) : ["none"],
            ),
          ),
        );
      const personalItems = runs.length
        ? await responsibilities
            .select({ key: workItems.key })
            .from(workItems)
            .where(
              and(
                eq(workItems.kind, "responsibility.run"),
                inArray(
                  workItems.key,
                  runs.map((run) => run.id),
                ),
              ),
            )
        : [];
      return {
        events: events.length,
        runs: runs.length,
        scanItems: scanItems.length,
        personalItems: personalItems.length,
      };
    },

    async dispose() {
      const failures: unknown[] = [];
      // work_items do not cascade with users; close this run's scan rows first.
      try {
        await responsibilities
          .delete(workItems)
          .where(eq(workItems.kind, "enterprise.job.due"));
      } catch (error) {
        failures.push(error);
      }
      try {
        await responsibilities.delete(agents).where(eq(agents.id, botId));
      } catch (error) {
        failures.push(error);
      }
      try {
        await responsibilities.$client.close();
      } catch (error) {
        failures.push(error);
      }
      try {
        await scan.dispose();
      } catch (error) {
        failures.push(error);
      }
      if (failures.length)
        throw new AggregateError(failures, "Inbound fixture disposal failed.");
    },
  };
}

export type { ScanFixture };

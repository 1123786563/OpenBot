import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  catalogSchema,
  pilotCatalogKey,
  type ReleasedBifrostRoute,
  view,
} from "../admin/bifrost-catalog";
import type { Database } from "../db/client";
import {
  billingApplications,
  billingPilotSignoffs,
  enterpriseSettings,
  pilotProviderCostLimits,
} from "../db/schema";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
const label = z.string().trim().min(1).max(256);
const reference = z.string().trim().min(1).max(1024);
const microcredits = z
  .string()
  .regex(/^[1-9]\d{0,18}$/)
  .refine((value) => BigInt(value) <= 9223372036854775807n);
const evidenceKind = z.enum(["fixture", "deployment"]);
const paymentChannel = z.enum(["alipay", "wechat"]);
const deployment = z.object({
  evidence: evidenceKind,
  deploymentId: label,
  buildVersion: label,
  imageDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
});
export type PilotDeployment = Partial<z.infer<typeof deployment>> & {
  evidence: z.infer<typeof evidenceKind>;
};

const common = deployment.extend({
  approvedBy: label,
  pauseOwner: label,
  accountIds: z.array(z.uuid().transform((id) => id.toLowerCase())).min(1),
  deploymentRef: reference,
});
const signedRoute = z.strictObject({
  id: label,
  revision: z.uuid(),
  provider: label,
  resourceType: z.literal("chat"),
  reconciliationRef: reference,
  supplierCapMicrocredits: microcredits,
  maxOperationMicrocredits: microcredits,
});
const signoff = z.discriminatedUnion("kind", [
  common.strict().extend({
    kind: z.literal("application"),
    id: label,
    pathRef: reference,
    rampRef: reference,
    routes: z
      .array(signedRoute)
      .min(1)
      .refine(
        (routes) => new Set(routes.map(({ id }) => id)).size === routes.length,
      ),
  }),
  common.strict().extend({
    kind: z.literal("channel"),
    id: paymentChannel,
    merchant: label,
    maxOrderCents: z.number().int().positive().max(2147483647),
    paymentRef: reference,
    refundRef: reference,
    reconciliationRef: reference,
    rulesRef: reference,
  }),
]);
type Signoff = z.infer<typeof signoff>;
type ApplicationSignoff = Extract<Signoff, { kind: "application" }>;

function signoffKey(
  kind: Signoff["kind"],
  id: string,
  evidence: PilotDeployment["evidence"],
) {
  return and(
    eq(billingPilotSignoffs.kind, kind),
    eq(billingPilotSignoffs.id, id),
    eq(billingPilotSignoffs.evidence, evidence),
  );
}

export function createPilotSignoffs(database: Database) {
  return {
    list: () =>
      database
        .select()
        .from(billingPilotSignoffs)
        .orderBy(
          billingPilotSignoffs.kind,
          billingPilotSignoffs.id,
          billingPilotSignoffs.evidence,
        ),
    async record(input: unknown) {
      const record = signoff.parse(input);
      if (
        record.evidence === "deployment" &&
        record.kind === "channel" &&
        record.merchant.startsWith("fixture-")
      )
        throw new Error(
          "A fixture merchant cannot receive deployment signoff.",
        );
      const { kind, id, evidence } = record;
      return database.transaction(async (tx) => {
        if (kind === "application") {
          const [app] = await tx
            .select({ id: billingApplications.id })
            .from(billingApplications)
            .where(eq(billingApplications.id, id))
            .for("share");
          if (!app)
            throw new Error(
              "Register the application before recording signoff.",
            );
        }
        const [row] = await tx
          .insert(billingPilotSignoffs)
          .values({ kind, id, evidence, record })
          .onConflictDoUpdate({
            target: [
              billingPilotSignoffs.kind,
              billingPilotSignoffs.id,
              billingPilotSignoffs.evidence,
            ],
            set: { record, signedAt: sql`now()` },
          })
          .returning();
        return row;
      });
    },
    async setChannelPause(
      channel: string,
      evidence: string,
      by: string | null,
    ) {
      const actor = by === null ? null : label.parse(by);
      const [row] = await database
        .update(billingPilotSignoffs)
        .set({ pausedBy: actor, pausedAt: actor === null ? null : sql`now()` })
        .where(
          signoffKey(
            "channel",
            paymentChannel.parse(channel),
            evidenceKind.parse(evidence),
          ),
        )
        .returning();
      if (!row) throw new Error("This channel has no signoff record.");
      return row;
    },
  };
}

export async function readPilotRoutes(
  database: Database | Transaction,
  lock = false,
) {
  const query = database
    .select({ value: enterpriseSettings.value })
    .from(enterpriseSettings)
    .where(eq(enterpriseSettings.key, pilotCatalogKey));
  const [row] = await (lock ? query.for("share") : query);
  return row && view(catalogSchema.parse(row.value));
}

export async function eligibleSignoff(
  tx: Transaction,
  scope: PilotDeployment,
  kind: Signoff["kind"],
  id: string,
  accountId: string,
) {
  const [row] = await tx
    .select()
    .from(billingPilotSignoffs)
    .where(signoffKey(kind, id, scope.evidence))
    .for("share");
  const parsed = signoff.safeParse(row?.record);
  if (!parsed.success || row?.pausedAt) return;
  const record = parsed.data;
  if (
    record.kind === kind &&
    record.id === id &&
    record.evidence === scope.evidence &&
    record.deploymentId === scope.deploymentId &&
    record.buildVersion === scope.buildVersion &&
    record.imageDigest === scope.imageDigest &&
    record.accountIds.includes(accountId)
  )
    return record;
}

export function signedSupplier(
  record: ApplicationSignoff,
  route: ReleasedBifrostRoute,
  limit: bigint | undefined,
  bound: bigint,
) {
  const supplier = record.routes.find(({ id }) => id === route.id);
  return (
    supplier !== undefined &&
    route.purpose !== "embedding" &&
    supplier.provider === route.provider &&
    supplier.revision === route.revision &&
    limit !== undefined &&
    limit > 0n &&
    limit <= BigInt(supplier.supplierCapMicrocredits) &&
    bound <= limit &&
    bound <= BigInt(supplier.maxOperationMicrocredits)
  );
}

export async function signedApplication(
  tx: Transaction,
  scope: PilotDeployment,
  id: string,
  accountId: string,
  route: ReleasedBifrostRoute,
  limit: bigint | undefined,
  bound: bigint,
) {
  const record = await eligibleSignoff(tx, scope, "application", id, accountId);
  return (
    record?.kind === "application" &&
    signedSupplier(record, route, limit, bound)
  );
}

export async function currentRouteLimit(tx: Transaction, id: string) {
  const [row] = await tx
    .select({ limit: pilotProviderCostLimits.limitMicrocredits })
    .from(pilotProviderCostLimits)
    .where(eq(pilotProviderCostLimits.path, id))
    .for("share");
  return row?.limit;
}

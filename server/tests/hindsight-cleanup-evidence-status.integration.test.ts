import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "../../tests/support/bun-test-compat";
import { createDatabase, type Database } from "../src/db/client";
import { users } from "../src/db/schema/core";
import {
  enterpriseMemberships,
  enterprisePrincipals,
  enterpriseTenants,
} from "../src/db/schema/enterprise-tenancy";
import { hindsightRevocations } from "../src/db/schema/hindsight-revocations";
import { createCleanupEvidenceService } from "../src/hindsight/cleanup-evidence";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * FIX-OCR3 (O3-M5): the pure-read observedAt. The status read (RA2-5) answers from the rows'
 * LAST recorded observations, and the observation a cleared claim may cite is the latest
 * verification of a CLEARED row — an outstanding row's verify time proves nothing about any
 * cleared document, and letting it stand in dated the claim with a moment that belonged to
 * somebody else's leg. On BASE a confirmed-but-never-verified document inherited an
 * outstanding row's verifiedAt as its own observation.
 */

const run = randomUUID().slice(0, 8);
const TENANT = `tn_obsm5-${run}`;
const PRINCIPAL = `prin_obsm5-${run}`;
const USER = `user_obsm5-${run}`;

let database: Database;

beforeAll(async () => {
  database = createDatabase(testDatabaseUrl(), TEST_POOL);
  await database
    .insert(users)
    .values({
      id: USER,
      email: `obsm5-${run}@example.test`,
      name: "Observed At",
    })
    .onConflictDoNothing();
  await database
    .insert(enterpriseTenants)
    .values({ id: TENANT, name: `observedAt ${run}`, status: "active" })
    .onConflictDoNothing();
  await database
    .insert(enterprisePrincipals)
    .values({ id: PRINCIPAL, userId: USER, status: "active" })
    .onConflictDoNothing();
  await database
    .insert(enterpriseMemberships)
    .values({ tenantId: TENANT, principalId: PRINCIPAL, role: "member" })
    .onConflictDoNothing();
});

afterAll(async () => {
  await database
    .delete(hindsightRevocations)
    .where(eq(hindsightRevocations.tenantId, TENANT));
  await database
    .delete(enterpriseMemberships)
    .where(eq(enterpriseMemberships.tenantId, TENANT));
  await database
    .delete(enterprisePrincipals)
    .where(eq(enterprisePrincipals.id, PRINCIPAL));
  await database
    .delete(enterpriseTenants)
    .where(eq(enterpriseTenants.id, TENANT));
  await database.delete(users).where(eq(users.id, USER));
  await database.$client.end();
});

/** One revocation-ledger row in whatever verify state the leg needs. */
async function seedRow(input: {
  id: string;
  documentId: string;
  deletionState: "pending" | "confirmed" | "failed";
  verifyState: "unverified" | "absent" | "present" | "unreachable";
  verifiedAt: Date | null;
}) {
  await database.insert(hindsightRevocations).values({
    tenantId: TENANT,
    id: input.id,
    principalId: PRINCIPAL,
    kind: "memory",
    subjectType: "preference",
    targetId: `row-${input.id}`,
    documentId: input.documentId,
    bankId: `bank-${input.id}`,
    bankKind: "user",
    blockedAt: new Date("2026-10-20T00:00:00.000Z"),
    deletionState: input.deletionState,
    verifyState: input.verifyState,
    verifiedAt: input.verifiedAt,
  });
}

/** The pure read only; no probe runs, so the config's transport half is never touched. */
const pureRead = () =>
  createCleanupEvidenceService(database, {
    apiUrl: "http://127.0.0.1:1/",
    serviceApiKey: "unused",
    assertionSecret: "unused",
  }).cleanupEvidenceStatus({
    tenantId: TENANT,
    principalId: PRINCIPAL,
    operationRetentionDays: null,
    reprobe: false,
  });

describe("FIX-OCR3 — the pure read's observedAt is the cleared rows' own observation", () => {
  test("an outstanding row's verifiedAt never dates the claim", async () => {
    // One cleared document nobody has verified yet, and one outstanding row verified later:
    // the old reduce took the outstanding row's moment as this claim's observation.
    const claimed = new Date("2026-10-21T08:00:00.000Z");
    await seedRow({
      id: "cleared-never-verified",
      documentId: `doc-cleared-${run}`,
      deletionState: "confirmed",
      verifyState: "unverified",
      verifiedAt: null,
    });
    await seedRow({
      id: "outstanding-verified",
      documentId: `doc-outstanding-${run}`,
      deletionState: "pending",
      verifyState: "absent",
      verifiedAt: claimed,
    });
    const status = await pureRead();
    expect(status.activeData.documents).toBe(2);
    expect(status.activeData.outstanding).toBe(1);
    // No cleared row was ever verified, so there is no observation to claim — not the
    // outstanding leg's verification moment.
    expect(status.activeData.observedAt).toBeNull();
  });

  test("a cleared row's own latest verification is still the observation", async () => {
    const verifiedAt = new Date("2026-10-22T09:30:00.000Z");
    await seedRow({
      id: "cleared-verified",
      documentId: `doc-verified-${run}`,
      deletionState: "confirmed",
      verifyState: "absent",
      verifiedAt,
    });
    const status = await pureRead();
    const cleared = status.activeData.observedAt?.getTime();
    expect(cleared).toBe(verifiedAt.getTime());
  });
});

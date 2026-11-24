import { expect, test } from "bun:test";
import {
  createWeKnoraIngestionBilling,
  type WeKnoraAuthorization,
  type WeKnoraLedger,
} from "../src/billing/weknora-ingestion";

type Op = {
  operationId: string;
  amount: bigint;
  state: "reserved" | "settled";
};

function fixture() {
  const operations = new Map<string, Op>();
  let available = 100n;
  const ledger: WeKnoraLedger = {
    async quote() {
      return {
        creditType: "test",
        priceVersion: "price-v1",
        route: "embed-v1",
        provider: "fixture",
        model: "embed",
        price: { inputPerMillion: 1_000_000, outputPerMillion: 0 },
        maxChargeMicrocredits: "20",
        usageDisclosure: "Usage can be charged after interruption.",
      };
    },
    async reserve(identity, input) {
      if (identity.subject !== "uploader")
        return { state: "denied", reason: "not_authorized" };
      if (available < BigInt(input.maxChargeMicrocredits))
        return { state: "denied", reason: "insufficient_credits" };
      available -= BigInt(input.maxChargeMicrocredits);
      const op = {
        operationId: input.operationId,
        amount: BigInt(input.maxChargeMicrocredits),
        state: "reserved" as const,
      };
      operations.set(input.operationId, op);
      return {
        state: "reserved",
        permit: `permit-${input.operationId}`,
        operation: op,
      };
    },
    async recordEvidence(_accountId, operationId, evidence) {
      const op = operations.get(operationId);
      if (!op) return undefined;
      return {
        operation: { ...op, state: "settled" as const },
        platformMicrocredits: "0",
        evidence,
      };
    },
    async settleRecorded(_accountId, operationId) {
      const op = operations.get(operationId);
      if (!op) return undefined;
      op.state = "settled";
      return op;
    },
  };
  return { ledger, operations };
}

function authorization(
  overrides: Partial<WeKnoraAuthorization> = {},
): WeKnoraAuthorization {
  return {
    id: "auth-1",
    applicationId: "weknora",
    issuer: "https://casdoor.example.test",
    subject: "uploader",
    resourceIds: ["kb-1"],
    expiresAt: new Date("2026-12-01T00:00:00Z"),
    maxMicrocredits: 40n,
    spentMicrocredits: 0n,
    revokedAt: null,
    ...overrides,
  };
}

test("WeKnora verifies app and Casdoor identity, reserves and settles against the uploader account", async () => {
  const { ledger } = fixture();
  const verified: string[] = [];
  const service = createWeKnoraIngestionBilling({
    ledger,
    now: () => new Date("2026-11-21T00:00:00Z"),
    verifyApplication: async (id) => {
      verified.push(`app:${id}`);
      return id === "weknora";
    },
    verifyUser: async (identity) => {
      verified.push(`user:${identity.subject}`);
      return identity.subject === "uploader";
    },
  });
  service.registerAuthorization(authorization());
  await expect(
    service.preflight({
      applicationId: "weknora",
      issuer: "https://casdoor.example.test",
      subject: "uploader",
      resourceId: "kb-1",
    }),
  ).resolves.toMatchObject({
    creditType: "test",
    maxChargeMicrocredits: "20",
    applicationId: "weknora",
  });
  const reserved = await service.reserve({
    operationId: "ingest-1",
    applicationId: "weknora",
    issuer: "https://casdoor.example.test",
    subject: "uploader",
    resourceId: "kb-1",
    maxChargeMicrocredits: "20",
  });
  expect(reserved.state).toBe("reserved");
  await expect(
    service.settle({
      operationId: "ingest-1",
      uploaderAccount: {
        issuer: "https://casdoor.example.test",
        subject: "uploader",
      },
      inputTokens: 12n,
      outputTokens: 0n,
    }),
  ).resolves.toMatchObject({ state: "settled" });
  expect(verified).toEqual([
    "app:weknora",
    "user:uploader",
    "app:weknora",
    "user:uploader",
  ]);
});

test("authorization refuses wrong app, user, resource, expiry, revocation and cap while preserving a resumable boundary", async () => {
  const { ledger } = fixture();
  let now = new Date("2026-11-21T00:00:00Z");
  const service = createWeKnoraIngestionBilling({ ledger, now: () => now });
  service.registerAuthorization(authorization({ maxMicrocredits: 20n }));
  for (const input of [
    { applicationId: "other" },
    { subject: "other" },
    { resourceId: "kb-2" },
  ]) {
    await expect(
      service.preflight({
        applicationId: input.applicationId ?? "weknora",
        issuer: "https://casdoor.example.test",
        subject: input.subject ?? "uploader",
        resourceId: input.resourceId ?? "kb-1",
      }),
    ).rejects.toMatchObject({ code: "not_authorized" });
  }
  now = new Date("2026-12-02T00:00:00Z");
  await expect(
    service.preflight({
      applicationId: "weknora",
      issuer: "https://casdoor.example.test",
      subject: "uploader",
      resourceId: "kb-1",
    }),
  ).rejects.toMatchObject({ code: "authorization_expired" });
  now = new Date("2026-11-21T00:00:00Z");
  service.revokeAuthorization("auth-1");
  await expect(
    service.reserve({
      operationId: "revoked",
      applicationId: "weknora",
      issuer: "https://casdoor.example.test",
      subject: "uploader",
      resourceId: "kb-1",
      maxChargeMicrocredits: "20",
    }),
  ).rejects.toMatchObject({ code: "authorization_revoked" });
  service.registerAuthorization(
    authorization({ id: "auth-2", maxMicrocredits: 20n }),
  );
  const first = await service.reserve({
    operationId: "first",
    applicationId: "weknora",
    issuer: "https://casdoor.example.test",
    subject: "uploader",
    resourceId: "kb-1",
    maxChargeMicrocredits: "20",
  });
  expect(first.state).toBe("reserved");
  await expect(
    service.reserve({
      operationId: "over-cap",
      applicationId: "weknora",
      issuer: "https://casdoor.example.test",
      subject: "uploader",
      resourceId: "kb-1",
      maxChargeMicrocredits: "1",
    }),
  ).rejects.toMatchObject({ code: "execution_limit" });
  await expect(
    service.resume({
      operationId: "resume",
      applicationId: "weknora",
      issuer: "https://casdoor.example.test",
      subject: "uploader",
      resourceId: "kb-1",
      maxChargeMicrocredits: "1",
      confirmedMaxMicrocredits: 40n,
    }),
  ).resolves.toMatchObject({ state: "reserved" });
});

test("preflight and cumulative cap are isolated per authorization and operation state is app-scoped", async () => {
  const { ledger } = fixture();
  const service = createWeKnoraIngestionBilling({
    ledger,
    now: () => new Date("2026-11-21T00:00:00Z"),
  });
  service.registerAuthorization(
    authorization({ id: "a", resourceIds: ["kb-a"], maxMicrocredits: 20n }),
  );
  service.registerAuthorization(
    authorization({
      id: "b",
      subject: "other",
      resourceIds: ["kb-b"],
      maxMicrocredits: 20n,
    }),
  );
  await expect(
    service.resume({
      operationId: "x",
      applicationId: "weknora",
      issuer: "https://casdoor.example.test",
      subject: "uploader",
      resourceId: "kb-a",
      maxChargeMicrocredits: "20",
      confirmedMaxMicrocredits: 40n,
    }),
  ).resolves.toMatchObject({ state: "reserved" });
  await expect(
    service.operation("weknora", "x", "other"),
  ).resolves.toBeUndefined();
});

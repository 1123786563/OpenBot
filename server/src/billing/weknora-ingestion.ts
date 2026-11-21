import type { VerifiedBillingIdentity } from "./test-credit";

export const WEKNORA_APPLICATION_ID = "weknora" as const;

type Quote = {
  creditType: "test";
  priceVersion: string;
  route: string;
  provider: string;
  model: string;
  price: { inputPerMillion: number; outputPerMillion: number };
  maxChargeMicrocredits: string;
  usageDisclosure: string;
};

type ReservationInput = {
  operationId: string;
  route: string;
  priceVersion: string;
  maxChargeMicrocredits: string;
  application: typeof WEKNORA_APPLICATION_ID;
  resourceId: string;
};

type Reservation = {
  state: "reserved" | "existing" | "denied";
  permit?: string;
  operation?: { operationId: string; accountId?: string; state: string };
  reason?: "not_authorized" | "route_unavailable" | "insufficient_credits";
};

/** The shared ledger seam used by WeKnora. Implement it with createTestCreditLedger at the edge. */
export type WeKnoraLedger = {
  quote(): Promise<Quote | undefined>;
  reserve(
    identity: VerifiedBillingIdentity,
    input: ReservationInput,
  ): Promise<Reservation>;
  settle?(
    identity: VerifiedBillingIdentity,
    operationId: string,
    usage: { inputTokens: bigint; outputTokens: bigint },
  ): Promise<unknown>;
  recordEvidence?(
    accountId: string,
    operationId: string,
    evidence: {
      evidenceId: string;
      outcome:
        | "completed"
        | "partial"
        | "cancelled"
        | "platform_failure"
        | "zero_cost";
      inputTokens: bigint;
      outputTokens: bigint;
    },
  ): Promise<unknown>;
  settleRecorded?(accountId: string, operationId: string): Promise<unknown>;
};

export type WeKnoraAuthorization = {
  id: string;
  applicationId: typeof WEKNORA_APPLICATION_ID;
  issuer: string;
  subject: string;
  resourceIds: string[];
  expiresAt: Date;
  maxMicrocredits: bigint;
  spentMicrocredits: bigint;
  revokedAt: Date | null;
};

type Request = {
  operationId: string;
  applicationId: string;
  issuer: string;
  subject: string;
  resourceId: string;
  maxChargeMicrocredits: string;
};

export type WeKnoraBillingErrorCode =
  | "not_authorized"
  | "authorization_expired"
  | "authorization_revoked"
  | "execution_limit"
  | "insufficient_credits"
  | "route_unavailable";

export class WeKnoraBillingError extends Error {
  constructor(
    readonly code: WeKnoraBillingErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WeKnoraBillingError";
  }
}

function identityOf(
  input: Pick<Request, "issuer" | "subject">,
): VerifiedBillingIdentity {
  return { issuer: input.issuer, subject: input.subject };
}

export function createWeKnoraIngestionBilling(options: {
  ledger: WeKnoraLedger;
  now?: () => Date;
  verifyApplication?: (applicationId: string) => Promise<boolean>;
  verifyUser?: (identity: VerifiedBillingIdentity) => Promise<boolean>;
}) {
  const now = options.now ?? (() => new Date());
  const authorizations = new Map<string, WeKnoraAuthorization>();
  const operations = new Map<
    string,
    {
      applicationId: string;
      subject: string;
      authorizationId: string;
      reserved: bigint;
      state: "reserved" | "settled";
    }
  >();
  let lock = Promise.resolve();

  async function exclusive<T>(work: () => Promise<T>): Promise<T> {
    const previous = lock;
    let release!: () => void;
    lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }

  async function authorizationFor(
    input: Pick<Request, "applicationId" | "issuer" | "subject" | "resourceId">,
  ) {
    if (
      options.verifyApplication &&
      !(await options.verifyApplication(input.applicationId))
    )
      throw new WeKnoraBillingError(
        "not_authorized",
        "The WeKnora application identity is invalid.",
      );
    if (options.verifyUser && !(await options.verifyUser(identityOf(input))))
      throw new WeKnoraBillingError(
        "not_authorized",
        "The Casdoor user authorization is invalid.",
      );
    const matches = [...authorizations.values()].filter(
      (candidate) =>
        candidate.applicationId === input.applicationId &&
        candidate.issuer === input.issuer &&
        candidate.subject === input.subject &&
        candidate.resourceIds.includes(input.resourceId),
    );
    const authorization =
      matches.find(
        (candidate) =>
          !candidate.revokedAt &&
          now().getTime() < candidate.expiresAt.getTime(),
      ) ?? matches[0];
    if (!authorization)
      throw new WeKnoraBillingError(
        "not_authorized",
        "WeKnora is not authorized for this user or resource.",
      );
    if (authorization.revokedAt)
      throw new WeKnoraBillingError(
        "authorization_revoked",
        "The WeKnora spending authorization was revoked.",
      );
    if (now().getTime() >= authorization.expiresAt.getTime())
      throw new WeKnoraBillingError(
        "authorization_expired",
        "The WeKnora spending authorization has expired.",
      );
    return authorization;
  }

  async function quote() {
    const value = await options.ledger.quote();
    if (!value)
      throw new WeKnoraBillingError(
        "route_unavailable",
        "The embedding route is unavailable.",
      );
    return { ...value, applicationId: WEKNORA_APPLICATION_ID };
  }

  async function reserve(input: Request, confirmedMaxMicrocredits?: bigint) {
    return exclusive(async () => {
      const authorization = await authorizationFor(input);
      const amount = BigInt(input.maxChargeMicrocredits);
      if (amount < 0n)
        throw new WeKnoraBillingError(
          "execution_limit",
          "The ingestion amount is invalid.",
        );
      const nextLimit =
        confirmedMaxMicrocredits ?? authorization.maxMicrocredits;
      if (nextLimit < authorization.maxMicrocredits)
        throw new WeKnoraBillingError(
          "execution_limit",
          "The confirmed ingestion limit cannot be reduced here.",
        );
      if (confirmedMaxMicrocredits !== undefined)
        authorization.maxMicrocredits = nextLimit;
      const remaining = nextLimit - authorization.spentMicrocredits;
      if (amount > remaining)
        throw new WeKnoraBillingError(
          "execution_limit",
          "The ingestion authorization limit has been reached.",
        );
      const quoteValue = await options.ledger.quote();
      if (!quoteValue)
        throw new WeKnoraBillingError(
          "route_unavailable",
          "The embedding route is unavailable.",
        );
      const result = await options.ledger.reserve(identityOf(input), {
        operationId: input.operationId,
        route: quoteValue.route,
        priceVersion: quoteValue.priceVersion,
        maxChargeMicrocredits: input.maxChargeMicrocredits,
        application: WEKNORA_APPLICATION_ID,
        resourceId: input.resourceId,
      });
      if (result.state === "denied") {
        throw new WeKnoraBillingError(
          result.reason === "insufficient_credits"
            ? "insufficient_credits"
            : (result.reason ?? "not_authorized"),
          "The shared Test Credit reservation was refused.",
        );
      }
      if (result.state === "reserved") {
        authorization.spentMicrocredits += amount;
        operations.set(input.operationId, {
          applicationId: WEKNORA_APPLICATION_ID,
          subject: input.subject,
          authorizationId: authorization.id,
          reserved: amount,
          state: "reserved",
        });
      }
      return {
        ...result,
        applicationId: WEKNORA_APPLICATION_ID,
        authorizationId: authorization.id,
        creditType: "test" as const,
        maxChargeMicrocredits: input.maxChargeMicrocredits,
      };
    });
  }

  return {
    registerAuthorization(value: WeKnoraAuthorization) {
      authorizations.set(value.id, {
        ...value,
        resourceIds: [...value.resourceIds],
      });
    },
    revokeAuthorization(id: string) {
      const value = authorizations.get(id);
      if (value) value.revokedAt = now();
    },
    async preflight(
      input: Omit<Request, "operationId" | "maxChargeMicrocredits">,
    ) {
      await authorizationFor(input);
      return quote();
    },
    reserve(input: Request) {
      return reserve(input);
    },
    resume(input: Request & { confirmedMaxMicrocredits: bigint }) {
      return reserve(input, input.confirmedMaxMicrocredits);
    },
    async settle(input: {
      operationId: string;
      uploaderAccount: VerifiedBillingIdentity;
      inputTokens: bigint;
      outputTokens: bigint;
    }) {
      const operation = operations.get(input.operationId);
      if (!operation || operation.subject !== input.uploaderAccount.subject)
        throw new WeKnoraBillingError(
          "not_authorized",
          "The ingestion operation is not owned by this uploader.",
        );
      const result = options.ledger.settle
        ? await options.ledger.settle(
            input.uploaderAccount,
            input.operationId,
            {
              inputTokens: input.inputTokens,
              outputTokens: input.outputTokens,
            },
          )
        : options.ledger.recordEvidence && options.ledger.settleRecorded
          ? await options.ledger.settleRecorded(
              operation.subject,
              input.operationId,
            )
          : undefined;
      operation.state = "settled";
      return result;
    },
    async operation(
      applicationId: string,
      operationId: string,
      subject: string,
    ) {
      const operation = operations.get(operationId);
      return operation?.applicationId === applicationId &&
        operation.subject === subject
        ? operation
        : undefined;
    },
  };
}

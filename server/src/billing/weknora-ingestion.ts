import type { TestCreditLedger, VerifiedBillingIdentity } from "./test-credit";

export const WEKNORA_APPLICATION_ID = "weknora" as const;

type Scope = {
  applicationId: string;
  authorizationId: string;
  issuer: string;
  subject: string;
  resourceId: string;
};

type Request = Scope & { operationId: string };

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
  input: Pick<Scope, "issuer" | "subject">,
): VerifiedBillingIdentity {
  return { issuer: input.issuer, subject: input.subject };
}

/**
 * The WeKnora ingestion entry over the person's durable Spending
 * Authorization (#111): it reads the grant only through the application it
 * was made to, and the ledger keeps the cap, the pause and the dispatch
 * recheck.
 */
export function createWeKnoraIngestionBilling(options: {
  ledger: TestCreditLedger;
  routeId: string;
  verifyApplication?: (applicationId: string) => Promise<boolean>;
  verifyUser?: (identity: VerifiedBillingIdentity) => Promise<boolean>;
}) {
  const ledger = options.ledger;

  async function authorizationFor(input: Scope) {
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
    const identity = await ledger.authorizationIdentity(
      input.applicationId,
      input.authorizationId,
    );
    if (identity?.issuer !== input.issuer || identity.subject !== input.subject)
      throw new WeKnoraBillingError(
        "not_authorized",
        "WeKnora is not authorized for this user or resource.",
      );
    const grant = await ledger.authorizationSummary(
      input.applicationId,
      input.authorizationId,
    );
    // Ingestion is the background task the grant names, over the one
    // knowledge base it was given.
    if (
      grant?.kind !== "background" ||
      grant.resourcePrefix !== input.resourceId
    )
      throw new WeKnoraBillingError(
        "not_authorized",
        "WeKnora is not authorized for this user or resource.",
      );
    if (grant.state === "revoked")
      throw new WeKnoraBillingError(
        "authorization_revoked",
        "The WeKnora spending authorization was revoked.",
      );
    if (grant.state === "expired")
      throw new WeKnoraBillingError(
        "authorization_expired",
        "The WeKnora spending authorization has expired.",
      );
    return { identity, grant };
  }

  async function selection() {
    const selected = await ledger.weknoraQuote(options.routeId, "embedding");
    if (!selected)
      throw new WeKnoraBillingError(
        "route_unavailable",
        "The embedding route is unavailable.",
      );
    return selected;
  }

  async function quote() {
    const { quote } = await selection();
    return { ...quote, applicationId: WEKNORA_APPLICATION_ID };
  }

  async function reserve(input: Request) {
    const { identity, grant } = await authorizationFor(input);
    const selected = await selection();
    const result = await ledger.reserve(
      identity,
      {
        operationId: input.operationId,
        route: selected.route.id,
        priceVersion: selected.quote.priceVersion,
        applicationId: input.applicationId,
        authorizationId: input.authorizationId,
        resourceId: input.resourceId,
        taskId: grant.taskId ?? undefined,
        creditType: grant.creditType,
      },
      { embedding: true },
    );
    if (result.state === "denied") {
      // Out of credits or a reached cap is a pause, not a refusal: the
      // ledger keeps the step as a resume point (#107 安全续做点).
      const reason = result.reason;
      const code: WeKnoraBillingErrorCode =
        reason === "insufficient_credits" ||
        reason === "execution_limit" ||
        reason === "route_unavailable"
          ? reason
          : "not_authorized";
      throw new WeKnoraBillingError(
        code,
        code === "insufficient_credits"
          ? "Your Test credits ran out. Set a budget in OpenBot, then try again."
          : code === "execution_limit"
            ? "The ingestion authorization limit has been reached."
            : code === "route_unavailable"
              ? "The embedding route is unavailable."
              : "The shared Test Credit reservation was refused.",
      );
    }
    return {
      ...result,
      applicationId: input.applicationId,
      authorizationId: input.authorizationId,
      creditType: grant.creditType,
    };
  }

  async function resume(
    input: Request & { budgetId: string; confirmedMaxMicrocredits: bigint },
  ) {
    const { identity } = await authorizationFor(input);
    const confirmed = await ledger.confirmResumePoint(
      identity,
      input.operationId,
      input.budgetId,
      input.authorizationId,
      input.confirmedMaxMicrocredits,
    );
    if (!confirmed || confirmed.state === "denied")
      throw new WeKnoraBillingError(
        "execution_limit",
        "The confirmed ingestion limit cannot be applied.",
      );
    return reserve(input);
  }

  return {
    async preflight(input: Omit<Request, "operationId">) {
      await authorizationFor(input);
      return quote();
    },
    reserve(input: Request) {
      return reserve(input);
    },
    resume(
      input: Request & { budgetId: string; confirmedMaxMicrocredits: bigint },
    ) {
      return resume(input);
    },
    async settle(input: {
      operationId: string;
      authorizationId: string;
      uploaderAccount: VerifiedBillingIdentity;
      inputTokens: bigint;
      outputTokens: bigint;
    }) {
      const owner = await ledger.authorizationIdentity(
        WEKNORA_APPLICATION_ID,
        input.authorizationId,
      );
      if (
        owner?.issuer !== input.uploaderAccount.issuer ||
        owner.subject !== input.uploaderAccount.subject
      )
        throw new WeKnoraBillingError(
          "not_authorized",
          "The ingestion operation is not owned by this uploader.",
        );
      const operation = await ledger.authorizedOperation(
        WEKNORA_APPLICATION_ID,
        input.authorizationId,
        input.operationId,
      );
      const accountId = await ledger.accountOf(input.uploaderAccount);
      if (!operation || !accountId)
        throw new WeKnoraBillingError(
          "not_authorized",
          "The ingestion operation is not owned by this uploader.",
        );
      return ledger.settle(accountId, input.operationId, {
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
      });
    },
    async operation(
      applicationId: string,
      authorizationId: string,
      operationId: string,
      subject: string,
    ) {
      const identity = await ledger.authorizationIdentity(
        applicationId,
        authorizationId,
      );
      return identity?.subject === subject
        ? ledger.authorizedOperation(
            applicationId,
            authorizationId,
            operationId,
          )
        : undefined;
    },
  };
}

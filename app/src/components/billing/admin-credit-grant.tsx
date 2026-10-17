import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { client } from "@/lib/client";

/**
 * The administrator's grant to a named personal account (Bifrost #222, 02.8).
 *
 * THE FORM SENDS A USER, NEVER AN ACCOUNT. The body carries the ticket's contract — target user,
 * amount, optional expiry, optional reason, a source — and an idempotency key; the account the
 * credits land on is the server's resolution of that user (the payer layer's mapping, 02.4), so
 * this component has no field for an account key and must never grow one: a bare
 * `externalCustomerId` in the body is answered 400 by the route, and asking for one here would
 * be the cross-account leak the ticket exists to close.
 *
 * THE IDEMPOTENCY KEY IS A FORM-SESSION FACT. One key is minted when this card mounts and is
 * reused by every retry of the same session — a double-click or a failed send that the operator
 * retries re-enters nothing (the server's unique index is the authority). A fresh mount — the
 * operator opening the form again to grant again, deliberately — mints a new key, so two
 * intentional grants stay two grants. The keyless server rule (a derived key over the request's
 * identity) backs API callers that send no key at all.
 *
 * OUTCOMES ARE SHOWN, NOT GUESSED. The result panel renders what the server answered — entered,
 * with the grant id and the account it resolved to; or replayed, saying so — and a refusal
 * renders the server's own sentence, because "为什么没发出去" is the question this screen owes
 * an answer to.
 */

/** The grant route's answer, as the server builds it (ticket 02.8's produced contract). */
type PersonalGrantResponse = {
  inserted: boolean;
  grant: { id: string; total: number };
  account: {
    id: string;
    kind: string;
    payerId: string;
    externalCustomerId: string;
  };
};

/** One grant, as the result panel reads it. */
function GrantResult({ result }: { result: PersonalGrantResponse }) {
  const { t } = useTranslation("admin");
  return (
    <div
      className="text-sm"
      data-testid="grant-result"
      role="status"
    >
      {result.inserted ? (
        <p className="font-medium">
          {t("billingPage.result.granted", {
            credits: result.grant.total / 100,
          })}
        </p>
      ) : (
        <p className="font-medium">{t("billingPage.result.replayed")}</p>
      )}
      <p className="text-muted-foreground">
        {t("billingPage.result.grantLabel")} {result.grant.id}
        {result.account
          ? ` · ${t("billingPage.result.accountLabel")} ${result.account.externalCustomerId}`
          : null}
      </p>
    </div>
  );
}

export function AdminCreditGrantCard() {
  const { t } = useTranslation("admin");
  const queryClient = useQueryClient();

  const [userId, setUserId] = useState("");
  const [credits, setCredits] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [reason, setReason] = useState("");
  const [source, setSource] = useState<"promo" | "signin">("promo");
  const [problem, setProblem] = useState<string | undefined>(undefined);

  // One key per mounted form session (see the header): the lazy initializer runs once per
  // mount, the value never changes, and the next session is the next mount.
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  const grant = useMutation({
    mutationFn: (input: {
      userId: string;
      source: "promo" | "signin";
      totalCents: number;
      expiresAt: string | undefined;
      reason: string | undefined;
      idempotencyKey: string;
    }) => {
      // The grant answer is the payload itself — grant, resolved account, inserted — three
      // fields with no single envelope key to unwrap (the probe route's precedent).
      return client("/api/admin/billing/credits/personal-grants", {
        method: "POST",
        body: input,
        fallbackKey: "billing.grantPersonal",
      }).then(
        (response) => response.json() as Promise<PersonalGrantResponse>,
      );
    },
    // The credit reads elsewhere are the user page's concern; nothing here caches a balance.
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["billing"] });
    },
  });

  const submit = () => {
    const trimmedUser = userId.trim();
    const amount = Number(credits);
    const trimmedExpiry = expiresAt.trim();
    if (
      !trimmedUser ||
      !Number.isFinite(amount) ||
      amount <= 0 ||
      (trimmedExpiry !== "" && Number.isNaN(new Date(trimmedExpiry).getTime()))
    ) {
      setProblem(
        trimmedExpiry !== "" && Number.isNaN(new Date(trimmedExpiry).getTime())
          ? t("billingPage.expiryProblem")
          : t("billingPage.problem"),
      );
      return;
    }
    setProblem(undefined);
    // Whole credits in the catalog → scaled units (×100) in the ledger, the same arithmetic
    // every other grant path uses; two decimals are the ledger's own precision.
    grant.mutate({
      userId: trimmedUser,
      source,
      totalCents: Math.round(amount * 100),
      expiresAt: trimmedExpiry
        ? new Date(trimmedExpiry).toISOString()
        : undefined,
      reason: reason.trim() ? reason.trim() : undefined,
      idempotencyKey,
    });
  };

  return (
    <div className="flex max-w-xl flex-col gap-4">
      <Field>
        <FieldLabel htmlFor="admin-grant-user-id">
          {t("billingPage.userId")}
        </FieldLabel>
        <Input
          autoComplete="off"
          data-testid="grant-user-id"
          id="admin-grant-user-id"
          name="admin-grant-user-id"
          onChange={(event) => setUserId(event.target.value)}
          placeholder={t("billingPage.userIdPlaceholder")}
          value={userId}
        />
      </Field>
      <div className="flex flex-col gap-4 md:flex-row">
        <Field className="flex-1">
          <FieldLabel htmlFor="admin-grant-credits">
            {t("billingPage.credits")}
          </FieldLabel>
          <Input
            autoComplete="off"
            data-testid="grant-credits"
            id="admin-grant-credits"
            inputMode="decimal"
            name="admin-grant-credits"
            onChange={(event) => setCredits(event.target.value)}
            placeholder="10"
            value={credits}
          />
        </Field>
        <Field className="flex-1">
          <FieldLabel htmlFor="admin-grant-source">
            {t("billingPage.source")}
          </FieldLabel>
          {/*
           * A native select: two values, no styling ambition worth a portal for — and it keeps
           * the default (a hand-granted credit is a promo unless named otherwise) visible.
           */}
          <select
            className="border-input bg-background h-9 rounded-md border px-3 text-sm"
            data-testid="grant-source"
            id="admin-grant-source"
            name="admin-grant-source"
            onChange={(event) =>
              setSource(event.target.value as "promo" | "signin")
            }
            value={source}
          >
            <option value="promo">{t("billingPage.sourcePromo")}</option>
            <option value="signin">{t("billingPage.sourceSignin")}</option>
          </select>
        </Field>
      </div>
      <Field>
        <FieldLabel htmlFor="admin-grant-expires-at">
          {t("billingPage.expiresAt")}
        </FieldLabel>
        {/* A text field, not a date picker: the value sent is the ISO instant (converted
        here, so the server's offset requirement is met whatever the operator typed), and an
        unparseable value is refused before anything is sent. */}
        <Input
          autoComplete="off"
          data-testid="grant-expires-at"
          id="admin-grant-expires-at"
          name="admin-grant-expires-at"
          onChange={(event) => setExpiresAt(event.target.value)}
          placeholder="2026-12-01T00:00:00Z"
          value={expiresAt}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="admin-grant-reason">
          {t("billingPage.reason")}
        </FieldLabel>
        <Input
          autoComplete="off"
          data-testid="grant-reason"
          id="admin-grant-reason"
          name="admin-grant-reason"
          onChange={(event) => setReason(event.target.value)}
          value={reason}
        />
      </Field>
      <div className="flex items-center gap-3">
        <Button disabled={grant.isPending} data-testid="grant-submit" onClick={submit} size="sm">
          {grant.isPending ? t("billingPage.submitting") : t("billingPage.submit")}
        </Button>
        {problem ? (
          <p className="text-destructive text-sm" role="alert">
            {problem}
          </p>
        ) : null}
        {grant.error ? (
          <p className="text-destructive text-sm" role="alert">
            {grant.error.message}
          </p>
        ) : null}
      </div>
      {grant.data ? <GrantResult result={grant.data} /> : null}
    </div>
  );
}

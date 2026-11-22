import {
  IconCoins,
  IconGauge,
  IconReceipt,
  IconScale,
  IconWallet,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Fragment, useId, useRef, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { astryxScope, AstryxSurface } from "@/components/astryx-pilot/theme";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import {
  billLinesQueryOptions,
  billingBalanceQueryOptions,
  billingQuoteQueryOptions,
  budgetsQueryOptions,
  type BillLine,
  creditsText,
  paidSourcesQueryOptions,
} from "@/lib/billing/queries";
import {
  createBudgetMutationOptions,
  microcreditsFromCredits,
} from "@/lib/billing/mutations";
import { queryClient } from "@/query-client";

/**
 * A person's credits (#107). The two Credit types stay in view side by side: the Test Credit
 * balance, the paid sources and what each still holds, the rate a request costs, the budget a task
 * runs under and the type it fixed when it started, and every charge by the source that paid it.
 */

export const Route = createFileRoute("/_authed/_app/billing")({
  component: CreditsPage,
});

const CREDIT_TYPES = { test: "Test credits", paid: "Paid credits" } as const;

const SOURCES: Record<BillLine["source"], string> = {
  test: "Test credits",
  subscription: "Monthly plan",
  credit_pack: "Credit pack",
  correction: "Correction",
};

function onDate(iso: string | null) {
  return iso
    ? new Date(iso).toLocaleDateString("en-US", { dateStyle: "medium" })
    : "";
}

/** One read-only row: what it is on the left, the value on the right. */
function ValueRow({
  icon: Icon,
  title,
  description,
  value,
}: {
  icon: React.ComponentType<{ "aria-hidden"?: true }>;
  title: string;
  description?: string;
  value: string;
}) {
  return (
    <Item size="sm">
      <ItemMedia variant="icon">
        <Icon />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>{title}</ItemTitle>
        {description ? <ItemDescription>{description}</ItemDescription> : null}
      </ItemContent>
      <ItemActions>{value}</ItemActions>
    </Item>
  );
}

function TestCreditsSection() {
  const balance = useQuery(billingBalanceQueryOptions());
  return (
    <PageSection title="Test credits">
      {balance.isPending ? null : balance.error ? (
        <PageEmpty icon={IconWallet} title="No credits yet">
          An admin adds Test Credits to your account.
        </PageEmpty>
      ) : (
        <PageRows>
          <ValueRow
            description="What your Bots can spend now."
            icon={IconWallet}
            title="Available"
            value={creditsText(balance.data.availableMicrocredits)}
          />
          <Separator />
          <ValueRow
            description="Held while a request is running."
            icon={IconWallet}
            title="Reserved"
            value={creditsText(balance.data.reservedMicrocredits)}
          />
          <Separator />
          <ValueRow
            description="Spent on finished requests."
            icon={IconWallet}
            title="Charged"
            value={creditsText(balance.data.chargedMicrocredits)}
          />
        </PageRows>
      )}
    </PageSection>
  );
}

function PaidCreditsSection() {
  const sources = useQuery(paidSourcesQueryOptions());
  return (
    <PageSection title="Paid credits">
      {sources.isPending ? null : sources.error ? (
        <p className="text-destructive text-sm" role="alert">
          {sources.error.message}
        </p>
      ) : sources.data.length === 0 ? (
        <PageEmpty icon={IconCoins} title="No paid credits yet">
          Buy a plan or a Credit Pack to give your Bots more to spend.
        </PageEmpty>
      ) : (
        <PageRows>
          {sources.data.map((source, index) => (
            <Fragment key={source.entitlementId}>
              {index > 0 ? <Separator /> : null}
              <Item size="sm">
                <ItemMedia variant="icon">
                  <IconCoins />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>
                    {source.kind === "subscription"
                      ? "Monthly plan"
                      : "Credit pack"}
                  </ItemTitle>
                  <ItemDescription>
                    Added {onDate(source.arrivedAt)}.
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  {creditsText(source.remainingMicrocredits)} available
                </ItemActions>
              </Item>
            </Fragment>
          ))}
        </PageRows>
      )}
    </PageSection>
  );
}

function RateSection() {
  const quote = useQuery(billingQuoteQueryOptions());
  return (
    <PageSection title="Rate">
      {quote.isPending ? null : quote.error ? (
        <PageEmpty icon={IconScale} title="No model route yet">
          An admin publishes one before Bots can run.
        </PageEmpty>
      ) : (
        <PageRows>
          <ValueRow
            icon={IconScale}
            title="Credit type"
            value={CREDIT_TYPES[quote.data.creditType]}
          />
          <Separator />
          <ValueRow
            icon={IconScale}
            title="Price"
            value={`${creditsText(quote.data.price.inputPerMillion)} in, ${creditsText(quote.data.price.outputPerMillion)} out`}
          />
          <Separator />
          <ValueRow
            description="The most one request can charge."
            icon={IconScale}
            title="Limit per request"
            value={`${creditsText(quote.data.maxChargeMicrocredits)} credits`}
          />
        </PageRows>
      )}
    </PageSection>
  );
}

function BudgetsSection() {
  const budgets = useQuery(budgetsQueryOptions());
  return (
    <PageSection
      description="A task runs on the Credit type its budget names, and stops when it reaches the limit."
      title="Budgets"
    >
      {budgets.isPending ? null : budgets.error ? (
        <p className="text-destructive text-sm" role="alert">
          {budgets.error.message}
        </p>
      ) : budgets.data.length === 0 ? (
        <PageEmpty icon={IconGauge} title="No budgets yet">
          Set a budget to cap what a task can spend.
        </PageEmpty>
      ) : (
        <PageRows>
          {budgets.data.map((budget, index) => (
            <Fragment key={budget.budgetId}>
              {index > 0 ? <Separator /> : null}
              <Item size="sm">
                <ItemMedia variant="icon">
                  <IconGauge />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>
                    {budget.creditType === "paid"
                      ? "Paid budget"
                      : "Test budget"}
                  </ItemTitle>
                  <ItemDescription>
                    Limit {creditsText(budget.limitMicrocredits)} credits. Used{" "}
                    {creditsText(budget.usedMicrocredits)}.
                  </ItemDescription>
                </ItemContent>
                <ItemActions>{budget.state}</ItemActions>
              </Item>
            </Fragment>
          ))}
        </PageRows>
      )}
    </PageSection>
  );
}

function UsageSection() {
  const lines = useQuery(billLinesQueryOptions());
  return (
    <PageSection title="Usage">
      {lines.isPending ? null : lines.error ? (
        <p className="text-destructive text-sm" role="alert">
          {lines.error.message}
        </p>
      ) : lines.data.length === 0 ? (
        <PageEmpty icon={IconReceipt} title="No charges yet">
          Charges appear here after a request finishes.
        </PageEmpty>
      ) : (
        <PageRows>
          {lines.data.map((line, index) => (
            <Fragment
              key={`${line.operationId}|${line.source}|${line.entitlementId ?? ""}|${line.at ?? ""}|${line.amountMicrocredits}`}
            >
              {index > 0 ? <Separator /> : null}
              <Item size="sm">
                <ItemContent>
                  <ItemTitle>{SOURCES[line.source]}</ItemTitle>
                  <ItemDescription>
                    {line.reason ?? `${line.operationId} on ${onDate(line.at)}`}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  {creditsText(line.amountMicrocredits)}
                </ItemActions>
              </Item>
            </Fragment>
          ))}
        </PageRows>
      )}
    </PageSection>
  );
}

/** The one verb on the page: choose a Credit type and a limit for a task. */
function SetBudgetDialog({
  onClose,
  returnFocus,
}: {
  onClose: () => void;
  returnFocus: React.RefObject<HTMLButtonElement | null>;
}) {
  const formId = useId();
  const [creditType, setCreditType] = useState<"test" | "paid">("test");
  const [limitCredits, setLimitCredits] = useState("");
  const limit = microcreditsFromCredits(limitCredits);
  const create = useMutation(createBudgetMutationOptions(queryClient));
  return (
    <Dialog onOpenChange={(next) => !next && onClose()} open>
      <DialogContent {...astryxScope} finalFocus={returnFocus}>
        <DialogHeader>
          <DialogTitle>Set a budget</DialogTitle>
          <DialogDescription>
            A task stops when it has spent this many credits. The Credit type is
            fixed when the task starts.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="mt-4 overflow-y-auto">
          {/* The footer's button reaches this form by id, so DialogBody stays a direct child of
              DialogContent and keeps scrolling. */}
          <form
            id={formId}
            onSubmit={(event) => {
              event.preventDefault();
              if (!limit) return;
              create.mutate(
                { creditType, limitCredits },
                { onSuccess: onClose },
              );
            }}
          >
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor={`${formId}-type`}>Credit type</FieldLabel>
                <Select
                  items={CREDIT_TYPES}
                  onValueChange={(value) =>
                    setCreditType(value === "paid" ? "paid" : "test")
                  }
                  value={creditType}
                >
                  <SelectTrigger className="w-full" id={`${formId}-type`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="test">Test credits</SelectItem>
                    <SelectItem value="paid">Paid credits</SelectItem>
                  </SelectContent>
                </Select>
                <FieldDescription>
                  Test credits are free to try. Paid credits come from a plan or
                  a Credit Pack you bought.
                </FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor={`${formId}-limit`}>Limit</FieldLabel>
                <Input
                  id={`${formId}-limit`}
                  inputMode="decimal"
                  onChange={(event) => setLimitCredits(event.target.value)}
                  placeholder="5"
                  required
                  value={limitCredits}
                />
                {limitCredits && !limit ? (
                  <FieldDescription>
                    Enter a positive amount of credits, with up to six decimals.
                  </FieldDescription>
                ) : null}
              </Field>
            </FieldGroup>
          </form>
          {create.error ? (
            <p className="mt-4 text-destructive text-sm" role="alert">
              {create.error.message}
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter className="mt-4">
          <Button onClick={onClose} type="button" variant="outline">
            Cancel
          </Button>
          <Button
            disabled={!limit || create.isPending}
            type="submit"
            form={formId}
          >
            {create.isPending ? "Setting…" : "Set budget"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CreditsPage() {
  const trigger = useRef<HTMLButtonElement | null>(null);
  const [setting, setSetting] = useState(false);
  return (
    <AstryxSurface className="flex min-h-0 min-w-0 flex-1 flex-col">
      <PageShell
        action={
          <Button
            onClick={() => setSetting(true)}
            ref={trigger}
            size="lg"
            type="button"
          >
            Set a budget
          </Button>
        }
        description="See what your Bots can spend, and set a budget before a task continues on paid credits."
        title="Credits"
      >
        <TestCreditsSection />
        <PaidCreditsSection />
        <RateSection />
        <BudgetsSection />
        <UsageSection />
        {setting ? (
          <SetBudgetDialog
            onClose={() => setSetting(false)}
            returnFocus={trigger}
          />
        ) : null}
      </PageShell>
    </AstryxSurface>
  );
}

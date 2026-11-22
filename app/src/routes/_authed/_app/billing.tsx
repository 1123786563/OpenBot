import {
  IconCoins,
  IconGauge,
  IconPlayerPause,
  IconReceipt,
  IconScale,
  IconSearch,
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
  SelectGroup,
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
  paidBalanceQueryOptions,
  paidSourcesQueryOptions,
  type ResumePoint,
  resumePointsQueryOptions,
} from "@/lib/billing/queries";
import {
  confirmResumePointMutationOptions,
  createBudgetMutationOptions,
  microcreditsFromCredits,
} from "@/lib/billing/mutations";
import { queryClient } from "@/query-client";

/**
 * A person's credits (#107). The two Credit types stay in view side by side: the Test Credit
 * balance, the paid balance and the sources behind it, the rate a request costs, the budget a task
 * runs under and the type it fixed when it started, and every charge by the source and the app. A
 * task that stopped for want of credits or budget room waits at the top until the person sets the
 * budget it continues on.
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

const APPLICATIONS: Record<string, string> = {
  weknora: "WeKnora",
  openbot: "OpenBot",
};
const NO_APP = "none";
const USAGE_TYPES = { all: "All types", ...CREDIT_TYPES } as const;

/** The app a step ran for, in words. A step whose caller named none says so. */
function appLabel(applicationId: string | null) {
  if (!applicationId) return "No app named";
  return APPLICATIONS[applicationId] ?? applicationId;
}

/** Test Credit is its own source; every other source, corrections included, is paid. */
const creditTypeOf = (line: BillLine) =>
  line.source === "test" ? "test" : "paid";

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
  const balance = useQuery(paidBalanceQueryOptions());
  const sources = useQuery(paidSourcesQueryOptions());
  const empty =
    balance.data?.availableMicrocredits === "0" &&
    balance.data.reservedMicrocredits === "0" &&
    balance.data.chargedMicrocredits === "0";
  return (
    <PageSection title="Paid credits">
      {balance.isPending || sources.isPending ? null : balance.error ||
        sources.error ? (
        <p className="text-destructive text-sm" role="alert">
          {(balance.error ?? sources.error)?.message}
        </p>
      ) : empty ? (
        <PageEmpty icon={IconCoins} title="No paid credits yet">
          Buy a plan or a Credit Pack to give your Bots more to spend.
        </PageEmpty>
      ) : (
        <PageRows>
          {/* The same three figures the Test Credit side shows, counted on this side alone. */}
          <ValueRow
            description="What your Bots can spend now."
            icon={IconCoins}
            title="Available"
            value={creditsText(balance.data.availableMicrocredits)}
          />
          <Separator />
          <ValueRow
            description="Held while a request is running."
            icon={IconCoins}
            title="Reserved"
            value={creditsText(balance.data.reservedMicrocredits)}
          />
          <Separator />
          <ValueRow
            description="Spent on finished requests."
            icon={IconCoins}
            title="Charged"
            value={creditsText(balance.data.chargedMicrocredits)}
          />
          {sources.data.map((source) => (
            <Fragment key={source.entitlementId}>
              <Separator />
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
  const [app, setApp] = useState("all");
  const [type, setType] = useState<"all" | "test" | "paid">("all");
  const data = lines.data ?? [];
  // Each filter is offered once it has something to tell apart.
  const apps = [...new Set(data.map((line) => line.applicationId ?? NO_APP))];
  const types = [...new Set(data.map(creditTypeOf))];
  const shown = data.filter(
    (line) =>
      (app === "all" || (line.applicationId ?? NO_APP) === app) &&
      (type === "all" || creditTypeOf(line) === type),
  );
  return (
    <PageSection
      action={
        <>
          {apps.length < 2 ? null : (
            <Select
              onValueChange={(value) => setApp(String(value))}
              value={app}
            >
              <SelectTrigger aria-label="App" size="sm">
                <SelectValue>
                  {app === "all"
                    ? "All apps"
                    : appLabel(app === NO_APP ? null : app)}
                </SelectValue>
              </SelectTrigger>
              <SelectContent {...astryxScope} align="end">
                <SelectGroup>
                  <SelectItem value="all">All apps</SelectItem>
                  {apps.map((id) => (
                    <SelectItem key={id} value={id}>
                      {appLabel(id === NO_APP ? null : id)}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          )}
          {types.length < 2 ? null : (
            <Select
              onValueChange={(value) =>
                setType(value === "test" || value === "paid" ? value : "all")
              }
              value={type}
            >
              <SelectTrigger aria-label="Credit type" size="sm">
                <SelectValue>{USAGE_TYPES[type]}</SelectValue>
              </SelectTrigger>
              <SelectContent {...astryxScope} align="end">
                <SelectGroup>
                  <SelectItem value="all">All types</SelectItem>
                  <SelectItem value="test">Test credits</SelectItem>
                  <SelectItem value="paid">Paid credits</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          )}
        </>
      }
      title="Usage"
    >
      {lines.isPending ? null : lines.error ? (
        <p className="text-destructive text-sm" role="alert">
          {lines.error.message}
        </p>
      ) : lines.data.length === 0 ? (
        <PageEmpty icon={IconReceipt} title="No charges yet">
          Charges appear here after a request finishes.
        </PageEmpty>
      ) : shown.length === 0 ? (
        <PageEmpty icon={IconSearch} title="No matches" />
      ) : (
        <PageRows>
          {shown.map((line, index) => (
            <Fragment
              key={`${line.operationId}|${line.source}|${line.entitlementId ?? ""}|${line.at ?? ""}|${line.amountMicrocredits}`}
            >
              {index > 0 ? <Separator /> : null}
              <Item size="sm">
                <ItemContent>
                  <ItemTitle>{SOURCES[line.source]}</ItemTitle>
                  <ItemDescription>
                    {line.reason ??
                      `${line.applicationId ? `${appLabel(line.applicationId)}, ` : ""}${line.operationId} on ${onDate(line.at)}`}
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

/** The tasks stopped for want of credits or budget room, each waiting on a budget. */
function WaitingSection({
  onContinue,
}: {
  onContinue: (resume: ResumePoint, trigger: HTMLButtonElement) => void;
}) {
  const points = useQuery(resumePointsQueryOptions());
  // A list that cannot load says nothing: the balance above already tells the
  // person when their account is unavailable.
  if (points.isPending || points.error || points.data.length === 0) return null;
  return (
    <PageSection
      description="Each one continues on the budget you set for it, the next time it tries."
      title="Paused tasks"
    >
      <PageRows>
        {points.data.map((point, index) => (
          <Fragment key={point.operationId}>
            {index > 0 ? <Separator /> : null}
            <Item size="sm">
              <ItemMedia variant="icon">
                <IconPlayerPause />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>
                  {point.applicationId
                    ? appLabel(point.applicationId)
                    : "A task"}
                </ItemTitle>
                <ItemDescription className="line-clamp-none">
                  {point.budgetId
                    ? `Continues on a ${point.creditType === "paid" ? "Paid" : "Test"} budget.`
                    : point.reason === "insufficient_credits"
                      ? "Its Test credits ran out."
                      : "It reached its budget."}
                </ItemDescription>
              </ItemContent>
              {point.budgetId ? null : (
                <ItemActions>
                  <Button
                    onClick={(event) => onContinue(point, event.currentTarget)}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    Set a budget to continue
                  </Button>
                </ItemActions>
              )}
            </Item>
          </Fragment>
        ))}
      </PageRows>
    </PageSection>
  );
}

/**
 * The one verb on the page: choose a Credit type and a limit for a task. For a paused task, the
 * budget is also what the person confirms for its next charged step (#107).
 */
function SetBudgetDialog({
  onClose,
  resume,
  returnFocus,
}: {
  onClose: () => void;
  resume?: ResumePoint;
  returnFocus: React.RefObject<HTMLButtonElement | null>;
}) {
  const formId = useId();
  // A task out of Test credits continues on paid credits.
  const [creditType, setCreditType] = useState<"test" | "paid">(
    resume?.reason === "insufficient_credits" ? "paid" : "test",
  );
  const [limitCredits, setLimitCredits] = useState("");
  const limit = microcreditsFromCredits(limitCredits);
  const create = useMutation(createBudgetMutationOptions(queryClient));
  const confirm = useMutation(confirmResumePointMutationOptions(queryClient));
  const saving = create.isPending || confirm.isPending;
  const error = confirm.error ?? create.error;
  return (
    <Dialog onOpenChange={(next) => !next && onClose()} open>
      <DialogContent {...astryxScope} finalFocus={returnFocus}>
        <DialogHeader>
          <DialogTitle>Set a budget</DialogTitle>
          <DialogDescription>
            {resume
              ? "This task continues on the budget you set here. It stops when it has spent this many credits."
              : "A task stops when it has spent this many credits. The Credit type is fixed when the task starts."}
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
                {
                  // The budget alone continues nothing: the person's confirmation
                  // is what lets the paused step reserve on it.
                  onSuccess: (budget) =>
                    resume
                      ? confirm.mutate(
                          {
                            operationId: resume.operationId,
                            budgetId: budget.budgetId,
                          },
                          { onSuccess: onClose },
                        )
                      : onClose(),
                },
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
          {error ? (
            <p className="mt-4 text-destructive text-sm" role="alert">
              {error.message}
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter className="mt-4">
          <Button onClick={onClose} type="button" variant="outline">
            Cancel
          </Button>
          <Button disabled={!limit || saving} type="submit" form={formId}>
            {saving ? "Setting…" : "Set budget"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CreditsPage() {
  const trigger = useRef<HTMLButtonElement | null>(null);
  const [dialog, setDialog] = useState<{
    resume?: ResumePoint;
    returnFocus: React.RefObject<HTMLButtonElement | null>;
  } | null>(null);
  return (
    <AstryxSurface className="flex min-h-0 min-w-0 flex-1 flex-col">
      <PageShell
        action={
          <Button
            onClick={() => setDialog({ returnFocus: trigger })}
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
        <WaitingSection
          onContinue={(resume, button) =>
            setDialog({ resume, returnFocus: { current: button } })
          }
        />
        <TestCreditsSection />
        <PaidCreditsSection />
        <RateSection />
        <BudgetsSection />
        <UsageSection />
        {dialog ? (
          <SetBudgetDialog
            onClose={() => setDialog(null)}
            resume={dialog.resume}
            returnFocus={dialog.returnFocus}
          />
        ) : null}
      </PageShell>
    </AstryxSurface>
  );
}

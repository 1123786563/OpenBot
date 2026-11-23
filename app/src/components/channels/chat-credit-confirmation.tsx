import { Button } from "@astryxdesign/core/Button";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@astryxdesign/core/SegmentedControl";
import { Stack } from "@astryxdesign/core/Stack";
import { useEffect, useRef, useState } from "react";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import type { BillingQuote } from "@/lib/billing/queries";

type CreditType = "test" | "paid";

export type ChatCreditReceipt = {
  userMessageId: string;
  description: string;
  pending: boolean;
  canRerun: boolean;
};

function microcredits(amount: string) {
  return `${amount} microcredit${amount === "1" ? "" : "s"}`;
}

export function chatCreditReceipt(
  value: unknown,
): ChatCreditReceipt | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    !("userMessageId" in value) ||
    typeof value.userMessageId !== "string" ||
    !("state" in value)
  )
    return undefined;
  const { userMessageId, state } = value;
  const credits =
    "creditType" in value && value.creditType === "paid"
      ? "Paid Credits"
      : "Test Credits";
  if (state === "pending" || state === "reserved") {
    if (
      !("heldMicrocredits" in value) ||
      typeof value.heldMicrocredits !== "string"
    )
      return undefined;
    return {
      userMessageId,
      description: `${credits} · Pending reconciliation · ${microcredits(value.heldMicrocredits)} held`,
      pending: true,
      canRerun: true,
    };
  }
  if (
    (state !== "settled" && state !== "released") ||
    !("releasedMicrocredits" in value) ||
    typeof value.releasedMicrocredits !== "string"
  )
    return undefined;
  const charged =
    "chargedMicrocredits" in value &&
    typeof value.chargedMicrocredits === "string"
      ? value.chargedMicrocredits
      : "0";
  return {
    userMessageId,
    description:
      state === "released"
        ? `${credits} · Reservation released · ${microcredits(value.releasedMicrocredits)} returned`
        : `${credits} · Settled · ${microcredits(charged)} charged · ${microcredits(value.releasedMicrocredits)} released`,
    pending: false,
    canRerun: "hasReply" in value && value.hasReply === false,
  };
}

export function useChatCreditConfirmation() {
  const [confirmation, setConfirmation] = useState<{
    quote: BillingQuote;
    rerun: boolean;
  }>();
  const [creditType, setCreditType] = useState<CreditType>("test");
  const creditLabel = creditType === "paid" ? "Paid Credits" : "Test Credits";
  const quote = confirmation?.quote;
  const rerun = confirmation?.rerun === true;
  const resolve = useRef<
    ((confirmed: CreditType | undefined) => void) | undefined
  >(undefined);
  const cancelButton = useRef<HTMLButtonElement>(null);
  useEffect(() => () => resolve.current?.(undefined), []);

  function finish(confirmed?: CreditType) {
    resolve.current?.(confirmed);
    resolve.current = undefined;
    setConfirmation(undefined);
  }

  return {
    confirmCredit: (next: BillingQuote, rerun: boolean) =>
      new Promise<CreditType | undefined>((confirmed) => {
        setCreditType("test");
        resolve.current = confirmed;
        setConfirmation({ quote: next, rerun });
      }),
    creditDialog: (
      <Dialog
        open={quote !== undefined}
        onOpenChange={(open) => {
          if (!open) finish();
        }}
      >
        <DialogContent initialFocus={cancelButton} showCloseButton={false}>
          <DialogTitle>
            {rerun
              ? `Run again using ${creditLabel}?`
              : `Send using ${creditLabel}?`}
          </DialogTitle>
          <DialogBody>
            {quote?.paidAvailable ? (
              <SegmentedControl
                label="Credit type"
                value={creditType}
                onChange={(value) =>
                  setCreditType(value === "paid" ? "paid" : "test")
                }
              >
                <SegmentedControlItem value="test" label="Test Credits" />
                <SegmentedControlItem value="paid" label="Paid Credits" />
              </SegmentedControl>
            ) : null}
            {quote ? (
              <DialogDescription render={<Stack gap={2} />}>
                <p>
                  {quote.provider}/{quote.model} · Bifrost route {quote.route}
                </p>
                <p>
                  Input {quote.price.inputPerMillion} and output{" "}
                  {quote.price.outputPerMillion} microcredits per million
                  tokens.
                </p>
                <p>
                  Maximum reservation{" "}
                  {microcredits(quote.maxChargeMicrocredits)}.
                </p>
                <p>
                  {creditType === "paid"
                    ? "Interrupted, cancelled, or failed requests may still use Paid Credits."
                    : quote.usageDisclosure}
                </p>
                {rerun ? (
                  <p>
                    Running again makes a new reservation. The original charge
                    is handled separately.
                  </p>
                ) : null}
              </DialogDescription>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <Button
              ref={cancelButton}
              label="Cancel"
              variant="secondary"
              onClick={() => finish()}
            />
            <Button
              label={rerun ? "Confirm and rerun" : "Confirm and send"}
              variant="primary"
              onClick={() => finish(creditType)}
            />
          </DialogFooter>
        </DialogContent>
      </Dialog>
    ),
  };
}

import { Button } from "@astryxdesign/core/Button";
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
  if (state === "pending" || state === "reserved") {
    if (
      !("heldMicrocredits" in value) ||
      typeof value.heldMicrocredits !== "string"
    )
      return undefined;
    return {
      userMessageId,
      description: `Test Credits · Pending reconciliation · ${microcredits(value.heldMicrocredits)} held`,
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
        ? `Test Credits · Reservation released · ${microcredits(value.releasedMicrocredits)} returned`
        : `Test Credits · Settled · ${microcredits(charged)} charged · ${microcredits(value.releasedMicrocredits)} released`,
    pending: false,
    canRerun: "hasReply" in value && value.hasReply === false,
  };
}

export function useChatCreditConfirmation() {
  const [confirmation, setConfirmation] = useState<{
    quote: BillingQuote;
    rerun: boolean;
  }>();
  const quote = confirmation?.quote;
  const rerun = confirmation?.rerun === true;
  const resolve = useRef<((confirmed: boolean) => void) | undefined>(undefined);
  const cancelButton = useRef<HTMLButtonElement>(null);
  useEffect(() => () => resolve.current?.(false), []);

  function finish(confirmed: boolean) {
    resolve.current?.(confirmed);
    resolve.current = undefined;
    setConfirmation(undefined);
  }

  return {
    confirmCredit: (next: BillingQuote, rerun: boolean) =>
      new Promise<boolean>((confirmed) => {
        resolve.current = confirmed;
        setConfirmation({ quote: next, rerun });
      }),
    creditDialog: (
      <Dialog
        open={quote !== undefined}
        onOpenChange={(open) => {
          if (!open) finish(false);
        }}
      >
        <DialogContent initialFocus={cancelButton} showCloseButton={false}>
          <DialogTitle>
            {rerun
              ? "Run again using Test Credits?"
              : "Send using Test Credits?"}
          </DialogTitle>
          <DialogBody>
            {quote ? (
              <DialogDescription render={<Stack gap={2} />}>
                <p>{quote.model} · Test Credits</p>
                <p>
                  Input {quote.price.inputPerMillion} and output{" "}
                  {quote.price.outputPerMillion} microcredits per million
                  tokens.
                </p>
                <p>
                  Maximum reservation{" "}
                  {microcredits(quote.maxChargeMicrocredits)}.
                </p>
                <p>{quote.usageDisclosure}</p>
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
              onClick={() => finish(false)}
            />
            <Button
              label={rerun ? "Confirm and rerun" : "Confirm and send"}
              variant="primary"
              onClick={() => finish(true)}
            />
          </DialogFooter>
        </DialogContent>
      </Dialog>
    ),
  };
}

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

export type ChatCreditReceipt = { description: string };

function microcredits(amount: string) {
  return `${amount} microcredit${amount === "1" ? "" : "s"}`;
}

export function chatCreditReceipt(
  value: unknown,
): ChatCreditReceipt | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    !("chargedMicrocredits" in value) ||
    !("releasedMicrocredits" in value) ||
    typeof value.releasedMicrocredits !== "string"
  )
    return undefined;
  const charged =
    typeof value.chargedMicrocredits === "string"
      ? value.chargedMicrocredits
      : "0";
  return {
    description: `Test Credits · ${microcredits(charged)} charged · ${microcredits(value.releasedMicrocredits)} released`,
  };
}

export function useChatCreditConfirmation() {
  const [quote, setQuote] = useState<BillingQuote>();
  const resolve = useRef<((confirmed: boolean) => void) | undefined>(undefined);
  const cancelButton = useRef<HTMLButtonElement>(null);
  useEffect(() => () => resolve.current?.(false), []);

  function finish(confirmed: boolean) {
    resolve.current?.(confirmed);
    resolve.current = undefined;
    setQuote(undefined);
  }

  return {
    confirmCredit: (next: BillingQuote) =>
      new Promise<boolean>((confirmed) => {
        resolve.current = confirmed;
        setQuote(next);
      }),
    creditDialog: (
      <Dialog
        open={quote !== undefined}
        onOpenChange={(open) => {
          if (!open) finish(false);
        }}
      >
        <DialogContent initialFocus={cancelButton} showCloseButton={false}>
          <DialogTitle>Send using Test Credits?</DialogTitle>
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
              label="Confirm and send"
              variant="primary"
              onClick={() => finish(true)}
            />
          </DialogFooter>
        </DialogContent>
      </Dialog>
    ),
  };
}

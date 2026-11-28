import { whatIfExplainable } from "@openbot/shared/what-if";
import { IconHelpCircle } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { governanceOverlay } from "@/components/astryx-pilot/governance";
import type { AuditEvent } from "@/components/audit/audit-cells";
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
import { cn } from "@/lib/utils";
import { explainAuditEvent, type WhatIfExplained } from "@/lib/what-if/check";
import { WhatIfResultView } from "./what-if-result";

/** Whether "Why did this happen?" can answer for a row: one OpenBot's controls decided. */
export function explainable(event: AuditEvent): boolean {
  return whatIfExplainable(event);
}

const RECORDED_WORDS = {
  allowed: "Allowed",
  refused: "Blocked",
  asks: "Approval requested",
  hands_off: "Handed to a person",
  failed: "Allowed, then didn't finish",
} as const;

/**
 * "Why?" on an Audit row: the same check "What would happen" runs, asked about the row's own recorded
 * facts, with no model. The dialog says what the row recorded, then what every control says about it
 * today, and where the two differ because a setting has changed since.
 */
type Explanation =
  | { kind: "idle" }
  | { kind: "loading"; retrying: boolean }
  | { kind: "error"; message: string }
  | { kind: "ready"; answer: WhatIfExplained };

export function WhyButton({ event }: { event: AuditEvent }) {
  const [open, setOpen] = useState(false);
  const [explanation, setExplanation] = useState<Explanation>({ kind: "idle" });
  const retryButton = useRef<HTMLButtonElement>(null);
  const doneButton = useRef<HTMLButtonElement>(null);
  const answer = explanation.kind === "ready" ? explanation.answer : null;
  const canRetry =
    explanation.kind === "error" ||
    (explanation.kind === "loading" && explanation.retrying);

  async function load() {
    if (answer || explanation.kind === "loading") return;
    setExplanation({ kind: "loading", retrying: explanation.kind === "error" });
    try {
      const result = await explainAuditEvent(event.id);
      if (retryButton.current === document.activeElement)
        doneButton.current?.focus();
      setExplanation({ kind: "ready", answer: result });
    } catch (error) {
      setExplanation({
        kind: "error",
        message:
          error instanceof Error
            ? error.message
            : "Couldn't explain this event.",
      });
    }
  }

  const differs =
    answer &&
    answer.recorded.outcome !== "failed" &&
    (answer.recorded.outcome !== answer.result.outcome ||
      (answer.recorded.layer !== null &&
        answer.recorded.layer !== answer.result.decidedBy));

  return (
    <>
      <Button
        className="-ms-2 mt-1 text-muted-foreground @max-3xl/audit:min-h-11"
        data-why={event.id}
        onClick={() => {
          setOpen(true);
          if (explanation.kind === "idle") void load();
        }}
        size="xs"
        variant="ghost"
      >
        <IconHelpCircle />
        Why?
      </Button>
      <Dialog onOpenChange={setOpen} open={open}>
        <DialogContent
          {...governanceOverlay}
          className={cn(governanceOverlay.className, "sm:max-w-xl")}
        >
          <DialogHeader>
            <DialogTitle>Why did this happen?</DialogTitle>
            <DialogDescription>
              See what was recorded and how current policy evaluates the same
              action.
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            {explanation.kind === "loading" ? (
              <p className="text-muted-foreground" role="status">
                Loading explanation…
              </p>
            ) : explanation.kind === "error" ? (
              <p
                className="text-destructive [overflow-wrap:anywhere]"
                role="alert"
              >
                {explanation.message}
              </p>
            ) : answer ? (
              <>
                <section data-why-recorded={answer.recorded.outcome}>
                  <h3 className="mb-2 font-semibold">Recorded decision</h3>
                  <p className="font-medium">
                    {RECORDED_WORDS[answer.recorded.outcome]}
                  </p>
                  <p className="mt-1 text-muted-foreground [overflow-wrap:anywhere]">
                    {answer.recorded.summary}
                  </p>
                </section>
                <section className="border-border border-t pt-4">
                  <h3 className="mb-2 font-semibold">With current policy</h3>
                  {differs ? (
                    <p className="mb-2 text-pretty text-muted-foreground">
                      The current evaluation differs from the recorded decision.
                    </p>
                  ) : null}
                  <WhatIfResultView inDialog result={answer.result} />
                </section>
              </>
            ) : null}
          </DialogBody>
          <DialogFooter>
            {canRetry ? (
              <Button
                aria-disabled={explanation.kind === "loading"}
                className="max-sm:min-h-11"
                onClick={() => void load()}
                ref={retryButton}
                size="sm"
                variant="outline"
              >
                {explanation.kind === "loading" ? "Retrying…" : "Try again"}
              </Button>
            ) : null}
            {answer ? (
              <Button
                render={(props) => (
                  <Link
                    {...props}
                    search={{ action: JSON.stringify(answer.action) }}
                    to="/admin/what-if"
                  />
                )}
                className="max-sm:min-h-11"
                size="sm"
                variant="outline"
              >
                Try a change
              </Button>
            ) : null}
            <Button
              className="max-sm:min-h-11"
              onClick={() => setOpen(false)}
              ref={doneButton}
              size="sm"
            >
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

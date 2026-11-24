import { Button } from "@astryxdesign/core/Button";
import { useId, useLayoutEffect, useRef, useState } from "react";
import { Field, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";

export function FirstMessageDraftCopy({
  text,
  label = "Copy draft",
}: {
  text: string;
  label?: string;
}) {
  const [status, setStatus] = useState<"idle" | "copied" | "manual">("idle");
  const trigger = useRef<HTMLButtonElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const id = useId();

  useLayoutEffect(() => {
    if (status === "manual" && document.activeElement === trigger.current)
      field.current?.focus();
  }, [status]);

  async function copyDraft() {
    try {
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(text);
        setStatus("copied");
        return;
      }
    } catch {
      // The read-only field provides the same text when clipboard access is refused.
    }
    setStatus("manual");
    if (document.activeElement === trigger.current) field.current?.focus();
  }

  return (
    <>
      <Button
        className="conversation-recovery-action"
        label={label}
        onClick={(event) => {
          trigger.current = event.currentTarget;
          void copyDraft();
        }}
        size="sm"
      />
      {status === "copied" ? <p role="status">Message text copied.</p> : null}
      {status === "manual" ? (
        <Field style={{ flexBasis: "100%", minInlineSize: 0 }}>
          <FieldLabel htmlFor={id}>Saved message text</FieldLabel>
          <Textarea
            className="max-h-32"
            id={id}
            onFocus={(event) => event.currentTarget.select()}
            readOnly
            ref={field}
            rows={3}
            value={text}
          />
          <p role="status">Select and copy the saved message text.</p>
        </Field>
      ) : null}
    </>
  );
}

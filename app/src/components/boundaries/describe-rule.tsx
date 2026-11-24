import { HStack } from "@astryxdesign/core/HStack";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { isComposing } from "@/lib/composing";
import {
  type PolicyTranslation,
  translatePolicyRule,
} from "@/lib/computers/policy-translate";

/** What came back for one description, kept beside the words it came from. */
export type WrittenRule = PolicyTranslation & { text: string };

/**
 * A sentence in, and a button that hands it to the deployment's model: the field a boundary and a
 * team approval rule are both described in.
 *
 * `write` does the asking and answers with a sentence to show under the field when the answer can't
 * be used, or null when it was handed on. A failure it throws is shown the same way, in its message.
 * Enter writes; it never reaches a form around the field, whose Enter saves.
 */
export function DescribeField({
  id,
  label,
  description,
  example,
  placeholder,
  action,
  write,
  text,
  onTextChange,
  onWritingChange,
  disabled,
}: {
  id: string;
  label: string;
  description: string;
  example?: string;
  placeholder?: string;
  /** The button: "Write rule". It reads "Writing…" while the model answers. */
  action: string;
  write: (text: string) => Promise<string | null>;
  text?: string;
  onTextChange?: (text: string) => void;
  onWritingChange?: (writing: boolean) => void;
  disabled?: boolean;
}) {
  const [localText, setLocalText] = useState("");
  const [writing, setWriting] = useState(false);
  const writingRef = useRef(false);
  const [problem, setProblem] = useState<string | null>(null);
  const value = text ?? localText;
  const described = value.trim();

  const ask = async () => {
    if (!described || writingRef.current || disabled) return;
    writingRef.current = true;
    setProblem(null);
    setWriting(true);
    onWritingChange?.(true);
    try {
      setProblem(await write(described));
    } catch (thrown) {
      setProblem((thrown as Error).message);
    } finally {
      writingRef.current = false;
      setWriting(false);
      onWritingChange?.(false);
    }
  };

  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <FieldDescription>{description}</FieldDescription>
      {example ? (
        <FieldDescription>For example, “{example}”</FieldDescription>
      ) : null}
      <Textarea
        className="min-h-10"
        id={id}
        maxLength={1000}
        onChange={(event) => {
          const next = event.target.value;
          if (text === undefined) setLocalText(next);
          onTextChange?.(next);
        }}
        onKeyDown={(event) => {
          // Enter writes the rule. It must never reach the form around it, whose Enter saves.
          if (event.key !== "Enter" || event.shiftKey || isComposing(event))
            return;
          event.preventDefault();
          event.stopPropagation();
          void ask();
        }}
        placeholder={placeholder}
        readOnly={disabled || (writing && onWritingChange !== undefined)}
        rows={2}
        value={value}
      />
      <HStack>
        <Button
          className="min-h-12"
          disabled={!described || writing || disabled}
          onClick={() => void ask()}
          size="sm"
          type="button"
          variant="outline"
        >
          {writing ? "Writing…" : action}
        </Button>
      </HStack>
      {problem ? (
        <p className="text-destructive text-sm" role="alert">
          {problem}
        </p>
      ) : null}
    </Field>
  );
}

/**
 * "Describe the rule": a sentence in, a rule out, written by the deployment's own model.
 *
 * It fills nothing in by itself. `onWritten` hands the rule to the screen, which puts it in the CEL
 * field where the admin reads it, edits it if they want, and saves it themselves. A description that
 * only grants permission comes back as an allow rule, which these screens cannot add, so it is
 * answered here and never handed on.
 */
export function DescribeRule({
  onWritten,
  text,
  onTextChange,
  onWritingChange,
  disabled,
}: {
  onWritten: (written: WrittenRule) => void;
  text?: string;
  onTextChange?: (text: string) => void;
  onWritingChange?: (writing: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <DescribeField
      action="Write rule"
      description="Describe the action to block and when to block it. You’ll review the proposed rule before saving."
      disabled={disabled}
      id="rule-description-english"
      label="Describe the rule"
      onTextChange={onTextChange}
      onWritingChange={onWritingChange}
      example="Bots may not visit social media sites."
      text={text}
      write={async (described) => {
        const translation = await translatePolicyRule(described);
        if (translation.effect === "allow")
          return "That says what Bots may do. A rule here stops an action, so describe what no Bot may do.";
        onWritten({ ...translation, text: described });
        return null;
      }}
    />
  );
}

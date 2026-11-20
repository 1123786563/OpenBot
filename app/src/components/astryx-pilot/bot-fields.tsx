import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { astryxPilot } from "./theme";

type BotFieldProps = {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  autoFocus?: boolean;
  optional?: boolean;
  maxLength?: number;
  description?: string;
  error?: string;
} & (
  | { rows: number; type?: never; inputMode?: never }
  | { rows?: never; type?: "password"; inputMode?: "url" }
);

export function BotField({
  id,
  label,
  autoFocus,
  optional,
  description,
  error,
  rows,
  type,
  inputMode,
  onChange,
  ...control
}: BotFieldProps) {
  if (astryxPilot) {
    const props = {
      ...control,
      autoComplete: "off",
      description,
      id,
      isOptional: optional,
      label,
      onChange,
      width: "100%",
    };
    return rows ? (
      <TextArea {...props} htmlMaxLength={control.maxLength} rows={rows} />
    ) : (
      <div>
        <TextInput
          {...props}
          aria-describedby={error ? `${id}-error` : undefined}
          hasAutoFocus={autoFocus}
          inputMode={inputMode}
          status={error ? { type: "error" } : undefined}
          type={type}
        />
        {error ? (
          <BotFieldError id={`${id}-error`}>{error}</BotFieldError>
        ) : null}
      </div>
    );
  }
  const statusId = error
    ? `${id}-error`
    : description
      ? `${id}-description`
      : undefined;
  return (
    <Field data-invalid={error ? true : undefined}>
      <FieldLabel htmlFor={id}>
        {label}
        {optional && (
          <span className="font-normal text-muted-foreground">Optional</span>
        )}
      </FieldLabel>
      {rows ? (
        <Textarea
          {...control}
          autoComplete="off"
          id={id}
          onChange={(event) => onChange(event.target.value)}
          rows={rows}
        />
      ) : (
        <Input
          {...control}
          aria-describedby={statusId}
          aria-invalid={Boolean(error)}
          autoComplete="off"
          autoFocus={autoFocus}
          id={id}
          inputMode={inputMode}
          onChange={(event) => onChange(event.target.value)}
          type={type}
        />
      )}
      {error ? (
        <BotFieldError id={statusId}>{error}</BotFieldError>
      ) : description ? (
        <FieldDescription id={statusId}>{description}</FieldDescription>
      ) : null}
    </Field>
  );
}

function BotFieldError({ children, id }: { children: string; id?: string }) {
  return (
    <p className="mt-1 text-sm text-destructive" id={id} role="alert">
      {children}
    </p>
  );
}

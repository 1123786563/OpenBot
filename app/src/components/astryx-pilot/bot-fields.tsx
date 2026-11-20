import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";

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
      {error ? <BotFieldError id={`${id}-error`}>{error}</BotFieldError> : null}
    </div>
  );
}

function BotFieldError({ children, id }: { children: string; id?: string }) {
  return (
    <p className="mt-1 text-sm text-destructive" id={id} role="alert">
      {children}
    </p>
  );
}

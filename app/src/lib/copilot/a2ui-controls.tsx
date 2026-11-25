import { Button } from "@astryxdesign/core/Button";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { DateInput } from "@astryxdesign/core/DateInput";
import { DateTimeInput } from "@astryxdesign/core/DateTimeInput";
import { Icon } from "@astryxdesign/core/Icon";
import { RadioList, RadioListItem } from "@astryxdesign/core/RadioList";
import { Selector } from "@astryxdesign/core/Selector";
import { Slider } from "@astryxdesign/core/Slider";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import { TimeInput } from "@astryxdesign/core/TimeInput";
import {
  type GenerativeUIComponentProps,
  standardUI,
  useGenerativeUIAccessibility,
} from "@copilotkit/react-core/v2/generative-ui";
import {
  type ComponentProps,
  useContext,
  useEffect,
  useId,
  useState,
} from "react";
import {
  A2UIForm,
  A2UIPressable,
  droppedWhileRunning,
  FormFailures,
  openActionUrl,
} from "./a2ui-form";

type Control<Name extends keyof (typeof standardUI)["definitions"] & string> =
  GenerativeUIComponentProps<typeof standardUI, Name>;

const CatalogIcon = standardUI.components.get("Icon")?.component;

type Checks =
  | readonly {
      condition?:
        | boolean
        | {
            valid: boolean;
            severity?: "error" | "warning" | "info";
            message?: string;
          };
      message?: string;
    }[]
  | undefined;

type Status = { type: "error" | "warning"; message?: string };

/**
 * The first failed check: an error, or else the first warning. The check's message wins over the
 * message of a validator result, which is where the model puts its own wording.
 */
function failedCheck(checks: Checks): Status | undefined {
  let first: Status | undefined;
  for (const { condition, message } of checks ?? []) {
    if (condition == null || condition === true) continue;
    const failed: Status = {
      // A `false` condition and a validator's "error" are errors; its "warning" and "info" are not.
      type:
        typeof condition === "boolean" ||
        condition.severity === undefined ||
        condition.severity === "error"
          ? "error"
          : "warning",
      message:
        message ??
        (typeof condition === "boolean" ? undefined : condition.message),
    };
    if (failed.type === "error") return failed;
    first ??= failed;
  }
  return first;
}

/**
 * The check state of a control, as the catalog's own controls keep it: the message of a failed
 * check shows once the person has been in the control or it holds a value, so a fresh form does not
 * open full of errors. A warning shows its message and does not make the control invalid.
 */
function useChecks(checks: Checks, value: unknown, invalid?: boolean) {
  const [touched, setTouched] = useState(false);
  const hasValue =
    value != null &&
    value !== "" &&
    value !== false &&
    (!Array.isArray(value) || value.length > 0);
  const failed = touched || hasValue ? failedCheck(checks) : undefined;
  return {
    status: failed ?? (invalid ? { type: "error" as const } : undefined),
    onBlur: () => setTouched(true),
  };
}

/** The catalog's sizes are one step finer than Astryx's. */
const size = (value: "sm" | "md" | "lg" | "xl" | undefined) =>
  value === "xl" ? "lg" : value;

const text = (value: string | number | undefined) =>
  value == null ? "" : String(value);

type Option = { value: string; label: string; description?: string };

const optionsOf = (
  options:
    | readonly (string | (Omit<Option, "label"> & { label?: string }))[]
    | undefined,
): Option[] =>
  (options ?? []).map((option) =>
    typeof option === "string"
      ? { value: option, label: option }
      : { ...option, label: option.label ?? option.value },
  );

/** The name a field goes by: its label, else its placeholder, else none. */
const fieldName = (props: { label?: string; placeholder?: string }) => ({
  label: props.label ?? props.placeholder ?? "",
  isLabelHidden: !props.label,
});

/**
 * The catalog's TextField. A number field is typed as text and stored as a number.
 *
 * WHY NUMBERS. CopilotKit's own field writes the box's text into the data model for every variant.
 * A Bot writes the starting amounts as numbers, so a total it computes (`calc` with
 * `transport + lodging + food`) added until the person edited a field and then joined text: the
 * trip budget starter task read "$10025080" after lodging was changed to 250.
 *
 * Clearing stores zero for arithmetic, displayed blank until the field holds another number. This
 * is not a nullable field: a value set to zero from elsewhere shows "0".
 *
 * The text being typed is shown as typed until the field is left, because the field is a text box:
 * without it "250." would snap back to "250" and the next key would make "2505".
 */
function A2UITextField(props: Control<"TextField">) {
  const aria = useGenerativeUIAccessibility();
  const number = props.variant === "number";
  // A number field the person emptied, shown blank while the model still holds zero for it.
  const [empty, setEmpty] = useState(false);
  const [draft, setDraft] = useState<string>();
  useEffect(() => {
    if (props.value !== 0 || props.variant !== "number") setEmpty(false);
  }, [props.value, props.variant]);
  const { status, onBlur } = useChecks(
    props.checks,
    props.value,
    props.invalid,
  );

  const field = {
    ...aria,
    ...fieldName(props),
    "data-a2ui-input": "",
    placeholder: props.placeholder,
    htmlName: props.name,
    isRequired: props.required,
    isDisabled: props.disabled,
    size: size(props.size),
    status,
    width: "100%" as const,
    // The typed text is the theme's ink. A text box has no colour of its own, so without this it
    // would inherit the interface's text colour, which is the app's and not Astryx's.
    containerStyle: {
      flexGrow: props.weight,
      color: "var(--color-text-primary)",
    },
    value: number
      ? (draft ?? (empty && props.value === 0 ? "" : text(props.value)))
      : text(props.value),
  };

  if (props.variant === "longText")
    return <TextArea {...field} onChange={props.setValue} onBlur={onBlur} />;

  return (
    <TextInput
      {...field}
      type={
        props.variant === "obscured"
          ? "password"
          : props.variant === "email" ||
              props.variant === "url" ||
              props.variant === "tel"
            ? props.variant
            : "text"
      }
      inputMode={number ? "decimal" : undefined}
      onFocus={
        props.autoSelect
          ? (event) =>
              event.target instanceof HTMLInputElement && event.target.select()
          : undefined
      }
      onChange={(next) => {
        if (!number) {
          props.setValue(next);
          return;
        }
        // An emptied field stores zero, and text that is not a number is kept as typed.
        setDraft(next);
        setEmpty(next === "");
        const parsed = Number(next);
        props.setValue(next === "" || Number.isFinite(parsed) ? parsed : next);
      }}
      onBlur={() => {
        setDraft(undefined);
        onBlur();
      }}
    />
  );
}

function A2UITextArea(props: Control<"TextArea">) {
  const aria = useGenerativeUIAccessibility();
  const { status, onBlur } = useChecks(
    props.checks,
    props.value,
    props.invalid,
  );
  return (
    <TextArea
      {...aria}
      {...fieldName(props)}
      data-a2ui-input=""
      placeholder={props.placeholder}
      htmlName={props.name}
      isRequired={props.required}
      isDisabled={props.disabled}
      size={size(props.size)}
      rows={props.rows}
      status={status}
      width="100%"
      containerStyle={{
        flexGrow: props.weight,
        color: "var(--color-text-primary)",
      }}
      value={text(props.value)}
      onChange={props.setValue}
      onBlur={onBlur}
    />
  );
}

function A2UIButton(props: Control<"Button">) {
  const aria = useGenerativeUIAccessibility();
  const contentId = useId();
  const [copied, setCopied] = useState(false);
  const { failed, notSent } = useContext(FormFailures);
  useEffect(() => {
    if (!copied) return;
    const timeout = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timeout);
  }, [copied]);
  const check = failedCheck(props.checks);
  const child =
    props.child ?? (props.children?.length ? props.children : undefined);
  const variant =
    props.color === "danger"
      ? "destructive"
      : props.variant === "primary"
        ? "primary"
        : props.variant === "borderless"
          ? "ghost"
          : "secondary";

  return (
    <Button
      {...aria}
      data-a2ui-input=""
      data-a2ui-copied={copied ? "" : undefined}
      label={props.label ?? props.text ?? ""}
      // With content of its own, the button is named by that content.
      aria-labelledby={
        child && !props.label && !props.text ? contentId : undefined
      }
      icon={
        copied ? (
          <Icon icon="check" />
        ) : props.icon && CatalogIcon ? (
          <CatalogIcon name={props.icon} />
        ) : undefined
      }
      isIconOnly={props.uniform && Boolean(copied || props.icon) && !child}
      size={props.size}
      variant={variant}
      width={props.block ? "100%" : undefined}
      style={{ flexGrow: props.weight }}
      type={props.submit ? "submit" : "button"}
      isDisabled={Boolean(
        props.disabled || props.loading || failed || check?.type === "error",
      )}
      isLoading={props.loading}
      tooltip={check?.message}
      onClick={(event) => {
        event.stopPropagation();
        if (props.submit && event.currentTarget.form) return;
        if (props.href) {
          openActionUrl(props.href);
          return;
        }
        if (props.copy !== undefined && props.copy !== "") {
          navigator.clipboard?.writeText(props.copy).then(
            () => setCopied(true),
            () => {},
          );
          return;
        }
        void props.onClick?.({}).then((result) => {
          if (droppedWhileRunning(result)) notSent();
        });
      }}
    >
      {child ? (
        <Text as="span" id={contentId} type="inherit">
          {child}
        </Text>
      ) : undefined}
    </Button>
  );
}

function A2UICheckBox(props: Control<"CheckBox">) {
  const aria = useGenerativeUIAccessibility();
  const { status } = useChecks(props.checks, props.value);
  return (
    <CheckboxInput
      {...aria}
      {...fieldName(props)}
      data-a2ui-input=""
      htmlName={props.name}
      isRequired={props.required}
      isDisabled={props.disabled}
      status={status}
      style={{ flexGrow: props.weight }}
      value={Boolean(props.value)}
      onChange={props.setValue}
    />
  );
}

function A2UISelect(props: Control<"Select">) {
  const aria = useGenerativeUIAccessibility();
  const { status, onBlur } = useChecks(props.checks, props.value);
  return (
    <Stack onBlur={onBlur} style={{ flexGrow: 1 }}>
      <Selector
        {...aria}
        {...fieldName(props)}
        data-a2ui-input=""
        htmlName={props.name}
        isRequired={props.required}
        isDisabled={props.disabled}
        size={size(props.size)}
        status={status}
        width={props.block === false ? undefined : "100%"}
        options={optionsOf(props.options)}
        value={text(props.value)}
        // Once cleared, the list shows the empty option's label, unless a placeholder is given.
        placeholder={props.placeholder ?? props.clearLabel}
        hasClear={props.clearable}
        hasSearch={props.searchable}
        startIcon={
          props.icon && CatalogIcon ? (
            <CatalogIcon name={props.icon} />
          ) : undefined
        }
        // An emptied Select writes the catalog's empty string, not null: the SDK omits a null
        // context value from the message, which would drop the field the Bot expects.
        onChange={(next) => props.setValue(next ?? "")}
      />
    </Stack>
  );
}

function A2UIRadioGroup(props: Control<"RadioGroup">) {
  const aria = useGenerativeUIAccessibility();
  const { status, onBlur } = useChecks(props.checks, props.value);
  return (
    <Stack onBlur={onBlur} style={{ flexGrow: 1 }}>
      <RadioList
        {...aria}
        {...fieldName(props)}
        data-a2ui-input=""
        htmlName={props.name}
        orientation={props.direction === "col" ? "vertical" : "horizontal"}
        isDisabled={props.disabled}
        isRequired={props.required}
        status={status}
        value={text(props.value)}
        onChange={props.setValue}
      >
        {optionsOf(props.options).map(({ value, label, description }) => (
          <RadioListItem
            key={value}
            value={value}
            label={label}
            description={description}
          />
        ))}
      </RadioList>
    </Stack>
  );
}

/** One radio button on its own. It has no value to keep, so its own state says whether it is chosen. */
function A2UIRadio(props: Control<"Radio">) {
  const aria = useGenerativeUIAccessibility();
  const [chosen, setChosen] = useState(false);
  const value = props.value ?? "on";
  const label = props.label ?? props.value ?? "";
  return (
    <RadioList
      data-a2ui-input=""
      label={label}
      isLabelHidden
      isDisabled={props.disabled}
      isRequired={props.required}
      value={chosen ? value : ""}
      onChange={() => setChosen(true)}
    >
      <RadioListItem {...aria} label={label} value={value} />
    </RadioList>
  );
}

function A2UIChoicePicker(props: Control<"ChoicePicker">) {
  const aria = useGenerativeUIAccessibility();
  const [filter, setFilter] = useState("");
  const value: string[] = Array.isArray(props.value) ? props.value : [];
  const { status, onBlur } = useChecks(props.checks, value);
  const several = props.variant === "multipleSelection";
  const chips = props.displayStyle === "chips";
  const options = optionsOf(props.options).filter(({ label }) =>
    label.toLowerCase().includes(filter.toLowerCase()),
  );
  const toggle = (option: string) => () =>
    props.setValue(
      value.includes(option)
        ? value.filter((item) => item !== option)
        : several
          ? [...value, option]
          : [option],
    );

  return (
    <Stack
      {...aria}
      data-a2ui-input=""
      gap={2}
      onBlur={onBlur}
      style={{ flexGrow: props.weight }}
    >
      {(several || chips) && props.label && (
        <Text type="supporting">{props.label}</Text>
      )}
      {props.filterable && (
        <TextInput
          type="search"
          label={props.label ?? ""}
          isLabelHidden
          placeholder="Filter options"
          value={filter}
          onChange={setFilter}
          isDisabled={props.disabled}
        />
      )}
      {!several && !chips ? (
        <RadioList
          label={props.label ?? ""}
          isLabelHidden
          isDisabled={props.disabled}
          isRequired={props.required && value.length === 0}
          value={value[0] ?? ""}
          onChange={(option) => props.setValue([option])}
        >
          {options.map(({ value: option, label, description }) => (
            <RadioListItem
              key={option}
              value={option}
              label={label}
              description={description}
            />
          ))}
        </RadioList>
      ) : several ? (
        <Stack role="group" aria-label={props.label} gap={2}>
          {options.map(({ value: option, label, description }) => (
            <CheckboxInput
              key={option}
              label={label}
              description={description}
              value={value.includes(option)}
              onChange={toggle(option)}
              isDisabled={props.disabled}
            />
          ))}
        </Stack>
      ) : (
        <Stack
          role="group"
          aria-label={props.label}
          direction="horizontal"
          wrap="wrap"
          gap={2}
        >
          {options.map(({ value: option, label }) => (
            <Button
              key={option}
              label={label}
              aria-pressed={value.includes(option)}
              onClick={toggle(option)}
              isDisabled={props.disabled}
              variant={value.includes(option) ? "primary" : "secondary"}
            />
          ))}
        </Stack>
      )}
      {status?.message && <Text role={status.type}>{status.message}</Text>}
    </Stack>
  );
}

function A2UISlider(props: Control<"Slider">) {
  const aria = useGenerativeUIAccessibility();
  const { status, onBlur } = useChecks(props.checks, props.value);
  const min = props.min ?? 0;
  const max = props.max ?? 100;
  const step = props.steps ? (max - min) / props.steps : props.step;
  return (
    <Stack
      onBlur={onBlur}
      data-a2ui-input=""
      style={{ flexGrow: props.weight }}
    >
      <Slider
        {...aria}
        {...fieldName(props)}
        htmlName={props.name}
        isDisabled={props.disabled}
        min={min}
        max={max}
        step={step && step > 0 ? step : 1}
        value={props.value ?? min}
        marks={props.marks}
        valueDisplay={props.label || props.unit ? "text" : "none"}
        formatValue={
          props.unit ? (value) => `${value} ${props.unit}` : undefined
        }
        status={status}
        onChange={props.setValue}
      />
    </Stack>
  );
}

type DateValue = NonNullable<ComponentProps<typeof DateInput>["value"]>;
type TimeValue = NonNullable<ComponentProps<typeof TimeInput>["value"]>;
type DateTimeValue = NonNullable<ComponentProps<typeof DateTimeInput>["value"]>;

const isDate = (value: string): value is DateValue =>
  /^\d{4}-\d{2}-\d{2}$/.test(value);
const isTime = (value: string): value is TimeValue =>
  /^\d{2}:\d{2}(:\d{2})?$/.test(value);
function isDateTime(value: string): value is DateTimeValue {
  const [date, time, ...rest] = value.split("T");
  return rest.length === 0 && isDate(date ?? "") && isTime(time ?? "");
}

function A2UIDateTimeInput(props: Control<"DateTimeInput">) {
  const aria = useGenerativeUIAccessibility();
  const { status, onBlur } = useChecks(props.checks, props.value);
  const value = text(props.value);
  const min = text(props.min);
  const max = text(props.max);
  const time = props.enableTime === true;
  const date = props.enableDate ?? !time;
  const common = {
    ...aria,
    ...fieldName(props),
    isRequired: props.required,
    isDisabled: props.disabled,
    hasClear: props.clearable,
    size: size(props.size),
    status,
    width: props.block === false ? undefined : "100%",
    // An emptied field writes an empty string, as the value it holds is text.
    onChange: (next: string | undefined) => props.setValue(next ?? ""),
  };
  return (
    <Stack
      onBlur={onBlur}
      data-a2ui-input=""
      style={{ flexGrow: props.weight }}
    >
      {time && date ? (
        <DateTimeInput
          {...common}
          value={isDateTime(value) ? value : undefined}
          min={isDateTime(min) ? min : undefined}
          max={isDateTime(max) ? max : undefined}
        />
      ) : time ? (
        <TimeInput
          {...common}
          value={isTime(value) ? value : undefined}
          min={isTime(min) ? min : undefined}
          max={isTime(max) ? max : undefined}
          increment={props.timeStep}
        />
      ) : (
        <DateInput
          {...common}
          value={isDate(value) ? value : undefined}
          min={isDate(min) ? min : undefined}
          max={isDate(max) ? max : undefined}
        />
      )}
    </Stack>
  );
}

/**
 * The catalog's input controls that stay as the SDK draws them. Astryx's own SegmentedControl
 * names its group for a screen reader and never shows a label, so drawing it with Astryx would
 * lose the label the catalog gives it. It reads the same `--a2ui-*` theme variables and takes the
 * keyboard like the catalog's other controls; a2ui-form.test.tsx holds it to that.
 */
export const SDK_DRAWN_CONTROLS = ["SegmentedControl"] as const;

/** The interactive controls of `openbot/ui@1`, drawn by Astryx. Names, props and events are the catalog's. */
export const astryxA2UIOverrides = {
  Button: { component: A2UIButton },
  CheckBox: { component: A2UICheckBox },
  ChoicePicker: { component: A2UIChoicePicker },
  DateTimeInput: { component: A2UIDateTimeInput },
  Form: { component: A2UIForm },
  Pressable: { component: A2UIPressable },
  Radio: { component: A2UIRadio },
  RadioGroup: { component: A2UIRadioGroup },
  Select: { component: A2UISelect },
  Slider: { component: A2UISlider },
  TextArea: { component: A2UITextArea },
  TextField: { component: A2UITextField },
};

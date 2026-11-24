import { Banner } from "@astryxdesign/core/Banner";
import { Stack } from "@astryxdesign/core/Stack";
import {
  type GenerativeUIComponentProps,
  type standardUI,
  useGenerativeUIAccessibility,
} from "@copilotkit/react-core/v2/generative-ui";
import {
  type CSSProperties,
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

type Control<Name extends keyof (typeof standardUI)["definitions"] & string> =
  GenerativeUIComponentProps<typeof standardUI, Name>;

/**
 * The Form a control is in. A node that failed to render counts itself here, so the Form stops
 * submitting and its Buttons stop pressing: a form that is missing a field must not be sent as
 * complete.
 */
export const FormFailures = createContext({
  failed: false,
  count: (_change: number) => {},
});

/**
 * What CopilotKit draws in place of a generated component that threw (the `errorBoundary.fallback`
 * of the provider). Only that component is replaced: its neighbours in the interface, and the rest
 * of the message, stay as they were.
 */
export function A2UINodeError() {
  const { count } = useContext(FormFailures);
  useEffect(() => {
    count(1);
    return () => count(-1);
  }, [count]);
  return (
    <Banner
      role="alert"
      status="error"
      title="Couldn't show this part of the reply."
      description="The rest of the conversation still works. Ask the Bot to send this part again."
    />
  );
}

export function A2UIForm(props: Control<"Form">) {
  const aria = useGenerativeUIAccessibility();
  const [failed, setFailed] = useState(0);
  const count = useRef((_change: number) =>
    setFailed((total) => total + _change),
  ).current;
  return (
    <FormFailures.Provider value={{ failed: failed > 0, count }}>
      <Stack
        {...aria}
        as="form"
        aria-label={props.label}
        direction="vertical"
        // Four steps between a form's fields is the catalog's default.
        gap={props.gap === undefined ? 4 : undefined}
        data-a2ui-input=""
        style={{ minWidth: 0, ...layoutStyle(props) }}
        onSubmit={(event) => {
          event.preventDefault();
          if (failed === 0) props.onSubmit?.({});
        }}
      >
        {props.children}
      </Stack>
    </FormFailures.Provider>
  );
}

/** Opens an http, https or mailto address in a new tab. Any other scheme is ignored. */
export function openActionUrl(href: string | undefined) {
  const url = href?.trim();
  if (url && /^(https?:|mailto:)/i.test(url))
    window.open(url, "_blank", "noopener,noreferrer");
}

const FLEX_ALIGN = {
  start: "flex-start",
  end: "flex-end",
  center: "center",
  baseline: "baseline",
  stretch: "stretch",
};
const FLEX_JUSTIFY = {
  ...FLEX_ALIGN,
  spaceBetween: "space-between",
  spaceAround: "space-around",
  spaceEvenly: "space-evenly",
};

/** A length the model gives a container: a number counts 4px steps, a string is CSS. */
const length = (value: number | string | undefined) =>
  typeof value === "number" ? `calc(var(--spacing-1) * ${value})` : value;

/** Where a container puts its children, and how wide and tall it is. */
function layoutStyle(props: {
  align?: keyof typeof FLEX_ALIGN;
  justify?: keyof typeof FLEX_JUSTIFY;
  wrap?: "nowrap" | "wrap" | "wrap-reverse";
  gap?: number | string;
  padding?: number | string;
  border?: boolean;
  width?: number | string;
  height?: number | string;
  flex?: number;
}): CSSProperties {
  return {
    alignItems: props.align ? FLEX_ALIGN[props.align] : undefined,
    justifyContent: props.justify ? FLEX_JUSTIFY[props.justify] : undefined,
    flexWrap: props.wrap,
    gap: length(props.gap),
    padding: length(props.padding),
    border: props.border
      ? "1px solid var(--a2ui-color-border-default)"
      : undefined,
    width: length(props.width),
    height: length(props.height),
    flex: props.flex,
  };
}

export function A2UIPressable(props: Control<"Pressable">) {
  const aria = useGenerativeUIAccessibility();
  const container = useRef<HTMLElement>(null);
  const seen = useRef(false);
  const { onVisible } = props;
  // `onVisible` is sent once, the first time the container scrolls into view.
  useEffect(() => {
    const element = container.current;
    if (!element || !onVisible || seen.current) return;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      seen.current = true;
      observer.disconnect();
      onVisible({});
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [onVisible]);

  const press = () => {
    if (props.disabled) return;
    if (props.href) openActionUrl(props.href);
    else props.onClick?.({});
  };

  return (
    <Stack
      {...aria}
      ref={container}
      role="button"
      tabIndex={props.disabled ? -1 : 0}
      aria-disabled={props.disabled || undefined}
      aria-pressed={props.ariaPressed}
      aria-description={props.tooltip}
      data-a2ui-input=""
      direction="vertical"
      style={{
        cursor: props.disabled ? "not-allowed" : "pointer",
        opacity: props.disabled ? 0.5 : undefined,
        boxShadow: props.insetBorder
          ? "inset 0 0 0 1px var(--a2ui-color-border-default)"
          : undefined,
        ...layoutStyle(props),
      }}
      onClick={(event) => {
        event.stopPropagation();
        press();
      }}
      onKeyDown={(event) => {
        if (
          event.target !== event.currentTarget ||
          (event.key !== "Enter" && event.key !== " ")
        )
          return;
        event.preventDefault();
        press();
      }}
    >
      {props.children}
    </Stack>
  );
}

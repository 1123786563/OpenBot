import { Banner } from "@astryxdesign/core/Banner";
import { Stack } from "@astryxdesign/core/Stack";
import {
  type GenerativeUIComponentProps,
  type GenerativeUIInvokeResult,
  type GenerativeUITheme,
  type standardUI,
  useGenerativeUIAccessibility,
  useGenerativeUIRuntime,
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
  /** Says an event of this form was not sent because the Bot is still replying. */
  notSent: () => {},
});

/**
 * Whether the SDK dropped an event because the Bot was still replying. It reports that on the
 * result of the event and nowhere else, so the control that sent it is the one that can say so.
 */
export function droppedWhileRunning(result: GenerativeUIInvokeResult) {
  return !result.ok && result.error.code === "agent_busy";
}

/**
 * The error state for a part of a reply that could not be drawn. It says what is missing and the
 * one next step.
 */
function A2UIPartError() {
  return (
    <Banner
      role="alert"
      status="error"
      title="Couldn't show this part of the reply."
      description="The rest of the conversation still works. Ask the Bot to send this part again."
    />
  );
}

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
  return <A2UIPartError />;
}

export function A2UIForm(props: Control<"Form">) {
  const aria = useGenerativeUIAccessibility();
  const { theme } = useGenerativeUIRuntime() ?? {};
  const element = useRef<HTMLFormElement>(null);
  const [failed, setFailed] = useState(0);
  const [undrawn, setUndrawn] = useState(0);
  const [unsent, setUnsent] = useState(false);
  const notSent = useRef(() => setUnsent(true)).current;
  const count = useRef((_change: number) =>
    setFailed((total) => total + _change),
  ).current;
  // A control bound to a value of the wrong type is swapped by the SDK for its own error node, and
  // an update the SDK refused leaves a line in the card around the interface while the form keeps
  // whatever drew before it. No boundary catches either, so nothing counts it in the context: the
  // form reads both from the DOM. The stylesheet hides the SDK's node and this error stands in its
  // place. Both can also go away again when a later update repairs the interface.
  useEffect(() => {
    const form = element.current;
    if (!form) return;
    const card = form.closest("[data-generative-ui-chat-surface]");
    const countUndrawn = () =>
      setUndrawn(
        form.querySelectorAll("[data-generative-ui-error]").length +
          (card?.querySelector(':scope > [role="alert"]') ? 1 : 0),
      );
    countUndrawn();
    const observer = new MutationObserver(countUndrawn);
    observer.observe(form, { childList: true, subtree: true });
    // The line arrives after the form when the refusal comes from the browser.
    if (card) observer.observe(card, { childList: true });
    return () => observer.disconnect();
  }, []);
  const broken = failed > 0 || undrawn > 0;
  return (
    <FormFailures.Provider value={{ failed: broken, count, notSent }}>
      <Stack
        {...aria}
        ref={element}
        as="form"
        aria-label={props.label}
        direction="vertical"
        // Four steps between a form's fields is the catalog's default.
        gap={props.gap === undefined ? 4 : undefined}
        data-a2ui-input=""
        style={layoutStyle(props, theme)}
        onSubmit={(event) => {
          event.preventDefault();
          if (broken) return;
          // The SDK drops an event that arrives while the Bot is still replying. Say so, or the
          // person believes the form was sent.
          void props
            .onSubmit?.({})
            .then((result) => setUnsent(droppedWhileRunning(result)));
        }}
      >
        {unsent && (
          <Banner
            role="status"
            status="warning"
            title="Nothing was sent. The Bot is still replying."
            description="Send it again once the reply has finished."
          />
        )}
        {undrawn > 0 && <A2UIPartError />}
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

/** Where a container puts its children, and how wide and tall it is. The catalog's layout props. */
function layoutStyle(
  props: Control<"Form"> | Control<"Pressable">,
  theme: GenerativeUITheme | undefined,
): CSSProperties {
  const themed = (name: string) =>
    Object.hasOwn(theme ?? {}, name) || Object.hasOwn(theme?.dark ?? {}, name);
  /**
   * A surface or border colour the catalog names. A name the theme gives a `--a2ui-*` variable
   * becomes that variable; anything else is CSS, as the catalog passes a raw colour through.
   */
  const paint = (
    family: "color" | "color-border",
    value: string | undefined,
  ) => {
    if (!value) return undefined;
    const name = `--a2ui-${family}-${value}`;
    return themed(name) ? `var(${name})` : value;
  };
  /** A radius token, a number of pixels, or one corner's raw CSS. */
  const corner = (value: string | number | undefined) => {
    if (value === undefined) return undefined;
    if (typeof value === "number")
      return `calc(var(--spacing-px, 0.0625rem) * ${value})`;
    if (value === "full") return "var(--a2ui-radius-full, var(--radius-full))";
    const name = `--a2ui-radius-${value}`;
    return themed(name) ? `var(${name})` : value;
  };
  const radius = props.radius;
  const corners =
    typeof radius === "object" && radius !== null
      ? {
          borderTopLeftRadius: corner(radius.topLeft),
          borderTopRightRadius: corner(radius.topRight),
          borderBottomLeftRadius: corner(radius.bottomLeft),
          borderBottomRightRadius: corner(radius.bottomRight),
        }
      : { borderRadius: corner(radius) };
  return {
    display: props.inline ? "inline-flex" : undefined,
    alignItems: props.align ? FLEX_ALIGN[props.align] : undefined,
    justifyContent: props.justify ? FLEX_JUSTIFY[props.justify] : undefined,
    flexWrap: props.wrap,
    gap: length(props.gap) ?? (props.disableAutoSpacing ? 0 : undefined),
    rowGap: length(props.rowGap),
    columnGap: length(props.columnGap),
    padding: props.flush ? 0 : length(props.padding),
    background: paint("color", props.background),
    border: props.border
      ? `1px solid ${paint("color-border", props.borderColor ?? "default")}`
      : undefined,
    ...corners,
    width: length(props.width),
    height: length(props.height),
    minWidth: length(props.minWidth ?? props.minSize) ?? 0,
    maxWidth: length(props.maxWidth ?? props.maxSize) ?? "100%",
    minHeight: length(props.minHeight ?? props.minSize),
    maxHeight: length(props.maxHeight ?? props.maxSize),
    flex: props.flex,
    flexGrow: props.weight,
    aspectRatio: props.aspectRatio,
    overflow: props.scrollable ? "auto" : props.clip ? "hidden" : undefined,
    boxShadow: props.shadow
      ? "var(--a2ui-shadow-sm, var(--shadow-low))"
      : undefined,
    boxSizing: "border-box",
  };
}

export function A2UIPressable(props: Control<"Pressable">) {
  const aria = useGenerativeUIAccessibility();
  const { theme } = useGenerativeUIRuntime() ?? {};
  const container = useRef<HTMLElement>(null);
  const seen = useRef(false);
  const { notSent } = useContext(FormFailures);
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
    else
      void props.onClick?.({}).then((result) => {
        if (droppedWhileRunning(result)) notSent();
      });
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
        ...layoutStyle(props, theme),
        ...(props.insetBorder
          ? { boxShadow: "inset 0 0 0 1px var(--a2ui-color-border-default)" }
          : {}),
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

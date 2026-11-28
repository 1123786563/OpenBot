import type { Page } from "playwright-core";

/**
 * How the words on a page read in a real browser: the contrast of every visible text node against what is behind it,
 * the Astryx palette resolved at the theme scope, and the ink of a form's field, label and error nodes.
 *
 * Used by the interfaces a Bot draws (`a2ui-frame.test.tsx`) and by the device and credential pages
 * (`device-pages-frame.test.tsx`), so the WCAG arithmetic is written once. Lifted from the A2UI frame test.
 */

export type ReadOptions = {
  /** Every visible text node inside this selector is measured. */
  scope: string;
  /** A text field and its label, whose ink is reported. Absent: no ink is read. */
  form?: { input: string; label: string };
  /** The SDK's own error nodes, by selector, whose ink is reported. */
  errors?: string;
  /** Measure an empty field's placeholder as a word, when the browser gives its computed colour. */
  placeholders?: boolean;
};

export type Word = { text: string; contrast: number };

export type Read<Ink = null> = {
  ink: Ink;
  palette: string[];
  words: Word[];
  errorInks: string[];
};

/** The options `a2ui-frame.test.tsx` reads a conversation's interfaces with. */
const CHAT: Required<Pick<ReadOptions, "scope" | "form" | "errors">> = {
  scope: "[data-generative-ui-chat-surface]",
  form: {
    input: "[data-generative-ui-chat-surface] .astryx-text-input input",
    label: "[data-generative-ui-chat-surface] .astryx-field-label",
  },
  errors: "[data-generative-ui-chat-surface] [data-generative-ui-error]",
};

/** A conversation's interface: the field and label are there, so their ink is always read. */
export function read(
  page: Page,
): Promise<Read<{ field: string; label: string }>>;
export function read(page: Page, options: ReadOptions): Promise<Read>;
export async function read(page: Page, options?: ReadOptions) {
  const asked: ReadOptions = options ?? CHAT;
  return page.evaluate((readOptions: ReadOptions) => {
    const scope = document.querySelector("[data-astryx-theme]");
    if (!scope) throw new Error("the page has no Astryx theme scope");
    const probe = document.createElement("span");
    scope.append(probe);
    const palette = new Set<string>();
    for (const name of getComputedStyle(scope)) {
      if (!name.startsWith("--color-")) continue;
      probe.style.color = `var(${name})`;
      palette.add(getComputedStyle(probe).color);
    }
    probe.remove();

    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("no canvas");
    // A canvas reads any CSS colour as sRGB, but flattens a translucent one against black, so
    // the alpha is read from the text and the colour measured opaque.
    const rgba = (colour: string): number[] => {
      // Computed colours come as rgb(), rgba(r, g, b, a) or as `<space>(... / a)`.
      const a = colour.startsWith("rgba(")
        ? Number(/,\s*([\d.]+)\)$/.exec(colour)?.[1])
        : Number(/\/\s*([\d.]+)\s*\)$/.exec(colour)?.[1] ?? 1);
      const opaque =
        a === 1
          ? colour
          : colour.startsWith("rgba(")
            ? colour.replace(/,\s*[\d.]+\)$/, ")").replace("rgba(", "rgb(")
            : colour.replace(/\/\s*[\d.]+\s*\)$/, ")");
      context.fillStyle = "#000000";
      context.fillStyle = opaque;
      context.fillRect(0, 0, 1, 1);
      const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
      return [r, g, b, a];
    };
    const over = ([tr, tg, tb, ta]: number[], [br, bg, bb]: number[]) => [
      tr * ta + br * (1 - ta),
      tg * ta + bg * (1 - ta),
      tb * ta + bb * (1 - ta),
      1,
    ];
    /** What is behind an element: its own and its ancestors' fills, composited over the page. */
    const behind = (element: Element): number[] => {
      const layers: number[][] = [];
      for (let at: Element | null = element; at; at = at.parentElement) {
        const fill = rgba(getComputedStyle(at).backgroundColor);
        if (fill[3] === 0) continue;
        layers.push(fill);
        if (fill[3] === 1) break;
      }
      return layers
        .reverse()
        .reduce((page, layer) => over(layer, page), [255, 255, 255, 1]);
    };
    const luminance = ([r, g, b]: number[]) => {
      const channel = (value: number) => {
        const s = value / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    };
    const contrast = (a: number[], b: number[]) => {
      const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (high + 0.05) / (low + 0.05);
    };

    const words: { text: string; contrast: number }[] = [];
    for (const element of document.querySelectorAll<HTMLElement>(
      `${readOptions.scope} *`,
    )) {
      if (!element.checkVisibility()) continue;
      if (element.closest('[aria-disabled="true"]')) continue;
      const text = [...element.childNodes]
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent?.trim())
        .join("");
      if (!text) continue;
      const style = getComputedStyle(element);
      words.push({
        text,
        contrast: contrast(
          over(rgba(style.color), behind(element)),
          behind(element),
        ),
      });
    }
    if (readOptions.placeholders) {
      for (const field of document.querySelectorAll<
        HTMLInputElement | HTMLTextAreaElement
      >("input[placeholder], textarea[placeholder]")) {
        if (!field.checkVisibility() || field.value) continue;
        const colour = getComputedStyle(field, "::placeholder").color;
        if (!colour) continue;
        words.push({
          text: `placeholder: ${field.placeholder}`,
          contrast: contrast(over(rgba(colour), behind(field)), behind(field)),
        });
      }
    }
    const errorInks = readOptions.errors
      ? [...document.querySelectorAll<HTMLElement>(readOptions.errors)]
          .filter((node) => node.checkVisibility())
          .map((node) => getComputedStyle(node).color)
      : [];
    const input = readOptions.form
      ? document.querySelector<HTMLElement>(readOptions.form.input)
      : null;
    const label = readOptions.form
      ? document.querySelector<HTMLElement>(readOptions.form.label)
      : null;
    if (readOptions.form && (!input || !label))
      throw new Error("the form has no labelled text field");
    return {
      ink:
        input && label
          ? {
              field: getComputedStyle(input).color,
              label: getComputedStyle(label).color,
            }
          : null,
      palette: [...palette],
      words,
      errorInks,
    };
  }, asked);
}

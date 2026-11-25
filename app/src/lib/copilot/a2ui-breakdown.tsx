import { HStack } from "@astryxdesign/core/HStack";
import { Slider } from "@astryxdesign/core/Slider";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { useState } from "react";
import { z } from "zod";
import { SERIES_COLOURS } from "@/components/gallery/palette";

const part = z.object({
  label: z.string().describe("What this part is, e.g. Lodging"),
  amount: z.number().describe("Its amount, a number"),
});

export const breakdownProps = z.object({
  items: z
    .array(part)
    .describe(
      'The parts, two to six, in the order to show them. Bind it with { "@path": "/items" } to a list of { label, amount } in the data model, so the user\'s changes are kept there',
    ),
  currency: z
    .string()
    .optional()
    .describe('For money, the ISO 4217 code, e.g. "USD" or "EUR"'),
  unit: z
    .string()
    .optional()
    .describe('For amounts that are not money, the unit, e.g. "h" or "kg"'),
  totalLabel: z.string().optional().describe('Default "Total"'),
  max: z
    .number()
    .optional()
    .describe(
      "The top of every slider. Default: about twice the largest amount",
    ),
});

export const BREAKDOWN_DESCRIPTION =
  "Amounts that add up to a total, such as a budget, a time plan or a split bill. The user changes each amount with its slider or by typing it. Each part has its own colour, a bar shows how the total splits, and the total updates as they edit. Use it instead of separate number fields and a total you compute.";

type Part = z.infer<typeof part>;
type Props = Partial<Omit<z.infer<typeof breakdownProps>, "items">> & {
  items?: Part[] | undefined;
  setItems: (items: Part[]) => void;
};

/** Past the sixth part a colour would repeat, so the rest share the muted ink and keep their labels. */
const BEYOND_PALETTE = "var(--muted-foreground)";

function colourAt(index: number): string {
  return SERIES_COLOURS[index] ?? BEYOND_PALETTE;
}

/** An amount that has arrived. While the Bot writes the list, a part can be there before its number. */
function amountOf(entry: Part | undefined): number {
  const amount = entry?.amount;
  return typeof amount === "number" && Number.isFinite(amount) ? amount : 0;
}

/** The smallest of `steps` times a power of ten that is at least `value`. */
function niceCeil(value: number, steps = [1, 2, 2.5, 5, 10]): number {
  if (!(value > 0)) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  const scaled = value / power;
  return (steps.find((step) => scaled <= step) ?? 10) * power;
}

/**
 * How amounts read, as money when the Bot named a currency. A code Intl does not know, such as "$",
 * is drawn as written in front of the number.
 */
function amountFormat(currency?: string, unit?: string) {
  const code = currency?.trim();
  if (code) {
    try {
      const sample = new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: code,
        currencyDisplay: "narrowSymbol",
      });
      const parts = sample.formatToParts(1);
      const symbol = parts.find((p) => p.type === "currency")?.value ?? code;
      const after =
        parts.findIndex((p) => p.type === "currency") >
        parts.findIndex((p) => p.type === "integer");
      return {
        format: (value: number) =>
          new Intl.NumberFormat(undefined, {
            style: "currency",
            currency: code,
            currencyDisplay: "narrowSymbol",
            minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
            maximumFractionDigits: 2,
          }).format(value),
        affix: symbol,
        after,
      };
    } catch {
      const plain = new Intl.NumberFormat(undefined, {
        maximumFractionDigits: 2,
      });
      return {
        format: (value: number) => `${code}${plain.format(value)}`,
        affix: code,
        after: false,
      };
    }
  }
  const plain = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
  const suffix = unit?.trim();
  return {
    format: (value: number) =>
      suffix ? `${plain.format(value)} ${suffix}` : plain.format(value),
    affix: suffix,
    after: true,
  };
}

/**
 * The slider scale, shared by every part so the filled tracks compare like bars. It starts at about
 * twice the largest amount and only grows, when a typed amount goes past it, so a thumb never jumps
 * while somebody drags another one.
 */
function useScale(largest: number, max: number | undefined) {
  const [ceiling, setCeiling] = useState(0);
  if (largest > ceiling) setCeiling(niceCeil(largest * 2));
  const top = max !== undefined && max > 0 ? max : ceiling || 1;
  // About a hundred stops along the track, each a round number: 5 at a time on a $400 scale.
  return { top, step: niceCeil(top / 100, [1, 2, 5, 10]) };
}

/**
 * A total and the parts it is made of, each part editable, in its own colour.
 *
 * WHY A COMPONENT OF ITS OWN. Drawn from the standard controls, the "Build a trip budget" starter
 * task was grey sliders or number boxes and a line of black text adding them up. Nothing tied a
 * control to its share of the total, and the controls could not be coloured by part because a
 * slider does not know which total it belongs to. Here one component holds the parts, so a part's
 * colour is the same on its swatch and its slice of the bar, and the total and the shares are
 * computed here as the person edits, with no `calc` expression for the Bot to get wrong. The
 * sliders are Astryx's and take the theme's accent: Astryx's slider has no colour of its own.
 *
 * The colours are the gallery's series colours, so a part reads the same as a slice of a donut
 * chart. `items` is writable: bound to the data model, every edit is written back there.
 */

/**
 * Each part's share of the total as a whole percent, adding up to exactly 100: every share rounded
 * down, then the points left over go to the parts that lost the most to rounding (the largest
 * remainder method). Rounding each share on its own can show 24 + 48 + 29 = 101%.
 */
function wholeShares(amounts: number[], shown: number): number[] {
  if (shown <= 0) return amounts.map(() => 0);
  const exact = amounts.map((amount) => (Math.max(0, amount) / shown) * 100);
  const shares = exact.map(Math.floor);
  let left = 100 - shares.reduce((sum, share) => sum + share, 0);
  const byRemainder = exact
    .map((value, index) => ({ index, rest: value - Math.floor(value) }))
    .sort((a, b) => b.rest - a.rest);
  for (const { index, rest } of byRemainder) {
    if (left <= 0 || rest <= 0) break;
    shares[index] = (shares[index] ?? 0) + 1;
    left -= 1;
  }
  return shares;
}

export function A2UIBreakdown({
  items: given,
  setItems,
  currency,
  unit,
  totalLabel,
  max,
}: Props) {
  const items = Array.isArray(given) ? given : [];
  const amounts = items.map(amountOf);
  const total = amounts.reduce((sum, amount) => sum + amount, 0);
  const shown = amounts.reduce((sum, amount) => sum + Math.max(0, amount), 0);
  const { format, affix, after } = amountFormat(currency, unit);
  const { top, step } = useScale(Math.max(0, ...amounts), max);
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [active, setActive] = useState<number | null>(null);

  const write = (index: number, amount: number) => {
    setItems(
      items.map((entry, at) => (at === index ? { ...entry, amount } : entry)),
    );
  };
  const shares = wholeShares(amounts, shown);

  return (
    <Stack data-slot="breakdown" direction="vertical" gap={4}>
      <Stack direction="vertical" gap={2}>
        <Text type="supporting">{totalLabel?.trim() || "Total"}</Text>
        <Text
          aria-live="polite"
          data-slot="breakdown-total"
          hasTabularNumbers
          weight="semibold"
        >
          {format(total)}
        </Text>
        {/* The rows below name every share in words, so the bar is a picture of them. */}
        <Stack
          aria-hidden="true"
          data-slot="breakdown-bar"
          direction="horizontal"
          gap={0.5}
          style={{
            blockSize: "var(--spacing-2)",
            inlineSize: "100%",
            borderRadius: "var(--radius-full)",
            background: "var(--color-background-muted)",
            overflow: "hidden",
          }}
        >
          {amounts.map((amount, index) =>
            amount > 0 ? (
              <Stack
                data-part={items[index]?.label ?? ""}
                // biome-ignore lint/suspicious/noArrayIndexKey: a part is its position; its label is still being written while the Bot streams it.
                key={index}
                style={{
                  background: colourAt(index),
                  flexGrow: amount,
                  minInlineSize: "var(--spacing-1)",
                  opacity:
                    active !== null && active !== index ? 0.35 : undefined,
                }}
              />
            ) : null,
          )}
        </Stack>
      </Stack>

      <Stack direction="vertical" gap={4}>
        {items.map((entry, index) => {
          const amount = amounts[index] ?? 0;
          const colour = colourAt(index);
          const label = typeof entry?.label === "string" ? entry.label : "";
          const edit = (text: string) => {
            setDrafts((current) => ({ ...current, [index]: text }));
            // A box being cleared counts as nothing until a new amount is typed.
            const number = text.trim() === "" ? 0 : Number(text);
            if (Number.isFinite(number)) write(index, Math.max(0, number));
          };
          const slide = (value: number) => {
            setDrafts(({ [index]: _, ...rest }) => rest);
            write(index, value);
          };
          return (
            <Stack
              // biome-ignore lint/suspicious/noArrayIndexKey: as above, a part is its position.
              key={index}
              data-slot="breakdown-part"
              direction="vertical"
              gap={1}
              onBlur={() => setActive(null)}
              onFocus={() => setActive(index)}
              onPointerEnter={() => setActive(index)}
              onPointerLeave={() => setActive(null)}
            >
              <HStack align="center" gap={2}>
                <Stack
                  aria-hidden="true"
                  style={{
                    background: colour,
                    blockSize: "var(--spacing-2)",
                    inlineSize: "var(--spacing-2)",
                    borderRadius: "var(--radius-inner)",
                    flexShrink: 0,
                  }}
                />
                <Text hasTruncateTooltip maxLines={1}>
                  {label}
                </Text>
                <Text hasTabularNumbers type="supporting">
                  {`${shares[index] ?? 0}%`}
                </Text>
                {affix ? (
                  <Text type="supporting" style={{ order: after ? 1 : -1 }}>
                    {affix}
                  </Text>
                ) : null}
                <TextInput
                  data-a2ui-input=""
                  inputMode="decimal"
                  isLabelHidden
                  label={label}
                  onBlur={() => setDrafts(({ [index]: _, ...rest }) => rest)}
                  onChange={edit}
                  size="sm"
                  value={drafts[index] ?? String(amount)}
                  width="8rem"
                />
              </HStack>
              <Slider
                formatValue={format}
                isLabelHidden
                label={label}
                max={top}
                min={0}
                onChange={slide}
                step={step}
                value={Math.min(Math.max(0, amount), top)}
                valueDisplay="none"
              />
            </Stack>
          );
        })}
      </Stack>
    </Stack>
  );
}

import { useTranslation } from "react-i18next";
import type enAdmin from "@/locales/en/admin.json";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import type { GatewayAudioPathAvailability } from "@/lib/gateway/queries";

/**
 * The audio path availability rows (Bifrost 14.4, #313): what an administrator reads to
 * know which audio processing paths are callable and — the point of the ticket — WHY an
 * unverified one is not, in the registry's own missing-item vocabulary.
 *
 * THE SERVER HOLDS THE VERDICT. Every judgment here arrives in the rows: `exists` false
 * is a checked absence, a non-empty `missingItems` is the structural gap list a refusal
 * names verbatim, and the per-ref `bases` rollup carries the basis-dependent half (which
 * dimensions each audio cell's latest snapshot leaves unknown). The component computes
 * nothing — it translates codes to sentences and renders them.
 *
 * A REASON IS A SENTENCE, NOT A CODE. The missing-item codes map through the locale's
 * own closed key set (typed against the en bundle, the source of truth), so a code a
 * future registry adds before the locale learns it falls back to the code itself — the
 * sentence may be missing, the information may not.
 */
const AUDIO_MISSING_ITEM_CODES = {
  no_wire_price_source: "no_wire_price_source",
  no_input_meter_wired: "no_input_meter_wired",
  no_admission_wiring: "no_admission_wiring",
  no_gateway_entrypoint: "no_gateway_entrypoint",
} as const satisfies Record<string, keyof typeof enAdmin.gateway.audio.missing>;

function missingItemText(
  t: ReturnType<typeof useTranslation<"admin">>["t"],
  code: string,
): string {
  const key =
    AUDIO_MISSING_ITEM_CODES[code as keyof typeof AUDIO_MISSING_ITEM_CODES];
  return key ? t(`gateway.audio.missing.${key}`) : code;
}

export function AudioPathAvailability({
  paths,
}: {
  paths: readonly GatewayAudioPathAvailability[];
}) {
  const { t } = useTranslation("admin");
  return (
    <>
      {paths.map((path) => (
        <Item
          data-testid={`audio-path-${path.path}-${path.stream ? "stream" : "unary"}`}
          key={`${path.path}-${path.stream ? "stream" : "unary"}`}
          size="sm"
        >
          <ItemContent>
            <ItemTitle>
              {path.exists ? (
                path.missingItems.length === 0 &&
                path.bases.some((basis) => basis.enableable) ? (
                  <span
                    className="text-emerald-600"
                    data-testid="audio-path-state"
                  >
                    {t("gateway.audio.available")}
                  </span>
                ) : (
                  <span
                    className="text-destructive"
                    data-testid="audio-path-state"
                  >
                    {t("gateway.audio.unavailable")}
                  </span>
                )
              ) : (
                <span
                  className="text-muted-foreground"
                  data-testid="audio-path-state"
                >
                  {t("gateway.audio.notAnEntrance")}
                </span>
              )}{" "}
              · {path.path}
              {path.stream ? ` · ${t("gateway.audio.streamVariant")}` : ""}
            </ItemTitle>
            {path.missingItems.length > 0 ? (
              <ItemDescription data-testid="audio-path-missing-intro">
                {t("gateway.audio.missingIntro")}
              </ItemDescription>
            ) : null}
            {path.missingItems.map((item) => (
              <ItemDescription data-testid="audio-path-missing" key={item.code}>
                {missingItemText(t, item.code)}
              </ItemDescription>
            ))}
            {path.exists
              ? path.bases.map((basis) => (
                  <ItemDescription key={basis.ref}>
                    {basis.enableable
                      ? t("gateway.audio.basisEnableable", { ref: basis.ref })
                      : t("gateway.audio.basisMissingDims", {
                          ref: basis.ref,
                          dimensions: basis.missingDimensions
                            .map((dimension) => dimension.dimension)
                            .join("、"),
                        })}
                  </ItemDescription>
                ))
              : null}
          </ItemContent>
        </Item>
      ))}
    </>
  );
}

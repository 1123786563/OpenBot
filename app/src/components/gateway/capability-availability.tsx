import { useTranslation } from "react-i18next";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import type { GatewayCapabilityAvailability } from "@/lib/gateway/queries";

/**
 * The group-11 capability availability rows (Bifrost 11.6, #301): what an administrator
 * reads to know whether the gateway can bill Embedding, Rerank and OCR strictly — and, the
 * point of the ticket, that an unknown price never shows as free.
 *
 * THE SERVER HOLDS THE VERDICT. Every judgment arrives in the rows: `state` is the
 * basis-level summary over each capability's own billed dimensions, and
 * `missingDimensions` is the per-cell worklist a re-pricing acts on. The component computes
 * nothing — it maps states to sentences and renders them, with FREE and UNKNOWN in
 * deliberately different words and colors, so no surface can conflate them.
 */
export function CapabilityAvailability({
  capabilities,
}: {
  capabilities: readonly GatewayCapabilityAvailability[];
}) {
  const { t } = useTranslation("admin");
  return (
    <>
      {capabilities.map((capability) => (
        <Item
          data-testid={`capability-${capability.capability}`}
          key={capability.capability}
          size="sm"
        >
          <ItemContent>
            <ItemTitle>
              {capability.state === "enabled" ? (
                <span
                  className="text-emerald-600"
                  data-testid="capability-state"
                >
                  {t("gateway.capabilities.enabled")}
                </span>
              ) : capability.state === "free" ? (
                <span className="text-sky-600" data-testid="capability-state">
                  {t("gateway.capabilities.free")}
                </span>
              ) : capability.state === "price_unknown" ? (
                <span
                  className="text-destructive"
                  data-testid="capability-state"
                >
                  {t("gateway.capabilities.priceUnknown")}
                </span>
              ) : (
                <span
                  className="text-muted-foreground"
                  data-testid="capability-state"
                >
                  {t("gateway.capabilities.unmapped")}
                </span>
              )}{" "}
              · {t(`gateway.capabilities.names.${capability.capability}`)}
              {capability.state === "free" ? (
                <ItemDescription>
                  {t("gateway.capabilities.freeExplanation")}
                </ItemDescription>
              ) : null}
            </ItemTitle>
            {capability.state === "enabled" ? (
              <ItemDescription>
                {t("gateway.capabilities.enabledCells", {
                  count: capability.cells.length,
                  freeCount: capability.cells.filter((cell) => cell.free)
                    .length,
                })}
              </ItemDescription>
            ) : null}
            {capability.state === "price_unknown" ? (
              <ItemDescription data-testid="capability-missing-intro">
                {t("gateway.capabilities.missingIntro")}
              </ItemDescription>
            ) : null}
            {(capability.missingDimensions ?? []).map((missing) => (
              <ItemDescription
                data-testid="capability-missing-dimension"
                key={`${missing.ref}-${missing.dimension}`}
              >
                {t("gateway.capabilities.missingDimension", {
                  ref: missing.ref,
                  dimension: missing.dimension,
                })}
              </ItemDescription>
            ))}
            {capability.state === "unmapped" ? (
              <ItemDescription>
                {t("gateway.capabilities.unmappedExplanation")}
              </ItemDescription>
            ) : null}
          </ItemContent>
        </Item>
      ))}
    </>
  );
}

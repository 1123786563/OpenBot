import { IconRobot } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
import { PageRowsSkeleton } from "@/components/layout/page-skeletons";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import {
  MODEL_SELECTION_UNAVAILABLE_REASONS,
  type EffectiveModelView,
  type ModelRefView,
  type ModelSelectionView,
  modelSelectionQueryOptions,
  setModelPreferenceMutationOptions,
} from "@/lib/model-selection/queries";

/**
 * The workbench model picker (Bifrost 03.10, AC09/AC19/Q16) — the settings
 * page's model selection entry for the built-in workbench Bot.
 *
 * THE SERVER'S ANSWER IS THE WHOLE TRUTH HERE. The offered list, the price
 * status per model and the effective selection with its layer are read from
 * `GET /api/model-selection` and rendered as they came; nothing on this screen
 * recomputes availability, falls back to a coarser preference layer, or picks
 * a model on the person's behalf.
 *
 * AN UNAVAILABLE SELECTION IS REPORTED, NEVER FIXED. When the stored model is
 * no longer offerable, the card keeps naming it as the current selection —
 * provider, model and layer — with the exact closed reason and a re-selection
 * prompt beneath. No offered model is marked current in its place, and the
 * offered list is not re-pointed at a substitute: choosing the next model is
 * the person's press, and until it happens the screen shows the truth — the
 * selection on record is the one that no longer works.
 *
 * THE WRITE ASKS AND NOTHING MORE. Each offered row offers "set as global
 * default" and "set as workbench default"; the write carries exactly the scope
 * and the ref, the server validates it against the same selectable list the
 * screen drew, and a refused write shows the server's refusal sentence and
 * changes nothing on screen. A successful write invalidates the read, so the
 * card shows the server's new truth with the layer it now comes from.
 *
 * Chat-embedded pickers and other Bot contexts are later entries (09.1, 22.1's
 * enumeration); they consume the same two endpoints with their own context.
 */
export function ModelPicker() {
  const { t } = useTranslation("settings");
  const queryClient = useQueryClient();
  const selection = useQuery(modelSelectionQueryOptions());
  const write = useMutation(setModelPreferenceMutationOptions(queryClient));

  return (
    <PageSection
      title={t("modelPicker.title")}
      description={t("modelPicker.description")}
    >
      {selection.isPending ? <PageRowsSkeleton rows={3} /> : null}
      {selection.isError ? (
        <p className="text-destructive mt-4 text-sm" role="alert">
          {selection.error.message}
        </p>
      ) : null}
      {selection.data ? (
        <>
          <EffectiveSelectionCard effective={selection.data.effective} />
          {write.data && !write.data.ok ? (
            <p className="text-destructive mt-4 text-sm" role="alert">
              {t("modelPicker.refusalHeading")}{" "}
              {write.data.detail
                ? unavailableReasonSentence(write.data.detail, t)
                : t("modelPicker.refusalFallback")}
            </p>
          ) : null}
          {selection.data.selectable.length === 0 ? (
            <PageEmpty>{t("modelPicker.emptyList")}</PageEmpty>
          ) : (
            <PageRows>
              {selection.data.selectable.map((entry, index) => (
                <Fragment key={modelKey(entry.ref)}>
                  {index > 0 ? <Separator /> : null}
                  <OfferedModelRow
                    entry={entry}
                    effective={selection.data.effective}
                    pending={write.isPending}
                    onWrite={(scope) => write.mutate({ scope, ref: entry.ref })}
                  />
                </Fragment>
              ))}
            </PageRows>
          )}
        </>
      ) : null}
    </PageSection>
  );
}

/** One selectable entry as the picker's list shows it. */
type OfferedEntry = ModelSelectionView["selectable"][number];

function modelKey(ref: ModelRefView): string {
  return `${ref.provider}|${ref.model}|${ref.capability}`;
}

/** The price sentence, straight from the status the snapshot reported. */
function priceSentence(priceStatus: string, t: TFunction<"settings">): string {
  const known = ["known", "free", "unknown", "unmapped"] as const;
  const status = (known as readonly string[]).includes(priceStatus)
    ? priceStatus
    : "unknown";
  return t(`modelPicker.price.${status}` as never);
}

/** The sentence for one closed unavailability reason; an unknown code still speaks. */
function unavailableReasonSentence(
  code: string | undefined,
  t: TFunction<"settings">,
): string {
  if (
    code &&
    (MODEL_SELECTION_UNAVAILABLE_REASONS as readonly string[]).includes(code)
  ) {
    return t(`modelPicker.unavailableReasons.${code}` as never);
  }
  return t("modelPicker.unavailableReasons.model_not_in_catalog");
}

/** The sentence naming where the current selection comes from. */
function sourceSentence(
  source: "global" | "bot" | "conversation",
  t: TFunction<"settings">,
): string {
  return t(`modelPicker.source.${source}` as never);
}

/**
 * The card that says what is in force. The stored ref and its layer — always,
 * including when the ref is no longer offerable, which is exactly when this
 * card must not quietly change its mind.
 */
function EffectiveSelectionCard({
  effective,
}: {
  effective: EffectiveModelView;
}) {
  const { t } = useTranslation("settings");
  if (effective.status === "unset") {
    return (
      <div className="mt-4">
        <Item size="sm">
          <ItemMedia variant="icon">
            <IconRobot />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>{t("modelPicker.unsetTitle")}</ItemTitle>
            <ItemDescription>
              {t("modelPicker.unsetDescription")}
            </ItemDescription>
          </ItemContent>
        </Item>
      </div>
    );
  }
  return (
    <div className="mt-4">
      <Item size="sm">
        <ItemMedia variant="icon">
          <IconRobot />
        </ItemMedia>
        <ItemContent>
          <ItemTitle>
            {t("modelPicker.currentTitle")}
            <span className="text-muted-foreground font-normal">
              {" · "}
              {effective.ref.model}
              {" · "}
              {effective.ref.provider}
              {" · "}
              {effective.ref.capability}
            </span>
          </ItemTitle>
          <ItemDescription>
            {sourceSentence(effective.source, t)}
          </ItemDescription>
        </ItemContent>
      </Item>
      {effective.available ? null : (
        <p className="text-destructive mt-4 text-sm" role="alert">
          {t("modelPicker.unavailableHeading")}{" "}
          {unavailableReasonSentence(effective.unavailableReasonCode, t)}{" "}
          {t("modelPicker.reselect")}
          {" — "}
          {effective.ref.model}
        </p>
      )}
    </div>
  );
}

/** One offered model: its identity, the price the snapshot reports, and the two writes. */
function OfferedModelRow({
  entry,
  effective,
  pending,
  onWrite,
}: {
  entry: OfferedEntry;
  effective: EffectiveModelView;
  pending: boolean;
  onWrite: (scope: "global" | "bot") => void;
}) {
  const { t } = useTranslation("settings");
  // The row is marked current only when the effective selection is this very
  // ref and it is offerable. An unavailable selection marks no row — that is
  // the no-silent-replacement rule drawn at the list.
  const isCurrent =
    effective.status === "resolved" &&
    effective.available &&
    modelKey(effective.ref) === modelKey(entry.ref);
  return (
    <Item size="sm" className="py-3">
      <ItemContent>
        <ItemTitle>
          {entry.ref.model}
          <span className="text-muted-foreground font-normal">
            {" · "}
            {entry.ref.provider} · {entry.ref.capability}
          </span>
        </ItemTitle>
        <ItemDescription>
          {priceSentence(entry.priceStatus, t)}
          {isCurrent ? ` · ${t("modelPicker.currentBadge")}` : ""}
        </ItemDescription>
      </ItemContent>
      <ItemActions>
        <Button
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={() => onWrite("global")}
        >
          {pending ? t("modelPicker.saving") : t("modelPicker.setGlobal")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={() => onWrite("bot")}
        >
          {pending ? t("modelPicker.saving") : t("modelPicker.setBot")}
        </Button>
      </ItemActions>
    </Item>
  );
}

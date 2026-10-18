import { IconCreditCard, IconSparkles } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";

export type ModelBillingMethod = "credit" | "subscription";

/**
 * The two billing paths a deployment's built-in Bots can run on (Bifrost 09.4), shown apart
 * so an administrator never has to infer one from the other's absence:
 *
 * - the credit path — the ordinary gateway/credential dial, admitted by the pre-call credit
 *   gate, metered and settled into the usage facts;
 * - the subscription harness path — a Claude Code / ChatGPT subscription credential riding
 *   the deployment's own installed harness. Billed by that subscription: no credit
 *   reservation, no usage fact, and never a path a credit-exhausted call falls back to.
 *
 * Exactly one is the path the built-in Bots actually run on; the server reports which
 * (`builtInModelBilling`), and this screen marks it rather than guessing.
 */
export function ModelBillingPaths({
  billing,
  model,
}: {
  billing: ModelBillingMethod;
  model: string | null;
}) {
  const { t } = useTranslation("admin");
  const creditActive = billing === "credit";
  return (
    <div>
      <Item size="sm">
        <ItemMedia variant="icon">
          <IconCreditCard />
        </ItemMedia>
        <ItemContent>
          <ItemTitle>{t("enterprise.models.creditPathTitle")}</ItemTitle>
          <ItemDescription>
            {t("enterprise.models.creditPathDescription")}
          </ItemDescription>
        </ItemContent>
        <span className="text-muted-foreground text-sm">
          {creditActive
            ? t("enterprise.models.pathActive", { model: model ?? "" })
            : t("enterprise.models.pathInactive")}
        </span>
      </Item>
      <Separator />
      <Item size="sm">
        <ItemMedia variant="icon">
          <IconSparkles />
        </ItemMedia>
        <ItemContent>
          <ItemTitle>{t("enterprise.models.subscriptionPathTitle")}</ItemTitle>
          <ItemDescription>
            {t("enterprise.models.subscriptionPathDescription")}
          </ItemDescription>
        </ItemContent>
        <span className="text-muted-foreground text-sm">
          {creditActive
            ? t("enterprise.models.pathInactive")
            : t("enterprise.models.pathActive", { model: model ?? "" })}
        </span>
      </Item>
    </div>
  );
}

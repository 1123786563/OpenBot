import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";

/** The one empty state all three billing pages share: a sentence and the way out. */
export function BillingEmpty({ message }: { message: string }) {
  const { t } = useTranslation("settings");
  return (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>{message}</EmptyTitle>
      </EmptyHeader>
      <EmptyContent>
        <Button
          render={(props) => (
            <Link to="/settings/billing/subscribe" {...props} />
          )}
        >
          {t("billing.goSubscribe")}
        </Button>
      </EmptyContent>
    </Empty>
  );
}

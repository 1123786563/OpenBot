import { useTranslation } from "react-i18next";
import type { Namespace } from "@/lib/i18n";

/**
 * What an observability page says until its chain ticket wires the store: one honest sentence,
 * not a guess dressed up as a state. `role="status"` announces it politely, and the eight
 * availability states stay reserved for pages that actually asked the store and can vouch for
 * which answer they got — a placeholder that rendered `unavailable` would be claiming a fault
 * that never happened.
 */
export function ObservabilityPlaceholder({
  namespace,
}: {
  namespace: Namespace;
}) {
  const { t } = useTranslation(namespace);
  return (
    <p className="mt-6 text-muted-foreground text-sm" role="status">
      {t("placeholder.description")}
    </p>
  );
}

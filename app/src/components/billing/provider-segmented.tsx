import { useTranslation } from "react-i18next";
import type { PurchaseProvider } from "@/lib/billing/payments";
import { cn } from "@/lib/utils";

/** The channels this deployment configured, as one segmented row. */
export function ProviderSegmented({
  providers,
  value,
  onChange,
}: {
  providers: PurchaseProvider[];
  value: PurchaseProvider;
  onChange: (provider: PurchaseProvider) => void;
}) {
  const { t } = useTranslation("settings");
  return (
    <div
      role="radiogroup"
      aria-label={t("subscribe.providerTitle")}
      className="border-input inline-flex rounded-lg border p-0.5"
    >
      {providers.map((provider) => (
        <button
          key={provider}
          type="button"
          role="radio"
          aria-checked={value === provider}
          onClick={() => onChange(provider)}
          className={cn(
            "rounded-md px-3 py-1.5 text-sm transition-colors",
            value === provider
              ? "bg-foreground/5 font-medium"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {t(`subscribe.provider.${provider}`)}
        </button>
      ))}
    </div>
  );
}

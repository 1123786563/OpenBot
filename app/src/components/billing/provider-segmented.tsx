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
        // 原生 radio（视觉上 sr-only）而非 button+role：语义即样式所写，
        // 屏幕阅读器与键盘行为无需手工模拟，name 来自包裹的 label 文本。
        <label
          key={provider}
          className={cn(
            "cursor-pointer rounded-md px-3 py-1.5 text-sm transition-colors",
            value === provider
              ? "bg-foreground/5 font-medium"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          <input
            type="radio"
            name="subscribe-provider"
            className="sr-only"
            checked={value === provider}
            onChange={() => onChange(provider)}
          />
          {t(`subscribe.provider.${provider}`)}
        </label>
      ))}
    </div>
  );
}

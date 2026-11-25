import { InternationalizationProvider } from "@astryxdesign/core/i18n";
import zhCN from "@astryxdesign/core/locales/zh-CN.generated.js";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

/** Hands Astryx components the language OpenBot's interface is in, in Astryx's own words for it. */
export function I18nProvider({ children }: { children: ReactNode }) {
  const { i18n } = useTranslation();
  return (
    <InternationalizationProvider
      locale={i18n.language}
      messages={{ "zh-CN": zhCN }}
    >
      {children}
    </InternationalizationProvider>
  );
}

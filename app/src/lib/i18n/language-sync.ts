import { useEffect } from "react";
import { useTranslation } from "react-i18next";

/**
 * Keeps `<html lang>` aligned with the active language.
 *
 * The attribute is what screen readers use to pick a pronunciation dictionary and what browsers
 * use for default font selection, so a page that speaks Chinese while claiming `lang="en"` is
 * wrong twice over. One call in the root component; the effect re-runs whenever the language
 * changes, including the async moment a lazy bundle lands.
 */
export function useLanguageSync() {
  const { i18n } = useTranslation();
  useEffect(() => {
    document.documentElement.lang = i18n.language;
  }, [i18n.language]);
}

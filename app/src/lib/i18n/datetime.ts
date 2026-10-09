import { useTranslation } from "react-i18next";
import { formatRelativeTime } from "../relative-time";

/**
 * Date, time and number formatting bound to the active language.
 *
 * Every `toLocale*` call in the app used to pass `undefined` as the locale, which hands the
 * choice to the browser — incidentally locale-aware, but uncontrolled, and English sentences
 * spliced around those dates made the mix visible. This hook is the seam where the i18n
 * language becomes the explicit locale for formatting, so "last signed in {{date}}" and the
 * date itself always agree.
 *
 * Prefer this over raw `toLocale*` in any component that renders user-visible values.
 */
export function useDateTime() {
  const { i18n } = useTranslation();
  const locale = i18n.language;

  return {
    locale,
    formatDate: (
      value: Date | string | number,
      options?: Intl.DateTimeFormatOptions,
    ) => new Date(value).toLocaleDateString(locale, options),
    formatTime: (
      value: Date | string | number,
      options?: Intl.DateTimeFormatOptions,
    ) => new Date(value).toLocaleTimeString(locale, options),
    formatDateTime: (
      value: Date | string | number,
      options?: Intl.DateTimeFormatOptions,
    ) => new Date(value).toLocaleString(locale, options),
    formatNumber: (value: number, options?: Intl.NumberFormatOptions) =>
      value.toLocaleString(locale, options),
    formatRelative: (value: Date | string | number) =>
      formatRelativeTime(new Date(value), locale),
  };
}

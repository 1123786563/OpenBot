import { Selector } from "@astryxdesign/core/Selector";
import { IconLanguage } from "@tabler/icons-react";
import { useRef } from "react";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import {
  isPreference,
  setLocalePreference,
  useLocalePreference,
  useTranslation,
} from "@/i18n";

/*
 * The interface language row, the one string this ticket translates. The two language names are
 * written in their own language and stay identical in every catalog, so they are not catalog
 * messages.
 */
export function LanguageRow() {
  const { t } = useTranslation();
  const trigger = useRef<HTMLButtonElement>(null);
  const preference = useLocalePreference() ?? "browser";
  return (
    <Item size="sm">
      <ItemMedia variant="icon">
        <IconLanguage />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>{t("settings.language.title", "Language")}</ItemTitle>
        <ItemDescription className="line-clamp-none">
          {t(
            "settings.language.description",
            "Choose the language OpenBot uses for its own text.",
          )}
        </ItemDescription>
      </ItemContent>
      <ItemActions>
        <Selector
          ref={trigger}
          isLabelHidden
          label={t("settings.language.title", "Language")}
          value={preference}
          onChange={(value) => {
            if (isPreference(value)) {
              void setLocalePreference(value);
              requestAnimationFrame(() => trigger.current?.focus());
            }
          }}
          options={[
            {
              value: "browser",
              label: t("settings.language.browser", "Follow the browser"),
            },
            { value: "en", label: "English" },
            { value: "zh-CN", label: "简体中文" },
          ]}
        />
      </ItemActions>
    </Item>
  );
}

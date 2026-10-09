import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import React from "react";
import {
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { MessageListPreference } from "@/components/settings/message-list-preference";
import { StandingInstructions } from "@/components/settings/standing-instructions";
import { useTheme } from "@/components/theme-provider";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { formatHotkey, HOTKEYS } from "@/lib/hotkeys/hotkeys";
import { SUPPORTED_LANGUAGES } from "@/lib/i18n";

export const Route = createFileRoute("/_authed/settings/")({
  component: RouteComponent,
});

/** Interface language, switched live and persisted by the language detector's localStorage cache. */
function LanguagePreference() {
  const { t, i18n } = useTranslation("settings");

  return (
    <Item size="sm">
      <ItemContent>
        <ItemTitle>{t("language.label")}</ItemTitle>
        <ItemDescription>{t("language.description")}</ItemDescription>
      </ItemContent>
      <ItemActions>
        <Select
          value={i18n.resolvedLanguage ?? i18n.language}
          onValueChange={(language) => {
            if (language) void i18n.changeLanguage(language);
          }}
        >
          <SelectTrigger aria-label={t("language.label")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SUPPORTED_LANGUAGES.map((language) => (
              <SelectItem key={language} value={language}>
                {t(`language.${language}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </ItemActions>
    </Item>
  );
}

function RouteComponent() {
  const { t } = useTranslation("settings");
  const { dark, setDark } = useTheme();

  /*
   * The measurements that used to be written out here now live in `PageShell`, which Skills, Admin
   * and this screen all render through. The reason they match is no longer that somebody remembered
   * to copy them.
   *
   * Connected accounts used to be a section below. It is its own screen now: a connector can need
   * more from a person than one switch, and a section cannot grow a page's worth of that.
   */
  return (
    <PageShell description={t("description")} title={t("title")}>
      <PageSection title={t("general")}>
        <PageRows>
          <Item size="sm">
            <ItemContent>
              <ItemTitle>{t("darkTheme")}</ItemTitle>
              <ItemDescription>{t("darkThemeDescription")}</ItemDescription>
            </ItemContent>
            <ItemActions>
              <Switch
                aria-label={t("darkTheme")}
                checked={dark}
                onCheckedChange={setDark}
              />
            </ItemActions>
          </Item>
          <LanguagePreference />
        </PageRows>
        <MessageListPreference />
      </PageSection>
      {/*
       * Above the shortcuts and below the appearance preferences, because it is the only thing on this
       * screen that changes what a coworker says rather than what this browser looks like.
       */}
      <StandingInstructions />
      {/*
       * Drawn from the same registry the listeners match against, so this list is what the keys
       * actually do rather than what somebody remembered they did. Read-only on purpose: these
       * are not rebindable, and a row with nothing to click says so by having nothing to click.
       */}
      <PageSection title={t("keyboardShortcuts")}>
        <PageRows>
          {HOTKEYS.map((hotkey, index) => (
            <React.Fragment key={hotkey.id}>
              <Item size="sm">
                <ItemContent>
                  <ItemTitle>{t(hotkey.label)}</ItemTitle>
                  <ItemDescription>{t(hotkey.description)}</ItemDescription>
                </ItemContent>
                <ItemActions>
                  <span className="flex gap-1">
                    {formatHotkey(hotkey.combo).map((part) => (
                      <kbd
                        className="rounded-md border bg-muted px-1.5 py-0.5 font-sans text-xs text-muted-foreground"
                        key={part}
                      >
                        {part}
                      </kbd>
                    ))}
                  </span>
                </ItemActions>
              </Item>
              {index !== HOTKEYS.length - 1 && <Separator />}
            </React.Fragment>
          ))}
        </PageRows>
      </PageSection>
    </PageShell>
  );
}

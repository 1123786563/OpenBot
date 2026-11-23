import { Switch as AstryxSwitch } from "@astryxdesign/core/Switch";
import { IconMoon } from "@tabler/icons-react";
import { createFileRoute } from "@tanstack/react-router";
import React from "react";
import { AstryxSurface } from "@/components/astryx-pilot/theme";
import {
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { AiModelSection } from "@/components/settings/ai-connection";
import { LanguageRow } from "@/components/settings/language-row";
import { MessageListPreference } from "@/components/settings/message-list-preference";
import { NameRow } from "@/components/settings/profile";
import { StandingInstructionsRow } from "@/components/settings/standing-instructions";
import { UsageDataSection } from "@/components/settings/usage-data";
import { useTheme } from "@/components/theme-provider";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { useTranslation } from "@/i18n";
import { formatHotkey, type Hotkey, HOTKEYS } from "@/lib/hotkeys/hotkeys";

export const Route = createFileRoute("/_authed/settings/")({
  component: RouteComponent,
});

/** Marks a message for extraction without translating it at module scope. */
function navigationMessage(messageId: string, label: string) {
  return { messageId, label };
}

/*
 * The shortcut registry keeps its words as identity strings, because the keys they describe are the
 * same in every language; the words a person reads are chosen here, at render, in the language in
 * force. Every id in `HOTKEYS` must have an entry, or this stops compiling.
 */
const SHORTCUT_MESSAGES = {
  "new-chat": {
    label: navigationMessage("nav.newConversation", "New conversation"),
    description: navigationMessage(
      "settings.shortcuts.newConversation.description",
      "Start a new conversation from anywhere in OpenBot.",
    ),
  },
} as const satisfies Record<
  Hotkey["id"],
  Record<"label" | "description", ReturnType<typeof navigationMessage>>
>;

function RouteComponent() {
  const { dark, setDark } = useTheme();
  const { t } = useTranslation();

  /*
   * The measurements that used to be written out here now live in `PageShell`, which Skills, Admin
   * and this screen all render through. The reason they match is no longer that somebody remembered
   * to copy them.
   *
   * Connected accounts used to be a section below. It is its own screen now: a connector can need
   * more from a person than one switch, and a section cannot grow a page's worth of that.
   */
  return (
    <PageShell
      description={t(
        "settings.description",
        "Set your name, how OpenBot looks, and the instructions every Bot follows.",
      )}
      title={t("settings.title", "General")}
    >
      {/*
       * What OpenBot and every Bot know of the person, first: their name and how they want things done. Both are free
       * text, so both are a summary that opens a dialog.
       */}
      <PageSection title={t("settings.aboutYou", "About you")}>
        <PageRows>
          <NameRow />
          <Separator />
          <StandingInstructionsRow />
        </PageRows>
      </PageSection>
      {/* Only in OpenBot Desktop, which holds the AI connection and changes it in its own window. */}
      <AiModelSection />
      {/* Only in OpenBot Desktop, which sends usage data and keeps this choice. */}
      <UsageDataSection />
      <AstryxSurface className="min-w-0 rounded-[var(--radius-container)]">
        <PageSection title={t("settings.appearance", "Appearance")}>
          <PageRows>
            <Item size="sm">
              <ItemMedia variant="icon">
                <IconMoon />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>{t("settings.darkTheme", "Dark theme")}</ItemTitle>
                <ItemDescription>
                  {t(
                    "settings.darkThemeDescription",
                    "Use the dark appearance across OpenBot.",
                  )}
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <AstryxSwitch
                  label={t("settings.darkTheme", "Dark theme")}
                  isLabelHidden
                  value={dark}
                  onChange={setDark}
                />
              </ItemActions>
            </Item>
            <Separator />
            <LanguageRow />
          </PageRows>
          <MessageListPreference />
        </PageSection>
      </AstryxSurface>
      {/*
       * Drawn from the same registry the listeners match against, so this list is what the keys
       * actually do rather than what somebody remembered they did. Read-only on purpose: these
       * are not rebindable, and a row with nothing to click says so by having nothing to click.
       */}
      <PageSection title={t("settings.shortcuts", "Keyboard shortcuts")}>
        <PageRows>
          {HOTKEYS.map((hotkey, index) => {
            const copy = SHORTCUT_MESSAGES[hotkey.id];
            return (
              <React.Fragment key={hotkey.id}>
                <Item size="sm">
                  <ItemContent>
                    <ItemTitle>
                      {t(copy.label.messageId, copy.label.label)}
                    </ItemTitle>
                    <ItemDescription>
                      {t(copy.description.messageId, copy.description.label)}
                    </ItemDescription>
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
            );
          })}
        </PageRows>
      </PageSection>
    </PageShell>
  );
}

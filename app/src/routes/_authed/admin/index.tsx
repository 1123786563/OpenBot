import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { IconChevronRight } from "@tabler/icons-react";
import { createFileRoute, Link, useLocation } from "@tanstack/react-router";
import { Fragment, type MouseEvent, useLayoutEffect, useRef } from "react";
import { z } from "zod";
import {
  ADMIN_NAVIGATION,
  type AdminSetting,
  searchAdminSettings,
} from "@/components/admin/admin-navigation";
import {
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { isComposing } from "@/lib/composing";

export const Route = createFileRoute("/_authed/admin/")({
  component: RouteComponent,
  validateSearch: z.object({ q: z.string().optional().catch(undefined) }),
});

let lastOpenedSetting: { historyEntry: string; title: string } | undefined;

function RouteComponent() {
  const { q = "" } = Route.useSearch();
  const navigate = Route.useNavigate();
  const historyEntry = useLocation({
    select: (location) => location.state.__TSR_key,
  });
  const links = useRef(new Map<string, HTMLAnchorElement>());
  useLayoutEffect(() => {
    if (!lastOpenedSetting || lastOpenedSetting.historyEntry !== historyEntry)
      return;
    const target = links.current.get(lastOpenedSetting.title);
    lastOpenedSetting = undefined;
    target?.focus();
  }, [historyEntry]);
  const results = searchAdminSettings(q);
  const firstResult = results?.items[0];
  const count = results?.items.length ?? 0;
  function registerLink(title: string, node: HTMLAnchorElement | null) {
    if (node) links.current.set(title, node);
    else links.current.delete(title);
  }
  function rememberLink(title: string, event: MouseEvent<HTMLAnchorElement>) {
    if (
      historyEntry &&
      event.button === 0 &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.shiftKey
    ) {
      lastOpenedSetting = { historyEntry, title };
    }
  }
  const setQuery = (value: string) =>
    void navigate({
      search: { q: value || undefined },
      replace: true,
      resetScroll: false,
    });

  return (
    <PageShell
      description="Manage settings that apply to everyone and every Bot in this deployment."
      title="Admin"
    >
      <section aria-label="Search admin settings" className="mt-6 space-y-2">
        <TextInput
          autoComplete="off"
          controlClassName="[&_button]:min-h-11 [&_button]:min-w-11"
          controlStyle={{
            minBlockSize: "var(--spacing-11)",
            paddingInlineStart: "var(--spacing-3)",
          }}
          hasAutoCorrect={false}
          hasClear
          hasSpellCheck={false}
          enterKeyHint="search"
          label="Find a setting"
          onChange={setQuery}
          onEnter={() =>
            firstResult && links.current.get(firstResult.title)?.focus()
          }
          onKeyDown={(event) => {
            if (event.key !== "Escape" || !q || isComposing(event)) return;
            event.preventDefault();
            setQuery("");
          }}
          size="lg"
          type="search"
          value={q}
          width="100%"
        />
        <Text
          as="p"
          color="secondary"
          display="block"
          role="status"
          size="base"
        >
          {results
            ? count === 0
              ? "No matching settings."
              : `${count} ${count === 1 ? "setting" : "settings"} found.`
            : null}
        </Text>
        {results?.spelling ? (
          <Text as="p" color="secondary" display="block" size="base">
            Showing close spelling matches.
          </Text>
        ) : results?.items.length === 0 ? (
          <Text as="p" color="secondary" display="block" size="base">
            Try “single sign-on”, “revoke an API key”, or “simulate a policy”.
          </Text>
        ) : null}
      </section>
      {results ? (
        count > 0 ? (
          <AdminSettingRows
            items={results.items}
            registerLink={registerLink}
            rememberLink={rememberLink}
          />
        ) : null
      ) : (
        ADMIN_NAVIGATION.map((section) => (
          <PageSection
            description={section.description || undefined}
            key={section.title}
            title={section.title}
          >
            <AdminSettingRows
              items={section.items}
              registerLink={registerLink}
              rememberLink={rememberLink}
            />
          </PageSection>
        ))
      )}
    </PageShell>
  );
}

function AdminSettingRows({
  items,
  registerLink,
  rememberLink,
}: {
  items: AdminSetting[];
  registerLink: (title: string, node: HTMLAnchorElement | null) => void;
  rememberLink: (title: string, event: MouseEvent<HTMLAnchorElement>) => void;
}) {
  return (
    <PageRows>
      {items.map((item, index) => (
        <Fragment key={item.title}>
          <Item
            render={(props) => (
              <Link
                {...item.linkOptions}
                {...props}
                ref={(node) => registerLink(item.title, node)}
                onClickCapture={(event) => rememberLink(item.title, event)}
              />
            )}
            size="sm"
          >
            <ItemMedia variant="icon">
              <item.icon />
            </ItemMedia>
            <ItemContent className="min-w-0">
              <ItemTitle className="line-clamp-none">{item.title}</ItemTitle>
              <ItemDescription className="line-clamp-none text-sm">
                {item.description}
              </ItemDescription>
            </ItemContent>
            <IconChevronRight className="size-4 shrink-0 text-muted-foreground" />
          </Item>
          {index !== items.length - 1 && <Separator />}
        </Fragment>
      ))}
    </PageRows>
  );
}

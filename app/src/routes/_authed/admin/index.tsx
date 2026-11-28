import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { IconChecks, IconChevronRight } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
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
import { ReadError } from "@/components/layout/read-status";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { useTranslation } from "@/i18n";
import { isComposing } from "@/lib/composing";
import { sharedUseRequestsQueryOptions } from "@/lib/plugins/shared-use";

export const Route = createFileRoute("/_authed/admin/")({
  component: RouteComponent,
  validateSearch: z.object({ q: z.string().optional().catch(undefined) }),
});

const commonTaskPaths = ["/admin/people", "/admin/providers", "/admin/audit"];
const settings = ADMIN_NAVIGATION.flatMap(({ items }) => items);
const commonTasks = commonTaskPaths.flatMap((path) =>
  settings.filter((item) => item.linkOptions.to === path),
);
const otherSettings = ADMIN_NAVIGATION.map((section) => ({
  ...section,
  items: section.items.filter((item) => !commonTasks.includes(item)),
})).filter((section) => section.items.length > 0);

let lastOpenedSetting: { historyEntry: string; title: string } | undefined;

function RouteComponent() {
  const { t } = useTranslation();
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
          onKeyDown={(event) => {
            if (isComposing(event)) return;
            if (event.key === "Enter" && firstResult) {
              event.preventDefault();
              links.current.get(firstResult.title)?.focus();
            } else if (event.key === "Escape" && q) {
              event.preventDefault();
              setQuery("");
            }
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
        <>
          <PendingAccountRequests />
          <PageSection title={t("admin.overview.commonTasks", "Common tasks")}>
            <AdminSettingRows
              items={commonTasks}
              registerLink={registerLink}
              rememberLink={rememberLink}
            />
          </PageSection>
          {otherSettings.map((section) => (
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
          ))}
        </>
      )}
    </PageShell>
  );
}

function PendingAccountRequests() {
  const { t } = useTranslation();
  const options = sharedUseRequestsQueryOptions(true);
  const requests = useQuery({
    ...options,
    refetchInterval: (query) =>
      query.state.status === "error" ? false : options.refetchInterval,
  });
  const heading = useRef<HTMLHeadingElement>(null);
  if (requests.isPending) return null;
  const pending = requests.data?.length ?? 0;
  if (!requests.error && pending === 0) return null;
  const title = t("admin.overview.requests", "Shared account requests");
  const count = t(
    "admin.overview.requestsCount",
    "{count, plural, one {# request needs review.} other {# requests need review.}}",
    { count: pending },
  );

  return (
    <PageSection
      headingRef={heading}
      title={t("admin.overview.needsAttention", "Needs attention")}
    >
      {requests.error ? (
        <ReadError
          focusAfterRetry={() => heading.current}
          message={t(
            "admin.overview.requestsError",
            "Couldn't load shared account requests.",
          )}
          retry={requests.refetch}
          retryLabel={t(
            "admin.overview.retryRequests",
            "Retry shared account requests",
          )}
          retrying={requests.isFetching}
        />
      ) : (
        <PageRows>
          <Item
            render={
              <Link
                aria-label={`${title}. ${count}`}
                to="/admin/approvals"
                hash="shared-account-requests"
              />
            }
            size="sm"
          >
            <ItemMedia variant="icon">
              <IconChecks />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>{title}</ItemTitle>
              <ItemDescription className="text-sm">{count}</ItemDescription>
            </ItemContent>
            <IconChevronRight className="size-4 shrink-0 text-muted-foreground" />
          </Item>
        </PageRows>
      )}
    </PageSection>
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

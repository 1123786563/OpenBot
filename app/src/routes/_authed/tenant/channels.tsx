import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { TableSkeleton } from "@/components/layout/page-skeletons";
import { Button } from "@/components/ui/button";
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
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import {
  channelQueryOptions,
  channelsQueryOptions,
  selectTenant,
  tenantsQueryOptions,
} from "@/lib/enterprise/tenant/queries";
import { queryClient } from "@/query-client";

/**
 * The smallest member-facing tenant surface, per plan F02 steps 6-7: pick a tenant, read the
 * personal channels of that tenant, open one channel's persisted record.
 *
 * Every read goes through `lib/enterprise/tenant/queries` — the component never calls `fetch`, and
 * never sees the tenant header. Switching tenants here is the one place the generation guard is
 * driven from: the navigation below moves the tenant in the URL, and `selectTenant` moves the
 * cache out of the old tenant first, so a response that arrives after the switch is refused rather
 * than rendered.
 *
 * WHAT THE RECORD IS. The channel's persisted row — bot, thread, mode, status. Run state exists
 * on this API but is keyed by run id (`POST`/`GET /runs/:id`, conditionally mounted), and a
 * channel record carries no run id, so there is nothing this page could read without inventing
 * one — the record section says exactly that rather than drawing a status nobody can serve.
 */

export const Route = createFileRoute("/_authed/tenant/channels")({
  component: TenantChannelsPage,
  /*
   * The selection in the URL rather than component state, like `usage`'s page number: a reader
   * mid-review can hand someone the exact tenant, channel and page they were on.
   */
  validateSearch: (
    search: Record<string, unknown>,
  ): {
    tenant?: string;
    channel?: string;
    cursor?: string;
  } => ({
    tenant: typeof search.tenant === "string" ? search.tenant : undefined,
    channel: typeof search.channel === "string" ? search.channel : undefined,
    cursor: typeof search.cursor === "string" ? search.cursor : undefined,
  }),
});

function TenantChannelsPage() {
  const { t } = useTranslation("tenant");
  const { tenant, channel, cursor } = Route.useSearch();
  const navigate = Route.useNavigate();
  const user = useQuery(currentUserQueryOptions());
  const userId = user.data?.id;
  const chooser = useQuery({
    ...tenantsQueryOptions(userId ?? ""),
    enabled: userId !== undefined,
  });

  return (
    <PageShell
      description={t("channels.description")}
      title={t("channels.title")}
    >
      <PageSection title={t("channels.tenant.label")}>
        {chooser.isPending ? (
          <TableSkeleton />
        ) : chooser.error ? (
          <PageEmpty>{(chooser.error as Error).message}</PageEmpty>
        ) : chooser.data.items.length === 0 ? (
          <PageEmpty>{t("channels.tenant.empty")}</PageEmpty>
        ) : (
          <Select
            onValueChange={(next) => {
              // The selection drives everything below, so a non-string answer from the
              // widget is no selection at all — not something to pass on.
              if (userId === undefined || typeof next !== "string") return;
              selectTenant(queryClient, userId, tenant ?? null, next);
              void navigate({ search: { tenant: next } });
            }}
            value={tenant ?? ""}
          >
            <SelectTrigger aria-label={t("channels.tenant.aria")}>
              <SelectValue placeholder={t("channels.tenant.placeholder")} />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {chooser.data.items.map((member) => (
                  <SelectItem key={member.id} value={member.id}>
                    {member.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        )}
      </PageSection>
      {userId !== undefined && tenant !== undefined ? (
        <ChannelsSection
          channelId={channel}
          cursor={cursor ?? null}
          tenantId={tenant}
          userId={userId}
        />
      ) : null}
    </PageShell>
  );
}

function ChannelsSection({
  channelId,
  cursor,
  tenantId,
  userId,
}: {
  channelId?: string;
  cursor: string | null;
  tenantId: string;
  userId: string;
}) {
  const { t } = useTranslation("tenant");
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const channels = useQuery(
    channelsQueryOptions(queryClient, userId, tenantId, cursor),
  );

  /*
   * Opening a record keeps the page the list is on (the cursor), so the reader comes back to the
   * same page; only the tenant switch above clears both.
   */
  const select = (next: string) => {
    void navigate({ search: { ...search, channel: next } });
  };

  return (
    <PageSection
      description={t("channels.list.description")}
      title={t("channels.list.title")}
    >
      {channels.isPending ? (
        <TableSkeleton />
      ) : channels.error ? (
        <PageEmpty>{(channels.error as Error).message}</PageEmpty>
      ) : channels.data.items.length === 0 ? (
        <PageEmpty>{t("channels.list.empty")}</PageEmpty>
      ) : (
        <>
          <PageRows>
            {channels.data.items.map((row) => (
              <Item
                key={row.channelId}
                render={
                  <button onClick={() => select(row.channelId)} type="button" />
                }
                size="sm"
              >
                <ItemContent>
                  <ItemTitle className="font-mono text-xs">
                    {row.channelId}
                  </ItemTitle>
                  <ItemDescription className="font-mono text-xs">
                    {t("channels.detail.bot")} {row.botId} ·{" "}
                    {row.status === "active"
                      ? t("channels.detail.statusActive")
                      : t("channels.detail.statusArchived")}
                  </ItemDescription>
                </ItemContent>
              </Item>
            ))}
          </PageRows>
          {channels.data.nextCursor !== null ? (
            <Button
              className="mt-4"
              onClick={() =>
                void navigate({
                  search: {
                    ...search,
                    cursor: channels.data.nextCursor ?? undefined,
                  },
                })
              }
              size="sm"
              variant="outline"
            >
              {t("channels.list.more")}
            </Button>
          ) : null}
        </>
      )}
      {channelId !== undefined ? (
        <ChannelRecord
          channelId={channelId}
          tenantId={tenantId}
          userId={userId}
        />
      ) : null}
    </PageSection>
  );
}

function ChannelRecord({
  channelId,
  tenantId,
  userId,
}: {
  channelId: string;
  tenantId: string;
  userId: string;
}) {
  const { t } = useTranslation("tenant");
  const record = useQuery(
    channelQueryOptions(queryClient, userId, tenantId, channelId),
  );

  return (
    <PageSection
      className="mt-8"
      description={t("channels.detail.description")}
      title={t("channels.detail.title")}
    >
      {record.isPending ? (
        <TableSkeleton />
      ) : record.error ? (
        <PageEmpty>{(record.error as Error).message}</PageEmpty>
      ) : (
        <PageRows>
          <Item size="sm">
            <ItemContent>
              <ItemTitle className="font-mono text-xs">
                {record.data.channelId}
              </ItemTitle>
              <ItemDescription className="font-mono text-xs">
                {t("channels.detail.bot")} {record.data.botId} ·{" "}
                {t("channels.detail.thread")} {record.data.threadId} ·{" "}
                {t("channels.detail.mode")} {record.data.mode} ·{" "}
                {t("channels.detail.status")}{" "}
                {record.data.status === "active"
                  ? t("channels.detail.statusActive")
                  : t("channels.detail.statusArchived")}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <span className="text-muted-foreground text-xs">
                {record.data.status === "active"
                  ? t("channels.detail.statusActive")
                  : t("channels.detail.statusArchived")}
              </span>
            </ItemActions>
          </Item>
        </PageRows>
      )}
    </PageSection>
  );
}

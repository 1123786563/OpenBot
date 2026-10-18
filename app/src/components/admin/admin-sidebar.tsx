import {
  IconArrowLeft,
  IconBook2,
  IconBuildingBank,
  IconChecks,
  IconCode,
  IconCoins,
  IconDeviceDesktop,
  IconFileText,
  IconKey,
  IconLayoutGrid,
  IconListDetails,
  IconNetwork,
  IconPuzzle,
  IconRobot,
  IconServer,
  IconShieldCheck,
  IconShoppingBag,
  IconUsers,
} from "@tabler/icons-react";
import { Link, type LinkOptions } from "@tanstack/react-router";
import type * as React from "react";
import { useTranslation } from "react-i18next";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar";

const appLinkOptions = { to: "/" } satisfies LinkOptions;
const adminLinkOptions = { to: "/admin" } satisfies LinkOptions;

/**
 * The same four groups, in the same order, as the admin index.
 *
 * A rail that lists ten things flat asks somebody to know which of them is the one they want. The
 * grouping is the only navigation help this screen offers, so it has to agree with the page it
 * navigates to — two different orderings of the same ten links is worse than either ordering.
 */
const GROUPS = [
  {
    label: "sidebar.reach",
    items: [
      {
        title: "sidebar.credentials",
        icon: IconKey,
        linkOptions: { to: "/admin/credentials" },
      },
      {
        title: "sidebar.botServices",
        icon: IconRobot,
        linkOptions: { to: "/admin/bot-services" },
      },
      {
        title: "sidebar.gateway",
        icon: IconNetwork,
        linkOptions: { to: "/admin/gateway" },
      },
      {
        title: "sidebar.modelCatalog",
        icon: IconServer,
        linkOptions: { to: "/admin/model-catalog" },
      },
      {
        title: "sidebar.boundaries",
        icon: IconShieldCheck,
        linkOptions: { to: "/admin/boundaries" },
      },
      {
        title: "sidebar.approvals",
        icon: IconChecks,
        linkOptions: { to: "/admin/approvals" },
      },
      {
        title: "sidebar.computers",
        icon: IconDeviceDesktop,
        linkOptions: { to: "/admin/computers" },
      },
    ],
  },
  {
    label: "sidebar.do",
    items: [
      {
        title: "sidebar.plugins",
        icon: IconPuzzle,
        linkOptions: { to: "/admin/plugins" },
      },
      {
        title: "sidebar.skills",
        icon: IconFileText,
        linkOptions: { to: "/admin/skills" },
      },
      {
        title: "sidebar.market",
        icon: IconShoppingBag,
        linkOptions: { to: "/admin/market" },
      },
      {
        title: "sidebar.knowledge",
        icon: IconBook2,
        linkOptions: { to: "/admin/knowledge" },
      },
      {
        title: "sidebar.learning",
        icon: IconFileText,
        linkOptions: { to: "/admin/learning" },
      },
      {
        title: "sidebar.components",
        icon: IconLayoutGrid,
        linkOptions: { to: "/admin/components" },
      },
      {
        title: "sidebar.playground",
        icon: IconCode,
        linkOptions: { to: "/admin/playground" },
      },
    ],
  },
  {
    label: "sidebar.access",
    items: [
      {
        title: "sidebar.people",
        icon: IconUsers,
        linkOptions: { to: "/admin/people" },
      },
      {
        title: "sidebar.billing",
        icon: IconCoins,
        linkOptions: { to: "/admin/billing" },
      },
      {
        title: "sidebar.identityProviders",
        icon: IconBuildingBank,
        linkOptions: { to: "/admin/identity-providers" },
      },
    ],
  },
  {
    label: "sidebar.history",
    items: [
      {
        title: "sidebar.audit",
        icon: IconListDetails,
        linkOptions: { to: "/admin/audit" },
      },
    ],
  },
] as const satisfies readonly {
  label: string;
  items: readonly {
    icon: React.ComponentType<{ className?: string }>;
    linkOptions: LinkOptions;
    title: string;
  }[];
}[];

export function AdminSidebar({
  ...props
}: React.ComponentProps<typeof Sidebar>) {
  const { t } = useTranslation("admin");
  return (
    <Sidebar {...props}>
      {/*
       * Pinned to the same height as the app sidebar's header. Left to itself this one is 60px
       * against the app's 45px — `p-2` around a `size="lg"` button rather than a fixed height — so
       * the nav list started lower here and the sidebar appeared to shift on the way into Admin.
       *
       * The button takes its default height rather than `h-full`. `h-full` resolves against the
       * parent, which in the app sidebar is a flex row holding a second control and here is not, so
       * the same class produces two different heights.
       */}
      <SidebarHeader className="h-12 p-2">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              render={(props) => (
                <Link {...appLinkOptions} {...props}>
                  <IconArrowLeft className="mr-2 h-4 w-4" />
                  {t("sidebar.backToApp")}
                </Link>
              )}
            />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarMenu>
            <SidebarMenuItem>
              {/*
               * `activeOptions.exact`, because /admin is a prefix of every other route here and
               * would otherwise light up on all of them.
               */}
              <SidebarMenuButton
                render={(props) => (
                  <Link
                    {...adminLinkOptions}
                    activeOptions={{ exact: true }}
                    activeProps={{
                      className:
                        "bg-sidebar-accent font-medium text-sidebar-accent-foreground",
                    }}
                    {...props}
                  >
                    {t("sidebar.overview")}
                  </Link>
                )}
              />
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>
        {GROUPS.map((group) => (
          <SidebarGroup key={group.label}>
            <SidebarGroupLabel>{t(group.label)}</SidebarGroupLabel>
            <SidebarMenu className="gap-px">
              {group.items.map((item) => (
                <SidebarMenuItem key={item.title}>
                  <SidebarMenuButton
                    render={(props) => (
                      <Link
                        {...item.linkOptions}
                        activeProps={{
                          className:
                            "bg-sidebar-accent font-medium text-sidebar-accent-foreground",
                        }}
                        {...props}
                      >
                        <item.icon className="mr-2 h-4 w-4" />
                        {t(item.title)}
                      </Link>
                    )}
                  />
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroup>
        ))}
      </SidebarContent>
      <SidebarRail />
    </Sidebar>
  );
}

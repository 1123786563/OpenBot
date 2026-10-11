import {
  IconArrowLeft,
  IconChartBar,
  IconKey,
  IconLayoutGrid,
  IconPlug,
  IconReceipt,
  IconSettings,
} from "@tabler/icons-react";
import { Link, type LinkOptions } from "@tanstack/react-router";
import type * as React from "react";
import { useTranslation } from "react-i18next";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar";

const appLinkOptions = { to: "/" } satisfies LinkOptions;

const ITEMS = [
  {
    title: "sidebar.general",
    icon: IconSettings,
    /* `/settings` prefixes every other route here, and would otherwise light up on all of them. */
    exact: true,
    linkOptions: { to: "/settings" },
  },
  {
    /*
     * The same subject as Admin's Plugins, from the other side: there an administrator decides what
     * this deployment may reach at all, here you decide what it may reach as you.
     */
    title: "sidebar.connectedAccounts",
    icon: IconPlug,
    exact: false,
    linkOptions: { to: "/settings/connected-accounts" },
  },
  {
    /* Logins saved from a Bot's private sign-in form. */
    title: "sidebar.passwords",
    icon: IconKey,
    exact: false,
    linkOptions: { to: "/settings/passwords" },
  },
  {
    /* The same mark Admin gives UI Components. It is the same subject seen from the other side. */
    title: "sidebar.componentsGallery",
    icon: IconLayoutGrid,
    exact: false,
    linkOptions: { to: "/settings/components-gallery" },
  },
  {
    /*
     * 套餐与积分: the plan, its base credits, reward credits and every spend — the new system
     * that replaced the old entitlements and subscribe screens.
     */
    title: "sidebar.plansUsage",
    icon: IconChartBar,
    exact: false,
    linkOptions: { to: "/settings/usage" },
  },
  {
    /*
     * What has been billed, and the receipt for each one. Last, because it is the screen somebody
     * visits when something needs accounting for, not when something needs deciding.
     */
    title: "sidebar.invoices",
    icon: IconReceipt,
    exact: false,
    linkOptions: { to: "/settings/invoices" },
  },
] as const satisfies readonly {
  /**
   * Whether this entry lights only on its own route.
   *
   * On for an entry whose path is a prefix of another's, which is the only reason to want it. Off
   * everywhere else, so an entry stays lit on the pages beneath it.
   */
  exact?: boolean;
  icon: React.ComponentType<{ className?: string }>;
  linkOptions: LinkOptions;
  title: string;
}[];

export function SettingsSidebar({
  ...props
}: React.ComponentProps<typeof Sidebar>) {
  const { t } = useTranslation("settings");
  return (
    <Sidebar {...props}>
      {/* Matched to the app sidebar's header, as Admin's is. See admin-sidebar.tsx. */}
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
        {/*
         * Group outside menu, as Admin has it. The other way round nests a list item inside a div
         * inside the `ul`, which is not markup a list is allowed to be made of.
         */}
        <SidebarGroup>
          <SidebarMenu className="gap-px">
            {ITEMS.map((option) => (
              <SidebarMenuItem key={option.title}>
                <SidebarMenuButton
                  render={(props) => (
                    <Link
                      {...option.linkOptions}
                      activeOptions={{ exact: option.exact ?? false }}
                      activeProps={{ className: "bg-foreground/5" }}
                      {...props}
                    >
                      <option.icon className="mr-2 h-4 w-4" />
                      {t(option.title)}
                    </Link>
                  )}
                />
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
      <SidebarRail />
    </Sidebar>
  );
}

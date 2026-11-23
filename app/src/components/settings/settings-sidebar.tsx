import {
  IconArrowLeft,
  IconBell,
  IconBook,
  IconBrowser,
  IconChecks,
  IconDeviceDesktop,
  IconHistory,
  IconKey,
  IconLayoutGrid,
  IconListCheck,
  IconLock,
  IconSchool,
  IconSettings,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { Link, type LinkOptions } from "@tanstack/react-router";
import type * as React from "react";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { desktopShell } from "@/lib/desktop/shell";
import { managePaths } from "@/lib/manage-paths";
import { mayOpenSetup, setupChecklistQueryOptions } from "@/lib/setup/queries";

const appLinkOptions = { to: "/" } satisfies LinkOptions;

type SettingsSidebarItem = {
  /**
   * Whether this entry lights only on its own route.
   *
   * On for an entry whose path is a prefix of another's, which is the only reason to want it. Off
   * everywhere else, so an entry stays lit on the pages beneath it.
   */
  exact?: boolean;
  group: "Preferences" | "Access and devices" | "Workspace tools";
  /** Shown only inside OpenBot Desktop, which is what the page reads from. */
  desktopOnly?: boolean;
  icon: React.ComponentType<{ className?: string }>;
  linkOptions: LinkOptions;
  title: string;
  setup?: boolean;
};

export const SETTINGS_SIDEBAR_ITEMS: SettingsSidebarItem[] = [
  {
    title: "General",
    group: "Preferences",
    icon: IconSettings,
    /* `/settings` prefixes every other route here, and would otherwise light up on all of them. */
    exact: true,
    linkOptions: { to: "/settings" },
  },
  {
    /* Where updates go for every Bot at once; how much each Bot sends is on that Bot's page. */
    title: "Notifications",
    group: "Preferences",
    icon: IconBell,
    linkOptions: { to: "/settings/notifications" },
  },
  {
    /* Whether Bots ask first, and rules for every Bot. Team settings are an administrator's. */
    title: "Approvals",
    group: "Access and devices",
    icon: IconChecks,
    linkOptions: { to: "/settings/approvals" },
  },
  {
    /* The browsers signed in to the Recorder extension as you; each can be disconnected here. */
    title: "Browsers",
    group: "Access and devices",
    icon: IconBrowser,
    linkOptions: { to: "/settings/browsers" },
  },
  {
    /* Who else's Bots use the Skills learned from your recordings: none, all, or the ones you open. */
    title: "Learning",
    group: "Preferences",
    icon: IconSchool,
    linkOptions: { to: "/settings/learning" },
  },
  {
    /* What the deployment has and still needs: onboarding's checklist, to come back to. */
    title: "Setup",
    group: "Workspace tools",
    icon: IconListCheck,
    linkOptions: { to: "/settings/setup" },
    setup: true,
  },
  {
    /* Logins saved from a Bot's private sign-in form. */
    title: "Passwords",
    group: "Access and devices",
    icon: IconKey,
    linkOptions: { to: "/settings/passwords" },
  },
  {
    /* What OpenBot runs here and the memory it takes, with Restart and Stop. */
    title: "This computer",
    group: "Access and devices",
    icon: IconDeviceDesktop,
    desktopOnly: true,
    linkOptions: { to: "/settings/this-computer" },
  },
  {
    /* The same mark Admin gives UI Components. It is the same subject seen from the other side. */
    title: "Components gallery",
    group: "Workspace tools",
    icon: IconLayoutGrid,
    linkOptions: { to: "/settings/components-gallery" },
  },
];

/**
 * What the personal edition keeps of Admin. There is no Admin there, and the one person still stores
 * keys, writes skills, resets the computer and reads the trail. Apps are not here:
 * adding one and connecting it are the same step, on Connections, which also links here for keys and
 * saved logins.
 */
const PERSONAL_SETTINGS_SIDEBAR_ITEMS: SettingsSidebarItem[] = [
  {
    title: "Keys",
    group: "Access and devices",
    icon: IconLock,
    linkOptions: { to: "/settings/credentials" },
  },
  {
    title: "Skills",
    group: "Workspace tools",
    icon: IconBook,
    linkOptions: { to: "/settings/skills" },
  },
  {
    title: "Computer",
    group: "Workspace tools",
    icon: IconDeviceDesktop,
    linkOptions: { to: "/settings/computer" },
  },
  {
    title: managePaths("personal").auditLabel,
    group: "Workspace tools",
    icon: IconHistory,
    linkOptions: { to: "/settings/activity" },
  },
];

export function settingsSidebarItems(
  edition: "team" | "personal",
): SettingsSidebarItem[] {
  // Passwords is called Saved logins there, as on Connections.
  return edition === "personal"
    ? [
        ...SETTINGS_SIDEBAR_ITEMS.map((item) =>
          item.title === "Passwords"
            ? { ...item, title: "Saved logins" }
            : item,
        ),
        ...PERSONAL_SETTINGS_SIDEBAR_ITEMS,
      ]
    : SETTINGS_SIDEBAR_ITEMS;
}

export function SettingsSidebar({
  ...props
}: React.ComponentProps<typeof Sidebar>) {
  const user = useQuery(currentUserQueryOptions()).data;
  const capabilities = useQuery(deploymentCapabilitiesQueryOptions()).data;
  const canSetUp = mayOpenSetup(user, capabilities);
  /*
   * What an admin can act on, counted beside Setup: rows that need setup and say how. Onboarding
   * leaves the checklist out, so this is where an admin learns something is waiting on them. Never
   * asked for anybody else, who could not fix any of it.
   */
  const checklist = useQuery({
    ...setupChecklistQueryOptions(),
    enabled: canSetUp,
  }).data;
  const toFix =
    checklist?.audience === "admin"
      ? checklist.rows.filter(
          (row) => row.status === "needs_setup" && row.fix !== null,
        ).length
      : 0;
  const items = settingsSidebarItems(capabilities?.edition ?? "team").filter(
    (option) =>
      (!option.setup || canSetUp) &&
      (!option.desktopOnly || desktopShell() !== null),
  );
  const groups = [
    "Preferences",
    "Access and devices",
    "Workspace tools",
  ] as const;
  return (
    <Sidebar variant="inset" {...props}>
      {/* Matched to the app sidebar's header, as Admin's is. See admin-sidebar.tsx. */}
      <SidebarHeader className="h-12 p-2">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              render={(props) => (
                <Link {...appLinkOptions} {...props}>
                  <IconArrowLeft className="mr-2 h-4 w-4" />
                  Workspace
                </Link>
              )}
            />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <nav aria-label="Settings">
          {groups.map((group) => (
            <SidebarGroup key={group}>
              <SidebarGroupLabel>{group}</SidebarGroupLabel>
              <SidebarMenu className="gap-px">
                {items
                  .filter((option) => option.group === group)
                  .map((option) => (
                    <SidebarMenuItem key={option.title}>
                      <SidebarMenuButton
                        render={(props) => (
                          <Link
                            {...option.linkOptions}
                            activeOptions={{ exact: option.exact ?? false }}
                            activeProps={{ "data-active": true }}
                            {...props}
                          >
                            <option.icon className="mr-2 h-4 w-4" />
                            {option.title}
                            {option.setup && toFix > 0 ? (
                              <span className="sr-only">
                                , {toFix} {toFix === 1 ? "needs" : "need"} setup
                              </span>
                            ) : null}
                          </Link>
                        )}
                      />
                      {option.setup && toFix > 0 ? (
                        <SidebarMenuBadge aria-hidden="true">
                          {toFix}
                        </SidebarMenuBadge>
                      ) : null}
                    </SidebarMenuItem>
                  ))}
              </SidebarMenu>
            </SidebarGroup>
          ))}
        </nav>
      </SidebarContent>
      <SidebarRail />
    </Sidebar>
  );
}

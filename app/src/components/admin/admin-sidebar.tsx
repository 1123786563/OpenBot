import { IconArrowLeft } from "@tabler/icons-react";
import { Link, type LinkOptions } from "@tanstack/react-router";
import type { RefObject } from "react";
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
  useSidebar,
} from "@/components/ui/sidebar";
import { useTranslation } from "@/i18n";
import { ADMIN_NAVIGATION } from "./admin-navigation";

const appLinkOptions = { to: "/" } satisfies LinkOptions;
const adminLinkOptions = { to: "/admin" } satisfies LinkOptions;

export function AdminSidebar({
  navId,
  returnFocus,
  ...props
}: React.ComponentProps<typeof Sidebar> & {
  /** The navigation's id: the desktop pane's and the mobile sheet's, so the toggle's aria-controls names it. */
  navId?: string;
  /** Where the closed sheet sends focus. */
  returnFocus?: RefObject<HTMLButtonElement | null>;
}) {
  const { isMobile } = useSidebar();
  const { t } = useTranslation();
  return (
    <Sidebar
      variant="inset"
      {...(navId
        ? {
            id: isMobile ? undefined : navId,
            mobileNavigation: {
              title: t("nav.admin", "Admin"),
              popup: {
                id: navId,
                finalFocus: returnFocus,
              },
            },
          }
        : {})}
      {...props}
    >
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
                  {t("nav.workspace", "Workspace")}
                </Link>
              )}
            />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <nav aria-label={t("nav.admin", "Admin")}>
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
                      activeProps={{ "data-active": true }}
                      {...props}
                    >
                      {t("admin.sidebar.overview", "Overview")}
                    </Link>
                  )}
                />
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroup>
          {ADMIN_NAVIGATION.map((group) => (
            <SidebarGroup key={group.title}>
              <SidebarGroupLabel>
                {t(group.messageId, group.label)}
              </SidebarGroupLabel>
              <SidebarMenu className="gap-px">
                {group.items.map((item) => (
                  <SidebarMenuItem key={item.title}>
                    <SidebarMenuButton
                      render={(props) => (
                        <Link
                          {...item.linkOptions}
                          activeProps={{ "data-active": true }}
                          {...props}
                        >
                          <item.icon className="mr-2 h-4 w-4" />
                          {t(item.messageId, item.label)}
                        </Link>
                      )}
                    />
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

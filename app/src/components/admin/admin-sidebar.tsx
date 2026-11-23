import { IconArrowLeft } from "@tabler/icons-react";
import { Link, type LinkOptions } from "@tanstack/react-router";
import type * as React from "react";
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
import { ADMIN_NAVIGATION } from "./admin-navigation";

const appLinkOptions = { to: "/" } satisfies LinkOptions;
const adminLinkOptions = { to: "/admin" } satisfies LinkOptions;

export function AdminSidebar({
  ...props
}: React.ComponentProps<typeof Sidebar>) {
  return (
    <Sidebar variant="inset" {...props}>
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
                  Workspace
                </Link>
              )}
            />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <nav aria-label="Admin">
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
                      Overview
                    </Link>
                  )}
                />
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroup>
          {ADMIN_NAVIGATION.map((group) => (
            <SidebarGroup key={group.title}>
              <SidebarGroupLabel>{group.title}</SidebarGroupLabel>
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
                          {item.title}
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

import { type ReactNode, useId, useRef } from "react";
import { AppSidebar } from "@/components/app-sidebar/app-sidebar";
import { AttentionNotifier } from "@/components/bot-profile/attention";
import { SelfHostBanner } from "@/components/layout/self-host-banner";
import { SidebarShell } from "@/components/layout/sidebar-shell";
import { UpdateBanner } from "@/components/layout/update-banner";
import { SidebarInset, useSidebar } from "@/components/ui/sidebar";
import { AstryxNavigationToggle } from "./navigation-toggle";
import { AstryxBrand, astryxScope } from "./theme";

export function AstryxWebShell({ children }: { children: ReactNode }) {
  return (
    <SidebarShell
      className="astryx-web-shell h-svh overflow-hidden"
      name="astryx-app"
      pageToggle={false}
      width="280px"
    >
      <AstryxWebFrame>{children}</AstryxWebFrame>
    </SidebarShell>
  );
}

function AstryxWebFrame({ children }: { children: ReactNode }) {
  const navId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const { isMobile, open } = useSidebar();

  return (
    <>
      <AttentionNotifier />
      <AppSidebar navId={navId} returnFocus={trigger} />
      <SidebarInset className="min-h-0 min-w-0 overflow-hidden">
        <div {...astryxScope} className="astryx-web-bar">
          <AstryxNavigationToggle navId={navId} trigger={trigger} />
          {isMobile || !open ? <AstryxBrand /> : null}
        </div>
        <UpdateBanner />
        <SelfHostBanner />
        {children}
      </SidebarInset>
    </>
  );
}
